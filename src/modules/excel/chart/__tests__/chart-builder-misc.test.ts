import { extractAll } from "@archive/unzip/extract";
/**
 * Chart builder tests — BUG / ROBUST regressions + miscellaneous chartEx structural + chartToPdf bridge.
 *
 * Split out of the original 13,000-line `chart-builder.test.ts`
 * so vitest transform/import stays fast in full-suite runs.
 * Shared helpers and imports live in `chart-builder.helpers.ts`.
 */
import type { AddChartOptions } from "@excel/chart";
import {
  buildChartModel,
  buildComboChartModel,
  parseSpPr,
  setSpPrFill,
  parseChartEx,
  buildChartExModel,
  renderChartEx,
  renderChartExSvg,
  drawChartExPdf
} from "@excel/chart";
import { chartsheetChart } from "@excel/core/chartsheet";
import { getChartEntry } from "@excel/core/workbook";
import { addWorkbookImage } from "@excel/core/workbook-core";
import { addChart, addChartEx, getCharts } from "@excel/core/worksheet";
import type { WorksheetData } from "@excel/core/worksheet-core";
import { Cell, Chart, Workbook, Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

import { VALUES_B, baseSeries, bubbleSeries, ctg, scatterSeries } from "./chart-builder.helpers";

const textDecoder = new TextDecoder();

describe("BUG-7+8: parseSpPr handles malformed XML", () => {
  it("parseSpPr handles missing end tag gracefully", () => {
    // A truncated raw XML where </a:srgbClr> is missing
    const rawXml = '<c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr>';
    const parsed = parseSpPr({ _rawXml: rawXml } as any);
    expect(parsed.fill?.solid?.srgb).toBe("FF0000");
  });
});

describe("BUG-11: funnel chart has no axes", () => {
  it("funnel chartEx has no axes", () => {
    const m = buildChartExModel({
      type: "funnel",
      categories: "Sheet1!$A$1:$A$5",
      series: [{ name: "F", values: "Sheet1!$B$1:$B$5" }]
    });
    expect(m.chartSpace.chart.plotArea.axis).toBeUndefined();
    const series = m.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    expect(series.axisId).toBeUndefined();
  });
});

describe("ROBUST-4: Excel 1900 leap year bug in date serial", () => {
  it("chart cache-populator uses the canonical Excel serial for Date cells", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Cat");
    // `Date.UTC(1900, 2, 1)` pins the instant to midnight UTC so the
    // computed serial is timezone-independent — a previous version
    // used `new Date(1900, 2, 1)` (local time) which silently flipped
    // between 61 and 62 depending on the CI runner's TZ.
    // Excel's DATEVALUE("1900-03-01") is 61 (accounting for the
    // fake Feb 29, 1900 the 1900 date system keeps for Lotus
    // compatibility). We assert the integer part so accidental
    // sub-day fractions from future refactors don't false-fail.
    Cell.setValue(ws, "B1", new Date(Date.UTC(1900, 2, 1)));
    addChart(
      ws,
      {
        type: "line",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$1", values: "Sheet1!$B$1:$B$1" }]
      },
      "C1:J10"
    );
    const series = Chart.chartModel(getCharts(ws)[0])!.chart.plotArea.chartTypes[0]
      .series[0] as any;
    const serial = series.val.numRef.cache.points[0].value;
    expect(Math.floor(serial)).toBe(61);
  });
});

describe("ROBUST-6: _renderTxPr includes rotation", () => {
  it("chart axis textRotation round-trips through structured txPr", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    addChart(
      ws,
      { type: "bar", series: [baseSeries("S")], categoryAxis: { textRotation: -45 } },
      "C1:J10"
    );
    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    // After round-trip, axis txPr should contain rotation
    const catAx = Chart.chartModel(
      getCharts(Workbook.getWorksheet(wb2, "Sheet1")!)[0]
    )!.chart.plotArea.axes.find(a => a.axisType === "cat")!;
    // txPr comes back as raw XML — check it contains rot="-2700000" (−45° × 60000)
    expect(catAx.txPr?._rawXml || "").toContain("-2700000");
  });
});

