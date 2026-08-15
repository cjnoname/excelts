import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigError, resolveConfig, TOOL_GROUPS } from "../config.js";

async function makeRoot(): Promise<string> {
  // realpath: on macOS `os.tmpdir()` is a symlink (/var -> /private/var), and
  // resolveConfig realpaths the root, so the expected value must too.
  return await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-config-")));
}

describe("resolveConfig", () => {
  it("defaults the root to the current working directory", async () => {
    const cwd = await makeRoot();
    const config = resolveConfig([], { cwd });
    expect(config.root).toBe(cwd);
  });

  it("resolves a relative --root against the cwd", async () => {
    const cwd = await makeRoot();
    const config = resolveConfig(["--root", "."], { cwd });
    expect(config.root).toBe(cwd);
  });

  it("enables every group by default", async () => {
    const config = resolveConfig([], { cwd: await makeRoot() });
    expect([...config.groups].toSorted()).toEqual([...TOOL_GROUPS].toSorted());
  });

  it("restricts groups with --enable, always keeping core", async () => {
    const config = resolveConfig(["--enable", "excel"], { cwd: await makeRoot() });
    expect([...config.groups].toSorted()).toEqual(["core", "excel"]);
  });

  it("allows writes unless --readonly is given", async () => {
    expect(resolveConfig([], { cwd: await makeRoot() }).readonly).toBe(false);
    expect(resolveConfig(["--readonly"], { cwd: await makeRoot() }).readonly).toBe(true);
  });

  it("creates a private output root disjoint from the input root", async () => {
    const cwd = await makeRoot();
    const config = resolveConfig([], { cwd });
    expect(config.outputRoot).not.toBe(config.root);
    expect(path.relative(config.root, config.outputRoot).startsWith("..")).toBe(true);
    expect(config.allowInPlace).toBe(false);
  });

  it("accepts an explicit output root and in-place opt-in", async () => {
    const cwd = await makeRoot();
    const output = await makeRoot();
    const config = resolveConfig(["--output-root", output, "--allow-in-place"], { cwd });
    expect(config.outputRoot).toBe(output);
    expect(config.allowInPlace).toBe(true);
  });

  it("rejects an output root inside the input root", async () => {
    const cwd = await makeRoot();
    await mkdir(path.join(cwd, "generated"));
    expect(() => resolveConfig(["--output-root", path.join(cwd, "generated")], { cwd })).toThrow(
      /must be disjoint/
    );
  });

  it("rejects a flag for a capability the server does not have", async () => {
    // --allow-remote was removed along with the (never implemented) remote
    // document capability: a flag that promises nothing is worse than absent.
    const cwd = await makeRoot();
    expect(() => resolveConfig(["--allow-remote"], { cwd })).toThrow(ConfigError);
  });

  it("rejects a --root that does not exist rather than silently defaulting", async () => {
    const cwd = await makeRoot();
    expect(() => resolveConfig(["--root", path.join(cwd, "nope")], { cwd })).toThrow(ConfigError);
  });

  it("rejects an unknown group", async () => {
    const cwd = await makeRoot();
    expect(() => resolveConfig(["--enable", "spreadsheets"], { cwd })).toThrow(/unknown group/);
  });

  it("rejects an unknown flag", async () => {
    const cwd = await makeRoot();
    expect(() => resolveConfig(["--yolo"], { cwd })).toThrow(ConfigError);
  });

  it("rejects a non-positive size limit", async () => {
    const cwd = await makeRoot();
    expect(() => resolveConfig(["--max-file-size", "0"], { cwd })).toThrow(/positive integer/);
    expect(() => resolveConfig(["--max-file-size", "1.5"], { cwd })).toThrow(/positive integer/);
  });
});
