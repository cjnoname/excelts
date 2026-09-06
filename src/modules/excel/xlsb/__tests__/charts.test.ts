import { extractAll } from "@archive/unzip/extract";
/**
 * Charts.
 *
 * **A chart part is XML in both containers**, and that is the fact the whole feature rests on:
 * `cal-any_sheets.xlsb` — the one corpus workbook with a chart — carries `xl/charts/chart1.xml`,
 * `colors1.xml` and `style1.xml` beside a `.bin` chartsheet. So a BIFF12 writer has nothing to translate;
 * it needs the same XML the XLSX writer produces.
 *
 * What was stopping it was smaller than it looked. `chart` appears 434 times in the XLSX writer, which
 * reads like a subsystem to port — but a programmatic chart goes through `Chart.add` → `addChartEntry`,
 * which puts a `{ chartNumber, model }` entry on the *workbook*, and one exported helper renders that to
 * XML. The rest of those 434 references are the reading path and the chart engine.
 *
 * Two details are asserted below because each is a silent failure:
 *
 * - An absolute chart anchor's position is **EMU in the model and pixels in the anchor**. `PosXform`
 *   multiplies by `EMU_PER_PIXEL_AT_96_DPI` on render, so passing EMU through overshoots by 9525×.
 * - A chart's relationship comes from the **drawing**, not the sheet — the `graphicFrame` names it.
 */
import { Chart, Workbook, Worksheet } from "@excel";
import { buildChartAnchors } from "@excel/utils/drawing-utils";
import type { DrawingRel } from "@excel/utils/drawing-utils";
import { describe, expect, it } from "vitest";

describe("buildChartAnchors", () => {
  it("converts an absolute position from EMU to pixels", () => {
    // 914400 EMU is one inch, which is 96 pixels at 96 dpi. Passing the EMU through produced
    // `<xdr:pos x="8709660000"/>` — a 9525× overshoot.
    const rels: DrawingRel[] = [];
    const anchors = buildChartAnchors(
      [
        {
          chartNumber: 1,
          range: { pos: { x: 914400, y: 914400 }, ext: { cx: 914400, cy: 457200 } }
        }
      ],
      rels
    );
    const range = (
      anchors[0] as unknown as { range: Record<string, { x?: number; width?: number }> }
    ).range;
    expect(range.pos?.x).toBe(96);
    // And `ext` is renamed: the model carries `{ cx, cy }` where the xform reads `{ width, height }`,
    // which otherwise renders as `NaN`.
    expect(range.ext?.width).toBe(96);
  });

  it("adds the relationship to the drawing, not the sheet", () => {
    const rels: DrawingRel[] = [];
    buildChartAnchors([{ chartNumber: 3, range: { tl: {}, br: {} } }], rels);
    expect(rels).toHaveLength(1);
    expect(rels[0].Target).toBe("../charts/chart3.xml");
  });

  it("distinguishes a modern ChartEx from a classic chart", () => {
    // Different relationship type, different part name, and an `alternateContent` wrapper — a ChartEx
    // written as a classic chart is a part Excel cannot read.
    const rels: DrawingRel[] = [];
    const anchors = buildChartAnchors([{ chartExNumber: 2, range: { tl: {}, br: {} } }], rels);
    expect(rels[0].Target).toBe("../charts/chartEx2.xml");
    expect(
      (anchors[0] as unknown as { alternateContent?: unknown }).alternateContent
    ).toBeDefined();
  });

  it("numbers relationships from the drawing's own id space", () => {
    // A chart on a sheet that already has a picture must not reuse the picture's id.
    const rels: DrawingRel[] = [{ Id: "rId1", Type: "image", Target: "../media/image1.png" }];
    buildChartAnchors([{ chartNumber: 1, range: { tl: {}, br: {} } }], rels);
    expect(rels[1].Id).toBe("rId2");
  });
});

describe("charts through an XLSB workbook", () => {
  /** A workbook with one bar chart. */
  function build() {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Data");
    Worksheet.addAoa(sheet, [
      ["a", 1],
      ["b", 2]
    ]);
    Chart.add(
      sheet,
      {
        type: "bar",
        title: "Sales",
        series: [{ name: "S", categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      } as never,
      "D2:H12" as never
    );
    return workbook;
  }

  it("writes the chart XML, the drawing and the relationship between them", async () => {
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    expect([...parts.keys()]).toContain("xl/charts/chart1.xml");
    expect([...parts.keys()]).toContain("xl/drawings/drawing1.xml");
    // The chart is reached from the *drawing's* rels, which is what the `graphicFrame` names.
    const drawingRels = new TextDecoder().decode(
      parts.get("xl/drawings/_rels/drawing1.xml.rels")!.data
    );
    expect(drawingRels).toContain("../charts/chart1.xml");
  });

  it("renders the chart's own content, not a placeholder", async () => {
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const xml = new TextDecoder().decode(parts.get("xl/charts/chart1.xml")!.data);
    expect(xml).toContain("Sales");
    expect(xml).toContain("c:barChart");
    // The series' data references have to survive, or the chart draws nothing.
    expect(xml).toContain("Data!$B$1:$B$2");
  });

  it("declares the chart part's content type", async () => {
    // A part with no content type is one the package does not describe, which Excel rejects.
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const declared = new TextDecoder().decode(parts.get("[Content_Types].xml")!.data);
    expect(declared).toContain("/xl/charts/chart1.xml");
    expect(declared).toContain("drawingml.chart+xml");
  });

  it("produces the same chart XML as the XLSX writer", async () => {
    // The point of reusing `renderChartWithLeadingComments` rather than reimplementing: the two
    // containers should differ in the *sheet* and in nothing else.
    const asXlsx = await extractAll(await Workbook.toBuffer(build()));
    const asXlsb = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    expect(new TextDecoder().decode(asXlsb.get("xl/charts/chart1.xml")!.data)).toBe(
      new TextDecoder().decode(asXlsx.get("xl/charts/chart1.xml")!.data)
    );
  });

  it("no longer reports a chart as a loss", async () => {
    await expect(Workbook.toBuffer(build(), { format: "xlsb" })).resolves.toBeDefined();
  });

  it("writes no chart part for a workbook with none", async () => {
    const workbook = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(workbook, "S"), [["a"]]);
    const paths = [
      ...(await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }))).keys()
    ];
    expect(paths.some(path => path.startsWith("xl/charts/"))).toBe(false);
  });
});