describe("supplementary edge cases", () => {
  it("buildChartModel rejects empty series array", () => {
    expect(() => buildChartModel({ type: "bar", series: [] })).toThrow(/at least one series/);
  });

  it("cache populator handles cells with null/undefined values", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Cat");
    Cell.setValue(ws, "B1", null);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$1", values: "Sheet1!$B$1:$B$1" }]
      },
      "C1:J10"
    );
    const series = Chart.chartModel(getCharts(ws)[0])!.chart.plotArea.chartTypes[0]
      .series[0] as any;
    // null value should produce empty cache points (nothing at index 0)
    expect(series.val.numRef.cache.points).toHaveLength(0);
    expect(series.val.numRef.cache.pointCount).toBe(1);
  });

  it("combo chart supports 3 or more groups", () => {
    const m = buildComboChartModel({
      groups: [
        { type: "bar", series: [baseSeries("Bar")] },
        { type: "line", series: [baseSeries("Line", VALUES_B)] },
        { type: "area", series: [baseSeries("Area")] }
      ]
    });
    expect(m.chart.plotArea.chartTypes).toHaveLength(3);
    expect(m.chart.plotArea.chartTypes[0].type).toBe("bar");
    expect(m.chart.plotArea.chartTypes[1].type).toBe("line");
    expect(m.chart.plotArea.chartTypes[2].type).toBe("area");
  });

  it("doughnut chart with holeSize 0 and 90", () => {
    const m0 = buildChartModel({ type: "doughnut", series: [baseSeries("S")], holeSize: 0 });
    expect((ctg(m0) as any).holeSize).toBe(0);
    const m90 = buildChartModel({ type: "doughnut", series: [baseSeries("S")], holeSize: 90 });
    expect((ctg(m90) as any).holeSize).toBe(90);
  });

  it("all 16 chart types round-trip through write/read", async () => {
    const types: AddChartOptions["type"][] = [
      "bar",
      "bar3D",
      "line",
      "line3D",
      "pie",
      "pie3D",
      "doughnut",
      "area",
      "area3D",
      "scatter",
      "bubble",
      "radar",
      "stock",
      "surface",
      "surface3D",
      "ofPie"
    ];
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    for (let i = 1; i <= 4; i++) {
      Cell.setValue(ws, `A${i}`, `Cat${i}`);
      Cell.setValue(ws, `B${i}`, i * 10);
      Cell.setValue(ws, `C${i}`, i * 5);
    }
    let row = 1;
    for (const type of types) {
      const opts: AddChartOptions =
        type === "scatter"
          ? { type, series: [scatterSeries("S")] }
          : type === "bubble"
            ? { type, series: [bubbleSeries("S")] }
            : type === "stock"
              ? {
                  type,
                  series: [
                    baseSeries("O"),
                    baseSeries("H", VALUES_B),
                    baseSeries("L"),
                    baseSeries("C", VALUES_B)
                  ]
                }
              : { type, series: [baseSeries("S")] };
      addChart(ws, opts, { tl: { col: 4, row }, br: { col: 12, row: row + 9 } });
      row += 12;
    }
    expect(getCharts(ws)).toHaveLength(16);
    const buf = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buf);
    const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
    expect(getCharts(ws2)).toHaveLength(16);
    for (let i = 0; i < types.length; i++) {
      expect(Chart.chartTypes(getCharts(ws2)[i])[0].type).toBe(types[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// P0-3: structured spPr / txPr access on chartEx (previously rawXml-only)
// ---------------------------------------------------------------------------

describe("ChartEx structured spPr / txPr", () => {
  const CHART_EX_NAMESPACES =
    'xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

  function makeWaterfallWithSpPr(colorHex: string): string {
    // Minimal waterfall chartEx with a structured cx:spPr on the series
    // containing a solid fill and a 2pt dashed border. This is the shape
    // produced by Excel when a user sets Fill + Outline on a waterfall.
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cx:chartSpace ${CHART_EX_NAMESPACES}>
  <cx:chartData>
    <cx:data id="0"><cx:strDim type="cat"><cx:f>Sheet1!$A$1:$A$3</cx:f></cx:strDim></cx:data>
    <cx:data id="1"><cx:numDim type="val"><cx:f>Sheet1!$B$1:$B$3</cx:f></cx:numDim></cx:data>
  </cx:chartData>
  <cx:chart>
    <cx:plotArea>
      <cx:plotAreaRegion>
        <cx:series layoutId="waterfall" ownerIdx="0">
          <cx:dataId val="0"/>
          <cx:dataId val="1"/>
          <cx:spPr>
            <a:solidFill>
              <a:srgbClr val="${colorHex}"/>
            </a:solidFill>
            <a:ln w="25400">
              <a:solidFill><a:srgbClr val="000000"/></a:solidFill>
              <a:prstDash val="dash"/>
            </a:ln>
          </cx:spPr>
          <cx:axisId val="1"/>
        </cx:series>
      </cx:plotAreaRegion>
      <cx:axis id="1"/>
    </cx:plotArea>
  </cx:chart>
</cx:chartSpace>`;
  }

  it("parser populates structured fill/line fields on cx:spPr while preserving rawXml", () => {
    const model = parseChartEx(makeWaterfallWithSpPr("FF0000"));
    const series = model.chartSpace.chart.plotArea.plotAreaRegion!.series[0];

    // Structured fields are populated
    expect(series.spPr?.fill?.solid?.srgb).toBe("FF0000");
    expect(series.spPr?.line?.color?.srgb).toBe("000000");
    expect(series.spPr?.line?.width).toBe(25400);
    expect(series.spPr?.line?.dash).toBe("dash");

    // Original rawXml is retained for lossless round-trip of anything the
    // structured parser doesn't model (joints, extensions…).
    expect(series.spPr?._rawXml).toBeDefined();
    expect(series.spPr?._rawXml).toContain("FF0000");
  });

  it("round-trip via parseChartEx(renderChartEx(model)) preserves spPr bytes when unmodified", () => {
    const first = parseChartEx(makeWaterfallWithSpPr("00FF00"));
    const rebuilt = parseChartEx(renderChartEx(first));
    const series = rebuilt.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    expect(series.spPr?.fill?.solid?.srgb).toBe("00FF00");
    expect(series.spPr?.line?.dash).toBe("dash");
  });

  it("structural mutation via setSpPrFill drops rawXml and writes the new fill", () => {
    const model = parseChartEx(makeWaterfallWithSpPr("FF0000"));
    const region = model.chartSpace.chart.plotArea.plotAreaRegion!;

    // Mutate: replace the fill using the shape-properties API. This returns
    // a new ShapeProperties object without `_rawXml`, which forces the
    // spPr writer to take the structured path.
    region.series[0].spPr = setSpPrFill(region.series[0].spPr, {
      solid: { srgb: "1122AA" }
    });
    expect(region.series[0].spPr._rawXml).toBeUndefined();

    // Clear the model-level `rawXml` cache so `renderChartEx` does not
    // short-circuit to the original bytes. `ChartExModel.rawXml` is a
    // performance cache for untouched parts — mutating consumers are
    // expected to drop it when they intend to re-serialise from the
    // structured model.
    model.rawXml = undefined;

    // Round-trip and observe the new colour.
    const rendered = renderChartEx(model);
    expect(rendered).toContain("1122AA");
    expect(rendered).not.toContain("FF0000");

    // The new XML parses back to the expected structured value.
    const reparsed = parseChartEx(rendered);
    expect(
      reparsed.chartSpace.chart.plotArea.plotAreaRegion!.series[0].spPr?.fill?.solid?.srgb
    ).toBe("1122AA");
  });

  it("parser populates structured txPr (font size / colour) on cx:dataLabels", () => {
    const rawXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cx:chartSpace ${CHART_EX_NAMESPACES}>
  <cx:chartData>
    <cx:data id="0"><cx:numDim type="val"><cx:f>Sheet1!$A$1:$A$3</cx:f></cx:numDim></cx:data>
  </cx:chartData>
  <cx:chart>
    <cx:plotArea>
      <cx:plotAreaRegion>
        <cx:series layoutId="funnel" ownerIdx="0">
          <cx:dataId val="0"/>
          <cx:dataLabels>
            <cx:visibility value="1"/>
            <cx:txPr>
              <a:bodyPr/>
              <a:lstStyle/>
              <a:p>
                <a:pPr>
                  <a:defRPr sz="1200" b="1">
                    <a:solidFill><a:srgbClr val="C00000"/></a:solidFill>
                  </a:defRPr>
                </a:pPr>
                <a:endParaRPr/>
              </a:p>
            </cx:txPr>
          </cx:dataLabels>
        </cx:series>
      </cx:plotAreaRegion>
    </cx:plotArea>
  </cx:chart>
</cx:chartSpace>`;
    const model = parseChartEx(rawXml);
    const dl = model.chartSpace.chart.plotArea.plotAreaRegion!.series[0].dataLabels!;

    // Structured fields are extracted from the raw XML.
    expect(dl.txPr?.size).toBe(1200);
    expect(dl.txPr?.bold).toBe(true);
    expect(dl.txPr?.color?.srgb).toBe("C00000");

    // Raw XML is also retained for elements the structured parser doesn't
    // understand (pPr alignment, custom fonts, etc.).
    expect(dl.txPr?._rawXml).toBeDefined();
    expect(dl.txPr?._rawXml).toContain("C00000");
  });

  it("structured ShapeProperties carries effectList / sp3d through cx:spPr render", () => {
    // Build a chartEx model programmatically with a structured effectList
    // and sp3d on a series, then round-trip through render+parse and assert
    // the structured fields survive. This is the path user code takes when
    // constructing a chart with shadow / bevel effects.
    const model = buildChartExModel({
      type: "funnel",
      series: [
        {
          values: "Sheet1!$A$1:$A$3",
          spPr: {
            fill: { solid: { srgb: "4472C4" } },
            effectList: {
              outerShadow: {
                blurRadius: 50800,
                distance: 38100,
                direction: 2700000,
                color: { srgb: "000000", alpha: 40 }
              }
            },
            sp3d: {
              extrusionHeight: 76200,
              bevelTop: { width: 63500, height: 25400, preset: "circle" }
            }
          }
        }
      ]
    });

    const rendered = renderChartEx(model);
    expect(rendered).toContain("<a:effectLst>");
    expect(rendered).toContain("<a:outerShdw");
    expect(rendered).toContain("<a:sp3d");
    expect(rendered).toContain("<a:bevelT");

    const reparsed = parseChartEx(rendered);
    const parsedSeries = reparsed.chartSpace.chart.plotArea.plotAreaRegion!.series[0];
    expect(parsedSeries.spPr?.effectList?.outerShadow?.blurRadius).toBe(50800);
    expect(parsedSeries.spPr?.sp3d?.extrusionHeight).toBe(76200);
    expect(parsedSeries.spPr?.sp3d?.bevelTop?.preset).toBe("circle");
  });

  it("structured axis txPr round-trips with rotation and font family", () => {
    const model = buildChartExModel({
      type: "histogram",
      series: [{ values: "Sheet1!$A$1:$A$6" }]
    });
    // Inject a txPr on the first axis before render.
    const axis = model.chartSpace.chart.plotArea.axis?.[0];
    if (!axis) {
      throw new Error("histogram builder did not produce an axis");
    }
    axis.txPr = {
      size: 900,
      italic: true,
      rotation: -5400000,
      fontFamily: "Arial",
      color: { srgb: "333333" }
    };

    const rendered = renderChartEx(model);
    expect(rendered).toContain('rot="-5400000"');
    expect(rendered).toContain('typeface="Arial"');

    const reparsed = parseChartEx(rendered);
    const parsedAxis = reparsed.chartSpace.chart.plotArea.axis![0];
    expect(parsedAxis.txPr?.size).toBe(900);
    expect(parsedAxis.txPr?.italic).toBe(true);
    expect(parsedAxis.txPr?.rotation).toBe(-5400000);
    expect(parsedAxis.txPr?.fontFamily).toBe("Arial");
  });
});

// ---------------------------------------------------------------------------
// P1-3: pictureFill.image high-level API
// ---------------------------------------------------------------------------

describe("bar chart pictureFill.image (high-level)", () => {
  const PNG_MAGIC = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    // IHDR dummy — just enough bytes for Excel to open; we only test the
    // rel pipeline here, not image rendering.
    0x00, 0x00, 0x00, 0x0d
  ]);

  it("resolves a raw Uint8Array into a workbook media entry and chart rel", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 10);
    Cell.setValue(ws, "A2", 20);

    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            name: "S",
            values: "Sheet1!$A$1:$A$2",
            pictureFill: {
              image: PNG_MAGIC,
              fillMode: "stretch",
              applyToFront: true
            }
          }
        ]
      },
      "C1:J10"
    );

    // The chart entry should carry a freshly allocated rel pointing at
    // the newly registered media entry.
    const entry = getChartEntry(wb, 1)!;
    expect(entry.rels).toBeDefined();
    const imageRels = (entry.rels ?? []).filter(r => r.Type.endsWith("/relationships/image"));
    expect(imageRels).toHaveLength(1);
    expect(imageRels[0].Target).toMatch(/^\.\.\/media\/image\d+\.png$/);
    expect(imageRels[0].Id).toMatch(/^rId\d+$/);

    // And the model's blipFill is wired up to the same id.
    const series = entry.model.chart.plotArea.chartTypes[0].series[0] as {
      spPr?: { fill?: { blip?: { relationshipId?: string; _pendingImage?: unknown } } };
    };
    expect(series.spPr?.fill?.blip?.relationshipId).toBe(imageRels[0].Id);
    expect(series.spPr?.fill?.blip?._pendingImage).toBeUndefined();

    // Full round-trip: the xlsx output contains the image part and the
    // chart XML references it via <a:blip r:embed="rIdN"/>.
    const buf = await Workbook.toBuffer(wb);
    const entries = await extractAll(new Uint8Array(buf));
    expect(entries.get("xl/media/image1.png")).toBeDefined();
    const chartXml = textDecoder.decode(entries.get("xl/charts/chart1.xml")!.data);
    expect(chartXml).toContain("<a:blipFill>");
    expect(chartXml).toContain(`r:embed="${imageRels[0].Id}"`);
    expect(chartXml).toContain("<a:stretch>");
    const chartRels = textDecoder.decode(entries.get("xl/charts/_rels/chart1.xml.rels")!.data);
    expect(chartRels).toContain(imageRels[0].Id);
    expect(chartRels).toContain("image1.png");
  });

  it("reuses an existing workbook image via workbookImageId", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    const imageId = addWorkbookImage(wb, { extension: "png", buffer: PNG_MAGIC });

    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            values: "Sheet1!$A$1:$A$1",
            pictureFill: { image: { workbookImageId: imageId } }
          }
        ]
      },
      "C1:J10"
    );

    // Only one media entry — the existing one.
    expect(wb.media).toHaveLength(1);
    const entry = getChartEntry(wb, 1)!;
    const imageRel = (entry.rels ?? []).find(r => r.Type.endsWith("/relationships/image"));
    expect(imageRel?.Target).toBe(`../media/image${imageId + 1}.png`);
  });

  it("accepts a data URL base64 string and infers extension", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 42);
    // 1x1 transparent GIF
    const gifData =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    addChart(
      ws,
      {
        type: "bar",
        series: [{ values: "Sheet1!$A$1:$A$1", pictureFill: { image: gifData } }]
      },
      "C1:J10"
    );
    const entry = getChartEntry(wb, 1)!;
    const imageRel = (entry.rels ?? []).find(r => r.Type.endsWith("/relationships/image"));
    expect(imageRel?.Target).toMatch(/\.gif$/);
  });

  it("still honours a manually-supplied relationshipId (no auto allocation)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            values: "Sheet1!$A$1:$A$1",
            pictureFill: { relationshipId: "rId99", fillMode: "stack" }
          }
        ]
      },
      "C1:J10"
    );
    const entry = getChartEntry(wb, 1)!;
    const series = entry.model.chart.plotArea.chartTypes[0].series[0] as {
      spPr?: { fill?: { blip?: { relationshipId?: string } } };
    };
    expect(series.spPr?.fill?.blip?.relationshipId).toBe("rId99");
    // No image rel was auto-created — caller takes responsibility.
    const imageRels = (entry.rels ?? []).filter(r => r.Type.endsWith("/relationships/image"));
    expect(imageRels).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P1-6: scatter/bubble text x axis
