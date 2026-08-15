/**
 * `archive_write` tests.
 *
 * Every archive is read back and its entry list asserted, because "created a
 * 4 KB zip" says nothing about whether it holds the intended files. The budget
 * checks are asserted to fire *before* anything is written, since their purpose
 * is to stop a caller accidentally packaging a whole workspace.
 */

import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArchiveFile } from "documonster/archive";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { archiveWriteTool } from "../tools/archive-write.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-archivewrite-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function create(fx: Fixture, args: Record<string, unknown>): Promise<string> {
  const result = await archiveWriteTool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

/** List the entries of a produced archive. */
async function entriesOf(fx: Fixture, name: string, tar = false): Promise<string[]> {
  const archive = tar
    ? await ArchiveFile.fromFile(path.join(fx.root, name), { format: "tar" })
    : await ArchiveFile.fromFile(path.join(fx.root, name));
  return (await archive.getEntries()).map(entry => entry.path).toSorted();
}

async function seed(fx: Fixture): Promise<void> {
  await mkdir(path.join(fx.root, "out/nested"), { recursive: true });
  await writeFile(path.join(fx.root, "out/a.csv"), "x,y\n1,2\n", "utf8");
  await writeFile(path.join(fx.root, "out/b.txt"), "bee", "utf8");
  await writeFile(path.join(fx.root, "out/nested/c.md"), "# see\n", "utf8");
  await writeFile(path.join(fx.root, "loose.txt"), "loose", "utf8");
}

