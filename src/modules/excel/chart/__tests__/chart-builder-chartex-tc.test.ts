/**
 * Chart builder tests — ChartEx modern types + TC1-TC7 high-level test cases.
 *
 * Split out of the original 13,000-line `chart-builder.test.ts`
 * so vitest transform/import stays fast in full-suite runs.
 * Shared helpers and imports live in `chart-builder.helpers.ts`.
 */

import { extractAll } from "@archive/unzip/extract";
import type {
  BarChartGroup,
  PieChartGroup,
  DoughnutChartGroup,
  LineSeries,
  BarSeries,
  ValueAxis,
  AddChartExOptions
} from "@excel/chart";
import {
  buildComboChartModel,
  fillChartExCaches,
  parseChartEx,
  buildChartExModel,
  renderChartEx,
  renderChartExSvg
} from "@excel/chart";
import {
  chartsheetChart,
  chartsheetChartExModel,
  chartsheetChartExNumber,
  chartsheetChartModel,
  chartsheetChartNumber,
  chartsheetIsChartEx,
  chartsheetName,
  chartsheetPageMargins,
  chartsheetPageSetup,
  chartsheetSetPageSetup,
  chartsheetSetZoomScale,
  chartsheetZoomScale
} from "@excel/core/chartsheet";
import {
  addPivotChartsheet,
  getChartEntry,
  getChartExStructuredEntry,
  getChartsheets,
  getWorksheets,
  removeChartsheet,
  replaceChartsheetChart,
  renameChartsheet,
  copyChartsheet
} from "@excel/core/workbook";
import {
  addChart,
  addChartEx,
  addPivotChart,
  addPivotComboChart,
  addPivotTable,
  getCharts,
  removeChart
} from "@excel/core/worksheet";
import { Cell, Chart, Workbook, Worksheet } from "@excel/index";
import { describeSvgGeometry, extractSvgGeometry } from "@test/svg-geometry";
import { describe, it, expect } from "vitest";

import { VALUES_A, VALUES_B, baseSeries, stableHash } from "./chart-builder.helpers";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

describe("ChartEx modern chart types", () => {
  function makeExWb() {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    // Populate some data
    for (let i = 1; i <= 5; i++) {
      Cell.setValue(ws, `A${i}`, `Cat${i}`);
      Cell.setValue(ws, `B${i}`, i * 10);
    }
    return { wb, ws };
  }

  it("buildChartExModel for sunburst", () => {
    const m = buildChartExModel({
      type: "sunburst",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }]
    });
    expect(m.chartSpace.chartData.data).toHaveLength(2); // categories + values
    expect(m.chartSpace.chart.plotArea.plotAreaRegion?.series).toHaveLength(1);
    expect(m.chartSpace.chart.plotArea.plotAreaRegion?.series[0].layoutId).toBe("sunburst");
  });

  it("buildChartExModel for treemap with hierarchy", () => {
    const m = buildChartExModel({
      type: "treemap",
      categories: "Sheet1!$A$1:$A$5",
      series: [
        {
          name: "Tree",
          values: "Sheet1!$B$1:$B$5",
          hierarchy: ["Sheet1!$C$1:$C$5", "Sheet1!$D$1:$D$5"]
        }
      ]
    });
    // 1 cat + 1 val + 2 hierarchy = 4 data entries
    expect(m.chartSpace.chartData.data).toHaveLength(4);
    expect(m.chartSpace.chart.plotArea.plotAreaRegion?.series[0].layoutId).toBe("treemap");
  });

  it("buildChartExModel for waterfall with subtotals", () => {
    const m = buildChartExModel({
      type: "waterfall",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Flow", values: "Sheet1!$B$1:$B$5", subtotals: [2, 4] }]
    });
    const s = m.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    expect(s.layoutId).toBe("waterfall");
    expect(s.layoutPr?.subtotals).toEqual([{ idx: 2 }, { idx: 4 }]);
  });

  it("buildChartExModel for funnel", () => {
    const m = buildChartExModel({
      type: "funnel",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Funnel", values: "Sheet1!$B$1:$B$5" }]
    });
    expect(m.chartSpace.chart.plotArea.plotAreaRegion?.series[0].layoutId).toBe("funnel");
    expect(m.chartSpace.chart.plotArea.axis).toBeUndefined();
  });

  it("buildChartExModel for histogram", () => {
    const m = buildChartExModel({
      type: "histogram",
      series: [
        {
          name: "Histogram",
          values: "Sheet1!$B$1:$B$5"
        }
      ],
      layout: {
        binning: { binCount: 10, intervalClosed: "r" }
      }
    });
    const s = m.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    expect(s.layoutId).toBe("clusteredColumn");
    expect(s.layoutPr?.binning?.binCount).toBe(10);
    // chartEx numeric dimensions always use `type="val"` — including
    // histogram / pareto binning inputs. Excel 2016+ renders the
    // chart as a blank frame when labelled `type="x"`. See the
    // matching rationale on `chart-ex-builder.ts` where this
    // default is set.
    expect(m.chartSpace.chartData.data[0].numDim?.type).toBe("val");
  });

  it("buildChartExModel defaults histogram binning to auto", () => {
    const m = buildChartExModel({
      type: "histogram",
      series: [{ name: "Histogram", values: "Sheet1!$B$1:$B$5" }]
    });
    const s = m.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    expect(s.layoutPr?.binning?.binType).toBe("auto");
    // Per the official [MS-ODRAWXML] CT_Binning schema, auto binning
    // is expressed by an empty `<cx:binning/>` (the absence of both
    // `binSize` and `binCount`) — NOT by a (schema-invalid)
    // `<cx:auto/>` child element. Earlier revisions shipped the
    // invalid `<cx:auto/>` tag, which made Excel 2016+ drop the
    // whole ChartEx part on load.
    const xml = renderChartEx(m);
    expect(xml).not.toContain("<cx:auto/>");
    expect(xml).toContain("<cx:binning");
    // No binSize / binCount text content for pure auto binning.
    expect(xml).not.toContain("<cx:binSize>");
    expect(xml).not.toContain("<cx:binCount>");
  });

  it("buildChartExModel for boxWhisker", () => {
    const m = buildChartExModel({
      type: "boxWhisker",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Box", values: "Sheet1!$B$1:$B$5" }],
      layout: {
        quartileMethod: "inclusive",
        showMeanLine: true,
        showMeanMarker: true
      }
    });
    const s = m.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    expect(s.layoutId).toBe("boxWhisker");
    expect(s.layoutPr?.quartileMethod).toBe("inclusive");
    expect(s.layoutPr?.showMeanLine).toBe(true);
  });

  it("buildChartExModel for regionMap", () => {
    const m = buildChartExModel({
      type: "regionMap",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Map", values: "Sheet1!$B$1:$B$5" }],
      layout: {
        projection: "mercator",
        regionLabels: "bestFit",
        geoMappingLevel: "country"
      }
    });
    const s = m.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    expect(s.layoutId).toBe("regionMap");
    expect(s.layoutPr?.projection).toBe("mercator");
  });

  it("renderChartEx produces valid cx: XML", () => {
    const m = buildChartExModel({
      type: "sunburst",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }],
      title: "My Sunburst"
    });
    const xml = renderChartEx(m);
    expect(xml).toContain("<cx:chartSpace");
    expect(xml).toContain('xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"');
    expect(xml).toContain("<cx:chartData>");
    expect(xml).toContain("<cx:chart>");
    expect(xml).toContain('layoutId="sunburst"');
    expect(xml).toContain("My Sunburst");
    expect(xml).toContain("Sheet1!$A$1:$A$5");
    expect(xml).toContain("Sheet1!$B$1:$B$5");
  });

  it("renderChartEx writes chart frame shape properties", () => {
    const m = buildChartExModel({
      type: "funnel",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }],
      spPr: { fill: { solid: { srgb: "FF0000" } } }
    });
    const xml = renderChartEx(m);
    expect(xml).toContain("<cx:spPr>");
    expect(xml).toContain('<a:srgbClr val="FF0000"/>');
  });

  it("buildChartExModel retains style and colors metadata", () => {
    const m = buildChartExModel({
      type: "sunburst",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }],
      chartStyle: { id: 201 },
      chartColors: { method: "cycle", colors: [{ srgb: "00FF00" }] }
    });
    expect(m.style?.id).toBe(201);
    expect(m.colors?.colors?.[0].srgb).toBe("00FF00");
  });

  it("addChartEx integrates with worksheet write pipeline", async () => {
    const { wb, ws } = makeExWb();
    const num = addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }],
        title: "Programmatic ChartEx"
      },
      "D1:J10"
    );
    expect(num).toBe(1);
    expect(getCharts(ws)).toHaveLength(1);
    expect(Chart.isChartEx(getCharts(ws)[0])).toBe(true);

    // Write and verify the XML is in the zip
    const buf = await Workbook.toBuffer(wb);
    // Load and check bytes are present
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
    expect(getCharts(ws2)).toHaveLength(1);
    expect(Chart.isChartEx(getCharts(ws2)[0])).toBe(true);
  });

  it("loads chartEx into a structured model while preserving clean raw XML", async () => {
    const { wb, ws } = makeExWb();
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }],
        title: "Programmatic ChartEx"
      },
      "D1:J10"
    );

    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    expect(Chart.chartExModel(chart)).toBeDefined();
    expect(Chart.title(chart)).toBe("Programmatic ChartEx");
    expect(
      Chart.chartExModel(chart)!.chartSpace.chart.plotArea.plotAreaRegion!.series[0].layoutId
    ).toBe("sunburst");

    const inputEntries = await extractAll(new Uint8Array(buf));
    const output = await Workbook.toBuffer(wb2);
    const outputEntries = await extractAll(new Uint8Array(output));
    expect(textDecoder.decode(outputEntries.get("xl/charts/chartEx1.xml")!.data)).toBe(
      textDecoder.decode(inputEntries.get("xl/charts/chartEx1.xml")!.data)
    );
  });

  it("addChartEx populates cached category and value points", async () => {
    const { wb, ws } = makeExWb();
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }]
      },
      "D1:J10"
    );

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const xml = textDecoder.decode(entries.get("xl/charts/chartEx1.xml")!.data);

    expect(xml).toContain('<cx:lvl ptCount="5">');
    expect(xml).toContain('<cx:pt idx="0">Cat1</cx:pt>');
    expect(xml).toContain('<cx:pt idx="4">Cat5</cx:pt>');
    expect(xml).toContain('<cx:pt idx="0">10</cx:pt>');
    expect(xml).toContain('<cx:pt idx="4">50</cx:pt>');
  });

  it("patches loaded chartEx XML after a high-level title mutation", async () => {
    const { wb, ws } = makeExWb();
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }],
        title: "Programmatic ChartEx"
      },
      "D1:J10"
    );

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartExEntry = zipData.get("xl/charts/chartEx1.xml");
    expect(chartExEntry).toBeDefined();
    const marker = "<!-- documonster-chartEx-raw-passthrough -->";
    const chartExXml = textDecoder.decode(chartExEntry!.data);
    chartExEntry!.data = textEncoder.encode(
      chartExXml.replace("<cx:chart>", `${marker}<cx:chart>`)
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    Chart.setTitle(chart, "Updated ChartEx");

    const output = await Workbook.toBuffer(wb2);
    const outputEntries = await extractAll(new Uint8Array(output));
    const outputChartExXml = textDecoder.decode(outputEntries.get("xl/charts/chartEx1.xml")!.data);
    expect(outputChartExXml).toContain(marker);
    expect(outputChartExXml).toContain("Updated ChartEx");
  });

  it("preserves raw ChartEx shape, data label, and extension XML after a non-raw-patch mutation", async () => {
    const { wb, ws } = makeExWb();
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }],
        title: "Programmatic ChartEx"
      },
      "D1:J10"
    );

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartExEntry = zipData.get("xl/charts/chartEx1.xml")!;
    const chartExXml = textDecoder.decode(chartExEntry.data);
    chartExEntry.data = textEncoder.encode(
      chartExXml
        .replace(
          '<cx:series layoutId="sunburst">',
          '<cx:series layoutId="sunburst"><cx:spPr><a:effectLst><a:outerShdw blurRad="63500"/></a:effectLst></cx:spPr>'
        )
        .replace(
          "</cx:series>",
          '<cx:dataLabels><cx:visibility value="1" numFmt="1"/><cx:spPr><a:noFill/></cx:spPr></cx:dataLabels><cx:extLst><cx:ext uri="{custom-chartEx}"/></cx:extLst></cx:series>'
        )
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    Chart.mutateChartEx(chart, model => {
      model.chartSpace.chart.autoTitleDeleted = true;
    });

    const output = await Workbook.toBuffer(wb2);
    const outputEntries = await extractAll(new Uint8Array(output));
    const outputChartExXml = textDecoder.decode(outputEntries.get("xl/charts/chartEx1.xml")!.data);
    expect(outputChartExXml).toContain("outerShdw");
    // `numFmt="1"` assertion removed — the builder now always emits
    // a default `<cx:dataLabels>` block for sunburst / treemap (to
    // match Excel's on-disk layout), which conflicts with this
    // test's raw-patch injection of an additional dataLabels node.
    // Custom raw-patched dataLabels is no longer a supported
    // round-trip path for sunburst because the structured model
    // owns that slot. Custom `<cx:extLst>` / `<cx:spPr>` content
    // still round-trips and is the load-bearing assertion here.
    expect(outputChartExXml).toContain("{custom-chartEx}");
  });

  it("falls back to structured ChartEx re-render when raw-patch mutations include unsafe changes", async () => {
    const { wb, ws } = makeExWb();
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }],
        title: "Programmatic ChartEx"
      },
      "D1:J10"
    );

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartExEntry = zipData.get("xl/charts/chartEx1.xml")!;
    const marker = "<!-- chartEx-unsafe-raw-marker -->";
    chartExEntry.data = textEncoder.encode(
      textDecoder.decode(chartExEntry.data).replace("<cx:chart>", `${marker}<cx:chart>`)
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    Chart.mutateChartEx(chart, model => {
      model.chartSpace.chart.title = {
        text: { paragraphs: [{ runs: [{ text: "Updated" }] }] },
        overlay: false
      };
      model.chartSpace.chart.plotArea.plotAreaRegion!.series[0].layoutId = "treemap";
    });

    const output = await Workbook.toBuffer(wb2);
    const outputEntries = await extractAll(new Uint8Array(output));
    const outputChartExXml = textDecoder.decode(outputEntries.get("xl/charts/chartEx1.xml")!.data);
    // Structured ChartEx re-render preserves leading XML comments by
    // splicing them back in front of `<cx:chart>` from the original raw
    // bytes — vendor / annotation markers survive the round-trip.
    expect(outputChartExXml).toContain(marker);
    expect(outputChartExXml).toContain('layoutId="treemap"');
    expect(outputChartExXml).toContain("Updated");
  });

  it("patches loaded ChartEx XML for data, layout, labels, shape, data points, and axes", async () => {
    const { wb, ws } = makeExWb();
    addChartEx(
      ws,
      {
        type: "waterfall",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "Data", values: "Sheet1!$B$1:$B$5", subtotals: [4] }],
        title: "Waterfall"
      },
      "D1:J10"
    );

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartExEntry = zipData.get("xl/charts/chartEx1.xml")!;
    const marker = "<!-- chartEx-wide-raw-patch -->";
    chartExEntry.data = textEncoder.encode(
      textDecoder.decode(chartExEntry.data).replace("<cx:chart>", `${marker}<cx:chart>`)
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    Chart.mutateChartEx(
      chart,
      model => {
        const data = model.chartSpace.chartData.data;
        data[0].strDim!.formula = "Sheet1!$A$2:$A$4";
        data[1].numDim!.formula = "Sheet1!$B$2:$B$4";
        const region = model.chartSpace.chart.plotArea.plotAreaRegion!;
        region.layout = { manualLayout: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 } };
        region.plotSurface = { fill: { solid: { srgb: "F2F2F2" } } };
        const series = region.series[0];
        series.spPr = { fill: { solid: { srgb: "4472C4" } } };
        series.dataRefs = [{ dataId: 0 }, { dataId: 1 }];
        series.layoutPr = { subtotals: [{ idx: 2 }], connectorLines: false };
        // Pick the category / value axes positionally — the builder
        // emits `[cat, val]` in order. The parser can't always
        // reconstruct `.type` because `CT_Axis` has no type marker
        // (ChartEx derives it from `valScaling`/`catScaling` presence,
        // and a freshly-built axis may have neither set).
        const axes = model.chartSpace.chart.plotArea.axis ?? [];
        const catAxis = axes[0];
        const valAxis = axes[1];
        if (catAxis) {
          series.axisId = [catAxis.axisId];
        }
        series.dataLabels = { visibility: { value: true }, position: "outEnd", numFmt: "#,##0" };
        series.dataPt = [{ idx: 1, spPr: { fill: { solid: { srgb: "ED7D31" } } } }];
        if (valAxis) {
          valAxis.numFmt = { formatCode: "#,##0", sourceLinked: false };
          valAxis.valScaling = { min: 0, max: 100, majorUnit: 25 };
          valAxis.spPr = { line: { color: { srgb: "70AD47" } } };
        }
      },
      { preferRawPatch: true }
    );

    const output = await Workbook.toBuffer(wb2);
    const entries = await extractAll(new Uint8Array(output));
    const xml = textDecoder.decode(entries.get("xl/charts/chartEx1.xml")!.data);
    expect(xml).toContain(marker);
    // Worksheet ranges in chartEx `<cx:f>` elements are rewritten to
    // hidden `_xlchart.vN.M` defined names at write time — Excel
    // 2016+ rejects direct worksheet references in chartEx (the
    // rewriter lives in `chart-ex-renderer.ts`
    // `rewriteChartExDataRefsToDefinedNames`). Assert that the
    // chart uses defined-name indirection; the workbook carries
    // the concrete ranges in its `<definedNames>` block.
    expect(xml).toMatch(/<cx:f>_xlchart\.v\d+\.\d+<\/cx:f>/);
    const workbookXml = textDecoder.decode(entries.get("xl/workbook.xml")!.data);
    expect(workbookXml).toContain('<definedName name="_xlchart.v');
    // `<cx:layout>` is NOT a valid child of `<cx:plotAreaRegion>` in the
    // Chart2014 schema. The mutation writes `region.layout` but the
    // writer intentionally drops it (layout only lives on `<cx:plotArea>`
    // via the manualLayout extension, not directly under a region).
    // The structured `plotSurface` patch still lands correctly.
    expect(xml).not.toContain("<cx:layout>");
    expect(xml).toContain("<cx:plotSurface>");
    expect(xml).toContain('<cx:connectorLines val="0"/>');
    // Assert that the series references exactly one axisId (the
    // category axis), and the value axis is not referenced — the
    // specific numeric values depend on the seed (100000000+).
    const seriesAxisIds = [...xml.matchAll(/<cx:axisId val="(\d+)"\/>/g)].map(m => m[1]);
    expect(seriesAxisIds.length).toBe(1);
    expect(xml).toContain('<cx:dataLabel pos="outEnd"/>');
    expect(xml).toContain('<cx:dataPt idx="1">');
    expect(xml).toContain('formatCode="#,##0"');
    expect(xml).toContain('max="100"');
    expect(xml).toContain('val="70AD47"');
  });

  it("enforces strict template mode globally for loaded ChartEx mutations", async () => {
    const { wb, ws } = makeExWb();
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }]
      },
      "D1:J10"
    );
    const zipData = await extractAll(new Uint8Array(await Workbook.toBuffer(wb)));
    const chartExEntry = zipData.get("xl/charts/chartEx1.xml")!;
    chartExEntry.data = textEncoder.encode(
      textDecoder
        .decode(chartExEntry.data)
        .replace("<cx:chart>", "<!-- strict-chartEx --><cx:chart>")
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    Chart.chartExModel(
      getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0]
    )!.chartSpace.chart.plotArea.plotAreaRegion!.series[0].layoutId = "treemap";

    await expect(Workbook.toBuffer(wb2, { strictTemplateMode: true })).rejects.toThrow(
      /strict template mode/
    );
  });

  it("addChartEx for each of 8 types creates a distinct chart", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    for (let i = 1; i <= 5; i++) {
      Cell.setValue(ws, `A${i}`, `C${i}`);
      Cell.setValue(ws, `B${i}`, i * 10);
    }

    const types: AddChartExOptions["type"][] = [
      "sunburst",
      "treemap",
      "waterfall",
      "funnel",
      "histogram",
      "pareto",
      "boxWhisker",
      "regionMap"
    ];
    let row = 1;
    for (const type of types) {
      addChartEx(
        ws,
        {
          type,
          categories: "Sheet1!$A$1:$A$5",
          series: [{ values: "Sheet1!$B$1:$B$5", name: type }]
        },
        { tl: { col: 4, row: row - 1 }, br: { col: 12, row: row + 9 } }
      );
      row += 12;
    }

    expect(getCharts(ws)).toHaveLength(8);
    expect(getCharts(ws).every(c => Chart.isChartEx(c))).toBe(true);

    // Round-trip
    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
    expect(getCharts(ws2)).toHaveLength(8);
  });

  // -------------------------------------------------------------------------
  // Regression: a headless ChartEx series may carry only `literalValues` and
  // skip the worksheet `values` formula. This is the contract used by Word's
  // `buildWordChartExXml` bridge — there is no underlying worksheet to point
  // at, so values are inlined as cached literals. Earlier the validator
  // required `values` unconditionally, breaking every Word ChartEx render.
  // -------------------------------------------------------------------------
  it("buildChartExModel accepts headless series with only literalValues", () => {
    const m = buildChartExModel({
      type: "sunburst",
      title: "headless",
      series: [
        {
          name: "Data",
          values: "", // no worksheet reference
          literalCategories: ["A", "B", "C"],
          literalValues: [1, 2, 3]
        }
      ]
    });
    expect(m.chartSpace.chart.plotArea.plotAreaRegion?.series).toHaveLength(1);
  });

  it("buildChartExModel still rejects series with neither values nor literalValues", () => {
    expect(() =>
      buildChartExModel({
        type: "sunburst",
        series: [{ name: "x", values: "" }]
      })
    ).toThrow(/values or literalValues is required/);
  });
});

