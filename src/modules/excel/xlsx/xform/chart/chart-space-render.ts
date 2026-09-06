/**
 * ChartSpaceXform render half — pure, stateless OOXML DrawingML chart
 * serialisers extracted from `chart-space-xform.ts`.
 *
 * Every function here is a module-level pure function: it reads only its
 * arguments, calls sibling render helpers, and writes to the supplied
 * {@link XmlSink}. No parser state is touched. The owning
 * `ChartSpaceXform.render` thin-delegates to {@link renderChartSpace}.
 *
 * The c: namespace is http://schemas.openxmlformats.org/drawingml/2006/chart
 * The a: namespace is http://schemas.openxmlformats.org/drawingml/2006/main
 * The r: namespace is http://schemas.openxmlformats.org/officeDocument/2006/relationships
 */

import type {
  ChartModel,
  ChartData,
  PlotArea,
  ChartTypeGroup,
  BarChartGroup,
  LineChartGroup,
  PieChartGroup,
  DoughnutChartGroup,
  AreaChartGroup,
  ScatterChartGroup,
  BubbleChartGroup,
  RadarChartGroup,
  StockChartGroup,
  SurfaceChartGroup,
  OfPieChartGroup,
  BarSeries,
  LineSeries,
  PieSeries,
  AreaSeries,
  ScatterSeries,
  BubbleSeries,
  RadarSeries,
  SurfaceSeries,
  ChartAxis,
  CategoryAxis,
  ValueAxis,
  DateAxis,
  SeriesAxis,
  ChartTitle,
  ChartLegend,
  ChartLayout,
  View3D,
  DataTable,
  DataLabels,
  DataLabelEntry,
  Trendline,
  ErrorBars,
  ChartMarker,
  DataPoint,
  NumberReference,
  StringReference,
  NumberCache,
  StringCache,
  NumberDataSource,
  AxisDataSource,
  NumberLiteral,
  StringLiteral,
  MultiLevelStringReference,
  ShapeProperties,
  ShapeTransform,
  PresetGeometry,
  CustomGeometry,
  CustomGeometryCommand,
  ChartColor,
  ChartTextProperties,
  ChartRichText,
  ChartBodyProperties,
  ChartParagraphProperties,
  ChartLineSpacing,
  EffectList,
  Shadow,
  Scene3D,
  ShapeProperties3D,
  PrintSettings,
  PivotChartOptions,
  DataLabelsRange,
  ChartBlipFill,
  UpDownBars,
  PictureOptions,
  SeriesBase
} from "@excel/chart/model/types";
import {
  escapeXml,
  needsXmlSpacePreserve,
  themeIndexToName,
  tickMarkToOoxml
} from "@excel/chart/shared/chart-utils";
import { isRawXmlShape, isRawXmlTxPr } from "@excel/chart/shared/shape-properties";
import {
  C14_PIVOT_OPTIONS_EXT_URI,
  C14_CHART_NAMESPACE,
  C16_PIVOT_OPTIONS16_EXT_URI,
  C16_CHART_NAMESPACE,
  C15_DATA_LABELS_RANGE_EXT_URI,
  C15_CHART_NAMESPACE
} from "@excel/xlsx/xform/chart/chart-space-constants";
import type { XmlSink } from "@xml/types";
import { StdDocAttributes } from "@xml/writer";

// ============================================================================
// MS Office extension URIs / namespaces — defined in ./chart-space-constants
// (neutral module shared with the parser).
// ============================================================================

// `escapeXmlText` is a local alias for {@link escapeXml}. Kept so the
// extension builders below read clearly at the call site ("text node
// content" vs. "attribute value"); both paths need identical escaping
// semantics.
const escapeXmlText = escapeXml;

// chartSpace root namespace declarations.
const CHART_SPACE_ATTRIBUTES = {
  "xmlns:c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
  "xmlns:a": "http://schemas.openxmlformats.org/drawingml/2006/main",
  "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
};

/**
 * Flags that tune per-chart-type quirks in the shared data-label writers.
 *
 * `suppressDLblPos` — omit the `<c:dLblPos>` element (doughnut charts).
 */
interface DataLabelRenderOptions {
  suppressDLblPos?: boolean;
}

export function renderChartSpace(xml: XmlSink, m: ChartModel): void {
  const nsAttrs: Record<string, string> = { ...CHART_SPACE_ATTRIBUTES };
  if (m.extraNamespaces) {
    Object.assign(nsAttrs, m.extraNamespaces);
  }
  xml.openXml(StdDocAttributes);
  xml.openNode("c:chartSpace", nsAttrs);

  if (m.date1904 !== undefined) {
    xml.leafNode("c:date1904", { val: m.date1904 ? "1" : "0" });
  }
  if (m.lang) {
    xml.leafNode("c:lang", { val: m.lang });
  }
  if (m.roundedCorners !== undefined) {
    xml.leafNode("c:roundedCorners", { val: m.roundedCorners ? "1" : "0" });
  }
  if (m.alternateContentStyle) {
    xml.writeRaw(m.alternateContentStyle);
  } else if (m.style !== undefined) {
    xml.leafNode("c:style", { val: String(m.style) });
  }
  // ECMA-376 §21.2.2.29 `CT_ChartSpace` child order:
  //   date1904, lang, roundedCorners, (AlternateContent | style),
  //   clrMapOvr, pivotSource, protection, chart,
  //   spPr, txPr, externalData, printSettings, userShapes, extLst.
  // `clrMapOvr` must appear BEFORE `chart` (the chart's colour
  // references may already point at the mapping); previously we
  // emitted it after `chart`, which strict OOXML validators reject.
  if (m.clrMapOvr) {
    xml.writeRaw(m.clrMapOvr);
  }
  if (m.pivotSource) {
    xml.writeRaw(m.pivotSource);
  }
  if (m.protection) {
    xml.writeRaw(m.protection);
  }

  renderChart(xml, m.chart);

  if (m.spPr) {
    renderSpPr(xml, m.spPr);
  }
  if (m.txPr) {
    renderTxPr(xml, m.txPr);
  }
  if (m.externalData && m.externalData.id) {
    // `<c:externalData>` requires a non-empty `r:id` referencing a
    // real relationship in the chart's `.rels` part. Emitting
    // `r:id=""` (which happened when the source XML had been parsed
    // from a chart whose `r:id` was missing or blank) produces a
    // workbook that Excel's strict-open rejects with the "repair"
    // dialog on reopen. Drop the element entirely when we have no
    // valid relationship id to point at.
    xml.openNode("c:externalData", { "r:id": m.externalData.id });
    if (m.externalData.autoUpdate !== undefined) {
      xml.leafNode("c:autoUpdate", { val: m.externalData.autoUpdate ? "1" : "0" });
    }
    xml.closeNode();
  }
  if (m.printSettings) {
    renderPrintSettings(xml, m.printSettings);
  }
  // `<c:userShapes r:id="…"/>` — optional reference to a separate
  // drawing part holding user-drawn annotations on the chart. The
  // part itself rides along via the chart rels; here we emit the
  // reference so Excel knows where to find it. Per schema, it is
  // the last structured child before `extLst`.
  if (m.userShapesRelId) {
    xml.leafNode("c:userShapes", { "r:id": m.userShapesRelId });
  }
  if (m.extLst || m.pivotOptions) {
    renderChartSpaceExtLst(xml, m);
  }

  xml.closeNode();
}

/**
 * Render the chart-space-level `<c:extLst>` element, merging the raw XML
 * captured at parse time (`m.extLst`) with any structured pivot chart
 * metadata (`m.pivotOptions`).
 *
 * The two inputs live side by side for good reason:
 *   - `m.extLst` holds extensions we do not structurally understand
 *     (c15 filtered series, c16r2 markup, c16r5 axis-title rich text…).
 *     These are byte-preserved verbatim for round-trip safety.
 *   - `m.pivotOptions` is the structured view of the MS Office 2010+
 *     `c14:pivotOptions` extension. The parser extracts it out of the
 *     raw extLst precisely so editors can read/mutate it programmatically
 *     without string surgery.
 *
 * Merge strategy: if `m.extLst` is present, splice the new c14 ext
 * element before its closing `</c:extLst>`; otherwise create a fresh
 * `<c:extLst>` wrapper containing just the c14 ext.
 */
export function renderChartSpaceExtLst(xml: XmlSink, m: ChartModel): void {
  // Combine every chartSpace-level extension we know how to emit. Each
  // piece is optional; we only emit a `<c:extLst>` wrapper when at
  // least one piece is present.
  const extPieces: string[] = [];
  // Emit the pivot extension chain whenever we have structured
  // `pivotOptions`, regardless of whether `pivotSource` is also
  // present. Historically the gate required both because
  // `pivotSource` is what links the chart to its PivotTable, but
  // programmatic builders may legitimately set `pivotOptions` first
  // (e.g. during incremental construction) and have the source
  // linked later — dropping the options silently on write lost the
  // author's work. If no options are set, both helpers return empty
  // strings and no extension is emitted.
  if (m.pivotOptions) {
    const c14 = buildC14PivotOptionsExt(m.pivotOptions);
    if (c14) {
      extPieces.push(c14);
    }
    const c16 = buildC16PivotOptions16Ext(m.pivotOptions);
    if (c16) {
      extPieces.push(c16);
    }
  }
  const extraExt = extPieces.join("");
  if (m.extLst) {
    if (!extraExt) {
      xml.writeRaw(m.extLst);
      return;
    }
    // Splice the new ext(s) before `</c:extLst>`. We look for the
    // closing tag; the raw XML was produced by our own parser which
    // always emits a closing tag on its own.
    const close = m.extLst.lastIndexOf("</c:extLst");
    if (close >= 0) {
      xml.writeRaw(m.extLst.slice(0, close) + extraExt + m.extLst.slice(close));
    } else {
      // Malformed raw extLst (shouldn't happen from our parser) — emit
      // both independently so we don't lose information.
      xml.writeRaw(m.extLst);
      xml.writeRaw(`<c:extLst>${extraExt}</c:extLst>`);
    }
  } else if (extraExt) {
    xml.writeRaw(`<c:extLst>${extraExt}</c:extLst>`);
  }
}

/**
 * Serialise the Office 2014+ `c16:pivotOptions16` extension
 * (`c:chartSpace/c:extLst/c:ext[uri={E28EC0CA-…}]`). Only the
 * `showExpandCollapseFieldButtons` toggle is modelled here — Excel
 * adds this block alongside {@link _buildC14PivotOptionsExt} to
 * control the newer expand/collapse field-button affordances.
 *
 * Returns `""` when nothing needs to be written so the caller can
 * omit the extension entirely.
 */
export function buildC16PivotOptions16Ext(options: PivotChartOptions): string {
  if (options.showExpandCollapseFieldButtons === undefined) {
    return "";
  }
  return (
    `<c:ext uri="${C16_PIVOT_OPTIONS16_EXT_URI}" xmlns:c16="${C16_CHART_NAMESPACE}">` +
    `<c16:pivotOptions16>` +
    `<c16:showExpandCollapseFieldButtons val="${
      options.showExpandCollapseFieldButtons ? "1" : "0"
    }"/>` +
    `</c16:pivotOptions16>` +
    `</c:ext>`
  );
}

/**
 * Serialise a {@link PivotChartOptions} as the `c:ext` wrapper Excel
 * expects:
 *
 * ```xml
 * <c:ext uri="{…}" xmlns:c14="http://schemas.microsoft.com/office/drawing/2007/8/2/chart">
 *   <c14:pivotOptions>
 *     <c14:dropZoneFilter val="0"/>
 *     …
 *   </c14:pivotOptions>
 * </c:ext>
 * ```
 *
 * The `uri` attribute is the well-known identifier for the c14 pivot
 * options extension (see MS-XLSX §2.3.11). Excel 2010+ uses this URI as
 * the key when deciding whether to honour the extension.
 */
export function buildC14PivotOptionsExt(options: PivotChartOptions): string {
  const children: string[] = [];
  // MS-XLSX schema order: filter, categories, data, series, dropZonesVisible.
  if (options.dropZoneFilter !== undefined) {
    children.push(`<c14:dropZoneFilter val="${options.dropZoneFilter ? "1" : "0"}"/>`);
  }
  if (options.dropZoneCategories !== undefined) {
    children.push(`<c14:dropZoneCategories val="${options.dropZoneCategories ? "1" : "0"}"/>`);
  }
  if (options.dropZoneData !== undefined) {
    children.push(`<c14:dropZoneData val="${options.dropZoneData ? "1" : "0"}"/>`);
  }
  if (options.dropZoneSeries !== undefined) {
    children.push(`<c14:dropZoneSeries val="${options.dropZoneSeries ? "1" : "0"}"/>`);
  }
  if (options.dropZonesVisible !== undefined) {
    children.push(`<c14:dropZonesVisible val="${options.dropZonesVisible ? "1" : "0"}"/>`);
  }
  if (children.length === 0) {
    return "";
  }
  return (
    `<c:ext uri="${C14_PIVOT_OPTIONS_EXT_URI}" xmlns:c14="${C14_CHART_NAMESPACE}">` +
    `<c14:pivotOptions>${children.join("")}</c14:pivotOptions>` +
    `</c:ext>`
  );
}

export function renderChart(xml: XmlSink, chart: ChartData): void {
  xml.openNode("c:chart");

  if (chart.title) {
    renderTitle(xml, chart.title, "c:title");
  }
  if (chart.autoTitleDeleted !== undefined) {
    xml.leafNode("c:autoTitleDeleted", { val: chart.autoTitleDeleted ? "1" : "0" });
  }
  if (chart.pivotFormats && chart.pivotFormats.length > 0) {
    xml.openNode("c:pivotFmts");
    for (const pf of chart.pivotFormats) {
      xml.openNode("c:pivotFmt");
      xml.leafNode("c:idx", { val: String(pf.index) });
      // CT_PivotFmt child order: `idx, spPr?, txPr?, marker?, dLbl?`.
      // Previously `txPr` was never written out; any pivotFmt-level
      // typography set on the model would vanish on round-trip.
      if (pf.spPr) {
        renderSpPr(xml, pf.spPr);
      }
      if (pf.txPr) {
        renderTxPr(xml, pf.txPr);
      }
      if (pf.marker) {
        renderMarker(xml, pf.marker);
      }
      // `c:pivotFmt` may carry a bare `c:dLbl` (no `c:dLbls` wrapper).
      // Use the structured representation so callers can mutate label
      // attributes programmatically.
      if (pf.dLbl) {
        renderDataLabelEntry(xml, pf.dLbl);
      } else if (pf.dataLabels) {
        renderDataLabels(xml, pf.dataLabels);
      }
      // CT_PivotFmt ends with an optional `extLst`. Preserved as raw
      // bytes so any unrecognised vendor extensions round-trip.
      if (pf.extLst) {
        xml.writeRaw(pf.extLst);
      }
      xml.closeNode();
    }
    xml.closeNode();
  }
  if (chart.view3D) {
    renderView3D(xml, chart.view3D);
  }
  if (chart.floor) {
    xml.openNode("c:floor");
    renderSpPr(xml, chart.floor);
    xml.closeNode();
  }
  if (chart.sideWall) {
    xml.openNode("c:sideWall");
    renderSpPr(xml, chart.sideWall);
    xml.closeNode();
  }
  if (chart.backWall) {
    xml.openNode("c:backWall");
    renderSpPr(xml, chart.backWall);
    xml.closeNode();
  }

  renderPlotArea(xml, chart.plotArea);

  if (chart.legend) {
    renderLegend(xml, chart.legend);
  }
  if (chart.plotVisOnly !== undefined) {
    xml.leafNode("c:plotVisOnly", { val: chart.plotVisOnly ? "1" : "0" });
  }
  if (chart.dispBlanksAs) {
    xml.leafNode("c:dispBlanksAs", { val: chart.dispBlanksAs });
  }
  if (chart.showDLblsOverMax !== undefined) {
    xml.leafNode("c:showDLblsOverMax", { val: chart.showDLblsOverMax ? "1" : "0" });
  }
  if (chart.extLst) {
    xml.writeRaw(chart.extLst);
  }

  xml.closeNode();
}

