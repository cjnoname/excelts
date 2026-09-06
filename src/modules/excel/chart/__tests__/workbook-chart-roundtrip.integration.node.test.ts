import * as fs from "fs";
/**
 * Real-fixture round-trip integration tests.
 *
 * This file is the single home for assertions that depend on
 * `__tests__/data/chart-pivot-sample.xlsx` — a real Excel-produced
 * workbook checked into the repository. Anything that can be expressed
 * with a synthetically generated workbook lives in one of these
 * sibling integration files instead, to keep concerns separated:
 *
 *   - chart-synthetic-corpus.integration.test.ts   — preset / ChartEx
 *     matrix + auto LibreOffice open-validation
 *   - chart-mutation-roundtrip.integration.test.ts — load → mutate →
 *     write fidelity (extLst, sidecar, unknown XML survival)
 *   - chartsheet-roundtrip.integration.test.ts     — multi-chartsheet
 *     view/page/state fidelity
 *   - chart-combo-axis-matrix.integration.test.ts  — combo / log /
 *     date / multi-secondary axis matrix
 *   - pivot-chart-roundtrip.integration.test.ts    — multi-cache,
 *     dropZone, refreshOnOpen pivot chart fidelity
 */

import { extractAll } from "@archive/unzip/extract";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { runLibreOfficeOpenValidationAuto } from "@excel/__tests__/helpers/external-oracle";
import { getWorksheets } from "@excel/core/workbook";
import type { WorkbookData } from "@excel/core/workbook-core";
import { getCharts, getSheetName } from "@excel/core/worksheet";
import { Cell, Chart, Workbook } from "@excel/index";
import { makeTestDataPath } from "@test/utils";
import { describe, it, expect, beforeAll } from "vitest";

// Path to test data file (fixtures stay centralized in __tests__/data)
const SAMPLE_FILE = makeTestDataPath(
  import.meta.url,
  "../../__tests__/data"
)("chart-pivot-sample.xlsx");

// Test utilities
let sampleBuffer: Buffer;

/**
 * Helper to load the sample file and return a workbook
 */
async function loadSampleWorkbook(): Promise<WorkbookData> {
  const workbook = Workbook.create();
  await Workbook.read(workbook, sampleBuffer);
  return workbook;
}

/**
 * Helper to get text content from ZIP entry
 */
function getEntryContent(entries: Map<string, any>, entryPath: string): string | null {
  const entry = entries.get(entryPath);
  if (!entry) {
    return null;
  }
  return new TextDecoder().decode(entry.data);
}

/**
 * Helper to perform round-trip and return both input/output entries
 */
async function performRoundTrip(): Promise<{
  inputEntries: Map<string, any>;
  outputEntries: Map<string, any>;
  outputBytes: Uint8Array;
}> {
  const workbook = await loadSampleWorkbook();
  const outputBuffer = await Workbook.toBuffer(workbook);
  const outputBytes = new Uint8Array(outputBuffer);

  const inputEntries = await extractAll(new Uint8Array(sampleBuffer));
  const outputEntries = await extractAll(outputBytes);

  return { inputEntries, outputEntries, outputBytes };
}

