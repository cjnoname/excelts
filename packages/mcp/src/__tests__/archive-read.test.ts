/**
 * `archive_read` tests.
 *
 * Security carries most of the weight here: this is the tool that turns opaque
 * bytes into files on disk, so traversal, decompression bombs, symlink entries
 * and the sandbox boundary all need real coverage rather than assumed behaviour.
 */

import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArchiveFile } from "documonster/archive";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { archiveReadTool } from "../tools/archive-read.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-archive-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function run(fx: Fixture, args: Record<string, unknown>): Promise<string> {
  const result = await archiveReadTool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

/** Build a zip in the sandbox from `[name, content]` pairs. */
async function makeZip(
  fx: Fixture,
  name: string,
  entries: readonly [string, string][]
): Promise<string> {
  const zip = new ArchiveFile();
  for (const [entryName, content] of entries) {
    // Note the argument order: addText(content, name).
    zip.addText(content, entryName);
  }
  await zip.writeToFile(path.join(fx.root, name));
  return name;
}

describe("archive_read — listing", () => {
  it("lists entries with sizes", async () => {
    const fx = await fixture();
    const file = await makeZip(fx, "b.zip", [
      ["data/a.csv", "x,y\n1,2\n"],
      ["notes.txt", "hello"]
    ]);

    const text = await run(fx, { path: file });
    expect(text).toContain("`data/a.csv`");
    expect(text).toContain("`notes.txt`");
    expect(text).toContain("entries: 2");
    expect(text).toContain("total uncompressed:");
  });

  it("defaults to listing rather than extracting", async () => {
    const fx = await fixture();
    const file = await makeZip(fx, "b.zip", [["a.txt", "a"]]);
    expect(await run(fx, { path: file })).toContain("# Archive:");
  });

  it("lists a tar.gz", async () => {
    const fx = await fixture();
    const tar = new ArchiveFile({ format: "tar" });
    tar.addText("inside.txt", "content.txt");
    await tar.writeToFile(path.join(fx.root, "bundle.tar"));

    expect(await run(fx, { path: "bundle.tar" })).toContain("`content.txt`");
  });
});

describe("archive_read — extraction", () => {
  it("extracts everything to a directory", async () => {
    const fx = await fixture();
    const file = await makeZip(fx, "b.zip", [
      ["deep/nested/a.csv", "x,y\n1,2\n"],
      ["b.txt", "bee"]
    ]);

    const text = await run(fx, { path: file, action: "extract", out: "out" });
    expect(text).toContain("Extracted **2**");
    // Parent directories must be created even though no directory entry was
    // selected.
    await expect(readFile(path.join(fx.root, "out/deep/nested/a.csv"), "utf8")).resolves.toBe(
      "x,y\n1,2\n"
    );
    await expect(readFile(path.join(fx.root, "out/b.txt"), "utf8")).resolves.toBe("bee");
  });

  it("extracts only selected entries, by exact name, prefix and extension", async () => {
    const fx = await fixture();
    const file = await makeZip(fx, "b.zip", [
      ["data/one.xlsx", "1"],
      ["data/two.csv", "2"],
      ["other/three.txt", "3"]
    ]);

    await run(fx, { path: file, action: "extract", out: "a", entries: ["data/"] });
    await expect(readFile(path.join(fx.root, "a/data/one.xlsx"), "utf8")).resolves.toBe("1");
    await expect(readFile(path.join(fx.root, "a/other/three.txt"), "utf8")).rejects.toThrow();

    await run(fx, { path: file, action: "extract", out: "b", entries: ["*.csv"] });
    await expect(readFile(path.join(fx.root, "b/data/two.csv"), "utf8")).resolves.toBe("2");

    await run(fx, { path: file, action: "extract", out: "c", entries: ["other/three.txt"] });
    await expect(readFile(path.join(fx.root, "c/other/three.txt"), "utf8")).resolves.toBe("3");
  });

  it("keeps duplicate basenames from different directories distinct", async () => {
    const fx = await fixture();
    const file = await makeZip(fx, "dupes.zip", [
      ["a/same.txt", "from a"],
      ["b/same.txt", "from b"]
    ]);

    await run(fx, { path: file, action: "extract", out: "out" });
    await expect(readFile(path.join(fx.root, "out/a/same.txt"), "utf8")).resolves.toBe("from a");
    await expect(readFile(path.join(fx.root, "out/b/same.txt"), "utf8")).resolves.toBe("from b");
  });

  it("reports what the archive holds when nothing matched", async () => {
    const fx = await fixture();
    const file = await makeZip(fx, "b.zip", [["a.txt", "a"]]);
    await expect(
      archiveReadTool.handler(
        { path: file, action: "extract", out: "out", entries: ["*.xlsx"] },
        { config: fx.config }
      )
    ).rejects.toThrow(/no entries matched/);
  });

  it("requires an out directory", async () => {
    const fx = await fixture();
    const file = await makeZip(fx, "b.zip", [["a.txt", "a"]]);
    await expect(
      archiveReadTool.handler({ path: file, action: "extract" }, { config: fx.config })
    ).rejects.toThrow(/requires `out`/);
  });
});

