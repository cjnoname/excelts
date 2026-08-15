/**
 * Registry tests.
 *
 * These use fabricated tool definitions rather than the real registry on
 * purpose. Every tool shipped today is in the `core` group, and `core` is
 * always enabled — so asserting against the real registry would exercise only
 * the "nothing was filtered" path and pass no matter how broken the filter was.
 * Fabricated tools cover the positive path: a disabled group's tools really do
 * disappear, and so do mutating tools under `--readonly`.
 */

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { resolveConfig, type ServerConfig, type ToolGroup } from "../config.js";
import { ALL_TOOLS, selectTools } from "../tools/index.js";
import { defineTool, type AnyToolDefinition } from "../tools/types.js";

async function makeConfig(args: readonly string[] = []): Promise<ServerConfig> {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-registry-")));
  return resolveConfig(args, { cwd });
}

function fakeTool(name: string, group: ToolGroup, mutates: boolean): AnyToolDefinition {
  return defineTool({
    name,
    group,
    title: name,
    description: `fake ${name}`,
    inputSchema: { value: z.string() },
    mutates,
    handler: async () => ({ content: [{ type: "text", text: name }] })
  });
}

const FIXTURE: readonly AnyToolDefinition[] = [
  fakeTool("core_read", "core", false),
  fakeTool("excel_read", "excel", false),
  fakeTool("excel_write", "excel", true),
  fakeTool("word_read", "word", false),
  fakeTool("archive_write", "archive", true)
];

/** Run the REAL predicate over the fixtures — never a copy of it. */
function select(config: ServerConfig): string[] {
  return selectTools(config, FIXTURE)
    .map(tool => tool.name)
    .toSorted();
}

describe("selectTools", () => {
  it("keeps every tool when all groups are enabled and writes are allowed", async () => {
    const config = await makeConfig();
    expect(select(config)).toEqual([
      "archive_write",
      "core_read",
      "excel_read",
      "excel_write",
      "word_read"
    ]);
  });

  it("drops tools whose group is not enabled", async () => {
    const config = await makeConfig(["--enable", "excel"]);
    // word_read and archive_write must be gone; core survives because
    // resolveConfig always adds it.
    expect(select(config)).toEqual(["core_read", "excel_read", "excel_write"]);
  });

  it("drops mutating tools under --readonly", async () => {
    const config = await makeConfig(["--readonly"]);
    expect(select(config)).toEqual(["core_read", "excel_read", "word_read"]);
  });

  it("applies both filters together", async () => {
    const config = await makeConfig(["--enable", "excel", "--readonly"]);
    expect(select(config)).toEqual(["core_read", "excel_read"]);
  });

  it("filters the real registry with the same predicate", async () => {
    // Guards against the two lists drifting: whatever ships must satisfy the
    // same invariants the fixtures assert.
    const config = await makeConfig(["--readonly"]);
    const selected = selectTools(config);
    expect(
      selected.every(tool => {
        const groups = Array.isArray(tool.group) ? tool.group : [tool.group];
        return groups.some(group => config.groups.has(group));
      })
    ).toBe(true);
    expect(selected.some(tool => tool.mutates)).toBe(false);
  });
});

describe("ALL_TOOLS", () => {
  it("has unique names", () => {
    const names = ALL_TOOLS.map(tool => tool.name);
    expect(names).toEqual([...new Set(names)]);
  });

  it("uses snake_case names, since renaming one is a breaking change", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("gives every tool a description and a title", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
    }
  });

  it("marks exactly the filesystem-writing tools as mutating", () => {
    // `mutates` drives withholding under --readonly, so a write tool that
    // forgets the flag would stay callable in a read-only server. Every tool
    // listed here must also call `assertWritable` before touching the disk.
    expect(
      ALL_TOOLS.filter(tool => tool.mutates)
        .map(tool => tool.name)
        .toSorted()
    ).toEqual([
      "archive_write",
      "doc_convert",
      "doc_edit",
      "doc_write",
      "pdf_edit",
      "sheet_edit",
      "sheet_write",
      "template_fill"
    ]);
  });

  it("never claims readOnlyHint for a tool that always writes", () => {
    // The reverse does not hold: `archive_read`, `form_fill`, `doc_review` and `doc_paginate`
    // write only when given a write-triggering argument, so they stay visible
    // under --readonly (mutates: false) while still declaring
    // readOnlyHint: false, because a call *can* write.
    for (const tool of ALL_TOOLS) {
      if (tool.mutates) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      }
    }
  });

  it("keeps conditionally-writing tools available under --readonly", () => {
    // Their read-only mode is genuinely useful — listing a form's fields,
    // comparing two documents, counting pages — so withholding them entirely
    // would remove capability a read-only server can safely offer.
    const conditional = ["archive_read", "form_fill", "doc_review", "doc_paginate"];
    for (const name of conditional) {
      const tool = ALL_TOOLS.find(candidate => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.mutates, `${name} must not be withheld under --readonly`).toBe(false);
    }
  });
});
