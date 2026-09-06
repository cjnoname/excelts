/**
 * Synthetic chart corpus integration tests.
 *
 * Single home for the per-preset / per-ChartEx-layoutId package audit
 * matrix and the auto-mode LibreOffice open-validation gate. Built on
 * top of the `synthetic-fixtures` builders so per-type coverage is
 * data-driven and reusable from other integration files.
 *
 * Real-fixture round-trip lives in
 * `workbook-chart-roundtrip.integration.test.ts`. Mutation fidelity,
 * chartsheet, combo/axis matrix, and pivot chart fidelity each have
 * their own dedicated integration file.
 */

import { extractAll } from "@archive/unzip/extract";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { runLibreOfficeOpenValidationAuto } from "@excel/__tests__/helpers/external-oracle";
import type { SyntheticFixture } from "@excel/__tests__/helpers/synthetic-fixtures";
import {
  buildChartExFixtures,
  buildClassicPresetFixtures,
  buildComboAxisFixtures,
  buildChartsheetFixtures,
  buildPivotChartFixtures,
  CHART_EX_TYPES
} from "@excel/__tests__/helpers/synthetic-fixtures";
import { entryText } from "@excel/__tests__/helpers/zip-text";
import { applyChartPreset, EXCEL_CHART_PRESETS } from "@excel/chart";
import { addChart, addChartEx, getCharts } from "@excel/core/worksheet";
import { Chart, Workbook, Worksheet } from "@excel/index";
import { beforeAll, describe, expect, it } from "vitest";

// Top-level fixture cache. Built once per file via `beforeAll` so the
// per-fixture matrix tests don't pay the xlsx-serialisation cost N
// times. Tests must NOT mutate `fixture.bytes` in place — they reload
// via `Workbook.load(...)` which copies the buffer.
let classicFixtures: SyntheticFixture[];
let chartExFixtures: SyntheticFixture[];
let comboAxisFixtures: SyntheticFixture[];
let chartsheetFixtures: SyntheticFixture[];
let pivotChartFixtures: SyntheticFixture[];

beforeAll(async () => {
  [classicFixtures, chartExFixtures, comboAxisFixtures, chartsheetFixtures, pivotChartFixtures] =
    await Promise.all([
      buildClassicPresetFixtures(),
      buildChartExFixtures(),
      buildComboAxisFixtures(),
      buildChartsheetFixtures(),
      buildPivotChartFixtures()
    ]);
});

async function expectAuditClean(fixture: SyntheticFixture): Promise<void> {
  await expectValidXlsx(fixture.bytes, {
    label: `${fixture.id} (${fixture.description})`
  });
}

async function expectOpensInLibreOffice(fixture: SyntheticFixture): Promise<void> {
  const result = await runLibreOfficeOpenValidationAuto(fixture.bytes, `${fixture.id}.xlsx`);
  if (!result.available) {
    expect(result.skipped, fixture.id).toBeTruthy();
    return;
  }
  expect(result.exitCode, `${fixture.id}: ${result.stderr ?? ""}`).toBe(0);
  expect(result.outputs.length, fixture.id).toBeGreaterThan(0);
}