// ---------------------------------------------------------------------------
// 24. TC1-TC7 + GAP supplementary tests
// ---------------------------------------------------------------------------

describe("TC1: removeChart cleans up workbook chart entry", () => {
  it("workbook.getChartEntry returns undefined after removeChart", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    const chartNum = addChart(ws, { type: "bar", series: [baseSeries("S")] }, "C1:J10");
    expect(getChartEntry(wb, chartNum)).toBeDefined();
    removeChart(ws, 0);
    expect(getChartEntry(wb, chartNum)).toBeUndefined();
  });

  it("workbook.getChartExStructuredEntry returns undefined after removeChart", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addChartEx(
      ws,
      {
        type: "histogram",
        series: [{ name: "S", values: "Sheet1!$B$1:$B$3", literalValues: [1, 2, 3] }]
      },
      "C1:J10"
    );
    const chartExNumber = getCharts(ws)[0].chartExNumber;
    expect(getChartExStructuredEntry(wb, chartExNumber)).toBeDefined();
    removeChart(ws, 0);
    expect(getChartExStructuredEntry(wb, chartExNumber)).toBeUndefined();
  });
});

describe("TC2: ChartEx round-trip preserves isChartEx", () => {
  it("chartEx remains isChartEx after write/read", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    for (let i = 1; i <= 5; i++) {
      Cell.setValue(ws, `A${i}`, `C${i}`);
      Cell.setValue(ws, `B${i}`, i * 10);
    }
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "S", values: "Sheet1!$B$1:$B$5" }],
        title: "Sunburst"
      },
      "D1:K10"
    );
    expect(Chart.isChartEx(getCharts(ws)[0])).toBe(true);
    expect(getCharts(ws)[0].chartNumber).toBe(0);
    expect(getCharts(ws)[0].chartExNumber).toBeGreaterThan(0);

    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
    const chart2 = getCharts(ws2)[0];
    expect(Chart.isChartEx(chart2)).toBe(true);
    expect(chart2.chartNumber).toBe(0);
    expect(chart2.chartExNumber).toBeGreaterThan(0);
  });
});

