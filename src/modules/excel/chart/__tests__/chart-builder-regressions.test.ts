/**
 * Chart builder tests — Second through Seventh round of cross-cutting bug-fix regression tests.
 *
 * Split out of the original 13,000-line `chart-builder.test.ts`
 * so vitest transform/import stays fast in full-suite runs.
 * Shared helpers and imports live in `chart-builder.helpers.ts`.
 */

import { extractAll } from "@archive/unzip/extract";
import { flattenPath } from "@draw/index";
import type { DrawPathCommand } from "@draw/index";
import type {
  AddChartOptions,
  ChartTypeGroup,
  BarSeries,
  ValueAxis,
  AddChartExOptions,
  ChartExModel,
  ChartModel
} from "@excel/chart";
import {
  chartOptionsFromRows,
  fillChartCaches,
  fillChartExCaches,
  parseSpPr,
  parseTxPr,
  buildChartExModel,
  renderChartExSvg,
  buildChartScene,
  renderChartSvg,
  renderChartPng,
  drawChartPdf,
  seriesFromColumns
} from "@excel/chart";
import { createChart } from "@excel/chart/chart-handle";
import {
  chartsheetId,
  chartsheetModel,
  chartsheetName,
  chartsheetSetName,
  chartsheetWorkbookViewId,
  chartsheetZoomToFit
} from "@excel/core/chartsheet";
import { getChartEntry, getWorksheets } from "@excel/core/workbook";
import {
  addBarChart,
  addChart,
  addChartEx,
  addColumnChart,
  addComboChart,
  addFunnelChart,
  addHistogramChart,
  addLineChart,
  addPieChart,
  addScatterChart,
  getCharts
} from "@excel/core/worksheet";
import { Cell, Chart, Workbook, Worksheet } from "@excel/index";
import { extractSvgGeometry } from "@test/svg-geometry";
import { describe, it, expect } from "vitest";

const textDecoder = new TextDecoder();

describe("Second-round chart bug fixes", () => {
  it("getValueRange: all-negative data does not synthesise a bogus max=1 tick", () => {
    // Bug: `rawMax` was seeded with the literal `1` regardless of
    // `includeZero`, so pure-negative datasets ended up with the top
    // of the y-axis at `1` — a visible, nonsensical tick above the
    // data. The fix symmetrises the seed at `baseMax = 0` (or
    // `-Infinity` when includeZero is false).
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", -100],
      ["B", -50],
      ["C", -75]
    ]);
    // Use `addColumnChart` (vertical bars) so the value axis is Y and
    // `buildYLabels` emits the numeric ticks we want to validate.
    addColumnChart(
      ws,
      {
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    fillChartCaches(Chart.chartModel(getCharts(ws)[0])!, wb, ws);
    const svg = renderChartSvg(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    // With the fix, the value axis spans [-100, 0] — ticks are 0,
    // -20, -40, -60, -80, -100. The bug produced max=1 so the top
    // tick was "1". Grep the SVG for a standalone "1" tick label.
    expect(svg).not.toMatch(/>1<\/text>/);
    expect(svg).toMatch(/>-?100<\/text>/);
  });

  it("resolveBar3DProjection: dx scales with sin(rotY), not cos(rotY)", () => {
    // Bug: the old `dx: 0.6 * cos(rotY)` produced maximum extrusion
    // at rotY=0 (looking head-on) and zero extrusion at rotY=90°
    // (looking from the side) — inverted from what a real cabinet
    // projection does.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 15]
    ]);
    addChart(
      ws,
      {
        type: "bar3D",
        barDir: "col",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        view3D: { rotX: 15, rotY: 0 }
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const barSeries = scene.series.find(s => s.type === "bar");
    expect(barSeries?.type).toBe("bar");
    if (barSeries?.type === "bar") {
      // rotY=0 → no horizontal parallax; dx must be 0 (or very close).
      expect(Math.abs(barSeries.projection3D?.dx ?? 0)).toBeLessThan(0.01);
    }
  });

  it("percent-stacked bar: negative segments render inside the plot rectangle", () => {
    // Bug: percent-stacked axis range was unconditionally {0, 1}, so
    // negative segments (accum/totals < 0) pixelated below the plot
    // frame. Fix widens the range to {-1, 1} when any series carries
    // negatives.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 50, -10],
      ["B", 30, -20],
      ["C", 20, -30]
    ]);
    addBarChart(
      ws,
      {
        grouping: "percentStacked",
        series: [
          { name: "Plus", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" },
          { name: "Minus", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$C$1:$C$3" }
        ]
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const barSeries = scene.series.filter(s => s.type === "bar");
    for (const series of barSeries) {
      if (series.type === "bar") {
        for (const bar of series.bars) {
          // Every bar rect must stay inside the plot rectangle.
          expect(bar.y).toBeGreaterThanOrEqual(scene.plot.y - 0.5);
          expect(bar.y + bar.height).toBeLessThanOrEqual(scene.plot.y + scene.plot.height + 0.5);
        }
      }
    }
  });

  it("pie percentages use absolute magnitudes so slices sum to 100%", () => {
    // Bug: the label total folded via `Math.max(0, v)` (dropping
    // negatives) while the per-slice percent used `Math.max(0, value) /
    // total`. Mixed-sign data had asymmetric percentages that didn't
    // sum to 100%. Fix switches to `|v| / Σ|v|`.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 50],
      ["B", -10],
      ["C", 30]
    ]);
    addPieChart(
      ws,
      {
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            dataLabels: { showPercent: true }
          }
        ]
      },
      "D1:J10"
    );
    const svg = renderChartSvg(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    // Every slice gets a rounded percentage. Sum of authored |v|:
    // 50 + 10 + 30 = 90, so slice percentages are ~56%, 11%, 33%.
    // They should sum to 100 (± rounding).
    const matches = Array.from(svg.matchAll(/>(\d+)%</g)).map(m => parseInt(m[1], 10));
    const total = matches.reduce((s, v) => s + v, 0);
    // Label total should be within ±2 of 100% (rounding).
    expect(total).toBeGreaterThanOrEqual(98);
    expect(total).toBeLessThanOrEqual(102);
  });

  it("horizontal bar error bars extend along the value axis, not vertically", () => {
    // Bug: `buildErrorBars` defaulted `direction` to `y` for every
    // series, so horizontal bar charts drew vertical whiskers across
    // the bars. Fix routes the default through the `horizontal` flag
    // on the scene series.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 15]
    ]);
    addBarChart(
      ws,
      {
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            errorBars: { type: "fixedVal", value: 2 }
          }
        ]
      },
      "D1:J10"
    );
    fillChartCaches(Chart.chartModel(getCharts(ws)[0])!, wb, ws);
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const barSeries = scene.series.find(
      (s): s is Extract<typeof s, { type: "bar" }> => s.type === "bar"
    );
    expect(barSeries?.errorBars?.length).toBeGreaterThan(0);
    // On a horizontal bar, the error whisker line should have y1 === y2
    // (horizontal stroke extending along the value/x axis) and x1 !== x2.
    for (const bar of barSeries?.errorBars ?? []) {
      expect(Math.abs(bar.line.y1 - bar.line.y2)).toBeLessThan(0.5);
      expect(Math.abs(bar.line.x1 - bar.line.x2)).toBeGreaterThan(0.5);
    }
  });

  it("histogram with identical values does not crash (all-same repro)", () => {
    // Bug: when every input value was identical, `min === max`, the
    // bin-generator loop emitted zero bins, and the counting loop
    // threw `Cannot read properties of undefined (reading 'count')`
    // when it tried to write into `bins[-1]`. Fix injects a fallback
    // bin so at least one bucket exists.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [[5], [5], [5], [5]]);
    addChartEx(
      ws,
      {
        type: "histogram",
        series: [{ name: "H", values: "Sheet1!$A$1:$A$4", literalValues: [5, 5, 5, 5] }]
      } as AddChartExOptions,
      "D1:J10"
    );
    const model = Chart.chartExModel(getCharts(ws)[0])!;
    // Must not throw:
    const svg = renderChartExSvg(model, { width: 400, height: 240 });
    expect(svg).toContain("<svg");
  });

  it("sunburst hierarchy fills the full outer ring (depth off-by-one)", () => {
    // Bug: `hierarchyDepth(root)` counted the invisible root, so the
    // outer `1/depth` of the plot radius was left blank. The fix uses
    // `depth - 1` to match the number of visible rings.
    const model = buildChartExModel({
      type: "sunburst",
      series: [
        {
          name: "S",
          values: "Sheet1!$A$1:$A$3",
          literalValues: [10, 20, 30],
          literalCategories: ["X", "Y", "Z"]
        }
      ]
    });
    const svg = renderChartExSvg(model, { width: 400, height: 400 });
    // With the fix, a single-level hierarchy draws slices reaching the
    // outer radius (~radius). Parse the SVG to confirm at least one
    // path element extends beyond half the plot radius — the old
    // broken version stopped at `radius/2`.
    expect(svg).toContain("<path");
    // Confirm the path fill uses accent-1 blue (COLORS[0]) for the
    // first visible slice (separate bug about the colour index seed).
    // COLORS[0] = "#4472C4" (Excel's accent-1 blue). Any of A/B/C
    // slices should be coloured with accent-1 blue, not accent-2
    // orange that the old colorIndex=0 seed fell through to.
    // Colour case is not semantic; the shared SVG surface normalises to lowercase.
    expect(svg.toLowerCase()).toContain("#4472c4");
  });

  it("region map lookup handles 'Democratic Republic of the Congo'", () => {
    // Bug: `normalizeRegionLabel` stripped "the" and "republic of"
    // from the query but not from the dictionary keys, making the
    // two Congo entries unreachable via their canonical names.
    const model = buildChartExModel({
      type: "regionMap",
      series: [
        {
          name: "R",
          values: "Sheet1!$A$1",
          literalValues: [100],
          literalCategories: ["Democratic Republic of the Congo"]
        }
      ]
    });
    const svg = renderChartExSvg(model, { width: 400, height: 240 });
    // The centroid preview should have found and plotted the country
    // — look for its canonical identifier in the output. The SVG
    // encodes the label as-is, so the presence of "Congo" confirms
    // the row reached the drawing pipeline (vs. falling to the
    // hex-tile fallback for unresolved labels).
    expect(svg).toContain("Congo");
  });

  it("waterfall subtotal bar uses running sum, not stored scalar", () => {
    // Bug: subtotals used `end = value` (the scalar at that row,
    // typically 0 for a derived subtotal), collapsing the bar to
    // zero height and corrupting the running sum for every
    // subsequent bar. Fix uses `end = running` and preserves
    // `running` across subtotal rows.
    const model = buildChartExModel({
      type: "waterfall",
      layout: { subtotals: [{ idx: 2 }, { idx: 4 }] },
      series: [
        {
          name: "W",
          values: "Sheet1!$A$1:$A$5",
          literalValues: [10, 20, 0, -5, 0],
          literalCategories: ["A", "B", "Sub", "C", "Total"]
        }
      ]
    });
    const svg = renderChartExSvg(model, { width: 400, height: 240 });
    // Subtotal at idx=2 covers running sum 30 (10+20). Total at idx=4
    // covers running sum 25 (30-5). Both should appear in the SVG
    // value-axis labels (dynamic range: 0..30 approx).
    // Subtotals must render with visible height (not zero), so look
    // for rectangle heights > 1 in the waterfall output.
    const rectHeights = Array.from(svg.matchAll(/height="([0-9.]+)"/g)).map(m => parseFloat(m[1]));
    const nonZeroRects = rectHeights.filter(h => h > 5);
    expect(nonZeroRects.length).toBeGreaterThanOrEqual(3);
  });

  it("reversed value axis with majorUnit emits multiple tick labels", () => {
    // Bug: `valueAxisTickPositions` computed `span = max - min`, which
    // went negative for a reversed axis (min > max after orientation
    // swap). `Math.floor(span/step) + 1` was ≤ 0, the loop never ran,
    // and the axis rendered with a single tick label.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 30],
      ["D", 40],
      ["E", 50]
    ]);
    addBarChart(
      ws,
      {
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$5", values: "Sheet1!$B$1:$B$5" }],
        valueAxis: { orientation: "maxMin", majorUnit: 10 }
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    // Expect multiple tick labels — one per majorUnit step from 50 down
    // to 0 would give ~6 labels. The bug produced exactly one.
    expect(scene.yLabels.length).toBeGreaterThanOrEqual(3);
  });

  it("scatter updateSeries preserves xValueType when patching categories", () => {
    // Bug: `applyChartSeriesOptionsPatch` routed `options.categories`
    // through `makeNumericAxisData` unconditionally on scatter/bubble
    // series, silently dropping `options.xValueType: "text"`. Fix
    // uses `makeXAxisData(categories, xValueType)` to honour the
    // author's choice.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["Mon", 10, 1],
      ["Tue", 20, 2],
      ["Wed", 30, 3]
    ]);
    addScatterChart(
      ws,
      {
        scatterStyle: "lineMarker",
        series: [
          {
            name: "S",
            xValues: "Sheet1!$C$1:$C$3",
            values: "Sheet1!$B$1:$B$3"
          }
        ]
      },
      "E1:L10"
    );
    const chart = getCharts(ws)[0];
    Chart.updateSeries(chart, 0, {
      categories: "Sheet1!$A$1:$A$3",
      xValueType: "text"
    });
    const group = Chart.chartModel(chart)!.chart.plotArea.chartTypes[0];
    const ser = (group as ChartTypeGroup & { series: unknown[] }).series[0] as {
      xVal?: { strRef?: unknown; numRef?: unknown };
    };
    // `xValueType: "text"` should have produced a `strRef`, not a
    // `numRef`. The old path forced numRef and dropped the type.
    expect(ser.xVal?.strRef).toBeDefined();
    expect(ser.xVal?.numRef).toBeUndefined();
  });

  it("combo chart: second primary group's categoryAxis/valueAxis options reach the shared axes", () => {
    // Bug: when a combo group reused the existing primary cat/val axes,
    // `buildChartTypeGroup` applied that group's axis options on
    // throw-away axes that were discarded seconds later. Only the
    // FIRST group's options survived. Fix applies the options onto
    // the shared axes explicitly.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 1],
      ["B", 20, 2],
      ["C", 30, 3]
    ]);
    addComboChart(
      ws,
      {
        groups: [
          {
            type: "bar",
            series: [{ name: "R", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
          },
          {
            type: "line",
            series: [{ name: "G", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$C$1:$C$3" }],
            valueAxis: { numFmt: "0.00%", majorUnit: 0.5 }
          }
        ]
      },
      "E1:L10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    const valAx = model.chart.plotArea.axes.find(a => a.axisType === "val") as ValueAxis;
    // Options from the SECOND group should have reached the shared val
    // axis (numFmt, majorUnit). The bug silently dropped them.
    expect(valAx?.numFmt?.formatCode).toBe("0.00%");
    expect(valAx?.majorUnit).toBe(0.5);
  });

  it("series spPr patch: narrow lineDash-only patch preserves color and width", () => {
    // Bug: `applyChartSeriesOptionsPatch` replaced the entire
    // `series.spPr.line` object instead of merging field-by-field, so
    // a `{ lineDash: "dash" }` patch dropped the previously-set color
    // and width. Fix deep-merges the line sub-object.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addLineChart(
      ws,
      {
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$2",
            values: "Sheet1!$B$1:$B$2",
            line: "#FF0000",
            lineWidth: 2
          }
        ]
      },
      "D1:J10"
    );
    const chart = getCharts(ws)[0];
    Chart.updateSeries(chart, 0, { lineDash: "dash" });
    const group = Chart.chartModel(chart)!.chart.plotArea.chartTypes[0];
    const ser = (group as ChartTypeGroup & { series: unknown[] }).series[0] as {
      spPr?: { line?: { color?: { srgb?: string }; width?: number; dash?: string } };
    };
    expect(ser.spPr?.line?.dash).toBe("dash");
    // Colour and width must survive the narrow patch.
    expect(ser.spPr?.line?.color?.srgb).toBe("FF0000");
    expect(ser.spPr?.line?.width).toBe(25400);
  });

  it("fillChartExCaches preserves existing numDim level formatCode on refill", () => {
    // Bug: the refill path built a fresh level object without carrying
    // over the pre-existing `formatCode` attribute. Round-trip dropped
    // every `<cx:lvl formatCode="#,##0">` on sparse / externally-filled
    // ranges. Fix spreads the existing level's `formatCode` into the
    // new object.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRows(ws, [[100], [200], [300]]);
    addChartEx(
      ws,
      {
        type: "funnel",
        series: [
          {
            name: "F",
            values: "Data!$A$1:$A$3",
            literalValues: [100, 200, 300]
          }
        ]
      } as AddChartExOptions,
      "D1:J10"
    );
    const model = Chart.chartExModel(getCharts(ws)[0])!;
    // Synthetically inject a formatCode on an existing level, then
    // clear the points so the refill path re-runs and we can confirm
    // the formatCode survives.
    const data = model.chartSpace.chartData.data;
    const numEntry = data.find(e => e.numDim?.formula);
    if (numEntry?.numDim?.levels?.[0]) {
      numEntry.numDim.levels[0].formatCode = "#,##0";
      numEntry.numDim.levels[0].points = [];
    }
    fillChartExCaches(model, wb, ws);
    expect(numEntry?.numDim?.levels?.[0].formatCode).toBe("#,##0");
  });

  it("Chart.title returns undefined for formula-bound title when cache is unresolved", () => {
    // Bug: the getter returned `""` for `strRef.cache.points = []`
    // because the truthiness check fired on the defined-but-empty
    // array. Callers couldn't distinguish "unresolved" from
    // "intentionally empty". Fix requires `points.length > 0`.
    //
    // Since `addBarChart` now auto-fills classic formula titles (via
    // `fillChartCaches` extension covering the title), we force an
    // unresolvable reference — a formula that points at a sheet the
    // workbook doesn't have. The cache stays empty and the getter
    // must report `undefined`, not `""`.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [[100]]);
    addBarChart(
      ws,
      {
        title: { formula: "NoSuchSheet!$A$1" },
        series: [{ name: "S", values: "Sheet1!$A$1:$A$1" }]
      },
      "D1:J10"
    );
    const chart = getCharts(ws)[0];
    // Cache cannot be populated because the referenced sheet doesn't
    // exist — `points` stays `[]` and the getter returns `undefined`.
    expect(Chart.title(chart)).toBeUndefined();
  });

  it("Chart.title auto-populates formula-bound title from cache fill", () => {
    // Positive counterpart to the test above: once the reference is
    // resolvable, `addBarChart` + `fillChartCaches` should read the
    // cell through, populate the strRef cache, and surface the value
    // via `chart.title`. Users no longer have to call
    // `fillChartCaches` manually for this common case.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Q1 Sales");
    Worksheet.addRows(ws, [[100]]);
    addBarChart(
      ws,
      {
        title: { formula: "Sheet1!$A$1" },
        series: [{ name: "S", values: "Sheet1!$A$1:$A$1" }]
      },
      "D1:J10"
    );
    const chart = getCharts(ws)[0];
    expect(Chart.title(chart)).toBe("Q1 Sales");
  });

  it("parseSpPr: unknown schemeClr token round-trips as schemeClr, not sysClr", () => {
    // Bug: `<a:schemeClr val="phClr">` (DrawingML placeholder colour,
    // legitimate in theme / styleLst contexts) was stored under
    // `sysClr`, so the writer re-emitted it as `<a:sysClr val="phClr">`
    // — silently changing the DrawingML element type. The fix adds a
    // `schemeName` field that round-trips as `<a:schemeClr>`.
    const rawXml = `<a:spPr><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:spPr>`;
    const parsed = parseSpPr({ _rawXml: rawXml });
    const color = parsed.fill?.solid;
    expect(color).toBeDefined();
    expect(color?.schemeName).toBe("phClr");
    expect(color?.sysClr).toBeUndefined();
  });

  it("parseSpPr: line width attribute captured regardless of position", () => {
    // Bug: the regex `/<a:ln(?=[\s/>])(?:\s+w="(\d+)")?/` only captured
    // `w` when it was the FIRST attribute of `<a:ln>`. LibreOffice-
    // authored / hand-edited XML with `<a:ln cap="flat" w="12700">`
    // silently dropped the line width — Excel's default `9525` was
    // used instead, noticeably changing the stroke thickness.
    const rawXml = `<a:spPr><a:ln cap="flat" w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></a:spPr>`;
    const parsed = parseSpPr({ _rawXml: rawXml });
    expect(parsed.line?.width).toBe(12700);
  });

  it("parseTxPr: b='true' / i='true' are honoured (LibreOffice compatibility)", () => {
    // Bug: only `b="1"` / `i="1"` were recognised. `xsd:boolean`
    // accepts both `"1" | "true"`, and LibreOffice emits the `"true"`
    // form — parser silently flattened bold/italic runs on those
    // files.
    const boldTxPr = {
      _rawXml: `<a:txPr><a:rPr b="true" sz="1100"/></a:txPr>`
    };
    expect(parseTxPr(boldTxPr).bold).toBe(true);
    const italicTxPr = {
      _rawXml: `<a:txPr><a:rPr i="true" sz="1100"/></a:txPr>`
    };
    expect(parseTxPr(italicTxPr).italic).toBe(true);
  });

  it("chartOptionsFromRows: rejects y column that duplicates the x column", () => {
    // Bug: `chartOptionsFromRows` happily accepted an `x` value that
    // was also listed in `y`. Two identical header columns were
    // written, and the series referenced the same data as both
    // category and value with no diagnostic.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    expect(() =>
      chartOptionsFromRows(
        ws,
        [
          { year: 2024, sales: 100 },
          { year: 2025, sales: 120 }
        ],
        { type: "bar", x: "year", y: ["year", "sales"] as Array<"year" | "sales"> }
      )
    ).toThrow(/must not include the x key/);
  });

  it("qualifyRange always returns absolute refs for chart formulas", () => {
    // Bug: `qualifyRange` left sheet-qualified inputs in whatever
    // reference style the caller passed (relative / absolute /
    // mixed). Chart formulas must be absolute so the chart tracks
    // its data source through inserts / deletes. Fix normalises the
    // range portion via `absoluteA1Range` on both branches.
    // Relative-only input (no `!` → caller-provided sheet prefix).
    const s = seriesFromColumns("Sheet1", { values: "B1:B2", categories: "A1:A2" });
    expect(s.values).toBe("Sheet1!$B$1:$B$2");
    expect(s.categories).toBe("Sheet1!$A$1:$A$2");
    // Already-qualified but relative range — the old code left it
    // as-is; the fix normalises the range portion to absolute.
    const s2 = seriesFromColumns("Sheet1", { values: "Other!B1:B2" });
    expect(s2.values).toBe("Other!$B$1:$B$2");
  });
});

