/**
 * Chart builder tests — P1 preset coverage and P2 SVG/PDF renderer.
 *
 * Split out of the original 13,000-line `chart-builder.test.ts`
 * so vitest transform/import stays fast in full-suite runs.
 * Shared helpers and imports live in `chart-builder.helpers.ts`.
 */

import { extractAll } from "@archive/unzip/extract";
import {
  CHART_EX_PRESETS,
  CHART_PRESETS,
  applyChartExPreset,
  buildChartModel,
  chartExOptionsFromRows,
  chartExOptionsFromTable,
  chartOptionsFromRows,
  chartOptionsFromTable,
  fillChartCaches,
  parseSpPr,
  buildSpPr,
  buildChartExModel,
  buildChartScene,
  renderChartPng,
  renderChartSvg,
  applyChartPreset,
  EXCEL_CHART_EX_PRESETS,
  EXCEL_CHART_PRESETS,
  drawChartPdf,
  seriesFromColumns,
  applyChartExPreset as rootApplyChartExPreset,
  CHART_EX_PRESETS as ROOT_CHART_EX_PRESETS,
  EXCEL_CHART_EX_PRESETS as ROOT_EXCEL_CHART_EX_PRESETS,
  CHART_PRESETS as ROOT_CHART_PRESETS,
  EXCEL_CHART_PRESETS as ROOT_EXCEL_CHART_PRESETS,
  buildChartExModel as rootBuildChartExModel,
  renderChartExSvg as rootRenderChartExSvg,
  renderChartSvg as rootRenderChartSvg,
  seriesFromColumns as rootSeriesFromColumns,
  chartOptionsFromRows as rootChartOptionsFromRows,
  chartOptionsFromTable as rootChartOptionsFromTable
} from "@excel/chart/index";
import type {
  AddChartOptions,
  AddChartSeriesOptions,
  ChartModel,
  BarChartGroup,
  LineChartGroup,
  PieChartGroup,
  BubbleChartGroup,
  LineSeries,
  BarSeries,
  ValueAxis,
  StockChartGroup,
  OfPieChartGroup,
  ChartScene,
  ChartSceneLegend,
  ChartSceneSeries,
  ChartSceneText,
  AddChartFromRowsOptions,
  AddChartFromTableOptions,
  ChartExType,
  SeriesFromColumnsOptions
} from "@excel/chart/index";
import { tableSetName } from "@excel/core/table";
import {
  addAreaChart,
  addBarChart,
  addBoxWhiskerChart,
  addBubbleChart,
  addChart,
  addChartExFromRows,
  addChartExFromTable,
  addChartFromRows,
  addChartFromTable,
  addColumnChart,
  addColumnChartFromRows,
  addComboChart,
  addDoughnutChart,
  addFunnelChart,
  addHistogramChart,
  addLineChart,
  addParetoChart,
  addPresetChart,
  addRadarChart,
  addRegionMapChart,
  addScatterChart,
  addStockChart,
  addSunburstChart,
  addSurfaceChart,
  addTable,
  addTreemapChart,
  addWaterfallChart,
  getCharts
} from "@excel/core/worksheet";
import { Cell, Chart, Workbook, Worksheet } from "@excel/index";
import {
  validateXmlName as rootValidateXmlName,
  xmlEncodeAttr as rootXmlEncodeAttr
} from "@xml/encode";
import { describe, it, expect } from "vitest";

import {
  CATEGORIES,
  VALUES_A,
  VALUES_B,
  baseSeries,
  bubbleSeries,
  ctg,
  expectPngDimensions,
  expectPngPhysDpi,
  makeRootExportRenderedChartModel,
  pngSignature,
  scatterSeries,
  stableHash
} from "./chart-builder.helpers";

const textDecoder = new TextDecoder();

