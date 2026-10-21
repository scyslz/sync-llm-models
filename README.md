# sync-llm-models

An OpenCode skill that keeps OpenAI-compatible model lists in sync, and refreshes
Paseo's cached provider catalogue without restarting its daemon.

Many OpenAI-compatible proxies, routers and local gateways (LiteLLM, one-api,
Ollama, vLLM, OpenRouter, internal gateways) expose a `/v1/models` endpoint, but
OpenCode wants an explicit `models` map per provider. Keeping that map by hand goes
stale the moment the proxy adds or removes a model.

## What it does

1. **`scripts/sync_models.mjs`** fetches `<baseURL>/models` for each provider in your
   OpenCode config and rewrites that provider's `models` map (under `provider.<id>`
   for OpenCode ≤ v1, `providers.<id>` for v2), preserving hand-tuned per-model
   fields and filling context/output limits from the API. Endpoints that are down
   are skipped, leaving their config untouched.
2. **`scripts/refresh-paseo.mjs`** sends `refreshProvidersSnapshot` to the local
   Paseo daemon so Paseo picks up the new list. It does not restart the daemon, so
   running agent sessions are left alone.

## Install

```bash
git clone https://github.com/scyslz/sync-llm-models.git ~/.agents/skills/sync-llm-models
cd ~/.agents/skills/sync-llm-models
```

OpenCode loads skills from `~/.agents/skills/<name>/SKILL.md`, so this path makes
`/sync-llm-models` available in a session. Requirements: Node 18+ and the
`opencode` CLI; the Paseo refresh also needs `@getpaseo/cli` installed.

## Quick start

```bash
node scripts/sync_models.mjs --dry-run   # preview
node scripts/sync_models.mjs             # write
node scripts/refresh-paseo.mjs           # refresh Paseo (required after every sync; skip if no Paseo)
# or in one go (skip Paseo refresh on failure):
# node scripts/sync_models.mjs && (node scripts/refresh-paseo.mjs || true)
```

See [SKILL.md](SKILL.md) for the full reference: flags, config templating
(`{env:...}` / `{file:...}`), backup behaviour, and how to add a new provider.

## Design notes

- **No hardcoded providers or secrets.** Every target comes from your own config, and
  `baseURL` / `apiKey` support OpenCode's `{env:VAR}` and `{file:path}` templates.
- **Idempotent.** If the endpoint is unchanged, nothing is written. Unchanged
  limits count as unchanged, so a re-run right after a sync writes nothing.
- **Both config layouts.** `provider.<id>.options` (OpenCode ≤ v1) and
  `providers.<id>.settings` (v2) are read; if neither block exists the script
  exits 1 rather than reporting "already up to date".
- **Reversible.** Each write copies `opencode.json[.bak.<timestamp>]` first, keeping
  the most recent 5 by default.
- **Preserves your config.** Both JSON and JSONC are handled (comments and trailing
  commas are tolerated on read), indentation is detected per file, and unknown keys
  are never dropped.
- **No daemon restart.** Paseo gets an in-place refresh, so live agents survive.

## Requirements

- Node 18+ (`@getpaseo/cli` installed for the Paseo refresh)
- The `opencode` CLI to verify results

## License

MIT
