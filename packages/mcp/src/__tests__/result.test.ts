/**
 * Output-budget tests.
 *
 * A tool result lands directly in the model's context, so truncation is a
 * correctness concern rather than cosmetics: a silently cut-off table is worse
 * than no table, because the model reasons over it as if it were complete.
 */

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig, type ServerConfig } from "../config.js";
import {
  errorResult,
  escapeTableCell,
  formatBytes,
  textResult,
  truncate
} from "../tools/result.js";

async function configWith(maxOutputChars: number): Promise<ServerConfig> {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-result-")));
  return resolveConfig(["--max-output-chars", String(maxOutputChars)], { cwd });
}

describe("truncate", () => {
  it("leaves text within budget untouched", async () => {
    const config = await configWith(100);
    expect(truncate(config, "short")).toBe("short");
  });

  it("keeps text exactly at the budget untouched", async () => {
    const config = await configWith(10);
    expect(truncate(config, "0123456789")).toBe("0123456789");
  });

  it("truncates and states how much was dropped", async () => {
    const config = await configWith(10);
    const result = truncate(config, "0123456789ABCDE");
    expect(result.startsWith("0123456789")).toBe(true);
    expect(result).toContain("[truncated: 5 more characters");
  });

  it("tells the model what to do about it", async () => {
    // Without an instruction the model tends to proceed on partial data.
    const config = await configWith(4);
    expect(truncate(config, "x".repeat(50))).toMatch(/narrower range|pagination/);
  });
});

describe("textResult", () => {
  it("applies the budget", async () => {
    const config = await configWith(5);
    const result = textResult(config, "x".repeat(20));
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text" });
    const block = result.content[0];
    expect(block?.type === "text" && block.text.includes("[truncated:")).toBe(true);
  });
});

describe("errorResult", () => {
  it("marks the result as an error so the model can react", () => {
    const result = errorResult("[not_found] nope");
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "[not_found] nope" });
  });
});

/**
 * A cell that leaks a delimiter shifts every later column, and the model has no
 * way to notice — so the escaping has to hold for adversarial content, not just
 * for a bare pipe.
 */
describe("escapeTableCell", () => {
  it("escapes a pipe so it cannot split the cell", () => {
    expect(escapeTableCell("a|b")).toBe("a\\|b");
  });

  it("escapes a backslash before the pipe it precedes", () => {
    // Escaping only the pipe yields `a\\|b`, which GFM reads as an escaped
    // backslash followed by a live delimiter — the break the escaping exists to
    // prevent.
    expect(escapeTableCell("a\\|b")).toBe("a\\\\\\|b");
  });

  it("leaves no odd-length backslash run in front of a pipe", () => {
    for (let backslashes = 0; backslashes <= 5; backslashes += 1) {
      const escaped = escapeTableCell(`${"\\".repeat(backslashes)}|`);
      const run = /(\\*)\\\|$/.exec(escaped);
      expect(run).not.toBeNull();
      // The delimiter's own escape is the last backslash; everything before it
      // must pair up, or one of them consumes that escape.
      expect((run?.[1]?.length ?? 0) % 2).toBe(0);
    }
  });

  it("collapses newlines so a cell cannot end its row early", () => {
    expect(escapeTableCell("a\r\nb\nc\rd")).toBe("a b c d");
  });

  it("clips before escaping, so a limit never cuts an escape in half", () => {
    // Slicing the escaped form at 2 would yield `a\`, whose dangling backslash
    // escapes the closing delimiter instead of a character of content.
    expect(escapeTableCell("a|b", 2)).toBe("a\\|");
  });

  it("counts the limit in source characters", () => {
    expect(escapeTableCell("||||", 2)).toBe("\\|\\|");
  });

  it("leaves text within the limit untouched", () => {
    expect(escapeTableCell("plain", 100)).toBe("plain");
  });
});

describe("formatBytes", () => {
  it("reports raw bytes below 1 KiB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("scales to binary units", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64.0 MiB");
  });

  it("stops at GiB rather than inventing a unit", () => {
    expect(formatBytes(1024 ** 4)).toBe("1024.0 GiB");
  });
});