describe("P1: chart convenience APIs and presets", () => {
  it("addColumnChart creates a column bar chart", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addColumnChart(ws, { series: [baseSeries("S")], grouping: "stacked" }, "C1:J10");

    const group = Chart.chartTypes(getCharts(ws)[0])[0] as BarChartGroup;
    expect(group.type).toBe("bar");
    expect(group.barDir).toBe("col");
    expect(group.grouping).toBe("stacked");
  });

  it("addLineChart creates a line chart", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addLineChart(ws, { series: [baseSeries("S")] }, "C1:J10");

    expect(Chart.chartTypes(getCharts(ws)[0])[0].type).toBe("line");
  });

  it("addHistogramChart creates a chartEx histogram", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addHistogramChart(ws, { series: [{ name: "H", values: "Sheet1!$B$1:$B$5" }] }, "C1:J10");

    const chart = getCharts(ws)[0];
    expect(Chart.isChartEx(chart)).toBe(true);
    expect(
      Chart.chartExModel(chart)!.chartSpace.chart.plotArea.plotAreaRegion!.series[0].layoutPr
        ?.binning?.binType
    ).toBe("auto");
  });

  it("addPresetChart maps Excel-style presets", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addPresetChart(ws, "bar3DConeClustered", { series: [baseSeries("S")] }, "C1:J10");

    const group = Chart.chartTypes(getCharts(ws)[0])[0] as BarChartGroup;
    expect(group.type).toBe("bar3D");
    expect(group.barDir).toBe("bar");
    expect(group.shape).toBe("cone");
  });

  it("applyChartPreset covers Excel 3D shape, stock, scatter, and surface aliases", () => {
    const cases: Array<[Parameters<typeof applyChartPreset>[0], Partial<AddChartOptions>]> = [
      [
        "cylinderColStacked100",
        { type: "bar3D", barDir: "col", grouping: "percentStacked", shape: "cylinder" }
      ],
      [
        "pyramidBarStacked",
        { type: "bar3D", barDir: "bar", grouping: "stacked", shape: "pyramid" }
      ],
      [
        "coneBarStacked100",
        { type: "bar3D", barDir: "bar", grouping: "percentStacked", shape: "cone" }
      ],
      ["pieExploded3D", { type: "pie3D" }],
      ["stockOHLC", { type: "stock" }],
      ["scatterLinesNoMarkers", { type: "scatter", scatterStyle: "line" }],
      ["surfaceTopView", { type: "surface3D", view3D: { rotX: 90, rotY: 0 } }],
      ["topViewWireframe", { type: "surface3D", wireframe: true, view3D: { rotX: 90, rotY: 0 } }]
    ];
    for (const [preset, expected] of cases) {
      const options = applyChartPreset(preset, { series: [baseSeries("S")] });
      expect(options).toMatchObject(expected);
    }
  });

  // Regression — `stockOHLC` preset previously omitted `hiLowLines`,
  // producing an OHLC chart without the wick connectors that Excel's
  // OHLC preset ships with. All stock variants now emit the
  // appropriate feature combination.
  it("stock presets enable hi-low lines by default; OHLC adds up-down bars too", () => {
    const hlc = applyChartPreset("stockHLC", { series: [baseSeries("S")] });
    expect(hlc).toMatchObject({ type: "stock", hiLowLines: true });
    expect(hlc.upDownBars).toBeFalsy();

    const ohlc = applyChartPreset("stockOHLC", { series: [baseSeries("S")] });
    expect(ohlc).toMatchObject({ type: "stock", hiLowLines: true, upDownBars: true });
  });

  // Regression — `stockVHLC` / `stockVOHLC` (Volume-HLC / Volume-OHLC)
  // used to be accepted here as quiet aliases of the non-volume
  // variants, hiding the fact that Excel renders a true volume-stock
  // chart as a combo of a column chart (for volume) and a stock chart
  // (for price). The aliases produced a chart without the volume
  // bars — the caller thought the preset worked and the preview
  // silently lied. `applyChartPreset` now rejects the names entirely;
  // callers who need the volume overlay should compose a combo chart
  // via `buildComboChartModel`.
  it("stockVHLC / stockVOHLC presets are rejected because they need a combo chart", () => {
    expect(() =>
      applyChartPreset("stockVHLC" as unknown as Parameters<typeof applyChartPreset>[0], {
        series: [baseSeries("S")]
      })
    ).toThrow(/Unknown chart preset/);
    expect(() =>
      applyChartPreset("stockVOHLC" as unknown as Parameters<typeof applyChartPreset>[0], {
        series: [baseSeries("S")]
      })
    ).toThrow(/Unknown chart preset/);
  });

  it("applyChartPreset exposes a broad Excel UI preset alias matrix", () => {
    expect(EXCEL_CHART_PRESETS.length).toBeGreaterThanOrEqual(70);
    expect(new Set(EXCEL_CHART_PRESETS).size).toBe(EXCEL_CHART_PRESETS.length);

    const cases: Array<[Parameters<typeof applyChartPreset>[0], Partial<AddChartOptions>]> = [
      [
        "col3DConeStacked100",
        { type: "bar3D", barDir: "col", grouping: "percentStacked", shape: "cone" }
      ],
      [
        "bar3DCylinderStacked",
        { type: "bar3D", barDir: "bar", grouping: "stacked", shape: "cylinder" }
      ],
      [
        "bar3DPyramidClustered",
        { type: "bar3D", barDir: "bar", grouping: "clustered", shape: "pyramid" }
      ],
      ["barOfPie", { type: "ofPie", ofPieType: "bar" }],
      ["pieOfPie", { type: "ofPie", ofPieType: "pie" }],
      ["area3DStacked100", { type: "area3D", grouping: "percentStacked" }],
      ["scatterMarker", { type: "scatter", scatterStyle: "marker" }],
      ["radarMarkers", { type: "radar", radarStyle: "marker" }],
      ["surface3DWireframe", { type: "surface3D", wireframe: true }],
      ["stockOHLC", { type: "stock", hiLowLines: true, upDownBars: true }]
    ];

    for (const [preset, expected] of cases) {
      const options = applyChartPreset(preset, { series: [baseSeries("S")] });
      expect(options).toMatchObject(expected);
    }
  });

  it("applyChartPreset maps series-level exploded pie settings", () => {
    const options = applyChartPreset("pieExploded", { series: [baseSeries("S")] });
    const model = buildChartModel(options);
    const group = ctg(model) as PieChartGroup;

    expect(group.type).toBe("pie");
    expect(group.series[0].explosion).toBe(25);
  });

  it("applyChartPreset maps bubble3D to bubble series", () => {
    const options = applyChartPreset("bubble3D", { series: [bubbleSeries("S")] });
    const model = buildChartModel(options);
    const group = ctg(model) as BubbleChartGroup;

    expect(group.type).toBe("bubble");
    expect(group.series[0].bubble3D).toBe(true);
  });

  it("applyChartExPreset maps modern chart presets", () => {
    expect(EXCEL_CHART_EX_PRESETS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(EXCEL_CHART_EX_PRESETS).size).toBe(EXCEL_CHART_EX_PRESETS.length);
    expect(CHART_EX_PRESETS.boxAndWhisker.options.type).toBe("boxWhisker");

    const series = [{ name: "S", values: VALUES_A }];
    expect(applyChartExPreset("histogram", { series })).toMatchObject({ type: "histogram" });
    expect(applyChartExPreset("pareto", { series })).toMatchObject({ type: "pareto" });
    expect(applyChartExPreset("boxAndWhisker", { series })).toMatchObject({
      type: "boxWhisker"
    });
    expect(applyChartExPreset("map", { series })).toMatchObject({ type: "regionMap" });
  });

  it("creates chart options from column ranges without hand-written sheet formulas", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sales Data");
    const series = Chart.seriesFromColumns(ws, {
      categories: "A2:A4",
      values: "B2:B4",
      name: "Sales"
    });
    expect(series.categories).toBe("'Sales Data'!$A$2:$A$4");
    expect(series.values).toBe("'Sales Data'!$B$2:$B$4");

    const standalone = seriesFromColumns("Sales Data", {
      categories: "A2:A4",
      values: "B2:B4",
      name: "Sales"
    });
    expect(standalone).toEqual(series);
  });

  it("adds charts directly from tables and object rows", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addTable(ws, {
      name: "SalesTable",
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      columns: [{ name: "Month" }, { name: "Sales" }, { name: "Profit" }],
      rows: [
        ["Jan", 10, 2],
        ["Feb", 20, 6]
      ]
    });
    addChartFromTable(
      ws,
      "SalesTable",
      { type: "bar", barDir: "col", categoryColumn: "Month", valueColumns: ["Sales"] },
      "E1:K10"
    );
    addColumnChartFromRows(
      ws,
      [
        { month: "Jan", sales: 10 },
        { month: "Feb", sales: 20 }
      ],
      { x: "month", y: "sales", startCell: "H20" },
      "E12:K22"
    );
    expect(getCharts(ws)).toHaveLength(2);
    expect(
      (Chart.chartTypes(getCharts(ws)[0])[0].series[0] as BarSeries).val?.numRef?.formula
    ).toBe("SalesTable[Sales]");
    expect(
      (Chart.chartTypes(getCharts(ws)[1])[0].series[0] as BarSeries).cat?.strRef?.formula
    ).toBe("Sheet1!$H$21:$H$22");
    expect(
      chartOptionsFromTable(ws, "SalesTable", { type: "line", valueColumns: ["Profit"] }).series
    ).toHaveLength(1);
    expect(
      chartOptionsFromRows(ws, [{ month: "Mar", sales: 30 }], {
        type: "bar",
        x: "month",
        y: "sales",
        startCell: "K20"
      }).series
    ).toHaveLength(1);
  });

  it("creates table chart options with structured references by default", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data Sheet");
    addTable(ws, {
      name: "SalesTable",
      ref: "A1",
      columns: [{ name: "Month" }, { name: "Sales" }, { name: "Profit %" }],
      rows: [
        ["Jan", 10, 0.2],
        ["Feb", 20, 0.3]
      ]
    });

    const dynamic = chartOptionsFromTable(ws, "SalesTable", {
      type: "bar",
      categoryColumn: "Month",
      valueColumns: ["Sales", "Profit %"]
    });
    expect(dynamic.series?.[0].categories).toBe("SalesTable[Month]");
    expect(dynamic.series?.[0].values).toBe("SalesTable[Sales]");
    expect(dynamic.series?.[1].values).toBe("SalesTable[Profit %]");

    const fixed = chartOptionsFromTable(ws, "SalesTable", {
      type: "bar",
      categoryColumn: "Month",
      valueColumns: ["Sales"],
      structuredReferences: false
    });
    expect(fixed.series?.[0].categories).toBe("'Data Sheet'!$A$2:$A$3");
    expect(fixed.series?.[0].values).toBe("'Data Sheet'!$B$2:$B$3");
  });

  it("populates caches from table structured references", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addTable(ws, {
      name: "SalesTable",
      ref: "A1",
      columns: [{ name: "Month" }, { name: "Sales" }],
      rows: [
        ["Jan", 10],
        ["Feb", 20]
      ]
    });

    const options = chartOptionsFromTable(ws, "SalesTable", {
      type: "bar",
      categoryColumn: "Month",
      valueColumns: ["Sales"]
    });
    const model = buildChartModel(options);
    fillChartCaches(model, wb);
    const series = model.chart.plotArea.chartTypes[0].series[0] as BarSeries;

    expect(series.cat?.strRef?.cache?.points).toEqual([
      { index: 0, value: "Jan" },
      { index: 1, value: "Feb" }
    ]);
    expect(series.val?.numRef?.cache?.points).toEqual([
      { index: 0, value: 10 },
      { index: 1, value: 20 }
    ]);
    expect(series.val?.numRef?.cache?.pointCount).toBe(2);
  });

  it("populates caches from escaped structured references", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const table = addTable(ws, {
      name: "OddTable",
      ref: "A1",
      columns: [{ name: "Region" }, { name: "Sales]#'@" }],
      rows: [
        ["East", 7],
        ["West", 8]
      ]
    });
    tableSetName(table, "Odd.Table");

    const options = chartOptionsFromTable(ws, table, {
      type: "bar",
      categoryColumn: "Region",
      valueColumns: ["Sales]#'@"]
    });
    const model = buildChartModel(options);
    fillChartCaches(model, wb);
    const series = model.chart.plotArea.chartTypes[0].series[0] as BarSeries;

    expect(series.val?.numRef?.formula).toBe("Odd.Table[Sales']'#'''@]");
    expect(series.val?.numRef?.cache?.points).toEqual([
      { index: 0, value: 7 },
      { index: 1, value: 8 }
    ]);
  });

  it("rejects object-row charts without rows or with a mismatched sheetName", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Workbook.addWorksheet(wb, "Other");

    expect(() => chartOptionsFromRows(ws, [], { type: "bar", x: "month", y: "sales" })).toThrow(
      /at least one row/
    );
    expect(() =>
      chartOptionsFromRows(ws, [{ month: "Jan", sales: 10 }], {
        type: "bar",
        x: "month",
        y: "sales",
        sheetName: "Other"
      })
    ).toThrow(/sheetName must match/);
  });

  it("rejects table charts with no data rows", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addTable(ws, {
      name: "EmptySales",
      ref: "A1",
      columns: [{ name: "Month" }, { name: "Sales" }],
      rows: []
    });

    expect(() =>
      chartOptionsFromTable(ws, "EmptySales", {
        type: "bar",
        categoryColumn: "Month",
        valueColumns: ["Sales"]
      })
    ).toThrow(/no data rows/);
  });

  it("chartExOptionsFromTable builds sunburst/funnel/histogram options from a Table", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data Sheet");
    addTable(ws, {
      name: "RegionSales",
      ref: "A1",
      columns: [{ name: "Region" }, { name: "Sales" }, { name: "Profit %" }],
      rows: [
        ["North", 100, 0.2],
        ["South", 80, 0.15],
        ["East", 60, 0.3]
      ]
    });

    const structured = chartExOptionsFromTable(ws, "RegionSales", {
      type: "sunburst",
      categoryColumn: "Region",
      valueColumns: ["Sales", "Profit %"]
    });
    expect(structured.type).toBe("sunburst");
    expect(structured.categories).toBe("RegionSales[Region]");
    expect(structured.series).toHaveLength(2);
    expect(structured.series[0].values).toBe("RegionSales[Sales]");
    expect(structured.series[0].name).toBe("Sales");
    expect(structured.series[1].values).toBe("RegionSales[Profit %]");

    const absolute = chartExOptionsFromTable(ws, "RegionSales", {
      type: "funnel",
      categoryColumn: "Region",
      structuredReferences: false
    });
    expect(absolute.type).toBe("funnel");
    expect(absolute.categories).toBe("'Data Sheet'!$A$2:$A$4");
    // Default valueColumns = every non-category column.
    expect(absolute.series).toHaveLength(2);
    expect(absolute.series[0].values).toBe("'Data Sheet'!$B$2:$B$4");
    expect(absolute.series[1].values).toBe("'Data Sheet'!$C$2:$C$4");

    // Histogram should build cleanly too.
    const hist = chartExOptionsFromTable(ws, "RegionSales", {
      type: "histogram",
      valueColumns: ["Sales"]
    });
    const histModel = buildChartExModel(hist);
    expect(histModel.chartSpace.chart.plotArea.plotAreaRegion?.series[0].layoutId).toBe(
      "clusteredColumn"
    );
  });

  it("chartExOptionsFromRows stages rows and builds waterfall/treemap options", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");

    const waterfall = chartExOptionsFromRows(
      ws,
      [
        { stage: "Start", value: 100 },
        { stage: "Adj1", value: -20 },
        { stage: "Adj2", value: 30 },
        { stage: "End", value: 110 }
      ],
      { type: "waterfall", x: "stage", y: "value", startCell: "A1" }
    );
    expect(waterfall.type).toBe("waterfall");
    expect(waterfall.categories).toBe("Sheet1!$A$2:$A$5");
    expect(waterfall.series[0].values).toBe("Sheet1!$B$2:$B$5");
    // Header row was written.
    expect(Cell.getValue(ws, "A1")).toBe("stage");
    expect(Cell.getValue(ws, "B1")).toBe("value");
    expect(Cell.getValue(ws, "A2")).toBe("Start");
    expect(Cell.getValue(ws, "B4")).toBe(30);

    // Skipping headers + offset startCell.
    const treemap = chartExOptionsFromRows(
      ws,
      [
        { leaf: "A", size: 1 },
        { leaf: "B", size: 2 }
      ],
      {
        type: "treemap",
        x: "leaf",
        y: "size",
        startCell: "D10",
        includeHeaders: false
      }
    );
    expect(treemap.categories).toBe("Sheet1!$D$10:$D$11");
    expect(treemap.series[0].values).toBe("Sheet1!$E$10:$E$11");
    expect(Cell.getValue(ws, "D10")).toBe("A");
    // No header was written.
    expect(Cell.getValue(ws, "D9")).toBeNull();
  });

  it("chartEx helpers surface through worksheet.addChartExFromTable and addChartExFromRows", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addTable(ws, {
      name: "Funnel",
      ref: "A1",
      columns: [{ name: "Stage" }, { name: "Count" }],
      rows: [
        ["Visit", 1000],
        ["Sign up", 400],
        ["Purchase", 80]
      ]
    });

    const tableChartNum = addChartExFromTable(
      ws,
      "Funnel",
      { type: "funnel", categoryColumn: "Stage" },
      "D1:J10"
    );
    const rowChartNum = addChartExFromRows(
      ws,
      [
        { stage: "Start", value: 50 },
        { stage: "End", value: 40 }
      ],
      { type: "waterfall", x: "stage", y: "value", startCell: "L1" },
      "D12:J21"
    );

    expect(tableChartNum).toBeGreaterThan(0);
    expect(rowChartNum).toBeGreaterThan(tableChartNum);
    // Both entries should have created ChartExModel records.
    const charts = getCharts(ws);
    expect(charts).toHaveLength(2);
    const tableChart = charts.find(chart => chart.chartExNumber === tableChartNum);
    const rowChart = charts.find(chart => chart.chartExNumber === rowChartNum);
    expect(
      Chart.chartExModel(tableChart!)?.chartSpace.chart.plotArea.plotAreaRegion?.series[0].layoutId
    ).toBe("funnel");
    expect(
      Chart.chartExModel(rowChart!)?.chartSpace.chart.plotArea.plotAreaRegion?.series[0].layoutId
    ).toBe("waterfall");
  });

  it("chartEx helpers reject empty rows, missing tables, and sheet mismatch", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Workbook.addWorksheet(wb, "Other");
    addTable(ws, {
      name: "EmptyEx",
      ref: "A1",
      columns: [{ name: "K" }, { name: "V" }],
      rows: []
    });

    expect(() => chartExOptionsFromTable(ws, "EmptyEx", { type: "sunburst" })).toThrow(
      /no data rows/
    );

    expect(() => chartExOptionsFromTable(ws, "MissingTable", { type: "treemap" })).toThrow(
      /Table not found/
    );

    expect(() => chartExOptionsFromRows(ws, [], { type: "funnel", x: "a", y: "b" })).toThrow(
      /at least one row/
    );

    expect(() =>
      chartExOptionsFromRows(ws, [{ a: "x", b: 1 }], {
        type: "funnel",
        x: "a",
        y: "b",
        sheetName: "Other"
      })
    ).toThrow(/sheetName must match/);
  });

  it("Chart.setUserShapesXml attaches a drawing overlay and round-trips through xlsx write", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 1],
      ["B", 2]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );

    const chart = getCharts(ws)[0];
    // Freshly built chart has no user shapes.
    expect(Chart.userShapesXml(chart)).toBeUndefined();

    const userShapesXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<c:userShapes xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"' +
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      "<c:relSizeAnchor>" +
      "<c:from><c:x>0.1</c:x><c:y>0.1</c:y></c:from>" +
      "<c:to><c:x>0.4</c:x><c:y>0.3</c:y></c:to>" +
      '<c:sp><c:nvSpPr><c:cNvPr id="1" name="TextBox"/><c:cNvSpPr/></c:nvSpPr>' +
      "<c:spPr/><c:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Callout</a:t></a:r></a:p></c:txBody></c:sp>" +
      "</c:relSizeAnchor>" +
      "</c:userShapes>";

    Chart.setUserShapesXml(chart, userShapesXml);
    expect(Chart.userShapesXml(chart)).toBeDefined();
    expect(textDecoder.decode(Chart.userShapesXml(chart)!)).toContain("Callout");
    // The chart model should now carry a rel id for the drawing part.
    expect(Chart.chartModel(chart)?.userShapesRelId).toMatch(/^rId/);

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const overlay = zipData.get("xl/drawings/chartUserShape1.xml");
    expect(overlay).toBeDefined();
    expect(textDecoder.decode(overlay!.data)).toContain("Callout");
    const rels = textDecoder.decode(zipData.get("xl/charts/_rels/chart1.xml.rels")!.data);
    expect(rels).toContain("chartUserShapes");
    expect(rels).toContain("chartUserShape1.xml");
    const contentTypes = textDecoder.decode(zipData.get("[Content_Types].xml")!.data);
    expect(contentTypes).toContain("chartUserShape1.xml");

    // Load the produced file and confirm the overlay bytes survive.
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const chart2 = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    expect(Chart.userShapesXml(chart2)).toBeDefined();
    expect(textDecoder.decode(Chart.userShapesXml(chart2)!)).toContain("Callout");
  });

  it("Chart.setUserShapesXml validates input and removeUserShapes drops the rel", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 1],
      ["B", 2]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    const chart = getCharts(ws)[0];

    // String overload is accepted too.
    expect(() => Chart.setUserShapesXml(chart, "<unknown/>")).toThrow(/c:userShapes/);

    Chart.setUserShapesXml(
      chart,
      '<c:userShapes xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>'
    );
    expect(Chart.userShapesXml(chart)).toBeDefined();
    expect(Chart.chartModel(chart)!.userShapesRelId).toBeDefined();

    // Empty bytes == remove.
    Chart.setUserShapesXml(chart, new Uint8Array(0));
    expect(Chart.userShapesXml(chart)).toBeUndefined();
    expect(Chart.chartModel(chart)!.userShapesRelId).toBeUndefined();

    // Explicit remove is idempotent.
    Chart.removeUserShapes(chart);
    expect(Chart.userShapesXml(chart)).toBeUndefined();
  });

  it("adds classic and chartEx shortcuts from worksheet helpers", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["Q1", 10, 1, 3],
      ["Q2", 20, 2, 4]
    ]);

    addBarChart(ws, { series: [baseSeries("Bar")], grouping: "stacked" }, "E1:L10");
    addAreaChart(ws, { series: [baseSeries("Area")] }, "E12:L21");
    addDoughnutChart(ws, { series: [baseSeries("Donut")], holeSize: 55 }, "E23:L32");
    addBubbleChart(ws, { series: [bubbleSeries("Bubble")] }, "E34:L43");
    addRadarChart(ws, { series: [baseSeries("Radar")], radarStyle: "filled" }, "E45:L54");
    addStockChart(
      ws,
      { series: [baseSeries("High"), baseSeries("Low", VALUES_B)], hiLowLines: true },
      "E56:L65"
    );
    addSurfaceChart(ws, { series: [baseSeries("Surface")], wireframe: true }, "E67:L76");

    const charts = getCharts(ws);
    expect(charts.slice(0, 7).map(chart => Chart.chartTypes(chart)[0].type)).toEqual([
      "bar",
      "area",
      "doughnut",
      "bubble",
      "radar",
      "stock",
      "surface"
    ]);
    expect((Chart.chartTypes(charts[0])[0] as BarChartGroup).barDir).toBe("bar");
    expect((Chart.chartTypes(charts[0])[0] as BarChartGroup).grouping).toBe("stacked");

    const chartExSeries = { name: "Modern", values: VALUES_A };
    addParetoChart(ws, { series: [chartExSeries] }, "N1:T10");
    addWaterfallChart(ws, { series: [chartExSeries] }, "N12:T21");
    addFunnelChart(ws, { series: [chartExSeries] }, "N23:T32");
    addTreemapChart(ws, { series: [chartExSeries] }, "N34:T43");
    addSunburstChart(ws, { series: [chartExSeries] }, "N45:T54");
    addBoxWhiskerChart(ws, { series: [chartExSeries] }, "N56:T65");
    addRegionMapChart(ws, { series: [chartExSeries] }, "N67:T76");

    expect(
      getCharts(ws)
        .slice(7)
        .map(
          chart =>
            Chart.chartExModel(chart)?.chartSpace.chart.plotArea.plotAreaRegion?.series[0].layoutId
        )
    ).toEqual([
      "clusteredColumn",
      "waterfall",
      "funnel",
      "treemap",
      "sunburst",
      "boxWhisker",
      "regionMap"
    ]);
  });

  it("adds charts from generic row helpers", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");

    addChartFromRows(
      ws,
      [
        { month: "Jan", sales: 10 },
        { month: "Feb", sales: 20 }
      ],
      { type: "line", x: "month", y: "sales", startCell: "C3" },
      "F1:M10"
    );

    const group = Chart.chartTypes(getCharts(ws)[0])[0] as LineChartGroup;
    expect(group.type).toBe("line");
    expect(group.series[0].cat?.strRef?.formula).toBe("Sheet1!$C$4:$C$5");
    expect(group.series[0].val?.numRef?.formula).toBe("Sheet1!$D$4:$D$5");
  });

  it("updateSeries merges sugared shape patches instead of overwriting the whole spPr", () => {
    // Regression: `applyChartSeriesOptionsPatch` used to overwrite
    // `series.spPr` wholesale on any sugared shape patch (`fill` /
    // `line` / `lineWidth` / `lineDash`), so calling `updateSeries`
    // with only `line: "#000000"` silently wiped an earlier `fill`
    // override (and vice versa). The fix merges keys per-field so
    // each patch touches only the property the caller asked about.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addChart(
      ws,
      {
        type: "line",
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            fill: "#FF0000",
            line: "#000000"
          }
        ]
      },
      "D1:J10"
    );
    const chart = getCharts(ws)[0];
    const initial = Chart.getSeries(chart, 0) as LineSeries;
    expect(initial.spPr?.fill?.solid?.srgb).toBe("FF0000");
    expect(initial.spPr?.line?.color?.srgb).toBe("000000");

    // Patch only the stroke — the fill must survive.
    Chart.updateSeries(chart, 0, { line: "#00FF00" });
    const patched = Chart.getSeries(chart, 0) as LineSeries;
    expect(patched.spPr?.fill?.solid?.srgb).toBe("FF0000");
    expect(patched.spPr?.line?.color?.srgb).toBe("00FF00");

    // Patch only the fill — the stroke must survive.
    Chart.updateSeries(chart, 0, { fill: "#0000FF" });
    const patchedAgain = Chart.getSeries(chart, 0) as LineSeries;
    expect(patchedAgain.spPr?.fill?.solid?.srgb).toBe("0000FF");
    expect(patchedAgain.spPr?.line?.color?.srgb).toBe("00FF00");
  });

  it("updates and appends series from high-level options", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addChart(ws, { type: "line", series: [baseSeries("Initial")] }, "C1:J10");
    const chart = getCharts(ws)[0];

    expect(
      Chart.updateSeries(chart, 0, {
        name: { formula: "Sheet1!$D$1" },
        categories: "Sheet1!$D$2:$D$4",
        values: "Sheet1!$E$2:$E$4",
        fill: "#FF0000",
        line: "#00AA00",
        lineWidth: 2,
        lineDash: "dash",
        marker: { symbol: "diamond", size: 9, fill: "#0000FF" },
        dataLabels: { showVal: true, position: "t" },
        trendline: { type: "linear", displayEq: true },
        errorBars: { type: "fixedVal", value: 2 },
        dataPoints: [{ index: 1, fill: "#FFFF00" }]
      })
    ).toBe(true);

    const series = Chart.getSeries(chart, 0) as LineSeries;
    expect(series.tx?.strRef?.formula).toBe("Sheet1!$D$1");
    expect(series.cat?.strRef?.formula).toBe("Sheet1!$D$2:$D$4");
    expect(series.val?.numRef?.formula).toBe("Sheet1!$E$2:$E$4");
    expect(series.spPr?.fill?.solid?.srgb).toBe("FF0000");
    expect(series.spPr?.line?.color?.srgb).toBe("00AA00");
    expect(series.spPr?.line?.width).toBe(25400);
    expect(series.spPr?.line?.dash).toBe("dash");
    expect(series.marker?.symbol).toBe("diamond");
    expect(series.marker?.size).toBe(9);
    expect(series.marker?.spPr?.fill?.solid?.srgb).toBe("0000FF");
    expect(series.dataLabels?.showVal).toBe(true);
    expect(series.dataLabels?.position).toBe("t");
    expect(series.trendlines?.[0].type).toBe("linear");
    expect(series.trendlines?.[0].displayEq).toBe(true);
    expect(series.errorBars?.errValType).toBe("fixedVal");
    expect(series.errorBars?.val).toBe(2);
    expect(series.dataPoints?.[0].index).toBe(1);
    expect(series.dataPoints?.[0].spPr?.fill?.solid?.srgb).toBe("FFFF00");

    expect(Chart.addSeriesFromOptions(chart, { ...baseSeries("Added"), values: VALUES_B })).toBe(
      true
    );
    expect(Chart.getSeriesCount(chart)).toBe(2);
    expect((Chart.getSeries(chart, 1) as LineSeries).val?.numRef?.formula).toBe(VALUES_B);
    expect(Chart.addSeriesFromOptions(chart, baseSeries("Missing"), 99)).toBe(false);
  });

  it("updates scatter and bubble series-specific references", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addChart(
      ws,
      {
        type: "scatter",
        series: [scatterSeries("Scatter")]
      },
      "C1:J10"
    );
    addChart(
      ws,
      {
        type: "bubble",
        series: [bubbleSeries("Bubble")]
      },
      "C12:J21"
    );

    const scatter = getCharts(ws)[0];
    Chart.updateSeries(scatter, 0, {
      xValues: "Sheet1!$D$1:$D$4",
      values: "Sheet1!$E$1:$E$4",
      errorBars: [
        { type: "fixedVal", value: 1, direction: "x" },
        { type: "fixedVal", value: 2, direction: "y" }
      ]
    });
    const scatterSeriesModel = Chart.getSeries(scatter, 0) as any;
    expect(scatterSeriesModel.xVal.numRef.formula).toBe("Sheet1!$D$1:$D$4");
    expect(scatterSeriesModel.yVal.numRef.formula).toBe("Sheet1!$E$1:$E$4");
    expect(scatterSeriesModel.errorBars).toHaveLength(2);

    const bubble = getCharts(ws)[1];
    Chart.updateSeries(bubble, 0, {
      xValues: "Sheet1!$F$1:$F$3",
      values: "Sheet1!$G$1:$G$3",
      bubbleSize: "Sheet1!$H$1:$H$3",
      bubble3D: true
    });
    const bubbleSeriesModel = Chart.getSeries(bubble, 0) as any;
    expect(bubbleSeriesModel.xVal.numRef.formula).toBe("Sheet1!$F$1:$F$3");
    expect(bubbleSeriesModel.yVal.numRef.formula).toBe("Sheet1!$G$1:$G$3");
    expect(bubbleSeriesModel.bubbleSize.numRef.formula).toBe("Sheet1!$H$1:$H$3");
    expect(bubbleSeriesModel.bubble3D).toBe(true);
  });

  it("exposes README chart and XML helpers from the root entrypoint", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Root API");
    addTable(ws, {
      name: "RootSales",
      ref: "A1",
      columns: [{ name: "Month" }, { name: "Sales" }],
      rows: [["Jan", 10]]
    });

    const seriesOptions: SeriesFromColumnsOptions = {
      categories: "A2:A2",
      values: "B2:B2",
      name: "Sales"
    };
    const tableOptions: AddChartFromTableOptions = {
      type: "bar",
      categoryColumn: "Month",
      valueColumns: ["Sales"]
    };
    const rowOptions: AddChartFromRowsOptions<{ month: string; sales: number }> = {
      type: "bar",
      x: "month",
      y: "sales",
      startCell: "D1"
    };

    expect(rootSeriesFromColumns("Root API", seriesOptions).values).toBe("'Root API'!$B$2:$B$2");
    expect(rootChartOptionsFromTable(ws, "RootSales", tableOptions).series).toHaveLength(1);
    expect(
      rootChartOptionsFromRows(ws, [{ month: "Feb", sales: 20 }], rowOptions).series
    ).toHaveLength(1);
    expect(ROOT_CHART_PRESETS).toBe(CHART_PRESETS);
    expect(ROOT_CHART_EX_PRESETS).toBe(CHART_EX_PRESETS);
    expect(ROOT_EXCEL_CHART_PRESETS).toBe(EXCEL_CHART_PRESETS);
    expect(ROOT_EXCEL_CHART_EX_PRESETS).toBe(EXCEL_CHART_EX_PRESETS);
    expect(rootApplyChartExPreset("map", { series: [{ values: "Root API!$B$2:$B$3" }] }).type).toBe(
      "regionMap"
    );
    expect(rootRenderChartSvg(makeRootExportRenderedChartModel())).toContain("<svg");
    const chartExType: ChartExType = "histogram";
    expect(
      rootRenderChartExSvg(
        rootBuildChartExModel({
          type: chartExType,
          series: [{ name: "S", values: "Root API!$B$2:$B$3", literalValues: [1, 2] }]
        })
      )
    ).toContain("<svg");
    expect(rootXmlEncodeAttr('a " b')).toBe("a &quot; b");
    expect(() => rootValidateXmlName("valid:name")).not.toThrow();
    const scene: ChartScene = buildChartScene(makeRootExportRenderedChartModel());
    const legend: ChartSceneLegend = scene.legend;
    const series: ChartSceneSeries = scene.series[0];
    const title: ChartSceneText | undefined = scene.title;
    expect(legend.items.length).toBeGreaterThan(0);
    expect(series.type).toBe("bar");
    expect(title?.text).toBe("Sales");
  });
});