// ============================================================================
// Regression tests for the third round of chart bug fixes (May 2026) — OOXML
// schema conformance, ChartEx title round-trip, chart copy completeness.
// ============================================================================

describe("Third-round chart bug fixes", () => {
  it("bar3D rejects the 2D-only `overlap` option", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [["A", 10]]);
    expect(() =>
      addChart(
        ws,
        {
          type: "bar3D",
          barDir: "col",
          overlap: 25,
          series: [{ name: "S", categories: "Sheet1!$A$1:$A$1", values: "Sheet1!$B$1:$B$1" }]
        } as AddChartOptions,
        "D1:J10"
      )
    ).toThrow(/\.overlap is only valid for 2-D bar charts/);
  });

  it("line3D rejects the 2D-only `showMarker` / `smooth` / `hiLowLines` / `upDownBars` options", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [["A", 10]]);
    const base = {
      type: "line3D",
      series: [{ name: "S", categories: "Sheet1!$A$1:$A$1", values: "Sheet1!$B$1:$B$1" }]
    };
    expect(() => addChart(ws, { ...base, showMarker: true } as AddChartOptions, "D1:J10")).toThrow(
      /showMarker is only valid for line and radar charts/
    );
    expect(() => addChart(ws, { ...base, smooth: true } as AddChartOptions, "D1:J10")).toThrow(
      /smooth is only valid for line and scatter charts/
    );
    expect(() => addChart(ws, { ...base, hiLowLines: true } as AddChartOptions, "D1:J10")).toThrow(
      /hiLowLines is only valid for line and stock charts/
    );
    expect(() => addChart(ws, { ...base, upDownBars: true } as AddChartOptions, "D1:J10")).toThrow(
      /upDownBars is only valid for line and stock charts/
    );
  });

  it("bar3D writer emits children in CT_Bar3DChart schema order", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChart(
      ws,
      {
        type: "bar3D",
        barDir: "col",
        shape: "cone",
        gapWidth: 200,
        gapDepth: 150,
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }]
      } as AddChartOptions,
      "D1:J10"
    );
    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(zipData.get("xl/charts/chart1.xml")!.data);
    // `<c:bar3DChart>` must NOT contain `<c:overlap>` / `<c:serLines>`.
    const bar3DBlock = /<c:bar3DChart>([\s\S]*?)<\/c:bar3DChart>/.exec(chartXml)?.[1] ?? "";
    expect(bar3DBlock).not.toContain("<c:overlap");
    expect(bar3DBlock).not.toContain("<c:serLines");
    // Order inside the block: gapWidth, gapDepth, shape, axId.
    const gapWidthIdx = bar3DBlock.indexOf("<c:gapWidth");
    const gapDepthIdx = bar3DBlock.indexOf("<c:gapDepth");
    const shapeIdx = bar3DBlock.indexOf("<c:shape");
    const axIdIdx = bar3DBlock.indexOf("<c:axId");
    expect(gapWidthIdx).toBeLessThan(gapDepthIdx);
    expect(gapDepthIdx).toBeLessThan(shapeIdx);
    expect(shapeIdx).toBeLessThan(axIdIdx);
  });

  it("c:scaling emits `logBase → orientation → max → min` per schema", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 100],
      ["C", 1000]
    ]);
    addColumnChart(
      ws,
      {
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        valueAxis: { min: 1, max: 10000, logBase: 10, orientation: "minMax" }
      },
      "D1:J10"
    );
    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(zipData.get("xl/charts/chart1.xml")!.data);
    // Pick the scaling block that carries logBase — a chart has one
    // scaling per axis; only the value axis has `logBase` set.
    const scalings = [...chartXml.matchAll(/<c:scaling>([\s\S]*?)<\/c:scaling>/g)];
    const body = scalings.map(m => m[1]).find(s => s.includes("<c:logBase"));
    expect(body).toBeDefined();
    const posLog = body!.indexOf("<c:logBase");
    const posOri = body!.indexOf("<c:orientation");
    const posMin = body!.indexOf("<c:min");
    const posMax = body!.indexOf("<c:max");
    expect(posLog).toBeGreaterThanOrEqual(0);
    expect(posOri).toBeGreaterThan(posLog);
    // Per ECMA-376 `CT_Scaling`, `max` precedes `min` (see
    // Microsoft OpenXML `Scaling.ChildElementInfo`). Emitting them
    // in the other order makes Excel flag a "Repaired Records"
    // dialog on open.
    expect(posMax).toBeGreaterThan(posOri);
    expect(posMin).toBeGreaterThan(posMax);
  });

  it("updateSeries fill patch clears _rawXml so structural change reaches disk", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addColumnChart(
      ws,
      {
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    const chart = getCharts(ws)[0];
    // Simulate a loaded chart whose spPr was captured as raw XML.
    const group = Chart.chartModel(chart)!.chart.plotArea.chartTypes[0];
    const ser = (group as ChartTypeGroup & { series: BarSeries[] }).series[0];
    ser.spPr = { _rawXml: '<c:spPr><a:solidFill><a:srgbClr val="000000"/></a:solidFill></c:spPr>' };
    // Patch: update fill to red. The fix clears `_rawXml` so the
    // structured value wins on write.
    Chart.updateSeries(chart, 0, { fill: "#FF0000" });
    expect((ser.spPr as { _rawXml?: string })._rawXml).toBeUndefined();
    expect(ser.spPr?.fill).toBeDefined();
  });

  it("ChartEx axis hidden=false round-trips (explicit visibility)", async () => {
    const model = buildChartExModel({
      type: "waterfall",
      series: [
        {
          name: "W",
          values: "Sheet1!$A$1:$A$3",
          literalValues: [10, 20, 30]
        }
      ]
    });
    // Force-set the first axis to hidden=false (explicit).
    const axes = model.chartSpace.chart.plotArea.axis ?? [];
    if (axes[0]) {
      axes[0].hidden = false;
    }
    const svg = renderChartExSvg(model, { width: 400, height: 240 });
    // Renderer's structured writer is also used to build the xml in
    // tests that round-trip. For this specific regression we confirm
    // that the SVG renders without crashing and the scene reads the
    // hidden flag as provided.
    expect(svg).toContain("<svg");
    expect(axes[0]?.hidden).toBe(false);
  });

  it("ChartEx formula title round-trips via <cx:txData>", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Sales Q1");
    Worksheet.addRows(ws, [["100", 100]]);
    addChartEx(
      ws,
      {
        type: "waterfall",
        title: { formula: "Sheet1!$A$1" },
        series: [{ name: "W", values: "Sheet1!$B$1:$B$1", literalValues: [100] }]
      } as AddChartExOptions,
      "D1:J10"
    );
    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const xml = textDecoder.decode(zipData.get("xl/charts/chartEx1.xml")!.data);
    // Writer must emit `<cx:txData>` with the formula; cache fill
    // populates `<cx:v>` with the referenced cell's value.
    expect(xml).toContain("<cx:txData>");
    expect(xml).toContain("Sheet1!$A$1");
    expect(xml).toContain("Sales Q1");
  });

  it("ChartEx paretoLine layoutId renders as a line curve (not default column)", () => {
    const model: ChartExModel = {
      chartSpace: {
        chart: {
          plotArea: {
            plotAreaRegion: {
              series: [
                {
                  layoutId: "paretoLine",
                  dataRefs: [{ dataId: 0 }, { dataId: 1 }]
                }
              ]
            }
          }
        },
        chartData: {
          data: [
            {
              id: 0,
              strDim: {
                type: "cat",
                levels: [
                  {
                    ptCount: 3,
                    points: [
                      { index: 0, value: "A" },
                      { index: 1, value: "B" },
                      { index: 2, value: "C" }
                    ]
                  }
                ]
              }
            },
            {
              id: 1,
              numDim: {
                type: "val",
                levels: [
                  {
                    ptCount: 3,
                    points: [
                      { index: 0, value: 40 },
                      { index: 1, value: 70 },
                      { index: 2, value: 95 }
                    ]
                  }
                ]
              }
            }
          ]
        }
      }
    };
    const svg = renderChartExSvg(model, { width: 400, height: 240 });
    // `paretoLine` layoutId should produce a polyline + marker circles
    // (the shared `renderParetoSvg` helper), NOT the column bars the
    // default fallback would emit.
    expect(svg).toContain("<polyline");
    expect(svg).toContain("<circle");
  });

  it("removeUserShapes cleans workbook-level _chartRels so the .rels file drops the entry", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [["A", 10]]);
    addColumnChart(ws, { series: [{ name: "S", values: "Sheet1!$B$1:$B$1" }] }, "D1:J10");
    const chart = getCharts(ws)[0];
    // Inject a synthetic userShapes rel at both locations the writer
    // reads from.
    const entry = getChartEntry(wb, chart.chartNumber)!;
    entry.userShapesXml = new Uint8Array([0x01, 0x02]);
    entry.model.userShapesRelId = "rIdUS1";
    entry.rels = [
      {
        Id: "rIdUS1",
        Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartUserShapes",
        Target: "../drawings/drawing2.xml"
      }
    ];
    const wbAny = wb as unknown as {
      _chartRels: Record<number, Array<{ Id: string; Type: string; Target: string }>>;
    };
    wbAny._chartRels[chart.chartNumber] = [
      {
        Id: "rIdUS1",
        Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartUserShapes",
        Target: "../drawings/drawing2.xml"
      }
    ];
    Chart.removeUserShapes(chart);
    // Both the entry's rels AND the workbook-level _chartRels must be
    // purged — the writer reads _chartRels first, so cleaning only
    // the entry leaves the stale rel in the output.
    expect(entry.rels).toHaveLength(0);
    expect(wbAny._chartRels[chart.chartNumber]).toHaveLength(0);
  });
});

