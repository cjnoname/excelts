/**
 * `doc_write` and `doc_convert` tests.
 *
 * Every produced file is read back through the library rather than merely
 * checked for existence: "wrote 4 KB" proves nothing about whether Word can
 * open it. Conversions also assert what is *lost*, since a silently lossy
 * conversion is the failure mode a model cannot see.
 */

import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Cell, Workbook, Worksheet } from "documonster/excel";
import { Pdf } from "documonster/pdf";
import { Document, Io, Query } from "documonster/word";
import { renderToMarkdown } from "documonster/word/markdown";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { docConvertTool } from "../tools/doc-convert.js";
import { docWriteTool } from "../tools/doc-write.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-docwrite-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function run(
  tool: typeof docWriteTool,
  fx: Fixture,
  args: Record<string, unknown>
): Promise<string> {
  const result = await tool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

const SAMPLE_MD = `# Quarterly Report

Revenue rose **8%** year over year.

## Regions

- APAC grew fastest
- EMEA was flat

| region | units |
| --- | --- |
| APAC | 10 |
| EMEA | 4 |
`;

describe("doc_write", () => {
  it("writes a .docx that reads back with its structure intact", async () => {
    const fx = await fixture();
    await run(docWriteTool, fx, { path: "report.docx", markdown: SAMPLE_MD });

    const doc = await Io.readFile(path.join(fx.root, "report.docx"));
    const markdown = renderToMarkdown(doc);
    expect(markdown).toContain("# Quarterly Report");
    expect(markdown).toContain("## Regions");
    expect(markdown).toContain("- APAC grew fastest");
    // The table must survive, not collapse into paragraphs.
    expect(Query.tableCount(doc)).toBe(1);
  });

  it("writes a real PDF", async () => {
    const fx = await fixture();
    await run(docWriteTool, fx, { path: "report.pdf", markdown: SAMPLE_MD });

    const bytes = await readFile(path.join(fx.root, "report.pdf"));
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");

    // And its text is actually extractable — a PDF that renders nothing would
    // still have the right magic bytes.
    const parsed = await Pdf.read(new Uint8Array(bytes), { extractText: true });
    expect(parsed.pages[0]?.text).toContain("Quarterly Report");
  });

  it("creates the parent directory", async () => {
    const fx = await fixture();
    await run(docWriteTool, fx, { path: "out/nested/r.docx", markdown: "# T\n" });
    await expect(stat(path.join(fx.root, "out/nested/r.docx"))).resolves.toBeDefined();
  });

  it("refuses to overwrite unless told to", async () => {
    const fx = await fixture();
    await run(docWriteTool, fx, { path: "r.docx", markdown: "# One\n" });
    await expect(
      docWriteTool.handler({ path: "r.docx", markdown: "# Two\n" }, { config: fx.config })
    ).rejects.toThrow(/already exists/);

    await run(docWriteTool, fx, { path: "r.docx", markdown: "# Two\n", overwrite: true });
    const doc = await Io.readFile(path.join(fx.root, "r.docx"));
    expect(renderToMarkdown(doc)).toContain("# Two");
  });

  it("rejects an output format it cannot produce", async () => {
    const fx = await fixture();
    await expect(
      docWriteTool.handler({ path: "r.xlsx", markdown: "# T\n" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpToolError && (error.hint ?? "").includes("sheet_write"),
      "expected a redirect to sheet_write"
    );
  });

  it("is withheld under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    await expect(
      docWriteTool.handler({ path: "r.docx", markdown: "# T\n" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });

  it("cannot write outside the sandbox root", async () => {
    const fx = await fixture();
    await expect(
      docWriteTool.handler({ path: "../escape.docx", markdown: "# T\n" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "outside_root",
      "expected an outside_root error"
    );
  });
});

describe("doc_convert", () => {
  /** A Word document on disk to convert from. */
  async function makeWord(fx: Fixture, name = "src.docx"): Promise<string> {
    const doc = Document.create();
    Document.addHeading(doc, "Policy", 1);
    Document.addParagraph(doc, "Body text here.");
    Document.addBulletList(doc, ["alpha", "beta"]);
    await Io.writeFile(Document.build(doc), path.join(fx.root, name));
    return name;
  }

  /** A workbook on disk to convert from. */
  async function makeWorkbook(fx: Fixture, name = "book.xlsx"): Promise<string> {
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "Data"), [
      ["region", "units"],
      ["APAC", 10],
      ["EMEA", 4]
    ]);
    Worksheet.addAoa(Workbook.addWorksheet(wb, "Notes"), [["second sheet"]]);
    await Workbook.writeFile(wb, path.join(fx.root, name));
    return name;
  }

  /**
   * The XLSB routes.
   *
   * Worth their own block because the container is chosen by the *output extension* and nothing else —
   * `Workbook.writeFile` produces XLSX unless told otherwise, so a route that forgot to pass `format`
   * would write an XLSX package behind an `.xlsb` name. Excel opens that, which is exactly why it needs
   * a test rather than a convention.
   */
  it("converts xlsx to xlsb and back", async () => {
    const fx = await fixture();
    const source = await makeWorkbook(fx);
    await run(docConvertTool, fx, { from: source, to: "out.xlsb" });

    // Read back through the *detector*, not through a format hint: if the bytes were XLSX the reader
    // would accept them and this would pass regardless.
    const reopened = Workbook.create();
    await Workbook.readFile(reopened, path.join(fx.root, "out.xlsb"));
    expect(Workbook.getWorksheets(reopened).map(sheet => Worksheet.getName(sheet))).toEqual([
      "Data",
      "Notes"
    ]);

    await run(docConvertTool, fx, { from: "out.xlsb", to: "round.xlsx" });
    const roundTripped = Workbook.create();
    await Workbook.readFile(roundTripped, path.join(fx.root, "round.xlsx"));
    expect(Cell.getValue(Workbook.getWorksheet(roundTripped, "Data")!, "B2")).toBe(10);
  });

  it("really writes a BIFF12 package, not XLSX under an .xlsb name", async () => {
    const fx = await fixture();
    await run(docConvertTool, fx, { from: await makeWorkbook(fx), to: "out.xlsb" });
    const bytes = await readFile(path.join(fx.root, "out.xlsb"));
    // `xl/workbook.bin` is the part that distinguishes the two containers; XLSX has `xl/workbook.xml`.
    const text = bytes.toString("latin1");
    expect(text).toContain("xl/workbook.bin");
    expect(text).not.toContain("xl/workbook.xml");
  });

  it("reports what XLSB could not carry", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    const sheet = Workbook.addWorksheet(wb, "Data");
    // A filter column carrying a schema extension — the last thing XLSB genuinely cannot carry on a sheet.
    // Pivot tables, conditional formatting and every other criterion kind are written now. Set through the
    // model because `addWorksheet` takes no `autoFilterCriteria`, and `getModel` returns a snapshot.
    Worksheet.addAoa(sheet, [["a", 1]]);
    const model = Workbook.getModel(wb);
    // The range as well as the criteria: the XLSX writer emits the criteria *inside* `<autoFilter>`, so
    // without a range they never reach the intermediate file and nothing is lost on the way back.
    (model.worksheets[0] as { autoFilter?: string }).autoFilter = "A1:B2";
    (
      model.worksheets[0] as { autoFilterCriteria?: { ref: string; xml: string } }
    ).autoFilterCriteria = {
      ref: "A1:B2",
      xml: '<filterColumn colId="0"><extLst><ext uri="{x}"/></extLst></filterColumn>'
    };
    Workbook.setModel(wb, model);

    await Workbook.writeFile(wb, path.join(fx.root, "lossy.xlsx"));

    const result = await run(docConvertTool, fx, { from: "lossy.xlsx", to: "out.xlsb" });
    expect(JSON.stringify(result)).toContain("dropped");
    expect(JSON.stringify(result)).toContain("auto filter criteria");
  });

  it("converts csv to xlsb", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "in.csv"), "region,units\nAPAC,10\n", "utf8");
    await run(docConvertTool, fx, { from: "in.csv", to: "out.xlsb" });
    const reopened = Workbook.create();
    await Workbook.readFile(reopened, path.join(fx.root, "out.xlsb"));
    expect(Cell.getValue(Workbook.getWorksheet(reopened, "Sheet1")!, "A2")).toBe("APAC");
  });

  it("converts xlsb to csv and to pdf, like xlsx", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "Data"), [
      ["region", "units"],
      ["APAC", 10]
    ]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsb"), { format: "xlsb" });

    await run(docConvertTool, fx, { from: "book.xlsb", to: "out.csv" });
    expect(await readFile(path.join(fx.root, "out.csv"), "utf8")).toContain("APAC");

    await run(docConvertTool, fx, { from: "book.xlsb", to: "out.pdf" });
    const pdf = await readFile(path.join(fx.root, "out.pdf"));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("converts docx to Markdown", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    await run(docConvertTool, fx, { from: source, to: "out.md" });

    const markdown = await readFile(path.join(fx.root, "out.md"), "utf8");
    expect(markdown).toContain("# Policy");
    expect(markdown).toContain("- alpha");
  });

  it("converts docx to HTML", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    await run(docConvertTool, fx, { from: source, to: "out.html" });

    const html = await readFile(path.join(fx.root, "out.html"), "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Policy");
  });

  it("converts docx to plain text and warns that formatting is gone", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    const report = await run(docConvertTool, fx, { from: source, to: "out.txt" });

    expect(report).toContain("formatting discarded");
    const text = await readFile(path.join(fx.root, "out.txt"), "utf8");
    expect(text).toContain("Policy");
    expect(text).not.toContain("#");
  });

  it("converts docx to PDF with extractable text", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    await run(docConvertTool, fx, { from: source, to: "out.pdf" });

    const bytes = await readFile(path.join(fx.root, "out.pdf"));
    const parsed = await Pdf.read(new Uint8Array(bytes), { extractText: true });
    expect(parsed.pages[0]?.text).toContain("Policy");
  });

  it("converts Markdown to docx and to PDF", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "in.md"), SAMPLE_MD, "utf8");

    await run(docConvertTool, fx, { from: "in.md", to: "a.docx" });
    expect(renderToMarkdown(await Io.readFile(path.join(fx.root, "a.docx")))).toContain(
      "# Quarterly Report"
    );

    await run(docConvertTool, fx, { from: "in.md", to: "b.pdf" });
    const parsed = await Pdf.read(new Uint8Array(await readFile(path.join(fx.root, "b.pdf"))), {
      extractText: true
    });
    expect(parsed.pages[0]?.text).toContain("Quarterly Report");
  });

  it("converts xlsx to csv, naming the sheet and warning about the rest", async () => {
    const fx = await fixture();
    const source = await makeWorkbook(fx);
    const report = await run(docConvertTool, fx, { from: source, to: "out.csv" });

    expect(report).toContain('"Data"');
    // The loss must be stated: a two-sheet workbook became one CSV.
    expect(report).toContain("only one sheet");
    expect(await readFile(path.join(fx.root, "out.csv"), "utf8")).toContain("APAC");
  });

  it("selects the sheet for a csv export", async () => {
    const fx = await fixture();
    const source = await makeWorkbook(fx);
    await run(docConvertTool, fx, { from: source, to: "notes.csv", sheet: "Notes" });
    expect(await readFile(path.join(fx.root, "notes.csv"), "utf8")).toContain("second sheet");
  });

  it("converts xlsx to PDF, recalculating formulas first", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addAoa(ws, [[10], [20]]);
    // Stored WITHOUT a leading "=", and with no cached result, so only a real
    // recalculation can put 30 into the PDF.
    const { Cell } = await import("documonster/excel");
    Cell.setValue(ws, "A3", { formula: "SUM(A1:A2)" });
    await Workbook.writeFile(wb, path.join(fx.root, "calc.xlsx"));

    const report = await run(docConvertTool, fx, { from: "calc.xlsx", to: "calc.pdf" });
    expect(report).toContain("recalculated");

    const parsed = await Pdf.read(new Uint8Array(await readFile(path.join(fx.root, "calc.pdf"))), {
      extractText: true
    });
    expect(parsed.pages[0]?.text).toContain("30");
  });

  it("converts csv to xlsx", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "in.csv"), "a,b\n1,2\n", "utf8");
    await run(docConvertTool, fx, { from: "in.csv", to: "out.xlsx" });

    const wb = Workbook.create();
    await Workbook.readFile(wb, path.join(fx.root, "out.xlsx"));
    const ws = Workbook.getWorksheet(wb, "Sheet1");
    expect(ws).toBeDefined();
    expect(Worksheet.toAoa(ws!)).toEqual([
      ["a", "b"],
      [1, 2]
    ]);
  });

  it("refuses PDF as a source and says why", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "in.pdf"), "%PDF-1.7\n", "utf8");
    await expect(
      docConvertTool.handler({ from: "in.pdf", to: "out.docx" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpToolError && (error.hint ?? "").includes("Supported sources"),
      "expected the error to list supported sources"
    );
  });

  it("lists the possible targets for an unsupported pair", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    await expect(
      docConvertTool.handler({ from: source, to: "out.xlsx" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpToolError && (error.hint ?? "").includes("md, html, pdf, txt"),
      "expected the error to enumerate valid targets"
    );
  });

  it("refuses to overwrite unless told to", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    await run(docConvertTool, fx, { from: source, to: "out.md" });
    await expect(
      docConvertTool.handler({ from: source, to: "out.md" }, { config: fx.config })
    ).rejects.toThrow(/already exists/);
    await run(docConvertTool, fx, { from: source, to: "out.md", overwrite: true });
  });

  it("is withheld under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    await expect(
      docConvertTool.handler({ from: "a.docx", to: "b.md" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });

  it("cannot read or write outside the sandbox root", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    await expect(
      docConvertTool.handler({ from: "../../etc/hosts", to: "out.md" }, { config: fx.config })
    ).rejects.toThrow(/outside (?:the server root|--output-root)/);
    await expect(
      docConvertTool.handler({ from: source, to: "../escape.md" }, { config: fx.config })
    ).rejects.toThrow(/outside (?:the server root|--output-root)/);
  });
});
