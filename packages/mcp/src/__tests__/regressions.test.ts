/**
 * Regression tests for the sandbox escapes and data-loss paths found in review.
 *
 * Each case here was a working escape or a silent corruption before the fix, and
 * each is written to fail loudly if the fix is ever undone. They live in one file
 * because they share a shape — plant something hostile in or beside the sandbox,
 * then assert both that the tool refuses *and* that nothing outside the root was
 * touched.
 */

import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArchiveFile } from "documonster/archive";
import { Cell, Workbook, Worksheet } from "documonster/excel";
import { Pdf } from "documonster/pdf";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { resolveInRoot } from "../sandbox.js";
import { archiveReadTool } from "../tools/archive-read.js";
import { archiveWriteTool } from "../tools/archive-write.js";
import { docReadTool } from "../tools/doc-read.js";
import { formFillTool } from "../tools/form-fill.js";
import { formulaEvaluateTool } from "../tools/formula-evaluate.js";
import { writeFileAtomic, writeWithPolicy } from "../tools/fs-helpers.js";
import { pdfEditTool } from "../tools/pdf-edit.js";
import { sheetEditTool } from "../tools/sheet-edit.js";
import { sheetReadTool } from "../tools/sheet-read.js";
import { sheetWriteTool } from "../tools/sheet-write.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
  readonly outside: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-reg-")));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-out-")));
  const base = resolveConfig(args, { cwd: root });
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root,
    outside
  };
}

async function secureFixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-input-")));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-outside-")));
  const outputRoot = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-output-")));
  return {
    config: resolveConfig(["--output-root", outputRoot, ...args], { cwd: root }),
    root,
    outside
  };
}

function expectOutsideRoot(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof McpToolError && error.code === "outside_root",
    "expected an outside_root error"
  );
}

describe("sandbox — symlink escapes", () => {
  it("rejects a dangling symlink pointing outside the root", async () => {
    // The original hole: `realpath` throws ENOENT both for "missing" and for
    // "symlink to something missing", and treating the second as the first let a
    // write target resolve to the link's external destination.
    const fx = await fixture();
    const external = path.join(fx.outside, "created.txt");
    await symlink(external, path.join(fx.root, "target.txt"));

    await expectOutsideRoot(resolveInRoot(fx.config, "target.txt"));
    await expect(readFile(external, "utf8")).rejects.toThrow();
  });

  it("rejects a live symlink pointing outside the root", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.outside, "secret.txt"), "secret", "utf8");
    await symlink(path.join(fx.outside, "secret.txt"), path.join(fx.root, "link.txt"));

    await expectOutsideRoot(resolveInRoot(fx.config, "link.txt", { mustExist: true }));
  });

  it("rejects a path whose intermediate directory is an external symlink", async () => {
    const fx = await fixture();
    await mkdir(path.join(fx.outside, "sink"), { recursive: true });
    await symlink(path.join(fx.outside, "sink"), path.join(fx.root, "sink"), "junction");

    await expectOutsideRoot(resolveInRoot(fx.config, "sink/inner/file.txt"));
  });

  it("refuses a symlink loop instead of hanging", async () => {
    const fx = await fixture();
    await symlink(path.join(fx.root, "b"), path.join(fx.root, "a"));
    await symlink(path.join(fx.root, "a"), path.join(fx.root, "b"));

    await expect(resolveInRoot(fx.config, "a")).rejects.toThrow(/too many symbolic links/);
  });

  it("still accepts an internal symlink that stays inside the root", async () => {
    // The guard must not be so strict that ordinary links break.
    const fx = await fixture();
    await mkdir(path.join(fx.root, "real"), { recursive: true });
    await writeFile(path.join(fx.root, "real/data.csv"), "a,b\n", "utf8");
    await symlink(path.join(fx.root, "real"), path.join(fx.root, "alias"), "junction");

    await expect(resolveInRoot(fx.config, "alias/data.csv", { mustExist: true })).resolves.toBe(
      path.join(fx.root, "real/data.csv")
    );
  });
});

