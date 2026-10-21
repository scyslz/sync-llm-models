#!/usr/bin/env node
/**
 * Sync OpenAI-compatible model lists into the OpenCode config.
 *
 * Usage:
 *   node sync_models.mjs [provider ...] [--all] [--keep-removed] [--dry-run]
 *                        [--home DIR] [--timeout SECONDS] [--keep-backups N]
 *
 * Reads <baseURL>/models for each provider and rewrites the provider's models
 * map, keeping existing per-model overrides (display name, limits, cost,
 * tool_call, ...) and filling limits from the endpoint when it reports them.
 * Understands both config layouts: provider.<id>.options (OpenCode <= v1) and
 * providers.<id>.settings (OpenCode v2). Updates opencode.json / opencode.jsonc
 * in place, atomically, with timestamped backups.
 *
 * With no provider arguments, every provider that has a baseURL is synced.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

const DEFAULT_TIMEOUT = 20.0;
const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"];
const TEMPLATE_RE = /\{env:([^}]+)\}|\{file:([^}]+)\}|\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function stripJsonc(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out.push(text.slice(i, j));
      i = j;
    } else if (ch === "/" && text.startsWith("//", i)) {
      const j = text.indexOf("\n", i);
      i = j === -1 ? n : j;
    } else if (ch === "/" && text.startsWith("/*", i)) {
      const j = text.indexOf("*/", i + 2);
      i = j === -1 ? n : j + 2;
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join("").replace(/,(\s*[}\]])/g, "$1");
}

function parseConfigText(text, path) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripJsonc(text));
    } catch (exc) {
      console.error(`${path}: invalid JSON/JSONC (${exc.message})`);
      process.exit(1);
    }
  }
}

function loadConfig(path) {
  return parseConfigText(readFileSync(path, "utf8"), path);
}

function detectIndent(text) {
  const stripped = text.replace(/\n+$/, "");
  if (!stripped.includes("\n")) return null;
  const lines = text.split("\n");
  for (let idx = 1; idx < lines.length; idx++) {
    const line = lines[idx];
    const lstripped = line.replace(/^ +/, "");
    if (lstripped.startsWith('"') && lstripped.length !== line.length) {
      return line.length - lstripped.length;
    }
  }
  return text.trimStart().startsWith("{\n") ? 2 : null;
}

function dumpAtomic(path, config, indent) {
  let body;
  if (indent) {
    body = JSON.stringify(config, null, indent);
  } else {
    body = JSON.stringify(config);
  }
  const tmp = path + ".tmp";
  writeFileSync(tmp, body + "\n", "utf8");
  renameSync(tmp, path);
}

function pruneBackups(path, keep) {
  if (keep < 0) return;
  const dir = dirname(path);
  const base = basename(path);
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(base + ".bak."))
    .sort()
    .map((f) => join(dir, f));
  const excess = files.length - keep;
  if (excess <= 0) return;
  for (const f of files.slice(0, excess)) {
    try {
      rmSync(f, { force: true });
    } catch {
      // ignore
    }
  }
}

function findConfigs(home) {
  const configs = CONFIG_NAMES.map((name) => join(home, name)).filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!configs.length) {
    console.error(`No opencode.json or opencode.jsonc found in ${home}`);
    process.exit(1);
  }
  return configs;
}

/**
 * OpenCode <= v1 stores providers as provider.<id> with options.baseURL/apiKey;
 * v2 stores them as providers.<id> with settings.baseURL/apiKey. Support both.
 */
function providerMap(cfg) {
  if (cfg.provider && typeof cfg.provider === "object") return cfg.provider;
  if (cfg.providers && typeof cfg.providers === "object") return cfg.providers;
  return {};
}

function providerOptions(prov) {
  if (prov.options && typeof prov.options === "object") return prov.options;
  if (prov.settings && typeof prov.settings === "object") return prov.settings;
  return {};
}

function ensureProviderMap(cfg) {
  if (cfg.provider && typeof cfg.provider === "object") return cfg.provider;
  if (cfg.providers && typeof cfg.providers === "object") return cfg.providers;
  cfg.providers = {};
  return cfg.providers;
}

function expandUser(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function expand(value) {
  if (typeof value !== "string") return value;
  return value.replace(TEMPLATE_RE, (match, env, fileref, braced, bare) => {
    if (env || braced) {
      return process.env[env || braced] ?? "";
    }
    if (fileref) {
      try {
        return readFileSync(expandUser(fileref), "utf8").trim();
      } catch {
        return "";
      }
    }
    return process.env[bare] ?? "";
  });
}

function modelsUrl(baseUrl) {
  const url = baseUrl.replace(/\/+$/, "");
  if (url.endsWith("/models")) return url;
  return url + "/models";
}

async function fetchModels(baseUrl, apiKey, timeout) {
  const url = modelsUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const headers = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`${url}: HTTP ${resp.status} ${resp.statusText}`);
    }
    const payload = await resp.json();
    let data =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload.data ?? payload
        : payload;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      data = data.models ?? data.items;
    }
    if (!Array.isArray(data)) {
      throw new Error(`${url}: unexpected payload shape`);
    }
    return data.filter((m) => m && typeof m === "object" && m.id);
  } catch (exc) {
    if (exc && exc.message && String(exc.message).startsWith(url)) {
      throw exc;
    }
    if (exc && exc.name === "AbortError") {
      throw new Error(`${url}: request timed out`);
    }
    throw new Error(`${url}: ${exc && exc.message ? exc.message : exc}`);
  } finally {
    clearTimeout(timer);
  }
}

function displayName(modelId, previous) {
  if (previous && previous.name) return String(previous.name);
  return modelId.split(":").pop().split("/").pop();
}

