/**
 * Chartsheet round-trip integration tests.
 *
 * Single home for chartsheet-specific fidelity: multiple chartsheets,
 * hidden state, page setup / margins / view settings, tab metadata,
 * and the chartsheet → drawing → chart relationship chain.
 *
 * Real-fixture round-trip lives in
 * `workbook-chart-roundtrip.integration.test.ts`. Other chart fidelity
 * dimensions live in `chart-mutation-roundtrip`,
 * `chart-combo-axis-matrix`, and `pivot-chart-roundtrip`.
 */

import { extractAll } from "@archive/unzip/extract";
import { createZip } from "@archive/zip/zip-bytes";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import type { SyntheticFixture } from "@excel/__tests__/helpers/synthetic-fixtures";
import { buildChartsheetFixtures } from "@excel/__tests__/helpers/synthetic-fixtures";
import { entryText, loadRoundTrip } from "@excel/__tests__/helpers/zip-text";
import {
  chartsheetChart,
  chartsheetName,
  chartsheetPageMargins,
  chartsheetPageSetup,
  chartsheetState,
  chartsheetTabSelected,
  chartsheetZoomScale,
  chartsheetZoomToFit
} from "@excel/core/chartsheet";
import { getChartsheets, getWorksheets } from "@excel/core/workbook";
import { Chart, Workbook } from "@excel/index";
import { beforeAll, describe, expect, it } from "vitest";

function fileEntry(path: string, data: Uint8Array) {
  return { path, data, type: "file" as const, size: data.length, mode: 0 };
}

let chartsheetFixtures: SyntheticFixture[];

beforeAll(async () => {
  chartsheetFixtures = await buildChartsheetFixtures();
});

