/**
 * Chart, generation, ODT and `doc_review` tests.
 *
 * Charts are verified by reopening the workbook and finding the chart object,
 * not by trusting the write call: a chart with a malformed series reference
 * writes without error and renders empty in Excel, which no return value would
 * reveal.
 */

import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Chart, Workbook, Worksheet } from "documonster/excel";
import { Build, Convert, Document, Io, Query } from "documonster/word";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { docConvertTool } from "../tools/doc-convert.js";
import { docReviewTool } from "../tools/doc-review.js";
import { sheetEditTool } from "../tools/sheet-edit.js";
import { sheetWriteTool } from "../tools/sheet-write.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-extras-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function run(
  tool: typeof sheetWriteTool,
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

async function reopen(fx: Fixture, name: string) {
  const wb = Workbook.create();
  await Workbook.readFile(wb, path.join(fx.root, name));
  return wb;
}

const DATA = [
  ["region", "units", "cost"],
  ["APAC", 10, 25],
  ["EMEA", 4, 30],
  ["AMER", 7, 20]
];

describe("sheet_write — charts", () => {
  it("writes a chart that survives a round trip", async () => {
    const fx = await fixture();
    await run(sheetWriteTool, fx, {
      path: "chart.xlsx",
      sheets: [
        {
          name: "Sales",
          rows: DATA,
          charts: [
            { type: "column", title: "Units by region", categories: "A2:A4", values: "B2:B4" }
          ]
        }
      ]
    });

    const ws = Workbook.getWorksheet(await reopen(fx, "chart.xlsx"), "Sales");
    expect(ws).toBeDefined();
    // Chart.get lists a sheet's charts; a non-empty list proves the drawing
    // part was written and survived the round trip.
    expect(Chart.get(ws!)).toHaveLength(1);
  });

  it("supports multiple series with names", async () => {
    const fx = await fixture();
    const report = await run(sheetWriteTool, fx, {
      path: "multi.xlsx",
      sheets: [
        {
          name: "Sales",
          rows: DATA,
          charts: [
            {
              type: "line",
              title: "Units and cost",
              categories: "A2:A4",
              values: ["B2:B4", "C2:C4"],
              seriesNames: ["B1", "C1"],
              legend: "bottom"
            }
          ]
        }
      ]
    });

    expect(report).toContain("2 series");
    expect(Chart.get(Workbook.getWorksheet(await reopen(fx, "multi.xlsx"), "Sales")!)).toHaveLength(
      1
    );
  });

  it("accepts every offered chart type", async () => {
    const fx = await fixture();
    for (const type of ["column", "bar", "line", "area", "pie", "doughnut", "scatter", "radar"]) {
      await run(sheetWriteTool, fx, {
        path: `${type}.xlsx`,
        sheets: [
          { name: "S", rows: DATA, charts: [{ type, categories: "A2:A4", values: "B2:B4" }] }
        ]
      });
      expect(
        Chart.get(Workbook.getWorksheet(await reopen(fx, `${type}.xlsx`), "S")!),
        type
      ).toHaveLength(1);
    }
  });

  it("works on a sheet whose name needs quoting", async () => {
    // The series reference becomes 'My Sheet'!$B$2:$B$4; getting the quoting
    // wrong produces a chart that renders empty rather than an error.
    const fx = await fixture();
    await run(sheetWriteTool, fx, {
      path: "quoted.xlsx",
      sheets: [
        {
          name: "My Sheet",
          rows: DATA,
          charts: [{ type: "column", categories: "A2:A4", values: "B2:B4" }]
        }
      ]
    });
    expect(
      Chart.get(Workbook.getWorksheet(await reopen(fx, "quoted.xlsx"), "My Sheet")!)
    ).toHaveLength(1);
  });

  it("places a chart clear of the data by default", async () => {
    const fx = await fixture();
    const report = await run(sheetWriteTool, fx, {
      path: "auto.xlsx",
      sheets: [
        {
          name: "S",
          rows: DATA,
          charts: [{ type: "column", categories: "A2:A4", values: "B2:B4" }]
        }
      ]
    });
    // Data occupies A:C, so the anchor must start at E or later.
    expect(report).toMatch(/at [E-Z]\d+:/);
  });

  it("rejects a sheet-qualified range, which is the model's likeliest mistake", async () => {
    const fx = await fixture();
    await expect(
      sheetWriteTool.handler(
        {
          path: "bad.xlsx",
          sheets: [
            {
              name: "S",
              rows: DATA,
              charts: [{ type: "column", categories: "S!A2:A4", values: "B2:B4" }]
            }
          ]
        },
        { config: fx.config }
      )
    ).rejects.toThrow(/not a plain A1 range/);
  });

  it("rejects a seriesNames list of the wrong length", async () => {
    const fx = await fixture();
    await expect(
      sheetWriteTool.handler(
        {
          path: "bad.xlsx",
          sheets: [
            {
              name: "S",
              rows: DATA,
              charts: [
                {
                  type: "line",
                  categories: "A2:A4",
                  values: ["B2:B4", "C2:C4"],
                  seriesNames: ["B1"]
                }
              ]
            }
          ]
        },
        { config: fx.config }
      )
    ).rejects.toThrow(/seriesNames has 1 entr/);
  });
});