function buildModels(entries, existing, keepRemoved) {
  const models = {};
  const ex = existing || {};
  for (const m of entries) {
    const mid = String(m.id);
    const prev = ex[mid] || {};
    const limit = m.limit || {};
    const context = limit.context || m.context_length || m.context_window;
    const output = limit.output || m.max_output_tokens;

    const entry = { name: displayName(mid, prev) };
    const mergedLimit = { ...(prev.limit || {}) };
    // Endpoint-reported limits win per field; keep previous values only for
    // fields the endpoint does not report (plus any extra limit keys).
    if (context !== undefined && context !== null && context !== "") mergedLimit.context = context;
    if (output !== undefined && output !== null && output !== "") mergedLimit.output = output;
    if (Object.keys(mergedLimit).length) entry.limit = mergedLimit;
    for (const [key, value] of Object.entries(prev)) {
      if (!(key in entry)) entry[key] = value;
    }
    models[mid] = entry;
  }
  if (keepRemoved) {
    for (const [mid, prev] of Object.entries(ex)) {
      if (!(mid in models)) models[mid] = prev;
    }
  }
  return models;
}

function sortKeys(x) {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(sortKeys);
  const out = {};
  for (const k of Object.keys(x).sort()) out[k] = sortKeys(x[k]);
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function summarize(oldObj, newObj) {
  const oldKeys = Object.keys(oldObj || {});
  const newKeys = Object.keys(newObj || {});
  const added = newKeys.filter((m) => !oldKeys.includes(m));
  const removed = oldKeys.filter((m) => !newKeys.includes(m));
  const relimited = newKeys.filter(
    (m) =>
      oldKeys.includes(m) &&
      JSON.stringify((oldObj[m] || {}).limit) !== JSON.stringify((newObj[m] || {}).limit),
  );
  const parts = [`${newKeys.length} models`];
  if (added.length) {
    parts.push(`+${added.length} (${added.slice(0, 4).join(", ")}${added.length > 4 ? "..." : ""})`);
  }
  if (removed.length) {
    parts.push(`-${removed.length} (${removed.slice(0, 4).join(", ")}${removed.length > 4 ? "..." : ""})`);
  }
  if (relimited.length) {
    parts.push(
      `limits updated ${relimited.length} (${relimited.slice(0, 4).join(", ")}${relimited.length > 4 ? "..." : ""})`,
    );
  }
  return parts.join(", ");
}

function parseArgs(argv) {
  const out = {
    providers: [],
    all: false,
    keepRemoved: false,
    dryRun: false,
    home: "~/.config/opencode",
    timeout: DEFAULT_TIMEOUT,
    keepBackups: 5,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`${arg} requires a value`);
        process.exit(2);
      }
      return value;
    };
    if (arg === "--all") out.all = true;
    else if (arg === "--keep-removed") out.keepRemoved = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--home") out.home = next();
    else if (arg === "--timeout") out.timeout = parseFloat(next());
    else if (arg === "--keep-backups") out.keepBackups = parseInt(next(), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node sync_models.mjs [provider ...] [--all] [--keep-removed] [--dry-run]\n" +
          "       [--home DIR] [--timeout SECONDS] [--keep-backups N]",
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    } else {
      out.providers.push(arg);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = expandUser(args.home);
  const configs = findConfigs(home);
  const primary = configs[0];
  const primaryConfig = loadConfig(primary);
  const providers = providerMap(primaryConfig);
  if (!Object.keys(providers).length) {
    console.error(`${primary}: no provider/providers block found`);
    process.exit(1);
  }

  let targets;
  if (args.all || args.providers.length === 0) {
    targets = Object.keys(providers);
  } else {
    targets = args.providers;
  }

  const updates = {};
  let failures = 0;
  for (const pid of targets) {
    const prov = providers[pid];
    if (!prov) {
      console.error(`skip ${pid}: not present in ${primary}`);
      failures += 1;
      continue;
    }
    const options = providerOptions(prov);
    const baseUrl = expand(options.baseURL);
    if (!baseUrl) {
      console.error(`skip ${pid}: no options.baseURL`);
      failures += 1;
      continue;
    }
    let entries;
    try {
      entries = await fetchModels(baseUrl, expand(options.apiKey), args.timeout);
    } catch (exc) {
      console.error(`skip ${pid}: ${exc.message}`);
      failures += 1;
      continue;
    }

    const existing = prov.models || {};
    const models = buildModels(entries, existing, args.keepRemoved);
    console.log(`${pid}: ${summarize(existing, models)} from ${modelsUrl(baseUrl)}`);
    if (args.dryRun) {
      for (const mid of Object.keys(models)) console.log(`  ${mid}`);
    } else if (!deepEqual(models, existing)) {
      updates[pid] = models;
    }
  }

  if (args.dryRun) process.exit(0);
  if (Object.keys(updates).length === 0) {
    console.log("config already up to date");
    if (targets.length && failures === targets.length) {
      console.error("every target failed");
      process.exit(1);
    }
    process.exit(0);
  }

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  for (const p of configs) {
    copyFileSync(p, `${p}.bak.${stamp}`);
  }

  for (const p of configs) {
    const cfg = p === primary ? primaryConfig : loadConfig(p);
    const cfgProviders = ensureProviderMap(cfg);
    const indent = detectIndent(readFileSync(p, "utf8"));
    let changed = false;
    for (const [pid, models] of Object.entries(updates)) {
      if (pid in cfgProviders) {
        cfgProviders[pid].models = models;
        changed = true;
      }
    }
    if (!changed) continue;
    dumpAtomic(p, cfg, indent);
    console.log(`wrote ${p}`);
    pruneBackups(p, args.keepBackups);
  }
}

main().catch((error) => {
  console.error(`sync failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