// ---------------------------------------------------------------------------

describe("scatter/bubble xValueType", () => {
  it("defaults xValues to numRef for scatter (OOXML standard)", () => {
    const m = buildChartModel({
      type: "scatter",
      series: [{ xValues: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }]
    });
    const series = m.chart.plotArea.chartTypes[0].series[0] as {
      xVal?: { numRef?: unknown; strRef?: unknown };
    };
    expect(series.xVal?.numRef).toBeDefined();
    expect(series.xVal?.strRef).toBeUndefined();
  });

  it('wraps xValues as strRef when xValueType is "text"', () => {
    const m = buildChartModel({
      type: "scatter",
      series: [
        {
          xValues: "Sheet1!$A$1:$A$3",
          xValueType: "text",
          values: "Sheet1!$B$1:$B$3"
        }
      ]
    });
    const series = m.chart.plotArea.chartTypes[0].series[0] as {
      xVal?: { numRef?: unknown; strRef?: unknown };
    };
    expect(series.xVal?.strRef).toBeDefined();
    expect(series.xVal?.numRef).toBeUndefined();
  });

  it("bubble chart also honours text xValueType", () => {
    const m = buildChartModel({
      type: "bubble",
      series: [
        {
          xValues: "Sheet1!$A$1:$A$2",
          xValueType: "text",
          values: "Sheet1!$B$1:$B$2",
          bubbleSize: "Sheet1!$C$1:$C$2"
        }
      ]
    });
    const series = m.chart.plotArea.chartTypes[0].series[0] as {
      xVal?: { strRef?: unknown };
    };
    expect(series.xVal?.strRef).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// P1-5: Chartsheet.chart host proxy
// ---------------------------------------------------------------------------

describe("Chartsheet.chart worksheet proxy", () => {
  it("exposes chartModel through the proxy without throwing", async () => {
    const wb = Workbook.create();
    Worksheet.addRows(Workbook.addWorksheet(wb, "Data"), [
      ["A", 1],
      ["B", 2]
    ]);
    const chartsheet = Workbook.addChartsheet(wb, "Chart Sheet", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$2", values: "Data!$B$1:$B$2" }]
      }
    });

    // `chart` returns a real Chart bound to a host proxy, and
    // reads/writes to chart-level properties work through it.
    const chart = chartsheetChart(chartsheet)!;
    expect(chart.chartNumber).toBe(1);
    expect(Chart.chartModel(chart)?.chart.plotArea).toBeDefined();
  });

  it("host proxy rejects grid operations with a helpful error", () => {
    const wb = Workbook.create();
    Worksheet.addRows(Workbook.addWorksheet(wb, "Data"), [["X", 1]]);
    const chartsheet = Workbook.addChartsheet(wb, "Chart Sheet", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1", values: "Data!$B$1" }]
      }
    });
    const chart = chartsheetChart(chartsheet)!;
    // Grid-centric calls (getRow / getColumn / addTable …) must not
    // silently no-op on the proxy — they should throw so the caller
    // notices the mis-use instead of ending up with a corrupted workbook.
    expect(() =>
      (chart.worksheet as unknown as { getRow: (n: number) => unknown }).getRow(1)
    ).toThrow(/not supported on a Chart attached to a chartsheet/);
  });
});

