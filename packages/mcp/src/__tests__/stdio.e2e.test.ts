/**
 * End-to-end stdio tests.
 *
 * Everything else in this suite uses an in-memory transport, which cannot catch
 * the failures specific to shipping an executable: a missing shebang, a `bin`
 * pointing at the wrong file, a manifest path that only resolves from `src/`,
 * or a stray `console.log` corrupting the protocol stream. Those only appear
 * when a real client spawns a real process, which is what this does.
 *
 * The suite builds the package itself in `beforeAll` so it is honest from any
 * entry point — `vitest run`, `vitest --watch`, or CI — instead of silently
 * skipping when `dist/` happens to be missing.
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLI_PATH = path.join(PACKAGE_ROOT, "dist", "cli.js");

beforeAll(async () => {
  // Build rather than assume: an e2e test that skips when dist/ is absent is a
  // green light that proves nothing.
  await execFileAsync(
    process.execPath,
    [
      path.join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      path.join(PACKAGE_ROOT, "tsconfig.build.json")
    ],
    { cwd: PACKAGE_ROOT }
  );
}, 120_000);

async function makeRoot(): Promise<string> {
  return await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-e2e-")));
}

interface Spawned {
  readonly client: Client;
  close(): Promise<void>;
}

async function spawnServer(root: string, extraArgs: readonly string[] = []): Promise<Spawned> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, "--root", root, ...extraArgs],
    stderr: "pipe"
  });
  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** Every JSON-RPC message emitted on stdout so far. */
interface RpcMessage {
  readonly id?: number;
  readonly result?: unknown;
}

function parseLines(stdout: string): RpcMessage[] {
  const messages: RpcMessage[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      messages.push(JSON.parse(line) as RpcMessage);
    } catch {
      // A malformed line is itself a failure, asserted by the caller.
    }
  }
  return messages;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

describe("documonster-mcp executable", () => {
  it("prints its version and exits cleanly", async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "--version"]);
    // Must be the manifest version, not the "0.0.0-unknown" embedder fallback:
    // this is what catches a manifest path that breaks once compiled to dist/.
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(stdout.trim()).not.toBe("0.0.0-unknown");
  });

  it("prints usage for --help", async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "--help"]);
    expect(stdout).toContain("documonster-mcp");
    expect(stdout).toContain("--root");
  });

  it("exits with code 2 and usage on a bad flag", async () => {
    await expect(execFileAsync(process.execPath, [CLI_PATH, "--nope"])).rejects.toSatisfy(
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        return failure.code === 2 && (failure.stderr ?? "").includes("Unknown option");
      },
      "expected exit code 2 with usage on stderr"
    );
  });

  it("exits with code 2 when --root does not exist", async () => {
    await expect(
      execFileAsync(process.execPath, [CLI_PATH, "--root", "/definitely/not/here"])
    ).rejects.toSatisfy((error: unknown) => (error as { code?: number }).code === 2);
  });

  it("completes a real MCP handshake over stdio", async () => {
    const root = await makeRoot();
    const server = await spawnServer(root);
    try {
      const info = server.client.getServerVersion();
      expect(info?.name).toBe("documonster");
      const { tools } = await server.client.listTools();
      expect(tools.map(tool => tool.name).toSorted()).toEqual([
        "archive_read",
        "archive_write",
        "diagram_inspect",
        "diagram_render",
        "doc_convert",
        "doc_edit",
        "doc_inspect",
        "doc_paginate",
        "doc_read",
        "doc_review",
        "doc_search",
        "doc_write",
        "documonster_help",
        "form_fill",
        "formula_evaluate",
        "pdf_edit",
        "sheet_edit",
        "sheet_read",
        "sheet_write",
        "template_fill",
        "template_inspect"
      ]);
    } finally {
      await server.close();
    }
  });

  it("keeps stdout free of anything but protocol traffic", async () => {
    // stdout IS the transport. A single stray write corrupts the stream, and the
    // failure surfaces later as an unrelated parse error.
    //
    // This must not go through the SDK client: the client tolerates
    // unparseable lines, so a `console.log` in the server passes unnoticed.
    // Verified by mutation — adding a `console.log` to cli.ts makes only this
    // test fail. So we speak raw JSON-RPC and inspect every byte of stdout.
    const root = await makeRoot();
    await writeFile(path.join(root, "a.csv"), "x,y\n1,2\n", "utf8");

    const child = spawn(process.execPath, [CLI_PATH, "--root", root], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "1.0.0" }
      }
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "doc_inspect", arguments: { path: "a.csv" } }
    });

    try {
      // Wait for the third response rather than a fixed delay.
      await vi.waitFor(
        () => {
          const ids = parseLines(stdout).map(message => message.id);
          expect(ids).toContain(3);
        },
        { timeout: 15_000, interval: 50 }
      );

      const lines = stdout.split("\n").filter(line => line.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(3);

      // Every single line must be a JSON-RPC message — this is the assertion
      // that a stray console.log breaks.
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        expect(parsed, `not a JSON-RPC message: ${line}`).toMatchObject({ jsonrpc: "2.0" });
      }

      const responses = parseLines(stdout);
      expect(responses.find(message => message.id === 1)?.result).toMatchObject({
        serverInfo: { name: "documonster" }
      });
      expect(JSON.stringify(responses.find(message => message.id === 3))).toContain(
        "kind: **csv**"
      );
    } finally {
      child.kill();
    }
  });

  it("enforces the sandbox in a real process", async () => {
    const root = await makeRoot();
    const server = await spawnServer(root);
    try {
      const result = (await server.client.callTool({
        name: "doc_inspect",
        arguments: { path: "/etc/hosts" }
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("[outside_root]");
    } finally {
      await server.close();
    }
  });
});