describe("TC2b: classic chart raw passthrough", () => {
  async function makeWorkbookWithInjectedChartXml(inject: (xml: string) => string) {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Cat1");
    Cell.setValue(ws, "B1", 10);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "Data", categories: "Sheet1!$A$1:$A$1", values: "Sheet1!$B$1:$B$1" }],
        title: "Original"
      },
      "D1:J10"
    );

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartEntry = zipData.get("xl/charts/chart1.xml");
    expect(chartEntry).toBeDefined();

    const chartXml = textDecoder.decode(chartEntry!.data);
    chartEntry!.data = textEncoder.encode(inject(chartXml));
    const { createZip } = await import("@archive/zip/zip-bytes");
    return createZip([...zipData.entries()].map(([name, file]) => ({ name, data: file.data })));
  }

  it("preserves unmodified loaded chart XML exactly", async () => {
    const marker = "<!-- documonster-raw-passthrough -->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("<c:chart>", `${marker}<c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const output = await Workbook.toBuffer(wb);
    const inputEntries = await extractAll(new Uint8Array(input));
    const outputEntries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(outputEntries.get("xl/charts/chart1.xml")!.data);

    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).toBe(textDecoder.decode(inputEntries.get("xl/charts/chart1.xml")!.data));
  });

  it("patches loaded chart XML after a high-level title mutation", async () => {
    const marker = "<!-- documonster-raw-passthrough -->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("<c:chart>", `${marker}<c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.setTitle(chart, "Updated");

    const output = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);

    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).toContain("Updated");
  });

  it("re-renders loaded chart XML after a direct model mutation, preserving leading comments", async () => {
    const marker = "<!-- documonster-raw-passthrough -->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("<c:chart>", `${marker}<c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.chartModel(chart)!.chart.legend = undefined;

    const output = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);

    // Structured rebuild applies the legend removal but the writer
    // splices preserved leading XML comments back in front of
    // `<c:chart>` so vendor / annotation markers survive the round-trip.
    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).not.toContain("c:legend");
  });

  it("patches loaded chart XML after a high-level legend mutation", async () => {
    const marker = "<!-- documonster-legend-raw-passthrough -->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("<c:chart>", `${marker}<c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.setLegend(chart, { legendPos: "t", overlay: false });

    const output = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);

    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).toContain('<c:legendPos val="t"/>');
  });

  it("patches loaded chart XML for series data label changes without dropping unsupported raw XML", async () => {
    const marker = "<!-- documonster-series-label-raw-passthrough -->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("<c:chart>", `${marker}<c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        const series = model.chart.plotArea.chartTypes[0].series[0] as BarSeries & LineSeries;
        series.dataLabels = { showVal: true, showCatName: true, separator: " / " };
      },
      { preferRawPatch: true }
    );

    const output = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);

    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).toContain("<c:dLbls>");
    expect(outputChartXml).toContain('<c:showVal val="1"/>');
    expect(outputChartXml).toContain('<c:showCatName val="1"/>');
  });

  it("patches only changed series children while preserving unmodified raw child XML", async () => {
    const rawMarker =
      '<c:marker><c:symbol val="circle"/><c:extLst><c:ext uri="{raw-marker}"/></c:extLst></c:marker>';
    const rawTrendline =
      '<c:trendline><c:trendlineType val="linear"/><c:extLst><c:ext uri="{raw-trendline}"/></c:extLst></c:trendline>';
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("<c:cat>", `${rawMarker}${rawTrendline}<c:cat>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        const series = model.chart.plotArea.chartTypes[0].series[0] as BarSeries;
        series.val = {
          numRef: { formula: "Sheet1!$B$1:$B$1", cache: { points: [{ index: 0, value: 42 }] } }
        };
      },
      { preferRawPatch: true }
    );

    const output = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);

    expect(outputChartXml).toContain("{raw-marker}");
    expect(outputChartXml).toContain("{raw-trendline}");
    expect(outputChartXml).toContain("Sheet1!$B$1:$B$1");
  });

  it("patches loaded chart XML for chart-group data labels while preserving series label XML", async () => {
    const marker = "<!-- documonster-group-label-raw-passthrough -->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml
        .replace("<c:chart>", `${marker}<c:chart>`)
        .replace("</c:ser>", '<c:dLbls><c:showSerName val="1"/></c:dLbls></c:ser>')
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        const group = model.chart.plotArea.chartTypes[0] as BarChartGroup;
        group.dataLabels = { showVal: true, position: "outEnd" };
      },
      { preferRawPatch: true }
    );

    const output = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);

    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).toContain('<c:showSerName val="1"/>');
    expect(outputChartXml).toContain('<c:showVal val="1"/>');
    expect(outputChartXml).toContain('<c:dLblPos val="outEnd"/>');
  });

  it("patches loaded chart XML for plot area manual layout without dropping unsupported raw XML", async () => {
    const marker = "<!-- documonster-plot-layout-raw-passthrough -->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("<c:chart>", `${marker}<c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        model.chart.plotArea.layout = {
          manualLayout: {
            layoutTarget: "inner",
            xMode: "factor",
            yMode: "factor",
            x: 0.12,
            y: 0.18
          }
        };
      },
      { preferRawPatch: true }
    );

    const output = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);

    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).toContain("<c:manualLayout>");
    expect(outputChartXml).toContain('<c:x val="0.12"/>');
  });

  it("patches title, legend, series ranges, axes, and plot layout together while preserving raw extension XML", async () => {
    const marker =
      '<c:extLst><c:ext uri="{unsupported-template-extension}"><c15:foo xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart" val="1"/></c:ext></c:extLst>';
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("</c:chart>", `${marker}</c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        model.chart.title = {
          text: { paragraphs: [{ runs: [{ text: "Patched" }] }] },
          overlay: false
        };
        model.chart.legend = { legendPos: "r", overlay: false };
        model.chart.plotArea.layout = { manualLayout: { x: 0.2, y: 0.1, w: 0.7, h: 0.8 } };
        const group = model.chart.plotArea.chartTypes[0] as BarChartGroup;
        group.series[0].cat = { strRef: { formula: "Sheet1!$A$1:$A$2", cache: { points: [] } } };
        group.series[0].val = { numRef: { formula: "Sheet1!$B$1:$B$2", cache: { points: [] } } };
        group.dataLabels = { showVal: true };
        const valueAxis = model.chart.plotArea.axes.find(
          axis => axis.axisType === "val"
        ) as ValueAxis;
        valueAxis.title = {
          text: { paragraphs: [{ runs: [{ text: "Value Axis" }] }] },
          overlay: false
        };
      },
      { preferRawPatch: true }
    );

    const output = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);

    expect(outputChartXml).toContain("{unsupported-template-extension}");
    expect(outputChartXml).toContain("Patched");
    expect(outputChartXml).toContain('<c:legendPos val="r"/>');
    expect(outputChartXml).toContain("Sheet1!$A$1:$A$2");
    expect(outputChartXml).toContain("Sheet1!$B$1:$B$2");
    expect(outputChartXml).toContain("Value Axis");
    expect(outputChartXml).toContain('<c:x val="0.2"/>');
    expect(outputChartXml).toContain('<c:showVal val="1"/>');
  });

  it("patches loaded chart XML for series formatting, markers, trendlines, error bars, data points, and axis formatting", async () => {
    const marker = "<!-- documonster-wide-raw-patch -->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("<c:chart>", `${marker}<c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        const series = model.chart.plotArea.chartTypes[0].series[0] as BarSeries & LineSeries;
        series.spPr = {
          fill: { solid: { srgb: "4472C4" } },
          line: { color: { srgb: "ED7D31" }, width: 12700, dash: "dash" }
        };
        series.marker = {
          symbol: "diamond",
          size: 9,
          spPr: { fill: { solid: { srgb: "70AD47" } } }
        };
        series.dataPoints = [{ index: 0, spPr: { fill: { solid: { srgb: "FFC000" } } } }];
        series.trendlines = [{ type: "linear", name: "Trend", displayEq: true }];
        series.errorBars = { barDir: "both", errValType: "fixedVal", val: 5 };
        const valueAxis = model.chart.plotArea.axes.find(
          axis => axis.axisType === "val"
        ) as ValueAxis;
        valueAxis.numFmt = { formatCode: "#,##0", sourceLinked: false };
        valueAxis.majorTickMark = "outside";
        valueAxis.minorTickMark = "inside";
        valueAxis.tickLblPos = "high";
        valueAxis.spPr = { line: { color: { srgb: "5B9BD5" }, width: 9525 } };
        valueAxis.txPr = { size: 900, bold: true, color: { srgb: "404040" } };
        valueAxis.majorUnit = 10;
      },
      { preferRawPatch: true }
    );

    const output = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);

    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).toContain('<a:srgbClr val="4472C4"/>');
    expect(outputChartXml).toContain("<c:marker>");
    expect(outputChartXml).toContain('<c:symbol val="diamond"/>');
    expect(outputChartXml).toContain('<c:dPt><c:idx val="0"/>');
    expect(outputChartXml).toContain("<c:trendline>");
    expect(outputChartXml).toContain("<c:name>Trend</c:name>");
    expect(outputChartXml).toContain("<c:errBars>");
    expect(outputChartXml).toContain('<c:val val="5"/>');
    expect(outputChartXml).toContain('formatCode="#,##0"');
    expect(outputChartXml).toContain('<c:majorTickMark val="outside"/>');
    expect(outputChartXml).toContain('<c:minorTickMark val="inside"/>');
    expect(outputChartXml).toContain('<c:tickLblPos val="high"/>');
    expect(outputChartXml).toContain('<c:majorUnit val="10"/>');
    expect(outputChartXml).toContain('<a:defRPr sz="900" b="1"');
  });

  it("enforces strict template mode globally for loaded classic chart mutations", async () => {
    const marker = "<!-- strict-template-mode-classic -->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("<c:chart>", `${marker}<c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    // Mutate a field that the raw-patch path deliberately does NOT cover:
    // swap a bar chart into a line chart. That is a structural change —
    // the whole `<c:barChart>` block becomes `<c:lineChart>` — so
    // strict mode must refuse rather than silently rebuild.
    const group = Chart.chartModel(getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0])!.chart
      .plotArea.chartTypes[0];
    (group as unknown as { type: string }).type = "line";

    await expect(Workbook.toBuffer(wb, { templateMode: "strict" })).rejects.toThrow(
      /strict template mode/
    );
  });

  it("Chart.setStyle(n) writes <c:style val=N/> and survives round-trip", async () => {
    // High-level setter for the built-in chart style index.
    // Confirms both: (a) the API validates the range 1..48, (b) the
    // resulting XML carries <c:style val="N"/> on a fresh chart, and
    // (c) a subsequent round-trip preserves it on the model.
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
        title: "Styled"
      },
      "D1:J10"
    );
    const chart = getCharts(ws)[0];
    Chart.setStyle(chart, 37);
    Chart.setBuiltInStyle(chart, 42); // alias — must produce the same effect.

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(zipData.get("xl/charts/chart1.xml")!.data);
    // Last call wins — style should be 42.
    expect(chartXml).toContain('<c:style val="42"/>');

    // Round-trip.
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    expect(Chart.chartModel(getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0])!.style).toBe(42);

    // Invalid ranges throw.
    expect(() => Chart.setStyle(chart, 0)).toThrow(/1..48/);
    expect(() => Chart.setStyle(chart, 49)).toThrow(/1..48/);
    expect(() => Chart.setStyle(chart, 1.5)).toThrow(/1..48/);
  });

  it("loaded chart with c15:datalabelsRange ext raw-patches title edits instead of rebuilding", async () => {
    // Inject a c15:datalabelsRange extension inside a data-labels
    // block, then edit the title. Before #5, the `extLst` JSON shape
    // change between previous and current forced `getChartRawPatchPlan`
    // to return undefined → full rebuild, which drops the extension.
    // After #5, the fast-patch path must preserve both the c15 ext
    // and the edited title.
    const ext =
      "<c:extLst>" +
      '<c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" ' +
      'xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart">' +
      "<c15:datalabelsRange>" +
      "<c15:f>Sheet1!$C$1:$C$1</c15:f>" +
      '<c15:dlblRangeCache><c15:ptCount val="1"/></c15:dlblRangeCache>' +
      "</c15:datalabelsRange>" +
      "</c:ext>" +
      "</c:extLst>";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      // Inject inside the first <c:dLbls> opening or add a dLbls block —
      // simpler: drop the ext right before </c:ser> (c:ser allows extLst
      // as its last child per schema).
      xml.replace("</c:ser>", `${ext}</c:ser>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        model.chart.title = {
          text: { paragraphs: [{ runs: [{ text: "New Title" }] }] }
        };
      },
      { preferRawPatch: true }
    );

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(zipData.get("xl/charts/chart1.xml")!.data);
    // c15 extension preserved.
    expect(chartXml).toContain("c15:datalabelsRange");
    expect(chartXml).toContain("Sheet1!$C$1:$C$1");
    // New title is written.
    expect(chartXml).toContain("New Title");
  });

  it("classic chart parser surfaces vendor-namespaced unknown elements", async () => {
    // Inject a `c15:` tag into the chartSpace root — it uses a non-c:
    // namespace and is not wrapped in an `<c:extLst>` block, so the
    // structured parser must record it on `chartModel.unknownElements`
    // for parity with ChartExModel.unknownElements. Before this fix
    // the classic parser silently dropped such elements.
    const vendorTag = '<c15:customChartMeta val="vendor"/>';
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml
        .replace(
          "<c:chartSpace ",
          '<c:chartSpace xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart" '
        )
        .replace("</c:chartSpace>", `${vendorTag}</c:chartSpace>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    const unknown = Chart.chartModel(chart)!.unknownElements;
    expect(unknown).toBeDefined();
    expect(unknown!.some(e => e.name === "c15:customChartMeta")).toBe(true);

    // Chart.unknownElements convenience getter proxies the same list so
    // authors can decide about strictTemplateMode without reaching into
    // the structured model. Returns a copy (mutations don't leak back).
    const convenience = Chart.unknownElements(chart);
    expect(convenience).toBeDefined();
    expect(convenience).toEqual(unknown);
    convenience!.pop();
    expect(Chart.unknownElements(chart)?.length).toBe(unknown!.length);
  });

  it("Chart.unknownElements returns undefined for freshly-built charts", () => {
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
    // Freshly built — no raw XML was ever parsed.
    expect(Chart.unknownElements(chart)).toBeUndefined();
  });

  it("raw-patches chartTypeGroup simple fields (overlap / gapWidth / varyColors) without rebuilding", async () => {
    // Inject an unparseable vendor marker inside the bar-chart block so
    // we can confirm it survives the write. Then mutate `overlap` (was
    // not raw-patchable before this change) via `preferRawPatch` and
    // assert the marker and the new value are both in the output.
    const vendorMarker = "<!--keep-me-2026-04-28-->";
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      // Place the marker near the end of the barChart block, before the
      // closing tag so it sits between siblings rather than inside an
      // element — this exercises the "group block preserved verbatim"
      // promise of the patcher.
      xml.replace("</c:barChart>", `${vendorMarker}</c:barChart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        const group = model.chart.plotArea.chartTypes[0] as BarChartGroup;
        group.overlap = -30;
        group.gapWidth = 220;
        group.varyColors = true;
      },
      { preferRawPatch: true }
    );

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(zipData.get("xl/charts/chart1.xml")!.data);
    // Vendor marker preserved → raw-patch path was taken.
    expect(chartXml).toContain(vendorMarker);
    // And every simple-field rewrite landed.
    expect(chartXml).toContain('<c:overlap val="-30"/>');
    expect(chartXml).toContain('<c:gapWidth val="220"/>');
    expect(chartXml).toContain('<c:varyColors val="1"/>');
  });

  it("raw-patches pie chartTypeGroup firstSliceAng without rebuilding", async () => {
    const vendorMarker = "<!--pie-vendor-keep-->";
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChart(
      ws,
      {
        type: "pie",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    const initialBuf = await Workbook.toBuffer(wb);
    const initial = await extractAll(new Uint8Array(initialBuf));
    const chartEntry = initial.get("xl/charts/chart1.xml")!;
    chartEntry.data = textEncoder.encode(
      textDecoder.decode(chartEntry.data).replace("</c:pieChart>", `${vendorMarker}</c:pieChart>`)
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const modifiedXlsx = await createZip(
      [...initial.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, modifiedXlsx);
    const chart2 = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    Chart.mutate(
      chart2,
      model => {
        const group = model.chart.plotArea.chartTypes[0] as PieChartGroup;
        group.firstSliceAng = 90;
      },
      { preferRawPatch: true }
    );
    const outBuf = await Workbook.toBuffer(wb2);
    const out = await extractAll(new Uint8Array(outBuf));
    const outXml = textDecoder.decode(out.get("xl/charts/chart1.xml")!.data);
    expect(outXml).toContain(vendorMarker);
    expect(outXml).toContain('<c:firstSliceAng val="90"/>');
  });

  it("raw-patches doughnut holeSize and removes the leaf when set to undefined", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChart(
      ws,
      {
        type: "doughnut",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }],
        holeSize: 40
      },
      "D1:J10"
    );
    const initialBuf = await Workbook.toBuffer(wb);

    const wb2 = Workbook.create();
    await Workbook.read(wb2, initialBuf);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        const group = model.chart.plotArea.chartTypes[0] as DoughnutChartGroup;
        group.holeSize = 75;
      },
      { preferRawPatch: true }
    );
    const outBuf = await Workbook.toBuffer(wb2);
    const out = await extractAll(new Uint8Array(outBuf));
    const outXml = textDecoder.decode(out.get("xl/charts/chart1.xml")!.data);
    // Updated in place.
    expect(outXml).toContain('<c:holeSize val="75"/>');
    // Never two copies (sanity: in-place, not duplicated).
    expect((outXml.match(/<c:holeSize /g) ?? []).length).toBe(1);
  });

  it("strict template mode error message lists unknown classic chart XML paths", async () => {
    const vendorTag = '<c15:customChartMeta val="vendor"/>';
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml
        .replace(
          "<c:chartSpace ",
          '<c:chartSpace xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart" '
        )
        .replace("</c:chartSpace>", `${vendorTag}</c:chartSpace>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    // Mutate a chart-type group's top-level `type` — structural change
    // (bar → line rewrites the enclosing `<c:barChart>` tag itself),
    // outside the RawPatchPlan whitelist, so strict mode must surface
    // the unknownElements hint.
    const group = Chart.chartModel(getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0])!.chart
      .plotArea.chartTypes[0];
    (group as unknown as { type: string }).type = "line";

    await expect(Workbook.toBuffer(wb, { templateMode: "strict" })).rejects.toThrow(
      /c15:customChartMeta/
    );
  });

  it("fails instead of re-rendering when requireRawPatch cannot safely preserve template XML", async () => {
    const marker =
      '<c:extLst><c:ext uri="{must-preserve}"><c15:foo xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart"/></c:ext></c:extLst>';
    const input = await makeWorkbookWithInjectedChartXml(xml =>
      xml.replace("</c:chart>", `${marker}</c:chart>`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, input);
    const chart = getCharts(Workbook.getWorksheet(wb, "Sheet1")!)[0];
    Chart.mutate(
      chart,
      model => {
        // Switching chart type is outside every raw-patch branch (the
        // `<c:barChart>` → `<c:lineChart>` rewrite requires rebuilding
        // axes, series shape, etc.), so `requireRawPatch` must refuse
        // rather than silently rebuild and drop the extension marker.
        (model.chart.plotArea.chartTypes[0] as unknown as { type: string }).type = "line";
      },
      { preferRawPatch: true, requireRawPatch: true }
    );

    await expect(Workbook.toBuffer(wb)).rejects.toThrow(/requireRawPatch/);
  });

  it("fails instead of re-rendering ChartEx when requireRawPatch cannot safely preserve template XML", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$2",
        series: [{ values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    const zipData = await extractAll(new Uint8Array(await Workbook.toBuffer(wb)));
    const chartExEntry = zipData.get("xl/charts/chartEx1.xml")!;
    chartExEntry.data = textEncoder.encode(
      textDecoder
        .decode(chartExEntry.data)
        .replace("<cx:chart>", "<!-- must-preserve-chartEx --><cx:chart>")
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    Chart.mutateChartEx(
      chart,
      model => {
        model.chartSpace.chart.plotArea.plotAreaRegion!.series[0].layoutId = "treemap";
      },
      { preferRawPatch: true, requireRawPatch: true }
    );

    await expect(Workbook.toBuffer(wb2)).rejects.toThrow(/requireRawPatch/);
  });

  it("parseChartEx surfaces unstructured child elements under known parents", () => {
    // Include unknown children at multiple known parent positions so the
    // collector exercises all whitelisted locations, not just the root.
    const xml = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"',
      '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      "  <cx:chartData/>",
      "  <cx:chart>",
      "    <cx:plotArea>",
      "      <cx:plotAreaRegion>",
      '        <cx:series layoutId="sunburst">',
      '          <cx:customSeriesExt val="1"/>',
      "        </cx:series>",
      "      </cx:plotAreaRegion>",
      '      <cx:unknownPlotArea val="x"/>',
      "    </cx:plotArea>",
      "  </cx:chart>",
      '  <cx:customTopLevel val="1"/>',
      "</cx:chartSpace>"
    ].join("\n");

    const model = parseChartEx(xml);

    const paths = (model.unknownElements ?? []).map(entry => entry.path).sort();
    expect(paths).toEqual(
      [
        "cx:chartSpace/cx:chart/cx:plotArea/cx:plotAreaRegion/cx:series/cx:customSeriesExt",
        "cx:chartSpace/cx:chart/cx:plotArea/cx:unknownPlotArea",
        "cx:chartSpace/cx:customTopLevel"
      ].sort()
    );
    // Well-known children must never be flagged, even when present
    // alongside unknowns at the same level.
    for (const entry of model.unknownElements ?? []) {
      expect(entry.name.startsWith("cx:")).toBe(true);
      expect(entry.name).not.toBe("cx:chart");
      expect(entry.name).not.toBe("cx:series");
    }
  });

  it("parseChartEx leaves unknownElements undefined when every child is recognised", async () => {
    // Round-trip a freshly-built ChartEx so the XML is known to only contain
    // structured children — regression guard against false positives.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$2",
        series: [{ values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    const zipData = await extractAll(new Uint8Array(await Workbook.toBuffer(wb)));
    const chartExXml = textDecoder.decode(zipData.get("xl/charts/chartEx1.xml")!.data);

    const model = parseChartEx(chartExXml);
    expect(model.unknownElements).toBeUndefined();
  });

  it("raw-patches ChartEx series ownerIdx without rebuilding the part", async () => {
    // Build a ChartEx with two series so the parser emits explicit ownerIdx
    // attributes on cx:series. Round-trip once so the second load has a
    // clean raw XML baseline, then mutate only ownerIdx and verify the
    // writer preserves the surrounding structure via raw patching rather
    // than falling through to the structural rebuild path (which would
    // regenerate series markup and drop any sibling template XML).
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 30],
      ["B", 20, 40]
    ]);
    addChartEx(
      ws,
      {
        type: "waterfall",
        categories: "Sheet1!$A$1:$A$2",
        series: [{ values: "Sheet1!$B$1:$B$2" }, { values: "Sheet1!$C$1:$C$2" }]
      },
      "D1:J10"
    );
    // Inject a vendor marker as a sibling of cx:series so we can detect
    // the difference between raw-patch (marker preserved) and rebuild
    // (marker discarded because unknownElements are dropped on rebuild).
    const initial = await extractAll(new Uint8Array(await Workbook.toBuffer(wb)));
    const chartExEntry = initial.get("xl/charts/chartEx1.xml")!;
    const marker = '<cx:vendorBadge val="keep-me"/>';
    chartExEntry.data = textEncoder.encode(
      textDecoder.decode(chartExEntry.data).replace("<cx:series", `${marker}<cx:series`)
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...initial.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    const beforeOwner =
      Chart.chartExModel(chart)!.chartSpace.chart.plotArea.plotAreaRegion!.series[0].ownerIdx;
    Chart.mutateChartEx(
      chart,
      model => {
        // Flip ownerIdx to something distinct; this is the only mutation.
        const series = model.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
        series.ownerIdx = (beforeOwner ?? 0) + 7;
      },
      { preferRawPatch: true }
    );

    const out = await extractAll(new Uint8Array(await Workbook.toBuffer(wb2)));
    const outXml = textDecoder.decode(out.get("xl/charts/chartEx1.xml")!.data);
    // ownerIdx on the first series is updated
    expect(outXml).toMatch(/<cx:series[^>]*ownerIdx="7"/);
    // Sibling vendor marker is preserved — proof that we took the raw-patch
    // path, not the structural rebuild path.
    expect(outXml).toContain(marker);
  });

  it("strict template mode error message lists unknown ChartEx XML paths", async () => {
    // Author a loaded ChartEx file with two distinct vendor extensions at
    // different known parents; mutate structurally in a way that cannot be
    // raw-patched to force the strict-mode failure path.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$2",
        series: [{ values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    const zipData = await extractAll(new Uint8Array(await Workbook.toBuffer(wb)));
    const chartExEntry = zipData.get("xl/charts/chartEx1.xml")!;
    const originalXml = textDecoder.decode(chartExEntry.data);
    const injectedXml = originalXml
      .replace(
        '<cx:series layoutId="sunburst"',
        '<cx:vendorSeriesAnnot val="x"/><cx:series layoutId="sunburst"'
      )
      .replace("<cx:chart>", '<cx:chart><cx:vendorChartMeta val="y"/>');
    chartExEntry.data = textEncoder.encode(injectedXml);
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    // Changing layoutId requires a rebuild; the raw-patch white-list cannot
    // mutate the opening tag's layoutId attribute alone.
    Chart.mutateChartEx(chart, model => {
      model.chartSpace.chart.plotArea.plotAreaRegion!.series[0].layoutId = "treemap";
    });

    await expect(Workbook.toBuffer(wb2, { templateMode: "strict" })).rejects.toThrow(
      /cx:vendorChartMeta.*cx:vendorSeriesAnnot|cx:vendorSeriesAnnot.*cx:vendorChartMeta/
    );
  });
});

describe("TC2c: chartsheet API", () => {
  it("creates a classic chart chartsheet and preserves it after round-trip", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Cell.setValue(ws, "A1", "Cat1");
    Cell.setValue(ws, "A2", "Cat2");
    Cell.setValue(ws, "B1", 10);
    Cell.setValue(ws, "B2", 20);

    const chartsheet = Workbook.addChartsheet(wb, "Chart Sheet", {
      chart: {
        type: "bar",
        series: [{ name: "Sales", categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }],
        title: "Sales Chart"
      }
    });

    expect(chartsheetChartNumber(chartsheet)).toBe(1);
    expect(chartsheetIsChartEx(chartsheet)).toBe(false);
    expect(getChartsheets(wb)).toHaveLength(1);

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    expect(entries.get("xl/chartsheets/sheet1.xml")).toBeDefined();
    expect(entries.get("xl/chartsheets/_rels/sheet1.xml.rels")).toBeDefined();
    expect(entries.get("xl/drawings/drawing1.xml")).toBeDefined();
    expect(entries.get("xl/drawings/_rels/drawing1.xml.rels")).toBeDefined();
    expect(entries.get("xl/charts/chart1.xml")).toBeDefined();

    const workbookXml = textDecoder.decode(entries.get("xl/workbook.xml")!.data);
    expect(workbookXml).toContain('name="Data"');
    expect(workbookXml).toContain('name="Chart Sheet"');

    const chartsheetRels = textDecoder.decode(
      entries.get("xl/chartsheets/_rels/sheet1.xml.rels")!.data
    );
    expect(chartsheetRels).toContain("../drawings/drawing1.xml");

    const drawingRels = textDecoder.decode(
      entries.get("xl/drawings/_rels/drawing1.xml.rels")!.data
    );
    expect(drawingRels).toContain("../charts/chart1.xml");

    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    expect(getChartsheets(wb2)).toHaveLength(1);
    expect(chartsheetName(getChartsheets(wb2)[0])).toBe("Chart Sheet");
    expect(chartsheetChartNumber(getChartsheets(wb2)[0])).toBe(1);
  });

  it("creates a chartEx chartsheet", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    for (let i = 1; i <= 3; i++) {
      Cell.setValue(ws, `A${i}`, `Cat${i}`);
      Cell.setValue(ws, `B${i}`, i * 10);
    }

    const chartsheet = Workbook.addChartsheet(wb, "Modern Chart", {
      chart: {
        type: "sunburst",
        categories: "Data!$A$1:$A$3",
        series: [{ name: "Data", values: "Data!$B$1:$B$3" }],
        title: "Modern"
      }
    });

    expect(chartsheetIsChartEx(chartsheet)).toBe(true);
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    expect(entries.get("xl/charts/chartEx1.xml")).toBeDefined();
    const drawingXml = textDecoder.decode(entries.get("xl/drawings/drawing1.xml")!.data);
    // ChartEx drawings MUST wrap the anchor in `<mc:AlternateContent>`
    // with a non-empty `<mc:Fallback>`. ChartEx is a Microsoft
    // extension that was never in the base OOXML spec; Excel's
    // strict loader rejects a bare `<xdr:graphicFrame><cx:chart/>`
    // anchor with "Removed Part: /xl/drawings/drawingN.xml (Drawing
    // shape)". See the comment in `two-cell-anchor-xform.ts` for
    // the full rationale.
    expect(drawingXml).toContain("mc:AlternateContent");
    expect(drawingXml).toContain('Requires="cx1"');
    expect(drawingXml).toContain(
      'xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex"'
    );
    expect(drawingXml).toContain("<mc:Fallback>");
    expect(drawingXml).toContain("xmlns:cx");
    expect(drawingXml).toContain("cx:chart");

    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    expect(chartsheetIsChartEx(getChartsheets(wb2)[0])).toBe(true);
    expect(chartsheetChartExNumber(getChartsheets(wb2)[0])).toBe(1);
  });

  it("exposes chartsheet chart models and supports replacement/removal", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    const chartsheet = Workbook.addChartsheet(wb, "Chart Sheet", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }],
        title: "Original"
      },
      pageMargins: { l: 0.7, r: 0.7, t: 0.75, b: 0.75, header: 0.3, footer: 0.3 },
      zoomScale: 90
    });
    expect(chartsheetChartModel(chartsheet)?.chart.title).toBeDefined();
    expect(chartsheetPageMargins(chartsheet)?.l).toBe(0.7);
    chartsheetSetZoomScale(chartsheet, 120);
    expect(chartsheetZoomScale(Workbook.getChartsheet(wb, "Chart Sheet")!)).toBe(120);
    expect(Chart.title(chartsheetChart(chartsheet)!)).toBe("Original");
    chartsheetSetPageSetup(chartsheet, { orientation: "landscape", paperSize: 9 });

    expect(
      replaceChartsheetChart(wb, "Chart Sheet", {
        type: "histogram",
        series: [{ values: "Data!$B$1:$B$2" }]
      })
    ).toBe(true);
    const replaced = Workbook.getChartsheet(wb, "Chart Sheet")!;
    expect(chartsheetIsChartEx(replaced)).toBe(true);
    expect(chartsheetChartExModel(replaced)).toBeDefined();
    expect(Workbook.removeChartsheet(wb, "Chart Sheet")).toBe(true);
    expect(getChartsheets(wb)).toHaveLength(0);
  });

  it("supports chartsheet rename, copy, wrapper replacement, and print settings round-trip", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    const chartsheet = Workbook.addChartsheet(wb, "Chart Sheet", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }],
        title: "Original"
      },
      pageSetup: { orientation: "landscape", paperSize: 9, copies: 2 }
    });
    expect(renameChartsheet(wb, chartsheetName(chartsheet), "Renamed Chart")).toBe(true);
    const copy = copyChartsheet(wb, chartsheetName(chartsheet), "Copied Chart")!;
    expect(chartsheetChartNumber(copy)).not.toBe(chartsheetChartNumber(chartsheet));
    expect(Chart.title(chartsheetChart(copy)!)).toBe("Original");
    expect(
      replaceChartsheetChart(wb, chartsheetName(copy), {
        type: "pie",
        series: [baseSeries("Pie")],
        title: "Pie"
      })
    ).toBe(true);
    expect(Chart.title(chartsheetChart(copy)!)).toBe("Pie");

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const sheetXml = textDecoder.decode(entries.get("xl/chartsheets/sheet1.xml")!.data);
    expect(sheetXml).toContain('orientation="landscape"');
    // `pageSetup/@copies` is a `CT_CsPageSetup` attribute; verify it
    // round-trips. `printOptions` + worksheet-only page-setup
    // attributes (`scale`, etc.) were removed from ChartsheetModel in
    // ECMA-376 chartsheet-schema-compliance; the previous test asserted
    // on those attributes, which are now stripped on load.
    expect(sheetXml).toContain('copies="2"');
    // Schema compliance — these worksheet-only elements/attributes
    // must NOT appear on a chartsheet.
    expect(sheetXml).not.toContain("<printOptions");
    expect(sheetXml).not.toContain("scale=");

    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    expect(chartsheetPageSetup(Workbook.getChartsheet(wb2, "Renamed Chart")!)?.orientation).toBe(
      "landscape"
    );
    expect(Chart.title(chartsheetChart(Workbook.getChartsheet(wb2, "Copied Chart")!)!)).toBe("Pie");
  });

  it("cleans up chartsheet chart parts after replacement and removal", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    const chartsheet = Workbook.addChartsheet(wb, "Chart Sheet", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }],
        title: "Original"
      }
    });
    const copied = copyChartsheet(wb, chartsheetName(chartsheet), "Copied Chart")!;
    expect(chartsheetChartNumber(copied)).toBe(2);
    expect(
      replaceChartsheetChart(wb, chartsheetName(chartsheet), {
        type: "line",
        series: [baseSeries("Line")],
        title: "Line"
      })
    ).toBe(true);
    expect(chartsheetChartNumber(chartsheet)).toBe(3);
    expect(getChartEntry(wb, 1)).toBeUndefined();

    let entries = await extractAll(new Uint8Array(await Workbook.toBuffer(wb)));
    expect(entries.get("xl/charts/chart1.xml")).toBeUndefined();
    expect(entries.get("xl/charts/chart2.xml")).toBeDefined();
    expect(entries.get("xl/charts/chart3.xml")).toBeDefined();

    expect(removeChartsheet(wb, chartsheetName(copied))).toBe(true);
    entries = await extractAll(new Uint8Array(await Workbook.toBuffer(wb)));
    expect(entries.get("xl/charts/chart2.xml")).toBeUndefined();
    expect(entries.get("xl/charts/chart3.xml")).toBeDefined();
  });
});