// ---------------------------------------------------------------------------
// P1-1 (L2): effectList SVG filter auto-injection
// ---------------------------------------------------------------------------

describe("renderChartSvg auto-injects effectList filters", () => {
  it('emits <filter> in <defs> and wraps the series in filter="url(#...)"', () => {
    // Build a bar chart whose series carries an outer shadow effect —
    // the same shape Excel emits when the user sets Series Format →
    // Shadow in the chart pane.
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
        series: [
          {
            name: "S",
            categories: "Sheet1!$A$1:$A$3",
            values: "Sheet1!$B$1:$B$3",
            spPr: {
              effectList: {
                outerShadow: {
                  blurRadius: 50800,
                  distance: 38100,
                  direction: 2700000,
                  color: { srgb: "000000", alpha: 40 }
                }
              }
            }
          }
        ]
      },
      "D1:K10"
    );
    const chart = getCharts(ws)[0];
    const svg = Chart.toSVG(chart, { width: 400, height: 200 });

    // The SVG must contain a <defs> block with a <filter> inside.
    expect(svg).toContain("<defs>");
    expect(svg).toMatch(/<filter id="documonster-fx-\d+"/);
    expect(svg).toContain("<feGaussianBlur");
    expect(svg).toContain("<feOffset");
    expect(svg).toContain("<feMerge");

    // And at least one <g> element must reference the filter.
    expect(svg).toMatch(/<g filter="url\(#documonster-fx-\d+\)">/);
  });

  it("deduplicates filters when multiple series share the same effect list", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10, 20],
      ["B", 20, 30]
    ]);
    const sharedEffect = {
      glow: { radius: 38100, color: { srgb: "FF0000" } }
    };
    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            categories: "Sheet1!$A$1:$A$2",
            values: "Sheet1!$B$1:$B$2",
            spPr: { effectList: sharedEffect }
          },
          {
            categories: "Sheet1!$A$1:$A$2",
            values: "Sheet1!$C$1:$C$2",
            spPr: { effectList: sharedEffect }
          }
        ]
      },
      "D1:K10"
    );
    const chart = getCharts(ws)[0];
    const svg = Chart.toSVG(chart, { width: 400, height: 200 });
    // Exactly one <filter> definition even though two series share it.
    const filterDefs = (svg.match(/<filter id="documonster-fx-/g) ?? []).length;
    expect(filterDefs).toBe(1);
    // But both series reference it (two <g filter="url(...)">)
    const filterRefs = (svg.match(/<g filter="url\(#documonster-fx-/g) ?? []).length;
    expect(filterRefs).toBe(2);
  });

  it("omits <defs> entirely when no series carry an effectList", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [["A", 1]]);
    addChart(
      ws,
      {
        type: "bar",
        series: [{ categories: "Sheet1!$A$1", values: "Sheet1!$B$1" }]
      },
      "D1:K10"
    );
    const chart = getCharts(ws)[0];
    const svg = Chart.toSVG(chart, { width: 400, height: 200 });
    expect(svg).not.toContain("<defs>");
    expect(svg).not.toContain("<filter");
    expect(svg).not.toContain('filter="url');
  });

  it("builds filter for glow / innerShadow / softEdge / reflection / blur", () => {
    // Exhaust the effect list surface so regressions in any single
    // effect show up as a distinct assertion failure.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [["A", 5]]);
    addChart(
      ws,
      {
        type: "bar",
        series: [
          {
            categories: "Sheet1!$A$1",
            values: "Sheet1!$B$1",
            spPr: {
              effectList: {
                blur: { radius: 38100, grow: true },
                innerShadow: {
                  blurRadius: 50800,
                  distance: 25400,
                  direction: 5400000,
                  color: { srgb: "000000", alpha: 30 }
                },
                glow: { radius: 25400, color: { srgb: "FFFF66" } },
                softEdge: { radius: 19050 },
                reflection: {
                  blurRadius: 6350,
                  startOpacity: 52000,
                  endOpacity: 300,
                  distance: 0,
                  direction: 5400000
                }
              }
            }
          }
        ]
      },
      "D1:K10"
    );
    const chart = getCharts(ws)[0];
    const svg = Chart.toSVG(chart, { width: 400, height: 200 });
    // Every filter primitive ends up somewhere in the single generated
    // <filter> element.
    expect(svg).toContain("<feGaussianBlur");
    expect(svg).toContain("<feComposite");
    expect(svg).toContain("<feMerge");
    expect(svg).toContain("<feFlood");
  });
});

// ---------------------------------------------------------------------------
// Gap A (L2): DrawingML a:xfrm / a:prstGeom / a:custGeom structured access
// ---------------------------------------------------------------------------