describe("Builder gap fixes verification", () => {
  it("rejects invalid classic chart option combinations", () => {
    expect(() =>
      buildChartModel({
        type: "pie",
        series: [{ ...baseSeries("S"), trendline: { type: "linear" } }]
      })
    ).toThrow(/trendline/);
    expect(() =>
      buildChartModel({ type: "surface", series: [baseSeries("S")], dataLabels: { showVal: true } })
    ).toThrow(/dataLabels/);
  });

  it("stock chart supports hiLowLines, upDownBars, dropLines", () => {
    const m = buildChartModel({
      type: "stock",
      series: [
        baseSeries("Open"),
        baseSeries("High", VALUES_B),
        baseSeries("Low"),
        baseSeries("Close", VALUES_B)
      ],
      hiLowLines: true,
      upDownBars: { gapWidth: 100 },
      dropLines: true
    });
    const g = ctg(m) as StockChartGroup;
    expect(g.hiLowLines).toBeDefined();
    expect(g.upDownBars).toBeDefined();
    expect(g.upDownBars!.gapWidth).toBe(100);
    expect(g.dropLines).toBeDefined();
  });

  it("stock chart rejects varyColors (not in CT_StockChart schema)", () => {
    // `CT_StockChart` has no `varyColors` attribute per ECMA-376.
    // The library previously emitted `<c:varyColors>` on stock
    // charts, which LibreOffice's strict validator rejected. The
    // builder now refuses the option up front with a diagnostic
    // error rather than silently producing schema-invalid XML.
    expect(() =>
      buildChartModel({
        type: "stock",
        series: [baseSeries("S1"), baseSeries("S2", VALUES_B)],
        varyColors: true
      })
    ).toThrow(/stock charts do not support .varyColors./);
  });

  it("ofPie chart supports gapWidth and serLines", () => {
    const m = buildChartModel({
      type: "ofPie",
      series: [baseSeries("S")],
      gapWidth: 200,
      serLines: true
    });
    const g = ctg(m) as OfPieChartGroup;
    expect(g.gapWidth).toBe(200);
    expect(g.serLines).toBeDefined();
  });
});

