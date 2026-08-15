import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { assertWritable, isInside, resolveInRoot } from "../sandbox.js";

async function makeConfig(overrides: Partial<ServerConfig> = {}): Promise<ServerConfig> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-sandbox-")));
  const outputRoot = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-output-")));
  return {
    root,
    outputRoot,
    allowInPlace: false,
    readonly: false,
    groups: new Set(["core"]),
    maxFileSize: 1024,
    maxOutputChars: 1000,
    ...overrides
  };
}

/** Assert a rejection carries a specific machine-readable code. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof McpToolError && error.code === code,
    `expected an McpToolError with code "${code}"`
  );
}

describe("resolveInRoot", () => {
  it("resolves a relative path inside the root", async () => {
    const config = await makeConfig();
    await writeFile(path.join(config.root, "a.csv"), "x");
    await expect(resolveInRoot(config, "a.csv", { mustExist: true })).resolves.toBe(
      path.join(config.root, "a.csv")
    );
  });

  it("accepts an absolute path that lands inside the root", async () => {
    const config = await makeConfig();
    const target = path.join(config.root, "a.csv");
    await writeFile(target, "x");
    await expect(resolveInRoot(config, target, { mustExist: true })).resolves.toBe(target);
  });

  it("allows a not-yet-existing write target", async () => {
    const config = await makeConfig();
    await expect(resolveInRoot(config, "out/new.xlsx")).resolves.toBe(
      path.join(config.root, "out", "new.xlsx")
    );
  });

  it("rejects traversal above the root", async () => {
    const config = await makeConfig();
    await expectCode(resolveInRoot(config, "../escaped.txt"), "outside_root");
    await expectCode(resolveInRoot(config, "a/../../escaped.txt"), "outside_root");
  });

  it("rejects an absolute path outside the root", async () => {
    const config = await makeConfig();
    await expectCode(resolveInRoot(config, "/etc/passwd"), "outside_root");
  });

  it("rejects a symlink that points outside the root", async () => {
    // The critical case: the link itself is inside the root, so a naive
    // string prefix check would accept it. Only realpath catches this.
    const config = await makeConfig();
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-outside-")));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(config.root, "link.txt"));

    await expectCode(resolveInRoot(config, "link.txt", { mustExist: true }), "outside_root");
  });

  it("rejects a write target whose parent escapes via a symlinked directory", async () => {
    const config = await makeConfig();
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-outside-")));
    await mkdir(path.join(outside, "sink"));
    // "junction" for directories: on Windows a plain symlink needs elevated
    // privileges, a junction does not, and both are what realpath must see
    // through. On POSIX the type argument is ignored.
    await symlink(path.join(outside, "sink"), path.join(config.root, "sink"), "junction");

    await expectCode(resolveInRoot(config, "sink/written.xlsx"), "outside_root");
  });

  it("rejects a URL but not a Windows drive letter shape", async () => {
    const config = await makeConfig();
    await expectCode(resolveInRoot(config, "https://example.com/a.xlsx"), "invalid_input");
    await expectCode(resolveInRoot(config, "file:///etc/passwd"), "invalid_input");
    // `C:` must not be mistaken for a URL scheme. On POSIX it is simply an
    // ordinary directory name, so the path stays inside the root instead of
    // being rejected — that is correct, and this pins the carve-out.
    await expect(resolveInRoot(config, "C:/Windows/system.ini")).resolves.toBe(
      path.join(config.root, "C:", "Windows", "system.ini")
    );
  });

  it("rejects an empty path", async () => {
    const config = await makeConfig();
    await expectCode(resolveInRoot(config, "   "), "invalid_input");
  });

  it("reports not_found only for genuinely missing inputs", async () => {
    const config = await makeConfig();
    await expectCode(resolveInRoot(config, "missing.xlsx", { mustExist: true }), "not_found");
  });

  it("resolves the root itself", async () => {
    const config = await makeConfig();
    await expect(resolveInRoot(config, ".", { mustExist: true })).resolves.toBe(config.root);
  });
});

describe("assertWritable", () => {
  it("passes when writes are allowed", async () => {
    const config = await makeConfig();
    expect(() => assertWritable(config)).not.toThrow();
  });

  it("throws readonly when they are not", async () => {
    const config = await makeConfig({ readonly: true });
    expect(() => assertWritable(config)).toThrow(McpToolError);
  });
});

describe("isInside", () => {
  it("does not treat a sibling with a shared prefix as contained", () => {
    // The bug a `startsWith` implementation would have.
    expect(isInside("/srv/root", "/srv/root-2/file")).toBe(false);
    expect(isInside("/srv/root", "/srv/root/file")).toBe(true);
    expect(isInside("/srv/root", "/srv/root")).toBe(true);
  });
});