describe("chartsheets", () => {
  /** A workbook with a data sheet and a chartsheet. */
  function build() {
    const workbook = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(workbook, "Data"), [
      ["a", 1],
      ["b", 2]
    ]);
    Workbook.addChartsheet(workbook, "Chart1", {
      chart: {
        type: "bar",
        title: "T",
        series: [{ name: "S", categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      }
    } as never);
    return workbook;
  }

  it("emits the ten records the corpus workbook has, in that order", async () => {
    // Every one of these was read out of `cal-any_sheets.xlsb`, which is the only corpus workbook with a
    // chartsheet — so this is a comparison against Excel's own stream rather than against a field list.
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { recordSpec } = await import("@excel/xlsb/spec/records");
    const names = [
      ...iterateInterpretableRecords(parts.get("xl/chartsheets/sheet1.bin")!.data, "c")
    ].map(entry => recordSpec(entry.id)?.name);
    expect(names).toEqual([
      "BrtBeginSheet",
      "BrtCsProp",
      "BrtBeginCsViews",
      "BrtBeginCsView",
      "BrtEndCsView",
      "BrtEndCsViews",
      "BrtCsProtection",
      "BrtMargins",
      "BrtDrawing",
      "BrtEndSheet"
    ]);
  });

  it("writes all four parts a chartsheet needs", async () => {
    const paths = [
      ...(await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }))).keys()
    ];
    expect(paths).toContain("xl/chartsheets/sheet1.bin");
    expect(paths).toContain("xl/chartsheets/_rels/sheet1.bin.rels");
    // The drawing is separate from a worksheet's, because a chartsheet's uses an absolute anchor.
    expect(paths).toContain("xl/drawings/chartsheetDrawing1.xml");
    expect(paths).toContain("xl/drawings/_rels/chartsheetDrawing1.xml.rels");
    expect(paths).toContain("xl/charts/chart1.xml");
  });

  it("anchors the chart absolutely, not to cells", async () => {
    // A chartsheet has no cell grid, so a cell-based anchor resolves to a 0×0 rectangle and Excel renders
    // a blank canvas. Both the anchor-level and the frame-level extents have to be non-zero.
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const xml = new TextDecoder().decode(parts.get("xl/drawings/chartsheetDrawing1.xml")!.data);
    expect(xml).toContain("absoluteAnchor");
    expect(xml).toContain("9906000");
    expect(xml).not.toContain("twoCellAnchor");
  });

  it("gives the chartsheet a bundle entry and its own relationship", async () => {
    // A workbook that writes the parts and omits the bundle entry has files nothing reaches, and Excel
    // shows no tab for them.
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { recordSpec } = await import("@excel/xlsb/spec/records");
    const bundles = [
      ...iterateInterpretableRecords(parts.get("xl/workbook.bin")!.data, "w")
    ].filter(entry => recordSpec(entry.id)?.name === "BrtBundleSh");
    expect(bundles).toHaveLength(2);
    const rels = new TextDecoder().decode(parts.get("xl/_rels/workbook.bin.rels")!.data);
    expect(rels).toContain("chartsheets/sheet1.bin");
  });

  it("points the bundle entry at the chartsheet, not at a worksheet", async () => {
    // `BrtBundleSh` carries a relationship id, and deriving it from the bundle *position* pointed every
    // chartsheet at a worksheet — a tab labelled "Chart1" whose contents were a grid.
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const rels = new TextDecoder().decode(parts.get("xl/_rels/workbook.bin.rels")!.data);
    const chartsheetId = /Id="([^"]+)"[^>]*Target="chartsheets\/sheet1\.bin"/.exec(rels)?.[1];
    expect(chartsheetId).toBeDefined();
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { recordSpec } = await import("@excel/xlsb/spec/records");
    const bundles = [
      ...iterateInterpretableRecords(parts.get("xl/workbook.bin")!.data, "w")
    ].filter(entry => recordSpec(entry.id)?.name === "BrtBundleSh");
    // The second bundle entry is the chartsheet's; its relationship id is in the payload after the two
    // leading `u32`s.
    const payload = bundles[1].payload;
    const length = new DataView(payload.buffer, payload.byteOffset).getUint32(8, true);
    const relId = new TextDecoder("utf-16le").decode(payload.slice(12, 12 + length * 2));
    expect(relId).toBe(chartsheetId);
  });

  it("declares the chartsheet's own content type, not the worksheet's", async () => {
    // A `.bin` is covered by this writer's `Default` with the *workbook's* type, and a chartsheet
    // described as a worksheet is one Excel reads as an empty grid.
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const declared = new TextDecoder().decode(parts.get("[Content_Types].xml")!.data);
    expect(declared).toContain('PartName="/xl/chartsheets/sheet1.bin"');
    expect(declared).toContain("application/vnd.ms-excel.chartsheet");
  });

  it("no longer reports a chartsheet as a loss", async () => {
    await expect(Workbook.toBuffer(build(), { format: "xlsb" })).resolves.toBeDefined();
  });
});
