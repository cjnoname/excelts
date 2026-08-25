/**
 * The size of what every request carries.
 *
 * Each enabled tool's name, description and JSON Schema is sent to the model on
 * *every* request, so the serialised `tools/list` is a permanent tax on the caller's
 * context — and unlike a slow test or a large file, nothing about it is visible while
 * it grows. Two tools in this server have already reached 7 000 characters each.
 *
 * These budgets are not aspirations. They are a tripwire: exceeding one should make
 * whoever added a field decide, deliberately, between trimming it and raising the
 * number with a reason. `documonster_help` exists precisely so that detail can live
 * somewhere a model pays for only when it needs it.
 */

import { z } from "zod";

import { resolveConfig } from "../config.js";
import { selectTools } from "../tools/index.js";

/** Characters the whole default tool list may serialise to. */
const TOTAL_BUDGET = 52_000;

/** Characters any single tool may serialise to. */
const PER_TOOL_BUDGET = 8_000;

/** Roughly four characters to a token, which is what makes the number meaningful. */
const CHARS_PER_TOKEN = 4;

function serialise(tool: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}): number {
  const schema = z.toJSONSchema(z.object(tool.inputSchema as never), { io: "input" });
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: schema
  }).length;
}

describe("tools/list context cost", () => {
  const config = resolveConfig([], { cwd: process.cwd() });
  const tools = selectTools(config);
  const sizes = tools.map(tool => [tool.name, serialise(tool)] as const);
  const total = sizes.reduce((sum, [, size]) => sum + size, 0);

  it("stays inside the whole-list budget", () => {
    const worst = [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 5);
    expect(
      total,
      `default tools/list is ${total} chars (~${Math.round(total / CHARS_PER_TOKEN)} tokens). ` +
        `Largest: ${worst.map(([name, size]) => `${name}=${size}`).join(", ")}. ` +
        "Move rarely-used fields into documonster_help, or raise TOTAL_BUDGET with a reason."
    ).toBeLessThanOrEqual(TOTAL_BUDGET);
  });

  it("keeps every individual tool inside its budget", () => {
    for (const [name, size] of sizes) {
      expect(
        size,
        `${name} serialises to ${size} chars. Push detail into documonster_help.`
      ).toBeLessThanOrEqual(PER_TOOL_BUDGET);
    }
  });

  it("charges nothing for a group that is switched off", () => {
    // The point of `--enable`: a caller who only reads spreadsheets should not pay
    // for the Word, PDF and diagram schemas on every request.
    const narrow = selectTools(resolveConfig(["--enable", "excel"], { cwd: process.cwd() }));
    const narrowTotal = narrow.map(serialise).reduce((sum, size) => sum + size, 0);
    expect(narrowTotal).toBeLessThan(total / 2);
    expect(narrow.some(tool => tool.name === "diagram_render")).toBe(false);
  });
});