describe("Chartsheet round-trip", () => {
  it("preserves multiple chartsheets (pie, funnel, combo, hidden) plus a Data worksheet", async () => {
    const [fixture] = chartsheetFixtures;
    const { wb, bytes, entries } = await loadRoundTrip(fixture.bytes);

    // High-level model: 1 worksheet + 4 chartsheets.
    expect(getWorksheets(wb).length).toBe(1);
    expect(getChartsheets(wb).length).toBe(4);
    expect(
      getChartsheets(wb)
        .map(cs => chartsheetName(cs))
        .sort()
    ).toEqual(["Combo Chart Sheet", "Funnel Chart Sheet", "Hidden Sheet", "Pie Chart Sheet"]);

    // OOXML parts: 4 chartsheets + 1 worksheet.
    const chartsheetPaths = [...entries.keys()]
      .filter(p => /^xl\/chartsheets\/sheet\d+[.]xml$/.test(p))
      .sort();
    expect(chartsheetPaths.length).toBe(4);
    expect([...entries.keys()].filter(p => /^xl\/worksheets\/sheet\d+[.]xml$/.test(p)).length).toBe(
      1
    );

    // Package must validate cleanly.
    await expectValidXlsx(bytes);

    // Each chartsheet xml references a drawing relationship.
    for (const path of chartsheetPaths) {
      const xml = entryText(entries, path)!;
      expect(xml, `${path} drawing ref`).toMatch(/<drawing\s/);
      expect(xml, `${path} chartsheet root`).toContain("<chartsheet");
    }

    // Each chartsheet has its own drawing rels file pointing at a chart part.
    for (const path of chartsheetPaths) {
      const stem = path
        .split("/")
        .pop()!
        .replace(/[.]xml$/, "");
      const relsPath = `xl/chartsheets/_rels/${stem}.xml.rels`;
      const relsXml = entryText(entries, relsPath);
      expect(relsXml, relsPath).toBeDefined();
      expect(relsXml!).toContain("../drawings/");
    }
  });

  it("preserves hidden state, zoomScale, zoomToFit, pageSetup, pageMargins on the configured chartsheets", async () => {
    const [fixture] = chartsheetFixtures;
    const { wb, entries } = await loadRoundTrip(fixture.bytes);

    const pie = getChartsheets(wb).find(cs => chartsheetName(cs) === "Pie Chart Sheet")!;
    // tabSelected omitted/false → undefined after round-trip (writer
    // skips emitting `<sheetView tabSelected="0"/>` since 0 is the
    // OOXML default).
    expect(chartsheetTabSelected(pie) ?? false).toBe(false);
    expect(chartsheetZoomScale(pie)).toBe(80);
    expect(chartsheetZoomToFit(pie)).toBe(true);
    expect(chartsheetPageMargins(pie)).toMatchObject({
      l: 0.7,
      r: 0.7,
      t: 0.75,
      b: 0.75,
      header: 0.3,
      footer: 0.3
    });
    expect(chartsheetPageSetup(pie)?.orientation).toBe("landscape");
    expect(chartsheetPageSetup(pie)?.paperSize).toBe(9);

    const hidden = getChartsheets(wb).find(cs => chartsheetName(cs) === "Hidden Sheet")!;
    expect(chartsheetState(hidden)).toBe("hidden");

    // The XML of the Pie chartsheet should also carry the page settings.
    // Locate by index rather than name (write order matches addChartsheet
    // call order in the fixture, so sheet1 = Pie).
    const sheet1Xml = entryText(entries, "xl/chartsheets/sheet1.xml")!;
    expect(sheet1Xml).toMatch(/<pageMargins[^>]*left="0\.7"/);
    expect(sheet1Xml).toMatch(/<pageSetup[^>]*orientation="landscape"/);
    expect(sheet1Xml).toMatch(/<pageSetup[^>]*paperSize="9"/);
    expect(sheet1Xml).toMatch(/zoomScale="80"/);
    expect(sheet1Xml).toMatch(/zoomToFit="1"/);

    // The Hidden chartsheet's hidden state lives on workbook.xml's
    // <sheets><sheet state="hidden" ...> entry.
    const workbookXml = entryText(entries, "xl/workbook.xml")!;
    expect(workbookXml).toMatch(/name="Hidden Sheet"[^>]*state="hidden"/);
  });

  it("emits the right content types and chartsheet relationships for each sheet", async () => {
    const [fixture] = chartsheetFixtures;
    const { entries } = await loadRoundTrip(fixture.bytes);

    const contentTypes = entryText(entries, "[Content_Types].xml")!;
    for (let i = 1; i <= 4; i++) {
      expect(contentTypes, `chartsheet${i} content type`).toContain(
        `/xl/chartsheets/sheet${i}.xml`
      );
    }

    // The workbook rels must reference each chartsheet.
    const workbookRels = entryText(entries, "xl/_rels/workbook.xml.rels")!;
    for (let i = 1; i <= 4; i++) {
      expect(workbookRels, `workbook rels chartsheet${i}`).toContain(`chartsheets/sheet${i}.xml`);
    }
  });

  it("repeated round-trips remain stable for chartsheet-only workbooks", async () => {
    const [fixture] = chartsheetFixtures;
    let bytes = fixture.bytes;
    for (let i = 0; i < 3; i++) {
      const wb = Workbook.create();
      await Workbook.read(wb, bytes);
      expect(getChartsheets(wb).length, `pass ${i + 1}`).toBe(4);
      bytes = new Uint8Array(await Workbook.toBuffer(wb));
      await expectValidXlsx(bytes, { label: `pass ${i + 1}` });
    }
  });

  it("a high-level mutation on a chartsheet's chart re-renders without dropping page metadata", async () => {
    const [fixture] = chartsheetFixtures;
    const wb = Workbook.create();
    await Workbook.read(wb, fixture.bytes);
    const pie = getChartsheets(wb).find(cs => chartsheetName(cs) === "Pie Chart Sheet")!;
    const chart = chartsheetChart(pie);
    expect(chart, "pie chartsheet chart accessor").toBeDefined();
    Chart.setTitle(chart!, "Mutated Pie Title");

    const out = new Uint8Array(await Workbook.toBuffer(wb));
    const entries = await extractAll(out);
    await expectValidXlsx(out);

    const sheet1Xml = entryText(entries, "xl/chartsheets/sheet1.xml")!;
    expect(sheet1Xml, "page metadata still present").toMatch(/<pageSetup/);
    expect(sheet1Xml, "page metadata still present").toMatch(/<pageMargins/);

    const wb2 = Workbook.create();
    await Workbook.read(wb2, out);
    const pie2 = getChartsheets(wb2).find(cs => chartsheetName(cs) === "Pie Chart Sheet")!;
    expect(chartsheetChart(pie2)).toBeDefined();
    expect(Chart.title(chartsheetChart(pie2)!)).toBe("Mutated Pie Title");
    expect(chartsheetZoomScale(pie2)).toBe(80);
  });

  it("preserves chartsheet header/footer VML image parts and relationships", async () => {
    const [fixture] = chartsheetFixtures;
    const entries = await extractAll(fixture.bytes);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const sheetPath = "xl/chartsheets/sheet1.xml";
    const sheetRelsPath = "xl/chartsheets/_rels/sheet1.xml.rels";
    const sheet = decoder
      .decode(entries.get(sheetPath)!.data)
      .replace("</chartsheet>", '<legacyDrawingHF r:id="rIdHeaderImage"/></chartsheet>');
    const sheetRels = decoder
      .decode(entries.get(sheetRelsPath)!.data)
      .replace(
        "</Relationships>",
        '<Relationship Id="rIdHeaderImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawingHF99.vml"/></Relationships>'
      );
    entries.set(sheetPath, fileEntry(sheetPath, encoder.encode(sheet)));
    entries.set(sheetRelsPath, fileEntry(sheetRelsPath, encoder.encode(sheetRels)));
    const vmlPath = "xl/drawings/vmlDrawingHF99.vml";
    entries.set(
      vmlPath,
      fileEntry(
        vmlPath,
        encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
        <xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
          <v:shape id="CH" type="#_x0000_t75" style="width:20pt;height:10pt">
            <v:imagedata o:relid="rIdImage"/>
          </v:shape>
        </xml>`)
      )
    );
    const vmlRelsPath = "xl/drawings/_rels/vmlDrawingHF99.vml.rels";
    entries.set(
      vmlRelsPath,
      fileEntry(
        vmlRelsPath,
        encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/header99.png"/>
        </Relationships>`)
      )
    );
    const mediaPath = "xl/media/header99.png";
    entries.set(
      mediaPath,
      fileEntry(
        mediaPath,
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0,
          0, 0, 1, 0, 0, 0, 1
        ])
      )
    );
    const input = await createZip(
      [...entries].map(([name, entry]) => ({ name, data: entry.data }))
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const output = await Workbook.toBuffer(wb);
    const outputEntries = await extractAll(output);

    expect(outputEntries.has("xl/drawings/vmlDrawingHF99.vml")).toBe(true);
    expect(outputEntries.has("xl/drawings/_rels/vmlDrawingHF99.vml.rels")).toBe(true);
    expect(entryText(outputEntries, sheetPath)).toContain("legacyDrawingHF");
    expect(entryText(outputEntries, sheetRelsPath)).toContain("vmlDrawingHF99.vml");
    expect(entryText(outputEntries, "[Content_Types].xml")).toContain('Extension="vml"');
    await expectValidXlsx(output, { label: "chartsheet header/footer image round-trip" });
  });

  it("drops an unreproducible chartsheet VML relationship instead of dangling it", async () => {
    const [fixture] = chartsheetFixtures;
    const entries = await extractAll(fixture.bytes);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const sheetPath = "xl/chartsheets/sheet1.xml";
    const relsPath = "xl/chartsheets/_rels/sheet1.xml.rels";
    entries.get(sheetPath)!.data = encoder.encode(
      decoder
        .decode(entries.get(sheetPath)!.data)
        .replace("</chartsheet>", '<legacyDrawingHF r:id="rIdBroken"/></chartsheet>')
    );
    entries.get(relsPath)!.data = encoder.encode(
      decoder
        .decode(entries.get(relsPath)!.data)
        .replace(
          "</Relationships>",
          '<Relationship Id="rIdBroken" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawingHF100.vml"/></Relationships>'
        )
    );
    entries.set(
      "xl/drawings/vmlDrawingHF100.vml",
      fileEntry(
        "xl/drawings/vmlDrawingHF100.vml",
        encoder.encode(
          '<xml xmlns:v="urn:schemas-microsoft-com:vml"><v:shape id="CH" type="#_x0000_t75"><v:imagedata o:relid="missing"/></v:shape></xml>'
        )
      )
    );
    const input = await createZip(
      [...entries].map(([name, entry]) => ({ name, data: entry.data }))
    );
    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const output = await Workbook.toBuffer(wb);
    const out = await extractAll(output);

    expect(entryText(out, sheetPath)).not.toContain("legacyDrawingHF");
    expect(entryText(out, relsPath)).not.toContain("vmlDrawingHF100.vml");
    await expectValidXlsx(output, { label: "chartsheet broken VML cleanup" });
  });
});
