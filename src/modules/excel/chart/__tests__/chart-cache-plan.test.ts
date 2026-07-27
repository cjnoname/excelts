import { captureChartDataSnapshot, fillChartCaches } from "@excel/chart/bridge/excel-chart-host";
import {
  applyChartCachePlan,
  applyChartExCachePlan,
  buildChartCachePlan,
  buildChartExCachePlan,
  buildChartCachePlanForReferences
} from "@excel/chart/build/cache-populator";
import { buildChartModel } from "@excel/chart/build/chart-builder";
import { buildChartExModel } from "@excel/chart/build/chart-ex-builder";
import type { ChartModel, NumberReference, StringReference } from "@excel/chart/model/types";
import { Cell, Chart, Workbook } from "@excel/index";
import { describe, expect, it } from "vitest";

function createFixture(): {
  model: ChartModel;
  workbook: ReturnType<typeof Workbook.create>;
  worksheet: ReturnType<typeof Workbook.addWorksheet>;
} {
  const workbook = Workbook.create();
  const worksheet = Workbook.addWorksheet(workbook, "Data");
  Cell.setValue(worksheet, "A1", "Q1");
  Cell.setValue(worksheet, "A2", "Q2");
  Cell.setValue(worksheet, "B1", 10);
  Cell.setValue(worksheet, "B2", 20);
  const model = buildChartModel({
    type: "line",
    series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
  });
  return { model, workbook, worksheet };
}

describe("chart cache planning", () => {
  it("is pure and deterministic", () => {
    const { model, workbook, worksheet } = createFixture();
    const snapshot = captureChartDataSnapshot(workbook, worksheet);
    const before = structuredClone(model);

    const first = buildChartCachePlan(model, snapshot);
    const second = buildChartCachePlan(model, snapshot);

    expect(model).toEqual(before);
    expect(first).toEqual(second);
    expect(first.writes.length).toBeGreaterThan(0);
  });

  it("uses captured values even if the live workbook changes later", () => {
    const { model, workbook, worksheet } = createFixture();
    const snapshot = captureChartDataSnapshot(workbook, worksheet);
    Cell.setValue(worksheet, "B1", 999);

    applyChartCachePlan(buildChartCachePlan(model, snapshot));

    const series = model.chart!.plotArea!.chartTypes[0].series[0] as {
      val?: { numRef?: NumberReference };
    };
    expect(series.val?.numRef?.cache?.points).toEqual([
      { index: 0, value: 10 },
      { index: 1, value: 20 }
    ]);
  });

  it("does not alias mutable Date values from the workbook", () => {
    const workbook = Workbook.create();
    const worksheet = Workbook.addWorksheet(workbook, "Data");
    const date = new Date(Date.UTC(2024, 0, 1));
    Cell.setValue(worksheet, "A1", date);

    const snapshot = captureChartDataSnapshot(workbook, worksheet);
    date.setUTCFullYear(2030);

    const captured = snapshot.worksheetsByName.get("data")?.cells.get("1:1");
    expect(captured).toBeInstanceOf(Date);
    expect((captured as Date).getUTCFullYear()).toBe(2024);
  });

  it("does not alias Date values stored as formula results", () => {
    const workbook = Workbook.create();
    const worksheet = Workbook.addWorksheet(workbook, "Data");
    const date = new Date(Date.UTC(2024, 0, 1));
    Cell.setValue(worksheet, "A1", { formula: "TODAY()", result: date });

    const snapshot = captureChartDataSnapshot(workbook, worksheet);
    date.setUTCFullYear(2030);

    const captured = snapshot.worksheetsByName.get("data")?.cells.get("1:1");
    expect((captured as Date).getUTCFullYear()).toBe(2024);
  });

  it("rejects applying a cache plan after the chart structure drifts", () => {
    const { model, workbook, worksheet } = createFixture();
    const plan = buildChartCachePlan(model, captureChartDataSnapshot(workbook, worksheet));
    const target = model.chart!.plotArea!.chartTypes[0].series[0] as {
      val?: { numRef?: NumberReference };
    };
    target.val!.numRef!.formula = "Data!$B$2:$B$2";

    expect(() => applyChartCachePlan(plan)).toThrow("Chart reference changed after cache planning");
  });

  it("validates every cache write before applying any of them", () => {
    const { model, workbook, worksheet } = createFixture();
    const plan = buildChartCachePlan(model, captureChartDataSnapshot(workbook, worksheet));
    const series = model.chart!.plotArea!.chartTypes[0].series[0] as {
      cat?: { strRef?: StringReference };
      val?: { numRef?: NumberReference };
    };
    series.val!.numRef!.formula = "Data!$B$2:$B$2";

    expect(() => applyChartCachePlan(plan)).toThrow("Chart reference changed after cache planning");
    expect(series.cat?.strRef?.cache?.points).toEqual([]);
  });

  it("matches the compatibility fill API without replacing model identity", () => {
    const fixture = createFixture();
    const planned = structuredClone(fixture.model);
    const identity = fixture.model;

    applyChartCachePlan(
      buildChartCachePlan(planned, captureChartDataSnapshot(fixture.workbook, fixture.worksheet))
    );
    fillChartCaches(fixture.model, fixture.workbook, fixture.worksheet);

    expect(fixture.model).toBe(identity);
    expect(fixture.model).toEqual(planned);
  });

  it("plans direct reference caches without mutating the reference", () => {
    const { workbook, worksheet } = createFixture();
    const ref: NumberReference = {
      formula: "Data!$B$1:$B$2",
      cache: { points: [] }
    };
    const before = structuredClone(ref);

    const plan = buildChartCachePlanForReferences(
      { number: ref },
      captureChartDataSnapshot(workbook, worksheet)
    );

    expect(ref).toEqual(before);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].value).toMatchObject({ points: [{ value: 10 }, { value: 20 }] });
  });

  it("preserves an existing direct-reference cache identity", async () => {
    const { workbook, worksheet } = createFixture();
    const cache: NonNullable<NumberReference["cache"]> = { points: [] };
    const ref: NumberReference = { formula: "Data!$B$1:$B$2", cache };
    const { fillNumRef } = await import("@excel/chart/bridge/excel-chart-host");

    fillNumRef(ref, workbook, undefined, worksheet);

    expect(ref.cache).toBe(cache);
    expect(cache.points).toHaveLength(2);
  });

  it("fills skipped ChartEx dimensions for rendering without mutating the skip flag", () => {
    const { workbook, worksheet } = createFixture();
    const model = buildChartExModel({
      type: "treemap",
      categories: "Data!$A$1:$A$2",
      series: [{ values: "Data!$B$1:$B$2" }]
    });
    const dimension = model.chartSpace.chartData.data.find(entry => entry.strDim)?.strDim;
    if (dimension) {
      dimension._skipCache = true;
    }
    expect(dimension?._skipCache).toBe(true);

    const plan = buildChartExCachePlan(model, captureChartDataSnapshot(workbook, worksheet), {
      includeSkippedDimensions: true
    });
    expect(dimension?._skipCache).toBe(true);

    applyChartExCachePlan(plan);
    expect(dimension?._skipCache).toBe(true);
    expect(dimension?.levels?.[0]?.points).toHaveLength(2);
  });
});