export function renderView3D(xml: XmlSink, v: View3D): void {
  xml.openNode("c:view3D");
  // ECMA-376 §21.2.2.228 CT_View3D child order:
  //   rotX?, hPercent?, rotY?, depthPercent?, rAngAx?, perspective?, extLst?
  // `hPercent` sits between `rotX` and `rotY`; the previous
  // implementation placed it after `rAngAx`, which strict schema
  // validators rejected.
  if (v.rotX !== undefined) {
    xml.leafNode("c:rotX", { val: String(v.rotX) });
  }
  if (v.hPercent !== undefined) {
    xml.leafNode("c:hPercent", { val: String(v.hPercent) });
  }
  if (v.rotY !== undefined) {
    xml.leafNode("c:rotY", { val: String(v.rotY) });
  }
  if (v.depthPercent !== undefined) {
    xml.leafNode("c:depthPercent", { val: String(v.depthPercent) });
  }
  if (v.rAngAx !== undefined) {
    xml.leafNode("c:rAngAx", { val: v.rAngAx ? "1" : "0" });
  }
  if (v.perspective !== undefined) {
    xml.leafNode("c:perspective", { val: String(v.perspective) });
  }
  if (v.extLst) {
    xml.writeRaw(v.extLst);
  }
  xml.closeNode();
}

export function renderPlotArea(xml: XmlSink, pa: PlotArea): void {
  xml.openNode("c:plotArea");
  renderLayout(xml, pa.layout);

  for (const ctg of pa.chartTypes) {
    renderChartTypeGroup(xml, ctg);
  }
  for (const ax of pa.axes) {
    renderAxis(xml, ax);
  }
  if (pa.dataTable) {
    renderDataTable(xml, pa.dataTable);
  }
  if (pa.spPr) {
    renderSpPr(xml, pa.spPr);
  }
  if (pa.extLst) {
    xml.writeRaw(pa.extLst);
  }
  xml.closeNode();
}

// ---- Chart type groups ----

export function renderChartTypeGroup(xml: XmlSink, ctg: ChartTypeGroup): void {
  const tagMap: Record<string, string> = {
    bar: "c:barChart",
    bar3D: "c:bar3DChart",
    line: "c:lineChart",
    line3D: "c:line3DChart",
    pie: "c:pieChart",
    pie3D: "c:pie3DChart",
    doughnut: "c:doughnutChart",
    area: "c:areaChart",
    area3D: "c:area3DChart",
    scatter: "c:scatterChart",
    bubble: "c:bubbleChart",
    radar: "c:radarChart",
    stock: "c:stockChart",
    surface: "c:surfaceChart",
    surface3D: "c:surface3DChart",
    ofPie: "c:ofPieChart"
  };
  const tag = tagMap[ctg.type];
  if (!tag) {
    return;
  }

  xml.openNode(tag);

  switch (ctg.type) {
    case "bar":
      renderBarChart(xml, ctg);
      break;
    case "bar3D":
      renderBar3DChart(xml, ctg);
      break;
    case "line":
      renderLineChart(xml, ctg);
      break;
    case "line3D":
      renderLine3DChart(xml, ctg);
      break;
    case "pie":
    case "pie3D":
      renderPieChart(xml, ctg);
      break;
    case "doughnut":
      renderDoughnutChart(xml, ctg);
      break;
    case "area":
    case "area3D":
      renderAreaChart(xml, ctg);
      break;
    case "scatter":
      renderScatterChart(xml, ctg);
      break;
    case "bubble":
      renderBubbleChart(xml, ctg);
      break;
    case "radar":
      renderRadarChart(xml, ctg);
      break;
    case "stock":
      renderStockChart(xml, ctg);
      break;
    case "surface":
    case "surface3D":
      renderSurfaceChart(xml, ctg);
      break;
    case "ofPie":
      renderOfPieChart(xml, ctg);
      break;
  }

  if (ctg.extLst) {
    xml.writeRaw(ctg.extLst);
  }

  xml.closeNode();
}

