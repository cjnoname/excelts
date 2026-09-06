/**
 * Chart mutation round-trip integration tests.
 *
 * Verifies that loading a workbook, performing a high-level mutation
 * (title / legend / axis / data labels / ChartEx layoutPr), and then
 * writing the workbook back never silently drops:
 *
 *   - vendor `c:extLst/c:ext` extensions on `c:chart`
 *   - the synthetic-marker XML comment immediately preceding `c:chart`
 *   - `xl/charts/styleN.xml` and `xl/charts/colorsN.xml` sidecars (raw
 *     byte passthrough — must be byte-identical)
 *   - `xl/charts/_rels/chartN.xml.rels` chartStyle / chartColorStyle
 *     relationships
 *   - `xl/drawings/_rels/drawing1.xml.rels` chart relationship targets
 *
 * The fixtures are produced by `synthetic-fixtures.ts`, which decorates
 * every classic chart with both a SYNTHETIC marker comment AND a
 * `c14:foo` vendor extension namespaced under
 * `{synthetic-roundtrip-fixture}` so we can prove unknown XML survives
 * structured re-rendering.
 */

import type { ExtractedFile } from "@archive/unzip/extract";
import { extractAll } from "@archive/unzip/extract";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { runLibreOfficeOpenValidationAuto } from "@excel/__tests__/helpers/external-oracle";
import type { SyntheticFixture } from "@excel/__tests__/helpers/synthetic-fixtures";
import {
  buildClassicPresetFixtures,
  buildChartExFixtures
} from "@excel/__tests__/helpers/synthetic-fixtures";
import { bytesEqual, entryText, loadRoundTripDiff } from "@excel/__tests__/helpers/zip-text";
import { getCharts } from "@excel/core/worksheet";
import { Chart, Workbook } from "@excel/index";
import { beforeAll, describe, expect, it } from "vitest";

let classicFixtures: SyntheticFixture[];
let chartExFixtures: SyntheticFixture[];

beforeAll(async () => {
  [classicFixtures, chartExFixtures] = await Promise.all([
    buildClassicPresetFixtures(),
    buildChartExFixtures()
  ]);
});

function chartParts(entries: Map<string, ExtractedFile>): {
  chartXml: string;
  chartPath: string;
  styleXml?: string;
  stylePath?: string;
  colorsXml?: string;
  colorsPath?: string;
  chartRelsXml: string;
  chartRelsPath: string;
} {
  const chartPath = [...entries.keys()].find(name => /^xl\/charts\/chart\d+[.]xml$/.test(name));
  if (!chartPath) {
    throw new Error("no classic chart found in fixture");
  }
  const stylePath = [...entries.keys()].find(name => /^xl\/charts\/style\d+[.]xml$/.test(name));
  const colorsPath = [...entries.keys()].find(name => /^xl\/charts\/colors\d+[.]xml$/.test(name));
  const chartRelsPath = `xl/charts/_rels/${chartPath.split("/").pop()}.rels`;
  return {
    chartPath,
    chartXml: entryText(entries, chartPath)!,
    stylePath,
    styleXml: stylePath ? entryText(entries, stylePath) : undefined,
    colorsPath,
    colorsXml: colorsPath ? entryText(entries, colorsPath) : undefined,
    chartRelsPath,
    chartRelsXml: entryText(entries, chartRelsPath)!
  };
}

function expectMarkersAndExtLstPreserved(
  fixture: SyntheticFixture,
  before: Map<string, ExtractedFile>,
  after: Map<string, ExtractedFile>
): void {
  const beforeChart = chartParts(before);
  const afterChart = chartParts(after);

  expect(afterChart.chartXml, `${fixture.id} SYNTHETIC marker`).toContain("SYNTHETIC-FIXTURE");
  expect(afterChart.chartXml, `${fixture.id} extLst uri`).toContain(
    "{synthetic-roundtrip-fixture}"
  );
  expect(afterChart.chartXml, `${fixture.id} extLst child`).toContain("c15:foo");
  expect(afterChart.chartXml, `${fixture.id} extLst val`).toContain('val="42"');

  // Style + colors sidecars must round-trip byte-identical (raw passthrough).
  if (beforeChart.stylePath) {
    expect(afterChart.stylePath, `${fixture.id} style sidecar present`).toBe(beforeChart.stylePath);
    expect(
      bytesEqual(before.get(beforeChart.stylePath)!.data, after.get(beforeChart.stylePath)!.data),
      `${fixture.id} style sidecar byte-identical`
    ).toBe(true);
  }
  if (beforeChart.colorsPath) {
    expect(afterChart.colorsPath, `${fixture.id} colors sidecar present`).toBe(
      beforeChart.colorsPath
    );
    expect(
      bytesEqual(before.get(beforeChart.colorsPath)!.data, after.get(beforeChart.colorsPath)!.data),
      `${fixture.id} colors sidecar byte-identical`
    ).toBe(true);
  }

  // chart rels must still reference style + colors sidecars.
  expect(afterChart.chartRelsXml, `${fixture.id} chart rels chartStyle`).toContain("chartStyle");
  expect(afterChart.chartRelsXml, `${fixture.id} chart rels chartColorStyle`).toContain(
    "chartColorStyle"
  );

  // drawing rels still target the chart.
  const drawingRels = entryText(after, "xl/drawings/_rels/drawing1.xml.rels");
  expect(drawingRels, `${fixture.id} drawing rels`).toBeDefined();
  expect(drawingRels!).toMatch(/charts\/chart\d+\.xml/);
}