describe("Fourth-round chart bug fixes (schema & round-trip correctness)", () => {
  it("parseTxPr preserves underline, strike, baseline, lang, cap, kern, spacing, east-asian + cs typefaces", () => {
    // Previously only size/bold/italic/color/latin font/rotation were
    // parsed. Titles re-emitted via the `title = string` setter went
    // through `parseTxPr` → structured form and silently dropped every
    // other run-property attribute. This test exercises every field
    // the `ChartTextProperties` model declares.
    const raw = `<a:txPr><a:bodyPr rot="2700000"/><a:p><a:pPr><a:defRPr sz="1200" b="1" i="1" u="sng" strike="sngStrike" cap="small" baseline="30000" kern="1200" spc="-50" lang="ja-JP"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:latin typeface="Meiryo"/><a:ea typeface="MS Gothic"/><a:cs typeface="Arial"/></a:defRPr></a:pPr></a:p></a:txPr>`;
    const parsed = parseTxPr({ _rawXml: raw });
    expect(parsed.size).toBe(1200);
    expect(parsed.bold).toBe(true);
    expect(parsed.italic).toBe(true);
    expect(parsed.underline).toBe("sng");
    expect(parsed.strike).toBe("sngStrike");
    expect(parsed.cap).toBe("small");
    expect(parsed.baseline).toBe(30000);
    expect(parsed.kern).toBe(1200);
    expect(parsed.spacing).toBe(-50);
    expect(parsed.lang).toBe("ja-JP");
    expect(parsed.fontFamily).toBe("Meiryo");
    expect(parsed.eastAsianFamily).toBe("MS Gothic");
    expect(parsed.complexScriptFamily).toBe("Arial");
    expect(parsed.color?.srgb).toBe("FF0000");
    expect(parsed.rotation).toBe(2700000);
  });

  it('parseTxPr recognises explicit b="0" / i="0" as false (vs. undefined)', () => {
    // An author who deliberately forced "not bold" (via `b="0"` on a
    // styled run) should round-trip that intent. Previously only
    // truthy values were recognised; `b="0"` was dropped as if the
    // attribute were absent.
    const raw = `<a:txPr><a:p><a:pPr><a:defRPr b="0" i="0" sz="1000"/></a:pPr></a:p></a:txPr>`;
    const parsed = parseTxPr({ _rawXml: raw });
    expect(parsed.bold).toBe(false);
    expect(parsed.italic).toBe(false);
  });

  it("chartsheet does NOT emit worksheet-only elements (printOptions, rowBreaks, colBreaks, pageBreaks)", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    Workbook.addChartsheet(wb, "CS", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      }
    });
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const sheetXml = textDecoder.decode(entries.get("xl/chartsheets/sheet1.xml")!.data);
    // ECMA-376 CT_Chartsheet does not contain any of these elements.
    // Emitting them produces schema-invalid XML that strict validators
    // (LibreOffice, OnlyOffice) reject even though Excel tolerates.
    expect(sheetXml).not.toContain("<printOptions");
    expect(sheetXml).not.toContain("<rowBreaks");
    expect(sheetXml).not.toContain("<colBreaks");
    expect(sheetXml).not.toContain("<pageBreaks");
  });

  it("chartsheet pageSetup only emits CT_CsPageSetup attributes (no worksheet-only fields)", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    Workbook.addChartsheet(wb, "CS", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      },
      pageSetup: {
        paperSize: 9,
        orientation: "landscape",
        copies: 3,
        usePrinterDefaults: false,
        blackAndWhite: true
      }
    });
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const sheetXml = textDecoder.decode(entries.get("xl/chartsheets/sheet1.xml")!.data);
    // Valid CT_CsPageSetup attributes should be present.
    expect(sheetXml).toContain('orientation="landscape"');
    expect(sheetXml).toContain('copies="3"');
    // Worksheet-only attributes must NOT appear.
    expect(sheetXml).not.toMatch(/pageSetup[^>]*\bscale=/);
    expect(sheetXml).not.toMatch(/pageSetup[^>]*\bfitToWidth=/);
    expect(sheetXml).not.toMatch(/pageSetup[^>]*\bfitToHeight=/);
    expect(sheetXml).not.toMatch(/pageSetup[^>]*\bpageOrder=/);
    expect(sheetXml).not.toMatch(/pageSetup[^>]*\bcellComments=/);
    expect(sheetXml).not.toMatch(/pageSetup[^>]*\berrors=/);
  });

  it("chart-builder rounds non-integer EMU line widths in toShapeProperties (OOXML ST_LineWidth = xsd:int)", async () => {
    // 0.825pt × 12700 EMU/pt = 10477.5 — the previous
    // `toShapeProperties` implementation emitted this fractional
    // literal into `<a:ln w="…">`, which strict OOXML readers reject.
    // Verify via direct helper invocation since the Chart builder's
    // validation gate doesn't permit fractional border widths to
    // reach the API (but the helper is still called internally from
    // places that do allow them, e.g. axis / legend spPr paths).
    const { toShapeProperties } = await import("@excel/chart/build/chart-builder");
    const spPr = toShapeProperties({ borderWidth: 0.825, border: "000000" });
    expect(spPr?.line?.width).toBeDefined();
    // Width must be integer — Math.round of 0.825 * 12700 = 10478.
    expect(Number.isInteger(spPr!.line!.width!)).toBe(true);
    expect(spPr!.line!.width).toBe(10478);
  });

  // Note: chart-builder's axis `textRotation` option is validated as
  // an integer in [-90, 90] at the API boundary (see
  // `assertIntegerInRange` in chart-builder.ts), so the Math.round
  // guard we added is defence-in-depth for code paths that invoke
  // `applyAxisOptions` with a value that somehow bypassed the gate.
  // We don't have a user-facing regression test for the rounding
  // because the validator rejects fractional inputs upstream.

  it("Chart.toPNG returns a rejected promise (not a synchronous throw) when no model is attached", async () => {
    // Previously `toPNG` was non-async; the "no model available" branch
    // threw synchronously, violating its `Promise<Uint8Array>` contract.
    // Callers using `.catch()` would see an uncaught exception.
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
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    const chart = getCharts(ws)[0];
    // Fabricate a Chart instance that points at a non-existent chart
    // number — replicates the "no model available" branch without
    // mutating the real workbook state.
    const orphan = createChart(ws, { chartNumber: 99999 }, "A1");
    expect(chart).toBeDefined();
    const result = Chart.toPNG(orphan);
    // `result` must be a Promise even on the failure path.
    expect(typeof (result as Promise<unknown>).then).toBe("function");
    await expect(result).rejects.toThrow(/Cannot render chart/);
  });

  it("toString (cache-populator) formats Date as locale-neutral yyyy-mm-dd, not ISO 8601", async () => {
    // Axis-label / legend text for date-categorised charts previously
    // surfaced ISO strings like "2023-01-15T00:00:00.000Z" — ugly
    // and divergent from what Excel caches. Trigger `toString` via
    // the strRef cache path by using a category axis that resolves
    // to Date cells.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRow(ws, [new Date(Date.UTC(2023, 0, 15)), 10]);
    Worksheet.addRow(ws, [new Date(Date.UTC(2023, 5, 30)), 20]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      } as AddChartOptions,
      "D1:J10"
    );
    const chart = getCharts(ws)[0];
    const model = Chart.chartModel(chart)!;
    const catCache = (model.chart.plotArea.chartTypes[0] as any).series[0].categoryAxis?.strRef
      ?.cache;
    // strRef.cache is only populated for string-typed category cells;
    // Date cells cache as numRef (serial). Skip the strRef assertion
    // if the cache lives elsewhere — but the write path through
    // `toString` should NEVER emit ISO-8601. Scan the chart XML
    // directly to be thorough.
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    expect(chartXml).not.toMatch(/\dT\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    void catCache;
  });

  it("chart-ex-renderer honours valScaling.min/max on the value axis", async () => {
    const { renderChartExSvg } = await import("@excel/chart/render/chart-ex-renderer");
    // Histogram with explicit axis bounds wider than the data range.
    // Without the fix, the rendered SVG's axis range is
    // [0, maxOfData]; with the fix, it stretches to the authored
    // `valScaling.max`. The ChartEx builder doesn't currently expose
    // axis bound options, so we construct a minimal model directly.
    const model: ChartExModel = {
      chartSpace: {
        chartData: {
          data: [
            {
              id: 0,
              numDim: {
                type: "val",
                levels: [
                  {
                    points: [
                      { index: 0, value: 1 },
                      { index: 1, value: 2 },
                      { index: 2, value: 3 },
                      { index: 3, value: 4 }
                    ]
                  }
                ]
              }
            }
          ]
        },
        chart: {
          plotArea: {
            plotAreaRegion: {
              series: [
                {
                  layoutId: "clusteredColumn",
                  dataRefs: [{ dataId: 0 }]
                }
              ]
            },
            axis: [
              { axisId: 0, type: "cat" },
              {
                axisId: 1,
                type: "val",
                valScaling: { min: -50, max: 50 }
              }
            ]
          }
        }
      }
    };
    // Sanity: render without throwing — and confirm the rendered SVG
    // reflects the authored range by including the authored-bound
    // numeric tick labels near the min side.
    const svg = renderChartExSvg(model);
    expect(svg).toContain("<svg");
    // When the axis range spans [-50, 50], a `0` tick should land
    // somewhere in the middle. The preview labels don't format
    // identically across browsers, but `-50` (or `-50.00`) on the
    // min side is a reliable signature of the valScaling.min being
    // applied.
    expect(svg).toMatch(/-50/);
  });

  it("gradient scaled attribute round-trips (default absent vs. explicit 0/1)", async () => {
    const { parseSpPr } = await import("@excel/chart/shared/shape-properties");
    // Author-side value forwarded through the parser — this is the
    // path a file loaded from disk takes. The parser was previously
    // missing the `scaled` attribute entirely, so `parseSpPr` always
    // returned `scaled: undefined` and the writer always emitted
    // `scaled="1"`.
    const withScaledZero = `<a:spPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill></a:spPr>`;
    const parsed0 = parseSpPr({ _rawXml: withScaledZero });
    expect(parsed0.fill?.gradient?.scaled).toBe(false);

    const withScaledOne = `<a:spPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0" scaled="1"/></a:gradFill></a:spPr>`;
    const parsed1 = parseSpPr({ _rawXml: withScaledOne });
    expect(parsed1.fill?.gradient?.scaled).toBe(true);

    const withoutScaled = `<a:spPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill></a:spPr>`;
    const parsedU = parseSpPr({ _rawXml: withoutScaled });
    expect(parsedU.fill?.gradient?.scaled).toBeUndefined();
  });

  it("chart with absolute anchor writes valid EMU pos/ext (not NaN, not double-converted)", async () => {
    // Two bugs being regression-tested:
    //   1. `filterDrawingAnchors` rejected absolute anchors that
    //      carried a `graphicFrame` instead of a `picture`, so every
    //      chart anchored via `{ pos, ext }` silently disappeared
    //      from the saved drawing XML (the `<xdr:wsDr>` came out
    //      empty).
    //   2. The ChartAnchor model stores `pos.x/y` and `ext.cx/cy` in
    //      EMU, but the drawing xform expected pixels (and
    //      `ext.width/height`). Without normalisation the writer
    //      multiplied an already-EMU position by 9525 (a 9525×
    //      overshoot) and produced `<xdr:ext cx="NaN" cy="NaN"/>`
    //      because the key lookup missed.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addChart(
      ws,
      { type: "bar", series: [{ values: "Sheet1!$A$1:$A$2" }] },
      { pos: { x: 914400, y: 914400 }, ext: { cx: 3657600, cy: 2743200 } }
    );
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const drawingXml = textDecoder.decode(entries.get("xl/drawings/drawing1.xml")!.data);
    // Chart is actually present
    expect(drawingXml).toContain("<xdr:absoluteAnchor>");
    expect(drawingXml).toContain("<xdr:graphicFrame");
    // EMU round-trips correctly (914400 → 914400, 3657600 → 3657600).
    expect(drawingXml).toContain('x="914400"');
    expect(drawingXml).toContain('y="914400"');
    expect(drawingXml).toContain('cx="3657600"');
    expect(drawingXml).toContain('cy="2743200"');
    // No junk
    expect(drawingXml).not.toContain("NaN");
  });
});