describe("chart mutation transactions", () => {
  it("does not partially mutate a classic chart when the callback throws", () => {
    const workbook = Workbook.create();
    const worksheet = Workbook.addWorksheet(workbook, "S");
    const number = Chart.add(
      worksheet,
      { type: "line", series: [{ values: "S!$A$1:$A$2" }] },
      "C1:H12"
    );
    const chart = Chart.get(worksheet).find(item => item.chartNumber === number)!;
    const model = Chart.chartModel(chart)!;
    const before = structuredClone(model);

    expect(() =>
      Chart.mutate(chart, draft => {
        draft.style = 12;
        throw new Error("injected mutation failure");
      })
    ).toThrow("injected mutation failure");

    expect(Chart.chartModel(chart)).toBe(model);
    expect(model).toEqual(before);
  });

  it("does not partially mutate ChartEx when the callback throws", () => {
    const workbook = Workbook.create();
    const worksheet = Workbook.addWorksheet(workbook, "S");
    const number = Chart.addEx(
      worksheet,
      { type: "funnel", series: [{ values: "S!$A$1:$A$2" }] },
      "C1:H12"
    );
    const chart = Chart.get(worksheet).find(item => item.chartExNumber === number)!;
    const model = Chart.chartExModel(chart)!;
    const before = structuredClone(model);

    expect(() =>
      Chart.mutateChartEx(chart, draft => {
        draft.rawXml = undefined;
        throw new Error("injected mutation failure");
      })
    ).toThrow("injected mutation failure");

    expect(Chart.chartExModel(chart)).toBe(model);
    expect(model).toEqual(before);
  });

  it("does not commit an invalid ChartEx draft that fails post-callback processing", () => {
    const workbook = Workbook.create();
    const worksheet = Workbook.addWorksheet(workbook, "S");
    const number = Chart.addEx(
      worksheet,
      { type: "funnel", series: [{ values: "S!$A$1:$A$2" }] },
      "C1:H12"
    );
    const chart = Chart.get(worksheet).find(item => item.chartExNumber === number)!;
    const model = Chart.chartExModel(chart)!;
    const before = structuredClone(model);

    expect(() =>
      Chart.mutateChartEx(chart, draft => {
        draft.chartSpace = undefined!;
      })
    ).toThrow("produced an invalid model");
    expect(model).toEqual(before);
  });

  it("preserves nested identities for successful classic mutations", () => {
    const workbook = Workbook.create();
    const worksheet = Workbook.addWorksheet(workbook, "S");
    const number = Chart.add(
      worksheet,
      { type: "line", series: [{ values: "S!$A$1:$A$2" }] },
      "C1:H12"
    );
    const chart = Chart.get(worksheet).find(item => item.chartNumber === number)!;
    const model = Chart.chartModel(chart)!;
    const plotArea = model.chart!.plotArea!;
    const series = plotArea.chartTypes[0].series[0];

    Chart.mutate(chart, draft => {
      draft.style = 12;
    });

    expect(model.chart!.plotArea).toBe(plotArea);
    expect(model.chart!.plotArea!.chartTypes[0].series[0]).toBe(series);
  });

  it("does not partially commit an uncloneable classic draft", () => {
    const workbook = Workbook.create();
    const worksheet = Workbook.addWorksheet(workbook, "S");
    const number = Chart.add(
      worksheet,
      { type: "line", series: [{ values: "S!$A$1:$A$2" }] },
      "C1:H12"
    );
    const chart = Chart.get(worksheet).find(item => item.chartNumber === number)!;
    const model = Chart.chartModel(chart)!;

    expect(() =>
      Chart.mutate(chart, draft => {
        draft.style = 12;
        (draft as unknown as { invalid: () => void }).invalid = () => undefined;
      })
    ).toThrow();
    expect(model.style).not.toBe(12);
    expect("invalid" in model).toBe(false);
  });
});