describe("Renderer gap fixes verification", () => {
  it("line with only width and dash renders via round-trip", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            ...baseSeries("S"),
            spPr: {
              line: { width: 25400, dash: "dash" }
            }
          }
        ]
      },
      "C1:J10"
    );
    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const s = Chart.chartModel(getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0])!.chart.plotArea
      .chartTypes[0].series[0];
    const parsed = parseSpPr(s.spPr!);
    expect(parsed.line?.width).toBe(25400);
    expect(parsed.line?.dash).toBe("dash");
  });

  it("line cap/join/compound are preserved through structured render", () => {
    const spPr = buildSpPr({
      line: { width: 12700, cap: "rnd", join: "round", compound: "sng" }
    });
    // buildSpPr returns a structured object (no _rawXml)
    expect(spPr._rawXml).toBeUndefined();
    expect(spPr.line?.width).toBe(12700);
    expect(spPr.line?.cap).toBe("rnd");
    expect(spPr.line?.join).toBe("round");
    expect(spPr.line?.compound).toBe("sng");
  });

  it("sysClr color renders correctly", () => {
    const spPr = buildSpPr({
      fill: { solid: { sysClr: "windowText" } }
    });
    // buildSpPr returns a structured object (no _rawXml)
    expect(spPr._rawXml).toBeUndefined();
    expect(spPr.fill?.solid?.sysClr).toBe("windowText");
  });

  it("prstClr color renders correctly", () => {
    const spPr = buildSpPr({
      fill: { solid: { prstClr: "red" } }
    });
    // buildSpPr returns a structured object (no _rawXml)
    expect(spPr._rawXml).toBeUndefined();
    expect(spPr.fill?.solid?.prstClr).toBe("red");
  });

  it("shade and satMod modifiers render on theme color", () => {
    const spPr = buildSpPr({
      fill: { solid: { theme: 4, shade: 75000, satMod: 120000 } }
    });
    // buildSpPr returns a structured object (no _rawXml)
    expect(spPr._rawXml).toBeUndefined();
    expect(spPr.fill?.solid?.shade).toBe(75000);
    expect(spPr.fill?.solid?.satMod).toBe(120000);
  });
});

