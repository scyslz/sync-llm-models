#!/usr/bin/env python3
"""Sync OpenAI-compatible model lists into the OpenCode config.

Usage:
    sync_models.py [provider ...] [--all] [--keep-removed] [--dry-run]
                   [--home DIR] [--timeout SECONDS] [--keep-backups N]

Reads <baseURL>/models for each provider and rewrites provider.<id>.models,
keeping existing per-model overrides (display name, limits, cost, tool_call,
...) and filling limits from the endpoint when it reports them. Updates
opencode.json / opencode.jsonc in place, atomically, with timestamped backups.

With no provider arguments, every provider that has options.baseURL is synced.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_TIMEOUT = 20.0
CONFIG_NAMES = ("opencode.jsonc", "opencode.json")
# {env:VAR}, {file:path} and $VAR / ${VAR} are resolved like OpenCode does.
TEMPLATE_RE = re.compile(r"\{env:([^}]+)\}|\{file:([^}]+)\}|\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)")


# --------------------------------------------------------------------------- #
# Config loading / dumping
# --------------------------------------------------------------------------- #
def strip_jsonc(text: str) -> str:
    """Remove // and /* */ comments and trailing commas, leaving strings intact."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == '"':
                    j += 1
                    break
                j += 1
            out.append(text[i:j])
            i = j
        elif ch == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j == -1 else j
        elif ch == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
        else:
            out.append(ch)
            i += 1
    # Trailing commas before a closing brace/bracket.
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def load_config(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        try:
            return json.loads(strip_jsonc(text))
        except json.JSONDecodeError as exc:
            sys.exit(f"{path}: invalid JSON/JSONC ({exc})")


def detect_indent(path: Path) -> int | None:
    """Return the indent width used by the file, or None for compact JSON."""
    text = path.read_text(encoding="utf-8")
    if "\n" not in text.rstrip("\n"):
        return None
    for line in text.splitlines()[1:]:
        stripped = line.lstrip(" ")
        if stripped.startswith('"') and len(stripped) != len(line):
            return len(line) - len(stripped)
    return 2 if text.lstrip().startswith("{\n") else None


def dump_atomic(path: Path, config: dict, indent: int | None) -> None:
    if indent:
        body = json.dumps(config, indent=indent, ensure_ascii=False)
    else:
        body = json.dumps(config, separators=(",", ":"), ensure_ascii=False)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(body + "\n", encoding="utf-8")
    os.replace(tmp, path)


def prune_backups(path: Path, keep: int) -> None:
    if keep < 0:
        return
    backups = sorted(path.parent.glob(f"{path.name}.bak.*"), key=lambda p: p.name)
    for old in backups[: max(0, len(backups) - keep)]:
        old.unlink(missing_ok=True)


def find_configs(home: Path) -> list[Path]:
    configs = [home / name for name in CONFIG_NAMES if (home / name).is_file()]
    if not configs:
        sys.exit(f"No opencode.json or opencode.jsonc found in {home}")
    return configs


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def expand(value: str | None) -> str | None:
    if not isinstance(value, str):
        return value

    def sub(match: re.Match[str]) -> str:
        env, fileref, braced, bare = match.groups()
        if env or braced:
            return os.environ.get(env or braced, "")
        if fileref:
            try:
                return Path(os.path.expanduser(fileref)).read_text(encoding="utf-8").strip()
            except OSError:
                return ""
        return os.environ.get(bare, "")

    return TEMPLATE_RE.sub(sub, value)


def models_url(base_url: str) -> str:
    url = base_url.rstrip("/")
    if url.endswith("/models"):
        return url
    return url + "/models"


def fetch_models(base_url: str, api_key: str | None, timeout: float) -> list[dict]:
    url = models_url(base_url)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{url}: HTTP {exc.code} {exc.reason}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        raise RuntimeError(f"{url}: {exc}") from exc

    data = payload.get("data", payload) if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        data = data.get("models") or data.get("items")
    if not isinstance(data, list):
        raise RuntimeError(f"{url}: unexpected payload shape")
    return [m for m in data if isinstance(m, dict) and m.get("id")]


# --------------------------------------------------------------------------- #
# Model map
# --------------------------------------------------------------------------- #
def display_name(model_id: str, previous: dict) -> str:
    if previous.get("name"):
        return str(previous["name"])
    return model_id.split(":")[-1].split("/")[-1]


def build_models(entries: list[dict], existing: dict, keep_removed: bool) -> dict:
    models: dict[str, dict] = {}
    for m in entries:
        mid = str(m["id"])
        prev = existing.get(mid) or {}
        limit = m.get("limit") or {}
        context = limit.get("context") or m.get("context_length") or m.get("context_window")
        output = limit.get("output") or m.get("max_output_tokens")

        entry: dict = {"name": display_name(mid, prev)}
        if context and output:
            entry["limit"] = {"context": context, "output": output}
        elif prev.get("limit"):
            entry["limit"] = prev["limit"]
        # Keep hand-tuned fields (tool_call, attachment, cost, reasoning, ...).
        for key, value in prev.items():
            entry.setdefault(key, value)
        models[mid] = entry

    if keep_removed:
        for mid, prev in existing.items():
            models.setdefault(mid, prev)
    return models


def summarize(old: dict, new: dict) -> str:
    added = [m for m in new if m not in old]
    removed = [m for m in old if m not in new]
    parts = [f"{len(new)} models"]
    if added:
        parts.append(f"+{len(added)} ({', '.join(added[:4])}{'...' if len(added) > 4 else ''})")
    if removed:
        parts.append(f"-{len(removed)} ({', '.join(removed[:4])}{'...' if len(removed) > 4 else ''})")
    return ", ".join(parts)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync OpenAI-compatible provider model lists into the OpenCode config"
    )
    parser.add_argument("providers", nargs="*", help="provider IDs (default: every provider with options.baseURL)")
    parser.add_argument("--all", action="store_true", help="explicitly sync every provider with options.baseURL")
    parser.add_argument("--keep-removed", action="store_true", help="keep models that the endpoint no longer lists")
    parser.add_argument("--dry-run", action="store_true", help="print changes without writing config files")
    parser.add_argument("--home", default="~/.config/opencode", help="config directory (default: ~/.config/opencode)")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help=f"HTTP timeout in seconds (default: {DEFAULT_TIMEOUT:g})")
    parser.add_argument("--keep-backups", type=int, default=5, help="backups to retain per config file (default: 5, -1 keeps all)")
    args = parser.parse_args()

    home = Path(os.path.expanduser(args.home))
    configs = find_configs(home)
    primary = configs[0]
    primary_config = load_config(primary)
    providers = primary_config.get("provider") or {}

    if args.all or not args.providers:
        targets = list(providers)
    else:
        targets = args.providers

    updates: dict[str, dict] = {}
    failures = 0
    for pid in targets:
        prov = providers.get(pid)
        if not prov:
            print(f"skip {pid}: not present in {primary}", file=sys.stderr)
            failures += 1
            continue
        options = prov.get("options") or {}
        base_url = expand(options.get("baseURL"))
        if not base_url:
            print(f"skip {pid}: no options.baseURL", file=sys.stderr)
            failures += 1
            continue
        try:
            entries = fetch_models(base_url, expand(options.get("apiKey")), args.timeout)
        except RuntimeError as exc:
            print(f"skip {pid}: {exc}", file=sys.stderr)
            failures += 1
            continue

        existing = prov.get("models") or {}
        models = build_models(entries, existing, args.keep_removed)
        print(f"{pid}: {summarize(existing, models)} from {models_url(base_url)}")
        if args.dry_run:
            for mid in models:
                print(f"  {mid}")
        elif models != existing:
            updates[pid] = models

    if args.dry_run:
        return 0
    if not updates:
        print("config already up to date")
        if targets and failures == len(targets):
            print("every target failed", file=sys.stderr)
            return 1
        return 0

    stamp = time.strftime("%Y%m%d%H%M%S")
    for path in configs:
        shutil.copy2(path, path.with_name(f"{path.name}.bak.{stamp}"))

    for path in configs:
        cfg = primary_config if path == primary else load_config(path)
        cfg_providers = cfg.setdefault("provider", {})
        indent = detect_indent(path)
        changed = False
        for pid, models in updates.items():
            if pid in cfg_providers:
                cfg_providers[pid]["models"] = models
                changed = True
        if not changed:
            continue
        dump_atomic(path, cfg, indent)
        print(f"wrote {path}")
        prune_backups(path, args.keep_backups)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
