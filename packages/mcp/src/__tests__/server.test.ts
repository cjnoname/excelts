/**
 * Protocol-level tests.
 *
 * These drive a real MCP client over an in-memory transport, so the handshake,
 * `tools/list`, JSON Schema generation and `tools/call` round-trip are all
 * exercised without spawning a process. A unit test on a handler cannot catch a
 * schema that fails to serialize or a tool that fails to register.
 */

import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { resolveConfig, type ServerConfig } from "../config.js";
import { createServer } from "../server.js";

interface Harness {
  readonly client: Client;
  readonly config: ServerConfig;
  close(): Promise<void>;
}

async function connect(extraArgs: readonly string[] = []): Promise<Harness> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-server-")));
  const config = resolveConfig(["--root", root, ...extraArgs], { cwd: root });
  const server = createServer(config, { name: "documonster", version: "0.0.0-test" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    config,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

/** Extract the concatenated text of a tool result. */
function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

describe("MCP server", () => {
  it("completes the handshake and lists its tools", async () => {
    const harness = await connect();
    try {
      const { tools } = await harness.client.listTools();
      const names = tools.map(tool => tool.name).toSorted();
      expect(names).toEqual([
        "archive_read",
        "archive_write",
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
      await harness.close();
    }
  });

  it("publishes a usable JSON Schema for every tool", async () => {
    const harness = await connect();
    try {
      const { tools } = await harness.client.listTools();
      for (const tool of tools) {
        expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
        expect(tool.inputSchema.type).toBe("object");
      }
    } finally {
      await harness.close();
    }
  });

  it("only exposes groups permitted by --enable", async () => {
    const harness = await connect(["--enable", "excel"]);
    try {
      const { tools } = await harness.client.listTools();
      // archive_read is in the `archive` group and must be gone; the `core`
      // tools survive because resolveConfig always keeps core.
      expect(tools.map(tool => tool.name).toSorted()).toEqual([
        "doc_convert",
        "doc_inspect",
        "documonster_help",
        "formula_evaluate",
        "sheet_edit",
        "sheet_read",
        "sheet_write"
      ]);
    } finally {
      await harness.close();
    }
  });

  it("withholds mutating tools under --readonly", async () => {
    const harness = await connect(["--readonly"]);
    try {
      const names = (await harness.client.listTools()).tools.map(tool => tool.name);
      for (const withheld of [
        "sheet_write",
        "sheet_edit",
        "doc_write",
        "doc_convert",
        "doc_edit",
        "pdf_edit",
        "template_fill",
        "archive_write"
      ]) {
        expect(names, `${withheld} must be withheld`).not.toContain(withheld);
      }
      // Read-only tools stay available.
      for (const available of [
        "sheet_read",
        "formula_evaluate",
        "doc_read",
        "doc_search",
        "template_inspect",
        "archive_read",
        "form_fill",
        "doc_review",
        "doc_paginate"
      ]) {
        expect(names, `${available} must stay available`).toContain(available);
      }
    } finally {
      await harness.close();
    }
  });

  it("returns help topics", async () => {
    const harness = await connect();
    try {
      const listed = (await harness.client.callTool({
        name: "documonster_help",
        arguments: {}
      })) as CallToolResult;
      expect(listed.isError).toBeFalsy();
      expect(textOf(listed)).toContain("overview");

      const topic = (await harness.client.callTool({
        name: "documonster_help",
        arguments: { topic: "sandbox" }
      })) as CallToolResult;
      expect(textOf(topic)).toContain("Path rules");
    } finally {
      await harness.close();
    }
  });

  it("inspects a CSV and reports its real dialect", async () => {
    const harness = await connect();
    try {
      // Semicolon-separated with CRLF and a BOM — the shape a model would
      // otherwise silently misread as a single column.
      await writeFile(
        path.join(harness.config.root, "sales.csv"),
        "\uFEFFregion;amount\r\nAPAC;100\r\nEMEA;200\r\n",
        "utf8"
      );

      const result = (await harness.client.callTool({
        name: "doc_inspect",
        arguments: { path: "sales.csv" }
      })) as CallToolResult;

      const text = textOf(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain("kind: **csv**");
      expect(text).toContain("delimiter: `;`");
      expect(text).toContain("line ending: `\\r\\n`");
      expect(text).toContain("UTF-8 BOM: yes");
      expect(text).toContain("columns in first line: 2");
    } finally {
      await harness.close();
    }
  });

  it("lists a directory", async () => {
    const harness = await connect();
    try {
      await writeFile(path.join(harness.config.root, "a.csv"), "x");
      await writeFile(path.join(harness.config.root, "b.txt"), "yy");

      const result = (await harness.client.callTool({
        name: "doc_inspect",
        arguments: { path: "." }
      })) as CallToolResult;

      const text = textOf(result);
      expect(text).toContain("a.csv");
      expect(text).toContain("b.txt");
    } finally {
      await harness.close();
    }
  });

  it("reports a sandbox escape as a tool error, not a protocol failure", async () => {
    const harness = await connect();
    try {
      const result = (await harness.client.callTool({
        name: "doc_inspect",
        arguments: { path: "../../../etc/passwd" }
      })) as CallToolResult;

      // isError (recoverable, model-readable) rather than a thrown JSON-RPC
      // error, so the model can read the code and stop retrying.
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("[outside_root]");
      expect(textOf(result)).toContain("Hint:");
    } finally {
      await harness.close();
    }
  });

  it("reports a missing file with an actionable code", async () => {
    const harness = await connect();
    try {
      const result = (await harness.client.callTool({
        name: "doc_inspect",
        arguments: { path: "nope.xlsx" }
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("[not_found]");
    } finally {
      await harness.close();
    }
  });

  it("rejects arguments that violate the schema", async () => {
    const harness = await connect();
    try {
      const result = (await harness.client.callTool({
        name: "doc_inspect",
        arguments: { path: "" }
      })) as CallToolResult;
      expect(result.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