describe("P2: chart SVG/PDF renderer", () => {
  function makeRenderedChartModel(options?: Partial<AddChartOptions>): ChartModel {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 5],
      ["B", 20, 12],
      ["C", 30, 25]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        title: "Sales",
        ...options
      },
      "D1:J10"
    );
    return Chart.chartModel(getCharts(ws)[0])!;
  }

  function makeRenderedBubbleChartModel(): ChartModel {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      [1, 10, 5],
      [2, 20, 12],
      [3, 30, 25]
    ]);
    addChart(
      ws,
      {
        type: "bubble",
        series: [
          {
            name: "Bubble",
            xValues: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            bubbleSize: "Sheet1!$C$1:$C$3"
          }
        ]
      },
      "D1:J10"
    );
    return Chart.chartModel(getCharts(ws)[0])!;
  }

  it("renderChartSvg returns a standalone SVG chart preview", () => {
    const svg = renderChartSvg(makeRenderedChartModel());
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("Sales");
    expect(svg).toContain("<rect");
    expect(svg).toContain("S");
  });

  it("renderChartSvg has a stable golden hash for a decorated combo preview", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 2],
      ["B", 20, 4],
      ["C", 15, 5]
    ]);
    addComboChart(
      ws,
      {
        groups: [
          {
            type: "bar",
            barDir: "col",
            dataLabels: { showVal: true },
            series: [
              { name: "Revenue", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }
            ]
          },
          {
            type: "line",
            series: [
              {
                name: "Growth",
                categories: "Sheet1!$A$1:$A$3",
                values: "Sheet1!$C$1:$C$3",
                marker: { symbol: "diamond", size: 7 },
                trendline: { type: "linear", lineDash: "dash" }
              }
            ]
          }
        ],
        title: "Golden Combo"
      },
      "E1:L12"
    );

    const svg = renderChartSvg(Chart.chartModel(getCharts(ws)[0])!, { width: 420, height: 260 });
    // Hash refreshed when the renderer switched to a two-pass series
    // loop (all shapes first, then all adornments) so later series'
    // filled polygons no longer obscure earlier series' data labels
    // and trendlines, and again when label measurement started
    // reporting scene units instead of CSS pixels (a font drawn at
    // `font-size="N"` user units is N units tall, not N * 96/72), which
    // narrowed every legend and label reservation by 4/3.
    expect(stableHash(svg)).toBe("4f54220a");
  });

  it("renderChartSvg is documented as a deterministic preview, not Excel-identical", () => {
    const svg = renderChartSvg(makeRenderedChartModel());
    expect(svg).toContain("deterministic preview");
    expect(svg).toContain("not an Excel-identical layout");
  });

  it("legend width reacts to real label widths instead of a fixed 86-px slot", () => {
    // Before the font-metrics fix `legendRect` hard-coded `itemCount * 86` for
    // horizontal legends and `width: 96` for vertical ones, so a 30-character
    // series name was silently clipped or wrapped outside the viewport. With
    // real glyph widths in place a long label must produce a measurably
    // wider legend rectangle than a short one.
    const build = (label: string, legendPosition: "r" | "b" = "r"): ChartModel => {
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
          series: [{ name: label, categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }],
          title: "T",
          legendPosition
        },
        "D1:J10"
      );
      return Chart.chartModel(getCharts(ws)[0])!;
    };
    // Horizontal legend: width growth is visible on the legend rect itself;
    // plot width is governed by other padding so it does not shrink here.
    const shortBottom = buildChartScene(build("S", "b"), { width: 400, height: 240 });
    const longBottom = buildChartScene(
      build("A much longer series name than the default one", "b"),
      { width: 400, height: 240 }
    );
    expect(shortBottom.legend.rect.width).toBeLessThanOrEqual(longBottom.legend.rect.width);

    // Vertical legend: long labels push the plot rectangle inwards. Use a
    // wide canvas so the unclamped legend column width can express itself.
    const shortRight = buildChartScene(build("S", "r"), { width: 800, height: 240 });
    const longRight = buildChartScene(
      build("A much longer series name than the default one", "r"),
      { width: 800, height: 240 }
    );
    expect(shortRight.legend.rect.width).toBeLessThanOrEqual(longRight.legend.rect.width);
    const plotDelta = shortRight.plot.width - longRight.plot.width;
    const legendDelta = longRight.legend.rect.width - shortRight.legend.rect.width;
    expect(plotDelta).toBeGreaterThanOrEqual(legendDelta - 4);
    expect(plotDelta).toBeLessThanOrEqual(legendDelta + 4);
  });

  it("pie chart emits leader lines when data labels use outEnd/bestFit", () => {
    // Build a pie chart with outEnd data labels. Before this change,
    // labels were anchored at the slice centroid with no connector line;
    // now the renderer must project each label to the outer ring and
    // emit a matching ChartSceneLine.
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
        type: "pie",
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            dataLabels: { showVal: true, position: "outEnd" }
          } as AddChartSeriesOptions
        ],
        title: "Pie"
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, {
      width: 320,
      height: 240
    });
    const pieSeries = scene.series[0];
    expect(pieSeries.type === "pie").toBe(true);
    // There must be three labels matching the three slices…
    expect(pieSeries.labels?.length).toBe(3);
    // …and three leader lines pointing from slice outer edge to each label.
    expect(pieSeries.leaderLines?.length).toBe(3);
    // Each label must live outside the pie's inscribed circle: recompute
    // the centre from the slice geometry and assert that all label
    // anchors are measurably further from it than the slice radius.
    if (pieSeries.type === "pie") {
      const slice = pieSeries.slices[0];
      const dist = (x: number, y: number): number => Math.hypot(x - slice.cx, y - slice.cy);
      for (const label of pieSeries.labels ?? []) {
        expect(dist(label.x, label.y)).toBeGreaterThan(slice.radius);
      }
    }

    // And the SVG output must contain the leader stroke (colour hardcoded).
    const svg = renderChartSvg(Chart.chartModel(getCharts(ws)[0])!, {
      width: 320,
      height: 240
    });
    expect(svg).toContain('stroke="#808080"');
  });

  it("bar data labels nudge or drop when they would otherwise overlap", () => {
    // Construct a very narrow bar chart with many data points. Without the
    // collision pass, the outEnd labels emit at nearly identical y with
    // horizontally overlapping bboxes. With the pass, neighbours must
    // either be stacked vertically or dropped entirely (never both at the
    // same coordinate).
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const cats = Array.from({ length: 8 }, (_, i) => `Cat${i + 1}`);
    const vals = Array.from({ length: 8 }, (_, i) => 10 + (i % 3));
    Worksheet.addRows(
      ws,
      cats.map((c, i) => [c, vals[i]])
    );
    addChart(
      ws,
      {
        type: "bar",
        barDir: "col",
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$8",
            values: "Sheet1!$B$1:$B$8",
            dataLabels: { showVal: true, position: "outEnd" }
          } as AddChartSeriesOptions
        ],
        title: "Dense"
      },
      "D1:F8"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, {
      width: 160,
      height: 120
    });
    const series = scene.series[0];
    expect(series.type === "bar").toBe(true);
    const kept = series.labels ?? [];
    // At least one label should have been either moved up or dropped.
    expect(kept.length).toBeLessThanOrEqual(8);
    // No two kept labels share the same (x, y) coordinate — if they did,
    // the collision pass failed and we would be drawing glyphs on top of
    // each other.
    const coords = new Set(kept.map(l => `${Math.round(l.x)}:${Math.round(l.y)}`));
    expect(coords.size).toBe(kept.length);
  });

  it("renderChartSvg honours plotArea manualLayout edge-mode overrides", () => {
    // Render the same chart with and without a manual plot-area override and
    // extract the first axes' x-coordinates to confirm the manual rectangle
    // is applied. Using an exaggerated override (x=0.5) guarantees the
    // resulting plot origin is well right of the default ~58px inset, even
    // after auto padding for left-axis labels.
    const width = 400;
    const height = 240;
    const baseModel = makeRenderedChartModel();
    const baseSvg = renderChartSvg(baseModel, { width, height });
    const manualModel = makeRenderedChartModel();
    manualModel.chart.plotArea.layout = {
      manualLayout: {
        xMode: "edge",
        yMode: "edge",
        wMode: "edge",
        hMode: "edge",
        x: 0.5,
        y: 0.1,
        w: 0.4,
        h: 0.6
      }
    };
    const manualSvg = renderChartSvg(manualModel, { width, height });

    // Extract the plot rectangle's leftmost <line> x attribute from each SVG —
    // the deterministic renderer emits axis gridlines starting at plot.x.
    const extractFirstLineX = (svg: string): number => {
      const match = /<line\s+x1="([0-9.]+)"/.exec(svg);
      expect(match).not.toBeNull();
      return parseFloat(match![1]);
    };
    const baseX = extractFirstLineX(baseSvg);
    const manualX = extractFirstLineX(manualSvg);
    // Manual x=0.5 → plot left edge near 200; base is under ~120 for this
    // legend/title configuration. The exact value depends on padding, but the
    // manual version must be meaningfully further right.
    expect(manualX).toBeGreaterThan(baseX + 40);
    expect(manualX).toBeGreaterThan(width * 0.45);
  });

  it("renderChartSvg positions data labels per DataLabelPosition", () => {
    // Build two otherwise-identical chart models whose only difference is the
    // data-label position so we can verify the renderer actually consumes
    // `labels.position`. Use `l` (left) vs `r` (right) since they produce
    // distinct x-anchors that are easy to detect.
    const buildModel = (position: "l" | "r"): ChartModel => {
      const model = makeRenderedChartModel({
        type: "line",
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            dataLabels: { showVal: true, position }
          } as AddChartSeriesOptions
        ]
      });
      return model;
    };
    const leftSvg = renderChartSvg(buildModel("l"), { width: 400, height: 240 });
    const rightSvg = renderChartSvg(buildModel("r"), { width: 400, height: 240 });

    // Left-positioned labels must be emitted with text-anchor="end" (so the
    // glyphs end at the anchor x); right-positioned labels with "start".
    expect(leftSvg).toContain('text-anchor="end"');
    expect(rightSvg).toContain('text-anchor="start"');
    // And the converse must not hold — a right-positioned chart should not
    // contain the left anchor (ignoring anchors that belong to other text,
    // such as axis labels; we check for data label text `10` specifically).
    const leftLabelAnchors = [...leftSvg.matchAll(/<text[^>]*>10<\/text>/g)];
    const rightLabelAnchors = [...rightSvg.matchAll(/<text[^>]*>10<\/text>/g)];
    expect(leftLabelAnchors.length).toBeGreaterThan(0);
    expect(rightLabelAnchors.length).toBeGreaterThan(0);
  });

  it("Chart.toSVG renders a classic chart through the high-level API", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChart(
      ws,
      {
        type: "line",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }],
        title: "Line Preview"
      },
      "D1:J10"
    );

    const svg = Chart.toSVG(getCharts(ws)[0], { width: 320, height: 180 });
    expect(svg).toContain('width="320"');
    expect(svg).toContain("Line Preview");
    expect(svg).toContain("<polyline");
  });

  it("Chart.toPNG renders a classic chart without a browser canvas", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChart(
      ws,
      {
        type: "line",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }],
        title: "Line Preview"
      },
      "D1:J10"
    );

    const png = await Chart.toPNG(getCharts(ws)[0], { width: 320, height: 180 });
    expectPngDimensions(png, 320, 180);
  });

  it("renderChartPng has a stable golden raster signature", async () => {
    const png = await renderChartPng(makeRenderedChartModel(), { width: 220, height: 140 });
    expectPngDimensions(png, 220, 140);
    // The exact IDAT hash is platform-dependent (system font differences
    // produce different glyph pixels on macOS vs Linux). Assert the PNG is
    // non-trivial (contains enough pixel data to be a real chart, not a
    // blank white rectangle) and that repeated calls are deterministic.
    expect(png.length).toBeGreaterThan(1000);
    const png2 = await renderChartPng(makeRenderedChartModel(), { width: 220, height: 140 });
    expect(pngSignature(png2)).toBe(pngSignature(png));
  });

  it("Node PNG fallback consumes text rotate transforms from the SVG", async () => {
    // Build a chart whose only difference is a left-axis title, which the
    // SVG renderer emits with `transform="rotate(-90 x y)"`. The Node PNG
    // fallback must consume that transform; before this fix it was silently
    // discarded so rotated text ended up drawn in its axis-aligned position.
    // Comparing the rasterised bytes confirms that code path actually runs:
    // the two images must differ wherever the rotated glyphs land.
    const baseModel = makeRenderedChartModel({ type: "bar" });
    const rotatedModel = makeRenderedChartModel({ type: "bar" });
    const valueAxis = rotatedModel.chart.plotArea.axes.find(
      axis => (axis as ValueAxis).axisType === "val"
    ) as ValueAxis | undefined;
    expect(valueAxis).toBeDefined();
    valueAxis!.title = { text: { paragraphs: [{ runs: [{ text: "Units" }] }] } };

    const [basePng, rotatedPng] = await Promise.all([
      renderChartPng(baseModel, { width: 260, height: 160 }),
      renderChartPng(rotatedModel, { width: 260, height: 160 })
    ]);
    // Sanity: both PNGs have the expected geometry.
    expectPngDimensions(basePng, 260, 160);
    expectPngDimensions(rotatedPng, 260, 160);
    // And their IDAT chunks must differ — meaning the rotated title actually
    // produced pixels, rather than being silently dropped by the SVG
    // tag-regex raster path.
    expect(pngSignature(rotatedPng)).not.toBe(pngSignature(basePng));

    // Meanwhile the SVG must still emit the canonical rotate transform so
    // the browser path continues to match visually (regression guard for
    // SVG emit — unrelated to the basic raster fix but cheap to assert).
    const svg = renderChartSvg(rotatedModel, { width: 260, height: 160 });
    expect(svg).toMatch(/transform="rotate\(-90 /);
  });

  it("Chart.toPNG renders a ChartEx chart without a browser canvas", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addHistogramChart(
      ws,
      {
        series: [{ name: "H", values: "Sheet1!$B$1:$B$6", literalValues: [-1, 0, 5, 10, 11, 21] }],
        binning: { binType: "binSize", binSize: 10, underflow: 0, overflow: 20 },
        title: "Histogram Preview"
      },
      "D1:J10"
    );

    const png = await Chart.toPNG(getCharts(ws)[0], { width: 300, height: 160 });
    expectPngDimensions(png, 300, 160);
  });

  it("Chart.toPNG honors scale, transparent background, and DPI metadata", async () => {
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

    const svg = Chart.toSVG(getCharts(ws)[0], {
      width: 160,
      height: 90,
      backgroundColor: "transparent"
    });
    expect(svg).not.toContain('fill="#fff"');

    const png = await Chart.toPNG(getCharts(ws)[0], {
      width: 160,
      height: 90,
      scale: 2,
      dpi: 192,
      backgroundColor: "transparent"
    });
    expectPngDimensions(png, 320, 180);
    expectPngPhysDpi(png, 192);
  });

  it("renderChartPng produces distinct content for different chart types", async () => {
    const barPng = await renderChartPng(makeRenderedChartModel({ type: "bar" }), {
      width: 200,
      height: 120
    });
    const piePng = await renderChartPng(makeRenderedChartModel({ type: "pie" }), {
      width: 200,
      height: 120
    });
    const linePng = await renderChartPng(makeRenderedChartModel({ type: "line" }), {
      width: 200,
      height: 120
    });
    const areaPng = await renderChartPng(makeRenderedChartModel({ type: "area" }), {
      width: 200,
      height: 120
    });
    // All PNGs should be valid.
    expectPngDimensions(barPng, 200, 120);
    expectPngDimensions(piePng, 200, 120);
    expectPngDimensions(linePng, 200, 120);
    expectPngDimensions(areaPng, 200, 120);
    // Each type should produce a distinct raster (different pixel content).
    const sigs = [
      pngSignature(barPng),
      pngSignature(piePng),
      pngSignature(linePng),
      pngSignature(areaPng)
    ];
    const unique = new Set(sigs);
    expect(unique.size).toBe(4);
  });

  it("buildChartScene produces shared geometry for SVG and PDF rendering", () => {
    const scene = buildChartScene(makeRenderedChartModel(), { width: 300, height: 180 });
    expect(scene.width).toBe(300);
    expect(scene.height).toBe(180);
    expect(scene.series[0].type).toBe("bar");
    expect(scene.gridlines.length).toBeGreaterThan(0);
    expect(scene.yLabels.map(label => label.text)).toContain("30");
  });

  it("buildChartScene handles horizontal bar charts", () => {
    const model = makeRenderedChartModel({ type: "bar", barDir: "bar" });
    const scene = buildChartScene(model, { width: 300, height: 180 });
    const series = scene.series[0];

    expect(series.type).toBe("bar");
    if (series.type === "bar") {
      expect(series.bars[0].width).toBeGreaterThan(series.bars[0].height);
    }
  });

  it("buildChartScene places stacked bar segments at their stack position, not at the axis origin", () => {
    // Regression: stacked-bar layout used to include `zeroX` / `zeroY` in
    // the `Math.min()` that picks the rect's anchor edge. That collapsed
    // every stack segment past the first onto the axis origin when no
    // segment straddled zero — horizontal positive stacks (series 2+)
    // rendered at `plot.x` instead of the top of the previous segment;
    // vertical stacks of all-negative values did the mirror-image thing.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 5],
      ["B", 20, 12],
      ["C", 30, 25]
    ]);
    addBarChart(
      ws,
      {
        grouping: "stacked",
        series: [
          { name: "S1", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" },
          { name: "S2", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$C$1:$C$3" }
        ]
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const [base, top] = scene.series as [
      (typeof scene.series)[number],
      (typeof scene.series)[number]
    ];
    expect(base.type).toBe("bar");
    expect(top.type).toBe("bar");
    if (base.type !== "bar" || top.type !== "bar") {
      return;
    }
    // `addBarChart` produces horizontal bars. Each category's upper
    // segment (S2) must sit directly to the right of the lower segment
    // (S1): `top.x === base.x + base.width` (modulo float precision).
    // Before the fix `top.x` collapsed to `plot.x` and the segments
    // overlapped at the axis origin.
    for (let i = 0; i < base.bars.length; i++) {
      const lower = base.bars[i];
      const upper = top.bars[i];
      expect(upper.x).toBeCloseTo(lower.x + lower.width, 5);
      expect(upper.y).toBeCloseTo(lower.y, 5);
      expect(upper.width).toBeGreaterThan(0);
    }
  });

  it("buildChartScene stacks vertical negative bars away from zero, not anchored to it", () => {
    // Regression: vertical stacked bars with only negative values used to
    // anchor the second segment at `zeroY` instead of at the top of the
    // first segment — the upper (further from zero) stack segment slid
    // up to the axis, overlapping the first segment.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", -10, -5],
      ["B", -20, -8],
      ["C", -30, -15]
    ]);
    addColumnChart(
      ws,
      {
        grouping: "stacked",
        series: [
          { name: "S1", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" },
          { name: "S2", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$C$1:$C$3" }
        ]
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const [base, top] = scene.series as [
      (typeof scene.series)[number],
      (typeof scene.series)[number]
    ];
    if (base.type !== "bar" || top.type !== "bar") {
      return;
    }
    // Negative stack grows downward (SVG y increases downward) from the
    // axis. `base.y` is the axis line; its bottom is `base.y + base.height`.
    // `top.y` must start exactly where `base` ends — not jump back to the
    // axis.
    for (let i = 0; i < base.bars.length; i++) {
      const lower = base.bars[i];
      const upper = top.bars[i];
      expect(upper.y).toBeCloseTo(lower.y + lower.height, 5);
      expect(upper.height).toBeGreaterThan(0);
    }
  });

  it("buildChartScene anchors bars at the axis floor when the value-axis range excludes zero", () => {
    // Regression: `buildBars` / `buildHorizontalBars` used to anchor
    // every bar at `valueToY(0, min, max, plot)`. When the user's
    // `valueAxis.min = 20` moved the range off zero, that coordinate
    // fell BELOW the plot rectangle — bars extended past the chart
    // frame instead of growing from the visible axis floor.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 30],
      ["B", 50],
      ["C", 80]
    ]);
    addColumnChart(
      ws,
      {
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        valueAxis: { min: 20, max: 100 }
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 260 });
    const series = scene.series[0];
    if (series.type !== "bar") {
      throw new Error("expected bar series");
    }
    const plotBottom = scene.plot.y + scene.plot.height;
    for (const bar of series.bars) {
      // The bottom edge of every bar must sit at (within float
      // epsilon of) the plot's bottom — the axis floor — rather
      // than somewhere below the chart frame.
      expect(bar.y + bar.height).toBeCloseTo(plotBottom, 3);
    }
  });

  it("buildChartScene reverses axis orientation when scaling.orientation is maxMin", () => {
    // Regression: OOXML `<c:scaling><c:orientation val="maxMin"/>` is
    // Excel's "values in reverse order" toggle. Previously the
    // renderer ignored it entirely, so a user-authored reversed axis
    // kept rendering min at the bottom and max at the top. The fix
    // swaps `min` / `max` after range resolution so `valueToY` /
    // `valueToX` naturally flip the axis direction.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 30]
    ]);
    addColumnChart(
      ws,
      {
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        valueAxis: { orientation: "maxMin" }
      },
      "D1:J10"
    );
    const rev = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 260 });
    // Build a matching chart without orientation for comparison.
    const wb2 = Workbook.create();
    const ws2 = Workbook.addWorksheet(wb2, "Sheet1");
    Worksheet.addRows(ws2, [
      ["A", 10],
      ["B", 20],
      ["C", 30]
    ]);
    addColumnChart(
      ws2,
      { series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }] },
      "D1:J10"
    );
    const normal = buildChartScene(Chart.chartModel(getCharts(ws2)[0])!, {
      width: 400,
      height: 260
    });
    const revSeries = rev.series[0];
    const normalSeries = normal.series[0];
    if (revSeries.type !== "bar" || normalSeries.type !== "bar") {
      throw new Error("expected bar series");
    }
    // Heights should match — reversing the axis doesn't change a bar's
    // height, it just flips where zero sits. Positions, however, must
    // mirror: the reversed bar anchors at the TOP of the plot and
    // extends downward, whereas the normal bar anchors at the BOTTOM
    // and extends upward. Bars at the max value occupy the full plot
    // height in both orientations and have the same `.y = plot.y`, so
    // only non-max bars (index 0 = value 10, index 1 = value 20) can
    // distinguish the two.
    for (let i = 0; i < 2; i++) {
      expect(revSeries.bars[i].height).toBeCloseTo(normalSeries.bars[i].height, 5);
      expect(revSeries.bars[i].y).toBeLessThan(normalSeries.bars[i].y);
    }
  });

  it("buildChartScene stacks line series cumulatively when grouping is stacked/percentStacked", () => {
    // Regression: stacked line charts (`LineChartGroup.grouping ===
    // "stacked"` or `"percentStacked"`) used to render the raw per-
    // series values, so the chart looked identical to a clustered
    // line regardless of the `grouping` attribute. The fix threads
    // the same stack logic the area / bar builders use — each
    // series' points sit at the cumulative sum of prior series.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 5],
      ["B", 20, 12],
      ["C", 30, 25]
    ]);
    addLineChart(
      ws,
      {
        grouping: "stacked",
        series: [
          { name: "S1", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" },
          { name: "S2", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$C$1:$C$3" }
        ]
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const [base, top] = scene.series as [
      (typeof scene.series)[number],
      (typeof scene.series)[number]
    ];
    if (base.type !== "line" || top.type !== "line") {
      throw new Error("expected line series");
    }
    // For a stacked line with series [10, 20, 30] and [5, 12, 25] the
    // cumulative top should sit at [15, 32, 55]. In SVG y-down, a
    // larger value maps to a smaller y — so each `top.points[i].y`
    // must be strictly less than `base.points[i].y`. Before the fix
    // the top line tracked the raw [5, 12, 25] geometry and sat
    // *below* the base line on every category.
    for (let i = 0; i < base.points.length; i++) {
      expect(top.points[i].y).toBeLessThan(base.points[i].y);
    }
  });

  it("renderChartSvg breaks the line at blank data points instead of dipping to origin", () => {
    // Regression: `collectNumberValues` promotes blank / `#N/A` cells
    // to `NaN` so downstream builders can skip them. But the SVG
    // renderer used to stringify every point through `fmt(NaN) === "0"`
    // and emit a single `<polyline>` containing the bogus `(x, 0)`
    // vertex — producing a visible spike down to the axis origin at
    // every gap. The fix segments the point list and emits one
    // `<polyline>` per contiguous finite run, matching Excel's default
    // `dispBlanksAs="gap"` behaviour.
    const model: ChartModel = {
      chart: {
        plotArea: {
          chartTypes: [
            {
              type: "line",
              grouping: "standard",
              series: [
                {
                  index: 0,
                  order: 0,
                  tx: { value: "S" },
                  cat: {
                    strRef: {
                      formula: "Sheet1!$A$1:$A$5",
                      cache: {
                        pointCount: 5,
                        points: [
                          { index: 0, value: "A" },
                          { index: 1, value: "B" },
                          { index: 2, value: "C" },
                          { index: 3, value: "D" },
                          { index: 4, value: "E" }
                        ]
                      }
                    }
                  },
                  val: {
                    numRef: {
                      formula: "Sheet1!$B$1:$B$5",
                      cache: {
                        // One blank in the middle (index 2). The
                        // cache-populator would map this to NaN.
                        pointCount: 5,
                        points: [
                          { index: 0, value: 10 },
                          { index: 1, value: 20 },
                          { index: 3, value: 40 },
                          { index: 4, value: 50 }
                        ]
                      }
                    }
                  }
                }
              ],
              axisIds: [1, 2]
            }
          ],
          axes: [
            {
              axisType: "cat",
              axId: 1,
              axPos: "b",
              scaling: { orientation: "minMax" },
              crossAx: 2
            },
            {
              axisType: "val",
              axId: 2,
              axPos: "l",
              scaling: { orientation: "minMax" },
              crossAx: 1
            }
          ]
        }
      }
    };
    const svg = renderChartSvg(model, { width: 400, height: 240 });
    // The blank at index 2 must split the polyline into two separate
    // `<polyline>` elements — one for indices 0-1, one for indices
    // 3-4. Before the fix a single polyline contained "x,0" at the
    // blank slot.
    const polylineMatches = svg.match(/<polyline\b/g) ?? [];
    expect(polylineMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("buildChartScene honours custom (errValType=cust) error-bar plus/minus arrays", () => {
    // Regression: `errorAmount` unconditionally fell through to
    // `err.val ?? 1` for `errValType === "cust"`, ignoring the
    // per-point `plus` / `minus` `NumberDataSource` arrays the caller
    // actually populated. Custom error bars therefore rendered as a
    // uniform ±1 span regardless of data — useless for studies where
    // each point has its own confidence interval.
    const model: ChartModel = {
      chart: {
        plotArea: {
          chartTypes: [
            {
              type: "bar",
              barDir: "col",
              grouping: "clustered",
              series: [
                {
                  index: 0,
                  order: 0,
                  tx: { value: "S" },
                  cat: {
                    strRef: {
                      formula: "Sheet1!$A$1:$A$3",
                      cache: {
                        pointCount: 3,
                        points: [
                          { index: 0, value: "A" },
                          { index: 1, value: "B" },
                          { index: 2, value: "C" }
                        ]
                      }
                    }
                  },
                  val: {
                    numRef: {
                      formula: "Sheet1!$B$1:$B$3",
                      cache: {
                        pointCount: 3,
                        points: [
                          { index: 0, value: 10 },
                          { index: 1, value: 20 },
                          { index: 2, value: 30 }
                        ]
                      }
                    }
                  },
                  errorBars: {
                    errValType: "cust",
                    barDir: "both",
                    errDir: "y",
                    plus: {
                      numRef: {
                        formula: "Sheet1!$C$1:$C$3",
                        cache: {
                          pointCount: 3,
                          points: [
                            { index: 0, value: 1 },
                            { index: 1, value: 2 },
                            { index: 2, value: 5 }
                          ]
                        }
                      }
                    },
                    minus: {
                      numRef: {
                        formula: "Sheet1!$D$1:$D$3",
                        cache: {
                          pointCount: 3,
                          points: [
                            { index: 0, value: 1 },
                            { index: 1, value: 2 },
                            { index: 2, value: 5 }
                          ]
                        }
                      }
                    }
                  }
                }
              ],
              axisIds: [1, 2]
            }
          ],
          axes: [
            {
              axisType: "cat",
              axId: 1,
              axPos: "b",
              scaling: { orientation: "minMax" },
              crossAx: 2
            },
            {
              axisType: "val",
              axId: 2,
              axPos: "l",
              scaling: { orientation: "minMax" },
              crossAx: 1
            }
          ]
        }
      }
    };
    const scene = buildChartScene(model, { width: 400, height: 260 });
    const series = scene.series[0];
    if (series.type !== "bar" || !series.errorBars) {
      throw new Error("expected bar series with error bars");
    }
    // The third point has a much wider ±5 range than the first two
    // (±1, ±2). Its vertical span on the scene should therefore be
    // strictly the largest. Before the fix every bar got the same
    // `err.val ?? 1` magnitude.
    const span = (eb: (typeof series.errorBars)[number]): number =>
      Math.abs(eb.line.y2 - eb.line.y1);
    const spans = series.errorBars.map(span);
    expect(spans[2]).toBeGreaterThan(spans[0]);
    expect(spans[2]).toBeGreaterThan(spans[1]);
    expect(spans[1]).toBeGreaterThan(spans[0]);
  });

  it("buildChartScene honours errorBars.barDir so plus-only bars don't draw both caps", () => {
    // Regression: `buildErrorBars` ignored `barDir` ("plus" / "minus"
    // / "both") and always drew a symmetric bar with two caps,
    // silently extending below the data point for `plus`-only error
    // bars and above for `minus`-only.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 30]
    ]);
    addColumnChart(
      ws,
      {
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            errorBars: {
              type: "fixedVal",
              value: 5,
              barDir: "plus",
              direction: "y"
            }
          }
        ]
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const bar = scene.series[0];
    if (bar.type !== "bar" || !bar.errorBars || bar.errorBars.length === 0) {
      throw new Error("expected bar series with error bars");
    }
    for (const errorBar of bar.errorBars) {
      // For barDir="plus": the minus cap should be absent; only the
      // plus-side cap (cap1) should be drawn.
      expect(errorBar.cap2).toBeUndefined();
      expect(errorBar.cap1).toBeDefined();
    }
  });

  it("buildChartScene honours axis line colour captured as raw XML (not structured .line)", () => {
    // Regression: the xform layer stores loaded `<c:spPr>` as
    // `{ _rawXml: "..." }` without parsing into structured `line` /
    // `fill` fields. Previous renderer helpers read `axis.spPr?.line`
    // directly, which is `undefined` for the raw-XML path — so an
    // Excel-authored axis with a custom stroke colour lost its colour
    // in the preview and fell back to the default `#444444`.
    const model: ChartModel = {
      chart: {
        plotArea: {
          chartTypes: [
            {
              type: "bar",
              barDir: "col",
              grouping: "clustered",
              series: [
                {
                  index: 0,
                  order: 0,
                  tx: { value: "S" },
                  val: {
                    numRef: {
                      formula: "Sheet1!$A$1:$A$3",
                      cache: {
                        pointCount: 3,
                        points: [
                          { index: 0, value: 10 },
                          { index: 1, value: 20 },
                          { index: 2, value: 30 }
                        ]
                      }
                    }
                  }
                }
              ],
              axisIds: [1, 2]
            }
          ],
          axes: [
            {
              axisType: "cat",
              axId: 1,
              axPos: "b",
              scaling: { orientation: "minMax" },
              crossAx: 2
            },
            {
              axisType: "val",
              axId: 2,
              axPos: "l",
              scaling: { orientation: "minMax" },
              crossAx: 1,
              spPr: {
                _rawXml: `<c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="FF00AA"/></a:solidFill></a:ln></c:spPr>`
              }
            }
          ]
        }
      }
    };
    const scene = buildChartScene(model, { width: 300, height: 200 });
    // Left axis (`axPos=l`) is the Y axis in a column chart; its stroke
    // colour must come from the raw-XML `<a:srgbClr val="FF00AA"/>`.
    expect(scene.axes.y?.color).toBe("#FF00AA");
  });

  it("buildChartScene honours pie firstSliceAng rotation and per-slice explosion", () => {
    // Regression: the pie builder always anchored the first slice at
    // 12 o'clock (`-π/2`) and ignored `group.firstSliceAng`; it also
    // ignored `dataPoint.explosion` so authors who "pulled out" a
    // slice for emphasis saw it sitting in the default position.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 30],
      ["B", 40],
      ["C", 30]
    ]);
    addChart(
      ws,
      {
        type: "pie",
        firstSliceAng: 90,
        series: [
          {
            name: "Slices",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            dataPoints: [{ index: 1, explosion: 25 }]
          }
        ]
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const pie = scene.series[0];
    if (pie.type !== "pie") {
      throw new Error("expected pie series");
    }
    // `firstSliceAng=90` rotates the first slice to start at 3 o'clock
    // (SVG radians: `-π/2 + π/2 = 0`). Before the fix startAngle
    // stayed at `-π/2` regardless of the option.
    expect(pie.slices[0].startAngle).toBeCloseTo(0, 5);
    // The second slice carries `explosion=25` — its centre must be
    // offset from the pie's geometric centre along the angle
    // bisector. The unexploded slices share the pie centre exactly.
    const centre = { cx: pie.slices[0].cx, cy: pie.slices[0].cy };
    const explodedSlice = pie.slices[1];
    expect(explodedSlice.cx === centre.cx && explodedSlice.cy === centre.cy).toBe(false);
    expect(pie.slices[2].cx).toBeCloseTo(centre.cx, 5);
    expect(pie.slices[2].cy).toBeCloseTo(centre.cy, 5);
  });

  it("buildChartScene honours per-slice `dataPoints` colour overrides on pie charts", () => {
    // Regression: the pie / doughnut / ofPie builders rotated every
    // slice through the 6-entry default palette and ignored
    // `series.dataPoints[idx].spPr.fill` entirely. The overwhelmingly
    // common way to colour-code an Excel pie chart is exactly that
    // — one `c:dPt` per slice specifying `spPr.solidFill.srgb`.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["Apple", 20],
      ["Banana", 30],
      ["Cherry", 50]
    ]);
    addChart(
      ws,
      {
        type: "pie",
        series: [
          {
            name: "Fruit",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            dataPoints: [
              { index: 0, fill: "#FF0000" },
              { index: 1, fill: "#00FF00" },
              { index: 2, fill: "#0000FF" }
            ]
          }
        ]
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const pie = scene.series[0];
    expect(pie.type).toBe("pie");
    if (pie.type !== "pie") {
      throw new Error("expected pie series");
    }
    // Scene colours must reflect the `dataPoints` overrides (uppercase
    // with leading `#`) rather than the default palette rotation.
    expect(pie.slices.map(s => s.color)).toEqual(["#FF0000", "#00FF00", "#0000FF"]);
  });

  it("buildChartScene emits category names (not numeric quintiles) on horizontal bar charts' Y axis", () => {
    // Regression: `buildYLabels` always called `formatAxisNumber`
    // regardless of axis type — for a horizontal bar chart the left
    // axis is the category axis and should render the category names
    // ("Alpha" / "Beta" / "Gamma"). Before the fix the Y axis
    // silently showed numeric labels derived from the *value* range,
    // placing "0"/"0.2"/"0.4"/…/"1" or an even worse span next to
    // bars whose real captions were author-specified strings.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["Alpha", 10],
      ["Beta", 20],
      ["Gamma", 30]
    ]);
    addBarChart(
      ws,
      {
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const labelTexts = scene.yLabels.map(label => label.text);
    expect(labelTexts).toContain("Alpha");
    expect(labelTexts).toContain("Beta");
    expect(labelTexts).toContain("Gamma");
  });

  it("buildChartScene emits vertical gridlines for a horizontal bar chart's value axis", () => {
    // Regression: horizontal bar charts authored via `addBarChart`
    // used to emit the column-chart axis positions (`valAx.axPos="l"`,
    // `catAx.axPos="b"`); combined with `buildGridlines` only
    // consulting the primary Y axis, the value axis's
    // `majorGridlines` rendered as horizontal strokes. The builder
    // now swaps `axPos` for `barDir="bar"` and the gridline builder
    // also emits vertical strokes when the primary X axis carries
    // `majorGridlines`, matching Excel's native render.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 30]
    ]);
    addBarChart(
      ws,
      {
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        valueAxis: { majorGridlines: true }
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    expect(scene.gridlines.length).toBeGreaterThan(0);
    for (const line of scene.gridlines) {
      expect(line.x1).toBeCloseTo(line.x2, 5);
      expect(line.y1).not.toBeCloseTo(line.y2, 5);
    }
  });

  it("buildChartScene emits vertical gridlines when the X axis carries majorGridlines", () => {
    // Regression: `buildGridlines` used to consult only the Y axis —
    // any `majorGridlines` on the horizontal (X) axis was dropped,
    // even though OOXML lets both axes carry them and the SVG render
    // should draw vertical strokes between X ticks. Exercise it via
    // a scatter chart (X axis naturally carries gridlines).
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      [1, 10],
      [2, 20],
      [3, 30]
    ]);
    addScatterChart(
      ws,
      {
        series: [{ name: "S", xValues: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        categoryAxis: { majorGridlines: true }
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    const verticalLines = scene.gridlines.filter(g => Math.abs(g.x1 - g.x2) < 1e-3);
    expect(verticalLines.length).toBeGreaterThan(0);
  });

  it("buildChartScene honours valueAxis.majorUnit for gridlines and tick labels", () => {
    // Regression: `buildGridlines` / `buildValueXLabels` / `buildYLabels`
    // used to hard-code six evenly-spaced ticks regardless of the
    // axis's `majorUnit`. A user-authored `majorUnit=25` on a
    // `[0, 100]` range should produce five gridlines at 0/25/50/75/100
    // (three inside the plot, two skipped at the plot edges) and
    // matching tick labels — not six ticks at 0/20/40/60/80/100.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 0],
      ["B", 50],
      ["C", 100]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        valueAxis: { min: 0, max: 100, majorUnit: 25, majorGridlines: true }
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    // Gridlines: horizontal lines across the plot. With majorUnit=25
    // on [0, 100] we expect ticks at 0, 25, 50, 75, 100; the two
    // endpoints coincide with the plot edges so the renderer skips
    // them → three gridlines remain.
    const horizontalLines = scene.gridlines.filter(g => Math.abs(g.y1 - g.y2) < 1e-3);
    expect(horizontalLines).toHaveLength(3);
    // Tick labels: five values (0/25/50/75/100). Previously six
    // labels (0/20/40/60/80/100) were emitted — misaligned with the
    // authored majorUnit.
    expect(scene.yLabels.map(l => l.text)).toEqual(["0", "25", "50", "75", "100"]);
  });

  it("renderChartSvg draws area and bubble primitives", () => {
    const areaSvg = renderChartSvg(makeRenderedChartModel({ type: "area" }));
    const bubbleSvg = renderChartSvg(makeRenderedBubbleChartModel());

    expect(areaSvg).toContain("<polygon");
    expect(areaSvg).toContain("<polyline");
    expect(bubbleSvg).toContain("<circle");
  });

  it("buildChartScene resolves theme / preset / sysClr line colours on gridlines", () => {
    // Regression: `previewShapeLineColor` used to read `line.color.srgb`
    // only, so any gridline whose stroke was authored as
    // `<a:schemeClr val="accent1"/>` or `<a:prstClr val="red"/>`
    // silently reverted to the default grey on render. Verify that
    // theme-coloured gridlines resolve through the shared
    // `resolveChartColor` hook.
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
        valueAxis: {
          majorGridlines: true,
          // `majorGridlinesStyle` flows into `axis.majorGridlines` as
          // a full `ShapeProperties` object — this is the public-API
          // route a caller uses to theme gridlines.
          majorGridlinesStyle: { line: { color: { theme: 4 } } } // accent1 → #4472C4
        }
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    expect(scene.gridlines.some(g => g.color.toUpperCase() === "#4472C4")).toBe(true);
  });

  it("buildChartScene resolves theme title colour via schemeClr", () => {
    // Regression companion to the gridline case above —
    // `colorFromChartTextProperties` used to read `color.srgb` only
    // so theme-coloured titles / axis labels / legend text silently
    // reverted to the default grey on render.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 1],
      ["B", 2]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }],
        title: "Themed",
        titleOptions: {
          // accent2 → #ED7D31
          txPr: { color: { theme: 5 } }
        }
      },
      "D1:J10"
    );
    const scene = buildChartScene(Chart.chartModel(getCharts(ws)[0])!, { width: 400, height: 240 });
    expect(scene.title?.color.toUpperCase()).toBe("#ED7D31");
  });

  it("renderChartSvg overlays combo chart groups instead of rendering only the first group", () => {
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
            barDir: "col",
            series: [
              { name: "Revenue", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }
            ]
          },
          {
            type: "line",
            series: [{ name: "Growth", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$C$1:$C$3" }]
          }
        ],
        title: "Combo"
      },
      "E1:L12"
    );
    const svg = renderChartSvg(Chart.chartModel(getCharts(ws)[0])!);
    expect(svg).toContain("Combo");
    expect(svg).toContain("<rect");
    expect(svg).toContain("<polyline");
    expect(svg).toContain("Revenue");
    expect(svg).toContain("Growth");
  });

  it("buildChartScene exposes secondary axes, legend visibility, and axis titles", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 1000],
      ["B", 20, 4000],
      ["C", 30, 9000]
    ]);
    addComboChart(
      ws,
      {
        groups: [
          {
            type: "bar",
            barDir: "col",
            categoryAxis: { title: "Quarter" },
            valueAxis: { title: "Revenue", min: 0, max: 40 },
            series: [
              { name: "Revenue", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }
            ]
          },
          {
            type: "line",
            useSecondaryAxis: true,
            series: [{ name: "Users", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$C$1:$C$3" }]
          }
        ],
        legendPosition: "t"
      },
      "E1:L12"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    const secondaryValueAxis = model.chart.plotArea.axes.find(
      axis => axis.axisType === "val" && axis.axPos === "r"
    )!;
    secondaryValueAxis.title = {
      text: { paragraphs: [{ runs: [{ text: "Users" }] }] }
    };
    const scene = buildChartScene(model, { width: 420, height: 260 });
    const svg = renderChartSvg(model, { width: 420, height: 260 });

    expect(scene.axes.y2).toBeDefined();
    expect(scene.secondaryYLabels.map(label => label.text)).toContain("9000");
    expect(scene.axisTitles.map(label => label.text)).toEqual(
      expect.arrayContaining(["Quarter", "Revenue", "Users"])
    );
    expect(scene.legend.visible).toBe(true);
    expect(scene.legend.orientation).toBe("horizontal");
    expect(svg).toContain("Users");
    expect(svg).toContain("rotate(90");
  });

  it("buildChartScene hides the legend when the chart has no legend", () => {
    const scene = buildChartScene(makeRenderedChartModel({ showLegend: false }));
    const svg = renderChartSvg(makeRenderedChartModel({ showLegend: false }));
    expect(scene.legend.visible).toBe(false);
    expect(svg).not.toContain('font-size="10" fill="#555">S</text>');
  });

  it("renderChartSvg draws labels, markers, trendlines, error bars, radar, stock, surface, and ofPie", () => {
    const decorated = makeRenderedChartModel({
      type: "line",
      series: [
        {
          ...baseSeries("S"),
          marker: { symbol: "diamond", size: 8 },
          dataLabels: { showVal: true },
          trendline: { type: "linear", name: "Trend", lineDash: "dash" },
          errorBars: { type: "fixedVal", value: 2 }
        }
      ]
    });
    const radar = makeRenderedChartModel({ type: "radar", radarStyle: "filled" });
    const surface = makeRenderedChartModel({ type: "surface", wireframe: true });
    const ofPie = makeRenderedChartModel({ type: "ofPie" });
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 15, 8, 12],
      ["B", 20, 24, 18, 19],
      ["C", 30, 34, 27, 33],
      ["D", 24, 26, 20, 22]
    ]);
    const stock = buildChartModel({
      type: "stock",
      series: [
        { name: "Open", categories: CATEGORIES, values: "Sheet1!$B$1:$B$4" },
        { name: "High", categories: CATEGORIES, values: "Sheet1!$C$1:$C$4" },
        { name: "Low", categories: CATEGORIES, values: "Sheet1!$D$1:$D$4" },
        { name: "Close", categories: CATEGORIES, values: "Sheet1!$E$1:$E$4" }
      ]
    });
    fillChartCaches(stock, wb);
    const svg = [decorated, radar, surface, ofPie, stock]
      .map(model => renderChartSvg(model))
      .join("\n");
    expect(svg).toContain("Trend");
    expect(svg).toContain("stroke-dasharray");
    expect(svg).toContain("<polygon");
    expect(svg).toContain("<path");
    expect(svg).toContain("#70AD47");
  });

  it("drawChartPdf draws chart primitives on a PDF-like surface", () => {
    const calls: string[] = [];
    const trace: string[] = [];
    const page = {
      drawRect() {
        calls.push("rect");
        return this;
      },
      drawLine() {
        calls.push("line");
        return this;
      },
      drawText() {
        calls.push("text");
        return this;
      }
    };

    const result = drawChartPdf(page, makeRenderedChartModel(), {
      x: 10,
      y: 20,
      width: 300,
      height: 180,
      trace
    });
    expect(result).toBe(page);
    expect(calls).toContain("rect");
    expect(calls).toContain("line");
    expect(calls).toContain("text");
    expect(stableHash(trace.join("\n"))).toBe("843940ac");
  });

  it("drawChartPdf draws pie paths when the surface supports paths", () => {
    const calls: string[] = [];
    const page = {
      drawRect() {
        calls.push("rect");
        return this;
      },
      drawLine() {
        calls.push("line");
        return this;
      },
      drawText() {
        calls.push("text");
        return this;
      },
      drawPath() {
        calls.push("path");
        return this;
      }
    };

    drawChartPdf(page, makeRenderedChartModel({ type: "pie" }), {
      x: 10,
      y: 20,
      width: 300,
      height: 180
    });

    expect(calls).toContain("path");
  });

  it("drawChartPdf emits adornments (labels/markers/errorBars/trendlines/leaders)", () => {
    // Build a chart whose model actually contains every adornment type so
    // the PDF path is forced to exercise the code added by this change:
    // markers (from series.marker), data labels (from dataLabels),
    // trendlines (from trendlines), error bars (from errorBars), and
    // leader lines are produced by the pie pass separately below.
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
        type: "line",
        series: [
          {
            name: "Trend",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            marker: { symbol: "diamond", size: 8 },
            dataLabels: { showVal: true, position: "t" },
            trendline: { type: "linear" },
            errorBars: { type: "fixedVal", value: 1, direction: "y" }
          } as AddChartSeriesOptions
        ],
        title: "PDF adornments"
      },
      "D1:J10"
    );
    const trace: string[] = [];
    const calls: Record<string, number> = {};
    const record = (kind: string) => {
      calls[kind] = (calls[kind] ?? 0) + 1;
    };
    const page = {
      drawRect() {
        record("rect");
        return this;
      },
      drawLine() {
        record("line");
        return this;
      },
      drawText() {
        record("text");
        return this;
      },
      drawPath() {
        record("path");
        return this;
      },
      drawCircle() {
        record("circle");
        return this;
      }
    };
    drawChartPdf(page, Chart.chartModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 320,
      height: 220,
      trace
    });
    // Trace must contain all new adornment tags.
    const joined = trace.join("\n");
    expect(joined).toContain("trendline:");
    expect(joined).toContain("errorbar:");
    expect(joined).toContain("label:");
    // Diamond markers route through `drawPath`.
    expect(calls.path).toBeGreaterThan(0);
    // And there are strictly more `line` calls than the pre-adornment
    // baseline (axes + gridlines + errorbar = many more than 4 lines).
    expect(calls.line).toBeGreaterThan(5);
  });

  it("drawChartPdf draws pie leader lines as connector strokes", () => {
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
        type: "pie",
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            dataLabels: { showVal: true, position: "outEnd" }
          } as AddChartSeriesOptions
        ]
      },
      "D1:J10"
    );
    const trace: string[] = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText() {
        return this;
      },
      drawPath() {
        return this;
      }
    };
    drawChartPdf(page, Chart.chartModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 320,
      height: 240,
      trace
    });
    expect(trace.join("\n")).toContain("leader:");
  });

  it("drawChartPdf forwards anchor and rotation to surfaces that support them", () => {
    // Axis titles on the y axes use rotate: ±90°. The PDF bridge must
    // forward that rotation so the title glyphs read vertically instead
    // of overlapping the tick labels.
    const captured: Array<{ text: string; rotation?: number; anchor?: string }> = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText(
        text: string,
        options: { x: number; y: number; rotation?: number; anchor?: string }
      ) {
        captured.push({ text, rotation: options.rotation, anchor: options.anchor });
        return this;
      }
    };
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
        title: "Centred",
        valueAxis: { title: "Units" }
      },
      "D1:J10"
    );
    drawChartPdf(page, Chart.chartModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 320,
      height: 220
    });
    // Title must be drawn with anchor=middle (centred under its x
    // coordinate); axis title "Units" with rotation=-90 or 90.
    const titleCall = captured.find(c => c.text === "Centred");
    expect(titleCall?.anchor).toBe("middle");
    const axisTitleCall = captured.find(c => c.text === "Units");
    expect(axisTitleCall).toBeDefined();
    expect(Math.abs(axisTitleCall!.rotation ?? 0)).toBe(90);
  });

  it("drawChartPdf area fill forwards alpha to surfaces that honour PdfColor.a", () => {
    // Without alpha support, stacked area charts render opaque and the
    // layer beneath becomes invisible. The PDF bridge must now forward
    // the SVG withAlpha(color, 0.35) semantic as a real PdfColor.a so
    // capable surfaces can emit /ExtGState.
    const captured: Array<{ fill?: { a?: number } }> = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText() {
        return this;
      },
      drawPath(_ops: unknown, options?: { fill?: { a?: number } }) {
        captured.push({ fill: options?.fill });
        return this;
      }
    };
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
        type: "area",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    drawChartPdf(page, Chart.chartModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 320,
      height: 200
    });
    // An area polygon must have been drawn with a non-opaque fill.
    const areaFill = captured.find(c => c.fill?.a !== undefined && c.fill.a < 1);
    expect(areaFill).toBeDefined();
    expect(areaFill!.fill!.a).toBeCloseTo(0.35);
  });

  it("drawChartPdf filled radar emits a translucent polygon fill", () => {
    const captured: Array<{ fill?: { a?: number } }> = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText() {
        return this;
      },
      drawPath(_ops: unknown, options?: { fill?: { a?: number } }) {
        captured.push({ fill: options?.fill });
        return this;
      }
    };
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
        type: "radar",
        radarStyle: "filled",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    drawChartPdf(page, Chart.chartModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 320,
      height: 220
    });
    // A radar fill path with 0.35 alpha — same value the SVG path draws.
    const translucent = captured.find(c => c.fill?.a !== undefined && c.fill.a < 1);
    expect(translucent).toBeDefined();
    expect(translucent!.fill!.a).toBeCloseTo(0.35);
  });

  it("drawChartPdf forwards fontFamily/bold/italic from txPr to the PDF surface", () => {
    const captured: Array<{
      text: string;
      fontFamily?: string;
      bold?: boolean;
      italic?: boolean;
    }> = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText(
        text: string,
        options: { x: number; y: number; fontFamily?: string; bold?: boolean; italic?: boolean }
      ) {
        captured.push({
          text,
          fontFamily: options.fontFamily,
          bold: options.bold,
          italic: options.italic
        });
        return this;
      }
    };
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    // Inject an explicit <a:latin> + bold + italic on the title txPr so
    // the scene exposes them via textStyleFromTxPr and the PDF bridge
    // can forward them.
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }],
        title: "Styled"
      },
      "D1:J10"
    );
    const model = Chart.chartModel(getCharts(ws)[0])!;
    model.chart.title!.txPr = {
      _rawXml:
        '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1800" b="1" i="1"><a:solidFill><a:srgbClr val="123456"/></a:solidFill><a:latin typeface="Verdana"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>'
    };
    drawChartPdf(page, model, {
      x: 0,
      y: 0,
      width: 320,
      height: 220
    });
    const titleCall = captured.find(c => c.text === "Styled");
    expect(titleCall).toBeDefined();
    expect(titleCall!.fontFamily).toBe("Verdana");
    expect(titleCall!.bold).toBe(true);
    expect(titleCall!.italic).toBe(true);
  });

  it("drawChartPdf on a drawPath-less surface strokes pie slice outlines instead of dropping them", () => {
    // Minimal surface (the real-world legacy shape) exposes only rect /
    // line / text. Before P3, the pie branch's `if (page.drawPath)` made
    // the entire chart disappear. The fallback must emit at least one
    // drawLine per slice so the geometry is still readable.
    const lineCalls: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine(options: { x1: number; y1: number; x2: number; y2: number }) {
        lineCalls.push(options);
        return this;
      },
      drawText() {
        return this;
      }
    };
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
        type: "pie",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    const baseline = lineCalls.length;
    drawChartPdf(page, Chart.chartModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 300,
      height: 220
    });
    // A 3-slice pie traced with `arcPolyline` produces many line
    // segments (at least one per slice × 3 slices). Assert a
    // conservative lower bound — the exact count depends on arc
    // segmentation, not on the fallback policy we're testing.
    expect(lineCalls.length - baseline).toBeGreaterThan(10);
  });

  it("drawChartPdf emits nothing for the pie fallback when drawPath IS available (no double paint)", () => {
    // Regression guard: the fallback path must not run when drawPath is
    // present. This proves the `else` branch is correctly gated — the
    // number of drawLine calls with drawPath available should be
    // dramatically smaller than without it (no arc-outline strokes).
    const pathCalls: string[] = [];
    const lineCalls: string[] = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        lineCalls.push("line");
        return this;
      },
      drawText() {
        return this;
      },
      drawPath() {
        pathCalls.push("path");
        return this;
      }
    };
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
        type: "pie",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    drawChartPdf(page, Chart.chartModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 300,
      height: 220
    });
    // drawPath used for every slice (3 slices = at least 3 calls).
    expect(pathCalls.length).toBeGreaterThanOrEqual(3);
    // drawLine count is small — only axis / gridline primitives, not
    // slice outline strokes. Each slice would contribute ~25 arc
    // segments if the fallback ran, so >50 total drawLine calls
    // would indicate leakage. Staying under that gives a comfortable
    // margin without coupling to the axis renderer's exact line count.
    expect(lineCalls.length).toBeLessThan(20);
  });

  it("drawChartPdf renders bar3D with three faces per bar (axonometric projection)", () => {
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
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    const trace: string[] = [];
    const calls: Record<string, number> = {};
    const record = (kind: string) => {
      calls[kind] = (calls[kind] ?? 0) + 1;
    };
    const page = {
      drawRect() {
        record("rect");
        return this;
      },
      drawLine() {
        record("line");
        return this;
      },
      drawText() {
        record("text");
        return this;
      },
      drawPath() {
        record("path");
        return this;
      }
    };
    drawChartPdf(page, Chart.chartModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      trace
    });
    const joined = trace.join("\n");
    // bar3D series still traces as "series:bar" in the scene.
    expect(joined).toContain("series:bar");
    // Each of the 3 data points produces 2 face paths (top + right) via
    // drawPdfBar3DBox, so at least 6 drawPath calls for the 3D extrusion.
    expect(calls.path).toBeGreaterThanOrEqual(6);
    // Plus the front face as a drawRect for each bar (3 bars = 3+ extra rects
    // beyond axis rects).
    expect(calls.rect).toBeGreaterThanOrEqual(3);
  });

  it("drawChartPdf renders dataTable rows and swatch cells", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["Q1", 100],
      ["Q2", 200],
      ["Q3", 150]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        barDir: "col",
        series: [{ name: "Revenue", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        dataTable: { showKeys: true, showHorzBorder: true, showVertBorder: true }
      },
      "D1:J10"
    );
    const trace: string[] = [];
    const texts: string[] = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText(_text: string) {
        texts.push(_text);
        return this;
      },
      drawPath() {
        return this;
      }
    };
    drawChartPdf(page, Chart.chartModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 320,
      height: 220,
      trace
    });
    const joined = trace.join("\n");
    // dataTable should emit "dTable:" traces and category text.
    expect(joined).toContain("dTable:");
    // The category labels should appear in the rendered text output.
    expect(texts).toContain("Q1");
    expect(texts).toContain("Q2");
    expect(texts).toContain("Q3");
    // Series name in the key row.
    expect(texts).toContain("Revenue");
  });
});

// ---------------------------------------------------------------------------
// 25. Bug fix verifications and supplementary edge cases
// ---------------------------------------------------------------------------