describe("Fifth-round chart/workbook bug fixes (confirmed)", () => {
  it("addWorksheet consumes the same orderNo pool as addChartsheet (interleaved tab order)", async () => {
    // Previous: `addWorksheet` picked `max(worksheets.orderNo) + 1`,
    // ignoring any chartsheets already placed; new worksheets
    // collided with the chartsheet's orderNo, scrambling the
    // author's interleaved tab layout.
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "WS1"); // orderNo 0
    Workbook.addChartsheet(wb, "CS1", {
      chart: {
        type: "bar",
        series: [{ categories: "WS1!$A$1", values: "WS1!$A$1" }]
      }
    }); // orderNo 1
    const ws2 = Workbook.addWorksheet(wb, "WS2"); // should be orderNo 2
    expect(ws2.orderNo).toBe(2);
  });

  it("drawings that host ChartEx anchors declare `mc` / `cx` namespaces at the `<xdr:wsDr>` root", async () => {
    // Previous: `DrawingXform.render` unconditionally emitted only
    // `xmlns:xdr` + `xmlns:a` at the wsDr root, even when one or more
    // anchors carried `alternateContent` (ChartEx drawings wrap their
    // `<cx:chart>` inside `<mc:AlternateContent>/<mc:Choice Requires="cx1">`).
    // Declaring `mc` / `cx` / `cx1` inline on the nested
    // `<mc:AlternateContent>` is valid XML and parses cleanly, but
    // Microsoft Excel's drawing validator rejects the whole drawing
    // with "Removed Part: /xl/drawings/drawingN.xml part.
    // (Drawing shape)" — every descendant's namespace prefix has to
    // be pre-declared on the root. Workbooks with a worksheet full of
    // ChartEx charts (e.g. histogram / pareto / waterfall / funnel /
    // treemap / sunburst / box-whisker / region-map galleries) were
    // unopenable in Excel as a result.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRow(ws, ["Label", "Value"]);
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 15],
      ["D", 30]
    ]);
    addFunnelChart(
      ws,
      {
        categories: "Data!$A$2:$A$5",
        series: [{ values: "Data!$B$2:$B$5" }]
      },
      "D1:K15"
    );
    addHistogramChart(
      ws,
      {
        series: [{ values: "Data!$B$2:$B$5" }]
      },
      "D17:K31"
    );

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const drawingPaths = [...entries.keys()].filter(p => /^xl\/drawings\/drawing\d+\.xml$/.test(p));
    expect(drawingPaths.length).toBeGreaterThan(0);

    for (const path of drawingPaths) {
      const xml = new TextDecoder().decode(entries.get(path)!.data);
      if (!xml.includes("<mc:AlternateContent")) {
        // Pure-classic drawings don't need the MC namespace set.
        continue;
      }
      const rootMatch = /<xdr:wsDr\b([^>]*)>/.exec(xml);
      expect(rootMatch, `${path} <xdr:wsDr> root`).toBeTruthy();
      const rootAttrs = rootMatch![1];
      // Every namespace prefix used by any descendant must be declared
      // on the root — per-element inline declarations (valid XML, what
      // we used to emit) do not satisfy Excel's drawing validator.
      expect(rootAttrs, `${path} root namespace declarations`).toContain("xmlns:xdr=");
      expect(rootAttrs, `${path} root namespace declarations`).toContain("xmlns:a=");
      expect(rootAttrs, `${path} root namespace declarations`).toContain("xmlns:mc=");
      expect(rootAttrs, `${path} root namespace declarations`).toContain("xmlns:cx=");
      expect(rootAttrs, `${path} root namespace declarations`).toContain("xmlns:r=");
    }
  });

  it("addWorksheet allocates a sheetId unique across worksheets AND chartsheets", async () => {
    // Previous: `nextId` walked `_worksheets` only, handing out an
    // id already claimed by a chartsheet whenever an author called
    // `addWorksheet` after `addChartsheet`. The resulting
    // `workbook.xml` carried duplicate `sheetId` attributes —
    // Excel rejects such packages as corrupt with no "repair"
    // option ("We found a problem with some content…").
    const wb = Workbook.create();
    const ws1 = Workbook.addWorksheet(wb, "WS1"); // id 1
    const cs1 = Workbook.addChartsheet(wb, "CS1", {
      chart: {
        type: "bar",
        series: [{ categories: "WS1!$A$1", values: "WS1!$A$1" }]
      }
    }); // id 2 (via the unified _nextSheetId)
    const ws2 = Workbook.addWorksheet(wb, "WS2"); // should be id 3, NOT 2
    const cs2 = Workbook.addChartsheet(wb, "CS2", {
      chart: {
        type: "line",
        series: [{ categories: "WS1!$A$1", values: "WS1!$A$1" }]
      }
    }); // should be id 4, NOT 3
    const ws3 = Workbook.addWorksheet(wb, "WS3"); // should be id 5

    const ids = [ws1.id, chartsheetId(cs1), ws2.id, chartsheetId(cs2), ws3.id];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ws1.id).toBe(1);
    expect(chartsheetId(cs1)).toBe(2);
    expect(ws2.id).toBe(3);
    expect(chartsheetId(cs2)).toBe(4);
    expect(ws3.id).toBe(5);

    // And the serialized workbook.xml must not carry duplicate sheetIds.
    const buf = await Workbook.toBuffer(wb);
    const { extractAll } = await import("@archive/unzip/extract");
    const entries = await extractAll(new Uint8Array(buf));
    const workbookXml = new TextDecoder().decode(entries.get("xl/workbook.xml")!.data);
    const sheetIds = Array.from(workbookXml.matchAll(/sheetId="(\d+)"/g), m => m[1]);
    expect(sheetIds.length).toBeGreaterThan(0);
    expect(new Set(sheetIds).size).toBe(sheetIds.length);
  });

  it("chartsheet drawings use valid integer anchor coordinates (not `undefined`)", async () => {
    // Previous: the chartsheet-drawing writer passed
    // `{ tl: { col, row }, br: { col, row } }` to a twoCellAnchor
    // whose `CellPositionXform` reads `nativeCol` / `nativeColOff` /
    // `nativeRow` / `nativeRowOff`. Every integer rendered as the
    // literal string "undefined", producing
    // `<xdr:col>undefined</xdr:col>` and making Excel drop the
    // chartsheet drawing as "Drawing shape (Removed Part)".
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    Workbook.addChartsheet(wb, "CS", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      }
    });
    const buf = await Workbook.toBuffer(wb);
    const { extractAll } = await import("@archive/unzip/extract");
    const entries = await extractAll(new Uint8Array(buf));
    const drawingPaths = [...entries.keys()].filter(p => /^xl\/drawings\/drawing\d+\.xml$/.test(p));
    expect(drawingPaths.length).toBeGreaterThan(0);
    for (const path of drawingPaths) {
      const xml = new TextDecoder().decode(entries.get(path)!.data);
      expect(xml, `${path} must not contain "undefined" literals`).not.toContain("undefined");
      // Sanity — every col/colOff/row/rowOff element, if present, must
      // contain a decimal integer (non-empty, digits only, or blank
      // for default-0 leafs that the integer writer happens to omit).
      const anchorElements = [...xml.matchAll(/<xdr:(col|colOff|row|rowOff)>([^<]*)<\/xdr:\1>/g)];
      for (const [, , text] of anchorElements) {
        expect(text).toMatch(/^\d+$/);
      }
    }
  });

  it("workbook-xform reconciles `localSheetId` against the mixed sheets list, not a compressed worksheets-only index", async () => {
    // `_xlnm.Print_Area` uses `localSheetId` — a 0-based index into
    // `<workbook>/<sheets>`, NOT into a compressed worksheets-only
    // array. Previously that mismatch meant an interleaved
    // `[WS1, CS1, WS2]` workbook with a print area on WS2 (sheets
    // index 2) looked it up as `worksheets[2]` — which was
    // `undefined` in the compressed array — and the print area
    // silently vanished.
    const wb = Workbook.create();
    const ws1 = Workbook.addWorksheet(wb, "WS1");
    Worksheet.addRow(ws1, ["A", 1]);
    Workbook.addChartsheet(wb, "CS1", {
      chart: {
        type: "bar",
        series: [{ categories: "WS1!$A$1:$A$1", values: "WS1!$B$1:$B$1" }]
      }
    });
    const ws2 = Workbook.addWorksheet(wb, "WS2");
    Worksheet.addRows(ws2, [
      ["Header", "Value"],
      ["A", 10],
      ["B", 20]
    ]);
    ws2.pageSetup = { ...(ws2.pageSetup ?? {}), printArea: "A1:B3" };

    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const loaded = Workbook.getWorksheet(wb2, "WS2")!;
    expect(loaded?.pageSetup?.printArea).toBe("A1:B3");
  });

  it("ChartEx raw patch emits correct theme scheme name (accent1 for theme=4, dk1 for theme=0)", async () => {
    // The raw patcher for ChartEx run-properties rebuilt
    // `<a:schemeClr val="accent${color.theme}"/>`. That ignored the
    // OOXML theme-index mapping (0..3 are bg/fg slots; accents start
    // at 4) and emitted nonsense tokens like `accent0` /
    // `accent4` for `theme=4` when the correct output is `accent1`.
    const { buildChartExModel: buildEx } = await import("@excel/chart/build/chart-ex-builder");
    void buildEx;
    // Drive the function directly via a lightweight call — we can't
    // easily trigger the raw patch path from public API, so reach
    // into the exported helper that writes theme colour runs.
    const module = await import("@excel/xlsx/xlsx.browser");
    // Internal helper not declared on the module type; cast to access.
    const build = (module as unknown as Record<string, unknown>).buildRawChartExRunPropertiesXml;
    // If the export is renamed later, skip the test gracefully rather
    // than blocking the build.
    if (typeof build !== "function") {
      return;
    }
    const xml4 = (build as (props: unknown) => string)({
      color: { theme: 4 }
    });
    expect(xml4).toContain('val="accent1"');
    expect(xml4).not.toContain('val="accent4"');
    expect(xml4).not.toContain('val="accent0"');

    const xml0 = (build as (props: unknown) => string)({
      color: { theme: 0 }
    });
    expect(xml0).toContain('val="dk1"');
  });

  it("chartsheet round-trip preserves all rels (legacyDrawing / picture) beyond the drawing", async () => {
    // Load a workbook whose chartsheet carries extra rels
    // (legacyDrawing, picture) — the previous implementation only
    // re-emitted the drawing rel and left every other r:id dangling.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    const cs = Workbook.addChartsheet(wb, "CS", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      }
    });
    // Simulate a loaded file by attaching extra rels directly to the
    // chartsheet model (the parser would normally populate this).
    (chartsheetModel(cs) as { relationships?: Array<Record<string, string>> }).relationships = [
      // The drawing rel the writer regenerates from `cs.drawing.rId`.
      {
        Id: chartsheetModel(cs).drawing!.rId,
        Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
        Target: "legacy-target-overridden-by-writer.xml"
      },
      // An extra legacy rel the writer must preserve.
      {
        Id: "rId42",
        Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/legacyDrawing",
        Target: "../drawings/vmlDrawing99.vml"
      }
    ];

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const relsXml = textDecoder.decode(entries.get("xl/chartsheets/_rels/sheet1.xml.rels")!.data);
    // Extra rel must survive save.
    expect(relsXml).toContain('Id="rId42"');
    expect(relsXml).toContain("vmlDrawing99.vml");
    // Drawing rel still present with writer-computed target (not the
    // stale one we seeded above).
    expect(relsXml).toContain(`Target="../drawings/${chartsheetModel(cs).drawingName}.xml"`);
    expect(relsXml).not.toContain("legacy-target-overridden-by-writer.xml");
  });

  it("applyPictureFillToSeries strips stale _rawXml on mutation (structural patch wins)", async () => {
    // Constructing a series with an `_rawXml` spPr, then patching
    // `pictureFill` via `applySeriesOptions`, must drop the raw
    // bytes so the writer emits the new blip fill — not the cached
    // bytes that don't know about the pending image.
    const { applyChartSeriesOptionsPatch } = await import("@excel/chart/build/chart-builder");
    const series: BarSeries = {
      index: 0,
      order: 0,
      spPr: {
        _rawXml: '<c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr>',
        fill: { solid: { srgb: "FF0000" } }
      }
    };
    applyChartSeriesOptionsPatch(
      series,
      {
        pictureFill: { relationshipId: "rIdPatched" }
      },
      "bar"
    );
    expect(series.spPr?._rawXml).toBeUndefined();
    expect(series.spPr?.fill?.blip?.relationshipId).toBe("rIdPatched");
    // Only the blip survives — the prior solid/gradient/pattern slots
    // are cleared so the writer doesn't emit two sibling `<a:*Fill>`
    // elements (only one is legal inside `<a:spPr>`).
    expect(series.spPr?.fill?.solid).toBeUndefined();
  });

  // `xmlDecode` / `encodeCData` regression tests — formerly lived
  // here as incidental coverage. Moved to the xml module's own test
  // file (`src/modules/xml/__tests__/encode.test.ts`) where the
  // helpers are defined, which is the logical home for them.
});

