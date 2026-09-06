import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel/index";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Structural invariants of **reading an XLSB and writing it back** — the ordinary editing path.
 *
 * Every assertion here is about the *package*, not about the model, because that is where the two defects this file was
 * written for lived and why nothing caught them: this library's own reader is happy to read a package with a duplicated
 * part name and a sheet whose relationship points at the wrong thing, so a round trip through the model reported
 * success. LibreOffice refused the file outright, which is how they were found at all.
 *
 * The fixture is `sales-dashboard`, which is the interesting shape: 12 declared sheets of which one is a chartsheet,
 * with charts, drawings, tables and pivot caches all arriving as preserved parts.
 */
/**
 * The package these assertions rewrite, **written here rather than borrowed from the examples' output.**
 *
 * It used to read `tmp/excel-examples/sales-dashboard.xlsb`, which is gitignored and produced by a different CI job — so
 * on a clean checkout every case in this file failed, and locally they passed only because an earlier example run had
 * left the file behind. Building it here also keeps the fixture honest: the shapes the rewrite has to survive are stated
 * in this file instead of depending on what an unrelated example happens to contain.
 *
 * The shape that matters is a chartsheet beside ordinary worksheets, plus parts this library keeps opaque on a read —
 * a chart and a table — because the defects this file pins are a duplicated content-type declaration and a chartsheet
 * counted twice.
 */
let SOURCE = "";

async function buildSource(directory: string): Promise<string> {
  const { Chart, Table } = await import("@excel/index");
  const workbook = Workbook.create();
  const data = Workbook.addWorksheet(workbook, "Data");
  Cell.setValue(data, "A1", "Region");
  Cell.setValue(data, "B1", "Units");
  ["APAC", "EMEA", "AMER"].forEach((region, index) => {
    Cell.setValue(data, `A${index + 2}`, region);
    Cell.setValue(data, `B${index + 2}`, (index + 1) * 10);
  });
  Table.add(data, {
    name: "Regions",
    ref: "A1",
    headerRow: true,
    columns: [{ name: "Region" }, { name: "Units" }],
    rows: [
      ["APAC", 10],
      ["EMEA", 20],
      ["AMER", 30]
    ]
  } as never);
  Chart.add(
    data,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      series: [{ name: "Units", categories: "Data!$A$2:$A$4", values: "Data!$B$2:$B$4" }]
    } as never,
    "D2:J20"
  );
  // The chartsheet: a sheet the XLSB reader cannot model, which is what the placeholder logic is about.
  Workbook.addChartsheet(workbook, "Overview", {
    chart: {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Overview",
      series: [{ name: "Units", categories: "Data!$A$2:$A$4", values: "Data!$B$2:$B$4" }]
    }
  } as never);
  const path = join(directory, "rich.xlsb");
  await writeFile(
    path,
    await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
  );
  return path;
}

async function rewritten(): Promise<Map<string, { data: Uint8Array }>> {
  const workbook = Workbook.create();
  await Workbook.readFile(workbook, SOURCE);
  const bytes = await Workbook.toBuffer(workbook, {
    format: "xlsb",
    unsupported: "ignore",
    // The point is to inspect what the writer produced, not to have the self-check reject it first.
    validate: false
  });
  return extractAll(bytes);
}

function overrideNames(parts: Map<string, { data: Uint8Array }>): string[] {
  const xml = new TextDecoder().decode(parts.get("[Content_Types].xml")!.data);
  return [...xml.matchAll(/<Override PartName="([^"]+)"/g)].map(match => match[1]!);
}