describe("secure dual-root default", () => {
  it("writes new files only to outputRoot and reads them back through @output", async () => {
    const fx = await secureFixture();
    const result = await sheetWriteTool.handler(
      { path: "reports/new.xlsx", sheets: [{ name: "S", rows: [["safe"]] }] },
      { config: fx.config }
    );
    const text = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map(block => block.text)
      .join("\n");
    expect(text).toContain("@output/reports/new.xlsx");
    await expect(lstat(path.join(fx.root, "reports/new.xlsx"))).rejects.toThrow();
    await expect(lstat(path.join(fx.config.outputRoot, "reports/new.xlsx"))).resolves.toBeDefined();

    const read = await sheetReadTool.handler(
      { path: "@output/reports/new.xlsx" },
      { config: fx.config }
    );
    expect(JSON.stringify(read.content)).toContain("safe");
  });

  it("requires an output path for editing an input file", async () => {
    const fx = await secureFixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["original"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    await expect(
      sheetEditTool.handler(
        { path: "book.xlsx", ops: [{ op: "set_cell", ref: "A1", value: "changed" }] },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpToolError &&
        error.code === "readonly" &&
        (error.hint ?? "").includes("out"),
      "expected a safe-output requirement"
    );

    await sheetEditTool.handler(
      {
        path: "book.xlsx",
        out: "edited/book.xlsx",
        ops: [{ op: "set_cell", ref: "A1", value: "changed" }]
      },
      { config: fx.config }
    );

    const original = Workbook.create();
    await Workbook.readFile(original, path.join(fx.root, "book.xlsx"));
    expect(Cell.getValue(Workbook.getWorksheet(original, "S")!, "A1")).toBe("original");
    const edited = Workbook.create();
    await Workbook.readFile(edited, path.join(fx.config.outputRoot, "edited/book.xlsx"));
    expect(Cell.getValue(Workbook.getWorksheet(edited, "S")!, "A1")).toBe("changed");
  });

  it("allows in-place edits only after the operator explicitly opts in", async () => {
    const fx = await secureFixture(["--allow-in-place"]);
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["before"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    await sheetEditTool.handler(
      { path: "book.xlsx", ops: [{ op: "set_cell", ref: "A1", value: "after" }] },
      { config: fx.config }
    );
    const back = Workbook.create();
    await Workbook.readFile(back, path.join(fx.root, "book.xlsx"));
    expect(Cell.getValue(Workbook.getWorksheet(back, "S")!, "A1")).toBe("after");
  });

  it("creates outputRoot with private permissions", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fx = await secureFixture();
    expect((await lstat(fx.config.outputRoot)).mode & 0o777).toBe(0o700);
  });
});

describe("sandbox — backups cannot escape or be clobbered", () => {
  it("refuses an in-place edit whose .bak is an external symlink", async () => {
    // `${file}.bak` was derived by string concatenation and never resolved, so a
    // planted link there let a backup overwrite a file outside the sandbox.
    const fx = await fixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["a"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    const external = path.join(fx.outside, "stolen.xlsx");
    await symlink(external, path.join(fx.root, "book.xlsx.bak"));

    await expectOutsideRoot(
      sheetEditTool.handler(
        { path: "book.xlsx", ops: [{ op: "set_cell", ref: "A1", value: "x" }] },
        { config: fx.config }
      )
    );
    await expect(readFile(external, "utf8")).rejects.toThrow();
  });

  it("does not overwrite an existing backup on a second edit", async () => {
    // The `.bak` a user reaches for is the pristine original, not the previous
    // intermediate state.
    const fx = await fixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["original"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    const edit = (value: string) =>
      sheetEditTool.handler(
        { path: "book.xlsx", ops: [{ op: "set_cell", ref: "A1", value }] },
        { config: fx.config }
      );

    await edit("first");
    await edit("second");

    const backup = Workbook.create();
    await Workbook.readFile(backup, path.join(fx.root, "book.xlsx.bak"));
    expect(Cell.getValue(Workbook.getWorksheet(backup, "S")!, "A1")).toBe("original");

    // The second edit's backup went to a numbered sibling rather than replacing it.
    const second = Workbook.create();
    await Workbook.readFile(second, path.join(fx.root, "book.xlsx.bak.2"));
    expect(Cell.getValue(Workbook.getWorksheet(second, "S")!, "A1")).toBe("first");
  });
});

describe("archive — extraction cannot escape", () => {
  it("refuses to write through a symlink already in the destination", async () => {
    // The library validates entry names against the target directory but writes
    // straight through a pre-existing link inside it.
    const fx = await fixture();
    await mkdir(path.join(fx.root, "out"), { recursive: true });
    await symlink(fx.outside, path.join(fx.root, "out/link"), "junction");

    const zip = new ArchiveFile();
    zip.addText("PWNED", "link/pwn.txt");
    await zip.writeToFile(path.join(fx.root, "evil.zip"));

    await expect(
      archiveReadTool.handler(
        { path: "evil.zip", action: "extract", out: "out" },
        { config: fx.config }
      )
    ).rejects.toThrow(/outside the server root/);

    await expect(readFile(path.join(fx.outside, "pwn.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses a traversal entry name", async () => {
    const fx = await fixture();
    const zip = new ArchiveFile();
    zip.addText("PWNED", "../../escaped.txt");
    await zip.writeToFile(path.join(fx.root, "evil.zip"));

    await expect(
      archiveReadTool.handler(
        { path: "evil.zip", action: "extract", out: "out" },
        { config: fx.config }
      )
    ).rejects.toThrow(/outside the server root/);
  });

  it("does not materialise symlink entries", async () => {
    const fx = await fixture();
    const zip = new ArchiveFile();
    zip.addText("fine", "regular.txt");
    zip.symlink("escape.txt", "/etc/passwd");
    await zip.writeToFile(path.join(fx.root, "link.zip"));

    await archiveReadTool.handler(
      { path: "link.zip", action: "extract", out: "out" },
      { config: fx.config }
    );

    const planted = await lstat(path.join(fx.root, "out/escape.txt")).catch(() => undefined);
    expect(planted).toBeUndefined();
  });

  it("refuses an archive larger than the configured limit before opening it", async () => {
    // A gzip bomb is inflated during the open call, so the on-disk size has to
    // be the gate.
    const fx = await fixture(["--max-file-size", "64"]);
    const zip = new ArchiveFile();
    zip.addText("x".repeat(4096), "big.txt");
    await zip.writeToFile(path.join(fx.root, "big.zip"));

    await expect(
      archiveReadTool.handler({ path: "big.zip" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "too_large",
      "expected a too_large error"
    );
  });
});

describe("archive — writing cannot escape or produce hostile output", () => {
  it("refuses an output path that is a dangling external symlink", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "a.txt"), "A", "utf8");
    const external = path.join(fx.outside, "created.zip");
    await symlink(external, path.join(fx.root, "out.zip"));

    await expectOutsideRoot(
      archiveWriteTool.handler(
        { out: "out.zip", entries: [{ path: "a.txt" }], overwrite: true },
        { config: fx.config }
      )
    );
    await expect(readFile(external)).rejects.toThrow();
  });

  it("refuses to put a traversal name inside an archive it creates", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "a.txt"), "A", "utf8");

    await expect(
      archiveWriteTool.handler(
        { out: "x.zip", entries: [{ path: "a.txt", as: "../../escape.txt" }] },
        { config: fx.config }
      )
    ).rejects.toThrow(/must not contain/);
  });
});

describe("resource limits are enforced, not merely advertised", () => {
  it("sheet_read refuses an oversized workbook", async () => {
    const fx = await fixture(["--max-file-size", "512"]);
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addAoa(
      ws,
      Array.from({ length: 200 }, (_, index) => [`row ${index}`, index])
    );
    await Workbook.writeFile(wb, path.join(fx.root, "big.xlsx"));

    await expect(
      sheetReadTool.handler({ path: "big.xlsx" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "too_large",
      "expected a too_large error"
    );
  });

  it("doc_read refuses an oversized document", async () => {
    const fx = await fixture(["--max-file-size", "32"]);
    await writeFile(path.join(fx.root, "big.md"), "# ".repeat(500), "utf8");

    await expect(docReadTool.handler({ path: "big.md" }, { config: fx.config })).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "too_large",
      "expected a too_large error"
    );
  });
});

describe("atomic writes", () => {
  it("leaves no temporary files behind after a successful edit", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["a"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    await sheetEditTool.handler(
      { path: "book.xlsx", ops: [{ op: "set_cell", ref: "A1", value: "b" }] },
      { config: fx.config }
    );

    const { readdir } = await import("node:fs/promises");
    const leftovers = (await readdir(fx.root)).filter(name => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("allows exactly one concurrent no-clobber writer", async () => {
    const fx = await fixture();
    const target = path.join(fx.root, "race.txt");

    const results = await Promise.allSettled([
      writeWithPolicy(target, false, temporary => writeFile(temporary, "A", "utf8")),
      writeWithPolicy(target, false, temporary => writeFile(temporary, "B", "utf8"))
    ]);

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(["A", "B"]).toContain(await readFile(target, "utf8"));
  });

  it("preserves restrictive Unix permissions on replacement", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fx = await fixture();
    const target = path.join(fx.root, "private.txt");
    await writeFile(target, "before", { mode: 0o600 });
    await writeFileAtomic(target, "after");
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });
});

describe("set_formula fills like Excel", () => {
  it("translates relative references down a range", async () => {
    // Writing the same literal text into every cell made all rows compute the
    // first row, and looked entirely plausible in the output.
    const fx = await fixture();
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addAoa(ws, [
      ["qty", "price"],
      [2, 10],
      [3, 10],
      [4, 10]
    ]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    await sheetEditTool.handler(
      { path: "book.xlsx", ops: [{ op: "set_formula", range: "C2:C4", formula: "=A2*B2" }] },
      { config: fx.config }
    );

    const back = Workbook.create();
    await Workbook.readFile(back, path.join(fx.root, "book.xlsx"));
    const sheet = Workbook.getWorksheet(back, "S")!;
    expect(Cell.getValue(sheet, "C2")).toMatchObject({ result: 20 });
    expect(Cell.getValue(sheet, "C3")).toMatchObject({ result: 30 });
    expect(Cell.getValue(sheet, "C4")).toMatchObject({ result: 40 });
  });

  it("honours absolute references", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addAoa(ws, [[5], [1], [2], [3]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    await sheetEditTool.handler(
      { path: "book.xlsx", ops: [{ op: "set_formula", range: "B2:B4", formula: "=A2*$A$1" }] },
      { config: fx.config }
    );

    const back = Workbook.create();
    await Workbook.readFile(back, path.join(fx.root, "book.xlsx"));
    const sheet = Workbook.getWorksheet(back, "S")!;
    expect(Cell.getValue(sheet, "B2")).toMatchObject({ result: 5 });
    expect(Cell.getValue(sheet, "B3")).toMatchObject({ result: 10 });
    expect(Cell.getValue(sheet, "B4")).toMatchObject({ result: 15 });
  });

  it("warns that structural moves do not rewrite references elsewhere", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["a"], ["b"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    const result = await sheetEditTool.handler(
      { path: "book.xlsx", ops: [{ op: "delete_rows", at: 1, count: 1 }] },
      { config: fx.config }
    );
    const text = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map(block => block.text)
      .join("\n");
    expect(text).toContain("NOT adjusted");
  });
});

describe("spreadsheet edits preserve existing data and formatting", () => {
  it("set_style merges font properties instead of replacing them", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", "text");
    Cell.setFont(ws, "A1", { name: "Times New Roman", size: 18, underline: true });
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    await sheetEditTool.handler(
      { path: "book.xlsx", ops: [{ op: "set_style", range: "A1", bold: true }] },
      { config: fx.config }
    );

    const back = Workbook.create();
    await Workbook.readFile(back, path.join(fx.root, "book.xlsx"));
    expect(Cell.getFont(Workbook.getWorksheet(back, "S")!, "A1")).toMatchObject({
      name: "Times New Roman",
      size: 18,
      underline: true,
      bold: true
    });
  });

  it("rows null clears data loaded from CSV", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "source.csv"), "a,b\nold,keep\n", "utf8");
    await sheetWriteTool.handler(
      {
        path: "out.xlsx",
        sheets: [{ name: "S", fromCsv: "source.csv", rows: [[null], [null]] }]
      },
      { config: fx.config }
    );

    const back = Workbook.create();
    await Workbook.readFile(back, path.join(fx.root, "out.xlsx"));
    const ws = Workbook.getWorksheet(back, "S")!;
    expect(Cell.getValue(ws, "A1")).toBeNull();
    expect(Cell.getValue(ws, "A2")).toBeNull();
    expect(Cell.getValue(ws, "B2")).toBe("keep");
  });

  it("rejects a single-cell address beyond Excel's limits", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["a"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));

    for (const range of ["A1048577", "XFE1", "ZZZ1"]) {
      await expect(
        sheetEditTool.handler(
          { path: "book.xlsx", ops: [{ op: "clear", range }] },
          { config: fx.config }
        ),
        range
      ).rejects.toThrow(/not a valid rectangle|could not parse range/);
    }
  });
});

describe("formula probe semantics", () => {
  it("evaluates location-dependent formulas at the requested cell", async () => {
    const fx = await fixture();
    const result = await formulaEvaluateTool.handler(
      { formula: "=COLUMN()+ROW()", cell: "C4" },
      { config: fx.config }
    );
    const text = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map(block => block.text)
      .join("\n");
    expect(text).toContain("evaluated at: `C4`");
    expect(text).toContain("result: **7**");
  });

  it("refuses to overwrite a context cell with the probe", async () => {
    const fx = await fixture();
    await expect(
      formulaEvaluateTool.handler(
        { formula: "=1", cell: "A1", context: { A1: 99 } },
        { config: fx.config }
      )
    ).rejects.toThrow(/also present in the context/);
  });
});

describe("PDF page operations keep live page numbering", () => {
  it("targets the new page 1 after deleting the old page 1", async () => {
    const fx = await fixture();
    const builder = new Pdf.Builder();
    builder.addPage().drawText("OLD PAGE ONE", { x: 60, y: 700 });
    builder.addPage().drawText("OLD PAGE TWO", { x: 60, y: 700 });
    await writeFile(path.join(fx.root, "two.pdf"), await builder.build());

    await pdfEditTool.handler(
      {
        path: "two.pdf",
        ops: [
          { op: "delete_pages", pages: [1] },
          { op: "stamp", text: "NEW PAGE ONE", x: 60, y: 650, pages: [1] }
        ]
      },
      { config: fx.config }
    );

    const result = await Pdf.read(new Uint8Array(await readFile(path.join(fx.root, "two.pdf"))), {
      extractText: true
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.text).toContain("OLD PAGE TWO");
    expect(result.pages[0]?.text).toContain("NEW PAGE ONE");
    expect(result.pages[0]?.text).not.toContain("OLD PAGE ONE");
  });
});

describe("failed form fills have no backup side effects", () => {
  it("validates field names before creating the backup", async () => {
    const fx = await fixture();
    // Ordinary PDF: no fields; the write path should fail before backup.
    const builder = new Pdf.Builder();
    builder.addPage().drawText("plain", { x: 60, y: 700 });
    await writeFile(path.join(fx.root, "plain.pdf"), await builder.build());

    await expect(
      formFillTool.handler({ path: "plain.pdf", values: { nope: "x" } }, { config: fx.config })
    ).rejects.toThrow();
    await expect(lstat(path.join(fx.root, "plain.pdf.bak"))).rejects.toThrow();
  });
});