describe("Chart mutation round-trip", () => {
  describe("classic charts", () => {
    let firstFixture: SyntheticFixture;

    it("setting chart.title preserves vendor extLst, marker, sidecars, and rels", async () => {
      const fixtures = classicFixtures;
      // Pick a fixture with axes + sidecars (skip pie/doughnut variants).
      firstFixture = fixtures.find(f => f.id === "classic-barClustered")!;
      expect(firstFixture, "classic-barClustered fixture").toBeDefined();

      const { before, after } = await loadRoundTripDiff(firstFixture.bytes, wb => {
        const charts = getCharts(Workbook.getWorksheet(wb, "Data")!);
        expect(charts.length).toBeGreaterThan(0);
        Chart.setTitle(charts[0], "Mutated Title via Round-Trip");
      });

      expectMarkersAndExtLstPreserved(firstFixture, before, after);
      const after1 = chartParts(after);
      expect(after1.chartXml, "title text").toContain("Mutated Title via Round-Trip");
    });

    it("structured chart.mutate() preserves passthrough across every classic preset with sidecars", async () => {
      const fixtures = classicFixtures.filter(f => !/-(pie|pie3D|doughnut|ofPie)$/.test(f.id));
      expect(fixtures.length).toBeGreaterThan(8);
      for (const fixture of fixtures) {
        const { before, after } = await loadRoundTripDiff(fixture.bytes, wb => {
          const charts = getCharts(Workbook.getWorksheet(wb, "Data")!);
          if (charts.length === 0) {
            return;
          }
          const chart = charts[0];
          if (!Chart.chartModel(chart)) {
            return;
          }
          Chart.mutate(chart, model => {
            // Toggle a benign field that re-renders the structured chart
            // XML without mutating sidecar parts.
            model.chart.autoTitleDeleted = false;
          });
        });
        expectMarkersAndExtLstPreserved(fixture, before, after);
      }
    });

    it("preferRawPatch mutate path also preserves vendor extLst", async () => {
      const fixtures = classicFixtures;
      const fixture = fixtures.find(f => f.id === "classic-line")!;
      const { before, after } = await loadRoundTripDiff(fixture.bytes, wb => {
        const chart = getCharts(Workbook.getWorksheet(wb, "Data")!)[0];
        Chart.mutate(
          chart,
          model => {
            model.chart.autoTitleDeleted = false;
          },
          { preferRawPatch: true }
        );
      });
      expectMarkersAndExtLstPreserved(fixture, before, after);
    });

    it("repeated load → write cycles never drop the marker or extLst", async () => {
      const fixtures = classicFixtures;
      const fixture = fixtures.find(f => f.id === "classic-barClustered")!;
      let bytes = fixture.bytes;
      for (let i = 0; i < 3; i++) {
        const wb = Workbook.create();
        await Workbook.read(wb, bytes);
        // Touch title each pass so structured renderer must run.
        const chart = getCharts(Workbook.getWorksheet(wb, "Data")!)[0];
        Chart.setTitle(chart, `Pass ${i + 1}`);
        bytes = new Uint8Array(await Workbook.toBuffer(wb));
        await expectValidXlsx(bytes, { label: `pass ${i + 1}` });
        const entries = await extractAll(bytes);
        const xml = chartParts(entries).chartXml;
        expect(xml, `pass ${i + 1} marker`).toContain("SYNTHETIC-FIXTURE");
        expect(xml, `pass ${i + 1} extLst`).toContain("{synthetic-roundtrip-fixture}");
        expect(xml, `pass ${i + 1} title`).toContain(`Pass ${i + 1}`);
      }
    });
  });

  describe("ChartEx", () => {
    it("mutateChartEx() preserves the SYNTHETIC marker comment on every layoutId", async () => {
      const fixtures = chartExFixtures;
      for (const fixture of fixtures) {
        const wb = Workbook.create();
        await Workbook.read(wb, fixture.bytes);
        const charts = getCharts(Workbook.getWorksheet(wb, "Data")!);
        expect(charts.length, fixture.id).toBeGreaterThanOrEqual(1);
        const chart = charts[0];
        if (!Chart.chartExModel(chart)) {
          continue;
        }
        Chart.mutateChartEx(chart, model => {
          // Mutating any structured field invalidates rawXml so the writer
          // must round-trip via the structured renderer; this is the path
          // most likely to drop the marker if the renderer regresses.
          // Toggle a benign optional flag rather than `title.text`
          // (which is a ChartRichText, not a string).
          const title = model.chartSpace.chart.title;
          if (title) {
            title.overlay = !title.overlay;
          } else {
            model.chartSpace.chart.autoTitleDeleted = false;
          }
        });
        const afterBytes = new Uint8Array(await Workbook.toBuffer(wb));
        await expectValidXlsx(afterBytes, { label: fixture.id });
        const after = await extractAll(afterBytes);
        const chartExPath = [...after.keys()].find(name =>
          /^xl\/charts\/chartEx\d+[.]xml$/.test(name)
        );
        expect(chartExPath, fixture.id).toBeDefined();
        const xml = entryText(after, chartExPath!)!;
        // synthetic-fixtures decorates every ChartEx fixture with both
        // a SYNTHETIC marker comment AND a `cx:extLst` vendor
        // extension on `cx:chartSpace`. Both must survive structured
        // mutate → re-render — the marker via the leading-comment
        // splice in the writer, the extLst via `chartSpace.extLst`
        // raw passthrough in the ChartEx renderer.
        expect(xml, `${fixture.id} marker preserved`).toContain("SYNTHETIC-FIXTURE");
        expect(xml, `${fixture.id} cx:extLst uri preserved`).toContain(
          "{synthetic-cx-roundtrip-fixture}"
        );
        expect(xml, `${fixture.id} cx15:foo preserved`).toContain("cx15:foo");
      }
    });
  });

  describe("LibreOffice open-validation on mutated workbooks (auto)", () => {
    it("a structurally-mutated classic chart workbook opens cleanly in LibreOffice", async () => {
      const fixture = classicFixtures.find(f => f.id === "classic-barClustered")!;
      const wb = Workbook.create();
      await Workbook.read(wb, fixture.bytes);
      const chart = getCharts(Workbook.getWorksheet(wb, "Data")!)[0];
      Chart.setTitle(chart, "LO-mutated title");
      const out = new Uint8Array(await Workbook.toBuffer(wb));
      await expectValidXlsx(out, { label: "mutated-classic-LO" });
      const result = await runLibreOfficeOpenValidationAuto(out, "mutated-classic.xlsx");
      if (!result.available) {
        expect(result.skipped).toBeTruthy();
        return;
      }
      expect(result.exitCode, result.stderr ?? "").toBe(0);
      expect(result.outputs.length).toBeGreaterThan(0);
      // A LibreOffice process start costs seconds on its own, and the default 30 s is spent before the conversion
      // begins when the suite runs alongside the rest of the tree.
    }, 600_000);

    it("a structurally-mutated ChartEx workbook opens cleanly in LibreOffice", async () => {
      // Pick the first ChartEx fixture that produces a structured model
      // (not all layoutIds populate `chartExModel`).
      let mutated: Uint8Array | undefined;
      let pickedId: string | undefined;
      for (const fixture of chartExFixtures) {
        const wb = Workbook.create();
        await Workbook.read(wb, fixture.bytes);
        const chart = getCharts(Workbook.getWorksheet(wb, "Data")!)[0];
        if (!Chart.chartExModel(chart)) {
          continue;
        }
        Chart.mutateChartEx(chart, model => {
          const title = model.chartSpace.chart.title;
          if (title) {
            title.overlay = !title.overlay;
          } else {
            model.chartSpace.chart.autoTitleDeleted = false;
          }
        });
        mutated = new Uint8Array(await Workbook.toBuffer(wb));
        await expectValidXlsx(mutated, { label: `mutated-chartEx-${fixture.id}` });
        pickedId = fixture.id;
        break;
      }
      expect(mutated, "no ChartEx fixture with structured model").toBeDefined();
      const result = await runLibreOfficeOpenValidationAuto(mutated!, `mutated-${pickedId}.xlsx`);
      if (!result.available) {
        expect(result.skipped).toBeTruthy();
        return;
      }
      expect(result.exitCode, result.stderr ?? "").toBe(0);
      expect(result.outputs.length).toBeGreaterThan(0);
      // A LibreOffice process start costs seconds on its own, and the default 30 s is spent before the conversion
      // begins when the suite runs alongside the rest of the tree.
    }, 600_000);
  });
});