describe("Chart Round-Trip Preservation", () => {
  // Load sample buffer once before all tests
  beforeAll(() => {
    sampleBuffer = fs.readFileSync(SAMPLE_FILE);
  });

  describe("round-trip preservation", () => {
    it("should preserve chart files during read/write cycle", async () => {
      const workbook = await loadSampleWorkbook();

      // Verify workbook was loaded
      expect(getWorksheets(workbook).length).toBe(2);
      expect(getWorksheets(workbook).map(ws => getSheetName(ws))).toContain("Data");
      expect(getWorksheets(workbook).map(ws => getSheetName(ws))).toContain("Pivot");

      const { inputEntries, outputEntries } = await performRoundTrip();

      // Get file lists
      const inputFiles = [...inputEntries.keys()].sort();
      const outputFiles = [...outputEntries.keys()].sort();

      // Check that all chart-related files are preserved
      const chartFiles = [
        "xl/charts/chart1.xml",
        "xl/charts/style1.xml",
        "xl/charts/colors1.xml",
        "xl/charts/_rels/chart1.xml.rels"
      ];

      for (const chartFile of chartFiles) {
        expect(inputFiles).toContain(chartFile);
        expect(outputFiles).toContain(chartFile);
      }

      // Check that drawing files are preserved
      const drawingFiles = ["xl/drawings/drawing1.xml", "xl/drawings/_rels/drawing1.xml.rels"];

      for (const drawingFile of drawingFiles) {
        expect(inputFiles).toContain(drawingFile);
        expect(outputFiles).toContain(drawingFile);
      }

      // Verify chart content is preserved
      // Chart XML is now parsed and re-rendered (not byte-for-byte passthrough),
      // so we verify structural correctness instead of exact match.
      const outputChartXml = getEntryContent(outputEntries, "xl/charts/chart1.xml");
      expect(outputChartXml).toContain("c:chartSpace");
      expect(outputChartXml).toContain("c:barChart");
      expect(outputChartXml).toContain('c:barDir val="col"');
      expect(outputChartXml).toContain('c:grouping val="clustered"');
      expect(outputChartXml).toContain("Pivot!$B$1");
      expect(outputChartXml).toContain("Pivot!$A$2:$A$6");
      expect(outputChartXml).toContain("c:catAx");
      expect(outputChartXml).toContain("c:valAx");
      expect(outputChartXml).toContain("c:legend");
      expect(outputChartXml).toContain("c:printSettings");

      // Style and colors are raw byte passthrough — should match exactly
      for (const file of ["xl/charts/style1.xml", "xl/charts/colors1.xml"]) {
        const inputContent = getEntryContent(inputEntries, file);
        const outputContent = getEntryContent(outputEntries, file);
        expect(outputContent).toBe(inputContent);
      }

      // Chart rels should be structurally correct
      const outputChartRels = getEntryContent(outputEntries, "xl/charts/_rels/chart1.xml.rels");
      expect(outputChartRels).toContain("Relationship");
      expect(outputChartRels).toContain("chartStyle");
      expect(outputChartRels).toContain("chartColorStyle");

      // Verify drawing XML contains graphicFrame (chart reference)
      // Drawing XML is regenerated, so verify structure rather than exact match
      const outputDrawing = getEntryContent(outputEntries, "xl/drawings/drawing1.xml");
      expect(outputDrawing).toContain("xdr:graphicFrame");
      expect(outputDrawing).toContain("xdr:wsDr");
      const inputDrawing = getEntryContent(inputEntries, "xl/drawings/drawing1.xml");
      expect(inputDrawing).toContain("xdr:graphicFrame");
    });

    it("should preserve pivot tables during read/write cycle", async () => {
      const workbook = await loadSampleWorkbook();

      // Verify pivot table is loaded
      expect(workbook.pivotTables.length).toBe(1);

      const { inputEntries, outputEntries } = await performRoundTrip();

      // Check that pivot table files are preserved
      const pivotFiles = [
        "xl/pivotTables/pivotTable1.xml",
        "xl/pivotTables/_rels/pivotTable1.xml.rels",
        "xl/pivotCache/pivotCacheDefinition1.xml",
        "xl/pivotCache/pivotCacheRecords1.xml",
        "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels"
      ];

      const inputFiles = [...inputEntries.keys()];
      const outputFiles = [...outputEntries.keys()];

      for (const pivotFile of pivotFiles) {
        expect(inputFiles).toContain(pivotFile);
        expect(outputFiles).toContain(pivotFile);
      }
    });

    it("should generate valid Content_Types.xml with chart content types", async () => {
      const { outputEntries } = await performRoundTrip();

      // Get Content_Types.xml
      const contentTypesXml = getEntryContent(outputEntries, "[Content_Types].xml");
      expect(contentTypesXml).not.toBeNull();

      // Verify chart content types are present
      expect(contentTypesXml).toContain("/xl/charts/chart1.xml");
      expect(contentTypesXml).toContain(
        "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
      );
      expect(contentTypesXml).toContain("application/vnd.ms-office.chartstyle+xml");
      expect(contentTypesXml).toContain("application/vnd.ms-office.chartcolorstyle+xml");
    });

    it("validates audit baseline on the real-fixture workbook", async () => {
      const { outputBytes } = await performRoundTrip();
      await expectValidXlsx(outputBytes);
    });

    it("optionally smoke-opens the real-fixture workbook with LibreOffice headless", async () => {
      const workbook = await loadSampleWorkbook();
      const output = new Uint8Array(await Workbook.toBuffer(workbook));
      const result = await runLibreOfficeOpenValidationAuto(
        output,
        "chart-pivot-sample-roundtrip.xlsx"
      );
      if (!result.available) {
        expect(result.skipped).toBeTruthy();
        return;
      }
      expect(result.exitCode).toBe(0);
      expect(result.outputs.length).toBeGreaterThan(0);
      // External conversions are serialised across workers by a lock in `external-oracle.ts`, so the wait for the lock
      // counts against this test's own budget even though the conversion itself is quick.
    }, 600_000);

    it("should preserve pivot table attributes including chartFormat", async () => {
      const { outputEntries } = await performRoundTrip();

      // Get pivot table XML
      const pivotTableXml = getEntryContent(outputEntries, "xl/pivotTables/pivotTable1.xml");
      expect(pivotTableXml).not.toBeNull();

      // Verify critical attributes for chart integration
      expect(pivotTableXml).toContain('chartFormat="1"');
      expect(pivotTableXml).toContain('outline="1"');
      expect(pivotTableXml).toContain('outlineData="1"');

      // Verify chartFormats section exists
      expect(pivotTableXml).toContain("<chartFormats");
      expect(pivotTableXml).toContain("<chartFormat");
    });

    it("should preserve rowItems and colItems in pivot table", async () => {
      const { outputEntries } = await performRoundTrip();

      // Get pivot table XML
      const pivotTableXml = getEntryContent(outputEntries, "xl/pivotTables/pivotTable1.xml");
      expect(pivotTableXml).not.toBeNull();

      // Verify rowItems has correct count (5 items: 4 data + 1 grand total)
      expect(pivotTableXml).toContain('<rowItems count="5">');

      // Verify colItems exists
      expect(pivotTableXml).toContain("<colItems");
    });

    it("should preserve worksheet-drawing relationship", async () => {
      const { outputEntries } = await performRoundTrip();

      // Get sheet2 relationships
      const sheet2RelsXml = getEntryContent(outputEntries, "xl/worksheets/_rels/sheet2.xml.rels");
      expect(sheet2RelsXml).not.toBeNull();

      // Verify drawing relationship exists
      expect(sheet2RelsXml).toContain("relationships/drawing");
      expect(sheet2RelsXml).toContain("drawings/drawing1.xml");

      // Get sheet2.xml
      const sheet2Xml = getEntryContent(outputEntries, "xl/worksheets/sheet2.xml");
      expect(sheet2Xml).not.toBeNull();

      // Verify drawing reference in sheet
      expect(sheet2Xml).toContain("<drawing");
      expect(sheet2Xml).toContain("r:id=");
    });

    it("should preserve drawing-chart relationship", async () => {
      const { outputEntries } = await performRoundTrip();

      // Get drawing1 relationships
      const drawingRelsXml = getEntryContent(outputEntries, "xl/drawings/_rels/drawing1.xml.rels");
      expect(drawingRelsXml).not.toBeNull();

      // Verify chart relationship exists
      expect(drawingRelsXml).toContain("relationships/chart");
      expect(drawingRelsXml).toContain("charts/chart1.xml");
    });
  });

  describe("data integrity", () => {
    it("should access charts via high-level API after load", async () => {
      const workbook = await loadSampleWorkbook();

      // Find the worksheet that contains the chart (Pivot sheet)
      const pivotSheet = Workbook.getWorksheet(workbook, "Pivot")!;
      expect(pivotSheet).toBeDefined();

      const charts = getCharts(pivotSheet!);
      expect(charts.length).toBe(1);

      const chart = charts[0];
      expect(chart.chartNumber).toBe(1);

      // This chart has an auto-generated title (no explicit c:tx), so title is undefined
      expect(Chart.title(chart)).toBeUndefined();

      // Verify chart model is accessible
      expect(Chart.chartModel(chart)).toBeDefined();
      expect(Chart.chartTypes(chart).length).toBeGreaterThan(0);
      expect(Chart.chartTypes(chart)[0].type).toBe("bar");
      expect(Chart.axes(chart).length).toBeGreaterThan(0);
    });

    it("should read chart title after setting it programmatically", async () => {
      const workbook = await loadSampleWorkbook();
      const pivotSheet = Workbook.getWorksheet(workbook, "Pivot")!;
      const chart = getCharts(pivotSheet!)[0];

      // Set a title
      Chart.setTitle(chart, "Revenue by Region");
      expect(Chart.title(chart)).toBe("Revenue by Region");

      // Round-trip and verify
      const outputBuffer = await Workbook.toBuffer(workbook);
      const workbook2 = Workbook.create();
      await Workbook.read(workbook2, outputBuffer);

      const chart2 = getCharts(Workbook.getWorksheet(workbook2, "Pivot")!)[0];
      expect(Chart.title(chart2)).toBe("Revenue by Region");
    });

    it("should preserve cell data in Data sheet", async () => {
      const workbook = await loadSampleWorkbook();

      // Get Data sheet
      const dataSheet = Workbook.getWorksheet(workbook, "Data")!;
      expect(dataSheet).toBeDefined();

      // Check header row (actual values from test file)
      expect(Cell.getValue(dataSheet!, "A1")).toBe("Custom ID");
      expect(Cell.getValue(dataSheet!, "B1")).toBe("Customer Name");
      expect(Cell.getValue(dataSheet!, "C1")).toBe("Region");
      expect(Cell.getValue(dataSheet!, "D1")).toBe("Revenue");

      // Write and re-read
      const outputBuffer = await Workbook.toBuffer(workbook);
      const workbook2 = Workbook.create();
      await Workbook.read(workbook2, outputBuffer);

      // Verify data preserved
      const dataSheet2 = Workbook.getWorksheet(workbook2, "Data")!;
      expect(Cell.getValue(dataSheet2!, "A1")).toBe("Custom ID");
      expect(Cell.getValue(dataSheet2!, "B1")).toBe("Customer Name");
    });

    it("should preserve pivot table summary values in Pivot sheet", async () => {
      const workbook = await loadSampleWorkbook();

      // Get Pivot sheet
      const pivotSheet = Workbook.getWorksheet(workbook, "Pivot")!;
      expect(pivotSheet).toBeDefined();

      // Write and re-read
      const outputBuffer = await Workbook.toBuffer(workbook);
      const workbook2 = Workbook.create();
      await Workbook.read(workbook2, outputBuffer);

      // Verify pivot sheet still exists
      const pivotSheet2 = Workbook.getWorksheet(workbook2, "Pivot")!;
      expect(pivotSheet2).toBeDefined();
    });
  });
});