describe("sheet_edit — add_chart", () => {
  it("adds a chart to an existing workbook", async () => {
    const fx = await fixture();
    await run(sheetWriteTool, fx, { path: "book.xlsx", sheets: [{ name: "S", rows: DATA }] });

    const report = await run(sheetEditTool, fx, {
      path: "book.xlsx",
      ops: [
        {
          op: "add_chart",
          chart: { type: "pie", title: "Share", categories: "A2:A4", values: "B2:B4" }
        }
      ]
    });

    expect(report).toContain("added a pie chart");
    expect(Chart.get(Workbook.getWorksheet(await reopen(fx, "book.xlsx"), "S")!)).toHaveLength(1);
  });

  it("reports a chart addition in dryRun without writing", async () => {
    const fx = await fixture();
    await run(sheetWriteTool, fx, { path: "book.xlsx", sheets: [{ name: "S", rows: DATA }] });
    const before = await readFile(path.join(fx.root, "book.xlsx"));

    const report = await run(sheetEditTool, fx, {
      path: "book.xlsx",
      ops: [{ op: "add_chart", chart: { type: "bar", categories: "A2:A4", values: "B2:B4" } }],
      dryRun: true
    });

    expect(report).toContain("added a bar chart");
    expect(await readFile(path.join(fx.root, "book.xlsx"))).toEqual(before);
  });
});

describe("sheet_write — generate", () => {
  it("generates rows server-side with a header", async () => {
    const fx = await fixture();
    const report = await run(sheetWriteTool, fx, {
      path: "gen.xlsx",
      sheets: [
        {
          name: "Test",
          generate: {
            rows: 50,
            columns: [
              { name: "id", type: "uuid" },
              { name: "email", type: "email" },
              { name: "qty", type: "int", min: 1, max: 9 },
              { name: "region", type: "string", values: ["APAC", "EMEA"] }
            ]
          }
        }
      ]
    });

    expect(report).toContain("generated 50 row(s) × 4 column(s) server-side");

    const ws = Workbook.getWorksheet(await reopen(fx, "gen.xlsx"), "Test")!;
    const rows = Worksheet.toAoa(ws);
    expect(rows[0]).toEqual(["id", "email", "qty", "region"]);
    expect(Worksheet.actualRowCount(ws)).toBe(51);
    // Constraints must actually be honoured.
    for (const row of rows.slice(1)) {
      expect(Number(row[2])).toBeGreaterThanOrEqual(1);
      expect(Number(row[2])).toBeLessThanOrEqual(9);
      expect(["APAC", "EMEA"]).toContain(row[3]);
    }
  });

  it("combines generated data with formulas over it", async () => {
    const fx = await fixture();
    await run(sheetWriteTool, fx, {
      path: "gen2.xlsx",
      sheets: [
        {
          name: "T",
          generate: { rows: 10, columns: [{ name: "n", type: "int", min: 5, max: 5 }] },
          formulas: { B1: "=SUM(A2:A11)" }
        }
      ]
    });

    const ws = Workbook.getWorksheet(await reopen(fx, "gen2.xlsx"), "T")!;
    const { Cell } = await import("documonster/excel");
    expect(Cell.getValue(ws, "B1")).toMatchObject({ result: 50 });
  });
});