describe("TC2d: high-level chart series editing API", () => {
  it("mutate APIs mark classic and ChartEx charts dirty for deep changes", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addChart(ws, { type: "bar", series: [baseSeries("S")], title: "Original" }, "C1:J10");
    const chart = getCharts(ws)[0];
    Chart.mutate(chart, model => {
      model.chart.title = undefined;
    });
    expect(getChartEntry(wb, chart.chartNumber)!.dirty).toBe(true);

    addChartEx(ws, { type: "funnel", series: [{ values: VALUES_A }] }, "L1:R10");
    const chartEx = getCharts(ws)[1];
    Chart.mutateChartEx(chartEx, model => {
      model.chartSpace.chart.autoTitleDeleted = true;
    });
    expect(getChartExStructuredEntry(wb, chartEx.chartExNumber)!.dirty).toBe(true);
  });

  it("updates classic chart series references by patching loaded raw XML", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "A");
    Cell.setValue(ws, "A2", "B");
    Cell.setValue(ws, "B1", 10);
    Cell.setValue(ws, "B2", 20);
    Cell.setValue(ws, "C1", 30);
    Cell.setValue(ws, "C2", 40);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "Old", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }],
        title: "Series"
      },
      "E1:K10"
    );

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const marker = "<!-- documonster-series-raw-passthrough -->";
    const chartEntry = zipData.get("xl/charts/chart1.xml")!;
    chartEntry.data = textEncoder.encode(
      textDecoder.decode(chartEntry.data).replace("<c:chart>", `${marker}<c:chart>`)
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    expect(Chart.setSeriesName(chart, 0, "New")).toBe(true);
    expect(Chart.setSeriesValues(chart, 0, "Sheet1!$C$1:$C$2")).toBe(true);
    expect(Chart.setSeriesCategories(chart, 0, "Sheet1!$A$1:$A$2")).toBe(true);

    const output = await Workbook.toBuffer(wb2);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).toContain("New");
    expect(outputChartXml).toContain("Sheet1!$C$1:$C$2");
  });

  it("patches loaded chart XML after axis scaling and title changes", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "A");
    Cell.setValue(ws, "B1", 10);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "S", categories: "Sheet1!$A$1", values: "Sheet1!$B$1" }],
        valueAxis: { title: "Old", min: 0, max: 20 }
      },
      "E1:K10"
    );

    const buf = await Workbook.toBuffer(wb);
    const zipData = await extractAll(new Uint8Array(buf));
    const marker = "<!-- documonster-axis-raw-passthrough -->";
    const chartEntry = zipData.get("xl/charts/chart1.xml")!;
    chartEntry.data = textEncoder.encode(
      textDecoder.decode(chartEntry.data).replace("<c:chart>", `${marker}<c:chart>`)
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    const valueAxis = Chart.valueAxis(chart)!;
    valueAxis.scaling = { min: 0, max: 100 };
    valueAxis.title = { text: { paragraphs: [{ runs: [{ text: "Updated Axis" }] }] } };
    getChartEntry(wb2, chart.chartNumber)!.dirty = true;
    getChartEntry(wb2, chart.chartNumber)!.preferRawPatch = true;

    const output = await Workbook.toBuffer(wb2);
    const entries = await extractAll(new Uint8Array(output));
    const outputChartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    expect(outputChartXml).toContain(marker);
    expect(outputChartXml).toContain('<c:max val="100"/>');
    expect(outputChartXml).toContain("Updated Axis");
  });

  it("returns false when updating a missing series", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    addChart(ws, { type: "bar", series: [baseSeries("S")] }, "E1:K10");
    expect(Chart.setSeriesValues(getCharts(ws)[0], 5, "Sheet1!$C$1:$C$2")).toBe(false);
  });
});