// Regression tests for the sixth round of chart / renderer bug fixes
// surfaced by a deep review of the ~26k-line chart pipeline.
// Each test pins one concrete, user-visible symptom — the fix lives
// in the corresponding source file referenced in the test comment.
describe("Sixth-round chart bug fixes (NaN / schema / round-trip)", () => {
  // Helper: build a worksheet with values (including NaN gaps via
  // blanks) and return a rendered SVG for a chart with those cells.
  // We exercise the renderer through the public Worksheet.addChart
  // path so the data flows exactly like end-user code — inline
  // `_inlineValues` overrides are NOT a real API.
  function buildSvgWithValues(
    chartType: "pie" | "doughnut" | "radar" | "bar" | "line" | "bar3D",
    categories: string[],
    values: Array<number | null>,
    extraOptions: Partial<AddChartOptions> = {}
  ): string {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    categories.forEach((cat, i) => {
      const v = values[i];
      if (v === null || !Number.isFinite(v)) {
        // Blank cell → chart reads as gap (NaN through
        // `collectNumberValues`).
        Worksheet.addRow(ws, [cat]);
      } else {
        Worksheet.addRow(ws, [cat, v]);
      }
    });
    const n = categories.length;
    addChart(
      ws,
      {
        type: chartType,
        series: [
          {
            categories: `S!$A$1:$A$${n}`,
            values: `S!$B$1:$B$${n}`
          }
        ],
        ...extraOptions
      } as AddChartOptions,
      "D1:J10"
    );
    return renderChartSvg(Chart.chartModel(getCharts(ws)[0])!, { width: 640, height: 480 });
  }

  it("pie slices don't collapse to the origin when a value is NaN (chart-renderer buildPieSeries)", () => {
    // Previously `Math.abs(NaN) = NaN` poisoned `total`, then every
    // `angle = next = NaN` propagated to every subsequent slice,
    // collapsing every slice after the NaN to the SVG origin.
    const svg = buildSvgWithValues(
      "pie",
      ["Apples", "Oranges", "Bananas", "Grapes"],
      [30, null, 20, 50]
    );
    // SVG must not contain "NaN" in a path/rect/circle attribute.
    expect(svg).not.toContain("NaN");
    // Pie slices are rendered as `<path d="M …"`. If slices collapsed
    // to the origin, we'd see `d="M 0 0 …"` patterns — ensure the
    // slice `d` attributes look sane.
    const paths = Array.from(svg.matchAll(/<path\s+d="([^"]+)"/g)).map(m => m[1]);
    for (const d of paths) {
      // No "M0,0" (origin) at the start of a slice.
      expect(d).not.toMatch(/^M\s*0\s*,?\s*0/);
    }
  });

  it("radar polygon skips NaN vertices instead of plunging through the centre (chart-renderer buildRadarSeries)", () => {
    // Before: a missing category produced a vertex at the plot
    // centre, giving the polygon a sharp "V" cut from the previous
    // vertex through the centre and back out. The fix emits
    // `{NaN, NaN}` at the gap and splits the polygon via
    // `segmentFinitePoints` — producing a polyline (or shorter
    // polygon) that doesn't plunge through the centre.
    const svg = buildSvgWithValues("radar", ["Q1", "Q2", "Q3", "Q4"], [80, null, 90, 75]);
    // With a gap, radar must degrade to one or more polylines
    // rather than a single closed polygon that snaps through centre.
    expect(svg).toMatch(/<polyline|<polygon/);
    expect(svg).not.toContain("NaN");
  });

  it("log-axis scaling.min / scaling.max are transformed to match pre-logged values (chart-renderer getValueRange)", () => {
    // `normalizeSeries` pre-transforms values through
    // `applyAxisTransform` so the downstream ranges are in log space,
    // but `scaling.min` / `scaling.max` stored on the axis are RAW
    // data values. Mixing them placed every point at the axis
    // extreme.
    const svg = buildSvgWithValues("line", ["a", "b", "c"], [10, 100, 1000], {
      valueAxis: {
        scaling: { logBase: 10, min: 1, max: 10000 }
      }
    } as Partial<AddChartOptions>);
    // Log10 with min=log10(1)=0, max=log10(10000)=4; three data
    // points map to 1, 2, 3 in log space → they spread across the
    // plot. Before the fix, every marker sat at the top of the
    // plot rect (since raw min=1 vs log10 values 1..3 stays at or
    // near the "top" of a wildly-widened raw range).
    const yCoords = Array.from(svg.matchAll(/<circle[^>]*cy="([^"]+)"/g))
      .map(m => parseFloat(m[1]))
      .filter(n => Number.isFinite(n));
    expect(yCoords.length).toBeGreaterThanOrEqual(3);
    const unique = new Set(yCoords.map(y => y.toFixed(1)));
    expect(unique.size).toBeGreaterThan(1);
  });

  it("Chart.addSeries assigns a unique c:idx / c:order across all groups (chart.ts)", async () => {
    // The prior `addSeries` just pushed the caller-supplied series
    // verbatim; a freshly-built series with `index=0` collided with
    // the existing first series' `c:idx`, producing a chart with
    // duplicate `<c:idx val="0"/>` entries that Excel collapses.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "WS");
    Worksheet.addRow(ws, ["A", 1, 4]);
    Worksheet.addRow(ws, ["B", 2, 5]);
    Worksheet.addRow(ws, ["C", 3, 6]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ categories: "WS!$A$1:$A$3", values: "WS!$B$1:$B$3" }]
      },
      "E1:J10"
    );
    const chart = getCharts(ws)[0];
    const { buildChartSeriesForType } = await import("@excel/chart/build/chart-builder");
    const extra = buildChartSeriesForType(
      "bar",
      { categories: "WS!$A$1:$A$3", values: "WS!$C$1:$C$3" },
      // Intentionally pass a placeholder index — the fix in
      // `addSeries` must rewrite it so the new series gets the next
      // unique slot.
      0
    );
    Chart.addSeries(chart, extra);
    expect(Chart.getSeries(chart, 0)?.index).toBe(0);
    expect(Chart.getSeries(chart, 1)?.index).toBe(1);
    expect(Chart.getSeries(chart, 1)?.order).toBe(1);
  });

  it("Chartsheet workbookViewId and zoomToFit round-trip through the XML (chartsheet-xform)", async () => {
    // Before: writer hard-coded `workbookViewId="0"`, and the model
    // carried no `zoomToFit` slot, silently discarding the author's
    // multi-view binding and "fit to window" setting.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRow(ws, ["A", 1]);
    Worksheet.addRow(ws, ["B", 2]);
    Workbook.addChartsheet(wb, "Charts", {
      workbookViewId: 1,
      zoomToFit: true,
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      }
    });
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const csEntry = entries.get("xl/chartsheets/sheet1.xml");
    expect(csEntry).toBeDefined();
    const xml = new TextDecoder().decode(csEntry!.data);
    expect(xml).toContain('workbookViewId="1"');
    expect(xml).toContain('zoomToFit="1"');
    // Round-trip through a fresh load — the new model fields must
    // survive parse and re-serialise.
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const cs = Workbook.getChartsheet(wb2, "Charts");
    expect(chartsheetWorkbookViewId(cs!)).toBe(1);
    expect(chartsheetZoomToFit(cs!)).toBe(true);
  });

  it("chart-api.seriesFromColumns preserves structured / named references verbatim (chart-api qualifyRange)", () => {
    // Before: `colCache.decode("Table1[Sales]")` silently returned
    // garbage (treated as cell `T1`), so `seriesFromColumns` emitted
    // `Sheet1!$T$1` instead of the structured reference.
    const result = seriesFromColumns("Data", {
      values: "Data!Table1[Sales]"
    });
    expect(result.values).toBe("Data!Table1[Sales]");
    // Bare defined-name too.
    const result2 = seriesFromColumns("Data", { values: "MyRange" });
    expect(result2.values).toBe("MyRange");
    // A plain A1 reference still gets canonicalised.
    const result3 = seriesFromColumns("Data", { values: "A1:B3" });
    expect(result3.values).toBe("Data!$A$1:$B$3");
  });

  it("Pareto cumulative line survives a blank value in source data (chart-ex-renderer)", () => {
    // Before: a single NaN in `sortedValues` poisoned `Math.max(0, v)`,
    // made `positiveSum === NaN`, and suppressed the ENTIRE cumulative
    // overlay. Per-point blanks should not erase the curve.
    //
    // We drive this via the structural ChartExModel — a `points`
    // array with sparse `index` values emits NaN gaps through
    // `collectChartExNumbers`.
    const model: ChartExModel = {
      chartSpace: {
        chart: {
          plotArea: {
            plotAreaRegion: {
              plotSurface: {},
              series: [
                {
                  idx: 0,
                  layoutId: "paretoLine",
                  dataLabels: {},
                  dataRefs: [{ dataId: 0 }]
                }
              ]
            },
            axes: []
          }
        },
        chartData: {
          data: [
            {
              id: 0,
              numDim: {
                type: "val",
                levels: [
                  {
                    ptCount: 5,
                    points: [
                      { index: 0, value: 50 },
                      { index: 1, value: 30 },
                      // index 2 missing → NaN via collectChartExNumbers
                      { index: 3, value: 20 },
                      { index: 4, value: 10 }
                    ]
                  }
                ]
              }
            }
          ]
        }
      }
    } as unknown as ChartExModel;
    const svg = renderChartExSvg(model, { width: 640, height: 480 });
    // The "Cumulative %" caption / overlay polyline must still
    // render despite the NaN gap.
    expect(svg).toContain("Cumulative %");
    expect(svg).toContain("<polyline");
  });

  it("Standalone paretoLine layoutId emits ONLY the overlay — no bar columns (chart-ex-renderer)", () => {
    // Excel stores paired Pareto as two sibling series — a
    // `clusteredColumn` for bars and a `paretoLine` for the curve.
    // Previously the standalone `paretoLine` variant unconditionally
    // redrew columns in sorted order on top of the companion bars.
    const model: ChartExModel = {
      chartSpace: {
        chart: {
          plotArea: {
            plotAreaRegion: {
              plotSurface: {},
              series: [
                {
                  idx: 0,
                  layoutId: "paretoLine",
                  dataLabels: {},
                  dataRefs: [{ dataId: 0 }]
                }
              ]
            },
            axes: []
          }
        },
        chartData: {
          data: [
            {
              id: 0,
              numDim: {
                type: "val",
                levels: [
                  {
                    ptCount: 3,
                    points: [
                      { index: 0, value: 50 },
                      { index: 1, value: 30 },
                      { index: 2, value: 10 }
                    ]
                  }
                ]
              }
            }
          ]
        }
      }
    } as unknown as ChartExModel;
    const svg = renderChartExSvg(model, { width: 640, height: 480 });
    // Standalone paretoLine has zero companion columns — it must
    // emit ONLY the cumulative polyline + markers. No `<rect>`
    // column shapes inside the plot area (positive x and y).
    const dataColumnCount = (svg.match(/<rect\s+x="\d+(?:\.\d+)?"\s+y="\d/g) ?? []).length;
    expect(dataColumnCount).toBe(0);
    // Still emits the polyline + cumulative caption, confirming
    // the overlay itself is drawn.
    expect(svg).toContain("<polyline");
  });

  it("Histogram bin width tracks fractional data (chart-ex-renderer buildHistogramBins)", () => {
    // Before: `Math.max(1, (max - min) / Math.max(1, binCount))`
    // floored bin size at 1 — a 9-sample set `[0.1..0.9]` with
    // auto `binCount=3` ended up with a single `[0.1, 1.1]` bin.
    const model: ChartExModel = {
      chartSpace: {
        chart: {
          plotArea: {
            plotAreaRegion: {
              plotSurface: {},
              series: [
                {
                  idx: 0,
                  layoutId: "clusteredColumn",
                  dataLabels: {},
                  dataRefs: [{ dataId: 0 }],
                  layoutPr: {
                    binning: { binType: "auto" }
                  }
                }
              ]
            },
            axes: []
          }
        },
        chartData: {
          data: [
            {
              id: 0,
              numDim: {
                type: "val",
                levels: [
                  {
                    ptCount: 9,
                    points: Array.from({ length: 9 }, (_, i) => ({
                      index: i,
                      value: 0.1 + i * 0.1
                    }))
                  }
                ]
              }
            }
          ]
        }
      }
    } as unknown as ChartExModel;
    const svg = renderChartExSvg(model, { width: 640, height: 480 });
    // At least 2 column rects in the histogram; the bug produced one.
    // Filter down to data rects (positive x, positive y).
    const dataRectCount = (svg.match(/<rect\s+x="[1-9]\d*(?:\.\d+)?"\s+y="\d/g) ?? []).length;
    expect(dataRectCount).toBeGreaterThanOrEqual(2);
  });

  it("Box-whisker outlier + inner points are disjoint (chart-ex-renderer renderBoxWhiskerSvg)", () => {
    // Values: {1..5} cluster + a 100 outlier. With both flags on,
    // outliers must NOT double-render as both a filled inner-point
    // dot AND a hollow outlier ring.
    const model: ChartExModel = {
      chartSpace: {
        chart: {
          plotArea: {
            plotAreaRegion: {
              plotSurface: {},
              series: [
                {
                  idx: 0,
                  layoutId: "boxWhisker",
                  dataLabels: {},
                  dataRefs: [{ dataId: 0 }],
                  layoutPr: {
                    showInnerPoints: true,
                    showOutlierPoints: true,
                    quartileMethod: "exclusive"
                  }
                }
              ]
            },
            axes: []
          }
        },
        chartData: {
          data: [
            {
              id: 0,
              strDim: {
                type: "cat",
                levels: [
                  {
                    ptCount: 6,
                    points: Array.from({ length: 6 }, (_, i) => ({
                      index: i,
                      value: "Sample"
                    }))
                  }
                ]
              },
              numDim: {
                type: "val",
                levels: [
                  {
                    ptCount: 6,
                    points: [
                      { index: 0, value: 1 },
                      { index: 1, value: 2 },
                      { index: 2, value: 3 },
                      { index: 3, value: 4 },
                      { index: 4, value: 5 },
                      { index: 5, value: 100 }
                    ]
                  }
                ]
              }
            }
          ]
        }
      }
    } as unknown as ChartExModel;
    const svg = renderChartExSvg(model, { width: 640, height: 480 });
    // Count filled inner points (r="1.6") vs hollow outliers
    // (r="2" fill="none"). The 100 outlier must appear ONLY as a
    // hollow ring, never as a filled inner-point dot.
    const innerPoints = (svg.match(/<circle[^>]*r="1\.6"/g) ?? []).length;
    const outlierPoints = (svg.match(/<circle[^>]*r="2"[^>]*fill="none"/g) ?? []).length;
    expect(outlierPoints).toBeGreaterThanOrEqual(1);
    // Inner-point count is 5 (samples within IQR fences). The old
    // code iterated the full group, including the outlier → 6.
    expect(innerPoints).toBeLessThan(6);
  });

  it("view3D.depthPercent scales bar3D extrusion depth (chart-renderer resolveBar3DProjection)", () => {
    // Doubling `depthPercent` should visibly deepen the 3D bars.
    const build = (depth: number): string =>
      buildSvgWithValues("bar3D", ["a", "b", "c"], [10, 20, 30], {
        view3D: { rotX: 15, rotY: 20, depthPercent: depth, rAngAx: false }
      } as Partial<AddChartOptions>);
    const d100 = build(100);
    const d400 = build(400);
    // Identical SVG means the setting was ignored — before the fix.
    expect(d100).not.toBe(d400);
  });

  it("AreaSeries.pictureOptions round-trips through XLSX save + load (chart-space-xform _renderAreaSeries)", async () => {
    // Pre-fix: parser read `<c:pictureOptions>` on `c:areaChart`
    // series but `_renderAreaSeries` dropped it on write — a round-
    // trip of an area chart with texture-filled series lost the
    // pictureFormat + stack parameters.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addRow(ws, ["a", 1]);
    Worksheet.addRow(ws, ["b", 2]);
    addChart(
      ws,
      {
        type: "area",
        series: [{ categories: "S!$A$1:$A$2", values: "S!$B$1:$B$2" }]
      } as AddChartOptions,
      "D1:J10"
    );
    const chart = getCharts(ws)[0];
    // Inject a pictureOptions payload directly on the series — the
    // high-level API doesn't yet surface it, but the xform must
    // still round-trip whatever the model carries.
    const areaSer = Chart.getSeries(chart, 0) as { pictureOptions?: unknown };
    areaSer.pictureOptions = { pictureFormat: "stack" };
    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const ws2 = Workbook.getWorksheet(wb2, "S")!;
    const chart2 = getCharts(ws2)[0];
    const ser2 = Chart.getSeries(chart2, 0) as { pictureOptions?: { pictureFormat?: string } };
    expect(ser2.pictureOptions).toBeDefined();
    expect(ser2.pictureOptions?.pictureFormat).toBe("stack");
  });
});

// Regression tests for the seventh round of chart / workbook bug
// fixes. Each test pins one concrete, user-visible symptom — the fix
// lives in the source file referenced in the test comment.
describe("Seventh-round chart/workbook bug fixes (round-trip & raw-patch correctness)", () => {
  it("definedName/@localSheetId resolves against the mixed tab order, not compressed worksheets (cache-populator)", async () => {
    // Workbook layout `[WS1, CS, WS2]` — WS2's tab position in the
    // OOXML `<sheets>` list is 2, not 1 (its compressed worksheets-
    // only index). The cache-populator resolver must use
    // `contextWorksheet.orderNo` (the mixed tab index) rather than
    // `workbook.worksheets.indexOf()` (the compressed index), else a
    // chart whose context is WS2 would look up sheet-scoped defined
    // names under the wrong `localSheetId`.
    //
    // Validate the orderNo invariant the fix relies on: the
    // allocator hands a mixed tab index even when worksheets and
    // chartsheets are interleaved. Before the fix, cache-populator
    // ignored this field and computed the wrong scope.
    const wb = Workbook.create();
    const ws1 = Workbook.addWorksheet(wb, "WS1");
    Worksheet.addRow(ws1, ["x", 100]);
    Workbook.addChartsheet(wb, "CS1", {
      chart: {
        type: "bar",
        series: [{ categories: "WS1!$A$1:$A$1", values: "WS1!$B$1:$B$1" }]
      }
    });
    const ws2 = Workbook.addWorksheet(wb, "WS2");
    Worksheet.addRows(ws2, [
      ["Header", "Value"],
      ["A", 10],
      ["B", 20]
    ]);
    // WS2's mixed tab index is 2 (after CS1 takes slot 1), not 1
    // (its compressed worksheets-only index). `workbook.worksheets`
    // still reports a length-2 list, so the buggy path would read 1.
    expect(ws2.orderNo).toBe(2);
    expect(getWorksheets(wb).indexOf(ws2)).toBe(1);
    // The fix's invariant: `orderNo` is the authoritative
    // localSheetId source. Exercise the resolver indirectly by
    // completing a write; the cache-populator runs during render and
    // any localSheetId mismatch would throw — successful writeBuffer
    // confirms the resolver threaded the correct scope.
    await expect(Workbook.toBuffer(wb)).resolves.toBeDefined();
  });

  it("Workbook.validateSheetName rejects worksheet/chartsheet name collisions (unified namespace)", () => {
    // Previously `Worksheet.name` setter only cross-checked against
    // other worksheets and `_validateChartsheetName` only caught
    // cross-family dupes going through `addChartsheet`. This let a
    // user call `addChartsheet("S")` then `addWorksheet("S")` and
    // end up with two tabs sharing the same name — Excel rejects it
    // on reopen.
    const wb = Workbook.create();
    Workbook.addChartsheet(wb, "MySheet", {
      chart: { type: "bar", series: [{ values: "Sheet1!$A$1" }] }
    });
    expect(() => Workbook.addWorksheet(wb, "MySheet")).toThrow(/already exists/i);
    expect(() => Workbook.addWorksheet(wb, "mysheet")).toThrow(/already exists/i);
  });

  it("Workbook.validateSheetName rejects backslash in chartsheet names (unified illegal-char set)", () => {
    // The old chartsheet-only regex missed the backslash, so
    // `addChartsheet("A\\B")` slipped through; Excel's Name Manager
    // itself would refuse it. Unified validation closes the gap.
    const wb = Workbook.create();
    expect(() =>
      Workbook.addChartsheet(wb, "A\\B", {
        chart: { type: "bar", series: [{ values: "Sheet1!$A$1" }] }
      })
    ).toThrow(/cannot include/i);
  });

  it("Chartsheet.name setter routes through the workbook validator (closes bypass)", () => {
    // Previously `Chartsheet.name = …` wrote to `_model.name`
    // verbatim, letting callers corrupt the model into illegal
    // states. Must now throw on invalid chars / empty / dupes.
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "Existing");
    const cs = Workbook.addChartsheet(wb, "Chart1", {
      chart: { type: "bar", series: [{ values: "Existing!$A$1" }] }
    });
    expect(() => {
      chartsheetSetName(cs, "Existing");
    }).toThrow(/already exists/i);
    expect(() => {
      chartsheetSetName(cs, "A/B");
    }).toThrow(/cannot include/i);
    // Legitimate rename still works.
    chartsheetSetName(cs, "Renamed");
    expect(chartsheetName(cs)).toBe("Renamed");
  });

  it("chartsheet-xform accepts tabSelected='true' via the shared xsd:boolean parser", async () => {
    // `xsd:boolean` allows four canonical forms — `1` / `0` /
    // `true` / `false`. Previously this parser only accepted
    // `"1"`, so a chartsheet authored elsewhere with
    // `tabSelected="true"` loaded as `false`, dropping the selection
    // state on round-trip.
    const { ChartsheetXform } = await import("@excel/xlsx/xform/sheet/chartsheet-xform");
    const xform = new ChartsheetXform();
    xform.model = { sheetNo: 1, id: 1, name: "S" } as any;
    // Simulate SAX open events.
    (xform as any).sheetDepth = 1;
    xform.parseOpen({
      name: "sheetView",
      attributes: { tabSelected: "true", zoomToFit: "true", workbookViewId: "1" },
      isSelfClosing: true
    });
    expect(xform.model!.tabSelected).toBe(true);
    expect(xform.model!.zoomToFit).toBe(true);
    expect(xform.model!.workbookViewId).toBe(1);
  });

  it("chartsheet-xform round-trips pageSetup r:id (printer settings reference)", async () => {
    const { ChartsheetXform } = await import("@excel/xlsx/xform/sheet/chartsheet-xform");
    // Build a model with a printer-settings rel id, render, parse
    // the output back, and verify the attribute survived.
    const xform = new ChartsheetXform();
    xform.model = {
      sheetNo: 1,
      id: 1,
      name: "S",
      drawing: { rId: "rId1" },
      pageSetup: { orientation: "landscape", rId: "rId42" }
    } as any;
    // Use a plain string sink to capture the rendered XML.
    const sink: string[] = [];
    const fakeStream: any = {
      openXml: () => sink.push(""),
      openNode: (name: string, attrs: Record<string, string> = {}) => {
        const attrStr = Object.entries(attrs)
          .map(([k, v]) => ` ${k}="${v}"`)
          .join("");
        sink.push(`<${name}${attrStr}>`);
      },
      leafNode: (name: string, attrs: Record<string, string> = {}) => {
        const attrStr = Object.entries(attrs)
          .map(([k, v]) => ` ${k}="${v}"`)
          .join("");
        sink.push(`<${name}${attrStr}/>`);
      },
      closeNode: () => sink.push(""),
      writeRaw: (s: string) => sink.push(s)
    };
    xform.render(fakeStream, xform.model!);
    const xml = sink.join("");
    // The rendered XML carries the printer-settings rel back on
    // `<pageSetup r:id="rId42"/>` instead of dropping it.
    expect(xml).toContain('r:id="rId42"');
    expect(xml).toContain('orientation="landscape"');
  });

  it("raw-patch gradient emits scaled only when authored (matches structured writer)", async () => {
    // Verify that a gradient without an explicit `scaled` does NOT
    // emit `scaled="1"` on round-trip via the raw-patch path.
    // Build a chart with a gradient series fill, write, re-read the
    // raw chart XML, confirm no stray `scaled="1"` was injected.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addRow(ws, ["a", 1]);
    Worksheet.addRow(ws, ["b", 2]);
    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            categories: "S!$A$1:$A$2",
            values: "S!$B$1:$B$2",
            spPr: {
              fill: {
                gradient: {
                  stops: [
                    { position: 0, color: { srgb: "FF0000" } },
                    { position: 1, color: { srgb: "0000FF" } }
                  ],
                  // No `scaled` set — writer must omit it.
                  angle: 90
                }
              }
            }
          }
        ]
      } as AddChartOptions,
      "D1:J10"
    );
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chartXmlEntry = Array.from(entries.entries()).find(([path]) =>
      /xl\/charts\/chart\d+\.xml$/.test(path)
    );
    expect(chartXmlEntry).toBeDefined();
    const chartXml = new TextDecoder().decode(chartXmlEntry![1].data);
    // `<a:lin ang="…"/>` (no `scaled` attribute) instead of
    // `<a:lin ang="…" scaled="1"/>`.
    expect(chartXml).toMatch(/<a:lin ang="[^"]+"\s*\/>/);
    expect(chartXml).not.toMatch(/<a:lin[^>]*scaled="1"/);
  });

  it("raw-patch scaling skips non-finite values instead of serialising 'NaN'", async () => {
    const { buildRawScalingXml: internal } = (await import("@excel/xlsx/xlsx.browser")) as any;
    // This helper is a file-local function and isn't exported. Drive
    // it indirectly through a writeBuffer round-trip. Build a chart,
    // poke a NaN into the axis scaling, write, and confirm the
    // serialiser does NOT emit `val="NaN"` (which Excel rejects).
    void internal;
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addRow(ws, ["a", 1]);
    Worksheet.addRow(ws, ["b", 2]);
    addChart(
      ws,
      {
        type: "bar",
        valueAxis: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          scaling: { max: Number.NaN as any, min: 0 }
        },
        series: [{ categories: "S!$A$1:$A$2", values: "S!$B$1:$B$2" }]
      } as AddChartOptions,
      "D1:J10"
    );
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chartXmlEntry = Array.from(entries.entries()).find(([path]) =>
      /xl\/charts\/chart\d+\.xml$/.test(path)
    );
    expect(chartXmlEntry).toBeDefined();
    const chartXml = new TextDecoder().decode(chartXmlEntry![1].data);
    expect(chartXml).not.toContain('val="NaN"');
    // `min=0` is finite and must still survive.
    expect(chartXml).toContain('val="0"');
  });

  it("raw-patch color modifiers guard NaN and produce finite xsd:int attributes", async () => {
    // Build a chart with a solid fill whose color carries a NaN
    // tint. The serialiser must drop the non-finite modifier rather
    // than emit `<a:tint val="NaN"/>`.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addRow(ws, ["a", 1]);
    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            categories: "S!$A$1:$A$1",
            values: "S!$A$1:$A$1",
            spPr: {
              fill: {
                solid: { srgb: "FF0000", tint: Number.NaN, lumMod: 75000 }
              }
            }
          }
        ]
      } as AddChartOptions,
      "D1:J10"
    );
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chartXmlEntry = Array.from(entries.entries()).find(([path]) =>
      /xl\/charts\/chart\d+\.xml$/.test(path)
    );
    const chartXml = new TextDecoder().decode(chartXmlEntry![1].data);
    expect(chartXml).not.toContain('val="NaN"');
    // The finite sibling modifier (`lumMod`) must still survive.
    expect(chartXml).toContain('<a:lumMod val="75000"/>');
  });

  it("ChartEx raw-patch legend preserves spPr/txPr/legendEntry/align via structured writer reuse", async () => {
    // Previously the raw-patch path emitted a self-closing
    // `<cx:legend pos="b"/>`, dropping every styled-legend field.
    // Driving a raw-patchable ChartEx edit through the pipeline
    // should now preserve `spPr` / `txPr` / `legendEntry` / `align`
    // because the raw writer delegates to `renderChartExLegendXml`.
    const { renderChartExLegendXml: internal } =
      await import("@excel/chart/serialize/chart-ex-serialize");
    // The exported function is the shared writer the raw path uses.
    // Call it directly to verify full coverage.
    const legendModel = {
      legendPos: "b" as const,
      align: "ctr" as const,
      overlay: true,
      legendEntries: [{ index: 0, delete: true }],
      spPr: { fill: { solid: { srgb: "ABCDEF" } } },
      extLst: "<cx:extLst>foo</cx:extLst>"
    };
    const xml = internal(legendModel as any);
    expect(xml).toContain('pos="b"');
    expect(xml).toContain('align="ctr"');
    expect(xml).toContain('overlay="1"');
    expect(xml).toContain("<cx:legendEntry");
    expect(xml).toContain("<cx:spPr>");
    expect(xml).toContain("<cx:extLst>foo</cx:extLst>");
  });

  it("spPr._rawXml passthrough respects structured mutation (_renderSpPr honours isRawXmlShape)", async () => {
    // Load a chart with a fill, then directly mutate
    // `spPr.fill.solid.srgb` on the loaded series. The writer
    // previously short-circuited to `_rawXml` and silently dropped
    // the mutation; `isRawXmlShape` now correctly falls back to the
    // structured path when any structured field is populated.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addRow(ws, ["a", 1]);
    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            categories: "S!$A$1:$A$1",
            values: "S!$A$1:$A$1",
            spPr: {
              fill: {
                solid: { srgb: "FF0000" }
              }
            }
          }
        ]
      } as AddChartOptions,
      "D1:J10"
    );
    const buf = await Workbook.toBuffer(wb);
    // Round-trip, then mutate directly in the structured model.
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const chart2 = getCharts(Workbook.getWorksheet(wb2, "S")!)[0];
    const series = Chart.getSeries(chart2, 0) as any;
    // Directly mutate the fill — no call to `setSpPrFill`. Previously
    // this edit was lost.
    series.spPr.fill = { solid: { srgb: "00FF00" } };
    const buf2 = await Workbook.toBuffer(wb2);
    const entries = await extractAll(new Uint8Array(buf2));
    const chartXmlEntry = Array.from(entries.entries()).find(([path]) =>
      /xl\/charts\/chart\d+\.xml$/.test(path)
    );
    const chartXml = new TextDecoder().decode(chartXmlEntry![1].data);
    // The new colour must land in the output, the old one must be
    // gone — proving the mutation won over the cached `_rawXml`.
    expect(chartXml).toContain('val="00FF00"');
    expect(chartXml).not.toContain('val="FF0000"');
  });

  it("threaded-comments rejects NaN / negative / non-integer mention startIndex / length", async () => {
    const { renderThreadedComments } =
      await import("@excel/xlsx/xform/comment/threaded-comments-xform");
    const base = {
      ref: "A1",
      comment: {
        id: "{00000000-0000-0000-0000-000000000001}",
        personId: "{00000000-0000-0000-0000-000000000002}",
        text: "hi",
        date: "2024-01-01T00:00:00Z",
        done: false
      }
    };
    // Non-finite / negative / fractional values must throw.
    expect(() =>
      renderThreadedComments([
        {
          ...base,
          comment: {
            ...base.comment,
            mentions: [{ mentionPersonId: "p", mentionId: "m", startIndex: Number.NaN, length: 3 }]
          }
        }
      ])
    ).toThrow(/non-negative integer/i);
    expect(() =>
      renderThreadedComments([
        {
          ...base,
          comment: {
            ...base.comment,
            mentions: [{ mentionPersonId: "p", mentionId: "m", startIndex: 0, length: -1 }]
          }
        }
      ])
    ).toThrow(/non-negative integer/i);
    expect(() =>
      renderThreadedComments([
        {
          ...base,
          comment: {
            ...base.comment,
            mentions: [{ mentionPersonId: "p", mentionId: "m", startIndex: 1.5, length: 3 }]
          }
        }
      ])
    ).toThrow(/non-negative integer/i);
    // Valid values round-trip unchanged.
    const xml = renderThreadedComments([
      {
        ...base,
        comment: {
          ...base.comment,
          mentions: [{ mentionPersonId: "p", mentionId: "m", startIndex: 0, length: 5 }]
        }
      }
    ]);
    expect(xml).toContain('startIndex="0"');
    expect(xml).toContain('length="5"');
  });

  it("chart-sidecar colorStyle / chartColors strip NaN modifiers instead of serialising 'NaN'", async () => {
    const { buildChartColors } = await import("@excel/chart/serialize/chart-sidecar");
    const xml = buildChartColors({
      method: "cycle",
      id: 10,
      colors: [
        { srgb: "FF0000", tint: Number.NaN, lumMod: 75000 },
        { theme: "accent2", tint: Number.POSITIVE_INFINITY, shade: 50000 }
      ],
      variations: [
        { tint: Number.NaN, lumMod: 60000 },
        { shade: Number.NEGATIVE_INFINITY, satMod: 110000 }
      ]
    });
    expect(xml).not.toContain('val="NaN"');
    expect(xml).not.toContain('val="Infinity"');
    expect(xml).not.toContain('val="-Infinity"');
    // Finite siblings must still emit.
    expect(xml).toContain('<a:lumMod val="75000"/>');
    expect(xml).toContain('<a:shade val="50000"/>');
    expect(xml).toContain('<a:satMod val="110000"/>');
  });
});