describe("doc_convert — ODT", () => {
  async function makeWord(fx: Fixture, name = "src.docx"): Promise<string> {
    const doc = Document.create();
    Document.addHeading(doc, "Policy", 1);
    Document.addParagraph(doc, "Body text here.");
    await Io.writeFile(Document.build(doc), path.join(fx.root, name));
    return name;
  }

  it("converts docx to odt", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    const report = await run(docConvertTool, fx, { from: source, to: "out.odt" });

    expect(report).toContain("OpenDocument");
    const bytes = await readFile(path.join(fx.root, "out.odt"));
    // ODT is a ZIP package.
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    // And it reads back with its text.
    const back = await Convert.readOdt(new Uint8Array(bytes));
    expect(Query.extractText(back)).toContain("Policy");
  });

  it("converts odt back to docx and to md", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    await run(docConvertTool, fx, { from: source, to: "round.odt" });

    await run(docConvertTool, fx, { from: "round.odt", to: "back.docx" });
    expect(Query.extractText(await Io.readFile(path.join(fx.root, "back.docx")))).toContain(
      "Policy"
    );

    await run(docConvertTool, fx, { from: "round.odt", to: "back.md" });
    expect(await readFile(path.join(fx.root, "back.md"), "utf8")).toContain("# Policy");
  });

  it("lists odt among a docx's targets", async () => {
    const fx = await fixture();
    const source = await makeWord(fx);
    await expect(
      docConvertTool.handler({ from: source, to: "x.xlsx" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && (error.hint ?? "").includes("odt"),
      "expected odt to be listed as a valid target"
    );
  });
});

describe("doc_review — comparing two versions", () => {
  async function makeVersion(
    fx: Fixture,
    name: string,
    paragraphs: readonly string[]
  ): Promise<string> {
    const doc = Document.create();
    Document.addHeading(doc, "Contract", 1);
    for (const paragraph of paragraphs) {
      Document.addParagraph(doc, paragraph);
    }
    await Io.writeFile(Document.build(doc), path.join(fx.root, name));
    return name;
  }

  const V1 = ["Payment due in 30 days.", "Governed by NSW law.", "Confidentiality applies."];
  const V2 = [
    "Payment due in 14 days.",
    "Governed by NSW law.",
    "Confidentiality applies.",
    "Termination requires 60 days notice."
  ];

  it("reports modified, added and deleted paragraphs", async () => {
    const fx = await fixture();
    const a = await makeVersion(fx, "v1.docx", V1);
    const b = await makeVersion(fx, "v2.docx", V2);

    const text = await run(docReviewTool, fx, { path: a, against: b });

    expect(text).toContain("modified: 1");
    expect(text).toContain("added: 1");
    expect(text).toContain("## modified");
    expect(text).toContain("Payment due in 30 days.");
    expect(text).toContain("Payment due in 14 days.");
    expect(text).toContain("Termination requires 60 days notice.");
  });

  it("reports no differences when the versions match", async () => {
    const fx = await fixture();
    const a = await makeVersion(fx, "a.docx", V1);
    const b = await makeVersion(fx, "b.docx", V1);

    const text = await run(docReviewTool, fx, { path: a, against: b });
    expect(text).toContain("No textual differences");
    // And it must say what it does not detect.
    expect(text).toContain("formatting are not detected");
  });

  it("refuses to combine `apply` with `against`", async () => {
    const fx = await fixture();
    const a = await makeVersion(fx, "a.docx", V1);
    const b = await makeVersion(fx, "b.docx", V2);

    await expect(
      docReviewTool.handler({ path: a, against: b, apply: "accept-all" }, { config: fx.config })
    ).rejects.toThrow(/cannot be combined/);
  });
});