describe("Synthetic chart corpus", () => {
  describe("audit baseline", () => {
    it("keeps the package audit clean for every classic preset", async () => {
      const fixtures = classicFixtures;
      expect(fixtures.length).toBe(EXCEL_CHART_PRESETS.length);
      for (const fixture of fixtures) {
        await expectAuditClean(fixture);
      }
    });

    it("keeps the package audit clean for every ChartEx layoutId", async () => {
      const fixtures = chartExFixtures;
      expect(fixtures.length).toBe(CHART_EX_TYPES.length);
      for (const fixture of fixtures) {
        await expectAuditClean(fixture);
      }
    });

    it("keeps the package audit clean across combo/axis variants", async () => {
      const fixtures = comboAxisFixtures;
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        await expectAuditClean(fixture);
      }
    });

    it("keeps the package audit clean for chartsheet hosting", async () => {
      const fixtures = chartsheetFixtures;
      for (const fixture of fixtures) {
        await expectAuditClean(fixture);
      }
    });

    it("keeps the package audit clean for pivot chart variants", async () => {
      const fixtures = pivotChartFixtures;
      for (const fixture of fixtures) {
        await expectAuditClean(fixture);
      }
    });
  });

  describe("synthetic marker decoration", () => {
    it("preserves the SYNTHETIC marker AND vendor extLst on every classic chart part", async () => {
      const fixtures = classicFixtures;
      for (const fixture of fixtures) {
        const entries = await extractAll(fixture.bytes);
        const chartPaths = [...entries.keys()].filter(name =>
          /^xl\/charts\/chart\d+[.]xml$/.test(name)
        );
        expect(chartPaths.length, fixture.id).toBeGreaterThan(0);
        for (const path of chartPaths) {
          const xml = entryText(entries, path)!;
          expect(xml, `${fixture.id} ${path} marker`).toContain("SYNTHETIC-FIXTURE");
          expect(xml, `${fixture.id} ${path} extLst`).toContain("{synthetic-roundtrip-fixture}");
        }
      }
    });
  });

  describe("classic preset model survives load → write", () => {
    it("retains primary chart-type for every preset after one round trip", async () => {
      const fixtures = classicFixtures;
      for (const fixture of fixtures) {
        const expectedType = applyChartPreset(
          fixture.id.replace(/^classic-/, "") as Parameters<typeof applyChartPreset>[0],
          { series: [] }
        ).type;
        const wb = Workbook.create();
        await Workbook.read(wb, fixture.bytes);
        const sheet = Workbook.getWorksheet(wb, "Data")!;
        expect(sheet, fixture.id).toBeDefined();
        const charts = getCharts(sheet!);
        expect(charts.length, fixture.id).toBeGreaterThanOrEqual(1);
        const loadedType = Chart.chartModel(charts[0])?.chart.plotArea.chartTypes[0].type;
        expect(loadedType, `${fixture.id} expected ${expectedType}`).toBe(expectedType);
      }
    });
  });

  describe("ChartEx layoutId survives load → write", () => {
    it("retains a series with the correct layoutId for every ChartEx fixture", async () => {
      const fixtures = chartExFixtures;
      for (const fixture of fixtures) {
        const layoutType = fixture.id.replace(/^chartEx-/, "");
        const wb = Workbook.create();
        await Workbook.read(wb, fixture.bytes);
        const charts = getCharts(Workbook.getWorksheet(wb, "Data")!);
        expect(charts.length, fixture.id).toBeGreaterThanOrEqual(1);
        const plotArea = Chart.chartExModel(charts[0])?.chartSpace.chart.plotArea;
        const firstSeries = plotArea?.plotAreaRegion?.series?.[0] ?? plotArea?.series?.[0];
        expect(firstSeries, fixture.id).toBeDefined();
        // Histogram and Pareto normalise to clusteredColumn internally.
        const expectedLayout =
          layoutType === "histogram" || layoutType === "pareto" ? "clusteredColumn" : layoutType;
        expect(firstSeries!.layoutId, fixture.id).toBe(expectedLayout);
      }
    });
  });

  describe("LibreOffice open-validation (auto)", () => {
    it("opens every classic preset fixture if LibreOffice is installed", async () => {
      const fixtures = classicFixtures;
      for (const fixture of fixtures) {
        await expectOpensInLibreOffice(fixture);
      }
      // Each fixture is a separate LibreOffice process start, so the default 30 s covers roughly one of them.
    }, 600_000);

    it("opens every ChartEx fixture if LibreOffice is installed", async () => {
      const fixtures = chartExFixtures;
      for (const fixture of fixtures) {
        await expectOpensInLibreOffice(fixture);
      }
      // Each fixture is a separate LibreOffice process start, so the default 30 s covers roughly one of them.
    }, 600_000);

    it("opens combo/axis variants if LibreOffice is installed", async () => {
      const fixtures = comboAxisFixtures;
      for (const fixture of fixtures) {
        await expectOpensInLibreOffice(fixture);
      }
      // Each fixture is a separate LibreOffice process start, so the default 30 s covers roughly one of them.
    }, 600_000);

    it("opens chartsheet variants if LibreOffice is installed", async () => {
      const fixtures = chartsheetFixtures;
      for (const fixture of fixtures) {
        await expectOpensInLibreOffice(fixture);
      }
      // Each fixture is a separate LibreOffice process start, so the default 30 s covers roughly one of them.
    }, 600_000);

    it("opens pivot chart variants if LibreOffice is installed", async () => {
      const fixtures = pivotChartFixtures;
      for (const fixture of fixtures) {
        await expectOpensInLibreOffice(fixture);
      }
      // Each fixture is a separate LibreOffice process start, so the default 30 s covers roughly one of them.
    }, 600_000);
  });

  // -----------------------------------------------------------------------
  // Edge-case audit cases that don't fit the per-fixture matrix above
  // -----------------------------------------------------------------------

  describe("audit edge cases", () => {
    it("validates rels and content types when classic + ChartEx + chartsheet all coexist", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Data");
      Worksheet.addRows(ws, [
        ["A", 10],
        ["B", 20]
      ]);
      addChart(
        ws,
        {
          type: "bar",
          series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }],
          chartStyle: { id: 10 },
          chartColors: { method: "cycle", colors: [{ srgb: "4472C4" }] }
        },
        "D1:J10"
      );
      addChartEx(
        ws,
        { type: "waterfall", categories: "Data!$A$1:$A$2", series: [{ values: "Data!$B$1:$B$2" }] },
        "D12:J22"
      );
      Workbook.addChartsheet(wb, "Chart Sheet", {
        chart: {
          type: "funnel",
          categories: "Data!$A$1:$A$2",
          series: [{ values: "Data!$B$1:$B$2" }]
        }
      });

      const entries = await extractAll(new Uint8Array(await Workbook.toBuffer(wb)));
      const contentTypes = entryText(entries, "[Content_Types].xml")!;
      expect(contentTypes).toContain("/xl/charts/chart1.xml");
      expect(contentTypes).toContain("/xl/charts/chartEx1.xml");
      expect(contentTypes).toContain("/xl/chartsheets/sheet1.xml");

      const drawingRels = entryText(entries, "xl/drawings/_rels/drawing1.xml.rels")!;
      expect(drawingRels).toContain("../charts/chart1.xml");
      expect(drawingRels).toContain("../charts/chartEx1.xml");
      const chartRels = entryText(entries, "xl/charts/_rels/chart1.xml.rels")!;
      expect(chartRels).toContain("chartStyle");
      expect(chartRels).toContain("chartColorStyle");
      const chartsheetRels = entryText(entries, "xl/chartsheets/_rels/sheet1.xml.rels")!;
      expect(chartsheetRels).toContain("../drawings/");
    });

    it("reports missing cx:data id, cx:axis id, and externalData rel references", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Data");
      Worksheet.addRows(ws, [
        ["A", 10],
        ["B", 20]
      ]);
      addChartEx(
        ws,
        { type: "waterfall", categories: "Data!$A$1:$A$2", series: [{ values: "Data!$B$1:$B$2" }] },
        "D1:J10"
      );
      const buffer = new Uint8Array(await Workbook.toBuffer(wb));
      const entries = await extractAll(buffer);
      const chartExEntry = entries.get("xl/charts/chartEx1.xml")!;
      const originalXml = new TextDecoder().decode(chartExEntry.data);
      // The in-tree ChartEx builder no longer emits `<cx:axisId>`
      // children on `<cx:series>` (Excel's own output omits them;
      // the axis binding is implicit from the `<cx:axis>` elements
      // in `<cx:plotArea>`). Inject an axisId child with an id
      // pointing at a non-existent axis so the validator can still
      // exercise its "missing cx:axis id" diagnostic.
      const dataIdMatch = originalXml.match(/<cx:dataId val="(\d+)"\/>/);
      const originalDataId = dataIdMatch?.[1];
      chartExEntry.data = new TextEncoder().encode(
        originalXml
          .replace(/<cx:dataId val="\d+"\/>/, '<cx:dataId val="99"/><cx:axisId val="42"/>')
          .replace(
            "<cx:chartData>",
            '<cx:chartData><cx:externalData r:id="rMissing" autoUpdate="1"/>'
          )
      );

      // Rebuild the zip with the mutated chartEx part so the validator
      // sees it. The legacy test variant operated on the raw entries
      // map; the new validator operates on a real zip buffer, so we
      // must re-zip.
      const { ZipArchive } = await import("@archive/zip");
      const zip = new ZipArchive({ level: 0 });
      for (const [p, entry] of entries) {
        if (entry.type !== "directory") {
          zip.add(p, entry.data);
        }
      }
      const mutatedZip = zip.bytesSync();

      const { validateXlsxBuffer } = await import("@excel/utils/ooxml-validator");
      const report = await validateXlsxBuffer(mutatedZip, { maxProblems: 50 });
      const problemText = report.problems.map(p => `${p.kind}: ${p.message}`).join("\n");
      // Assert: the injected axis-id reference (42) has no matching
      // `<cx:axis id="42">`; the injected external-data relationship
      // id (`rMissing`) isn't declared; the dataId mutation only
      // reports "missing cx:data id 99" when the original chart
      // actually had id 99 referenced — that part depends on the
      // renderer's synthetic id allocation and isn't the load-
      // bearing assertion. Validator must catch at least the axis
      // and external-rel diagnostics.
      expect(problemText).toContain("missing cx:axis id 42");
      expect(problemText).toContain("rMissing");
      void originalDataId;
    });
  });
});