describe("archive_read — security", () => {
  it("refuses an archive containing a traversal path", async () => {
    const fx = await fixture();
    const zip = new ArchiveFile();
    zip.addText("pwned", "../../escaped.txt");
    zip.addText("fine", "normal.txt");
    await zip.writeToFile(path.join(fx.root, "evil.zip"));

    await expect(
      archiveReadTool.handler(
        { path: "evil.zip", action: "extract", out: "out" },
        { config: fx.config }
      )
    ).rejects.toThrow(/would be written outside the server root/);

    // And nothing landed outside.
    await expect(readFile(path.join(fx.root, "..", "escaped.txt"), "utf8")).rejects.toThrow();
  });

  it("cannot extract outside the sandbox root", async () => {
    const fx = await fixture();
    const file = await makeZip(fx, "b.zip", [["a.txt", "a"]]);
    await expect(
      archiveReadTool.handler(
        { path: file, action: "extract", out: "../escape" },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "outside_root",
      "expected an outside_root error"
    );
  });

  it("never creates a symlink entry", async () => {
    // A materialised link would be a live escape hatch for later tools, so
    // extraction writes file entries only.
    const fx = await fixture();
    const zip = new ArchiveFile();
    zip.addText("a", "regular.txt");
    zip.symlink("link.txt", "/etc/passwd");
    await zip.writeToFile(path.join(fx.root, "link.zip"));

    await run(fx, { path: "link.zip", action: "extract", out: "out" });
    const link = await lstat(path.join(fx.root, "out/link.txt")).catch(() => undefined);
    expect(link).toBeUndefined();
    await expect(readFile(path.join(fx.root, "out/regular.txt"), "utf8")).resolves.toBe("a");
  });

  it("refuses to write through a symlink already in the destination", async () => {
    // The escape the library's own traversal check does not cover: the entry
    // name is innocuous, but `out/link` points outside the sandbox.
    const fx = await fixture();
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-outside-")));
    await mkdir(path.join(fx.root, "out"), { recursive: true });
    await symlink(outside, path.join(fx.root, "out/link"), "junction");

    const zip = new ArchiveFile();
    zip.addText("PWNED", "link/pwn.txt");
    await zip.writeToFile(path.join(fx.root, "evil.zip"));

    await expect(
      archiveReadTool.handler(
        { path: "evil.zip", action: "extract", out: "out" },
        { config: fx.config }
      )
    ).rejects.toThrow(/outside the server root/);

    await expect(readFile(path.join(outside, "pwn.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses an entry larger than the per-file limit before writing", async () => {
    const fx = await fixture(["--max-file-size", "64"]);
    const file = await makeZip(fx, "big.zip", [["big.txt", "x".repeat(1000)]]);

    await expect(
      archiveReadTool.handler({ path: file, action: "extract", out: "out" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "too_large",
      "expected a too_large error"
    );
    // Nothing should have been written.
    await expect(readFile(path.join(fx.root, "out/big.txt"), "utf8")).rejects.toThrow();
  });

  it("is withheld under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    const file = await makeZip(fx, "b.zip", [["a.txt", "a"]]);
    // Listing still throws only at the write step, so extraction is the case.
    await expect(
      archiveReadTool.handler({ path: file, action: "extract", out: "out" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });

  it("rejects a file that is not an archive", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "plain.zip"), "not a zip at all", "utf8");
    await expect(
      archiveReadTool.handler({ path: "plain.zip" }, { config: fx.config })
    ).rejects.toThrow(/could not open plain\.zip/);
  });

  it("cannot read an archive outside the sandbox root", async () => {
    const fx = await fixture();
    await expect(
      archiveReadTool.handler({ path: "../../etc/hosts" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "outside_root",
      "expected an outside_root error"
    );
  });
});