describe("shape-properties structured DrawingML geometry", () => {
  it("extracts a:xfrm offset / ext / rot / flips from raw spPr XML", () => {
    const spPr = parseSpPr({
      _rawXml:
        '<c:spPr><a:xfrm rot="5400000" flipH="1">' +
        '<a:off x="123456" y="789012"/>' +
        '<a:ext cx="500000" cy="250000"/>' +
        "</a:xfrm></c:spPr>"
    });
    expect(spPr.transform).toEqual({
      rotation: 5400000,
      flipHorizontal: true,
      offsetX: 123456,
      offsetY: 789012,
      width: 500000,
      height: 250000
    });
  });

  it("extracts a:prstGeom preset + avLst adjustments", () => {
    const spPr = parseSpPr({
      _rawXml:
        '<c:spPr><a:prstGeom prst="roundRect">' +
        '<a:avLst><a:gd name="adj" fmla="val 16667"/></a:avLst>' +
        "</a:prstGeom></c:spPr>"
    });
    expect(spPr.presetGeometry?.preset).toBe("roundRect");
    expect(spPr.presetGeometry?.adjustments).toEqual([{ name: "adj", fmla: "val 16667" }]);
  });

  it("extracts a:custGeom path commands (moveTo / lnTo / arcTo / close)", () => {
    const spPr = parseSpPr({
      _rawXml:
        "<c:spPr><a:custGeom><a:pathLst>" +
        '<a:path w="100000" h="100000" fill="norm" stroke="1">' +
        '<a:moveTo><a:pt x="0" y="0"/></a:moveTo>' +
        '<a:lnTo><a:pt x="100000" y="0"/></a:lnTo>' +
        '<a:arcTo wR="50000" hR="50000" stAng="0" swAng="10800000"/>' +
        "<a:close/>" +
        "</a:path></a:pathLst></a:custGeom></c:spPr>"
    });
    const path = spPr.customGeometry?.paths?.[0];
    expect(path).toBeDefined();
    expect(path?.w).toBe(100000);
    expect(path?.h).toBe(100000);
    expect(path?.fill).toBe("norm");
    expect(path?.stroke).toBe(true);
    expect(path?.commands).toHaveLength(4);
    expect(path?.commands[0].type).toBe("moveTo");
    expect(path?.commands[0].points).toEqual([{ x: 0, y: 0 }]);
    expect(path?.commands[2].type).toBe("arcTo");
    expect(path?.commands[2].arcParams?.swAng).toBe(10800000);
    expect(path?.commands[3].type).toBe("close");
  });
});

// ---------------------------------------------------------------------------
// chartToPdf bridge — vector for classic, raster for ChartEx
// ---------------------------------------------------------------------------