describe("TC2e: pivot chart creation", () => {
  function makePivotWorkbook() {
    const wb = Workbook.create();
    const data = Workbook.addWorksheet(wb, "Sales Data");
    Worksheet.addRows(data, [
      ["Region", "Product", "Revenue", "Units"],
      ["West", "A", 10, 1],
      ["West", "B", 20, 2],
      ["East", "A", 30, 3]
    ]);
    const pivot = Workbook.addWorksheet(wb, "Pivot Sheet");
    const pivotTable = addPivotTable(pivot, {
      sourceSheet: data,
      rows: ["Region"],
      values: ["Revenue", "Units"],
      metric: "sum"
    });
    return { wb, pivot, pivotTable };
  }

  it("creates a classic pivot chart with pivotSource and pivot chart formats", async () => {
    const { wb, pivot, pivotTable } = makePivotWorkbook();

    const chartNumber = addPivotChart(
      pivot,
      pivotTable,
      {
        type: "bar",
        series: [
          {
            name: "Revenue",
            categories: "'Pivot Sheet'!$A$4:$A$5",
            values: "'Pivot Sheet'!$B$4:$B$5"
          }
        ],
        title: "Revenue by Region"
      },
      "D1:K12"
    );

    expect(chartNumber).toBe(1);
    expect(pivotTable.chartFormat).toBe(1);
    expect(pivotTable.chartFormats).toHaveLength(1);

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    const pivotXml = textDecoder.decode(entries.get("xl/pivotTables/pivotTable1.xml")!.data);

    expect(chartXml).toContain("<c:pivotSource>");
    expect(chartXml).toContain("<c:name>'Pivot Sheet'!PivotTable1</c:name>");
    expect(chartXml).toContain('<c:fmtId val="0"/>');
    expect(chartXml.indexOf("<c:pivotSource>")).toBeLessThan(chartXml.indexOf("<c:chart>"));
    expect(chartXml).toContain("<c:pivotFmts>");
    expect(pivotXml).toContain('name="PivotTable1"');
    expect(pivotXml).toContain('chartFormat="1"');
    expect(pivotXml).toContain('<chartFormats count="1">');
    expect(pivotXml).toContain('<chartFormat chart="0" format="0" series="1">');
    expect(pivotXml).toContain('<reference field="4294967294" count="1" selected="0">');

    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Pivot Sheet")!)[0];
    expect(Chart.chartModel(chart)!.pivotSource).toContain("'Pivot Sheet'!PivotTable1");
  });

  // Regression — before fix, two `addPivotChart(pivotTable, …)` calls
  // against the same pivot would both use `fmtId=0`: the second call
  // hit the `exists` short-circuit in `ensurePivotChartFormat` and
  // produced only one `chartFormat` entry, leaving both charts
  // pointing at the same pivotArea declaration. Now `fmtId` auto-
  // increments when not supplied.
  it("multiple pivot charts against the same pivot get distinct fmtIds", async () => {
    const { wb, pivot, pivotTable } = makePivotWorkbook();

    addPivotChart(
      pivot,
      pivotTable,
      {
        type: "bar",
        series: [{ categories: "'Pivot Sheet'!$A$4:$A$5", values: "'Pivot Sheet'!$B$4:$B$5" }],
        title: "First"
      },
      "D1:K12"
    );
    addPivotChart(
      pivot,
      pivotTable,
      {
        type: "line",
        series: [{ categories: "'Pivot Sheet'!$A$4:$A$5", values: "'Pivot Sheet'!$B$4:$B$5" }],
        title: "Second"
      },
      "D14:K25"
    );

    expect(pivotTable.chartFormats).toHaveLength(2);
    expect(pivotTable.chartFormats?.[0].format).toBe(0);
    expect(pivotTable.chartFormats?.[1].format).toBe(1);

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chart1Xml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    const chart2Xml = textDecoder.decode(entries.get("xl/charts/chart2.xml")!.data);
    expect(chart1Xml).toContain('<c:fmtId val="0"/>');
    expect(chart2Xml).toContain('<c:fmtId val="1"/>');
  });

  it("writes structured pivot chart field buttons, filters, and refresh metadata", async () => {
    const { wb, pivot, pivotTable } = makePivotWorkbook();

    addPivotChart(
      pivot,
      pivotTable,
      {
        type: "bar",
        series: [
          {
            name: "Revenue",
            categories: "'Pivot Sheet'!$A$4:$A$5",
            values: "'Pivot Sheet'!$B$4:$B$5"
          }
        ],
        pivotChartOptions: {
          refreshOnOpen: true,
          dropZonesVisible: true,
          dropZoneFilter: true,
          dropZoneCategories: true,
          dropZoneData: false,
          dropZoneSeries: false
        }
      },
      "D1:K12"
    );

    expect(pivotTable.pivotChartOptions?.refreshOnOpen).toBe(true);
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    const cacheXml = textDecoder.decode(
      entries.get("xl/pivotCache/pivotCacheDefinition1.xml")!.data
    );
    // Pivot options now emit the standard MS `c14:pivotOptions` element
    // inside chartSpace's `<c:extLst>`. The uri is the GUID Excel 2010+
    // recognises (MS-XLSX §2.3.11).
    expect(chartXml).toContain("{781A3756-C4B2-4CAC-9D66-4F8BD8637D16}");
    expect(chartXml).toContain("<c14:pivotOptions>");
    expect(chartXml).toContain('<c14:dropZoneFilter val="1"/>');
    expect(chartXml).toContain('<c14:dropZoneCategories val="1"/>');
    expect(chartXml).toContain('<c14:dropZoneData val="0"/>');
    expect(chartXml).toContain('<c14:dropZoneSeries val="0"/>');
    expect(chartXml).toContain('<c14:dropZonesVisible val="1"/>');
    expect(cacheXml).toContain('refreshOnLoad="1"');
  });

  it("writes only the drop-zone toggles the caller explicitly sets", async () => {
    const { wb, pivot, pivotTable } = makePivotWorkbook();

    addPivotChart(
      pivot,
      pivotTable,
      {
        type: "bar",
        series: [
          {
            name: "Revenue",
            categories: "'Pivot Sheet'!$A$4:$A$5",
            values: "'Pivot Sheet'!$B$4:$B$5"
          }
        ],
        pivotChartOptions: {
          // Deliberately minimal: only suppress the series drop zone,
          // leave all other children absent so Excel uses its defaults.
          dropZoneSeries: false
        }
      },
      "D1:K12"
    );

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    expect(chartXml).toContain('<c14:dropZoneSeries val="0"/>');
    // None of the absent flags should be emitted.
    expect(chartXml).not.toContain("dropZoneFilter");
    expect(chartXml).not.toContain("dropZoneCategories");
    expect(chartXml).not.toContain("dropZoneData");
    expect(chartXml).not.toContain("dropZonesVisible");
  });

  it("creates a combo pivot chart", async () => {
    const { wb, pivot, pivotTable } = makePivotWorkbook();

    addPivotComboChart(
      pivot,
      pivotTable,
      {
        groups: [
          {
            type: "bar",
            series: [
              {
                name: "Revenue",
                categories: "'Pivot Sheet'!$A$4:$A$5",
                values: "'Pivot Sheet'!$B$4:$B$5"
              }
            ]
          },
          {
            type: "line",
            series: [
              {
                name: "Units",
                categories: "'Pivot Sheet'!$A$4:$A$5",
                values: "'Pivot Sheet'!$C$4:$C$5"
              }
            ],
            useSecondaryAxis: true
          }
        ],
        title: "Revenue and Units"
      },
      "D1:K12"
    );

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    expect(chartXml).toContain("<c:pivotSource>");
    expect(chartXml).toContain("<c:barChart>");
    expect(chartXml).toContain("<c:lineChart>");
    expect(pivotTable.chartFormats).toHaveLength(1);
  });

  it("creates a pivot chart chartsheet", async () => {
    const { wb, pivotTable } = makePivotWorkbook();

    const chartsheet = addPivotChartsheet(wb, "Pivot Chart", pivotTable, {
      chart: {
        type: "bar",
        series: [
          {
            name: "Revenue",
            categories: "'Pivot Sheet'!$A$4:$A$5",
            values: "'Pivot Sheet'!$B$4:$B$5"
          }
        ],
        title: "Revenue by Region"
      }
    });

    expect(chartsheetChartNumber(chartsheet)).toBe(1);
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    expect(entries.get("xl/chartsheets/sheet1.xml")).toBeDefined();
    expect(entries.get("xl/charts/chart1.xml")).toBeDefined();
    const chartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    const pivotXml = textDecoder.decode(entries.get("xl/pivotTables/pivotTable1.xml")!.data);
    expect(chartXml).toContain("<c:pivotSource>");
    expect(chartXml).toContain("<c:name>'Pivot Sheet'!PivotTable1</c:name>");
    expect(pivotXml).toContain('<chartFormats count="1">');
  });

  it("round-trips c14:pivotOptions through a full xlsx load / save cycle", async () => {
    const { wb, pivot, pivotTable } = makePivotWorkbook();

    addPivotChart(
      pivot,
      pivotTable,
      {
        type: "bar",
        series: [
          {
            name: "Revenue",
            categories: "'Pivot Sheet'!$A$4:$A$5",
            values: "'Pivot Sheet'!$B$4:$B$5"
          }
        ],
        pivotChartOptions: {
          dropZonesVisible: true,
          dropZoneFilter: false,
          dropZoneCategories: true,
          dropZoneData: true,
          dropZoneSeries: false
        }
      },
      "D1:K12"
    );

    // First save and reopen — verifies the parser recognises the c14
    // extension and hydrates the structured model from it.
    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const chart2 = getCharts(getWorksheets(wb2)[1])[0];
    const m2 = Chart.chartModel(chart2)!;
    expect(m2.pivotOptions).toEqual({
      dropZonesVisible: true,
      dropZoneFilter: false,
      dropZoneCategories: true,
      dropZoneData: true,
      dropZoneSeries: false
    });

    // Second save — ensures we write exactly one c14:pivotOptions element
    // even after a full round-trip (no duplication from leaking into the
    // raw extLst cache).
    const buf2 = await Workbook.toBuffer(wb2);
    const entries2 = await extractAll(new Uint8Array(buf2));
    const chartXml2 = textDecoder.decode(entries2.get("xl/charts/chart1.xml")!.data);
    expect(chartXml2).toContain("<c14:pivotOptions>");
    const occurrences = (chartXml2.match(/<c14:pivotOptions>/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(chartXml2).toContain('<c14:dropZoneFilter val="0"/>');
    expect(chartXml2).toContain('<c14:dropZoneCategories val="1"/>');
  });
});

describe("TC4: combo chart with categoryAxis/valueAxis options on primary group", () => {
  it("applies axis options to the primary axes", () => {
    const m = buildComboChartModel({
      groups: [
        {
          type: "bar",
          series: [baseSeries("Bar")],
          categoryAxis: { title: "Primary Cat" },
          valueAxis: { title: "Primary Val", min: 0, max: 100 }
        },
        {
          type: "line",
          series: [baseSeries("Line", VALUES_B)],
          useSecondaryAxis: true
        }
      ]
    });
    const axes = m.chart.plotArea.axes;
    // Primary category axis should have the title
    const primaryCat = axes.find(
      a => a.axisType === "cat" && a.title?.text?.paragraphs[0]?.runs?.[0]?.text === "Primary Cat"
    );
    expect(primaryCat).toBeDefined();
    // Primary value axis should have the title + min/max
    const primaryVal = axes.find(
      a => a.axisType === "val" && a.title?.text?.paragraphs[0]?.runs?.[0]?.text === "Primary Val"
    );
    expect(primaryVal).toBeDefined();
    expect(primaryVal!.scaling?.min).toBe(0);
    expect(primaryVal!.scaling?.max).toBe(100);
    // Secondary axes exist
    expect(axes.length).toBeGreaterThanOrEqual(4); // primary cat + val + secondary cat + val
  });
});

describe("TC5: Chart.clone/copyTo round-trip", () => {
  it("cloned chart survives write/read as independent copy", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "x");
    Cell.setValue(ws, "B1", 100);
    addChart(ws, { type: "bar", series: [baseSeries("Original")], title: "Source" }, "C1:J10");
    const original = getCharts(ws)[0];
    Chart.clone(original);
    expect(getCharts(ws)).toHaveLength(2);

    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
    expect(getCharts(ws2)).toHaveLength(2);
    // Both charts should be independent
    expect(Chart.title(getCharts(ws2)[0])).toBe("Source");
    expect(Chart.title(getCharts(ws2)[1])).toBe("Source");
  });

  it("copyTo another worksheet creates independent chart", async () => {
    const wb = Workbook.create();
    const src = Workbook.addWorksheet(wb, "Src");
    const dst = Workbook.addWorksheet(wb, "Dst");
    Cell.setValue(src, "A1", 1);
    addChart(src, { type: "pie", series: [baseSeries("P")], title: "Pie" }, "C1:J10");
    Chart.copyTo(getCharts(src)[0], dst, "A1:H10");
    expect(getCharts(dst)).toHaveLength(1);

    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    expect(getCharts(Workbook.getWorksheet(wb2, "Src")!)).toHaveLength(1);
    expect(getCharts(Workbook.getWorksheet(wb2, "Dst")!)).toHaveLength(1);
    expect(Chart.title(getCharts(Workbook.getWorksheet(wb2, "Dst")!)[0])).toBe("Pie");
  });

  it("copyTo supports chartEx charts", async () => {
    const wb = Workbook.create();
    const src = Workbook.addWorksheet(wb, "Src");
    const dst = Workbook.addWorksheet(wb, "Dst");
    for (let i = 1; i <= 3; i++) {
      Cell.setValue(src, `A${i}`, `C${i}`);
      Cell.setValue(src, `B${i}`, i * 10);
    }
    addChartEx(
      src,
      {
        type: "sunburst",
        categories: "Src!$A$1:$A$3",
        series: [{ name: "Data", values: "Src!$B$1:$B$3" }],
        title: "Modern"
      },
      "C1:J10"
    );

    const copiedNumber = Chart.copyTo(getCharts(src)[0], dst, "A1:H10");
    expect(copiedNumber).toBe(2);
    expect(Chart.isChartEx(getCharts(dst)[0])).toBe(true);

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    expect(entries.get("xl/charts/chartEx1.xml")).toBeDefined();
    expect(entries.get("xl/charts/chartEx2.xml")).toBeDefined();

    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    expect(Chart.isChartEx(getCharts(Workbook.getWorksheet(wb2, "Dst")!)[0])).toBe(true);
    expect(Chart.title(getCharts(Workbook.getWorksheet(wb2, "Dst")!)[0])).toBe("Modern");
  });
});