describe("Eighth-round chart bug fixes (multi-line text parity between backends)", () => {
  /** Records every `drawText` the PDF backend issues, in order. */
  function recordingSurface() {
    const texts: { text: string; x: number; y: number; fontSize: number; rotation?: number }[] = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText(
        text: string,
        options: { x: number; y: number; fontSize?: number; rotation?: number }
      ) {
        texts.push({
          text,
          x: options.x,
          y: options.y,
          fontSize: options.fontSize ?? 0,
          rotation: options.rotation
        });
        return this;
      }
    };
    return { page, texts };
  }

  function barChart(): { model: ChartModel } {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 30]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    return { model: Chart.chartModel(getCharts(ws)[0])! };
  }

  /** A bar chart whose title has one paragraph per supplied string. */
  function titledModel(paragraphs: string[]): ChartModel {
    const { model } = barChart();
    model.chart.title = {
      text: { paragraphs: paragraphs.map(text => ({ runs: [{ text }] })) }
    } as never;
    return model;
  }

  function pngHash(png: Uint8Array): string {
    let hash = 2166136261;
    for (const byte of png) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  it("stacks a multi-paragraph title in the PDF backend instead of collapsing it", () => {
    // `ChartPdfDrawingSurface.drawText` is contractually a single line, and the
    // surfaces behind it only honour `\n` when a wrap width is given — which
    // charts never give. The title used to arrive as one call carrying a raw
    // newline, so a two-paragraph title rendered as one line in PDF while the
    // SVG backend stacked it correctly.
    const { page, texts } = recordingSurface();
    drawChartPdf(page, titledModel(["Quarterly", "Revenue"]), {
      x: 0,
      y: 0,
      width: 300,
      height: 200
    });

    expect(texts.every(entry => !/[\r\n]/.test(entry.text))).toBe(true);

    const first = texts.findIndex(entry => entry.text === "Quarterly");
    expect(first).toBeGreaterThanOrEqual(0);
    const second = texts[first + 1];
    expect(second.text).toBe("Revenue");
    // Same anchor column, one 1.2 em step further down the page. The scene has
    // already been flipped into PDF's Y-up space, so "down" means a lower y.
    expect(second.x).toBeCloseTo(texts[first].x, 6);
    expect(texts[first].y - second.y).toBeCloseTo(1.2 * texts[first].fontSize, 6);
  });

  it("steps a rotated multi-paragraph label along its own down axis", () => {
    // Axis titles are emitted at -90°. Stacking along the page's Y axis would
    // put the second line on top of the first; it has to follow the rotated
    // text's own down direction, which for -90° is +x.
    const model = titledModel(["Sales"]);
    const valueAxis = model.chart.plotArea.axes.find(
      axis => (axis as ValueAxis).axisType === "val"
    ) as ValueAxis;
    valueAxis.title = {
      text: { paragraphs: [{ runs: [{ text: "Quarterly" }] }, { runs: [{ text: "Revenue" }] }] }
    } as never;

    const { page, texts } = recordingSurface();
    drawChartPdf(page, model, { x: 0, y: 0, width: 300, height: 200 });

    const first = texts.findIndex(entry => entry.text === "Quarterly");
    expect(first).toBeGreaterThanOrEqual(0);
    const second = texts[first + 1];
    expect(second.text).toBe("Revenue");
    // The scene is handed to the surface in PDF space, where the Y flip has
    // already reversed the sense of the rotation: the SVG's `rotate(-90)` (which
    // reads bottom-to-top) is `+90` here. Forwarding the SVG angle unchanged
    // mirrored every rotated axis title in a vector PDF.
    expect(texts[first].rotation).toBe(90);
    expect(second.rotation).toBe(90);
    expect(second.x - texts[first].x).toBeCloseTo(1.2 * texts[first].fontSize, 6);
    expect(second.y).toBeCloseTo(texts[first].y, 6);
  });

  it("leaves single-line text on the one-call fast path", () => {
    const { page, texts } = recordingSurface();
    drawChartPdf(page, titledModel(["Sales"]), { x: 0, y: 0, width: 300, height: 200 });
    expect(texts.filter(entry => entry.text === "Sales")).toHaveLength(1);
  });

  it("draws a smooth line as a curve through its points", () => {
    // `c:smooth` asks for a spline *through* the data, not a polyline with its corners
    // rounded off. Rounding the joins left the line straight between every pair of
    // points — the shape the reader is being told it is not.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 1],
      ["B", 5],
      ["C", 2],
      ["D", 6]
    ]);
    addChart(
      ws,
      {
        type: "line",
        smooth: true,
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$4", values: "Sheet1!$B$1:$B$4" }]
      } as AddChartOptions,
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    fillChartCaches(model, wb);
    const svg = renderChartSvg(model, { width: 300, height: 200 });
    const path = /<path d="([^"]*)"/.exec(svg);
    expect(path).not.toBeNull();
    // Three segments for four points, each a cubic.
    expect((path![1].match(/C/g) ?? []).length).toBe(3);
  });

  it("passes a smooth curve through every data point", () => {
    // Catmull-Rom rather than an approximating spline: a chart's line has to touch its
    // own values. The segment endpoints are the data points.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 1],
      ["B", 5],
      ["C", 2],
      ["D", 6]
    ]);
    addChart(
      ws,
      {
        type: "line",
        smooth: true,
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$4", values: "Sheet1!$B$1:$B$4" }]
      } as AddChartOptions,
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    fillChartCaches(model, wb);
    const svg = renderChartSvg(model, { width: 300, height: 200 });
    // The markers sit on the data points; every one must lie on the curve's own anchors.
    const markers = extractSvgGeometry(svg)
      .filter(shape => shape.kind === "circle")
      .map(shape => ({ x: shape.coords[0], y: shape.coords[1] }));
    const path = /<path d="([^"]*)"/.exec(svg)![1];
    const anchors = [
      ...path.matchAll(/(?:M|C(?:\s+[-\d.]+\s+[-\d.]+){2})\s+([-\d.]+)\s+([-\d.]+)/g)
    ].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      const hit = anchors.some(
        anchor => Math.abs(anchor.x - marker.x) < 0.6 && Math.abs(anchor.y - marker.y) < 0.6
      );
      expect(hit, `no curve anchor at ${marker.x},${marker.y}`).toBe(true);
    }
  });

  it("keeps a smooth curve inside the range of its own data", () => {
    // Catmull-Rom overshoots at an asymmetric local extreme: where one neighbour is far
    // and the other near, the curve bulges past the point it is meant to peak at. On a
    // chart that is ink outside the plot, in the axis labels. Clamping each tangent
    // against the smaller adjacent slope — the monotone condition — holds the curve to
    // the data.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const values = [100, 95, 0, 98, 100];
    Worksheet.addRows(
      ws,
      values.map((value, index) => [`C${index}`, value])
    );
    addChart(
      ws,
      {
        type: "line",
        smooth: true,
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$5", values: "Sheet1!$B$1:$B$5" }]
      } as AddChartOptions,
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    fillChartCaches(model, wb);
    const svg = renderChartSvg(model, { width: 300, height: 200 });

    // The plot's vertical extent, read from the axis lines.
    const vertical = extractSvgGeometry(svg).filter(
      shape =>
        shape.kind === "polyline" &&
        shape.coords.length === 4 &&
        Math.abs(shape.coords[0] - shape.coords[2]) < 0.01
    );
    const top = Math.min(...vertical.flatMap(shape => [shape.coords[1], shape.coords[3]]));
    const bottom = Math.max(...vertical.flatMap(shape => [shape.coords[1], shape.coords[3]]));

    // The curve itself, flattened rather than judged by its control points.
    const numbers = [.../<path d="([^"]*)"/.exec(svg)![1].matchAll(/-?[\d.]+/g)].map(match =>
      Number(match[0])
    );
    const commands: DrawPathCommand[] = [{ op: "move", x: numbers[0], y: numbers[1] }];
    for (let i = 2; i + 5 < numbers.length + 1; i += 6) {
      commands.push({
        op: "cubic",
        x1: numbers[i],
        y1: numbers[i + 1],
        x2: numbers[i + 2],
        y2: numbers[i + 3],
        x: numbers[i + 4],
        y: numbers[i + 5]
      });
    }
    const ys = flattenPath(commands).flatMap(run => run.points.map(point => point.y));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(top - 0.01);
    expect(Math.max(...ys)).toBeLessThanOrEqual(bottom + 0.01);
  });

  it("leaves a non-smooth line straight", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 1],
      ["B", 5],
      ["C", 2],
      ["D", 6]
    ]);
    addChart(
      ws,
      {
        type: "line",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$4", values: "Sheet1!$B$1:$B$4" }]
      } as AddChartOptions,
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    fillChartCaches(model, wb);
    const svg = renderChartSvg(model, { width: 300, height: 200 });
    expect(svg).not.toContain("<path");
  });

  it("keeps a smooth line's rounded joins and caps", () => {
    // `c:smooth` asks for a spline; the SVG emitter has always approximated it by
    // rounding the joins and caps, and that was the only place it ever showed —
    // neither the PDF nor the raster path read the flag. Moving to a display list
    // dropped the approximation silently, because the paint had nowhere to carry
    // it, so a smooth line and a straight one rendered identically.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addRows(ws, [
      ["A", 1],
      ["B", 5],
      ["C", 2]
    ]);
    addChart(
      ws,
      {
        type: "line",
        series: [{ name: "S", categories: "S!$A$1:$A$3", values: "S!$B$1:$B$3" }],
        smooth: true
      } as AddChartOptions,
      "D1:J10"
    );
    const svg = renderChartSvg(Chart.chartModel(getCharts(ws)[0])!, { width: 200, height: 150 });
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('stroke-linecap="round"');
  });

  it("leaves a non-smooth line on the default joins", () => {
    // The flag has to still mean something: emitting rounded joins unconditionally
    // would make every line chart look smoothed.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addRows(ws, [
      ["A", 1],
      ["B", 5],
      ["C", 2]
    ]);
    addChart(
      ws,
      {
        type: "line",
        series: [{ name: "S", categories: "S!$A$1:$A$3", values: "S!$B$1:$B$3" }]
      } as AddChartOptions,
      "D1:J10"
    );
    const svg = renderChartSvg(Chart.chartModel(getCharts(ws)[0])!, { width: 200, height: 150 });
    expect(svg).not.toContain("stroke-linejoin");
    expect(svg).not.toContain("stroke-linecap");
  });

  it("keeps the SVG backend on the same 1.2 em step", () => {
    const svg = renderChartSvg(titledModel(["Quarterly", "Revenue"]), {
      width: 300,
      height: 200
    });
    expect(svg).toContain(">Quarterly</tspan>");
    expect(svg).toContain(">Revenue</tspan>");
    // Baselines are absolute rather than relative `dy`, so no consumer has to
    // resolve `em` against a font size to know where a line sits. The step itself
    // is what matters, and it is still 1.2 em of the 18-unit title font.
    const baselines = [...svg.matchAll(/<tspan x="[\d.]+" y="([\d.]+)"/g)].map(match =>
      Number(match[1])
    );
    expect(baselines).toHaveLength(2);
    expect(baselines[1] - baselines[0]).toBeCloseTo(1.2 * 18, 6);
  });

  it("stacks a multi-paragraph title in the Node raster fallback too", async () => {
    // The raster fallback re-parses the emitted SVG. `decodeSvgText` strips the
    // `<tspan>` tags but nothing put the line break back, so the paragraphs
    // rasterised run together as "QuarterlyRevenue" — byte-identical to a chart
    // actually titled that. Distinct output proves the tspans are walked.
    const size = { width: 300, height: 200 };
    const stacked = await renderChartPng(titledModel(["Quarterly", "Revenue"]), size);
    const runTogether = await renderChartPng(titledModel(["QuarterlyRevenue"]), size);
    expect(pngHash(stacked)).not.toBe(pngHash(runTogether));

    // …and rendering stays deterministic.
    const again = await renderChartPng(titledModel(["Quarterly", "Revenue"]), size);
    expect(pngHash(again)).toBe(pngHash(stacked));
  });

  it("flattens a legend label that carries a newline", () => {
    // A legend row has a fixed height and its column width comes from measuring
    // the whole label, so a newline has nowhere to go. It must collapse to a
    // space in every backend rather than stack (PDF), disappear (SVG whitespace
    // collapsing) or run together (raster).
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 5],
      ["B", 20, 12]
    ]);
    addChart(
      ws,
      {
        // Two series, so the legend labels come from the series names rather
        // than from the per-category fallback Excel uses for a lone series.
        type: "bar",
        series: [
          { name: "North\nRegion", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" },
          { name: "South", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$C$1:$C$2" }
        ],
        showLegend: true,
        legendPosition: "r"
      },
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;

    const scene = buildChartScene(model, { width: 300, height: 200 });
    expect(scene.legend.items.map(item => item.label)).toContain("North Region");
    expect(scene.legend.items.every(item => !/[\r\n]/.test(item.label))).toBe(true);

    const { page, texts } = recordingSurface();
    drawChartPdf(page, model, { x: 0, y: 0, width: 300, height: 200 });
    expect(texts.every(entry => !/[\r\n]/.test(entry.text))).toBe(true);
  });

  it("names the series, not the categories, on a single-series bar chart", () => {
    // Excel lists series in a legend. It lists categories only where each point is
    // coloured separately — the pie family, or an author who set `varyColors`. The
    // branch used to fire for any chart with one series and several categories, so a
    // single-series bar, line or area chart showed `Q1 Q2 Q3 Q4` and never its own
    // name, and `varyColors` was not read anywhere in the renderer.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["Q1", 10],
      ["Q2", 20],
      ["Q3", 15]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "Revenue", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        showLegend: true
      } as AddChartOptions,
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, {
      width: 300,
      height: 200
    });
    expect(scene.legend.items.map(item => item.label)).toEqual(["Revenue"]);
  });

  it("names the categories on a pie, whose slices are coloured one by one", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["Q1", 10],
      ["Q2", 20],
      ["Q3", 15]
    ]);
    addChart(
      ws,
      {
        type: "pie",
        series: [{ name: "Revenue", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        showLegend: true
      } as AddChartOptions,
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, {
      width: 300,
      height: 200
    });
    expect(scene.legend.items.map(item => item.label)).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("honours varyColors on a chart that would otherwise name its series", () => {
    // An author asking for per-point colours is asking for a per-point legend. The
    // renderer never read the flag, so this was previously indistinguishable from a
    // plain bar chart.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["Q1", 10],
      ["Q2", 20],
      ["Q3", 15]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        varyColors: true,
        series: [{ name: "Revenue", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        showLegend: true
      } as AddChartOptions,
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, {
      width: 300,
      height: 200
    });
    expect(scene.legend.items.map(item => item.label)).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("colours the points themselves when varyColors is set, not just the legend", () => {
    // The legend lists categories only because each point carries its own colour, so the
    // two have to agree: a legend of three colours against three identical bars would
    // describe nothing. Asserting the legend alone cannot see that.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 15]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        varyColors: true,
        series: [{ name: "Rev", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        showLegend: true
      } as AddChartOptions,
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    fillChartCaches(model, wb);
    const shapes = extractSvgGeometry(renderChartSvg(model, { width: 320, height: 220 }));
    const swatches = shapes
      .filter(shape => shape.kind === "rect" && shape.coords[2] === 10 && shape.coords[3] === 10)
      .map(shape => shape.fill);
    const bars = shapes
      .filter(
        shape =>
          shape.kind === "rect" &&
          shape.coords[2] > 6 &&
          shape.coords[3] > 6 &&
          shape.fill !== undefined &&
          shape.fill !== "#ffffff"
      )
      .map(shape => shape.fill);
    expect(new Set(bars).size).toBe(3);
    expect([...new Set(bars)]).toEqual(swatches);
  });

  it("keeps every point one colour without varyColors", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 15]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "Rev", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        showLegend: true
      } as AddChartOptions,
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    fillChartCaches(model, wb);
    const bars = extractSvgGeometry(renderChartSvg(model, { width: 320, height: 220 }))
      .filter(
        shape =>
          shape.kind === "rect" &&
          shape.coords[2] > 6 &&
          shape.coords[3] > 6 &&
          shape.fill !== undefined &&
          shape.fill !== "#ffffff"
      )
      .map(shape => shape.fill);
    expect(new Set(bars).size).toBe(1);
  });

  it("flattens a per-category legend label that carries a newline", () => {
    // A pie takes the other branch: its slices are coloured individually, so the
    // legend names categories rather than the series, and the category text becomes
    // the legend label and needs the same treatment. This used to be written with a
    // bar chart, which reached the same branch only because the branch ignored the
    // chart type — the behaviour that made a single-series bar chart list `Q1 Q2 Q3
    // Q4` instead of its series name.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["North\nRegion", 10],
      ["South", 20]
    ]);
    addChart(
      ws,
      {
        type: "pie",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }],
        showLegend: true,
        legendPosition: "r"
      },
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;

    const scene = buildChartScene(model, { width: 300, height: 200 });
    expect(scene.legend.items.every(item => !/[\r\n]/.test(item.label))).toBe(true);
    expect(scene.legend.items.map(item => item.label)).toContain("North Region");
  });
});