describe("chartToPdf bridge", () => {
  it("produces a valid 1-page PDF for a classic chart via the vector path", async () => {
    const { chartToPdf } = await import("@pdf/excel-bridge");
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
        series: [{ name: "S", categories: "Sheet1!$A$1:$A$3", values: "Sheet1!$B$1:$B$3" }],
        title: "Classic Bar"
      },
      "D1:J10"
    );
    const bytes = await chartToPdf(getCharts(ws)[0]);
    // PDF magic bytes.
    expect(bytes.length).toBeGreaterThan(500);
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 8));
    expect(head.startsWith("%PDF-")).toBe(true);
    const body = new TextDecoder("latin1").decode(bytes);
    // Vector path distinguishes itself from the raster path by the
    // **absence** of an image XObject — content streams are FlateDecoded
    // so we cannot match on literal glyph bytes, but a vector PDF from
    // this helper never embeds an /Image XObject.
    expect(body).not.toMatch(/\/Subtype\s+\/Image/);
    // And every PDF we produce references /Helvetica because the PDF
    // vector path always resolves the built-in Type1 font set.
    expect(body).toContain("/Helvetica");
  });

  it("renders regionMap ChartEx via the vector path by default and via the raster path when forceRaster is set", async () => {
    const { chartToPdf } = await import("@pdf/excel-bridge");
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20]
    ]);
    // regionMap joined VECTOR_PDF_CHART_EX_LAYOUT_IDS once
    // `drawRegionMapPdf` landed — topology polygons, centroid
    // preview, and hex-tile fallback all render through drawPath /
    // drawRect / drawCircle / drawText now. The raster path is still
    // reachable via `forceRaster: true` for callers who want
    // pixel-identical output to the SVG preview.
    addChartEx(
      ws,
      {
        type: "regionMap",
        series: [
          {
            values: "Sheet1!$B$1:$B$2",
            literalValues: [10, 20],
            literalCategories: ["USA", "Canada"]
          }
        ]
      },
      "D1:J10"
    );

    // Default: vector path, no image XObject.
    const vectorBytes = await chartToPdf(getCharts(ws)[0]);
    expect(vectorBytes.length).toBeGreaterThan(500);
    const vectorHead = new TextDecoder("latin1").decode(vectorBytes.slice(0, 8));
    expect(vectorHead.startsWith("%PDF-")).toBe(true);
    const vectorBody = new TextDecoder("latin1").decode(vectorBytes);
    expect(vectorBody).not.toMatch(/\/Subtype\s+\/Image/);
    expect(vectorBody).toContain("/Helvetica");

    // Opt-in raster: same chart rendered via the PNG → image XObject route.
    const rasterBytes = await chartToPdf(getCharts(ws)[0], { forceRaster: true });
    expect(rasterBytes.length).toBeGreaterThan(500);
    const rasterHead = new TextDecoder("latin1").decode(rasterBytes.slice(0, 8));
    expect(rasterHead.startsWith("%PDF-")).toBe(true);
    const rasterBody = new TextDecoder("latin1").decode(rasterBytes);
    expect(rasterBody).toMatch(/\/Subtype\s+\/Image/);
  });

  it("sunburst and treemap ChartEx charts use the vector PDF path (no image XObject)", async () => {
    const { chartToPdf } = await import("@pdf/excel-bridge");
    for (const layout of ["sunburst", "treemap"] as const) {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Worksheet.addRows(ws, [
        ["A", 10],
        ["B", 20],
        ["C", 15]
      ]);
      addChartEx(
        ws,
        {
          type: layout,
          categories: "Sheet1!$A$1:$A$3",
          series: [{ values: "Sheet1!$B$1:$B$3" }]
        },
        "D1:J10"
      );
      const bytes = await chartToPdf(getCharts(ws)[0], { title: `${layout} vector` });
      const body = new TextDecoder("latin1").decode(bytes);
      // Vector path: no image XObject, but the PDF must still carry a
      // content stream wide enough to hold the slice/rect drawing ops.
      expect(body).not.toMatch(/\/Subtype\s+\/Image/);
      // And the standard chart-title font must be registered (vector
      // text = real PDF font resources).
      expect(body).toContain("/Helvetica");
      // PDF must still be valid.
      expect(body.startsWith("%PDF-")).toBe(true);
    }
  });

  it("waterfall/funnel/histogram/pareto/boxWhisker ChartEx layouts take the vector PDF path", async () => {
    // Second batch of vector-capable ChartEx layouts. Each type has
    // its own geometry (stepped bars with dashed connectors,
    // trapezoid stack, binned columns, sorted columns + cumulative
    // polyline, statistical boxes). Confirming the batch via the
    // same `no /Image XObject + has /Helvetica` contract keeps the
    // assertion shape uniform across the six vector layouts.
    const { chartToPdf } = await import("@pdf/excel-bridge");
    const fixtures: Array<{
      name: string;
      build: (ws: WorksheetData) => void;
    }> = [
      {
        name: "waterfall",
        build: ws =>
          addChartEx(
            ws,
            {
              type: "waterfall",
              categories: "S!$A$1:$A$4",
              series: [{ values: "S!$B$1:$B$4" }],
              layout: { subtotals: [{ idx: 3 }], connectorLines: true }
            },
            "D1:J10"
          )
      },
      {
        name: "funnel",
        build: ws =>
          addChartEx(
            ws,
            {
              type: "funnel",
              categories: "S!$A$1:$A$4",
              series: [{ values: "S!$B$1:$B$4" }]
            },
            "D1:J10"
          )
      },
      {
        name: "histogram",
        build: ws =>
          addChartEx(
            ws,
            {
              type: "histogram",
              series: [{ values: "S!$B$1:$B$4", literalValues: [1, 2, 3, 4, 5, 6, 7, 8] }],
              binning: { binCount: 4 }
            },
            "D1:J10"
          )
      },
      {
        name: "pareto",
        build: ws =>
          addChartEx(
            ws,
            {
              type: "pareto",
              categories: "S!$A$1:$A$4",
              series: [
                {
                  values: "S!$B$1:$B$4",
                  literalValues: [30, 20, 15, 10],
                  literalCategories: ["A", "B", "C", "D"]
                }
              ]
            },
            "D1:J10"
          )
      },
      {
        name: "boxWhisker",
        build: ws =>
          addChartEx(
            ws,
            {
              type: "boxWhisker",
              categories: "S!$A$1:$A$6",
              series: [{ values: "S!$B$1:$B$6" }],
              layout: { showMeanMarker: true, showMeanLine: true, showOutlierPoints: true }
            },
            "D1:J10"
          )
      }
    ];
    for (const fixture of fixtures) {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "S");
      Worksheet.addRows(ws, [
        ["A", 10],
        ["B", 20],
        ["C", 15],
        ["D", 8],
        ["E", 5],
        ["F", 25]
      ]);
      fixture.build(ws);
      const bytes = await chartToPdf(getCharts(ws)[0], { title: `${fixture.name} vector` });
      const body = new TextDecoder("latin1").decode(bytes);
      expect(body).not.toMatch(/\/Subtype\s+\/Image/);
      expect(body).toContain("/Helvetica");
      expect(body.startsWith("%PDF-")).toBe(true);
    }
  });

  it("forceRaster on a ChartEx chart keeps the raster path even for vectorable layouts", async () => {
    const { chartToPdf } = await import("@pdf/excel-bridge");
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["A", 10],
      ["B", 20],
      ["C", 15]
    ]);
    addChartEx(
      ws,
      {
        type: "sunburst",
        categories: "Sheet1!$A$1:$A$3",
        series: [{ values: "Sheet1!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    const bytes = await chartToPdf(getCharts(ws)[0], { forceRaster: true });
    const body = new TextDecoder("latin1").decode(bytes);
    expect(body).toMatch(/\/Subtype\s+\/Image/);
  });

  it("forceRaster on a classic chart routes through the PNG path", async () => {
    const { chartToPdf } = await import("@pdf/excel-bridge");
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
        title: "Forced raster"
      },
      "D1:J10"
    );
    const bytes = await chartToPdf(getCharts(ws)[0], { forceRaster: true });
    const body = new TextDecoder("latin1").decode(bytes);
    // Raster path embedded an image XObject.
    expect(body).toMatch(/\/Subtype\s+\/Image/);
  });

  it("drawChartExPdf boxWhisker outlier falls back to stroke-only rect on surfaces without drawCircle", async () => {
    // Exercise the minimal-surface path — a surface that implements
    // only drawRect / drawLine / drawText, nothing else. Before this
    // change the outlier emitter silently skipped (no circle, no
    // fallback). Now it emits a stroke-only rect so the outlier stays
    // visible.
    const { drawChartExPdf } = await import("@excel/chart");
    let outlierRects = 0;
    const rects: Array<{ width: number; height: number; fill?: unknown; stroke?: unknown }> = [];
    const surface = {
      drawRect(opts: {
        x: number;
        y: number;
        width: number;
        height: number;
        fill?: unknown;
        stroke?: unknown;
      }) {
        rects.push(opts);
        // A stroke-only 4×4 rect is the outlier fallback signature.
        if (opts.width === 4 && opts.height === 4 && !opts.fill && opts.stroke) {
          outlierRects++;
        }
        return this;
      },
      drawLine() {
        return this;
      },
      drawText() {
        return this;
      }
    };
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    // A distribution with three clear outliers (very large jumps) so
    // boxStats flags them regardless of quartileMethod.
    addChartEx(
      ws,
      {
        type: "boxWhisker",
        series: [
          {
            values: "ignored",
            literalValues: [10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 200, 500, 1000],
            literalCategories: ["A", "A", "A", "A", "A", "A", "A", "A", "A", "A", "A", "A", "A"]
          }
        ],
        layout: { showOutlierPoints: true, quartileMethod: "inclusive" }
      },
      "D1:J10"
    );
    drawChartExPdf(surface, Chart.chartExModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 400,
      height: 300
    });
    expect(outlierRects).toBeGreaterThan(0);
  });

  it("drawChartExPdf rounds the regionMap panel's corners when the surface takes a path", async () => {
    // `ChartPdfDrawingSurface.drawRect` has no corner radius, so the SVG's rounded
    // map panel used to come out square in a PDF — the old renderer documented that
    // as the one unavoidable divergence for this layout. It is avoidable whenever
    // the surface can take a path.
    const { drawChartExPdf } = await import("@excel/chart");
    const paths: Array<{ ops: Array<{ op: string }> }> = [];
    const rects: Array<{ width: number; height: number }> = [];
    const surface = {
      drawRect(opts: { width: number; height: number }) {
        rects.push(opts);
        return this;
      },
      drawLine() {
        return this;
      },
      drawText() {
        return this;
      },
      drawPath(ops: Array<{ op: string }>) {
        paths.push({ ops });
        return this;
      }
    };
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    addChartEx(
      ws,
      {
        type: "regionMap",
        series: [
          {
            values: "ignored",
            literalValues: [10, 20],
            literalCategories: ["USA", "Canada"]
          }
        ]
      },
      "D1:J10"
    );
    drawChartExPdf(surface, Chart.chartExModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 400,
      height: 300
    });

    // The panel is now a path with four cubic corners rather than a plain rect.
    const cornered = paths.filter(p => p.ops.filter(op => op.op === "curve").length === 4);
    expect(cornered.length).toBeGreaterThan(0);
  });

  it("drawChartExPdf regionMap keeps a feature's two rings apart without drawPath", async () => {
    // A country with an island is one path with two subpaths. On a surface with no
    // `drawPath` the fallback traces the outline with `drawLine`, and it used to
    // flatten every command into one point list — drawing a connector from the end
    // of the mainland ring to the start of the island, and leaving both rings with
    // a missing closing edge.
    const { drawChartExPdf } = await import("@excel/chart");
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    const surface = {
      drawRect() {
        return this;
      },
      drawLine(opts: { x1: number; y1: number; x2: number; y2: number }) {
        lines.push(opts);
        return this;
      },
      drawText() {
        return this;
      }
    };
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    addChartEx(
      ws,
      {
        type: "regionMap",
        series: [
          {
            values: "ignored",
            literalValues: [42],
            literalCategories: ["Twinland"]
          }
        ]
      },
      "D1:J10"
    );
    // Two disjoint unit squares, far apart, as one feature.
    const topology = {
      type: "Topology",
      arcs: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0]
        ],
        [
          [40, 40],
          [50, 40],
          [50, 50],
          [40, 50],
          [40, 40]
        ]
      ],
      objects: {
        countries: {
          type: "GeometryCollection",
          geometries: [{ type: "MultiPolygon", id: "Twinland", arcs: [[[0]], [[1]]] }]
        }
      }
    } as const;
    drawChartExPdf(
      surface,
      Chart.chartExModel(getCharts(ws)[0])!,
      {
        x: 0,
        y: 0,
        width: 400,
        height: 300
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { regionMap: { topology, objectName: "countries", match: "id" } }
    );

    // Every traced segment must lie within one ring, never bridge the two. The
    // rings are 30 units apart in source space, so any connector is far longer
    // than the longest legitimate edge.
    expect(lines.length).toBeGreaterThan(0);
    const lengths = lines.map(l => Math.hypot(l.x2 - l.x1, l.y2 - l.y1));
    const longest = Math.max(...lengths);
    const median = [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)];
    expect(longest).toBeLessThan(median * 3);
  });

  it("drawChartExPdf funnel traces the trapezoid outline with drawLine when drawPath is missing", async () => {
    // Minimal surface without drawPath. The funnel layer must still
    // (a) fill a colour rect so the data magnitude is visible and
    // (b) trace four outline lines so the trapezoid silhouette
    // remains recognisable despite the polygon fill being unavailable.
    const { drawChartExPdf } = await import("@excel/chart");
    let coloredRects = 0;
    let outlineLines = 0;
    const surface = {
      drawRect(opts: { fill?: unknown; stroke?: unknown }) {
        if (opts.fill) {
          coloredRects++;
        }
        return this;
      },
      drawLine(opts: { color?: unknown }) {
        if (opts.color) {
          outlineLines++;
        }
        return this;
      },
      drawText() {
        return this;
      }
    };
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addRows(ws, [
      ["A", 100],
      ["B", 80],
      ["C", 50],
      ["D", 20]
    ]);
    addChartEx(
      ws,
      {
        type: "funnel",
        categories: "S!$A$1:$A$4",
        series: [{ values: "S!$B$1:$B$4" }]
      },
      "D1:J10"
    );
    drawChartExPdf(surface, Chart.chartExModel(getCharts(ws)[0])!, {
      x: 0,
      y: 0,
      width: 400,
      height: 300
    });
    // 4 layers × 1 colour rect each = 4 rects for the fill signal.
    expect(coloredRects).toBeGreaterThanOrEqual(4);
    // 4 layers × 4 outline lines each = 16 lines for the trapezoid
    // silhouette.
    expect(outlineLines).toBeGreaterThanOrEqual(16);
  });
});