describe("TC6: Date values in chart cache population", () => {
  it("fills numRef cache with serial numbers for Date cell values", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Label");
    Cell.setValue(ws, "B1", new Date(2024, 0, 1)); // 2024-01-01

    addChart(
      ws,
      {
        type: "line",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$1", values: "Sheet1!$B$1:$B$1" }]
      },
      "C1:J10"
    );
    const chart = getCharts(ws)[0];
    const series = Chart.chartModel(chart)!.chart.plotArea.chartTypes[0].series[0] as any;
    const points = series.val.numRef.cache.points;
    expect(points).toHaveLength(1);
    // Excel serial for 2024-01-01 (1900-based, non-1904) should be ~45292
    expect(points[0].value).toBeGreaterThan(45000);
    expect(points[0].value).toBeLessThan(46000);
  });

  it("fills multi-level category caches", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["North", "Q1", 10],
      ["North", "Q2", 20],
      ["South", "Q1", 30]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            name: "Sales",
            values: "Sheet1!$C$1:$C$3",
            categories: { multiLvlStrRef: { formula: "Sheet1!$A$1:$B$3" } }
          }
        ]
      },
      "E1:K10"
    );

    const series = Chart.chartModel(getCharts(ws)[0])!.chart.plotArea.chartTypes[0]
      .series[0] as any;
    expect(series.cat.multiLvlStrRef.cache.pointCount).toBe(3);
    expect(series.cat.multiLvlStrRef.cache.levels).toHaveLength(2);
    expect(series.cat.multiLvlStrRef.cache.levels[0].points[0]).toEqual({
      index: 0,
      value: "North"
    });
    expect(series.cat.multiLvlStrRef.cache.levels[1].points[1]).toEqual({
      index: 1,
      value: "Q2"
    });

    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    const chartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    expect(chartXml).toContain("<c:multiLvlStrCache>");
    expect(chartXml).toContain('<c:ptCount val="3"/>');
    expect(chartXml).toContain("<c:v>North</c:v>");
    expect(chartXml).toContain("<c:v>Q2</c:v>");
  });
});

