#!/usr/bin/env node
/**
 * Refresh the Paseo daemon's provider catalogue without restarting it.
 *
 * Usage:
 *   node refresh-paseo.mjs [--providers opencode,pi] [--home ~/.paseo]
 *                          [--cwd DIR] [--retries N] [--verbose]
 *
 * Paseo has no model list of its own: it reads the OpenCode config and caches a
 * provider snapshot in its daemon. This connects to the local daemon over its
 * socket/WebSocket, sends refreshProvidersSnapshot, and prints the
 * acknowledgement. Live agent sessions are unaffected (unlike `paseo daemon
 * restart`, which kills them).
 *
 * Finding the daemon client: Paseo's CLI is a Node package. We locate its
 * installed dist/utils/client.js by asking npm for the global root, then fall
 * back to the `paseo` binary on PATH. Override with PASEO_CLI_CLIENT_MODULE.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG = "@getpaseo/cli";

function parseArgs(argv) {
  const out = {
    providers: ["opencode"],
    home: join(homedir(), ".paseo"),
    cwd: undefined,
    retries: 1,
    verbose: false,
  };
  const tilde = (v) => v.replace(/^~(?=$|\/)/, homedir());
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--providers") out.providers = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--home") out.home = tilde(next());
    else if (arg === "--cwd") out.cwd = tilde(next());
    else if (arg === "--retries") out.retries = Math.max(1, Number(next()) || 1);
    else if (arg === "--verbose" || arg === "-v") out.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node refresh-paseo.mjs [--providers opencode,pi] [--home ~/.paseo] [--cwd DIR] [--retries N] [--verbose]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function candidates() {
  const list = [];
  if (process.env.PASEO_CLI_CLIENT_MODULE) list.push(process.env.PASEO_CLI_CLIENT_MODULE);

  const isWin = process.platform === "win32";
  const execOpts = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: isWin };

  // Ask npm where global packages live; this handles nvm/volta/asdf layouts.
  for (const cmd of ["npm", "pnpm"]) {
    try {
      const root = execFileSync(cmd, ["root", "-g"], execOpts).trim();
      if (root) list.push(join(root, ...PKG.split("/"), "dist", "utils", "client.js"));
    } catch {
      // not installed / not on PATH
    }
  }

  // Follow the `paseo` binary if it is a symlink into the package.
  try {
    const whichCmd = isWin ? "where" : "which";
    const bin = execFileSync(whichCmd, ["paseo"], execOpts).trim().split(/\\r?\\n/)[0];
    if (bin) {
      const real = isWin ? bin : realpathSync(bin);
      // .../<pkg>/bin/paseo  or  .../<pkg>/dist/cli.js
      list.push(join(dirname(real), "..", "dist", "utils", "client.js"));
      list.push(join(dirname(real), "dist", "utils", "client.js"));
    }
  } catch {
    // paseo not on PATH
  }

  list.push(
    join(homedir(), ".local/node/lib/node_modules", ...PKG.split("/"), "dist", "utils", "client.js"),
    join("/usr/local/lib/node_modules", ...PKG.split("/"), "dist", "utils", "client.js"),
    join("/usr/lib/node_modules", ...PKG.split("/"), "dist", "utils", "client.js"),
    join("/opt/homebrew/lib/node_modules", ...PKG.split("/"), "dist", "utils", "client.js"),
  );
  if (isWin) {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    list.push(
      join(appData, "npm", "node_modules", ...PKG.split("/"), "dist", "utils", "client.js"),
      join(process.env.ProgramFiles || "C:\\\\Program Files", "nodejs", "node_modules", ...PKG.split("/"), "dist", "utils", "client.js"),
    );
  }
  return [...new Set(list)];
}

function resolveClientModule(verbose) {
  const tried = candidates();
  const found = tried.find((p) => existsSync(p));
  if (verbose) {
    for (const p of tried) console.error(`${p === found ? "using " : "miss  "}${p}`);
  }
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modulePath = resolveClientModule(args.verbose);
  if (!modulePath) {
    throw new Error(`Could not locate ${PKG} client module (set PASEO_CLI_CLIENT_MODULE to dist/utils/client.js)`);
  }

  const { connectToDaemon } = await import(pathToFileURL(modulePath).href);
  const client = await connectToDaemon({ target: { kind: "home", home: args.home } });
  try {
    let lastError;
    for (let attempt = 1; attempt <= args.retries; attempt += 1) {
      try {
        const result = await client.refreshProvidersSnapshot({
          providers: args.providers,
          ...(args.cwd ? { cwd: args.cwd } : {}),
        });
        console.log(`refreshed ${args.providers.join(",")}: ${JSON.stringify(result)}`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < args.retries) {
          // The first liveness check after a daemon wake-up often races; retry.
          console.error(`attempt ${attempt} failed: ${error instanceof Error ? error.message : error}`);
          await sleep(2000);
        }
      }
    }
    throw lastError;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`refresh failed: ${error instanceof Error ? error.message : error}`);
  console.error(
    "If the daemon is unreachable, use the Paseo app's refresh action instead of restarting " +
      "(a restart kills live agent sessions). Try --retries 3 --verbose to diagnose.",
  );
  process.exit(1);
});