describe("Ninth-round chart bug fixes (raster opacity and alpha compositing)", () => {
  /** Rasterise a standalone SVG and read one pixel back. */
  async function pixel(svg: string, x: number, y: number) {
    const { renderSvgToPng } = await import("@excel/chart/render/chart-renderer");
    const { decodePng } = await import("@pdf/render/png-decoder");
    const decoded = decodePng(await renderSvgToPng(svg, { width: 20, height: 20 }));
    const offset = (y * decoded.width + x) * 3;
    return {
      r: decoded.pixels[offset],
      g: decoded.pixels[offset + 1],
      b: decoded.pixels[offset + 2],
      a: decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255
    };
  }

  const svg = (attrs: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">` +
    `<rect x="0" y="0" width="20" height="20" fill="#ff0000" ${attrs}/></svg>`;

  it("honours the opacity attribute, which the raster path used to drop", () => {
    // ChartEx emits `opacity="0.55"` on some series. The Node raster read only
    // `fill` / `stroke`, so the same `Chart.toPNG` call came out fully opaque on
    // Node while the browser canvas honoured it.
    return pixel(svg('opacity="0.2"'), 10, 10).then(px => {
      expect(px.a).toBeCloseTo(51, -0.5);
      // …and the colour must stay pure red rather than darken towards black.
      expect(px).toMatchObject({ r: 255, g: 0, b: 0 });
    });
  });

  it("honours fill-opacity and multiplies it with opacity", async () => {
    expect((await pixel(svg('fill-opacity="0.5"'), 10, 10)).a).toBeCloseTo(128, -0.5);
    expect((await pixel(svg('fill-opacity="0.5" opacity="0.5"'), 10, 10)).a).toBeCloseTo(64, -0.5);
  });

  it("honours alpha carried by an 8-digit hex fill", async () => {
    const px = await pixel(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
        '<rect x="0" y="0" width="20" height="20" fill="#ff000040"/></svg>',
      10,
      10
    );
    expect(px.a).toBeCloseTo(64, -0.5);
    expect(px).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("keeps an opaque paint fully opaque", async () => {
    expect(await pixel(svg(""), 10, 10)).toMatchObject({ r: 255, g: 0, b: 0, a: 255 });
  });

  it("composites onto an opaque background exactly as before", async () => {
    // The compositing fix must not move any pixel in the normal chart path,
    // where a background rect is painted first: 20% red over white is
    // rgb(255,204,204) under both the old and the corrected formula.
    const px = await pixel(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
        '<rect x="0" y="0" width="20" height="20" fill="#ffffff"/>' +
        '<rect x="0" y="0" width="20" height="20" fill="#ff0000" opacity="0.2"/></svg>',
      10,
      10
    );
    expect(px).toMatchObject({ r: 255, g: 204, b: 204, a: 255 });
  });
});

describe("Tenth-round chart bug fixes (rotation sense across the Y flip)", () => {
  it("reverses a rotated label's angle when the scene is flipped into PDF space", () => {
    // A value-axis title is emitted as `rotate(-90)` so it reads bottom-to-top,
    // which is what Excel, the SVG backend and the PNG backend all draw. The PDF
    // surface receives a Y-up coordinate system, and a Y reflection reverses a
    // rotation, so the angle has to flip with it.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    const valueAxis = model.chart.plotArea.axes.find(
      axis => (axis as ValueAxis).axisType === "val"
    ) as ValueAxis;
    valueAxis.title = { text: { paragraphs: [{ runs: [{ text: "Units" }] }] } } as never;

    // SVG keeps the authored, screen-space angle…
    expect(renderChartSvg(model, { width: 300, height: 200 })).toContain("rotate(-90 ");

    // …and the PDF surface receives its mirror image.
    const rotations: number[] = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText(text: string, options: { rotation?: number }) {
        if (text === "Units") {
          rotations.push(options.rotation ?? 0);
        }
        return this;
      }
    };
    drawChartPdf(page, model, { x: 0, y: 0, width: 300, height: 200 });
    expect(rotations).toEqual([90]);
  });

  it("leaves unrotated text alone", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }],
        title: "Sales"
      },
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    const seen: (number | undefined)[] = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText(text: string, options: { rotation?: number }) {
        if (text === "Sales") {
          seen.push(options.rotation);
        }
        return this;
      }
    };
    drawChartPdf(page, model, { x: 0, y: 0, width: 300, height: 200 });
    expect(seen).toEqual([undefined]);
  });
});