describe("archive_write", () => {
  it("packages named files", async () => {
    const fx = await fixture();
    await seed(fx);

    const report = await create(fx, {
      out: "bundle.zip",
      entries: [{ path: "out/a.csv" }, { path: "loose.txt" }]
    });

    expect(report).toContain("2 file(s)");
    expect(await entriesOf(fx, "bundle.zip")).toEqual(["a.csv", "loose.txt"]);
  });

  it("renames entries inside the archive", async () => {
    const fx = await fixture();
    await seed(fx);
    await create(fx, {
      out: "bundle.zip",
      entries: [{ path: "out/a.csv", as: "data/june.csv" }]
    });
    expect(await entriesOf(fx, "bundle.zip")).toEqual(["data/june.csv"]);
  });

  it("adds a directory recursively under a prefix", async () => {
    const fx = await fixture();
    await seed(fx);
    await create(fx, { out: "all.zip", entries: [{ path: "out", as: "report" }] });

    const entries = await entriesOf(fx, "all.zip");
    expect(entries).toContain("report/a.csv");
    expect(entries).toContain("report/nested/c.md");
  });

  it("produces a tar when the extension says so", async () => {
    const fx = await fixture();
    await seed(fx);
    await create(fx, { out: "bundle.tar", entries: [{ path: "loose.txt" }] });
    expect(await entriesOf(fx, "bundle.tar", true)).toEqual(["loose.txt"]);
  });

  it("verifies by reading the archive back", async () => {
    const fx = await fixture();
    await seed(fx);
    const report = await create(fx, { out: "b.zip", entries: [{ path: "loose.txt" }] });
    expect(report).toContain("Verified by reading the archive back");
    expect(report).toContain("`loose.txt`");
  });

  it("creates the parent directory", async () => {
    const fx = await fixture();
    await seed(fx);
    await create(fx, { out: "dist/deep/b.zip", entries: [{ path: "loose.txt" }] });
    await expect(stat(path.join(fx.root, "dist/deep/b.zip"))).resolves.toBeDefined();
  });

  it("refuses to overwrite unless told to", async () => {
    const fx = await fixture();
    await seed(fx);
    await create(fx, { out: "b.zip", entries: [{ path: "loose.txt" }] });

    await expect(
      archiveWriteTool.handler(
        { out: "b.zip", entries: [{ path: "loose.txt" }] },
        { config: fx.config }
      )
    ).rejects.toThrow(/already exists/);

    await create(fx, { out: "b.zip", entries: [{ path: "out/b.txt" }], overwrite: true });
    expect(await entriesOf(fx, "b.zip")).toEqual(["b.txt"]);
  });

  it("rejects an extension it cannot map to a format", async () => {
    const fx = await fixture();
    await seed(fx);
    await expect(
      archiveWriteTool.handler(
        { out: "bundle.7z", entries: [{ path: "loose.txt" }] },
        { config: fx.config }
      )
    ).rejects.toThrow(/cannot tell the archive format/);
  });

  it("rejects a missing input before writing anything", async () => {
    const fx = await fixture();
    await seed(fx);
    await expect(
      archiveWriteTool.handler(
        { out: "b.zip", entries: [{ path: "loose.txt" }, { path: "nope.txt" }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "not_found",
      "expected a not_found error"
    );
    await expect(stat(path.join(fx.root, "b.zip"))).rejects.toThrow();
  });

  it("refuses a file over the per-file limit before writing", async () => {
    const fx = await fixture(["--max-file-size", "16"]);
    await writeFile(path.join(fx.root, "big.txt"), "x".repeat(1000), "utf8");

    await expect(
      archiveWriteTool.handler(
        { out: "b.zip", entries: [{ path: "big.txt" }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "too_large",
      "expected a too_large error"
    );
    await expect(stat(path.join(fx.root, "b.zip"))).rejects.toThrow();
  });

  it("applies the per-file limit inside a walked directory", async () => {
    // "Add this directory" is how a caller accidentally packages one enormous
    // file, so the cap has to reach inside the walk rather than only the
    // directory total.
    const fx = await fixture(["--max-file-size", "16"]);
    await mkdir(path.join(fx.root, "heavy"), { recursive: true });
    await writeFile(path.join(fx.root, "heavy/big.txt"), "x".repeat(1000), "utf8");

    await expect(
      archiveWriteTool.handler(
        { out: "h.zip", entries: [{ path: "heavy" }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "too_large",
      "expected a too_large error naming the offending file"
    );
    await expect(stat(path.join(fx.root, "h.zip"))).rejects.toThrow();
  });

  it("rejects an entry name that would escape on extraction", async () => {
    // An archive is data handed to someone else: this tool must not be the
    // producer of a Zip Slip payload.
    const fx = await fixture();
    await seed(fx);

    for (const as of ["../../escape.txt", "a/../../b.txt", "..\\..\\win.txt"]) {
      await expect(
        archiveWriteTool.handler(
          { out: "x.zip", entries: [{ path: "loose.txt", as }], overwrite: true },
          { config: fx.config }
        ),
        as
      ).rejects.toThrow(/must not contain/);
    }

    await expect(
      archiveWriteTool.handler(
        { out: "x.zip", entries: [{ path: "loose.txt", as: "C:/abs.txt" }], overwrite: true },
        { config: fx.config }
      )
    ).rejects.toThrow(/absolute Windows path/);
  });

  it("normalises a leading slash rather than rejecting it", async () => {
    // "/data/x.txt" is a plausible way to name an entry and cannot escape once
    // the leading separator is dropped, so it is accepted as relative.
    const fx = await fixture();
    await seed(fx);
    await create(fx, {
      out: "abs.zip",
      entries: [{ path: "loose.txt", as: "/data/x.txt" }],
      overwrite: true
    });
    expect(await entriesOf(fx, "abs.zip")).toEqual(["data/x.txt"]);
  });

  it("cannot read inputs from outside the sandbox root", async () => {
    const fx = await fixture();
    await seed(fx);
    await expect(
      archiveWriteTool.handler(
        { out: "b.zip", entries: [{ path: "../../etc/hosts" }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "outside_root",
      "expected an outside_root error"
    );
  });

  it("cannot write outside the sandbox root", async () => {
    const fx = await fixture();
    await seed(fx);
    await expect(
      archiveWriteTool.handler(
        { out: "../escape.zip", entries: [{ path: "loose.txt" }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "outside_root",
      "expected an outside_root error"
    );
  });

  it("is withheld under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    await expect(
      archiveWriteTool.handler(
        { out: "b.zip", entries: [{ path: "loose.txt" }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });

  it("round-trips with archive_read", async () => {
    // The pair is the point: pack outputs, then a later session unpacks them.
    const fx = await fixture();
    await seed(fx);
    await create(fx, { out: "rt.zip", entries: [{ path: "out", as: "report" }] });

    const { archiveReadTool } = await import("../tools/archive-read.js");
    const result = await archiveReadTool.handler(
      { path: "rt.zip", action: "extract", out: "back" },
      { config: fx.config }
    );
    expect(result.isError).toBeUndefined();

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(fx.root, "back/report/nested/c.md"), "utf8")).toBe("# see\n");
  });
});
