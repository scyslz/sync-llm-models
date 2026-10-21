---
name: sync-llm-models
description: Sync OpenAI-compatible model lists from any provider's /v1/models into the OpenCode config, then refresh Paseo's cached provider catalogue. Use when models are missing or stale in OpenCode or Paseo, when a proxy adds or removes models, or when a new OpenAI-compatible provider is configured.
---

# Sync LLM models into OpenCode and Paseo

OpenCode reads providers from `~/.config/opencode/opencode.json` (or `opencode.jsonc`).
Paseo has no model list of its own: it reads that config and caches a provider
snapshot in its daemon. Syncing is therefore two steps:

1. rewrite each provider's `models` map from its endpoint's `/models`;
2. tell the Paseo daemon to refresh its snapshot.

Both steps are scripted here. Run them from any directory.

> **Important:** step 1 only rewrites the OpenCode config. Paseo caches its own
> snapshot in the daemon, so after every sync you **must** run step 2, otherwise
> the new models stay invisible in Paseo. A single chained command:
>
> ```bash
> node scripts/sync_models.mjs && node scripts/refresh-paseo.mjs
> ```
>
> If you do not use Paseo, skip step 2 entirely — `sync_models.mjs` alone is
> enough to keep OpenCode up to date. The refresh script exits non-zero when the
> daemon is unreachable, so guard it in scripts if needed:
>
> ```bash
> node scripts/sync_models.mjs && (node scripts/refresh-paseo.mjs || true)
> ```

## 1. Sync model lists

```bash
node scripts/sync_models.mjs                    # every provider with a baseURL
node scripts/sync_models.mjs myprovider other   # only these provider IDs
node scripts/sync_models.mjs --dry-run          # show what would change
```

The script reads both config layouts: OpenCode ≤ v1 uses `provider.<id>` with
`options.baseURL` / `options.apiKey`, OpenCode v2 uses `providers.<id>` with
`settings.baseURL` / `settings.apiKey` (and `package` instead of `npm`). If no
provider block is found at all it exits 1 instead of claiming "up to date".

Options:

| Flag | Meaning |
| --- | --- |
| `provider ...` | Provider IDs as they appear under `provider` (v1) or `providers` (v2). |
| `--all` | Same as passing no IDs: sync every provider that has a baseURL. |
| `--dry-run` | Print the resulting model IDs without writing anything. |
| `--keep-removed` | Keep models the endpoint no longer lists (useful for flaky proxies). |
| `--home DIR` | Config directory (default `~/.config/opencode`). |
| `--timeout SECS` | Per-request HTTP timeout (default 20). |
| `--keep-backups N` | Backups to retain per config file (default 5; `-1` keeps all). |

What it does:

- GETs `<baseURL>/models` — a base URL already ending in `/models` is left alone —
  adding `Authorization: Bearer <apiKey>` when the provider has `options.apiKey`
  or `settings.apiKey`.
- Resolves `{env:VAR}`, `{file:path}`, `$VAR` and `${VAR}` in `baseURL` / `apiKey`
  the way OpenCode does, so no secrets need to be literal in the config.
- Rebuilds the provider's `models` map in API order, keeping any existing per-model
  overrides (`name`, `cost`, `tool_call`, `attachment`, `reasoning`, ...).
  A model without a `name` gets its ID minus the vendor prefix
  (`cn:glm-5.3` → `glm-5.3`).
- Fills `limit.context` / `limit.output` from `limit.*`, `context_length`,
  `context_window` or `max_output_tokens` when the endpoint reports them.
  The endpoint wins **per field**: a reported context replaces the stored one
  even when the endpoint reports no output limit (the previous value is kept
  only for fields the endpoint omits). The run summary prints
  `limits updated N (...)` so limit-only changes are visible.
- An endpoint that is down or unreachable is **skipped**, leaving that provider's
  config untouched (failures are reported on stderr; the run still succeeds for
  the providers that did sync).
- Updates every config file found (`jsonc` first, then `json`) in place, preserving
  each file's indentation style, writing atomically, and saving a timestamped
  `*.bak.<stamp>` before each write.

Verify:

```bash
opencode models | grep '^myprovider/'
```

## 2. Refresh the Paseo provider snapshot

```bash
node scripts/refresh-paseo.mjs --providers opencode
```

This connects to the local Paseo daemon (`~/.paseo` by default), sends
`refreshProvidersSnapshot`, and prints the acknowledgement. It does **not** restart
the daemon, so running agent sessions keep working. Verify:

```bash
paseo provider models opencode | grep myprovider
```

Options: `--providers opencode,pi` (comma separated), `--home <paseo-home>`,
`--cwd <dir>` (also refresh that workspace's snapshot), `--retries N`,
`--verbose` (show every client-module path it tried).

The script locates the daemon client inside the installed `@getpaseo/cli` package by
asking `npm root -g`, following the `paseo` binary, then trying well-known global
paths. If it still cannot find it, set `PASEO_CLI_CLIENT_MODULE` to that package's
`dist/utils/client.js`.

The first liveness check after a daemon wake-up can time out. Retry with
`--retries 3`. If the daemon stays unreachable, use the refresh action in the Paseo
app — do **not** run `paseo daemon restart` while an agent session is live, because
that kills every session.

## 3. End-to-end smoke test

```bash
opencode run -m myprovider/<model-id> "Reply with exactly: OK"
```

## Adding a new compatible provider

Add it under `providers` in `~/.config/opencode/opencode.json` (and `.jsonc` if you
keep both). This is the OpenCode v2 shape; the older `provider` + `options`/`npm`
shape is understood by the script too:

```jsonc
{
  "providers": {
    "myprovider": {
      "package": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "settings": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:MY_PROVIDER_API_KEY}"
      }
      // "models" is optional; step 1 creates it.
    }
  }
}
```

Then run step 1 and step 2. The endpoint's model list is the source of truth: every
model it returns is added to `models`, and models it no longer returns are dropped
unless you pass `--keep-removed`. There is no per-provider allowlist — to publish
fewer models, point the provider at an endpoint that serves fewer.

## Requirements

- Node 18+ (`@getpaseo/cli` installed for the Paseo refresh)
- The `opencode` CLI, and/or Paseo with `@getpaseo/cli` installed