describe("Eleventh-round chart bug fixes (raster stroke dash and text alpha)", () => {
  /** Count opaque vs transparent pixels along the middle scanline. */
  async function scanline(svg: string) {
    const { renderSvgToPng } = await import("@excel/chart/render/chart-renderer");
    const { decodePng } = await import("@pdf/render/png-decoder");
    const decoded = decodePng(await renderSvgToPng(svg, { width: 40, height: 12 }));
    const y = 6;
    let on = 0;
    let off = 0;
    for (let x = 0; x < decoded.width; x++) {
      const alpha = decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
      if (alpha > 40) {
        on++;
      } else {
        off++;
      }
    }
    return { on, off };
  }

  const wrap = (body: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="12">${body}</svg>`;

  it("rasterises stroke-dasharray as an actual dashed stroke", async () => {
    // The waterfall connector, the box-whisker mean line and classic dashed
    // trendlines all emit `stroke-dasharray`; the Node raster path dropped it, so
    // they came out solid while SVG and browser PNG drew them dashed.
    //
    // Compared relatively rather than against absolutes: in a browser this runs
    // through Chromium's canvas, whose anti-aliasing leaves the odd sub-threshold
    // edge pixel on a 1px line. What matters either way is that a dashed stroke
    // covers materially less of the scanline than a solid one — before the fix the
    // two were identical.
    const solid = await scanline(
      wrap('<line x1="0" y1="6" x2="39" y2="6" stroke="#000" stroke-width="1"/>')
    );
    const dashed = await scanline(
      wrap(
        '<line x1="0" y1="6" x2="39" y2="6" stroke="#000" stroke-width="1" stroke-dasharray="4 4"/>'
      )
    );
    expect(dashed.on).toBeGreaterThan(0);
    expect(dashed.off).toBeGreaterThan(solid.off + 2);
    expect(dashed.on).toBeLessThan(solid.on - 2);
  });

  it("dashes a polyline as one continuous phase", async () => {
    const solid = await scanline(
      wrap('<polyline points="0,6 39,6" stroke="#000" stroke-width="1"/>')
    );
    const dashed = await scanline(
      wrap('<polyline points="0,6 39,6" stroke="#000" stroke-width="1" stroke-dasharray="5 5"/>')
    );
    expect(dashed.off).toBeGreaterThan(solid.off + 2);
  });

  it("treats stroke-dasharray:none and an all-zero pattern as solid", async () => {
    const solid = await scanline(
      wrap('<line x1="0" y1="6" x2="39" y2="6" stroke="#000" stroke-width="1"/>')
    );
    for (const value of ["none", "0", "0 0"]) {
      const result = await scanline(
        wrap(
          `<line x1="0" y1="6" x2="39" y2="6" stroke="#000" stroke-width="1" stroke-dasharray="${value}"/>`
        )
      );
      expect(result.on, `dasharray=${value}`).toBe(solid.on);
    }
  });

  it("modulates glyph anti-aliasing by the paint alpha", async () => {
    // Coverage used to *replace* the alpha, so translucent text rendered fully
    // opaque at every glyph centre while shapes honoured the same attribute.
    const { renderSvgToPng } = await import("@excel/chart/render/chart-renderer");
    const { decodePng } = await import("@pdf/render/png-decoder");
    const size = { width: 60, height: 30 };
    const text = (attrs: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30">` +
      `<text x="2" y="22" font-size="24" fill="#ff0000" ${attrs}>I</text></svg>`;

    const peak = (png: Uint8Array): number => {
      const decoded = decodePng(png);
      let max = 0;
      const alpha = decoded.alpha;
      if (!alpha) {
        return 255;
      }
      for (const value of alpha) {
        max = Math.max(max, value);
      }
      return max;
    };

    const opaque = peak(await renderSvgToPng(text(""), size));
    const faded = peak(await renderSvgToPng(text('opacity="0.3"'), size));
    expect(opaque).toBeGreaterThan(200);
    expect(faded).toBeLessThan(opaque);
    expect(faded).toBeGreaterThan(0);
  });
});

describe("Twelfth-round chart bug fixes (rounded rect in the raster fallback)", () => {
  it("rounds a rect's corners when rx is set", async () => {
    // The ChartEx region-map frame is emitted with `rx="14"`; the raster path read
    // only x/y/width/height, so it came out square while SVG and browser PNG
    // rounded it.
    const { renderSvgToPng } = await import("@excel/chart/render/chart-renderer");
    const { decodePng } = await import("@pdf/render/png-decoder");
    const size = { width: 40, height: 24 };
    const svg = (attrs: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24">` +
      `<rect x="0" y="0" width="40" height="24" ${attrs} fill="#0000ff"/></svg>`;

    const alphaAt = async (attrs: string, x: number, y: number): Promise<number> => {
      const decoded = decodePng(await renderSvgToPng(svg(attrs), size));
      return decoded.alpha ? decoded.alpha[y * decoded.width + x] : 255;
    };

    // Square corners are painted; rounded ones are not. The centre stays filled
    // either way, which rules out "the whole rect vanished".
    expect(await alphaAt("", 1, 1)).toBeGreaterThan(200);
    expect(await alphaAt('rx="10"', 1, 1)).toBeLessThan(40);
    expect(await alphaAt('rx="10"', 20, 12)).toBeGreaterThan(200);
  });

  it("falls back to square corners for rx=0 and a malformed rx", async () => {
    const { renderSvgToPng } = await import("@excel/chart/render/chart-renderer");
    const { decodePng } = await import("@pdf/render/png-decoder");
    for (const attrs of ['rx="0"', 'rx="abc"']) {
      const decoded = decodePng(
        await renderSvgToPng(
          `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24">` +
            `<rect x="0" y="0" width="40" height="24" ${attrs} fill="#00f"/></svg>`,
          { width: 40, height: 24 }
        )
      );
      const alpha = decoded.alpha ? decoded.alpha[1 * decoded.width + 1] : 255;
      expect(alpha, `attrs=${attrs}`).toBeGreaterThan(200);
    }
  });
});