export function renderBarChart(xml: XmlSink, g: BarChartGroup): void {
  // `CT_BarChart` (2D) schema sequence:
  //   barDir, grouping?, varyColors?, ser*, dLbls?, gapWidth?,
  //   overlap?, serLines*, axId{2}.
  //
  // `c:barDir` and `c:grouping` are required children, but the parser
  // may leave them `undefined` if the source XML had an invalid value
  // that `narrowEnumValue` rejected. Emitting `val=""` produces a
  // file Excel rejects outright. Fall back to the schema defaults
  // (`"col"` for barDir, `"clustered"` for grouping) — these match
  // Excel's behaviour when the attributes are absent.
  xml.leafNode("c:barDir", { val: g.barDir ?? "col" });
  xml.leafNode("c:grouping", { val: g.grouping ?? "clustered" });
  // **`c:varyColors` is written even when the model is silent, and getting this wrong cost 15× on open.**
  //
  // It is optional in every `CT_*Chart`, so omitting it produces a valid file that Excel renders identically. A third
  // party need not read the omission the same way — and the direction here is the opposite of what it sounds like.
  //
  // Measured against LibreOffice on `sales-dashboard`, whose bar series carries 10,080 points and a data table:
  //
  // | `c:varyColors`     | time to open |
  // | ------------------ | ------------ |
  // | absent             | 495 s        |
  // | `val="0"`          | 498 s        |
  // | `val="1"`          | **31 s**     |
  // | Excel's own file   | 32 s         |
  //
  // The 31 s is a hand-patched copy of this library's own output; with the fix in place the example writes 32 s for
  // `.xlsb` and 33 s for `.xlsx`, which is the number that matters and is Excel's own to within a second.
  //
  // So *one colour per series* is the expensive answer: it makes the renderer resolve each of 10,080 points against
  // the inherited series fill, and the data table then draws every one of those again as a key. `val="1"` indexes a
  // palette instead. **Excel writes `1` on all five charts in that workbook**, which is why its larger file opens in a
  // fifteenth of the time, and it is why the default here is `1` rather than the `0` a reading of the schema suggests.
  //
  // The first attempt at this fix wrote `"0"` — reasoning that a series has one colour unless told otherwise — and
  // changed nothing, because that was already the effective behaviour. Deleting the data table also "fixed" it (28 s)
  // by removing a feature the example asks for; Excel carries the same table over the same categories for free.
  //
  // The general rule this establishes for this file: **an element Excel always emits gets emitted.** A schema default
  // is what a *validator* falls back to, not what every consumer does, and "the model said nothing" is not the same
  // claim as "the default applies".
  //
  // **It is not a change of visual semantics, which is the obvious objection.** Three things settle that:
  //
  // - Excel's own `12-charts` reference is a **single-series** `barChart` with no series `spPr` and no `dPt`, and it
  //   still writes `val="1"`. There is nothing there for the flag to be overridden by, so `1` is simply what Excel
  //   writes for a chart nobody has coloured.
  // - This library's *renderer* reads `group.varyColors` from the **model**, not from this XML (see
  //   `chart-renderer.ts`), and the model still says `undefined`. SVG and PDF output are byte-identical across this
  //   change.
  // - `varyColors` only distinguishes points within one series; a multi-series chart colours by series regardless.
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderBarSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  if (g.gapWidth !== undefined) {
    xml.leafNode("c:gapWidth", { val: String(g.gapWidth) });
  }
  if (g.overlap !== undefined) {
    xml.leafNode("c:overlap", { val: String(g.overlap) });
  }
  if (g.serLines) {
    xml.openNode("c:serLines");
    renderSpPr(xml, g.serLines);
    xml.closeNode();
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
}

/**
 * Render a 3-D bar chart per `CT_Bar3DChart`. The 3-D schema DROPS
 * `overlap` and `serLines` (both 2-D-only) and ADDS `gapDepth` and
 * `shape`. The child order differs from 2-D:
 *
 *   barDir, grouping?, varyColors?, ser*, dLbls?, gapWidth?,
 *   gapDepth?, shape?, axId{3}.
 *
 * Previously the builder shared `_renderBarChart` with bar2D, which
 * emitted `overlap` / `serLines` on bar3D (schema violation) and put
 * `shape` before `gapDepth` (sequence violation — Excel tolerates it
 * on read, strict validators reject).
 */
export function renderBar3DChart(xml: XmlSink, g: BarChartGroup): void {
  xml.leafNode("c:barDir", { val: g.barDir ?? "col" });
  xml.leafNode("c:grouping", { val: g.grouping ?? "clustered" });
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderBarSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  if (g.gapWidth !== undefined) {
    xml.leafNode("c:gapWidth", { val: String(g.gapWidth) });
  }
  if (g.gapDepth !== undefined) {
    xml.leafNode("c:gapDepth", { val: String(g.gapDepth) });
  }
  if (g.shape) {
    xml.leafNode("c:shape", { val: g.shape });
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
}

export function renderLineChart(xml: XmlSink, g: LineChartGroup): void {
  // `CT_LineChart` (2D) schema sequence:
  //   grouping, varyColors?, ser*, dLbls?, dropLines?, hiLowLines?,
  //   upDownBars?, marker?, smooth?, axId{2}.
  //
  // Guard required `c:grouping` with schema default `"standard"` when
  // parser narrowing rejected the source value; see `_renderBarChart`.
  xml.leafNode("c:grouping", { val: g.grouping ?? "standard" });
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderLineSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  if (g.dropLines) {
    xml.openNode("c:dropLines");
    renderSpPr(xml, g.dropLines);
    xml.closeNode();
  }
  if (g.hiLowLines) {
    xml.openNode("c:hiLowLines");
    renderSpPr(xml, g.hiLowLines);
    xml.closeNode();
  }
  if (g.upDownBars) {
    renderUpDownBars(xml, g.upDownBars);
  }
  if (g.marker !== undefined) {
    xml.leafNode("c:marker", { val: g.marker ? "1" : "0" });
  }
  if (g.smooth !== undefined) {
    xml.leafNode("c:smooth", { val: g.smooth ? "1" : "0" });
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
}

/**
 * Render a 3-D line chart per `CT_Line3DChart`. Schema DROPS
 * `hiLowLines`, `upDownBars`, `marker`, `smooth` (all 2-D-only) and
 * ADDS `gapDepth`. Child order:
 *
 *   grouping, varyColors?, ser*, dLbls?, dropLines?, gapDepth?,
 *   axId{3}.
 *
 * Previously the builder shared `_renderLineChart` with line2D,
 * producing `<c:line3DChart>` with illegal children (most Excel-
 * authored tools would still open the file, but strict validators
 * reject it; more importantly, Excel's own read path silently
 * ignored the illegal children, so the line3D chart lost its marker
 * / smooth / up-down bars on round-trip).
 */
export function renderLine3DChart(xml: XmlSink, g: LineChartGroup): void {
  xml.leafNode("c:grouping", { val: g.grouping ?? "standard" });
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderLineSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  if (g.dropLines) {
    xml.openNode("c:dropLines");
    renderSpPr(xml, g.dropLines);
    xml.closeNode();
  }
  if (g.gapDepth !== undefined) {
    xml.leafNode("c:gapDepth", { val: String(g.gapDepth) });
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
}

export function renderPieChart(xml: XmlSink, g: PieChartGroup): void {
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderPieSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  if (g.firstSliceAng !== undefined) {
    xml.leafNode("c:firstSliceAng", { val: String(g.firstSliceAng) });
  }
}

/**
 * Render `CT_DoughnutChart`. Child order matches the schema:
 *   varyColors?, ser*, dLbls?, firstSliceAng?, holeSize?, extLst?.
 *
 * Excel's reader rejects `<c:dLblPos>` inside a doughnut chart's
 * `<c:dLbls>` (both group-level and per-series). The Excel UI
 * confirms this — the "Label Position" control is absent from the
 * Format Data Labels panel for doughnut charts, whereas pie exposes
 * center / inside end / outside end / best fit. Writing any
 * `c:dLblPos` value (even `bestFit`) causes Excel to strip the
 * entire `drawing1.xml` part on open with "Removed Part: Drawing
 * shape".
 *
 * Some writers hide this by forcibly nulling `labels["position"]`
 * whenever the user-supplied position equals the chart's default
 * ("best_fit" for pie/doughnut). That only masks the bug when the
 * caller doesn't override the default; non-default positions still
 * emit `c:dLblPos` and still break real-world doughnut files.
 *
 * The fix is to suppress `c:dLblPos` at serialisation time for
 * doughnut — both in series `<c:dLbls>` and inside any per-point
 * `<c:dLbl>` entries. `pie` and `ofPie` continue to emit it (they
 * share `_renderPieSeries`, hence the explicit flag). The chart
 * model still carries `position`, so SVG/PDF renderers keep using
 * it for layout; only the XLSX writer filters it out.
 */
export function renderDoughnutChart(xml: XmlSink, g: DoughnutChartGroup): void {
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderPieSeries(xml, s, { suppressDLblPos: true });
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels, { suppressDLblPos: true });
  }
  if (g.firstSliceAng !== undefined) {
    xml.leafNode("c:firstSliceAng", { val: String(g.firstSliceAng) });
  }
  if (g.holeSize !== undefined) {
    xml.leafNode("c:holeSize", { val: String(g.holeSize) });
  }
}

export function renderAreaChart(xml: XmlSink, g: AreaChartGroup): void {
  // Guard required `c:grouping` — see `_renderBarChart`.
  xml.leafNode("c:grouping", { val: g.grouping ?? "standard" });
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderAreaSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  if (g.dropLines) {
    xml.openNode("c:dropLines");
    renderSpPr(xml, g.dropLines);
    xml.closeNode();
  }
  // `c:gapDepth` exists only on `CT_Area3DChart`, not on plain
  // `CT_AreaChart`. The builder's validator rejects `gapDepth` for
  // 2-D area, but a direct model mutation (`group.gapDepth = 50`)
  // would previously sneak the value through and produce an
  // invalid `<c:areaChart><c:gapDepth/>` — every strict validator
  // rejects that. Gate on the group type so only `area3D` emits
  // the element.
  if (g.type === "area3D" && g.gapDepth !== undefined) {
    xml.leafNode("c:gapDepth", { val: String(g.gapDepth) });
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
}

export function renderScatterChart(xml: XmlSink, g: ScatterChartGroup): void {
  // `c:scatterStyle` is required; fall back to `"marker"` (Excel's
  // default scatter style) when parser narrowing rejected the source.
  xml.leafNode("c:scatterStyle", { val: g.scatterStyle ?? "marker" });
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderScatterSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
}

export function renderBubbleChart(xml: XmlSink, g: BubbleChartGroup): void {
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderBubbleSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  if (g.bubbleScale !== undefined) {
    xml.leafNode("c:bubbleScale", { val: String(g.bubbleScale) });
  }
  if (g.showNegBubbles !== undefined) {
    xml.leafNode("c:showNegBubbles", { val: g.showNegBubbles ? "1" : "0" });
  }
  if (g.sizeRepresents) {
    xml.leafNode("c:sizeRepresents", { val: g.sizeRepresents });
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
}

export function renderRadarChart(xml: XmlSink, g: RadarChartGroup): void {
  // `c:radarStyle` is required; default to `"standard"` per schema
  // when parser narrowing rejected the source value.
  xml.leafNode("c:radarStyle", { val: g.radarStyle ?? "standard" });
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderRadarSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
}

export function renderStockChart(xml: XmlSink, g: StockChartGroup): void {
  // `CT_StockChart` child sequence per ECMA-376 §21.2.2.206:
  //   ser+ → dLbls? → dropLines? → hiLowLines? → upDownBars? →
  //   axId{2} → extLst?.
  //
  // The previous emission order was:
  //   varyColors, ser, dLbls, hiLowLines, upDownBars, dropLines, axId
  // which was invalid on two counts: `CT_StockChart` has no
  // `varyColors` attribute (fields are bound by the schema, not the
  // more permissive `CT_LineChart` superset), and `dropLines`
  // precedes `hiLowLines` in the sequence. Strict validators
  // (`ooxml-validate`, LibreOffice strict) rejected both.
  for (const s of g.series) {
    renderLineSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  if (g.dropLines) {
    xml.openNode("c:dropLines");
    renderSpPr(xml, g.dropLines);
    xml.closeNode();
  }
  if (g.hiLowLines) {
    xml.openNode("c:hiLowLines");
    renderSpPr(xml, g.hiLowLines);
    xml.closeNode();
  }
  if (g.upDownBars) {
    renderUpDownBars(xml, g.upDownBars);
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
  // NOTE: `extLst` is intentionally omitted here — the caller
  // (`_renderChartTypeGroup`) emits `ctg.extLst` for every group
  // type unconditionally at the very end of the group element.
  // Writing it here too would produce a duplicate `<c:extLst>`
  // inside `<c:stockChart>`, which breaks strict validators.
}

export function renderSurfaceChart(xml: XmlSink, g: SurfaceChartGroup): void {
  if (g.wireframe !== undefined) {
    xml.leafNode("c:wireframe", { val: g.wireframe ? "1" : "0" });
  }
  for (const s of g.series) {
    renderSurfaceSeries(xml, s);
  }
  // `CT_SurfaceChart` has no `dLbls` child per schema; the builder
  // rejects `opts.dataLabels` for surface charts and the type no
  // longer carries the slot, so we simply skip emitting it here.
  if (g.bandFormats && g.bandFormats.length > 0) {
    xml.openNode("c:bandFmts");
    for (const bf of g.bandFormats) {
      xml.openNode("c:bandFmt");
      xml.leafNode("c:idx", { val: String(bf.index) });
      if (bf.spPr) {
        renderSpPr(xml, bf.spPr);
      }
      xml.closeNode();
    }
    xml.closeNode();
  }
  for (const id of g.axisIds) {
    xml.leafNode("c:axId", { val: String(id) });
  }
}

export function renderOfPieChart(xml: XmlSink, g: OfPieChartGroup): void {
  // `c:ofPieType` is required; default to `"pie"` (Excel's default
  // bar-of-pie / pie-of-pie style) when parser narrowing rejected.
  xml.leafNode("c:ofPieType", { val: g.ofPieType ?? "pie" });
  xml.leafNode("c:varyColors", { val: g.varyColors === false ? "0" : "1" });
  for (const s of g.series) {
    renderPieSeries(xml, s);
  }
  if (g.dataLabels) {
    renderDataLabels(xml, g.dataLabels);
  }
  if (g.gapWidth !== undefined) {
    xml.leafNode("c:gapWidth", { val: String(g.gapWidth) });
  }
  if (g.splitType) {
    xml.leafNode("c:splitType", { val: g.splitType });
  }
  if (g.splitPos !== undefined) {
    xml.leafNode("c:splitPos", { val: String(g.splitPos) });
  }
  if (g.custSplit && g.custSplit.length > 0) {
    xml.openNode("c:custSplit");
    for (const idx of g.custSplit) {
      xml.leafNode("c:secondPiePt", { val: String(idx) });
    }
    xml.closeNode();
  }
  if (g.secondPieSize !== undefined) {
    xml.leafNode("c:secondPieSize", { val: String(g.secondPieSize) });
  }
  if (g.serLines) {
    xml.openNode("c:serLines");
    renderSpPr(xml, g.serLines);
    xml.closeNode();
  }
}

// ---- Series rendering ----

export function renderSeriesBase(xml: XmlSink, s: SeriesBase): void {
  xml.leafNode("c:idx", { val: String(s.index) });
  xml.leafNode("c:order", { val: String(s.order) });
  if (s.tx) {
    renderSeriesTx(xml, s.tx);
  }
  if (s.spPr) {
    renderSpPr(xml, s.spPr);
  }
}

export function renderBarSeries(xml: XmlSink, s: BarSeries): void {
  xml.openNode("c:ser");
  renderSeriesBase(xml, s);
  if (s.invertIfNegative !== undefined) {
    xml.leafNode("c:invertIfNegative", { val: s.invertIfNegative ? "1" : "0" });
  }
  if (s.pictureOptions) {
    renderPictureOptions(xml, s.pictureOptions);
  }
  if (s.dataPoints) {
    for (const dp of s.dataPoints) {
      renderDataPoint(xml, dp);
    }
  }
  if (s.dataLabels) {
    renderDataLabels(xml, s.dataLabels);
  }
  if (s.trendlines) {
    for (const t of s.trendlines) {
      renderTrendline(xml, t);
    }
  }
  if (s.errorBars) {
    renderErrorBars(xml, s.errorBars);
  }
  if (s.cat) {
    renderCatData(xml, s.cat);
  }
  if (s.val) {
    renderValData(xml, s.val);
  }
  if (s.shape) {
    xml.leafNode("c:shape", { val: s.shape });
  }
  if (s.extLst) {
    xml.writeRaw(s.extLst);
  }
  xml.closeNode();
}

export function renderLineSeries(xml: XmlSink, s: LineSeries): void {
  xml.openNode("c:ser");
  renderSeriesBase(xml, s);
  if (s.marker) {
    renderMarker(xml, s.marker);
  }
  if (s.dataPoints) {
    for (const dp of s.dataPoints) {
      renderDataPoint(xml, dp);
    }
  }
  if (s.dataLabels) {
    renderDataLabels(xml, s.dataLabels);
  }
  if (s.trendlines) {
    for (const t of s.trendlines) {
      renderTrendline(xml, t);
    }
  }
  if (s.errorBars) {
    renderErrorBars(xml, s.errorBars);
  }
  if (s.cat) {
    renderCatData(xml, s.cat);
  }
  if (s.val) {
    renderValData(xml, s.val);
  }
  if (s.smooth !== undefined) {
    xml.leafNode("c:smooth", { val: s.smooth ? "1" : "0" });
  }
  if (s.extLst) {
    xml.writeRaw(s.extLst);
  }
  xml.closeNode();
}

export function renderPieSeries(xml: XmlSink, s: PieSeries, opts?: DataLabelRenderOptions): void {
  xml.openNode("c:ser");
  renderSeriesBase(xml, s);
  if (s.explosion !== undefined) {
    xml.leafNode("c:explosion", { val: String(s.explosion) });
  }
  if (s.dataPoints) {
    for (const dp of s.dataPoints) {
      renderDataPoint(xml, dp);
    }
  }
  if (s.dataLabels) {
    renderDataLabels(xml, s.dataLabels, opts);
  }
  if (s.cat) {
    renderCatData(xml, s.cat);
  }
  if (s.val) {
    renderValData(xml, s.val);
  }
  if (s.extLst) {
    xml.writeRaw(s.extLst);
  }
  xml.closeNode();
}

export function renderAreaSeries(xml: XmlSink, s: AreaSeries): void {
  xml.openNode("c:ser");
  renderSeriesBase(xml, s);
  // OOXML `CT_AreaSer` child sequence: SerShared (index, order, tx,
  // spPr) → pictureOptions? → dPt* → dLbls → trendline* → errBars
  // → cat → val → extLst. Previously `pictureOptions` was parsed
  // (see `_processSeries` at line 4617) but never written back, so
  // a round-trip of a texture-filled area chart lost the
  // pictureFormat (`stretch` / `stack` / …) and the author's scale
  // parameters — Excel fell back to `stretch` as the default.
  if (s.pictureOptions) {
    renderPictureOptions(xml, s.pictureOptions);
  }
  if (s.dataPoints) {
    for (const dp of s.dataPoints) {
      renderDataPoint(xml, dp);
    }
  }
  if (s.dataLabels) {
    renderDataLabels(xml, s.dataLabels);
  }
  if (s.trendlines) {
    for (const t of s.trendlines) {
      renderTrendline(xml, t);
    }
  }
  if (s.errorBars) {
    renderErrorBars(xml, s.errorBars);
  }
  if (s.cat) {
    renderCatData(xml, s.cat);
  }
  if (s.val) {
    renderValData(xml, s.val);
  }
  if (s.extLst) {
    xml.writeRaw(s.extLst);
  }
  xml.closeNode();
}

export function renderScatterSeries(xml: XmlSink, s: ScatterSeries): void {
  xml.openNode("c:ser");
  renderSeriesBase(xml, s);
  if (s.marker) {
    renderMarker(xml, s.marker);
  }
  if (s.dataPoints) {
    for (const dp of s.dataPoints) {
      renderDataPoint(xml, dp);
    }
  }
  if (s.dataLabels) {
    renderDataLabels(xml, s.dataLabels);
  }
  if (s.trendlines) {
    for (const t of s.trendlines) {
      renderTrendline(xml, t);
    }
  }
  if (s.errorBars) {
    for (const eb of s.errorBars) {
      renderErrorBars(xml, eb);
    }
  }
  if (s.xVal) {
    renderCatData(xml, s.xVal, "c:xVal");
  }
  if (s.yVal) {
    renderValData(xml, s.yVal, "c:yVal");
  }
  if (s.smooth !== undefined) {
    xml.leafNode("c:smooth", { val: s.smooth ? "1" : "0" });
  }
  if (s.extLst) {
    xml.writeRaw(s.extLst);
  }
  xml.closeNode();
}

export function renderBubbleSeries(xml: XmlSink, s: BubbleSeries): void {
  xml.openNode("c:ser");
  renderSeriesBase(xml, s);
  if (s.invertIfNegative !== undefined) {
    xml.leafNode("c:invertIfNegative", { val: s.invertIfNegative ? "1" : "0" });
  }
  if (s.dataPoints) {
    for (const dp of s.dataPoints) {
      renderDataPoint(xml, dp);
    }
  }
  if (s.dataLabels) {
    renderDataLabels(xml, s.dataLabels);
  }
  if (s.trendlines) {
    for (const t of s.trendlines) {
      renderTrendline(xml, t);
    }
  }
  if (s.errorBars) {
    for (const eb of s.errorBars) {
      renderErrorBars(xml, eb);
    }
  }
  if (s.xVal) {
    renderCatData(xml, s.xVal, "c:xVal");
  }
  if (s.yVal) {
    renderValData(xml, s.yVal, "c:yVal");
  }
  if (s.bubbleSize) {
    renderValData(xml, s.bubbleSize, "c:bubbleSize");
  }
  if (s.bubble3D !== undefined) {
    xml.leafNode("c:bubble3D", { val: s.bubble3D ? "1" : "0" });
  }
  if (s.extLst) {
    xml.writeRaw(s.extLst);
  }
  xml.closeNode();
}

export function renderRadarSeries(xml: XmlSink, s: RadarSeries): void {
  xml.openNode("c:ser");
  renderSeriesBase(xml, s);
  if (s.marker) {
    renderMarker(xml, s.marker);
  }
  if (s.dataPoints) {
    for (const dp of s.dataPoints) {
      renderDataPoint(xml, dp);
    }
  }
  if (s.dataLabels) {
    renderDataLabels(xml, s.dataLabels);
  }
  if (s.cat) {
    renderCatData(xml, s.cat);
  }
  if (s.val) {
    renderValData(xml, s.val);
  }
  if (s.extLst) {
    xml.writeRaw(s.extLst);
  }
  xml.closeNode();
}

export function renderSurfaceSeries(xml: XmlSink, s: SurfaceSeries): void {
  xml.openNode("c:ser");
  renderSeriesBase(xml, s);
  if (s.cat) {
    renderCatData(xml, s.cat);
  }
  if (s.val) {
    renderValData(xml, s.val);
  }
  if (s.extLst) {
    xml.writeRaw(s.extLst);
  }
  xml.closeNode();
}

// ---- Data references ----

export function renderSeriesTx(
  xml: XmlSink,
  tx: { strRef?: StringReference; value?: string }
): void {
  xml.openNode("c:tx");
  if (tx.strRef) {
    renderStrRef(xml, tx.strRef);
  } else if (tx.value !== undefined) {
    xml.openNode("c:v");
    xml.writeText(tx.value);
    xml.closeNode();
  }
  xml.closeNode();
}

export function renderCatData(xml: XmlSink, d: AxisDataSource, tag = "c:cat"): void {
  xml.openNode(tag);
  if (d.strRef) {
    renderStrRef(xml, d.strRef);
  } else if (d.numRef) {
    renderNumRef(xml, d.numRef);
  } else if (d.strLit) {
    renderStrLit(xml, d.strLit);
  } else if (d.numLit) {
    renderNumLit(xml, d.numLit);
  } else if (d.multiLvlStrRef) {
    renderMultiLvlStrRef(xml, d.multiLvlStrRef);
  }
  xml.closeNode();
}

export function renderValData(xml: XmlSink, d: NumberDataSource, tag = "c:val"): void {
  xml.openNode(tag);
  if (d.numRef) {
    renderNumRef(xml, d.numRef);
  } else if (d.numLit) {
    renderNumLit(xml, d.numLit);
  }
  xml.closeNode();
}

export function renderNumRef(xml: XmlSink, ref: NumberReference): void {
  xml.openNode("c:numRef");
  xml.openNode("c:f");
  xml.writeText(ref.formula);
  xml.closeNode();
  if (ref.cache) {
    renderNumCache(xml, ref.cache);
  }
  xml.closeNode();
}

export function renderStrRef(xml: XmlSink, ref: StringReference): void {
  xml.openNode("c:strRef");
  xml.openNode("c:f");
  xml.writeText(ref.formula);
  xml.closeNode();
  if (ref.cache) {
    renderStrCache(xml, ref.cache);
  }
  xml.closeNode();
}

export function renderNumCache(xml: XmlSink, cache: NumberCache): void {
  xml.openNode("c:numCache");
  if (cache.formatCode) {
    xml.leafNode("c:formatCode", undefined, cache.formatCode);
  }
  // ptCount: prefer the explicit value from the model (preserves the
  // "declared N points but M ≤ N have values" OOXML convention for
  // sparse caches); otherwise fall back to `points.length` so
  // hand-authored caches never emit a cache missing the required
  // `c:ptCount` element.
  const ptCount = cache.pointCount ?? cache.points.length;
  xml.leafNode("c:ptCount", { val: String(ptCount) });
  for (const pt of cache.points) {
    // `!= null` catches both `null` (sparse slot sentinel) AND
    // `undefined` (uninitialised points on hand-built caches).
    // Strict `!== null` would let `undefined` through and emit
    // `<c:v>undefined</c:v>` — Excel parses that as a string "undefined"
    // on a numeric cache, corrupting the series on reopen.
    if (pt.value != null) {
      const attrs: Record<string, string> = { idx: String(pt.index) };
      if (pt.formatCode) {
        attrs.formatCode = pt.formatCode;
      }
      xml.openNode("c:pt", attrs);
      xml.openNode("c:v");
      xml.writeText(String(pt.value));
      xml.closeNode();
      xml.closeNode();
    }
  }
  xml.closeNode();
}

export function renderStrCache(xml: XmlSink, cache: StringCache): void {
  xml.openNode("c:strCache");
  const ptCount = cache.pointCount ?? cache.points.length;
  xml.leafNode("c:ptCount", { val: String(ptCount) });
  for (const pt of cache.points) {
    xml.openNode("c:pt", { idx: String(pt.index) });
    xml.openNode("c:v");
    xml.writeText(pt.value);
    xml.closeNode();
    xml.closeNode();
  }
  xml.closeNode();
}

export function renderNumLit(xml: XmlSink, lit: NumberLiteral): void {
  xml.openNode("c:numLit");
  if (lit.formatCode) {
    xml.leafNode("c:formatCode", undefined, lit.formatCode);
  }
  // `CT_NumData` requires `ptCount` per ECMA-376 §21.2.2.163 (same
  // convention as `CT_NumRef/numCache`). Fall back to `points.length`
  // when the caller did not set an explicit `pointCount` so
  // programmatically-built literal lists always emit the required
  // element — the previous `if (lit.pointCount !== undefined)` gate
  // produced schema-invalid XML that both validators and Excel's
  // strict open path rejected.
  const ptCount = lit.pointCount ?? lit.points.length;
  xml.leafNode("c:ptCount", { val: String(ptCount) });
  for (const pt of lit.points) {
    // `!= null` rather than `!== null` so `undefined` also skips
    // emission — see `_renderNumCache` for the rationale.
    if (pt.value != null) {
      xml.openNode("c:pt", { idx: String(pt.index) });
      xml.openNode("c:v");
      xml.writeText(String(pt.value));
      xml.closeNode();
      xml.closeNode();
    }
  }
  xml.closeNode();
}

export function renderStrLit(xml: XmlSink, lit: StringLiteral): void {
  xml.openNode("c:strLit");
  // `CT_StrData` mandates `ptCount`; mirror the `_renderNumLit`
  // fallback rather than silently omitting the element when
  // `lit.pointCount` is unset.
  const ptCount = lit.pointCount ?? lit.points.length;
  xml.leafNode("c:ptCount", { val: String(ptCount) });
  for (const pt of lit.points) {
    xml.openNode("c:pt", { idx: String(pt.index) });
    xml.openNode("c:v");
    xml.writeText(pt.value);
    xml.closeNode();
    xml.closeNode();
  }
  xml.closeNode();
}

export function renderMultiLvlStrRef(xml: XmlSink, ref: MultiLevelStringReference): void {
  xml.openNode("c:multiLvlStrRef");
  xml.openNode("c:f");
  xml.writeText(ref.formula);
  xml.closeNode();
  if (ref.cache) {
    xml.openNode("c:multiLvlStrCache");
    if (ref.cache.pointCount !== undefined) {
      xml.leafNode("c:ptCount", { val: String(ref.cache.pointCount) });
    }
    for (const level of ref.cache.levels) {
      xml.openNode("c:lvl");
      for (const pt of level.points) {
        xml.openNode("c:pt", { idx: String(pt.index) });
        xml.openNode("c:v");
        xml.writeText(pt.value);
        xml.closeNode();
        xml.closeNode();
      }
      xml.closeNode();
    }
    xml.closeNode();
  }
  xml.closeNode();
}

// ---- Marker, DataPoint, DataLabels ----

export function renderMarker(xml: XmlSink, m: ChartMarker): void {
  xml.openNode("c:marker");
  if (m.symbol) {
    xml.leafNode("c:symbol", { val: m.symbol });
  }
  if (m.size !== undefined) {
    xml.leafNode("c:size", { val: String(m.size) });
  }
  if (m.spPr) {
    renderSpPr(xml, m.spPr);
  }
  if (m.extLst) {
    xml.writeRaw(m.extLst);
  }
  xml.closeNode();
}

export function renderDataPoint(xml: XmlSink, dp: DataPoint): void {
  xml.openNode("c:dPt");
  xml.leafNode("c:idx", { val: String(dp.index) });
  if (dp.invertIfNegative !== undefined) {
    xml.leafNode("c:invertIfNegative", { val: dp.invertIfNegative ? "1" : "0" });
  }
  if (dp.marker) {
    renderMarker(xml, dp.marker);
  }
  if (dp.bubble3D !== undefined) {
    xml.leafNode("c:bubble3D", { val: dp.bubble3D ? "1" : "0" });
  }
  if (dp.explosion !== undefined) {
    xml.leafNode("c:explosion", { val: String(dp.explosion) });
  }
  if (dp.spPr) {
    renderSpPr(xml, dp.spPr);
  }
  if (dp.pictureOptions) {
    renderPictureOptions(xml, dp.pictureOptions);
  }
  if (dp.extLst) {
    xml.writeRaw(dp.extLst);
  }
  xml.closeNode();
}

/**
 * Serialise a single {@link DataLabelEntry} as `<c:dLbl>…</c:dLbl>`.
 * Shared between the series-level `<c:dLbls><c:dLbl/>` loop and
 * pivot-format containers that emit a bare `<c:dLbl/>` without the
 * enclosing `<c:dLbls>` wrapper.
 */
export function renderDataLabelEntry(
  xml: XmlSink,
  e: DataLabelEntry,
  opts?: DataLabelRenderOptions
): void {
  xml.openNode("c:dLbl");
  xml.leafNode("c:idx", { val: String(e.index) });
  // ECMA-376 CT_DLbl is `idx, choice(delete | (layout, tx, numFmt, spPr,
  // txPr, dLblPos, showLegendKey, showVal, showCatName, showSerName,
  // showPercent, showBubbleSize, separator), extLst)`. When `delete` is
  // set we must emit `<c:delete val="1"/>` alone (choice left branch);
  // all the display-option children belong to the other branch and
  // would make the XML schema-invalid — some Excel builds reject it.
  if (e.delete) {
    xml.leafNode("c:delete", { val: "1" });
    if (e.extLst) {
      xml.writeRaw(e.extLst);
    }
    xml.closeNode();
    return;
  }
  if (e.layout) {
    renderLayout(xml, e.layout);
  }
  if (e.rawTx) {
    xml.writeRaw(e.rawTx);
  } else if (e.text) {
    renderRichText(xml, e.text, "c:tx");
  }
  if (e.numFmt) {
    xml.leafNode("c:numFmt", {
      formatCode: e.numFmt.formatCode,
      ...(e.numFmt.sourceLinked !== undefined
        ? { sourceLinked: e.numFmt.sourceLinked ? "1" : "0" }
        : {})
    });
  }
  if (e.spPr) {
    renderSpPr(xml, e.spPr);
  }
  if (e.txPr) {
    renderTxPr(xml, e.txPr);
  }
  if (e.position && !opts?.suppressDLblPos) {
    xml.leafNode("c:dLblPos", { val: e.position });
  }
  if (e.showLegendKey !== undefined) {
    xml.leafNode("c:showLegendKey", { val: e.showLegendKey ? "1" : "0" });
  }
  if (e.showVal !== undefined) {
    xml.leafNode("c:showVal", { val: e.showVal ? "1" : "0" });
  }
  if (e.showCatName !== undefined) {
    xml.leafNode("c:showCatName", { val: e.showCatName ? "1" : "0" });
  }
  if (e.showSerName !== undefined) {
    xml.leafNode("c:showSerName", { val: e.showSerName ? "1" : "0" });
  }
  if (e.showPercent !== undefined) {
    xml.leafNode("c:showPercent", { val: e.showPercent ? "1" : "0" });
  }
  if (e.showBubbleSize !== undefined) {
    xml.leafNode("c:showBubbleSize", { val: e.showBubbleSize ? "1" : "0" });
  }
  if (e.separator) {
    xml.openNode("c:separator");
    xml.writeText(e.separator);
    xml.closeNode();
  }
  if (e.extLst) {
    xml.writeRaw(e.extLst);
  }
  xml.closeNode();
}

export function renderDataLabels(
  xml: XmlSink,
  dl: DataLabels,
  opts?: DataLabelRenderOptions
): void {
  xml.openNode("c:dLbls");
  // ECMA-376 CT_DLbls: `(dLbl* & display-flags) | delete` — the
  // `delete` choice is mutually exclusive with the dLbl list and
  // every display-option child. Emit `delete` alone (+ extLst) when
  // set so strict validators (xsd, Excel strict mode) accept the
  // output. Previously we emitted `entries` before checking
  // `delete`, producing `<c:dLbl>…<c:delete val="1"/>` which violates
  // the choice.
  if (dl.delete) {
    xml.leafNode("c:delete", { val: "1" });
    if (dl.extLst) {
      xml.writeRaw(dl.extLst);
    }
    xml.closeNode();
    return;
  }
  if (dl.entries) {
    for (const e of dl.entries) {
      renderDataLabelEntry(xml, e, opts);
    }
  }
  if (dl.numFmt) {
    xml.leafNode("c:numFmt", {
      formatCode: dl.numFmt.formatCode,
      ...(dl.numFmt.sourceLinked !== undefined
        ? { sourceLinked: dl.numFmt.sourceLinked ? "1" : "0" }
        : {})
    });
  }
  if (dl.spPr) {
    renderSpPr(xml, dl.spPr);
  }
  if (dl.txPr) {
    renderTxPr(xml, dl.txPr);
  }
  // `c:dLblPos` is forbidden by Excel's reader on doughnut charts
  // even though the schema permits it — see `_renderDoughnutChart`
  // for the full rationale. Callers set `opts.suppressDLblPos` to
  // drop the element without mutating the source model.
  if (dl.position && !opts?.suppressDLblPos) {
    xml.leafNode("c:dLblPos", { val: dl.position });
  }
  if (dl.showLegendKey !== undefined) {
    xml.leafNode("c:showLegendKey", { val: dl.showLegendKey ? "1" : "0" });
  }
  if (dl.showVal !== undefined) {
    xml.leafNode("c:showVal", { val: dl.showVal ? "1" : "0" });
  }
  if (dl.showCatName !== undefined) {
    xml.leafNode("c:showCatName", { val: dl.showCatName ? "1" : "0" });
  }
  if (dl.showSerName !== undefined) {
    xml.leafNode("c:showSerName", { val: dl.showSerName ? "1" : "0" });
  }
  if (dl.showPercent !== undefined) {
    xml.leafNode("c:showPercent", { val: dl.showPercent ? "1" : "0" });
  }
  if (dl.showBubbleSize !== undefined) {
    xml.leafNode("c:showBubbleSize", { val: dl.showBubbleSize ? "1" : "0" });
  }
  // `c:separator` MUST precede `c:showLeaderLines` / `c:leaderLines`
  // per ECMA-376 `CT_DLbls` (§21.2.2.49) and Microsoft OpenXML SDK
  // `DataLabels.ChildElementInfo` ordering:
  //   … showBubbleSize, separator, showLeaderLines, leaderLines, extLst.
  // Emitting `showLeaderLines` first produces a schema-invalid
  // document — Excel repairs it silently on open (dropping either
  // element), LibreOffice strict mode rejects it.
  if (dl.separator) {
    xml.openNode("c:separator");
    xml.writeText(dl.separator);
    xml.closeNode();
  }
  if (dl.showLeaderLines !== undefined) {
    xml.leafNode("c:showLeaderLines", { val: dl.showLeaderLines ? "1" : "0" });
  }
  // `dataLabelsRange` (Excel 2013+ "Value From Cells") serialises as a
  // `c15:datalabelsRange` element inside `c:dLbls/c:extLst/c:ext`. When
  // both `dataLabelsRange` and `extLst` are set, splice the ext into
  // the existing rawXml so other extensions already captured there are
  // preserved. When only `dataLabelsRange` is set, emit a fresh wrapper.
  const dlRangeExt = dl.dataLabelsRange ? buildC15DataLabelsRangeExt(dl.dataLabelsRange) : "";
  if (dlRangeExt && dl.extLst) {
    const close = dl.extLst.lastIndexOf("</c:extLst");
    if (close >= 0) {
      xml.writeRaw(dl.extLst.slice(0, close) + dlRangeExt + dl.extLst.slice(close));
    } else {
      xml.writeRaw(dl.extLst);
      xml.writeRaw(`<c:extLst>${dlRangeExt}</c:extLst>`);
    }
  } else if (dl.extLst) {
    xml.writeRaw(dl.extLst);
  } else if (dlRangeExt) {
    xml.writeRaw(`<c:extLst>${dlRangeExt}</c:extLst>`);
  }
  xml.closeNode();
}

/**
 * Serialise a {@link DataLabelsRange} as the `c:ext` wrapper Excel
 * 2013+ expects:
 *
 * ```xml
 * <c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}"
 *        xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart">
 *   <c15:datalabelsRange>
 *     <c15:f>Sheet1!$A$1:$A$5</c15:f>
 *     <c15:dlblRangeCache>
 *       <c15:ptCount val="5"/>
 *       <c15:pt idx="0"><c15:v>Label 1</c15:v></c15:pt>
 *       …
 *     </c15:dlblRangeCache>
 *   </c15:datalabelsRange>
 * </c:ext>
 * ```
 *
 * The URI and child-element names are exactly what Excel emits —
 * verified against a user-authored xlsx via
 * `tmp/pivot-sample/xl/charts/chart1.xml` (the extension URI also
 * appears as a placeholder inside `c:pivotFmt/c:dLbl`).
 */
export function buildC15DataLabelsRangeExt(range: DataLabelsRange): string {
  const parts: string[] = [];
  parts.push(`<c:ext uri="${C15_DATA_LABELS_RANGE_EXT_URI}" xmlns:c15="${C15_CHART_NAMESPACE}">`);
  parts.push(`<c15:datalabelsRange>`);
  parts.push(`<c15:f>${escapeXmlText(range.formula)}</c15:f>`);
  // Emit the cache whenever the parser / cache-populator saw ANY
  // resolved cells — an all-blank range has `pointCount > 0` but
  // `points = []`, and without the cache element Excel loses the
  // array length and desynchronises labels from the underlying data
  // points. Previously gated on `points.length > 0`, which dropped
  // the `ptCount` for the blank case.
  if (range.cache && (range.cache.pointCount !== undefined || range.cache.points.length > 0)) {
    parts.push(`<c15:dlblRangeCache>`);
    if (range.cache.pointCount !== undefined) {
      parts.push(`<c15:ptCount val="${range.cache.pointCount}"/>`);
    }
    for (const pt of range.cache.points) {
      parts.push(`<c15:pt idx="${pt.index}"><c15:v>${escapeXmlText(pt.value)}</c15:v></c15:pt>`);
    }
    parts.push(`</c15:dlblRangeCache>`);
  }
  parts.push(`</c15:datalabelsRange>`);
  parts.push(`</c:ext>`);
  return parts.join("");
}

// ---- Trendline, ErrorBars ----

export function renderTrendline(xml: XmlSink, t: Trendline): void {
  xml.openNode("c:trendline");
  if (t.name) {
    xml.openNode("c:name");
    xml.writeText(t.name);
    xml.closeNode();
  }
  if (t.spPr) {
    renderSpPr(xml, t.spPr);
  }
  xml.leafNode("c:trendlineType", { val: t.type });
  if (t.order !== undefined) {
    xml.leafNode("c:order", { val: String(t.order) });
  }
  if (t.period !== undefined) {
    xml.leafNode("c:period", { val: String(t.period) });
  }
  if (t.forward !== undefined) {
    xml.leafNode("c:forward", { val: String(t.forward) });
  }
  if (t.backward !== undefined) {
    xml.leafNode("c:backward", { val: String(t.backward) });
  }
  if (t.intercept !== undefined) {
    xml.leafNode("c:intercept", { val: String(t.intercept) });
  }
  if (t.displayRSqr !== undefined) {
    xml.leafNode("c:dispRSqr", { val: t.displayRSqr ? "1" : "0" });
  }
  if (t.displayEq !== undefined) {
    xml.leafNode("c:dispEq", { val: t.displayEq ? "1" : "0" });
  }
  if (t.trendlineLbl) {
    xml.openNode("c:trendlineLbl");
    if (t.trendlineLbl.layout) {
      renderLayout(xml, t.trendlineLbl.layout);
    }
    if (t.trendlineLbl.rawTx) {
      xml.writeRaw(t.trendlineLbl.rawTx);
    } else if (t.trendlineLbl.text) {
      renderRichText(xml, t.trendlineLbl.text, "c:tx");
    }
    if (t.trendlineLbl.numFmt) {
      xml.leafNode("c:numFmt", {
        formatCode: t.trendlineLbl.numFmt.formatCode,
        ...(t.trendlineLbl.numFmt.sourceLinked !== undefined
          ? { sourceLinked: t.trendlineLbl.numFmt.sourceLinked ? "1" : "0" }
          : {})
      });
    }
    if (t.trendlineLbl.spPr) {
      renderSpPr(xml, t.trendlineLbl.spPr);
    }
    if (t.trendlineLbl.txPr) {
      renderTxPr(xml, t.trendlineLbl.txPr);
    }
    if (t.trendlineLbl.extLst) {
      xml.writeRaw(t.trendlineLbl.extLst);
    }
    xml.closeNode();
  }
  if (t.extLst) {
    xml.writeRaw(t.extLst);
  }
  xml.closeNode();
}

export function renderErrorBars(xml: XmlSink, eb: ErrorBars): void {
  xml.openNode("c:errBars");
  // ECMA-376 CT_ErrBars child order:
  //   errDir?, errBarType, errValType, noEndCap?, plus?, minus?, val?, spPr?, extLst?
  // `c:val` must come after `plus`/`minus` — we previously emitted
  // `val` before `plus`/`minus` which produced schema-invalid XML
  // that strict OOXML validators (and some Excel versions in strict
  // mode) reject.
  if (eb.errDir) {
    xml.leafNode("c:errDir", { val: eb.errDir });
  }
  xml.leafNode("c:errBarType", { val: eb.barDir });
  xml.leafNode("c:errValType", { val: eb.errValType });
  if (eb.noEndCap !== undefined) {
    xml.leafNode("c:noEndCap", { val: eb.noEndCap ? "1" : "0" });
  }
  if (eb.plus) {
    renderValData(xml, eb.plus, "c:plus");
  }
  if (eb.minus) {
    renderValData(xml, eb.minus, "c:minus");
  }
  if (eb.val !== undefined) {
    xml.leafNode("c:val", { val: String(eb.val) });
  }
  if (eb.spPr) {
    renderSpPr(xml, eb.spPr);
  }
  if (eb.extLst) {
    xml.writeRaw(eb.extLst);
  }
  xml.closeNode();
}

export function renderPictureOptions(xml: XmlSink, po: PictureOptions): void {
  xml.openNode("c:pictureOptions");
  if (po.applyToFront !== undefined) {
    xml.leafNode("c:applyToFront", { val: po.applyToFront ? "1" : "0" });
  }
  if (po.applyToSides !== undefined) {
    xml.leafNode("c:applyToSides", { val: po.applyToSides ? "1" : "0" });
  }
  if (po.applyToEnd !== undefined) {
    xml.leafNode("c:applyToEnd", { val: po.applyToEnd ? "1" : "0" });
  }
  if (po.pictureFormat) {
    xml.leafNode("c:pictureFormat", { val: po.pictureFormat });
  }
  if (po.pictureStackUnit !== undefined) {
    xml.leafNode("c:pictureStackUnit", { val: String(po.pictureStackUnit) });
  }
  xml.closeNode();
}

export function renderUpDownBars(xml: XmlSink, udb: UpDownBars): void {
  xml.openNode("c:upDownBars");
  if (udb.gapWidth !== undefined) {
    xml.leafNode("c:gapWidth", { val: String(udb.gapWidth) });
  }
  if (udb.upBars) {
    xml.openNode("c:upBars");
    renderSpPr(xml, udb.upBars);
    xml.closeNode();
  }
  if (udb.downBars) {
    xml.openNode("c:downBars");
    renderSpPr(xml, udb.downBars);
    xml.closeNode();
  }
  if (udb.extLst) {
    xml.writeRaw(udb.extLst);
  }
  xml.closeNode();
}

// ---- Axes ----

export function renderAxis(xml: XmlSink, ax: ChartAxis): void {
  const tagMap: Record<string, string> = {
    cat: "c:catAx",
    val: "c:valAx",
    date: "c:dateAx",
    ser: "c:serAx"
  };
  const tag = tagMap[ax.axisType];
  if (!tag) {
    return;
  }

  xml.openNode(tag);
  xml.leafNode("c:axId", { val: String(ax.axId) });

  // Scaling — per ECMA-376 `CT_Scaling` sequence: `logBase?`,
  // `orientation?`, `max?`, `min?`, `extLst?` (see Microsoft
  // OpenXML `Scaling.ChildElementInfo` ordering). Emitting `min`
  // before `max` — or any of the earlier orderings this file
  // previously shipped (`orientation, max, min, logBase`) — is a
  // schema violation. Excel tolerates the wrong order on read
  // but flags the chart with a "Repaired Records" dialog on
  // open; LibreOffice strict mode and `ooxml-validate` refuse
  // the document outright.
  xml.openNode("c:scaling");
  if (ax.scaling?.logBase !== undefined) {
    xml.leafNode("c:logBase", { val: String(ax.scaling.logBase) });
  }
  if (ax.scaling?.orientation) {
    xml.leafNode("c:orientation", { val: ax.scaling.orientation });
  }
  if (ax.scaling?.max !== undefined) {
    xml.leafNode("c:max", { val: String(ax.scaling.max) });
  }
  if (ax.scaling?.min !== undefined) {
    xml.leafNode("c:min", { val: String(ax.scaling.min) });
  }
  xml.closeNode();

  if (ax.delete !== undefined) {
    xml.leafNode("c:delete", { val: ax.delete ? "1" : "0" });
  }
  xml.leafNode("c:axPos", { val: ax.axPos });
  if (ax.majorGridlines) {
    xml.openNode("c:majorGridlines");
    renderSpPr(xml, ax.majorGridlines);
    xml.closeNode();
  }
  if (ax.minorGridlines) {
    xml.openNode("c:minorGridlines");
    renderSpPr(xml, ax.minorGridlines);
    xml.closeNode();
  }
  if (ax.title) {
    renderTitle(xml, ax.title, "c:title");
  }
  if (ax.numFmt) {
    xml.leafNode("c:numFmt", {
      formatCode: ax.numFmt.formatCode,
      ...(ax.numFmt.sourceLinked !== undefined
        ? { sourceLinked: ax.numFmt.sourceLinked ? "1" : "0" }
        : {})
    });
  }
  // **These stay conditional, and an earlier attempt at this fix made them unconditional.**
  //
  // The reasoning was that Excel always writes them, so writing them could only improve fidelity. Two things were
  // wrong with it. Performance: the 473 s → 403 s drop that motivated it was measured by running LibreOffice on
  // several variants *concurrently*, so the instances contended and every intermediate reading was noise — re-measured
  // serially it changes nothing, and `c:varyColors` is the whole effect. Correctness: this renderer is not the only
  // path to a chart part. A chart loaded from a file and patched keeps its original XML, and injecting a default into
  // an axis the caller never touched overwrites what was there — which is exactly what the raw-passthrough test
  // caught, an axis arriving with `val="outside"` and leaving with the default.
  if (ax.majorTickMark) {
    xml.leafNode("c:majorTickMark", { val: tickMarkToOoxml(ax.majorTickMark) });
  }
  if (ax.minorTickMark) {
    xml.leafNode("c:minorTickMark", { val: tickMarkToOoxml(ax.minorTickMark) });
  }
  if (ax.tickLblPos) {
    xml.leafNode("c:tickLblPos", { val: ax.tickLblPos });
  }
  if (ax.spPr) {
    renderSpPr(xml, ax.spPr);
  }
  if (ax.txPr) {
    renderTxPr(xml, ax.txPr);
  }
  // `c:crossAx` is a required child of every axis per ECMA-376
  // `CT_ValAx` / `CT_CatAx`. Guard against `undefined` leaking from
  // a mutated model — emitting `val="undefined"` here produces a
  // file Excel rejects. Skip the element when the field is missing;
  // the xform's axis-id allocator should have filled it in at parse
  // time, so an absent crossAx at write time signals a bug upstream
  // that's better surfaced as a validation error from Excel than
  // silently corrupted XML.
  if (typeof ax.crossAx === "number" && Number.isFinite(ax.crossAx)) {
    xml.leafNode("c:crossAx", { val: String(ax.crossAx) });
  }
  if (ax.crosses) {
    xml.leafNode("c:crosses", { val: ax.crosses });
  }
  if (ax.crossesAt !== undefined) {
    xml.leafNode("c:crossesAt", { val: String(ax.crossesAt) });
  }

  // Type-specific properties
  if (ax.axisType === "cat") {
    const ca = ax as CategoryAxis;
    if (ca.auto !== undefined) {
      xml.leafNode("c:auto", { val: ca.auto ? "1" : "0" });
    }
    if (ca.lblAlgn) {
      xml.leafNode("c:lblAlgn", { val: ca.lblAlgn });
    }
    if (ca.lblOffset !== undefined) {
      xml.leafNode("c:lblOffset", { val: String(ca.lblOffset) });
    }
    if (ca.tickLblSkip !== undefined) {
      xml.leafNode("c:tickLblSkip", { val: String(ca.tickLblSkip) });
    }
    if (ca.tickMarkSkip !== undefined) {
      xml.leafNode("c:tickMarkSkip", { val: String(ca.tickMarkSkip) });
    }
    if (ca.noMultiLvlLbl !== undefined) {
      xml.leafNode("c:noMultiLvlLbl", { val: ca.noMultiLvlLbl ? "1" : "0" });
    }
  } else if (ax.axisType === "val") {
    const va = ax as ValueAxis;
    if (va.crossBetween) {
      xml.leafNode("c:crossBetween", { val: va.crossBetween });
    }
    if (va.majorUnit !== undefined) {
      xml.leafNode("c:majorUnit", { val: String(va.majorUnit) });
    }
    if (va.minorUnit !== undefined) {
      xml.leafNode("c:minorUnit", { val: String(va.minorUnit) });
    }
    if (va.dispUnits) {
      xml.openNode("c:dispUnits");
      // ECMA-376 CT_DispUnits: `(builtInUnit | custUnit)?` — the two
      // are a choice, so emitting both produces schema-invalid XML.
      // `builtInUnit` wins when the model (unusually) carries both.
      if (va.dispUnits.builtInUnit) {
        xml.leafNode("c:builtInUnit", { val: va.dispUnits.builtInUnit });
      } else if (va.dispUnits.custUnit !== undefined) {
        xml.leafNode("c:custUnit", { val: String(va.dispUnits.custUnit) });
      }
      if (va.dispUnits.label) {
        renderDispUnitsLbl(xml, va.dispUnits.label);
      }
      if (va.dispUnits.extLst) {
        xml.writeRaw(va.dispUnits.extLst);
      }
      xml.closeNode();
    }
  } else if (ax.axisType === "date") {
    const da = ax as DateAxis;
    if (da.auto !== undefined) {
      xml.leafNode("c:auto", { val: da.auto ? "1" : "0" });
    }
    if (da.lblOffset !== undefined) {
      xml.leafNode("c:lblOffset", { val: String(da.lblOffset) });
    }
    if (da.baseTimeUnit) {
      xml.leafNode("c:baseTimeUnit", { val: da.baseTimeUnit });
    }
    if (da.majorUnit !== undefined) {
      xml.leafNode("c:majorUnit", { val: String(da.majorUnit) });
    }
    if (da.majorTimeUnit) {
      xml.leafNode("c:majorTimeUnit", { val: da.majorTimeUnit });
    }
    if (da.minorUnit !== undefined) {
      xml.leafNode("c:minorUnit", { val: String(da.minorUnit) });
    }
    if (da.minorTimeUnit) {
      xml.leafNode("c:minorTimeUnit", { val: da.minorTimeUnit });
    }
  } else if (ax.axisType === "ser") {
    const sa = ax as SeriesAxis;
    if (sa.tickLblSkip !== undefined) {
      xml.leafNode("c:tickLblSkip", { val: String(sa.tickLblSkip) });
    }
    if (sa.tickMarkSkip !== undefined) {
      xml.leafNode("c:tickMarkSkip", { val: String(sa.tickMarkSkip) });
    }
  }

  if (ax.extLst) {
    xml.writeRaw(ax.extLst);
  }

  xml.closeNode();
}

// ---- Title, Legend, Layout ----

/**
 * `<c:dispUnitsLbl>` — **not** a title, despite carrying the same pieces.
 *
 * This called {@link renderTitle} with a different tag, and `CT_DispUnitsLbl` differs from `CT_Title` in three
 * ways rather than one:
 *
 * - it has **no `overlay`**, and one was emitted — the single schema violation Excel actually reported,
 *   as `Repaired Records: Drawing from /xl/drawings/drawingN.xml part (Drawing shape)` against the drawing
 *   anchoring the chart;
 * - its sequence is `layout` **then** `tx`, the reverse of `CT_Title`'s `tx` then `layout`;
 * - it has no `extLst`.
 *
 * So the shared renderer was wrong for this element in element set, order and both directions at once. The two
 * types are kept apart here rather than parameterised, because "a title with two fields suppressed and two
 * swapped" is a longer thing to read than the four-line sequence it actually is.
 *
 * The model is a `ChartTitle` because that is what the parser fills in and what the public surface accepts;
 * the fields this element cannot express are dropped on write rather than rejected, which is what every other
 * unrepresentable-in-this-position value does here.
 */
function renderDispUnitsLbl(xml: XmlSink, label: ChartTitle): void {
  xml.openNode("c:dispUnitsLbl");
  if (label.layout) {
    renderLayout(xml, label.layout);
  }
  if (label.rawTx) {
    xml.writeRaw(label.rawTx);
  } else if (label.text) {
    renderRichText(xml, label.text, "c:tx");
  } else if (label.strRef) {
    xml.openNode("c:tx");
    renderStrRef(xml, label.strRef);
    xml.closeNode();
  }
  if (label.spPr) {
    renderSpPr(xml, label.spPr);
  }
  if (label.txPr) {
    renderTxPr(xml, label.txPr);
  }
  xml.closeNode();
}

export function renderTitle(xml: XmlSink, title: ChartTitle, tag: string): void {
  xml.openNode(tag);
  if (title.rawTx) {
    xml.writeRaw(title.rawTx);
  } else if (title.text) {
    renderRichText(xml, title.text, "c:tx");
  } else if (title.strRef) {
    xml.openNode("c:tx");
    renderStrRef(xml, title.strRef);
    xml.closeNode();
  }
  if (title.layout) {
    renderLayout(xml, title.layout);
  }
  if (title.overlay !== undefined) {
    xml.leafNode("c:overlay", { val: title.overlay ? "1" : "0" });
  }
  if (title.spPr) {
    renderSpPr(xml, title.spPr);
  }
  if (title.txPr) {
    renderTxPr(xml, title.txPr);
  }
  if (title.extLst) {
    xml.writeRaw(title.extLst);
  }
  xml.closeNode();
}

export function renderLegend(xml: XmlSink, legend: ChartLegend): void {
  xml.openNode("c:legend");
  // `c:legendPos` is optional per CT_Legend. Skip when the model
  // didn't set it rather than emit a literal `val="undefined"` which
  // some validators / older Excel versions reject.
  if (legend.legendPos) {
    xml.leafNode("c:legendPos", { val: legend.legendPos });
  }
  if (legend.legendEntries) {
    for (const e of legend.legendEntries) {
      xml.openNode("c:legendEntry");
      xml.leafNode("c:idx", { val: String(e.index) });
      if (e.delete !== undefined) {
        xml.leafNode("c:delete", { val: e.delete ? "1" : "0" });
      }
      if (e.txPr) {
        renderTxPr(xml, e.txPr);
      }
      if (e.extLst) {
        xml.writeRaw(e.extLst);
      }
      xml.closeNode();
    }
  }
  if (legend.layout) {
    renderLayout(xml, legend.layout);
  }
  if (legend.overlay !== undefined) {
    xml.leafNode("c:overlay", { val: legend.overlay ? "1" : "0" });
  }
  if (legend.spPr) {
    renderSpPr(xml, legend.spPr);
  }
  if (legend.txPr) {
    renderTxPr(xml, legend.txPr);
  }
  if (legend.extLst) {
    xml.writeRaw(legend.extLst);
  }
  xml.closeNode();
}

export function renderLayout(xml: XmlSink, layout?: ChartLayout): void {
  if (!layout) {
    // Previously this emitted an empty `<c:layout/>` sentinel. That
    // produced a byte-diff on every round-trip of charts whose source
    // XML did not include a `<c:layout>` element (which is the norm:
    // Excel omits it when no manual layout is set). Callers that
    // genuinely need the placeholder now emit `<c:layout/>` themselves.
    return;
  }
  xml.openNode("c:layout");
  if (layout.manualLayout) {
    const ml = layout.manualLayout;
    xml.openNode("c:manualLayout");
    if (ml.layoutTarget) {
      xml.leafNode("c:layoutTarget", { val: ml.layoutTarget });
    }
    if (ml.xMode) {
      xml.leafNode("c:xMode", { val: ml.xMode });
    }
    if (ml.yMode) {
      xml.leafNode("c:yMode", { val: ml.yMode });
    }
    if (ml.wMode) {
      xml.leafNode("c:wMode", { val: ml.wMode });
    }
    if (ml.hMode) {
      xml.leafNode("c:hMode", { val: ml.hMode });
    }
    if (ml.x !== undefined) {
      xml.leafNode("c:x", { val: String(ml.x) });
    }
    if (ml.y !== undefined) {
      xml.leafNode("c:y", { val: String(ml.y) });
    }
    if (ml.w !== undefined) {
      xml.leafNode("c:w", { val: String(ml.w) });
    }
    if (ml.h !== undefined) {
      xml.leafNode("c:h", { val: String(ml.h) });
    }
    xml.closeNode();
  }
  xml.closeNode();
}

export function renderDataTable(xml: XmlSink, dt: DataTable): void {
  xml.openNode("c:dTable");
  // Conditional, for the reason given in `renderAxis`: an unconditional default overwrites what a patched chart
  // already carried. Measured to be performance-neutral in any case — `c:varyColors` is where the cost was.
  if (dt.showHorzBorder !== undefined) {
    xml.leafNode("c:showHorzBorder", { val: dt.showHorzBorder ? "1" : "0" });
  }
  if (dt.showVertBorder !== undefined) {
    xml.leafNode("c:showVertBorder", { val: dt.showVertBorder ? "1" : "0" });
  }
  if (dt.showOutline !== undefined) {
    xml.leafNode("c:showOutline", { val: dt.showOutline ? "1" : "0" });
  }
  if (dt.showKeys !== undefined) {
    xml.leafNode("c:showKeys", { val: dt.showKeys ? "1" : "0" });
  }
  if (dt.spPr) {
    renderSpPr(xml, dt.spPr);
  }
  if (dt.txPr) {
    renderTxPr(xml, dt.txPr);
  }
  if (dt.extLst) {
    xml.writeRaw(dt.extLst);
  }
  xml.closeNode();
}

export function renderRichText(xml: XmlSink, rt: ChartRichText, tag: string): void {
  xml.openNode(tag);
  xml.openNode("c:rich");
  // Render body properties (a:bodyPr) — use structured if present, else default leaf.
  if (rt.bodyProperties) {
    renderBodyProperties(xml, rt.bodyProperties);
  } else {
    xml.leafNode("a:bodyPr");
  }
  xml.leafNode("a:lstStyle");
  let paragraphCount = 0;
  for (const p of rt.paragraphs) {
    xml.openNode("a:p");
    if (p.properties || p.runProperties) {
      renderParagraphProperties(xml, p.properties, p.runProperties);
    }
    for (const run of p.runs ?? []) {
      xml.openNode("a:r");
      if (run.properties) {
        renderRunProperties(xml, run.properties, "a:rPr");
      }
      // Emit `xml:space="preserve"` when the run text contains
      // whitespace that XML normalisation would strip: leading /
      // trailing whitespace, runs of ≥2 spaces, or any tab/newline
      // in the middle. The ChartEx renderer has the equivalent
      // guard; previously the classic `<a:t>` writer silently
      // dropped padding whitespace on round-trip of axis titles and
      // category labels that intentionally carry alignment spaces.
      const text = run.text ?? "";
      if (needsXmlSpacePreserve(text)) {
        xml.openNode("a:t", { "xml:space": "preserve" });
      } else {
        xml.openNode("a:t");
      }
      xml.writeText(text);
      xml.closeNode();
      xml.closeNode();
    }
    if (p.endParaRunProperties) {
      renderRunProperties(xml, p.endParaRunProperties, "a:endParaRPr");
    }
    xml.closeNode();
    paragraphCount++;
  }
  if (paragraphCount === 0) {
    xml.openNode("a:p");
    xml.leafNode("a:endParaRPr");
    xml.closeNode();
  }
  xml.closeNode();
  xml.closeNode();
}

export function renderBodyProperties(xml: XmlSink, bp: ChartBodyProperties): void {
  const attrs: Record<string, string> = {};
  if (bp.rotation !== undefined) {
    attrs.rot = String(bp.rotation);
  }
  if (bp.horizontalOverflow) {
    attrs.horzOverflow = bp.horizontalOverflow;
  }
  if (bp.vertical) {
    attrs.vert = bp.vertical;
  }
  if (bp.wrap) {
    attrs.wrap = bp.wrap;
  }
  if (bp.anchor) {
    attrs.anchor = bp.anchor;
  }
  xml.leafNode("a:bodyPr", Object.keys(attrs).length > 0 ? attrs : undefined);
}

export function renderParagraphProperties(
  xml: XmlSink,
  pPr: ChartParagraphProperties | undefined,
  legacyDefRPr: ChartTextProperties | undefined
): void {
  const attrs: Record<string, string> = {};
  if (pPr?.alignment) {
    attrs.algn = pPr.alignment;
  }
  if (pPr?.indent !== undefined) {
    attrs.indent = String(pPr.indent);
  }
  if (pPr?.marginLeft !== undefined) {
    attrs.marL = String(pPr.marginLeft);
  }
  if (pPr?.marginRight !== undefined) {
    attrs.marR = String(pPr.marginRight);
  }
  if (pPr?.level !== undefined) {
    attrs.lvl = String(pPr.level);
  }

  const defRPr = pPr?.defaultRunProperties ?? legacyDefRPr;
  const hasChildren = !!(
    pPr?.lineSpacing ||
    pPr?.spaceBefore ||
    pPr?.spaceAfter ||
    pPr?.bullet ||
    defRPr
  );

  if (!hasChildren) {
    xml.leafNode("a:pPr", Object.keys(attrs).length > 0 ? attrs : undefined);
    return;
  }

  xml.openNode("a:pPr", Object.keys(attrs).length > 0 ? attrs : undefined);
  if (pPr?.lineSpacing) {
    xml.openNode("a:lnSpc");
    renderSpacing(xml, pPr.lineSpacing);
    xml.closeNode();
  }
  if (pPr?.spaceBefore) {
    xml.openNode("a:spcBef");
    renderSpacing(xml, pPr.spaceBefore);
    xml.closeNode();
  }
  if (pPr?.spaceAfter) {
    xml.openNode("a:spcAft");
    renderSpacing(xml, pPr.spaceAfter);
    xml.closeNode();
  }
  if (pPr?.bullet) {
    const b = pPr.bullet;
    if (b.type === "none") {
      xml.leafNode("a:buNone");
    } else if (b.type === "char") {
      xml.leafNode("a:buChar", { char: b.character });
    } else if (b.type === "autoNum") {
      const bAttrs: Record<string, string> = { type: b.scheme };
      if (b.startAt !== undefined) {
        bAttrs.startAt = String(b.startAt);
      }
      xml.leafNode("a:buAutoNum", bAttrs);
    }
  }
  if (defRPr) {
    renderRunProperties(xml, defRPr, "a:defRPr");
  }
  xml.closeNode();
}

export function renderSpacing(xml: XmlSink, s: ChartLineSpacing): void {
  if (s.type === "percentage") {
    xml.leafNode("a:spcPct", { val: String(s.value) });
  } else {
    xml.leafNode("a:spcPts", { val: String(s.value) });
  }
}

export function renderRunProperties(xml: XmlSink, props: ChartTextProperties, tag: string): void {
  if (props._rawXml) {
    // Rewrite the outer element name to match the target tag before
    // emitting the raw bytes. The parser captures run properties
    // under whatever element it found (`<a:defRPr>` on paragraph
    // defaults, `<a:rPr>` inside `<a:r>`, `<a:endParaRPr>` after the
    // final run); the caller passes a target tag that may differ
    // from the captured one (e.g. restyling a paragraph default as a
    // per-run property). Previously the function emitted the bytes
    // verbatim — producing schema-invalid output when the target tag
    // was `a:endParaRPr` but the bytes were `<a:defRPr>…</a:defRPr>`,
    // or a `<a:defRPr>` appearing where the writer asked for `<a:rPr>`.
    const raw = props._rawXml;
    const openRe = /<a:(?:defRPr|rPr|endParaRPr)\b([^>]*)(\/?)>/;
    const closeRe = /<\/a:(?:defRPr|rPr|endParaRPr)>/;
    const openMatch = openRe.exec(raw);
    if (!openMatch) {
      // Captured bytes aren't a recognisable run-properties element.
      // Drop to the structured path below so we don't emit garbage.
    } else {
      const attrs = openMatch[1] ?? "";
      const selfClosing = openMatch[2] === "/";
      const stripNamespace = tag.replace(/^a:/, "");
      const targetTag = `a:${stripNamespace}`;
      if (selfClosing) {
        xml.writeRaw(`<${targetTag}${attrs}/>`);
        return;
      }
      const closeMatch = closeRe.exec(raw);
      if (closeMatch) {
        const inner = raw.slice(openMatch.index + openMatch[0].length, closeMatch.index);
        xml.writeRaw(`<${targetTag}${attrs}>${inner}</${targetTag}>`);
        return;
      }
      // Malformed — fall through to structured path.
    }
  }
  const attrs: Record<string, string> = {};
  if (props.size !== undefined) {
    attrs.sz = String(props.size);
  }
  if (props.bold !== undefined) {
    attrs.b = props.bold ? "1" : "0";
  }
  if (props.italic !== undefined) {
    attrs.i = props.italic ? "1" : "0";
  }
  if (props.underline !== undefined) {
    // Accept boolean shorthand: true -> "sng", false -> "none"
    if (typeof props.underline === "boolean") {
      attrs.u = props.underline ? "sng" : "none";
    } else {
      attrs.u = props.underline;
    }
  }
  if (props.strike) {
    attrs.strike = props.strike;
  }
  // NOTE: `ChartTextProperties.rotation` intentionally does NOT
  // contribute to run-property attributes. `rot` is a member of
  // `CT_TextBodyProperties` (`<a:bodyPr>`) — it has no schema slot
  // on `CT_TextCharacterProperties` (`<a:rPr>` / `<a:defRPr>` /
  // `<a:endParaRPr>`). Emitting it here used to produce
  // `<a:defRPr rot="-2700000"/>` which Microsoft Excel's strict
  // loader rejects as "We found a problem with some content"
  // (no repair dialog). `_renderTxPr` already writes rotation to
  // the correct element on the enclosing `<a:bodyPr>`.
  if (props.baseline !== undefined) {
    attrs.baseline = String(props.baseline);
  }
  if (props.kern !== undefined) {
    attrs.kern = String(props.kern);
  }
  if (props.spacing !== undefined) {
    attrs.spc = String(props.spacing);
  }
  if (props.cap) {
    attrs.cap = props.cap;
  }
  if (props.lang) {
    attrs.lang = props.lang;
  }

  const hasChildren = !!(
    props.color ||
    props.fontFamily ||
    props.eastAsianFamily ||
    props.complexScriptFamily
  );
  if (!hasChildren) {
    xml.leafNode(tag, Object.keys(attrs).length > 0 ? attrs : undefined);
    return;
  }

  xml.openNode(tag, attrs);
  if (props.color) {
    xml.openNode("a:solidFill");
    renderColor(xml, props.color);
    xml.closeNode();
  }
  if (props.fontFamily) {
    xml.leafNode("a:latin", { typeface: props.fontFamily });
  }
  if (props.eastAsianFamily) {
    xml.leafNode("a:ea", { typeface: props.eastAsianFamily });
  }
  if (props.complexScriptFamily) {
    xml.leafNode("a:cs", { typeface: props.complexScriptFamily });
  }
  xml.closeNode();
}

// ---- Shape Properties (simplified + raw XML) ----

export function renderSpPr(xml: XmlSink, spPr: ShapeProperties): void {
  // Emit raw XML only when the model is a pure raw-capture — i.e.
  // `_rawXml` is present AND no structured field has been set. If
  // the caller assigned `spPr.fill = {...}` directly (without going
  // through `setSpPrFill`, which clears `_rawXml`), the stale raw
  // bytes are stale and the structured writer must win. Previously
  // this check was `if (spPr._rawXml)` — so any direct mutation of
  // a loaded chart's spPr was silently dropped on save.
  if (isRawXmlShape(spPr)) {
    xml.writeRaw(spPr._rawXml!);
    return;
  }

  xml.openNode("c:spPr");
  // Per DrawingML §20.1.2.2.35 (CT_ShapeProperties), child order is:
  // xfrm? → (prstGeom | custGeom)? → (fill)? → ln? → effectLst|effectDag? →
  // scene3d? → sp3d? → extLst?. We emit in that order so round-trip
  // through `parseSpPr → buildSpPr` re-serialises to valid OOXML.
  if (spPr.transform) {
    renderShapeTransform(xml, spPr.transform);
  }
  if (spPr.presetGeometry) {
    renderPresetGeometry(xml, spPr.presetGeometry);
  } else if (spPr.customGeometry) {
    renderCustomGeometry(xml, spPr.customGeometry);
  }
  if (spPr.fill) {
    if (spPr.fill.noFill) {
      xml.leafNode("a:noFill");
    } else if (spPr.fill.solid) {
      xml.openNode("a:solidFill");
      renderColor(xml, spPr.fill.solid);
      xml.closeNode();
    } else if (spPr.fill.gradient) {
      const g = spPr.fill.gradient;
      if (g.stops.length >= 2) {
        xml.openNode("a:gradFill");
        xml.openNode("a:gsLst");
        for (const stop of g.stops) {
          // OOXML `<a:gs pos>` encodes position as hundredths of a
          // percent (0–100000), NOT thousandths. The previous writer
          // used ×1000 — emitting `pos="1000"` for a 100% stop, which
          // schema-validating readers treat as 1%. Matching fix lives
          // in `chart-ex-renderer.ts` and the gradient parser in
          // `shape-properties.ts`.
          const encoded = Math.max(0, Math.min(100000, Math.round(stop.position * 100000)));
          xml.openNode("a:gs", { pos: String(encoded) });
          renderColor(xml, stop.color);
          xml.closeNode();
        }
        xml.closeNode();
        if (g.type === "linear" || g.type === undefined) {
          // `<a:lin ang>` is in 60000ths of a degree. `Math.round`
          // keeps the attribute an integer even for fractional
          // degrees passed through the structured model.
          //
          // `scaled` is only emitted when the author explicitly set
          // it — leaving it absent lets DrawingML apply the implicit
          // default (`scaled="1"`). Unconditionally writing
          // `scaled="1"` previously overwrote a parsed `scaled="0"`
          // on round-trip, silently toggling whether the angle
          // scales with the shape's aspect ratio.
          const angleEmu = Math.round((g.angle ?? 0) * 60000);
          const linAttrs: Record<string, string> = { ang: String(angleEmu) };
          if (g.scaled !== undefined) {
            linAttrs.scaled = g.scaled ? "1" : "0";
          }
          xml.leafNode("a:lin", linAttrs);
        } else if (g.type === "circle" || g.type === "rect" || g.type === "shape") {
          // Path gradient with optional focal rectangle. Preserve
          // parsed `fillToRect` so off-centre radial gradients
          // round-trip; fall back to Excel's centred default.
          // `CT_FillToRectangle` sides are `ST_Percentage` — the
          // full signed range is legal; don't clamp to `[0, 100000]`
          // or off-centre focal points get lost on re-save.
          const rect = g.fillToRect;
          const pct = (v: number | undefined, def: number): number => {
            if (v === undefined) {
              return def;
            }
            return Math.round(v * 100000);
          };
          xml.openNode("a:path", { path: g.type });
          xml.leafNode("a:fillToRect", {
            l: String(pct(rect?.left, 50000)),
            t: String(pct(rect?.top, 50000)),
            r: String(pct(rect?.right, 50000)),
            b: String(pct(rect?.bottom, 50000))
          });
          xml.closeNode();
        }
        xml.closeNode();
      }
    } else if (spPr.fill.pattern) {
      const p = spPr.fill.pattern;
      xml.openNode("a:pattFill", { prst: p.preset });
      if (p.foreground) {
        xml.openNode("a:fgClr");
        renderColor(xml, p.foreground);
        xml.closeNode();
      }
      if (p.background) {
        xml.openNode("a:bgClr");
        renderColor(xml, p.background);
        xml.closeNode();
      }
      xml.closeNode();
    } else if (spPr.fill.blip?.relationshipId) {
      // Picture fill. The rel id was allocated during
      // worksheet._registerChart (see chart-images.ts); by the time
      // the writer runs it is always a concrete `rIdN`. When the id
      // is missing we skip the element entirely rather than emit a
      // broken `<a:blip r:embed="">` — the caller kept their
      // pictureOptions, so the chart still opens correctly.
      renderBlipFill(xml, spPr.fill.blip);
    }
  }
  if (spPr.line) {
    const lnAttrs: Record<string, string> = {};
    if (spPr.line.width) {
      lnAttrs.w = String(spPr.line.width);
    }
    if (spPr.line.cap) {
      lnAttrs.cap = spPr.line.cap;
    }
    if (spPr.line.compound) {
      lnAttrs.cmpd = spPr.line.compound;
    }
    xml.openNode("a:ln", Object.keys(lnAttrs).length > 0 ? lnAttrs : undefined);
    if (spPr.line.noFill) {
      xml.leafNode("a:noFill");
    } else if (spPr.line.color) {
      xml.openNode("a:solidFill");
      renderColor(xml, spPr.line.color);
      xml.closeNode();
    }
    if (spPr.line.dash) {
      xml.leafNode("a:prstDash", { val: spPr.line.dash });
    }
    if (spPr.line.join) {
      if (spPr.line.join === "round") {
        xml.leafNode("a:round");
      } else if (spPr.line.join === "bevel") {
        xml.leafNode("a:bevel");
      } else if (spPr.line.join === "miter") {
        xml.leafNode("a:miter");
      }
    }
    xml.closeNode();
  }
  if (spPr.effectList) {
    renderEffectList(xml, spPr.effectList);
  }
  if (spPr.scene3d) {
    renderScene3D(xml, spPr.scene3d);
  }
  if (spPr.sp3d) {
    renderSp3D(xml, spPr.sp3d);
  }
  xml.closeNode();
}

/**
 * Emit `<a:xfrm>` with optional `@rot` / `@flipH` / `@flipV` attributes
 * and nested `<a:off>` / `<a:ext>`. Matches what `parseSpPr` captures in
 * `shape-properties.ts`.
 */
export function renderShapeTransform(xml: XmlSink, transform: ShapeTransform): void {
  const attrs: Record<string, string> = {};
  if (transform.rotation !== undefined && transform.rotation !== 0) {
    attrs.rot = String(transform.rotation);
  }
  if (transform.flipHorizontal) {
    attrs.flipH = "1";
  }
  if (transform.flipVertical) {
    attrs.flipV = "1";
  }
  const hasOff = transform.offsetX !== undefined || transform.offsetY !== undefined;
  const hasExt = transform.width !== undefined || transform.height !== undefined;
  if (!hasOff && !hasExt && Object.keys(attrs).length === 0) {
    // Nothing meaningful to emit.
    return;
  }
  if (!hasOff && !hasExt) {
    xml.leafNode("a:xfrm", attrs);
    return;
  }
  xml.openNode("a:xfrm", Object.keys(attrs).length > 0 ? attrs : undefined);
  if (hasOff) {
    xml.leafNode("a:off", {
      x: String(transform.offsetX ?? 0),
      y: String(transform.offsetY ?? 0)
    });
  }
  if (hasExt) {
    xml.leafNode("a:ext", {
      cx: String(transform.width ?? 0),
      cy: String(transform.height ?? 0)
    });
  }
  xml.closeNode();
}

/**
 * Emit `<a:prstGeom prst="…"><a:avLst>…</a:avLst></a:prstGeom>`. The
 * `a:avLst` wrapper is always written (even when empty) to match Excel's
 * own output; adjustments are optional inside.
 */
export function renderPresetGeometry(xml: XmlSink, geom: PresetGeometry): void {
  xml.openNode("a:prstGeom", { prst: geom.preset });
  xml.openNode("a:avLst");
  for (const adj of geom.adjustments ?? []) {
    xml.leafNode("a:gd", { name: adj.name, fmla: adj.fmla });
  }
  xml.closeNode();
  xml.closeNode();
}

/**
 * Emit `<a:custGeom>` with its adjustments list and the `<a:pathLst>`
 * command stream. Commands map 1:1 to the DrawingML path command set
 * (`moveTo` / `lnTo` / `arcTo` / `cubicBezTo` / `quadBezTo` / `close`);
 * `arcTo` carries its parameters as attributes instead of control
 * points, matching the parser.
 */
export function renderCustomGeometry(xml: XmlSink, geom: CustomGeometry): void {
  xml.openNode("a:custGeom");
  xml.openNode("a:avLst");
  for (const adj of geom.adjustments ?? []) {
    xml.leafNode("a:gd", { name: adj.name, fmla: adj.fmla });
  }
  xml.closeNode();
  // `a:gdLst`, `a:ahLst`, `a:cxnLst`, `a:rect` are omitted here — the
  // parser does not consume them and the round-trip path is dominated
  // by `_rawXml` for geometry-heavy shapes.
  xml.openNode("a:pathLst");
  for (const path of geom.paths ?? []) {
    const pathAttrs: Record<string, string> = {};
    if (path.w !== undefined) {
      pathAttrs.w = String(path.w);
    }
    if (path.h !== undefined) {
      pathAttrs.h = String(path.h);
    }
    if (path.fill !== undefined) {
      pathAttrs.fill = path.fill;
    }
    if (path.stroke !== undefined) {
      pathAttrs.stroke = path.stroke ? "1" : "0";
    }
    xml.openNode("a:path", Object.keys(pathAttrs).length > 0 ? pathAttrs : undefined);
    for (const cmd of path.commands) {
      renderCustomGeometryCommand(xml, cmd);
    }
    xml.closeNode();
  }
  xml.closeNode();
  xml.closeNode();
}

export function renderCustomGeometryCommand(xml: XmlSink, cmd: CustomGeometryCommand): void {
  if (cmd.type === "close") {
    xml.leafNode("a:close");
    return;
  }
  if (cmd.type === "arcTo") {
    const p = cmd.arcParams;
    if (!p) {
      return;
    }
    xml.leafNode("a:arcTo", {
      wR: String(p.wR),
      hR: String(p.hR),
      stAng: String(p.stAng),
      swAng: String(p.swAng)
    });
    return;
  }
  const tag =
    cmd.type === "moveTo"
      ? "a:moveTo"
      : cmd.type === "lnTo"
        ? "a:lnTo"
        : cmd.type === "cubicBezTo"
          ? "a:cubicBezTo"
          : "a:quadBezTo";
  xml.openNode(tag);
  for (const point of cmd.points ?? []) {
    xml.leafNode("a:pt", { x: String(point.x), y: String(point.y) });
  }
  xml.closeNode();
}

/**
 * Render an `<a:blipFill>` element for a picture fill. The element is
 * `<a:blipFill><a:blip r:embed="rIdN"/>[<a:srcRect …/>]<a:stretch …>
 * or <a:tile …></a:blipFill>` matching the OOXML shape-fill subschema
 * (DrawingML §20.1.8.14).
 *
 * Callers are responsible for making sure `blip.relationshipId` is
 * populated — the writer no-ops when it is missing (see the comment
 * at the call site in `_renderSpPr`).
 */
export function renderBlipFill(xml: XmlSink, blip: ChartBlipFill): void {
  xml.openNode("a:blipFill");
  xml.leafNode("a:blip", { "r:embed": blip.relationshipId! });
  if (blip.sourceRectangle) {
    const sr = blip.sourceRectangle;
    const attrs: Record<string, string> = {};
    if (sr.left !== undefined) {
      attrs.l = String(sr.left);
    }
    if (sr.top !== undefined) {
      attrs.t = String(sr.top);
    }
    if (sr.right !== undefined) {
      attrs.r = String(sr.right);
    }
    if (sr.bottom !== undefined) {
      attrs.b = String(sr.bottom);
    }
    xml.leafNode("a:srcRect", Object.keys(attrs).length > 0 ? attrs : undefined);
  }
  if (blip.fillMode === "tile") {
    const t = blip.tile ?? {};
    const tileAttrs: Record<string, string> = {};
    if (t.tx !== undefined) {
      tileAttrs.tx = String(t.tx);
    }
    if (t.ty !== undefined) {
      tileAttrs.ty = String(t.ty);
    }
    if (t.sx !== undefined) {
      tileAttrs.sx = String(t.sx);
    }
    if (t.sy !== undefined) {
      tileAttrs.sy = String(t.sy);
    }
    if (t.flip) {
      tileAttrs.flip = t.flip;
    }
    if (t.alignment) {
      tileAttrs.algn = t.alignment;
    }
    xml.leafNode("a:tile", Object.keys(tileAttrs).length > 0 ? tileAttrs : undefined);
  } else if (blip.fillMode !== "none") {
    // Default and "stretch" produce a fillRect-stretch.
    xml.openNode("a:stretch");
    xml.leafNode("a:fillRect");
    xml.closeNode();
  }
  xml.closeNode();
}

export function renderEffectList(xml: XmlSink, effects: EffectList): void {
  xml.openNode("a:effectLst");
  // DrawingML `CT_EffectList` declares a strict `<xsd:sequence>`:
  //   blur → fillOverlay → glow → innerShdw → outerShdw → prstShdw →
  //   reflection → softEdge.
  // The previous emission order (blur → outerShdw → innerShdw →
  // prstShdw → glow → softEdge → reflection) was accepted by Excel
  // but rejected by strict validators (`ooxml-validate`, LibreOffice
  // strict mode). Keep this ordering in sync with
  // `chart-ex-renderer.ts:renderEffectList`. `fillOverlay` is not
  // modelled yet and its slot is intentionally empty.
  if (effects.blur) {
    const attrs: Record<string, string> = {};
    if (effects.blur.radius !== undefined) {
      attrs.rad = String(effects.blur.radius);
    }
    if (effects.blur.grow) {
      attrs.grow = "1";
    }
    xml.leafNode("a:blur", Object.keys(attrs).length > 0 ? attrs : undefined);
  }
  // fillOverlay — reserved slot per schema, not currently modelled.
  if (effects.glow) {
    xml.openNode("a:glow", { rad: String(effects.glow.radius) });
    renderColor(xml, effects.glow.color);
    xml.closeNode();
  }
  if (effects.innerShadow) {
    renderShadowElement(xml, "a:innerShdw", effects.innerShadow);
  }
  if (effects.outerShadow) {
    renderShadowElement(xml, "a:outerShdw", effects.outerShadow);
  }
  if (effects.presetShadow) {
    const ps = effects.presetShadow;
    const attrs: Record<string, string> = { prst: ps.preset };
    if (ps.distance !== undefined) {
      attrs.dist = String(ps.distance);
    }
    if (ps.direction !== undefined) {
      attrs.dir = String(ps.direction);
    }
    xml.openNode("a:prstShdw", attrs);
    if (ps.color) {
      renderColor(xml, ps.color);
    }
    xml.closeNode();
  }
  if (effects.reflection) {
    const r = effects.reflection;
    const attrs: Record<string, string> = {};
    if (r.blurRadius !== undefined) {
      attrs.blurRad = String(r.blurRadius);
    }
    if (r.startOpacity !== undefined) {
      attrs.stA = String(r.startOpacity);
    }
    if (r.startPosition !== undefined) {
      attrs.stPos = String(r.startPosition);
    }
    if (r.endOpacity !== undefined) {
      attrs.endA = String(r.endOpacity);
    }
    if (r.endPosition !== undefined) {
      attrs.endPos = String(r.endPosition);
    }
    if (r.distance !== undefined) {
      attrs.dist = String(r.distance);
    }
    if (r.direction !== undefined) {
      attrs.dir = String(r.direction);
    }
    if (r.fadeDirection !== undefined) {
      attrs.fadeDir = String(r.fadeDirection);
    }
    if (r.scaleHorizontal !== undefined) {
      attrs.sx = String(r.scaleHorizontal);
    }
    if (r.scaleVertical !== undefined) {
      attrs.sy = String(r.scaleVertical);
    }
    if (r.skewHorizontal !== undefined) {
      attrs.kx = String(r.skewHorizontal);
    }
    if (r.skewVertical !== undefined) {
      attrs.ky = String(r.skewVertical);
    }
    if (r.alignment) {
      attrs.algn = r.alignment;
    }
    if (r.rotateWithShape) {
      attrs.rotWithShape = "1";
    }
    xml.leafNode("a:reflection", attrs);
  }
  if (effects.softEdge) {
    xml.leafNode("a:softEdge", { rad: String(effects.softEdge.radius) });
  }
  xml.closeNode();
}

export function renderShadowElement(xml: XmlSink, tag: string, shadow: Shadow): void {
  const attrs: Record<string, string> = {};
  if (shadow.blurRadius !== undefined) {
    attrs.blurRad = String(shadow.blurRadius);
  }
  if (shadow.distance !== undefined) {
    attrs.dist = String(shadow.distance);
  }
  if (shadow.direction !== undefined) {
    attrs.dir = String(shadow.direction);
  }
  if (shadow.alignment) {
    attrs.algn = shadow.alignment;
  }
  if (shadow.rotateWithShape) {
    attrs.rotWithShape = "1";
  }
  if (shadow.scaleHorizontal !== undefined) {
    attrs.sx = String(shadow.scaleHorizontal);
  }
  if (shadow.scaleVertical !== undefined) {
    attrs.sy = String(shadow.scaleVertical);
  }
  if (shadow.skewHorizontal !== undefined) {
    attrs.kx = String(shadow.skewHorizontal);
  }
  if (shadow.skewVertical !== undefined) {
    attrs.ky = String(shadow.skewVertical);
  }
  xml.openNode(tag, attrs);
  renderColor(xml, shadow.color);
  xml.closeNode();
}

export function renderScene3D(xml: XmlSink, scene: Scene3D): void {
  xml.openNode("a:scene3d");
  if (scene.camera) {
    const cam = scene.camera;
    const attrs: Record<string, string> = { prst: cam.preset };
    if (cam.fov !== undefined) {
      attrs.fov = String(cam.fov);
    }
    if (cam.zoom !== undefined) {
      attrs.zoom = String(cam.zoom);
    }
    if (cam.rotation) {
      xml.openNode("a:camera", attrs);
      xml.leafNode("a:rot", {
        lat: String(cam.rotation.lat),
        lon: String(cam.rotation.lon),
        rev: String(cam.rotation.rev)
      });
      xml.closeNode();
    } else {
      xml.leafNode("a:camera", attrs);
    }
  }
  if (scene.lightRig) {
    const lr = scene.lightRig;
    const attrs: Record<string, string> = { rig: lr.rig, dir: lr.direction };
    if (lr.rotation) {
      xml.openNode("a:lightRig", attrs);
      xml.leafNode("a:rot", {
        lat: String(lr.rotation.lat),
        lon: String(lr.rotation.lon),
        rev: String(lr.rotation.rev)
      });
      xml.closeNode();
    } else {
      xml.leafNode("a:lightRig", attrs);
    }
  }
  xml.closeNode();
}

export function renderSp3D(xml: XmlSink, sp3d: ShapeProperties3D): void {
  const attrs: Record<string, string> = {};
  if (sp3d.z !== undefined) {
    attrs.z = String(sp3d.z);
  }
  if (sp3d.extrusionHeight !== undefined) {
    attrs.extrusionH = String(sp3d.extrusionHeight);
  }
  if (sp3d.contourWidth !== undefined) {
    attrs.contourW = String(sp3d.contourWidth);
  }
  if (sp3d.material) {
    attrs.prstMaterial = sp3d.material;
  }
  const hasChildren = !!(
    sp3d.bevelTop ||
    sp3d.bevelBottom ||
    sp3d.extrusionColor ||
    sp3d.contourColor
  );
  if (!hasChildren) {
    xml.leafNode("a:sp3d", attrs);
    return;
  }
  xml.openNode("a:sp3d", attrs);
  if (sp3d.bevelTop) {
    const b = sp3d.bevelTop;
    const bAttrs: Record<string, string> = {};
    if (b.width !== undefined) {
      bAttrs.w = String(b.width);
    }
    if (b.height !== undefined) {
      bAttrs.h = String(b.height);
    }
    if (b.preset) {
      bAttrs.prst = b.preset;
    }
    xml.leafNode("a:bevelT", bAttrs);
  }
  if (sp3d.bevelBottom) {
    const b = sp3d.bevelBottom;
    const bAttrs: Record<string, string> = {};
    if (b.width !== undefined) {
      bAttrs.w = String(b.width);
    }
    if (b.height !== undefined) {
      bAttrs.h = String(b.height);
    }
    if (b.preset) {
      bAttrs.prst = b.preset;
    }
    xml.leafNode("a:bevelB", bAttrs);
  }
  if (sp3d.extrusionColor) {
    xml.openNode("a:extrusionClr");
    renderColor(xml, sp3d.extrusionColor);
    xml.closeNode();
  }
  if (sp3d.contourColor) {
    xml.openNode("a:contourClr");
    renderColor(xml, sp3d.contourColor);
    xml.closeNode();
  }
  xml.closeNode();
}

export function renderTxPr(xml: XmlSink, txPr: ChartTextProperties): void {
  if (isRawXmlTxPr(txPr)) {
    xml.writeRaw(txPr._rawXml!);
    return;
  }
  xml.openNode("c:txPr");
  // Excel's own `<a:bodyPr>` inside an axis `<c:txPr>` always carries
  // the full attribute set — `spcFirstLastPara`, `vertOverflow`,
  // `wrap`, `anchor`, `anchorCtr` — even when they mirror the schema
  // defaults. Emitting a bare `<a:bodyPr rot="-2700000"/>` (the
  // previous output) schema-validates but triggers Excel's strict
  // loader to flag the chart as "needs repair": the drawing is
  // kept but the file opens with the "we found a problem…" dialog
  // and a "Repaired Records: Drawing" entry in the repair log.
  // Verified against `tmp/reference-rotated-axis.xlsx` (Excel 2021-
  // authored) — every axis `<c:txPr>` there carries the same attr
  // bundle. Mirror that output here so a round-trip through our
  // writer is byte-compatible with Excel's own output and survives
  // the strict-loader's "drawing shape" integrity check.
  const bodyPrAttrs: Record<string, string> = {
    rot: String(txPr.rotation ?? 0),
    spcFirstLastPara: "1",
    vertOverflow: "ellipsis",
    wrap: "square",
    anchor: "ctr",
    anchorCtr: "1"
  };
  xml.leafNode("a:bodyPr", bodyPrAttrs);
  xml.leafNode("a:lstStyle");
  xml.openNode("a:p");
  xml.openNode("a:pPr");
  renderRunProperties(xml, txPr, "a:defRPr");
  xml.closeNode();
  // Every `<a:endParaRPr>` in Excel's own output carries a `lang`
  // attribute. Emitting the bare self-closing form used to leave
  // the strict loader flagging the chart as repairable even when
  // the rest of the structure was clean. "en-US" matches Excel's
  // factory default; callers that need a different locale can
  // route through `_rawXml` on `ChartTextProperties`.
  xml.leafNode("a:endParaRPr", { lang: "en-US" });
  xml.closeNode();
  xml.closeNode();
}

export function renderColor(xml: XmlSink, color: ChartColor): void {
  // Children shared across all five DrawingML colour-element kinds
  // (srgbClr, schemeClr, sysClr, schemeClr-by-name, prstClr). Rather
  // than duplicating the guard + emission logic in every branch,
  // route through these two helpers.
  //
  // `hasModifiers` avoids the pathological
  // `<a:srgbClr val="…"></a:srgbClr>` output (invalid child count);
  // `emitModifiers` enforces:
  //   1. Fields stored as OOXML integers (`alpha`, `shade`, `satMod`,
  //      `lumMod`, `lumOff`) round to guard against `NaN.toString()`
  //      producing `"NaN"` in attribute values (strict readers reject).
  //   2. `tint` is a fraction in 0..1 per `ChartColor.tint` contract;
  //      multiply by 100000. Negative `tint` on `schemeClr` is a
  //      known Excel-UI convention for "darken by |tint|"; map to
  //      `<a:shade>` exactly as the existing code did.
  const hasModifiers = (c: ChartColor): boolean =>
    c.alpha !== undefined ||
    c.tint !== undefined ||
    c.lumMod !== undefined ||
    c.lumOff !== undefined ||
    c.shade !== undefined ||
    c.satMod !== undefined;
  const emitInt = (tag: string, value: number | undefined): void => {
    if (value === undefined || !Number.isFinite(value)) {
      return;
    }
    xml.leafNode(tag, { val: String(Math.round(value)) });
  };
  const emitModifiers = (c: ChartColor, tintAsShade: boolean = false): void => {
    emitInt("a:alpha", c.alpha);
    let tintEmittedShade = false;
    if (c.tint !== undefined && Number.isFinite(c.tint)) {
      if (tintAsShade && c.tint < 0) {
        // Legacy scheme-colour convention: negative tint → equivalent
        // shade. `(1 + tint) * 100000` lives on the 0..100000 range
        // for tint ∈ [-1, 0].
        xml.leafNode("a:shade", { val: String(Math.round((1 + c.tint) * 100000)) });
        tintEmittedShade = true;
      } else {
        xml.leafNode("a:tint", { val: String(Math.round(c.tint * 100000)) });
      }
    }
    emitInt("a:lumMod", c.lumMod);
    emitInt("a:lumOff", c.lumOff);
    if (!tintEmittedShade) {
      emitInt("a:shade", c.shade);
    }
    emitInt("a:satMod", c.satMod);
  };

  if (color.srgb) {
    const attrs: Record<string, string> = { val: color.srgb };
    if (!hasModifiers(color)) {
      xml.leafNode("a:srgbClr", attrs);
    } else {
      xml.openNode("a:srgbClr", attrs);
      emitModifiers(color);
      xml.closeNode();
    }
  } else if (color.theme !== undefined) {
    const name = themeIndexToName(color.theme);
    if (!hasModifiers(color)) {
      xml.leafNode("a:schemeClr", { val: name });
    } else {
      xml.openNode("a:schemeClr", { val: name });
      // Scheme-colour is the only variant that honours the negative-
      // tint-as-shade legacy mapping; the other elements don't.
      emitModifiers(color, /* tintAsShade */ true);
      xml.closeNode();
    }
  } else if (color.sysClr) {
    if (!hasModifiers(color)) {
      xml.leafNode("a:sysClr", { val: color.sysClr });
    } else {
      xml.openNode("a:sysClr", { val: color.sysClr });
      emitModifiers(color);
      xml.closeNode();
    }
  } else if (color.schemeName) {
    // Scheme-colour tokens that can't be mapped onto a theme index
    // (e.g. `phClr`, vendor extensions). Round-trip as
    // `<a:schemeClr>` rather than silently re-emitting as
    // `<a:sysClr>` (which the old parser did, but which is a
    // semantically-different DrawingML element kind).
    if (!hasModifiers(color)) {
      xml.leafNode("a:schemeClr", { val: color.schemeName });
    } else {
      xml.openNode("a:schemeClr", { val: color.schemeName });
      emitModifiers(color);
      xml.closeNode();
    }
  } else if (color.prstClr) {
    if (!hasModifiers(color)) {
      xml.leafNode("a:prstClr", { val: color.prstClr });
    } else {
      xml.openNode("a:prstClr", { val: color.prstClr });
      emitModifiers(color);
      xml.closeNode();
    }
  }
  // else: unknown / empty color — drop silently (same as before)
}

export function renderPrintSettings(xml: XmlSink, ps: PrintSettings): void {
  xml.openNode("c:printSettings");
  // Only emit `c:headerFooter` / `c:pageSetup` when the model
  // actually carries them. Previously we unconditionally wrote empty
  // `<c:headerFooter/>` / `<c:pageSetup/>` sentinels, which broke
  // byte-for-byte round-trip on files that did not originally
  // include them (and added elements Excel would gladly default,
  // inflating diffs / confusing compare tools).
  if (typeof ps.headerFooter === "string") {
    xml.writeRaw(ps.headerFooter);
  }
  if (ps.pageMargins) {
    xml.leafNode("c:pageMargins", {
      b: String(ps.pageMargins.b),
      l: String(ps.pageMargins.l),
      r: String(ps.pageMargins.r),
      t: String(ps.pageMargins.t),
      header: String(ps.pageMargins.header),
      footer: String(ps.pageMargins.footer)
    });
  }
  if (ps.pageSetup) {
    const attrs: Record<string, string> = {};
    if (ps.pageSetup.orientation) {
      attrs.orientation = ps.pageSetup.orientation;
    }
    if (ps.pageSetup.paperSize !== undefined) {
      attrs.paperSize = String(ps.pageSetup.paperSize);
    }
    xml.leafNode("c:pageSetup", Object.keys(attrs).length > 0 ? attrs : undefined);
  }
  xml.closeNode();
}