// ============================================================================
// Regression tests for the second round of chart bug fixes (April 2026)
//
// Each test documents a specific bug and asserts the fixed behaviour so
// a regression in the renderer / builder / cache layer surfaces as a
// clear failure rather than a subtle visual drift.
// ============================================================================

// ---------------------------------------------------------------------------
// regionMap TopoJSON PDF vector path assertion
// ---------------------------------------------------------------------------

describe("drawChartExPdf regionMap with TopoJSON topology", () => {
  it("draws polygon paths when a matching topology is provided", async () => {
    const { drawChartExPdf } = await import("@excel/chart");
    const paths: Array<{ ops: unknown[] }> = [];
    const texts: string[] = [];
    const surface = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText(text: string) {
        texts.push(text);
        return this;
      },
      drawPath(ops: unknown[]) {
        paths.push({ ops });
        return this;
      },
      drawCircle() {
        return this;
      }
    };
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Geo");
    Worksheet.addRows(ws, [
      ["USA", 300],
      ["CAN", 150],
      ["MEX", 80]
    ]);
    addChartEx(
      ws,
      {
        type: "regionMap",
        categories: "Geo!$A$1:$A$3",
        series: [{ values: "Geo!$B$1:$B$3" }]
      },
      "D1:J10"
    );
    // Minimal TopoJSON with three country polygons that match by id.
    const topology = {
      type: "Topology" as const,
      objects: {
        countries: {
          type: "GeometryCollection" as const,
          geometries: [
            { type: "Polygon" as const, id: "USA", arcs: [[0]] },
            { type: "Polygon" as const, id: "CAN", arcs: [[1]] },
            { type: "Polygon" as const, id: "MEX", arcs: [[2]] }
          ]
        }
      },
      arcs: [
        // USA: triangle
        [
          [0, 0],
          [100, 0],
          [50, 100],
          [0, 0]
        ],
        // CAN: triangle
        [
          [0, 100],
          [100, 100],
          [50, 200],
          [0, 100]
        ],
        // MEX: triangle
        [
          [0, 200],
          [100, 200],
          [50, 300],
          [0, 200]
        ]
      ]
    };
    drawChartExPdf(
      surface,
      Chart.chartExModel(getCharts(ws)[0])!,
      { x: 0, y: 0, width: 400, height: 300 },
      { regionMap: { topology, objectName: "countries", match: "id" } }
    );
    // When TopoJSON polygons are provided, the renderer draws path primitives
    // for each matched region (3 countries = at least 3 paths).
    expect(paths.length).toBeGreaterThanOrEqual(3);
  });
});

