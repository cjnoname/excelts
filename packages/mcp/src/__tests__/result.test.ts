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
import { errorResult, formatBytes, textResult, truncate } from "../tools/result.js";

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
