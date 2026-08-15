#!/usr/bin/env node
/**
 * `documonster-mcp` executable — stdio transport.
 *
 * stdio is the only transport for now because it covers every local AI client
 * and needs no session management or auth. A remote (Streamable HTTP) entry
 * point would live beside this file, sharing `createServer`.
 *
 * Nothing here may write to stdout: stdout IS the protocol channel. All
 * diagnostics go to stderr.
 */

import { readFile } from "node:fs/promises";
import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, readMetaFlags, resolveConfig, usage } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const meta = readMetaFlags(argv);

  if (meta.help) {
    process.stdout.write(usage());
    return;
  }

  const version = await readVersion();

  if (meta.version) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const config = resolveConfig(argv);
  const server = createServer(config, { name: "documonster", version });

  await server.connect(new StdioServerTransport());

  // Report the effective sandbox on stderr so an operator can see, in the
  // client's log, exactly what this process was allowed to touch.
  process.stderr.write(
    `documonster-mcp ${version} ready — root=${config.root} output=${config.outputRoot} readonly=${config.readonly} inPlace=${config.allowInPlace} groups=${[...config.groups].join(",")}\n`
  );
}

/** Read the version from the package manifest, which sits beside `dist/` and `src/`. */
async function readVersion(): Promise<string> {
  try {
    const manifestUrl = new URL("../package.json", import.meta.url);
    const parsed: unknown = JSON.parse(await readFile(manifestUrl, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const { version } = parsed as { version?: unknown };
      if (typeof version === "string") {
        return version;
      }
    }
  } catch {
    // A missing or malformed manifest must not stop the server from starting.
  }
  return "0.0.0";
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`documonster-mcp: ${error.message}\n\n${usage()}`);
    process.exit(2);
  }
  process.stderr.write(
    `documonster-mcp: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
}