let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "documonster-rws-"));
  SOURCE = await buildSource(directory);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("XLSB read → write, package structure", () => {
  it("declares each part name exactly once", async () => {
    // OPC forbids a repeated part name and LibreOffice rejects the package for it ("source file could not be loaded").
    // Sixteen were duplicated: every chart, drawing and table that arrived as a preserved part was declared once by the
    // preserved-part pass and again by the writer that owns that kind of part.
    const names = overrideNames(await rewritten());
    const duplicated = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
    expect(duplicated).toEqual([]);
  });

  it("writes each part into the archive exactly once", async () => {
    // `extractAll` returns a map, so a duplicated ZIP entry would be invisible here — count the entries instead.
    const workbook = Workbook.create();
    await Workbook.readFile(workbook, SOURCE);
    const bytes = await Workbook.toBuffer(workbook, {
      format: "xlsb",
      unsupported: "ignore",
      validate: false
    });
    const parts = await extractAll(bytes);
    const { ZipParser } = await import("@archive/unzip/zip-parser");
    const entries = new ZipParser(bytes).getEntries().map(entry => entry.path.toLowerCase());
    expect(entries.length).toBe(parts.size);
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("gives every declared sheet exactly one relationship", async () => {
    // The invariant that broke: a chartsheet the reader cannot model is kept as an empty worksheet, and that
    // placeholder used to be written as a real sheet part *as well as* leaving the preserved chartsheet reachable —
    // 13 targets for 12 declared sheets, with the chart sheet resolving to a 319-byte empty grid.
    const parts = await rewritten();
    let declared = 0;
    for (const record of iterateInterpretableRecords(parts.get("xl/workbook.bin")!.data, "x")) {
      if (recordSpec(record.id)?.name === "BrtBundleSh") {
        declared += 1;
      }
    }
    const rels = new TextDecoder().decode(parts.get("xl/_rels/workbook.bin.rels")!.data);
    const sheetTargets = [
      ...(rels.match(/worksheets\/sheet\d+\.bin/g) ?? []),
      ...(rels.match(/chartsheets\/sheet\d+\.bin/g) ?? [])
    ];
    expect(declared).toBeGreaterThan(0);
    expect(sheetTargets).toHaveLength(declared);
    expect(new Set(sheetTargets).size).toBe(sheetTargets.length);
  });

  it("reproduces the source's sheet split", async () => {
    // A rewrite that adds a sheet part has invented a sheet; one that drops a chartsheet part has lost the chart.
    // Pinned against the source rather than against a number, so the fixture and the assertion cannot drift apart.
    const source = await extractAll(new Uint8Array(readFileSync(SOURCE)));
    const parts = await rewritten();
    const worksheets = (map: Map<string, unknown>): number =>
      [...map.keys()].filter(name => /worksheets\/sheet\d+\.bin$/.test(name)).length;
    const chartsheets = (map: Map<string, unknown>): number =>
      [...map.keys()].filter(name => /chartsheets\/sheet\d+\.bin$/.test(name)).length;
    expect(worksheets(parts)).toBe(worksheets(source));
    expect(chartsheets(parts)).toBe(chartsheets(source));
  });

  it("drops the relationship file a sheet of internal links no longer needs", async () => {
    // **The total part count is deliberately *not* asserted, and this test says why.**
    //
    // The rewrite emits one part fewer than the fixture: `sheet11.bin.rels`, which held six hyperlink relationships
    // of the form `Target="#'Pivot Core'!A1" TargetMode="External"` — an internal navigation link declared as an
    // external URL. That is the defect fixed in `hyperlink-internal.test.ts`, and the fixture carries it because this
    // library wrote the fixture. Excel's own save of the same workbook has **no** hyperlink relationship in any sheet's
    // `.rels`, which is the independent confirmation.
    //
    // So "identical to the source" would have pinned the bug in place. The invariant that survives is the one about
    // sheets, above.
    const parts = await rewritten();
    const rels = [...parts.keys()].filter(name => /worksheets\/_rels\/.*\.rels$/.test(name));
    for (const path of rels) {
      const xml = new TextDecoder().decode(parts.get(path)!.data);
      expect(xml, path).not.toContain('Target="#');
    }
  });

  it("declares a content type only for parts the package contains", async () => {
    // **The mirror image of a part nothing declares, and the case that produced it was the chartsheet placeholder.**
    //
    // A chartsheet the reader cannot model is kept as an empty worksheet; the writer correctly skips its sheet part and
    // correctly points its relationship at the preserved chartsheet — and then declared a content type for the part it
    // had not written, leaving `[Content_Types].xml` naming `xl/worksheets/sheet2.bin`. Three places asked whether a
    // sheet was a placeholder and this was the one that did not.
    const parts = await rewritten();
    const xml = new TextDecoder().decode(parts.get("[Content_Types].xml")!.data);
    const dangling = [...xml.matchAll(/<Override PartName="\/([^"]+)"/g)]
      .map(match => match[1]!)
      .filter(path => !parts.has(path));
    expect(dangling).toEqual([]);
  });

  it("reports a part written twice rather than dropping one silently", async () => {
    // Two writers producing bytes for one name means only one reached the package. It happened for real — a preserved
    // chart and a newly generated one both claiming `chart1.xml`, the preserved one dropped and its drawing left
    // pointing at the replacement — and nothing said so, because the reader is happy to read whichever copy is there.
    //
    // The numbering that caused it is fixed at the source, so this asserts the *reporting channel* on a package that
    // should have nothing to report.
    const workbook = Workbook.create();
    await Workbook.readFile(workbook, SOURCE);
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect(written.length).toBeGreaterThan(0);
    // A second read-write must not start duplicating either.
    const again = Workbook.create();
    await Workbook.read(again, written);
    Cell.setValue(Workbook.getWorksheets(again)[0]!, "ZZ998", "edited");
    const { writeXlsbPackage } = await import("@excel/xlsb/write/package");
    const { getWorkbookModel } = await import("@excel/core/workbook.browser");
    const report = await writeXlsbPackage(getWorkbookModel(again));
    expect(report.unsupported.filter(entry => entry.includes("written twice"))).toEqual([]);
  });

  it("keeps the chartsheet's relationship pointing at the chartsheet", async () => {
    // The sheet bundle names relationships by id, so it is not enough for the chartsheet part to survive — the id the
    // bundle names has to be the one that reaches it.
    const parts = await rewritten();
    const rels = new TextDecoder().decode(parts.get("xl/_rels/workbook.bin.rels")!.data);
    const chartsheetRels = [
      ...rels.matchAll(/<Relationship[^>]*Target="(chartsheets\/sheet\d+\.bin)"[^>]*\/>/g)
    ];
    expect(chartsheetRels).toHaveLength(1);
    // And the part it names is really there.
    expect(parts.has(`xl/${chartsheetRels[0]![1]!}`)).toBe(true);
  });
});
