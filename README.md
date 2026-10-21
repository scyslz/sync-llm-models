# sync-llm-models

An OpenCode skill that keeps OpenAI-compatible model lists in sync, and refreshes
Paseo's cached provider catalogue without restarting its daemon.

Many OpenAI-compatible proxies, routers and local gateways (LiteLLM, one-api,
Ollama, vLLM, OpenRouter, internal gateways) expose a `/v1/models` endpoint, but
OpenCode wants an explicit `models` map per provider. Keeping that map by hand goes
stale the moment the proxy adds or removes a model.

## What it does

1. **`scripts/sync_models.py`** fetches `<baseURL>/models` for each provider in your
   OpenCode config and rewrites `provider.<id>.models`, preserving hand-tuned
   per-model fields and filling context/output limits from the API.
2. **`scripts/refresh-paseo.mjs`** sends `refreshProvidersSnapshot` to the local
   Paseo daemon so Paseo picks up the new list. It does not restart the daemon, so
   running agent sessions are left alone.

## Quick start

```bash
git clone https://github.com/scyslz/sync-llm-models.git ~/.agents/skills/sync-llm-models
cd ~/.agents/skills/sync-llm-models

python3 scripts/sync_models.py --dry-run   # preview
python3 scripts/sync_models.py             # write
node scripts/refresh-paseo.mjs             # refresh Paseo
```

OpenCode loads skills from `~/.agents/skills/<name>/SKILL.md`, so the clone path
above makes `/sync-llm-models` available in a session.

See [SKILL.md](SKILL.md) for the full reference: flags, config templating
(`{env:...}` / `{file:...}`), backup behaviour, and how to add a new provider.

## Design notes

- **No hardcoded providers or secrets.** Every target comes from your own config, and
  `baseURL` / `apiKey` support OpenCode's `{env:VAR}` and `{file:path}` templates.
- **Idempotent.** If the endpoint is unchanged, nothing is written.
- **Reversible.** Each write copies `opencode.json[.bak.<timestamp>]` first, keeping
  the most recent 5 by default.
- **Preserves your config.** Both JSON and JSONC are handled (comments and trailing
  commas are tolerated on read), indentation is detected per file, and unknown keys
  are never dropped.
- **No daemon restart.** Paseo gets an in-place refresh, so live agents survive.

## Requirements

- Python 3.9+ (stdlib only)
- Node 18+ for the Paseo refresh (`@getpaseo/cli` installed)
- The `opencode` CLI to verify results

## License

MIT