describe("ChartEx legend parity between the SVG and vector-PDF backends", () => {
  /** A funnel chartEx with a legend at the requested position. */
  function funnelWithLegend(legendPosition: "b" | "l" | "r" | "t" | "tr") {
    return buildChartExModel({
      type: "funnel",
      categories: "Sheet1!$A$1:$A$3",
      series: [{ name: "Stage", values: "Sheet1!$B$1:$B$3", literalValues: [10, 6, 3] }],
      showLegend: true,
      legendPosition
    });
  }

  /** Record the swatches and label strings a PDF surface receives. */
  function recordingSurface() {
    const swatches: { x: number; y: number }[] = [];
    const texts: string[] = [];
    const page = {
      drawRect(options: { x: number; y: number; width: number; height: number }) {
        if (options.width === 10 && options.height === 10) {
          swatches.push({ x: options.x, y: options.y });
        }
        return this;
      },
      drawLine() {
        return this;
      },
      drawText(text: string) {
        texts.push(text);
        return this;
      }
    };
    return { page, swatches, texts };
  }

  it("draws the legend in the vector PDF, not only in the SVG", () => {
    // Regression: `drawChartExPdf` had no legend code at all, so an authored
    // `legendPos` showed up in SVG and PNG but never in a PDF.
    const model = funnelWithLegend("b");
    const svg = renderChartExSvg(model, { width: 300, height: 200 });
    expect(svg).toContain('width="10" height="10"');
    expect(svg).toContain("Stage");

    const { page, swatches, texts } = recordingSurface();
    drawChartExPdf(page, model, { x: 0, y: 0, width: 300, height: 200 });
    expect(swatches).toHaveLength(1);
    expect(texts).toContain("Stage");
  });

  it("omits the legend from both backends when the model has none", () => {
    const model = buildChartExModel({
      type: "funnel",
      categories: "Sheet1!$A$1:$A$3",
      series: [{ name: "Stage", values: "Sheet1!$B$1:$B$3", literalValues: [10, 6, 3] }],
      showLegend: false
    });
    expect(renderChartExSvg(model, { width: 300, height: 200 })).not.toContain(
      'width="10" height="10"'
    );

    const { page, swatches } = recordingSurface();
    drawChartExPdf(page, model, { x: 0, y: 0, width: 300, height: 200 });
    expect(swatches).toHaveLength(0);
  });

  it("places the swatch at the same coordinates in both backends", () => {
    // Both backends read one shared layout, so the geometry cannot drift. The
    // PDF surface receives page coordinates, which are Y-up: a swatch whose SVG
    // top edge is `y` has its PDF bottom edge at `height - y - swatchSize`.
    const HEIGHT = 200;
    const SWATCH = 10;
    for (const position of ["b", "l", "r", "t", "tr"] as const) {
      const model = funnelWithLegend(position);
      const svg = renderChartExSvg(model, { width: 300, height: HEIGHT });
      const svgSwatch = /<rect x="([\d.-]+)" y="([\d.-]+)" width="10" height="10"/.exec(svg);
      expect(svgSwatch, `no SVG swatch for legendPos=${position}`).not.toBeNull();

      const { page, swatches } = recordingSurface();
      drawChartExPdf(page, model, { x: 0, y: 0, width: 300, height: HEIGHT });
      expect(swatches, `no PDF swatch for legendPos=${position}`).toHaveLength(1);
      expect(swatches[0].x).toBeCloseTo(Number(svgSwatch![1]), 2);
      expect(swatches[0].y).toBeCloseTo(HEIGHT - Number(svgSwatch![2]) - SWATCH, 2);
    }
  });

  it("keeps the legend clear of the plotted data in the vector PDF", () => {
    // Asserting against the *expected* margins would pass even if the PDF path
    // computed a different plot, which is exactly the bug: it used 12px insets
    // while the legend layout assumes 58/128/46. So measure what is actually
    // drawn — the bounding box of every non-swatch mark — and require the
    // swatch to sit outside it.
    const WIDTH = 300;
    const HEIGHT = 200;
    for (const position of ["b", "l", "r", "t", "tr"] as const) {
      for (const title of [undefined, "T"]) {
        const model = buildChartExModel({
          type: "funnel",
          categories: "Sheet1!$A$1:$A$3",
          series: [{ name: "Stage", values: "Sheet1!$B$1:$B$3", literalValues: [10, 6, 3] }],
          showLegend: true,
          legendPosition: position,
          ...(title === undefined ? {} : { title })
        });

        const swatches: { x: number; y: number }[] = [];
        const data = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        const note = (x: number, y: number): void => {
          data.minX = Math.min(data.minX, x);
          data.minY = Math.min(data.minY, y);
          data.maxX = Math.max(data.maxX, x);
          data.maxY = Math.max(data.maxY, y);
        };
        const page = {
          drawRect(options: { x: number; y: number; width: number; height: number }) {
            if (options.width === 10 && options.height === 10) {
              swatches.push({ x: options.x, y: options.y });
            } else if (options.width < WIDTH && options.height < HEIGHT) {
              // Skip the full-bleed chart background; everything else is data.
              note(options.x, options.y);
              note(options.x + options.width, options.y + options.height);
            }
            return this;
          },
          drawLine(options: { x1: number; y1: number; x2: number; y2: number }) {
            note(options.x1, options.y1);
            note(options.x2, options.y2);
            return this;
          },
          drawText() {
            return this;
          },
          drawPath(ops: { op: string; x?: number; y?: number }[]) {
            for (const op of ops) {
              if (op.x !== undefined && op.y !== undefined) {
                note(op.x, op.y);
              }
            }
            return this;
          }
        };
        drawChartExPdf(page, model, { x: 0, y: 0, width: WIDTH, height: HEIGHT });

        expect(swatches).toHaveLength(1);
        expect(Number.isFinite(data.minX), "no data geometry was recorded").toBe(true);

        const swatch = swatches[0];
        const overlaps =
          swatch.x + 10 > data.minX &&
          swatch.x < data.maxX &&
          swatch.y + 10 > data.minY &&
          swatch.y < data.maxY;
        expect(
          overlaps,
          `legendPos=${position} title=${String(title)}: swatch (${swatch.x},${swatch.y}) ` +
            `overlaps data box [${data.minX},${data.minY}]-[${data.maxX},${data.maxY}]`
        ).toBe(false);
      }
    }
  });

  it("flattens a multi-paragraph series caption onto the legend row", () => {
    const model = buildChartExModel({
      type: "funnel",
      categories: "Sheet1!$A$1:$A$3",
      series: [{ name: "North\nRegion", values: "Sheet1!$B$1:$B$3", literalValues: [3, 2, 1] }],
      showLegend: true,
      legendPosition: "r"
    });
    const { page, texts } = recordingSurface();
    drawChartExPdf(page, model, { x: 0, y: 0, width: 300, height: 200 });
    expect(texts.every(text => !/[\r\n]/.test(text))).toBe(true);
    expect(texts).toContain("North Region");
  });
});

describe("ChartEx data labels are driven by the model, not hard-coded", () => {
  const funnel = (dataLabels?: unknown) =>
    buildChartExModel({
      type: "funnel",
      categories: "Sheet1!$A$1:$A$3",
      series: [
        {
          name: "Stage",
          values: "Sheet1!$B$1:$B$3",
          literalValues: [10, 6, 3],
          ...(dataLabels === undefined ? {} : { dataLabels })
        }
      ]
    } as Parameters<typeof buildChartExModel>[0]);

  /** Every string the PDF backend draws. */
  function pdfTexts(model: ReturnType<typeof buildChartExModel>): string[] {
    const out: string[] = [];
    const page = {
      drawRect() {
        return this;
      },
      drawLine() {
        return this;
      },
      drawText(text: string) {
        out.push(text);
        return this;
      }
    };
    drawChartExPdf(page, model, { x: 0, y: 0, width: 300, height: 200 });
    return out;
  }

  it("shows the value by default, matching the model Excel writes", () => {
    // `chart-ex-builder` defaults a funnel to `visibility.value = true`, but the
    // renderers drew the category name — so all three backends agreed with each
    // other and disagreed with the model they were rendering.
    const model = funnel();
    expect(
      model.chartSpace.chart.plotArea.plotAreaRegion!.series[0].dataLabels?.visibility?.value
    ).toBe(true);
    expect(pdfTexts(model)).toEqual(expect.arrayContaining(["10", "6", "3"]));
    expect(renderChartExSvg(model, { width: 300, height: 200 })).toContain(">10<");
  });

  it("honours an authored categoryName-only visibility", () => {
    const texts = pdfTexts(funnel({ showCategory: true, showValue: false }));
    expect(texts).not.toContain("10");
    expect(texts).toEqual(expect.arrayContaining(["1", "2", "3"]));
  });

  it("joins several parts with the authored separator", () => {
    expect(pdfTexts(funnel({ showCategory: true, showValue: true, separator: " — " }))).toEqual(
      expect.arrayContaining(["1 — 10", "2 — 6", "3 — 3"])
    );
  });

  it("draws no data label when every flag is off", () => {
    const texts = pdfTexts(funnel({ showCategory: false, showValue: false }));
    for (const value of ["10", "6", "3", "1", "2"]) {
      expect(texts, `unexpected label ${value}`).not.toContain(value);
    }
    const svg = renderChartExSvg(funnel({ showCategory: false, showValue: false }), {
      width: 300,
      height: 200
    });
    expect(svg).not.toContain(">10<");
  });

  it("keeps the SVG and PDF backends showing the same label text", () => {
    for (const labels of [
      undefined,
      { showCategory: true, showValue: false },
      { showCategory: true, showValue: true, separator: "/" }
    ]) {
      const model = funnel(labels);
      const svg = renderChartExSvg(model, { width: 300, height: 200 });
      for (const text of pdfTexts(model)) {
        if (text === "Stage") {
          continue; // legend entry, not a data label
        }
        expect(svg, `PDF drew ${JSON.stringify(text)} but the SVG did not`).toContain(text);
      }
    }
  });
});