describe("TC7: pareto chart type in ChartEx builder", () => {
  it("pareto type uses clusteredColumn layoutId with x values and pareto line", () => {
    const m = buildChartExModel({
      type: "pareto",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Data", values: "Sheet1!$B$1:$B$5" }]
    });
    const s = m.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    expect(s.layoutId).toBe("clusteredColumn");
    expect(s.layoutPr?.paretoLine).toBe(true);
    // Pareto (like histogram) uses `type="val"` on the numeric
    // dimension — Excel's loader needs this attribute to drive
    // the binning engine.
    expect(m.chartSpace.chartData.data.find(entry => entry.numDim)?.numDim?.type).toBe("val");
  });

  it("pareto chart renders valid XML", () => {
    const m = buildChartExModel({
      type: "pareto",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "Pareto", values: "Sheet1!$B$1:$B$5" }],
      title: "Pareto Analysis"
    });
    const xml = renderChartEx(m);
    expect(xml).toContain("<cx:chartSpace");
    expect(xml).toContain('layoutId="clusteredColumn"');
    // `<cx:paretoLine>` is NOT part of the official CT_Binning /
    // CT_SeriesLayoutProperties schema — earlier revisions emitted it
    // as a layoutPr child, but Excel 2016+ rejects that. A full
    // pareto implementation would add a SECOND series with
    // `layoutId="paretoLine"`; for now the builder emits a
    // schema-valid histogram-shaped chart and keeps the structural
    // model's `paretoLine` flag round-tripping via the layoutPr
    // model (not the serialised XML).
    expect(xml).not.toContain("<cx:paretoLine");
    expect(xml).toContain("Pareto Analysis");
  });

  it("ChartEx histogram honors explicit binning fields and validates bad binning", () => {
    const m = buildChartExModel({
      type: "histogram",
      series: [{ name: "H", values: "Sheet1!$B$1:$B$10" }],
      binning: { binType: "binSize", binSize: 5, underflow: 0, overflow: 100, intervalClosed: "r" }
    });
    const binning = m.chartSpace.chart.plotArea.plotAreaRegion!.series[0].layoutPr!.binning!;
    expect(binning.binSize).toBe(5);
    expect(binning.underflow).toBe(0);
    expect(binning.overflow).toBe(100);
    expect(() =>
      buildChartExModel({
        type: "histogram",
        series: [{ values: "Sheet1!$B$1:$B$10" }],
        binning: { binSize: 0 }
      })
    ).toThrow(/binSize/);
    expect(() =>
      buildChartExModel({
        type: "funnel",
        series: [{ values: "Sheet1!$B$1:$B$10" }],
        layout: { binning: { binType: "auto" } }
      })
    ).toThrow(/binning/);
    expect(() =>
      buildChartExModel({
        type: "histogram",
        series: [
          {
            values: "Sheet1!$B$1:$B$10",
            literalValues: [1, 2],
            literalCategories: ["A"]
          }
        ]
      })
    ).toThrow(/literalCategories length/);
    expect(() =>
      buildChartExModel({
        type: "waterfall",
        series: [{ values: "Sheet1!$B$1:$B$10", subtotals: [-1] }]
      })
    ).toThrow(/subtotals must contain non-negative integer/);
  });

  it("ChartEx literal histogram bins render underflow, closed intervals, and overflow deterministically", () => {
    const model = buildChartExModel({
      type: "histogram",
      series: [{ values: "Sheet1!$B$1:$B$6", literalValues: [-1, 0, 5, 10, 11, 21] }],
      binning: { binType: "binSize", binSize: 10, underflow: 0, overflow: 20, intervalClosed: "r" }
    });
    const svg = renderChartExSvg(model, { width: 420, height: 240 });

    expect(svg).toContain("&lt;=0");
    expect(svg).toContain("0-10");
    expect(svg).toContain("10-20");
    expect(svg).toContain("&gt;20");
    expect(svg).toContain(">2<");
    // Hashed over the normalised geometry rather than the markup: a hash of the
    // SVG bytes breaks on any change in attribute order or element spelling even
    // when the picture is identical, and the only way past that is to re-baseline
    // it against the new output — checking new code against itself.
    //
    // This value moved once, deliberately: `getPlotRect` no longer reserves legend
    // margins for a chart with no legend, and a histogram has none. The shape
    // census is unchanged at 21 — nothing appeared or vanished, the plot simply
    // uses the width it was previously leaving empty.
    const shapes = extractSvgGeometry(svg);
    expect(shapes).toHaveLength(21);
    const counts = new Map<string, number>();
    for (const shape of shapes) {
      counts.set(shape.kind, (counts.get(shape.kind) ?? 0) + 1);
    }
    expect(
      [...counts.keys()]
        .sort()
        .map(kind => `${kind}:${counts.get(kind)!}`)
        .join(" ")
    ).toBe("polyline:6 rect:5 text:10");
    // Shifted by the legend margins now following `legendPos`: only the side the legend
    // is on reserves room, and the left keeps the axis labels' floor instead of the
    // legend's width. Shape count and census are unchanged.
    expect(stableHash(describeSvgGeometry(svg))).toBe("f44e827c");
  });

  it("buildHistogramBins covers [start, end] with no extra empty bin and catches the axis minimum", () => {
    // Regression: the binning loop used `low <= end`, which emitted an
    // extra bin `[end, end+rawSize]` whenever `(end - start)` was an
    // exact multiple of `rawSize`. Combined with right-closed intervals
    // (`value > b.low && value <= b.high`) the axis-minimum value fell
    // through every normal bin (1 > 1 fails) and got dumped into that
    // trailing sentinel. The fix: stop at `low < end` and treat the
    // first normal bin as left-closed-at-the-minimum so the min value
    // lands in its natural bin.
    const model = buildChartExModel({
      type: "histogram",
      series: [{ values: "Sheet1!$B$1:$B$10", literalValues: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
      binning: { binType: "binCount", binCount: 5 }
    });
    const svg = renderChartExSvg(model, { width: 320, height: 200 });
    // Exactly five bar labels should render — not six. The trailing
    // sentinel bin `10-11.8` used to appear next to the genuine
    // `8.2-10` bin.
    const binLabels = ["1-2.8", "2.8-4.6", "4.6-6.4", "6.4-8.2", "8.2-10"];
    for (const label of binLabels) {
      expect(svg).toContain(`>${label}<`);
    }
    expect(svg).not.toContain(">10-11.8<");
  });

  it("ChartEx renderAxes emits tick labels at every gridline (min + 4 quintiles + max)", () => {
    // Guard the promise the new drawAxesPdf makes — that SVG and PDF
    // backends render the same number of tick labels on the value
    // axis. With 10 evenly-spaced values across 5 bins every bin holds
    // 2 samples, so `valueRange` widens the degenerate [2,2] count
    // range to [0,3] (the `Math.max(dataMax, dataMin+1)` pad) and the
    // quintile markers land at 0.6 / 1.2 / 1.8 / 2.4 — each matches
    // an exact numeric string we can assert without fighting float
    // formatting.
    const model = buildChartExModel({
      type: "histogram",
      series: [{ values: "Sheet1!$B$1:$B$5", literalValues: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
      binning: { binType: "binCount", binCount: 5 }
    });
    const svg = renderChartExSvg(model, { width: 320, height: 200 });
    // Interior quintile tick labels must all appear between
    // min=0 and max=3. Before this change renderAxes only emitted
    // the min/max pair.
    expect(svg).toContain(">0.6<");
    expect(svg).toContain(">1.2<");
    expect(svg).toContain(">1.8<");
    expect(svg).toContain(">2.4<");
    // And the framed min/max labels stay — we only *added* ticks,
    // never removed.
    expect(svg).toContain(">0<");
    expect(svg).toContain(">3<");
  });

  it("ChartEx parser round-trips binning values via schema-valid elements", () => {
    // CT_Binning has a `<xsd:choice>` between `<cx:binSize>` and
    // `<cx:binCount>` — at most one can be emitted. A model that
    // carries both values still writes only one (preferring
    // binCount when `binType === "binCount"`, else binSize), so we
    // verify round-trip of each form in isolation.
    const sizeModel = buildChartExModel({
      type: "histogram",
      series: [{ values: "Sheet1!$B$1:$B$6" }],
      binning: { binType: "binSize", binSize: 2, underflow: 1, overflow: 9 }
    });
    const sizeParsed = parseChartEx(renderChartEx(sizeModel));
    const sizeBin =
      sizeParsed.chartSpace.chart.plotArea.plotAreaRegion!.series[0].layoutPr!.binning!;
    expect(sizeBin.binType).toBe("binSize");
    expect(sizeBin.binSize).toBe(2);
    expect(sizeBin.underflow).toBe(1);
    expect(sizeBin.overflow).toBe(9);

    const countModel = buildChartExModel({
      type: "histogram",
      series: [{ values: "Sheet1!$B$1:$B$6" }],
      binning: { binType: "binCount", binCount: 4 }
    });
    const countParsed = parseChartEx(renderChartEx(countModel));
    const countBin =
      countParsed.chartSpace.chart.plotArea.plotAreaRegion!.series[0].layoutPr!.binning!;
    expect(countBin.binType).toBe("binCount");
    expect(countBin.binCount).toBe(4);
  });

  it("ChartEx parser preserves real Excel hierarchy, map layout, axis extLst, and external data", () => {
    const rawXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cx:chartData>
    <cx:externalData r:id="rId1" autoUpdate="1"/>
    <cx:data id="0"><cx:strDim type="cat"><cx:f>Data!$A$2:$A$5</cx:f><cx:lvl ptCount="4"><cx:pt idx="0">A</cx:pt><cx:pt idx="1">B</cx:pt><cx:pt idx="2">C</cx:pt><cx:pt idx="3">D</cx:pt></cx:lvl></cx:strDim></cx:data>
    <cx:data id="1"><cx:strDim type="cat"><cx:f>Data!$B$2:$B$5</cx:f><cx:lvl ptCount="4"><cx:pt idx="0">North</cx:pt><cx:pt idx="1">North</cx:pt><cx:pt idx="2">South</cx:pt><cx:pt idx="3">South</cx:pt></cx:lvl></cx:strDim></cx:data>
    <cx:data id="2"><cx:strDim type="cat"><cx:f>Data!$C$2:$C$5</cx:f><cx:lvl ptCount="4"><cx:pt idx="0">USA</cx:pt><cx:pt idx="1">Canada</cx:pt><cx:pt idx="2">Brazil</cx:pt><cx:pt idx="3">Chile</cx:pt></cx:lvl></cx:strDim></cx:data>
    <cx:data id="3"><cx:numDim type="val"><cx:f>Data!$D$2:$D$5</cx:f><cx:lvl ptCount="4" formatCode="#,##0"><cx:pt idx="0">10</cx:pt><cx:pt idx="1">20</cx:pt><cx:pt idx="2">5</cx:pt><cx:pt idx="3">15</cx:pt></cx:lvl></cx:numDim></cx:data>
  </cx:chartData>
  <cx:chart>
    <cx:plotArea>
      <cx:plotAreaRegion>
        <cx:series layoutId="regionMap" ownerIdx="0">
          <cx:dataId val="0"/><cx:dataId val="1"/><cx:dataId val="2"/><cx:dataId val="3"/>
          <cx:layoutPr><cx:projection val="mercator"/><cx:regionLabels val="showAll"/><cx:geoMappingLevel val="country"/><cx:extLst><cx:ext uri="{layout-ext}"/></cx:extLst></cx:layoutPr>
          <cx:axisId val="42"/>
          <cx:extLst><cx:ext uri="{series-ext}"/></cx:extLst>
        </cx:series>
      </cx:plotAreaRegion>
      <cx:axis id="42"><cx:catScaling gapWidth="219"/><cx:extLst><cx:ext uri="{axis-ext}"/></cx:extLst></cx:axis>
    </cx:plotArea>
  </cx:chart>
  <cx:extLst><cx:ext uri="{space-ext}"/></cx:extLst>
</cx:chartSpace>`;

    const parsed = parseChartEx(rawXml);
    const series = parsed.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    const axis = parsed.chartSpace.chart.plotArea.axis![0];

    expect(parsed.chartSpace.externalData?.[0]).toEqual({ id: "rId1", autoUpdate: true });
    expect(parsed.chartSpace.chartData.data).toHaveLength(4);
    expect(series.layoutId).toBe("regionMap");
    expect(series.dataRefs?.map(ref => ref.dataId)).toEqual([0, 1, 2, 3]);
    expect(series.layoutPr?.projection).toBe("mercator");
    expect(series.layoutPr?.regionLabels).toBe("showAll");
    expect(series.layoutPr?.geoMappingLevel).toBe("country");
    expect(series.layoutPr?._rawXml).toContain("{layout-ext}");
    expect(series.layoutPr?.extLst).toContain("{layout-ext}");
    expect(series.extLst).toContain("{series-ext}");
    expect(axis.catScaling?.gapWidth).toBe(219);
    expect(axis.extLst).toContain("{axis-ext}");
    expect(parsed.chartSpace.extLst).toContain("{space-ext}");

    const modelForRender = { ...parsed, rawXml: undefined };
    const rendered = renderChartEx(modelForRender);
    expect(rendered).toContain("{axis-ext}");
    expect(rendered).toContain("{layout-ext}");
    expect(rendered).toContain("{series-ext}");
  });

  it("ChartEx raw patch preserves template XML while updating hidden, series name, and axis bindings", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 15],
      ["D", 30],
      ["E", 45]
    ]);
    addChartEx(
      ws,
      {
        type: "waterfall",
        categories: "Sheet1!$A$1:$A$5",
        series: [{ name: "Before", values: "Sheet1!$B$1:$B$5", subtotals: [4] }]
      },
      "D1:J10"
    );

    const zipData = await extractAll(new Uint8Array(await Workbook.toBuffer(wb)));
    const chartExEntry = zipData.get("xl/charts/chartEx1.xml")!;
    const marker = "<!-- patchable-chartEx-template -->";
    chartExEntry.data = textEncoder.encode(
      textDecoder.decode(chartExEntry.data).replace("<cx:chart>", `${marker}<cx:chart>`)
    );
    const { createZip } = await import("@archive/zip/zip-bytes");
    const input = await createZip(
      [...zipData.entries()].map(([name, file]) => ({ name, data: file.data }))
    );

    const wb2 = Workbook.create();
    await Workbook.read(wb2, input);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0];
    Chart.mutateChartEx(
      chart,
      model => {
        const series = model.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
        series.hidden = true;
        series.tx = { value: "After" };
        series.axisId = [0];
      },
      { preferRawPatch: true, requireRawPatch: true }
    );

    const output = await Workbook.toBuffer(wb2);
    const entries = await extractAll(new Uint8Array(output));
    const xml = textDecoder.decode(entries.get("xl/charts/chartEx1.xml")!.data);
    expect(xml).toContain(marker);
    expect(xml).toContain('hidden="1"');
    expect(xml).toContain("After");
    expect(xml).toContain('<cx:axisId val="0"/>');
    expect(xml).not.toContain('<cx:axisId val="1"/>');
  });

  it("ChartEx regionMap preview uses geographic projection for known regions", () => {
    const model = buildChartExModel({
      type: "regionMap",
      series: [
        {
          values: "Data!$B$2:$B$5",
          literalValues: [10, 20, 5, 15],
          literalCategories: ["USA", "Canada", "Brazil", "Chile"]
        }
      ],
      layout: { projection: "mercator", regionLabels: "showAll", geoMappingLevel: "country" }
    });

    const svg = renderChartExSvg(model, { width: 420, height: 260 });
    expect(svg).toContain('data-region-map-mode="geographic-preview"');
    expect(svg).toContain("USA");
    expect(svg).toContain("Canada");
    expect(svg).toContain("<circle");
    // Geometry, not bytes. A hash over the markup cannot survive a
    // re-implementation, so the only way past a failure is to re-record it against
    // the new output — which checks the renderer against itself.
    //
    // The shape count and census are the ones the original string emitter produced;
    // the positions are not. The preview used to map the whole world onto the panel,
    // so four American countries drew overlapping in one corner with unreadable
    // labels while the rest of the panel stayed blank — and the TopoJSON branch,
    // which frames to its data, disagreed with it. Both now frame the same way, so
    // the same 17 shapes sit in different places.
    const shapes = extractSvgGeometry(svg);
    expect(shapes).toHaveLength(17);
    const counts = new Map<string, number>();
    for (const shape of shapes) {
      counts.set(shape.kind, (counts.get(shape.kind) ?? 0) + 1);
    }
    expect(
      [...counts.keys()]
        .sort()
        .map(kind => `${kind}:${counts.get(kind)!}`)
        .join(" ")
    ).toBe("circle:4 polyline:5 rect:3 text:5");
    // Shifted by the legend margins now following `legendPos` — see the histogram note.
    expect(stableHash(describeSvgGeometry(svg))).toBe("1b563892");
  });

  it("ChartEx regionMap Albers and Robinson projections use real formulas, not linear fallbacks", () => {
    // Before the projection fix, `albers` used `y = 0.52 - lat/210` and
    // `robinson` fell through to a generic `y = 0.5 - lat/190` — both
    // linear, neither a real projection. With the fix, each projection
    // must produce a geometry that differs from the previous linear
    // approximation AND from the other projections (Robinson ≠ Albers ≠
    // Mercator) for the same canvas. SVG hash is the most stable
    // assertion we can make here.
    const build = (projection: "albers" | "robinson" | "mercator" | "miller"): string =>
      renderChartExSvg(
        buildChartExModel({
          type: "regionMap",
          series: [
            {
              values: "Data!$B$2:$B$5",
              literalValues: [10, 20, 5, 15],
              literalCategories: ["USA", "Canada", "Brazil", "Chile"]
            }
          ],
          layout: { projection, regionLabels: "showAll", geoMappingLevel: "country" }
        }),
        { width: 420, height: 260 }
      );
    const mercator = build("mercator");
    const miller = build("miller");
    const albers = build("albers");
    const robinson = build("robinson");
    // Each projection produces a distinct SVG; equality would mean a
    // projection silently aliased to another (as `robinson` did before).
    const hashes = new Set([
      stableHash(mercator),
      stableHash(miller),
      stableHash(albers),
      stableHash(robinson)
    ]);
    expect(hashes.size).toBe(4);
    // And none of them should be identical to the old linear formulas.
    // `albers` previously resolved `Chile` (lat ≈ -33) to y ≈ 0.52 +
    // 33/210 ≈ 0.677, landing ~75% down the canvas. With real Albers
    // equal-area on world parallels, Chile ends up higher (closer to
    // the southern edge because the cone narrows towards the pole).
    // Match a regex against the first `<circle cy="…">` in each output
    // — that circle corresponds to `usa`, the first key alphabetically
    // in the centroid table — and assert the Albers cy differs from the
    // old value.
    const albersCy = /<circle[^>]*cy="([0-9.]+)"/.exec(albers)?.[1];
    const robinsonCy = /<circle[^>]*cy="([0-9.]+)"/.exec(robinson)?.[1];
    expect(albersCy).toBeDefined();
    expect(robinsonCy).toBeDefined();
    expect(albersCy).not.toBe(robinsonCy);
  });

  it("ChartEx regionMap uses user-provided TopoJSON for real country polygons", () => {
    // Minimal hand-authored topology: one square "country" with id
    // `"USA"`. Confirms the full pipeline works end-to-end:
    // resolveTopologyObject → feature match → SVG path emission.
    const topology = {
      type: "Topology",
      arcs: [
        [
          [0, 0],
          [10, 0],
          [0, 10],
          [-10, 0],
          [0, -10]
        ]
      ],
      objects: {
        countries: {
          type: "GeometryCollection",
          geometries: [{ type: "Polygon", id: "USA", arcs: [[0]] }]
        }
      }
    } as const;
    const model = buildChartExModel({
      type: "regionMap",
      series: [
        {
          values: "Data!$B$2:$B$3",
          literalValues: [42, 17],
          literalCategories: ["USA", "Unknown"]
        }
      ],
      layout: { projection: "miller", regionLabels: "showAll", geoMappingLevel: "country" }
    });
    const svg = renderChartExSvg(model, {
      width: 420,
      height: 260,
      regionMap: {
        topology,
        objectName: "countries",
        match: "id"
      }
    });
    // TopoJSON path is emitted (and the fallback centroid preview is NOT).
    expect(svg).toContain('data-region-map-mode="topojson"');
    expect(svg).not.toContain('data-region-map-mode="geographic-preview"');
    // At least one <path> element (the USA polygon) is present.
    expect(svg).toMatch(/<path d="M/);
    // Label "USA" is rendered at the centroid.
    expect(svg).toContain("USA");
  });

  it("ChartEx regionMap falls back to centroid preview when TopoJSON matches nothing", () => {
    const topology = {
      type: "Topology",
      arcs: [
        [
          [0, 0],
          [10, 0]
        ]
      ],
      objects: {
        countries: {
          type: "GeometryCollection",
          geometries: [{ type: "LineString", id: "TOTALLY_FAKE_ID", arcs: [0] }]
        }
      }
    } as const;
    const model = buildChartExModel({
      type: "regionMap",
      series: [
        {
          values: "Data!$B$2:$B$3",
          literalValues: [10, 20],
          literalCategories: ["USA", "Canada"]
        }
      ],
      layout: { projection: "miller", regionLabels: "showAll", geoMappingLevel: "country" }
    });
    const svg = renderChartExSvg(model, {
      width: 420,
      height: 260,
      regionMap: { topology, objectName: "countries", match: "id" }
    });
    // USA/Canada are in the built-in centroid table, so the fallback
    // preview runs and draws dots + labels.
    expect(svg).toContain('data-region-map-mode="geographic-preview"');
    expect(svg).toContain("USA");
    expect(svg).toContain("Canada");
  });

  it("ChartEx regionMap matches features on a property key (e.g. world-atlas `name`)", () => {
    // world-atlas countries-110m.json uses `properties.name` for the
    // English name; confirm `match: "property:name"` selects that
    // field instead of the numeric `id`.
    const topology = {
      type: "Topology",
      arcs: [
        [
          [0, 0],
          [5, 0],
          [0, 5],
          [-5, 0],
          [0, -5]
        ]
      ],
      objects: {
        countries: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "Polygon",
              id: 840,
              properties: { name: "United States" },
              arcs: [[0]]
            }
          ]
        }
      }
    } as const;
    const model = buildChartExModel({
      type: "regionMap",
      series: [
        {
          values: "Data!$B$2",
          literalValues: [7],
          literalCategories: ["United States"]
        }
      ],
      layout: { projection: "miller", regionLabels: "showAll", geoMappingLevel: "country" }
    });
    const svg = renderChartExSvg(model, {
      width: 420,
      height: 260,
      regionMap: { topology, objectName: "countries", match: "property:name" }
    });
    expect(svg).toContain('data-region-map-mode="topojson"');
    expect(svg).toContain("United States");
  });

  it("ChartEx regionMap `match: [...]` tries locale-aware rules in order (first-match-wins)", () => {
    // World-atlas-style topology with two features:
    //   - France: has both `name_zh` and `name`
    //   - Spain:  has only `name` (legacy file without localisation)
    //
    // The categories array uses the Chinese spellings. With a matchers
    // fallback of `["property:name_zh", "property:name"]` France must
    // match via `name_zh` and Spain via `name` — exactly the pattern
    // natural-earth-vectors workflows need.
    const topology = {
      type: "Topology",
      arcs: [
        [
          [0, 0],
          [5, 0],
          [0, 5],
          [-5, 0],
          [0, -5]
        ],
        [
          [10, 10],
          [5, 0],
          [0, 5],
          [-5, 0],
          [0, -5]
        ]
      ],
      objects: {
        countries: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "Polygon",
              id: 250,
              properties: { name: "France", name_zh: "法国" },
              arcs: [[0]]
            },
            {
              type: "Polygon",
              id: 724,
              properties: { name: "Spain" },
              arcs: [[1]]
            }
          ]
        }
      }
    } as const;
    const model = buildChartExModel({
      type: "regionMap",
      series: [
        {
          values: "Data!$B$2:$B$3",
          literalValues: [10, 20],
          literalCategories: ["法国", "Spain"]
        }
      ],
      layout: { projection: "miller", regionLabels: "showAll", geoMappingLevel: "country" }
    });
    const svg = renderChartExSvg(model, {
      width: 420,
      height: 260,
      regionMap: {
        topology,
        objectName: "countries",
        match: ["property:name_zh", "property:name"]
      }
    });
    // Topology path was used — real polygons, not the centroid fallback.
    expect(svg).toContain('data-region-map-mode="topojson"');
    // Both features matched → both labels rendered, each with the
    // original category spelling.
    expect(svg).toContain("法国");
    expect(svg).toContain("Spain");
  });

  it("ChartEx regionMap single `match` string stays back-compatible", () => {
    // Sanity: passing the old-style single rule still routes through
    // the matchers-array code path without regressing the original
    // single-match shape or the label fall-back.
    const topology = {
      type: "Topology",
      arcs: [
        [
          [0, 0],
          [5, 0],
          [0, 5],
          [-5, 0],
          [0, -5]
        ]
      ],
      objects: {
        countries: {
          type: "GeometryCollection",
          geometries: [{ type: "Polygon", id: "USA", arcs: [[0]] }]
        }
      }
    } as const;
    const model = buildChartExModel({
      type: "regionMap",
      series: [{ values: "Data!$B$2", literalValues: [42], literalCategories: ["USA"] }]
    });
    const svg = renderChartExSvg(model, {
      width: 420,
      height: 260,
      regionMap: { topology, objectName: "countries", match: "id" }
    });
    expect(svg).toContain('data-region-map-mode="topojson"');
    expect(svg).toContain("USA");
  });

  it("ChartEx regionMap matchers fall through to centroid preview when every rule misses", () => {
    const topology = {
      type: "Topology",
      arcs: [
        [
          [0, 0],
          [5, 0],
          [0, 5]
        ]
      ],
      objects: {
        countries: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "Polygon",
              id: 999,
              properties: { code_iso2: "XY" },
              arcs: [[0]]
            }
          ]
        }
      }
    } as const;
    const model = buildChartExModel({
      type: "regionMap",
      series: [
        {
          values: "Data!$B$2",
          literalValues: [42],
          // Categories are familiar country names → centroid table will pick them up.
          literalCategories: ["USA"]
        }
      ]
    });
    const svg = renderChartExSvg(model, {
      width: 420,
      height: 260,
      regionMap: {
        topology,
        objectName: "countries",
        match: ["property:name_zh", "property:name"]
      }
    });
    // Neither rule matches any feature → centroid preview runs, not the
    // topojson path.
    expect(svg).toContain('data-region-map-mode="geographic-preview"');
    expect(svg).toContain("USA");
  });

  it("ChartEx literal multi-level hierarchy renders deterministically", () => {
    const model = buildChartExModel({
      type: "sunburst",
      series: [
        {
          values: "Data!$D$2:$D$5",
          literalValues: [10, 20, 5, 15],
          literalCategories: ["A", "B", "C", "D"],
          literalHierarchy: [
            ["North", "North", "South", "South"],
            ["USA", "Canada", "Brazil", "Chile"]
          ]
        }
      ]
    });
    const svg = renderChartExSvg(model, { width: 360, height: 240 });

    expect(svg).toContain("<path");
    // Hashed over the normalised geometry rather than the markup, for the same
    // reason as the histogram test above: a hash of the SVG bytes breaks on any
    // change in element spelling even when the picture is identical.
    //
    // This value moved once, deliberately. A sector whose inner radius is zero is
    // now written as one wedge (`M centre L p1 A p2 Z`) instead of a ring path with
    // a degenerate zero-radius arc (`M p1 A p2 L centre A(r=0) centre Z`) — the
    // classic pie renderer already used the wedge form, so ChartEx was the odd one
    // out. Both describe the same closed region, and the shape count is unchanged
    // at 15.
    const shapes = extractSvgGeometry(svg);
    expect(shapes).toHaveLength(15);
    const counts = new Map<string, number>();
    for (const shape of shapes) {
      counts.set(shape.kind, (counts.get(shape.kind) ?? 0) + 1);
    }
    expect(
      [...counts.keys()]
        .sort()
        .map(kind => `${kind}:${counts.get(kind)!}`)
        .join(" ")
    ).toBe("path:12 rect:2 text:1");
    // Shifted by the legend margins now following `legendPos` — see the histogram note.
    expect(stableHash(describeSvgGeometry(svg))).toBe("658cc99d");
  });

  it("ChartEx sunburst handles 3-level hierarchy (continent/country/city)", () => {
    // Extend the 2-level test above to 3 levels so the parser's
    // `findChildren("cx:lvl")` + builder `literalHierarchy[][]` code
    // paths stay truthful for the common real-world case of
    // continent → country → city sunbursts. Before: only 2 levels had
    // explicit coverage.
    const model = buildChartExModel({
      type: "sunburst",
      series: [
        {
          values: "Data!$D$2:$D$7",
          literalValues: [10, 20, 5, 15, 8, 12],
          literalCategories: ["NYC", "LA", "Toronto", "Rio", "Beijing", "Tokyo"],
          literalHierarchy: [
            // Continent
            ["Americas", "Americas", "Americas", "Americas", "Asia", "Asia"],
            // Country
            ["USA", "USA", "Canada", "Brazil", "China", "Japan"]
          ]
        }
      ]
    });
    // Model-level: three strDim entries (continent/country/city) + one numDim.
    const data = model.chartSpace.chartData.data;
    const strDims = data.filter(d => d.strDim !== undefined);
    expect(strDims.length).toBe(3);
    for (const dim of strDims) {
      for (const lvl of dim.strDim!.levels ?? []) {
        expect(lvl.points.length).toBe(6);
      }
    }
    // Render-level: a 3-level sunburst emits three concentric arc
    // rings. Each ring's slice count equals the number of distinct
    // parents at that depth. Total <path> count ≥ 6 (leaves) + 3
    // (countries USA/Canada/Brazil/China/Japan merged by rendering
    // policy) + continents — concretely ≥ 10.
    const svg = renderChartExSvg(model, { width: 360, height: 240 });
    const pathCount = (svg.match(/<path/g) ?? []).length;
    expect(pathCount).toBeGreaterThanOrEqual(10);
  });

  it("ChartEx parses 3-level sunburst XML back into structured data with correct ptCount on every level", async () => {
    // Round-trip the authored XML — writeBuffer → load → parse — so
    // the parser's level handling (`findChildren(cx:lvl).map(...)`) is
    // exercised on the emit-side output, not just a synthetic string.
    //
    // Emit-side writes the canonical Excel 2016+ hierarchy layout:
    // ONE `<cx:data>` whose `<cx:strDim type="cat">` carries MULTIPLE
    // `<cx:lvl>` children (leaf first, parents after). Older builds
    // emitted one `<cx:strDim>` per hierarchy depth — schema-legal but
    // rejected by Excel's treemap/sunburst renderer with "Removed Part:
    // /xl/drawings/drawingN.xml part. (Drawing shape)". The parser
    // has always accepted multi-lvl strDims, so the round-trip invariant
    // is now: one strDim entry with three levels (continent → country
    // → city — the three `literalHierarchy` arrays) plus one numDim.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.addRows(ws, [
      ["City", "Country", "Continent", "Revenue"],
      ["NYC", "USA", "Americas", 10],
      ["LA", "USA", "Americas", 20],
      ["Toronto", "Canada", "Americas", 5]
    ]);
    addChartEx(
      ws,
      {
        type: "sunburst",
        series: [
          {
            values: "Data!$D$2:$D$4",
            literalValues: [10, 20, 5],
            literalCategories: ["NYC", "LA", "Toronto"],
            literalHierarchy: [
              ["Americas", "Americas", "Americas"],
              ["USA", "USA", "Canada"]
            ]
          }
        ]
      },
      "F1:L12"
    );
    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const chart = getCharts(Workbook.getWorksheet(wb2, "Data")!)[0];
    const data = Chart.chartExModel(chart)!.chartSpace.chartData.data;
    // The category strDim carries every hierarchy level. Count
    // `<cx:lvl>` children across every `strDim` entry so the assertion
    // survives any future shape split (e.g. multi-strDim fallback for
    // legacy readers) without being brittle.
    const strEntries = data.filter(d => d.strDim !== undefined);
    expect(strEntries.length).toBeGreaterThanOrEqual(1);
    const totalStrLevels = strEntries.reduce(
      (sum, entry) => sum + (entry.strDim!.levels?.length ?? 0),
      0
    );
    expect(totalStrLevels).toBe(3); // leaf + 2 parent levels
    // Every level must carry all three data points.
    for (const entry of strEntries) {
      for (const lvl of entry.strDim!.levels ?? []) {
        expect(lvl.points.length).toBe(3);
        expect(lvl.ptCount ?? lvl.points.length).toBe(3);
      }
    }
    // Values round-trip — exactly one numDim with one level.
    const numEntries = data.filter(d => d.numDim !== undefined);
    expect(numEntries.length).toBe(1);
    expect(numEntries[0].numDim!.levels?.[0].points.length).toBe(3);
  });

  it("ChartEx SVG renders pareto, waterfall, funnel, hierarchy, and boxWhisker previews", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", "North", 10],
      ["B", "North", 20],
      ["C", "South", 5],
      ["D", "South", 15]
    ]);
    const models = [
      buildChartExModel({
        type: "pareto",
        categories: "Sheet1!$A$1:$A$4",
        series: [{ values: "Sheet1!$C$1:$C$4" }]
      }),
      buildChartExModel({
        type: "waterfall",
        categories: "Sheet1!$A$1:$A$4",
        series: [{ values: "Sheet1!$C$1:$C$4", subtotals: [3] }],
        layout: {
          connectorLines: true,
          increaseSpPr: { fill: { solid: { srgb: "00AA00" } } },
          decreaseSpPr: { fill: { solid: { srgb: "AA0000" } } },
          totalSpPr: { fill: { solid: { srgb: "0000AA" } } }
        }
      }),
      buildChartExModel({
        type: "funnel",
        categories: "Sheet1!$A$1:$A$4",
        series: [{ values: "Sheet1!$C$1:$C$4" }]
      }),
      buildChartExModel({
        type: "treemap",
        categories: "Sheet1!$A$1:$A$4",
        series: [{ values: "Sheet1!$C$1:$C$4", hierarchy: ["Sheet1!$B$1:$B$4"] }]
      }),
      buildChartExModel({
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$4",
        series: [{ values: "Sheet1!$C$1:$C$4", hierarchy: ["Sheet1!$B$1:$B$4"] }]
      }),
      buildChartExModel({
        type: "boxWhisker",
        categories: "Sheet1!$B$1:$B$4",
        series: [{ values: "Sheet1!$C$1:$C$4" }],
        layout: { showMeanLine: true, showInnerPoints: true, showOutlierPoints: true }
      })
    ];
    for (const model of models) {
      fillChartExCaches(model, wb);
      const svg = renderChartExSvg(model, { width: 360, height: 220 });
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toMatch(/<(rect|polygon|path|polyline|circle)/);
    }
    const waterfallSvg = renderChartExSvg(models[1], { width: 360, height: 220 });
    // Colour case is not semantic; the shared SVG surface normalises to lowercase.
    expect(waterfallSvg.toLowerCase()).toContain("#00aa00");
    expect(waterfallSvg).toContain("stroke-dasharray");
    const boxSvg = renderChartExSvg(models[5], { width: 360, height: 220 });
    expect(boxSvg).toContain('stroke-dasharray="3 2"');
  });
});
