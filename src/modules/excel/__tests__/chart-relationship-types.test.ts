/**
 * Relationship type URIs, which are case-sensitive and were written out by hand.
 *
 * **Why this file exists.** A drawing that anchors a modern chart names its `chartEx` part through a
 * relationship, and `drawing-utils.ts` wrote that relationship's `Type` as a string literal:
 * `…/office/drawing/2014/chartex`. The real type is `…/office/2014/relationships/chartEx` — a different path
 * *and* a different case. Relationship type URIs are compared case-sensitively (part *names* are not, which is
 * the trap), so Excel did not recognise the relationship, could not resolve the `graphicFrame` that named it,
 * and answered `Removed Part: /xl/drawings/drawingN.xml (Drawing shape)`.
 *
 * Every chart part was correct. Every drawing was correct. The *link* between them was not, and nothing in five
 * thousand tests looked at it — the workbook was written, read back and compared without either side ever
 * examining a relationship type. So these assertions compare against `RelType`, the single table, and against
 * the shapes Excel writes.
 */
import { extractAll } from "@archive/unzip/extract";
import { Chart, Workbook, Worksheet } from "@excel";
import { RelType } from "@excel/xlsx/rel-type";
import { describe, expect, it } from "vitest";

/** A workbook with one ordinary chart and one `chartEx` — a waterfall, which is the modern family. */
async function workbookWithBothChartKinds(
  format: "xlsx" | "xlsb"
): Promise<ReadonlyMap<string, { data: Uint8Array }>> {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "Data");
  Worksheet.addAoa(sheet, [
    ["Region", "Units"],
    ["APAC", 10],
    ["EMEA", 20],
    ["AMER", 30]
  ]);
  const series = [{ name: "Units", categories: "Data!$A$2:$A$4", values: "Data!$B$2:$B$4" }];
  Chart.addColumn(
    sheet as never,
    { series } as never,
    {
      tl: { col: 3, row: 1 },
      br: { col: 8, row: 10 }
    } as never
  );
  Chart.addWaterfall(
    sheet as never,
    { series } as never,
    {
      tl: { col: 3, row: 12 },
      br: { col: 8, row: 22 }
    } as never
  );
  return extractAll(await Workbook.toBuffer(workbook, { format, unsupported: "ignore" }));
}

/** Every `Type` a drawing's relationships declare. */
function drawingRelationshipTypes(parts: ReadonlyMap<string, { data: Uint8Array }>): string[] {
  const types: string[] = [];
  for (const [name, entry] of parts) {
    if (!/drawings\/_rels\/.*\.rels$/.test(name)) {
      continue;
    }
    const xml = new TextDecoder().decode(entry.data);
    for (const match of xml.matchAll(/Type="([^"]+)"/g)) {
      types.push(match[1]!);
    }
  }
  return types;
}

describe.each(["xlsx", "xlsb"] as const)("a chartEx relationship in %s", format => {
  it("uses the registered type URI, exactly", async () => {
    const types = drawingRelationshipTypes(await workbookWithBothChartKinds(format));
    expect(types).toContain(RelType.ChartEx);
    expect(types).toContain(RelType.Chart);
    // The literal that was there, spelled out so a reintroduction fails here rather than in Excel.
    expect(types).not.toContain("http://schemas.microsoft.com/office/drawing/2014/chartex");
  });

  it("names a part the package contains", async () => {
    // The other half of the same failure: a relationship whose target is absent is as fatal as one whose type is
    // unrecognised. The XLSB writer emitted this relationship and no `chartEx` part for years.
    const parts = await workbookWithBothChartKinds(format);
    for (const [name, entry] of parts) {
      if (!/drawings\/_rels\/.*\.rels$/.test(name)) {
        continue;
      }
      const xml = new TextDecoder().decode(entry.data);
      for (const match of xml.matchAll(/Target="([^"]+)"/g)) {
        const resolved = `xl/${match[1]!.replace(/^\.\.\//, "")}`;
        expect([...parts.keys()], `${name} names ${match[1]}`).toContain(resolved);
      }
    }
  });
});

describe("the namespace URI is a different string from the relationship type", () => {
  it("keeps the lowercase chartex namespace on the chart part", async () => {
    // **Both spellings are correct, in different places**, which is exactly how the wrong one got copied into a
    // relationship. The *namespace* really is `…/office/drawing/2014/chartex`, lowercase — Excel writes that —
    // while the *relationship type* is `…/office/2014/relationships/chartEx`. Pinning both stops a future
    // "consistency" edit from unifying them.
    const parts = await workbookWithBothChartKinds("xlsx");
    const chartEx = [...parts.keys()].find(name => /charts\/chartEx\d+\.xml$/.test(name));
    expect(chartEx).toBeDefined();
    const xml = new TextDecoder().decode(parts.get(chartEx!)!.data);
    expect(xml).toContain('xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"');
  });
});