describe("doc_review — tracked changes", () => {
  /** A document with a deletion and an insertion by two authors. */
  async function makeTracked(fx: Fixture, name = "tracked.docx"): Promise<string> {
    const doc = Document.create();
    Document.addContent(doc, {
      type: "paragraph",
      children: [
        Build.text("Payment due in "),
        Build.deletedRun(Build.text("30"), {
          author: "Alice",
          date: "2026-08-01T00:00:00Z",
          id: 1
        }),
        Build.insertedRun(Build.text("14"), {
          author: "Alice",
          date: "2026-08-01T00:00:00Z",
          id: 2
        }),
        Build.text(" days.")
      ]
    });
    await Io.writeFile(Document.build(doc), path.join(fx.root, name));
    return name;
  }

  it("lists revisions with author and kind", async () => {
    const fx = await fixture();
    const file = await makeTracked(fx);
    const text = await run(docReviewTool, fx, { path: file });

    expect(text).toContain("2 tracked change(s)");
    expect(text).toContain("Alice (2)");
    expect(text).toContain("insert");
    expect(text).toContain("delete");
  });

  it("writes nothing unless apply is given", async () => {
    const fx = await fixture();
    const file = await makeTracked(fx);
    const before = await readFile(path.join(fx.root, file));

    const text = await run(docReviewTool, fx, { path: file });
    expect(text).toContain("Nothing was written");
    expect(await readFile(path.join(fx.root, file))).toEqual(before);
  });

  it("accepts all revisions", async () => {
    const fx = await fixture();
    const file = await makeTracked(fx);
    const report = await run(docReviewTool, fx, { path: file, apply: "accept-all" });

    expect(report).toContain("Accepted");
    const doc = await Io.readFile(path.join(fx.root, file));
    expect(Query.extractText(doc)).toContain("Payment due in 14 days.");
    expect(Query.listRevisions(doc)).toEqual([]);
    await expect(stat(path.join(fx.root, `${file}.bak`))).resolves.toBeDefined();
  });

  it("rejects all revisions, restoring the original wording", async () => {
    const fx = await fixture();
    const file = await makeTracked(fx);
    await run(docReviewTool, fx, { path: file, apply: "reject-all", out: "out/rejected.docx" });

    const doc = await Io.readFile(path.join(fx.root, "out/rejected.docx"));
    expect(Query.extractText(doc)).toContain("Payment due in 30 days.");
    // The original was untouched, so no backup was taken.
    await expect(stat(path.join(fx.root, `${file}.bak`))).rejects.toThrow();
  });

  it("says so for a document with no tracked changes", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Clean document.");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "clean.docx"));

    const text = await run(docReviewTool, fx, { path: "clean.docx" });
    expect(text).toContain("no tracked changes");
    expect(text).toContain("`against`");
  });

  it("rejects a non-Word file", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "fake.docx"), "nope", "utf8");
    await expect(
      docReviewTool.handler({ path: "fake.docx" }, { config: fx.config })
    ).rejects.toThrow(/could not read fake\.docx as a Word document/);
  });

  it("is withheld under --readonly when applying", async () => {
    const fx = await fixture(["--readonly"]);
    const file = await makeTracked(fx);
    // Listing still works.
    expect(await run(docReviewTool, fx, { path: file })).toContain("tracked change(s)");
    await expect(
      docReviewTool.handler({ path: file, apply: "accept-all" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });

  it("cannot read outside the sandbox root", async () => {
    const fx = await fixture();
    await expect(
      docReviewTool.handler({ path: "../../etc/hosts" }, { config: fx.config })
    ).rejects.toThrow(/outside the server root/);
  });
});
