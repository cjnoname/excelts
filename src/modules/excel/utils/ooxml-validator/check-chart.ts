/**
 * Chart / chartEx internal structure check.
 *
 * Classic charts (`xl/charts/chartN.xml`) must contain both `c:chart` and
 * `c:plotArea`. ChartEx charts must contain `cx:chart`, `cx:plotArea`
 * and at least one `cx:series`; series must carry `layoutId` and their
 * `dataId`/`axisId` back-references must resolve inside the chart.
 * `cx:externalData` nodes must refer to a declared relationship.
 *
 * In addition we catch five chartEx schema-violation patterns that
 * cause Excel 2016+ to drop the whole chartEx part with "Removed Part:
 * /xl/drawings/drawingN.xml (Drawing shape)":
 *
 *   - `<cx:series>` with more than one `<cx:dataId>` child
 *     (`CT_Series/dataId` has `maxOccurs="1"`; multi-dim series must
 *     use a single `<cx:data>` wrapper with multiple strDim/numDim).
 *   - `<cx:axisId>N</cx:axisId>`, `<cx:dataId>N</cx:dataId>`,
 *     `<cx:binCount>N</cx:binCount>`, `<cx:binSize>N</cx:binSize>`
 *     emitted as text content instead of `val="N"` attribute. The
 *     underlying types are `CT_UnsignedInteger`/`CT_Double`, which
 *     Excel's strict loader only accepts via the attribute form.
 *   - `<cx:auto/>` element anywhere in the chartEx. Auto binning is
 *     expressed by the ABSENCE of `binSize`/`binCount`, not a
 *     dedicated `<cx:auto/>` tag. The tag is schema-invalid.
 *   - `<cx:paretoLine>` child of `<cx:layoutPr>`. Not in the
 *     CT_SeriesLayoutProperties schema. A real pareto chart adds a
 *     second series with `layoutId="paretoLine"`.
 *   - `<cx:title>` with a direct `<cx:layout>` child. Title layout
 *     belongs in `extLst`-based extensions.
 */

import type { ValidationContext } from "@excel/utils/ooxml-validator/context";
import {
  attrByLocalName,
  collectDescendantsLocal,
  findChildLocal,
  findChildrenLocal,
  hasDescendantLocal,
  localName,
  matchesLocal
} from "@excel/utils/ooxml-validator/xml-utils";
import type { XmlElement } from "@xml/types";

const CHART_PATH_RE = /^xl\/charts\/chart\d+\.xml$/;
const CHARTEX_PATH_RE = /^xl\/charts\/chartEx\d+\.xml$/;

export function checkChart(ctx: ValidationContext): void {
  for (const [path, entry] of ctx.files()) {
    if (ctx.reporter.capped) {
      return;
    }
    if (entry.type === "directory") {
      continue;
    }
    if (CHART_PATH_RE.test(path)) {
      checkClassicChart(ctx, path);
    } else if (CHARTEX_PATH_RE.test(path)) {
      checkChartEx(ctx, path);
    }
  }
}

function checkClassicChart(ctx: ValidationContext, path: string): void {
  const dom = ctx.readDom(path);
  if (!dom) {
    return;
  }
  const root = dom.root;
  if (!hasDescendantLocal(root, "chart")) {
    ctx.reporter.error("chart-missing-chart", `${path}: missing c:chart`, path);
  }
  if (!hasDescendantLocal(root, "plotArea")) {
    ctx.reporter.error("chart-missing-plotArea", `${path}: missing c:plotArea`, path);
  }
  // Schema-conformance pass: verifies child-element order, required
  // child counts, enumerated attribute values and numeric ranges
  // against ECMA-376 Part 1 §21.2.x / Microsoft OpenXML SDK
  // ChildElementInfo. See the tables below.
  checkClassicChartSchema(ctx, path, root);
}

// -----------------------------------------------------------------------------
// Classic chart ECMA-376 schema conformance
// -----------------------------------------------------------------------------

/**
 * ECMA-376 Part 1 § 21.2.x complex types encode each chart element's
 * child sequence as `<xsd:sequence>`. OOXML readers (Excel being the
 * strictest) reject — or silently repair — elements whose children
 * appear in the wrong order. The tables below capture the canonical
 * order for every element the writer emits.
 *
 * Elements inside an `<xsd:choice maxOccurs="unbounded">` group can
 * legally appear in any order relative to siblings in the same group;
 * such groups are collapsed to a single logical "bucket" in
 * {@link ClassicOrderRule.choiceGroups}. `c:plotArea` is the one
 * place where this matters (chart-type elements and axis elements
 * each form a choice group).
 */
interface ClassicOrderRule {
  /** Parent element local name (namespace prefix stripped). */
  parent: string;
  /** Canonical child sequence, local names only. */
  order: string[];
  /**
   * Sets of child names that form an `<xsd:choice>` group — their
   * relative order inside the parent is unconstrained. Each tag in a
   * group maps to the same rank when comparing positions.
   */
  choiceGroups?: string[][];
  /**
   * Whether `order` is the *complete* set of permitted children, so a child outside it is an error rather
   * than something to skip.
   *
   * Off by default, and deliberately opt-in: the order check must stay tolerant of extension elements and of
   * children this table has not enumerated, or it would report a healthy file. But for a type whose content
   * model is short and closed, silence is the wrong answer — a `<c:overlay>` inside `<c:dispUnitsLbl>` ranked
   * -1, was skipped as "not in the table", and shipped in a file Excel repaired while this validator reported
   * zero problems.
   */
  closed?: boolean;
}

const CT_CHART_TYPE_TAGS = [
  "areaChart",
  "area3DChart",
  "lineChart",
  "line3DChart",
  "stockChart",
  "radarChart",
  "scatterChart",
  "pieChart",
  "pie3DChart",
  "doughnutChart",
  "barChart",
  "bar3DChart",
  "ofPieChart",
  "surfaceChart",
  "surface3DChart",
  "bubbleChart"
];

const CT_AXIS_TAGS = ["catAx", "valAx", "dateAx", "serAx"];

const CLASSIC_ORDER_RULES: ClassicOrderRule[] = [
  // CT_ChartSpace (§21.2.2.29)
  {
    parent: "chartSpace",
    order: [
      "lang",
      "roundedCorners",
      "style",
      "clrMapOvr",
      "pivotSource",
      "protection",
      "chart",
      "spPr",
      "txPr",
      "externalData",
      "printSettings",
      "userShapes",
      "extLst"
    ]
  },
  // CT_Chart (§21.2.2.27)
  {
    parent: "chart",
    order: [
      "title",
      "autoTitleDeleted",
      "pivotFmts",
      "view3D",
      "floor",
      "sideWall",
      "backWall",
      "plotArea",
      "legend",
      "plotVisOnly",
      "dispBlanksAs",
      "showDLblsOverMax",
      "extLst"
    ]
  },
  // CT_PlotArea (§21.2.2.145). Two `<xsd:choice maxOccurs="unbounded">`
  // groups — chart-type elements and axis elements — collapse into
  // bucket placeholders.
  {
    parent: "plotArea",
    order: ["layout", "__CHART_TYPES__", "__AXES__", "dTable", "spPr", "extLst"],
    choiceGroups: [CT_CHART_TYPE_TAGS, CT_AXIS_TAGS]
  },
  // CT_DLbls (§21.2.2.49) — the biggest historical offender.
  // Separator MUST come before showLeaderLines / leaderLines.
  {
    parent: "dLbls",
    order: [
      "dLbl",
      "delete",
      "numFmt",
      "spPr",
      "txPr",
      "dLblPos",
      "showLegendKey",
      "showVal",
      "showCatName",
      "showSerName",
      "showPercent",
      "showBubbleSize",
      "separator",
      "showLeaderLines",
      "leaderLines",
      "extLst"
    ]
  },
  // CT_DLbl (§21.2.2.47). The `delete` branch is mutually exclusive
  // with the display-flag branch but we allow the tag here for
  // ordering purposes; the choice violation is caught separately by
  // `checkClassicDLblChoice` below.
  {
    parent: "dLbl",
    order: [
      "idx",
      "delete",
      "layout",
      "tx",
      "numFmt",
      "spPr",
      "txPr",
      "dLblPos",
      "showLegendKey",
      "showVal",
      "showCatName",
      "showSerName",
      "showPercent",
      "showBubbleSize",
      "separator",
      "extLst"
    ]
  },
  // CT_Scaling (§21.2.2.195). `max` precedes `min`.
  { parent: "scaling", order: ["logBase", "orientation", "max", "min", "extLst"] },
  // CT_CatAx (§21.2.2.25)
  {
    parent: "catAx",
    order: [
      "axId",
      "scaling",
      "delete",
      "axPos",
      "majorGridlines",
      "minorGridlines",
      "title",
      "numFmt",
      "majorTickMark",
      "minorTickMark",
      "tickLblPos",
      "spPr",
      "txPr",
      "crossAx",
      "crosses",
      "crossesAt",
      "auto",
      "lblAlgn",
      "lblOffset",
      "tickLblSkip",
      "tickMarkSkip",
      "noMultiLvlLbl",
      "extLst"
    ]
  },
  // CT_ValAx (§21.2.2.226)
  {
    parent: "valAx",
    order: [
      "axId",
      "scaling",
      "delete",
      "axPos",
      "majorGridlines",
      "minorGridlines",
      "title",
      "numFmt",
      "majorTickMark",
      "minorTickMark",
      "tickLblPos",
      "spPr",
      "txPr",
      "crossAx",
      "crosses",
      "crossesAt",
      "crossBetween",
      "majorUnit",
      "minorUnit",
      "dispUnits",
      "extLst"
    ]
  },
  // CT_DateAx (§21.2.2.39)
  {
    parent: "dateAx",
    order: [
      "axId",
      "scaling",
      "delete",
      "axPos",
      "majorGridlines",
      "minorGridlines",
      "title",
      "numFmt",
      "majorTickMark",
      "minorTickMark",
      "tickLblPos",
      "spPr",
      "txPr",
      "crossAx",
      "crosses",
      "crossesAt",
      "auto",
      "lblOffset",
      "baseTimeUnit",
      "majorUnit",
      "majorTimeUnit",
      "minorUnit",
      "minorTimeUnit",
      "extLst"
    ]
  },
  // CT_SerAx (§21.2.2.175)
  {
    parent: "serAx",
    order: [
      "axId",
      "scaling",
      "delete",
      "axPos",
      "majorGridlines",
      "minorGridlines",
      "title",
      "numFmt",
      "majorTickMark",
      "minorTickMark",
      "tickLblPos",
      "spPr",
      "txPr",
      "crossAx",
      "crosses",
      "crossesAt",
      "tickLblSkip",
      "tickMarkSkip",
      "extLst"
    ]
  },
  // CT_Trendline (§21.2.2.211)
  {
    parent: "trendline",
    order: [
      "name",
      "spPr",
      "trendlineType",
      "order",
      "period",
      "forward",
      "backward",
      "intercept",
      "dispRSqr",
      "dispEq",
      "trendlineLbl",
      "extLst"
    ]
  },
  // CT_ErrBars (§21.2.2.55)
  {
    parent: "errBars",
    order: [
      "errDir",
      "errBarType",
      "errValType",
      "noEndCap",
      "plus",
      "minus",
      "val",
      "spPr",
      "extLst"
    ]
  },
  // CT_View3D (§21.2.2.228)
  {
    parent: "view3D",
    order: ["rotX", "hPercent", "rotY", "depthPercent", "rAngAx", "perspective", "extLst"]
  },
  // CT_Legend (§21.2.2.93)
  {
    parent: "legend",
    order: ["legendPos", "legendEntry", "layout", "overlay", "spPr", "txPr", "extLst"]
  },
  // CT_Title (§21.2.2.210)
  { parent: "title", order: ["tx", "layout", "overlay", "spPr", "txPr", "extLst"] },

  // CT_DispUnitsLbl (§21.2.2.49). **Not CT_Title**, though it is easy to render as one: the sequence is
  // `layout` before `tx` — the reverse of a title's — and there is no `overlay` and no `extLst`. Closed,
  // because those two absences are the whole point of listing it.
  { parent: "dispUnitsLbl", order: ["layout", "tx", "spPr", "txPr"], closed: true },

  // ---------------------------------------------------------------------------
  // Chart-type elements (§21.2.2.4 — §21.2.2.198). Each plotArea
  // child must list its children in the canonical sequence. Excel
  // tolerates many mis-orderings but LibreOffice strict mode
  // rejects them; third-party OOXML validators (Microsoft's SDK,
  // Calligra, xmllint + XSD) refuse too.
  // ---------------------------------------------------------------------------
  // CT_AreaChart (§21.2.2.5)
  {
    parent: "areaChart",
    order: ["grouping", "varyColors", "ser", "dLbls", "dropLines", "axId", "extLst"]
  },
  // CT_Area3DChart (§21.2.2.4)
  {
    parent: "area3DChart",
    order: ["grouping", "varyColors", "ser", "dLbls", "dropLines", "gapDepth", "axId", "extLst"]
  },
  // CT_BarChart (§21.2.2.16)
  {
    parent: "barChart",
    order: [
      "barDir",
      "grouping",
      "varyColors",
      "ser",
      "dLbls",
      "gapWidth",
      "overlap",
      "serLines",
      "axId",
      "extLst"
    ]
  },
  // CT_Bar3DChart (§21.2.2.15)
  {
    parent: "bar3DChart",
    order: [
      "barDir",
      "grouping",
      "varyColors",
      "ser",
      "dLbls",
      "gapWidth",
      "gapDepth",
      "shape",
      "axId",
      "extLst"
    ]
  },
  // CT_LineChart (§21.2.2.97)
  {
    parent: "lineChart",
    order: [
      "grouping",
      "varyColors",
      "ser",
      "dLbls",
      "dropLines",
      "hiLowLines",
      "upDownBars",
      "marker",
      "smooth",
      "axId",
      "extLst"
    ]
  },
  // CT_Line3DChart (§21.2.2.96)
  {
    parent: "line3DChart",
    order: ["grouping", "varyColors", "ser", "dLbls", "dropLines", "gapDepth", "axId", "extLst"]
  },
  // CT_PieChart (§21.2.2.141)
  { parent: "pieChart", order: ["varyColors", "ser", "dLbls", "firstSliceAng", "extLst"] },
  // CT_Pie3DChart (§21.2.2.140) — no firstSliceAng, no holeSize.
  { parent: "pie3DChart", order: ["varyColors", "ser", "dLbls", "extLst"] },
  // CT_DoughnutChart (§21.2.2.50)
  {
    parent: "doughnutChart",
    order: ["varyColors", "ser", "dLbls", "firstSliceAng", "holeSize", "extLst"]
  },
  // CT_OfPieChart (§21.2.2.126)
  {
    parent: "ofPieChart",
    order: [
      "ofPieType",
      "varyColors",
      "ser",
      "dLbls",
      "gapWidth",
      "splitType",
      "splitPos",
      "custSplit",
      "secondPieSize",
      "serLines",
      "extLst"
    ]
  },
  // CT_ScatterChart (§21.2.2.161)
  {
    parent: "scatterChart",
    order: ["scatterStyle", "varyColors", "ser", "dLbls", "axId", "extLst"]
  },
  // CT_BubbleChart (§21.2.2.20)
  {
    parent: "bubbleChart",
    order: [
      "varyColors",
      "ser",
      "dLbls",
      "bubble3D",
      "bubbleScale",
      "showNegBubbles",
      "sizeRepresents",
      "axId",
      "extLst"
    ]
  },
  // CT_RadarChart (§21.2.2.153)
  {
    parent: "radarChart",
    order: ["radarStyle", "varyColors", "ser", "dLbls", "axId", "extLst"]
  },
  // CT_StockChart (§21.2.2.198)
  {
    parent: "stockChart",
    order: ["ser", "dLbls", "dropLines", "hiLowLines", "upDownBars", "axId", "extLst"]
  },
  // CT_SurfaceChart (§21.2.2.193) / CT_Surface3DChart
  { parent: "surfaceChart", order: ["wireframe", "ser", "bandFmts", "axId", "extLst"] },
  { parent: "surface3DChart", order: ["wireframe", "ser", "bandFmts", "axId", "extLst"] },

  // ---------------------------------------------------------------------------
  // Auxiliary complex types (§21.2.2.x). Sequences that appear
  // throughout the chart graph — getting them out of order is a
  // common bug source (and historically Excel tolerates it while
  // LibreOffice strict refuses the file).
  // ---------------------------------------------------------------------------
  // CT_DPt (§21.2.2.52)
  {
    parent: "dPt",
    order: [
      "idx",
      "invertIfNegative",
      "marker",
      "bubble3D",
      "explosion",
      "spPr",
      "pictureOptions",
      "extLst"
    ]
  },
  // CT_Marker (§21.2.2.106)
  { parent: "marker", order: ["symbol", "size", "spPr", "extLst"] },
  // CT_UpDownBars (§21.2.2.218)
  { parent: "upDownBars", order: ["gapWidth", "upBars", "downBars", "extLst"] },
  // CT_NumRef / CT_StrRef / CT_MultiLvlStrRef (§21.2.2.121 / .189 / .113)
  { parent: "numRef", order: ["f", "numCache", "extLst"] },
  { parent: "strRef", order: ["f", "strCache", "extLst"] },
  { parent: "multiLvlStrRef", order: ["f", "multiLvlStrCache", "extLst"] },
  // CT_NumData / CT_StrData (§21.2.2.122 / .188)
  { parent: "numCache", order: ["formatCode", "ptCount", "pt", "extLst"] },
  { parent: "strCache", order: ["ptCount", "pt", "extLst"] },
  { parent: "multiLvlStrCache", order: ["ptCount", "lvl", "extLst"] },
  // CT_NumLit / CT_StrLit
  { parent: "numLit", order: ["formatCode", "ptCount", "pt", "extLst"] },
  { parent: "strLit", order: ["ptCount", "pt", "extLst"] },
  // CT_Pt (§21.2.2.146): v element; idx is an attribute.
  { parent: "pt", order: ["v"] },
  // CT_Layout (§21.2.2.88) / CT_ManualLayout (§21.2.2.105)
  { parent: "layout", order: ["manualLayout", "extLst"] },
  {
    parent: "manualLayout",
    order: ["layoutTarget", "xMode", "yMode", "wMode", "hMode", "x", "y", "w", "h", "extLst"]
  },
  // CT_DTable (§21.2.2.54)
  {
    parent: "dTable",
    order: ["showHorzBorder", "showVertBorder", "showOutline", "showKeys", "spPr", "txPr", "extLst"]
  },
  // CT_BandFormats (§21.2.2.12) / CT_BandFormat (§21.2.2.11)
  { parent: "bandFmts", order: ["bandFmt"] },
  { parent: "bandFmt", order: ["idx", "spPr"] },
  // CT_TrendlineLbl (§21.2.2.212) — layout? tx? numFmt? spPr? txPr? extLst?
  {
    parent: "trendlineLbl",
    order: ["layout", "tx", "numFmt", "spPr", "txPr", "extLst"]
  },
  // CT_PictureOptions (§21.2.2.144)
  {
    parent: "pictureOptions",
    order: ["applyToFront", "applyToSides", "applyToEnd", "pictureFormat", "pictureStackUnit"]
  }
];

/**
 * Series (`c:ser`) child order depends on which chart-type element
 * encloses it. The same tag maps to CT_BarSer / CT_LineSer /
 * CT_PieSer / CT_AreaSer / CT_ScatterSer / CT_BubbleSer / CT_RadarSer
 * / CT_SurfaceSer, each with its own sequence.
 */
interface ContextualSeriesOrderRule {
  /** Chart-type parents this rule applies to. */
  chartTypes: readonly string[];
  /** Canonical child order for `c:ser` under these parents. */
  order: readonly string[];
}

const SERIES_ORDER_RULES: ContextualSeriesOrderRule[] = [
  // CT_BarSer (§21.2.2.17)
  {
    chartTypes: ["barChart", "bar3DChart"],
    order: [
      "idx",
      "order",
      "tx",
      "spPr",
      "invertIfNegative",
      "pictureOptions",
      "dPt",
      "dLbls",
      "trendline",
      "errBars",
      "cat",
      "val",
      "shape",
      "extLst"
    ]
  },
  // CT_LineSer (§21.2.2.99) — line3D uses same structure.
  {
    chartTypes: ["lineChart", "line3DChart", "stockChart"],
    order: [
      "idx",
      "order",
      "tx",
      "spPr",
      "marker",
      "dPt",
      "dLbls",
      "trendline",
      "errBars",
      "cat",
      "val",
      "smooth",
      "extLst"
    ]
  },
  // CT_PieSer (§21.2.2.149) — pie / pie3D / doughnut / ofPie share.
  {
    chartTypes: ["pieChart", "pie3DChart", "doughnutChart", "ofPieChart"],
    order: ["idx", "order", "tx", "spPr", "explosion", "dPt", "dLbls", "cat", "val", "extLst"]
  },
  // CT_AreaSer (§21.2.2.3)
  {
    chartTypes: ["areaChart", "area3DChart"],
    order: [
      "idx",
      "order",
      "tx",
      "spPr",
      "pictureOptions",
      "dPt",
      "dLbls",
      "trendline",
      "errBars",
      "cat",
      "val",
      "extLst"
    ]
  },
  // CT_ScatterSer (§21.2.2.167)
  {
    chartTypes: ["scatterChart"],
    order: [
      "idx",
      "order",
      "tx",
      "spPr",
      "marker",
      "dPt",
      "dLbls",
      "trendline",
      "errBars",
      "xVal",
      "yVal",
      "smooth",
      "extLst"
    ]
  },
  // CT_BubbleSer (§21.2.2.19)
  {
    chartTypes: ["bubbleChart"],
    order: [
      "idx",
      "order",
      "tx",
      "spPr",
      "invertIfNegative",
      "dPt",
      "dLbls",
      "trendline",
      "errBars",
      "xVal",
      "yVal",
      "bubbleSize",
      "bubble3D",
      "extLst"
    ]
  },
  // CT_RadarSer (§21.2.2.153)
  {
    chartTypes: ["radarChart"],
    order: ["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "cat", "val", "extLst"]
  },
  // CT_SurfaceSer (§21.2.2.191)
  {
    chartTypes: ["surfaceChart", "surface3DChart"],
    order: ["idx", "order", "tx", "spPr", "cat", "val", "extLst"]
  }
];

/**
 * Required / maximum occurrence counts for specific parent/child
 * pairs. `min` is the schema `minOccurs`; `max` is the `maxOccurs`
 * (left undefined when unbounded). Reported as
 * `chart-missing-required-child` or `chart-wrong-child-count`.
 */
interface RequiredChildRule {
  parent: string;
  child: string;
  min: number;
  max?: number;
}

const CLASSIC_REQUIRED_CHILDREN: RequiredChildRule[] = [
  // Chart types that plot against a Cartesian coordinate system
  // reference their axes by `c:axId`. 2-D variants need exactly two
  // axis references, 3-D variants need three (X / Y / Z / series).
  { parent: "barChart", child: "axId", min: 2, max: 2 },
  { parent: "barChart", child: "barDir", min: 1, max: 1 },
  { parent: "bar3DChart", child: "axId", min: 3, max: 3 },
  { parent: "bar3DChart", child: "barDir", min: 1, max: 1 },
  { parent: "lineChart", child: "axId", min: 2, max: 2 },
  { parent: "lineChart", child: "grouping", min: 1, max: 1 },
  { parent: "line3DChart", child: "axId", min: 3, max: 3 },
  { parent: "line3DChart", child: "grouping", min: 1, max: 1 },
  { parent: "areaChart", child: "axId", min: 2, max: 2 },
  { parent: "area3DChart", child: "axId", min: 3, max: 3 },
  { parent: "scatterChart", child: "axId", min: 2, max: 2 },
  { parent: "scatterChart", child: "scatterStyle", min: 1, max: 1 },
  { parent: "bubbleChart", child: "axId", min: 2, max: 2 },
  { parent: "radarChart", child: "axId", min: 2, max: 2 },
  { parent: "radarChart", child: "radarStyle", min: 1, max: 1 },
  { parent: "stockChart", child: "axId", min: 2, max: 2 },
  { parent: "surfaceChart", child: "axId", min: 3, max: 3 },
  { parent: "surface3DChart", child: "axId", min: 3, max: 3 },
  { parent: "ofPieChart", child: "ofPieType", min: 1, max: 1 },
  // Axes require axId / scaling / axPos / crossAx.
  { parent: "catAx", child: "axId", min: 1, max: 1 },
  { parent: "catAx", child: "scaling", min: 1, max: 1 },
  { parent: "catAx", child: "axPos", min: 1, max: 1 },
  { parent: "catAx", child: "crossAx", min: 1, max: 1 },
  { parent: "valAx", child: "axId", min: 1, max: 1 },
  { parent: "valAx", child: "scaling", min: 1, max: 1 },
  { parent: "valAx", child: "axPos", min: 1, max: 1 },
  { parent: "valAx", child: "crossAx", min: 1, max: 1 },
  { parent: "dateAx", child: "axId", min: 1, max: 1 },
  { parent: "dateAx", child: "scaling", min: 1, max: 1 },
  { parent: "dateAx", child: "axPos", min: 1, max: 1 },
  { parent: "dateAx", child: "crossAx", min: 1, max: 1 },
  { parent: "serAx", child: "axId", min: 1, max: 1 },
  { parent: "serAx", child: "scaling", min: 1, max: 1 },
  { parent: "serAx", child: "axPos", min: 1, max: 1 },
  { parent: "serAx", child: "crossAx", min: 1, max: 1 },
  // Every series carries idx + order.
  { parent: "ser", child: "idx", min: 1, max: 1 },
  { parent: "ser", child: "order", min: 1, max: 1 },
  // Trendline / errBars / dPt / dLbl header attributes.
  { parent: "trendline", child: "trendlineType", min: 1, max: 1 },
  { parent: "errBars", child: "errBarType", min: 1, max: 1 },
  { parent: "errBars", child: "errValType", min: 1, max: 1 },
  { parent: "dPt", child: "idx", min: 1, max: 1 },
  { parent: "dLbl", child: "idx", min: 1, max: 1 }
];

/**
 * Enumerated attribute values. Applied to every element with a
 * matching local name anywhere in the chart. Mismatches are
 * reported as `chart-invalid-enum-value`.
 */
interface EnumAttrRule {
  element: string;
  attr: string;
  allowed: readonly string[];
}

const CLASSIC_ENUM_RULES: EnumAttrRule[] = [
  { element: "barDir", attr: "val", allowed: ["bar", "col"] },
  {
    element: "grouping",
    attr: "val",
    allowed: ["standard", "stacked", "percentStacked", "clustered"]
  },
  { element: "orientation", attr: "val", allowed: ["minMax", "maxMin"] },
  { element: "ofPieType", attr: "val", allowed: ["pie", "bar"] },
  {
    element: "dLblPos",
    attr: "val",
    allowed: ["b", "bestFit", "ctr", "inBase", "inEnd", "l", "outEnd", "r", "t"]
  },
  { element: "legendPos", attr: "val", allowed: ["b", "l", "r", "t", "tr"] },
  {
    element: "scatterStyle",
    attr: "val",
    allowed: ["none", "line", "lineMarker", "marker", "smooth", "smoothMarker"]
  },
  { element: "radarStyle", attr: "val", allowed: ["standard", "marker", "filled"] },
  { element: "dispBlanksAs", attr: "val", allowed: ["span", "gap", "zero"] },
  { element: "splitType", attr: "val", allowed: ["auto", "cust", "percent", "pos", "val"] },
  {
    element: "shape",
    attr: "val",
    allowed: ["cone", "coneToMax", "box", "cylinder", "pyramid", "pyramidToMax"]
  },
  { element: "crosses", attr: "val", allowed: ["autoZero", "min", "max"] },
  { element: "crossBetween", attr: "val", allowed: ["between", "midCat"] },
  { element: "lblAlgn", attr: "val", allowed: ["ctr", "l", "r"] },
  { element: "axPos", attr: "val", allowed: ["b", "l", "r", "t"] },
  { element: "majorTickMark", attr: "val", allowed: ["cross", "in", "none", "out"] },
  { element: "minorTickMark", attr: "val", allowed: ["cross", "in", "none", "out"] },
  { element: "tickLblPos", attr: "val", allowed: ["high", "low", "nextTo", "none"] },
  { element: "baseTimeUnit", attr: "val", allowed: ["days", "months", "years"] },
  { element: "majorTimeUnit", attr: "val", allowed: ["days", "months", "years"] },
  { element: "minorTimeUnit", attr: "val", allowed: ["days", "months", "years"] },
  {
    element: "trendlineType",
    attr: "val",
    allowed: ["exp", "linear", "log", "movingAvg", "poly", "power"]
  },
  { element: "errDir", attr: "val", allowed: ["x", "y"] },
  { element: "errBarType", attr: "val", allowed: ["both", "minus", "plus"] },
  {
    element: "errValType",
    attr: "val",
    allowed: ["cust", "fixedVal", "percentage", "stdDev", "stdErr"]
  },
  {
    element: "symbol",
    attr: "val",
    allowed: [
      "auto",
      "circle",
      "dash",
      "diamond",
      "dot",
      "none",
      "picture",
      "plus",
      "square",
      "star",
      "triangle",
      "x"
    ]
  },
  { element: "sizeRepresents", attr: "val", allowed: ["area", "w"] },
  // DrawingML theme-palette slots — `<a:schemeClr val>` must be one
  // of the 17 canonical slot names per ECMA-376 §20.1.10.54
  // (`ST_SchemeColorVal`). Typos here either inherit Excel's
  // "Accent 1" default or strip the fill entirely depending on
  // build.
  {
    element: "schemeClr",
    attr: "val",
    allowed: [
      "bg1",
      "bg2",
      "tx1",
      "tx2",
      "accent1",
      "accent2",
      "accent3",
      "accent4",
      "accent5",
      "accent6",
      "hlink",
      "folHlink",
      "phClr",
      "dk1",
      "dk2",
      "lt1",
      "lt2"
    ]
  }
];

/**
 * Numeric-range constraints. Mismatches are reported as
 * `chart-value-out-of-range`.
 */
interface RangeAttrRule {
  element: string;
  attr: string;
  min: number;
  max: number;
}

const CLASSIC_RANGE_RULES: RangeAttrRule[] = [
  { element: "holeSize", attr: "val", min: 10, max: 90 },
  { element: "firstSliceAng", attr: "val", min: 0, max: 360 },
  { element: "overlap", attr: "val", min: -100, max: 100 },
  { element: "gapWidth", attr: "val", min: 0, max: 500 },
  { element: "gapDepth", attr: "val", min: 0, max: 500 },
  { element: "rotX", attr: "val", min: -90, max: 90 },
  { element: "rotY", attr: "val", min: 0, max: 360 },
  { element: "perspective", attr: "val", min: 0, max: 240 },
  { element: "hPercent", attr: "val", min: 5, max: 500 },
  { element: "depthPercent", attr: "val", min: 20, max: 2000 },
  { element: "bubbleScale", attr: "val", min: 0, max: 300 },
  { element: "secondPieSize", attr: "val", min: 5, max: 200 },
  // Axis units must be strictly positive. `Number.EPSILON` is a
  // close-to-zero sentinel that rejects 0 and negatives while
  // permitting the smallest finite positive a double can express.
  { element: "majorUnit", attr: "val", min: Number.EPSILON, max: Number.MAX_VALUE },
  { element: "minorUnit", attr: "val", min: Number.EPSILON, max: Number.MAX_VALUE },
  // Tick-label / tick-mark skip: 1 = every tick, so >= 1 per schema
  // (CT_Skip uses `xsd:unsignedInt` with a required minimum of 1).
  { element: "tickLblSkip", attr: "val", min: 1, max: Number.MAX_SAFE_INTEGER },
  { element: "tickMarkSkip", attr: "val", min: 1, max: Number.MAX_SAFE_INTEGER },
  // DrawingML `<a:alpha val>` is CT_PositiveFixedPercentage
  // (0 to 100000 representing 0% to 100%).
  { element: "alpha", attr: "val", min: 0, max: 100_000 }
];

function checkClassicChartSchema(ctx: ValidationContext, path: string, root: XmlElement): void {
  checkClassicChildOrder(ctx, path, root);
  checkClassicRequiredChildren(ctx, path, root);
  checkClassicEnumValues(ctx, path, root);
  checkClassicNumericRanges(ctx, path, root);
  checkClassicDLblChoice(ctx, path, root);
  checkContextAwareChartRules(ctx, path, root);
  checkDataReferenceStructure(ctx, path, root);
  checkSeriesChildOrder(ctx, path, root);
  checkAxIdResolution(ctx, path, root);
  checkErrBarsConditionalChildren(ctx, path, root);
  checkTxChoice(ctx, path, root);
  checkSeriesChildWhitelist(ctx, path, root);
  checkSrgbClrFormat(ctx, path, root);
  checkNumFmtFormatCode(ctx, path, root);
  checkRichStructure(ctx, path, root);
  // Cross-part reference checks — these reach into `xl/theme/theme1.xml`
  // and `xl/workbook.xml` via ctx.readDom (cached).
  checkThemeSchemeColorSlots(ctx, path, root);
  checkFormulaSyntax(ctx, path, root);
  checkDefinedNameResolution(ctx, path, root);
}

function checkClassicChildOrder(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const rule of CLASSIC_ORDER_RULES) {
    for (const parent of collectDescendantsLocal(root, rule.parent)) {
      if (ctx.reporter.capped) {
        return;
      }
      const children = parent.children.filter(c => c.type === "element") as XmlElement[];
      const rankOf = (tag: string): number => {
        if (rule.choiceGroups) {
          for (let i = 0; i < rule.choiceGroups.length; i++) {
            if (rule.choiceGroups[i].includes(tag)) {
              // Every tag in the same choice group maps to the same
              // virtual bucket ("__CHART_TYPES__" / "__AXES__") so
              // they compare equal in sibling-order checks.
              return rule.order.indexOf(`__${i === 0 ? "CHART_TYPES" : "AXES"}__`);
            }
          }
        }
        return rule.order.indexOf(tag);
      };
      let lastRank = -1;
      let lastTag = "";
      for (const child of children) {
        const name = localName(child.name);
        const rank = rankOf(name);
        if (rank < 0) {
          if (rule.closed === true) {
            ctx.reporter.error(
              "chart-child-not-permitted",
              `${path}: <c:${rule.parent}> child <c:${name}> is not permitted — CT_${capitalise(rule.parent)} allows only ${rule.order.map(tag => `<c:${tag}>`).join(", ")}.`,
              path
            );
          }
          continue;
        }
        if (rank < lastRank) {
          ctx.reporter.error(
            "chart-child-out-of-order",
            `${path}: <c:${rule.parent}> child <c:${name}> appears after <c:${lastTag}> — ECMA-376 requires it before per CT_${capitalise(rule.parent)}.`,
            path
          );
        }
        if (rank >= lastRank) {
          lastRank = rank;
          lastTag = name;
        }
      }
    }
  }
}

function checkClassicRequiredChildren(
  ctx: ValidationContext,
  path: string,
  root: XmlElement
): void {
  for (const rule of CLASSIC_REQUIRED_CHILDREN) {
    for (const parent of collectDescendantsLocal(root, rule.parent)) {
      if (ctx.reporter.capped) {
        return;
      }
      const n = findChildrenLocal(parent, rule.child).length;
      if (n < rule.min) {
        ctx.reporter.error(
          "chart-missing-required-child",
          `${path}: <c:${rule.parent}> has ${n} <c:${rule.child}> child(ren); schema requires at least ${rule.min}.`,
          path
        );
      }
      if (rule.max !== undefined && n > rule.max) {
        ctx.reporter.error(
          "chart-wrong-child-count",
          `${path}: <c:${rule.parent}> has ${n} <c:${rule.child}> child(ren); schema permits at most ${rule.max}.`,
          path
        );
      }
    }
  }
}

function checkClassicEnumValues(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const rule of CLASSIC_ENUM_RULES) {
    for (const el of collectDescendantsLocal(root, rule.element)) {
      if (ctx.reporter.capped) {
        return;
      }
      const val = attrByLocalName(el, rule.attr);
      if (val === undefined) {
        continue;
      }
      if (!rule.allowed.includes(val)) {
        ctx.reporter.error(
          "chart-invalid-enum-value",
          `${path}: <c:${rule.element} ${rule.attr}="${val}"> — ${val} is not in {${rule.allowed.join(", ")}}.`,
          path
        );
      }
    }
  }
}

function checkClassicNumericRanges(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const rule of CLASSIC_RANGE_RULES) {
    for (const el of collectDescendantsLocal(root, rule.element)) {
      if (ctx.reporter.capped) {
        return;
      }
      const raw = attrByLocalName(el, rule.attr);
      if (raw === undefined) {
        continue;
      }
      const num = parseFloat(raw);
      if (!Number.isFinite(num)) {
        ctx.reporter.error(
          "chart-value-out-of-range",
          `${path}: <c:${rule.element} ${rule.attr}="${raw}"> is not a finite number.`,
          path
        );
        continue;
      }
      if (num < rule.min || num > rule.max) {
        ctx.reporter.error(
          "chart-value-out-of-range",
          `${path}: <c:${rule.element} ${rule.attr}="${num}"> outside [${rule.min}, ${rule.max}].`,
          path
        );
      }
    }
  }
}

/**
 * `CT_DLbl` is `idx, choice(delete | (layout, tx, numFmt, spPr,
 * txPr, dLblPos, show*..., separator)), extLst?`. The two choice
 * branches are mutually exclusive — emitting `delete` alongside
 * any display-flag child is a schema violation that Excel's
 * loader has been observed to handle inconsistently (some builds
 * strip the label wholesale, others silently drop `delete`).
 */
function checkClassicDLblChoice(ctx: ValidationContext, path: string, root: XmlElement): void {
  const displayBranchTags = new Set([
    "layout",
    "tx",
    "numFmt",
    "spPr",
    "txPr",
    "dLblPos",
    "showLegendKey",
    "showVal",
    "showCatName",
    "showSerName",
    "showPercent",
    "showBubbleSize",
    "separator"
  ]);
  for (const dLbl of collectDescendantsLocal(root, "dLbl")) {
    if (ctx.reporter.capped) {
      return;
    }
    const hasDelete = findChildLocal(dLbl, "delete") !== undefined;
    if (!hasDelete) {
      continue;
    }
    const conflictingChild = dLbl.children.find(
      c => c.type === "element" && displayBranchTags.has(localName(c.name))
    ) as XmlElement | undefined;
    if (conflictingChild) {
      ctx.reporter.error(
        "chart-child-out-of-order",
        `${path}: <c:dLbl> has both <c:delete> and <c:${localName(conflictingChild.name)}>; CT_DLbl's choice group requires one branch or the other, never both.`,
        path
      );
    }
  }
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// -----------------------------------------------------------------------------
// Context-aware rules — chart-type-specific restrictions that the
// generic schema tables above cannot express. Each rule scopes itself
// to one or more `c:*Chart` parents so the same child element gets
// validated differently based on where it lives.
// -----------------------------------------------------------------------------

/**
 * Per-chart-type `c:dLblPos` allow-list. Although ECMA-376 `ST_DLblPos`
 * permits all nine values globally, Excel's reader applies a stricter
 * per-context filter that mirrors the "Label Position" picker in the
 * Format Data Labels panel. Emitting a value outside the allow-list
 * triggers "Repaired Records: Drawing" on open, and — for doughnut —
 * causes the entire `drawing*.xml` part to be stripped.
 *
 * - `doughnut`: Excel's UI exposes no position choices at all; any
 *   `c:dLblPos` in a doughnut chart's `c:dLbls` causes the drawing
 *   part to be removed on open.
 * - `bar` / `bar3D`: only the four "in/out/base/centre" positions.
 *   `inBase` is unique to bar and anchors the label to the axis end.
 * - `line`, `line3D`, `scatter`, `bubble`, `radar`, `stock`: only the
 *   five cartesian positions (centre, above, below, left, right).
 * - `pie`, `pie3D`, `ofPie`: the pie label set — bestFit is Excel's
 *   default and the only value that lets Excel place labels with
 *   automatic leader lines.
 * - `area`, `area3D`: Excel only accepts `ctr` for area fills.
 * - `surface`, `surface3D`: data labels are forbidden entirely (see
 *   `FORBIDDEN_CHILDREN_BY_CHART_TYPE` below).
 */
const VALID_DLBL_POSITIONS_BY_CHART_TYPE: Record<string, ReadonlySet<string>> = {
  barChart: new Set(["ctr", "inBase", "inEnd", "outEnd"]),
  bar3DChart: new Set(["ctr", "inBase", "inEnd", "outEnd"]),
  lineChart: new Set(["ctr", "l", "r", "t", "b"]),
  line3DChart: new Set(["ctr", "l", "r", "t", "b"]),
  scatterChart: new Set(["ctr", "l", "r", "t", "b"]),
  bubbleChart: new Set(["ctr", "l", "r", "t", "b"]),
  radarChart: new Set(["ctr", "l", "r", "t", "b"]),
  stockChart: new Set(["ctr", "l", "r", "t", "b"]),
  pieChart: new Set(["bestFit", "ctr", "inEnd", "outEnd"]),
  pie3DChart: new Set(["bestFit", "ctr", "inEnd", "outEnd"]),
  ofPieChart: new Set(["bestFit", "ctr", "inEnd", "outEnd"]),
  doughnutChart: new Set(),
  areaChart: new Set(["ctr"]),
  area3DChart: new Set(["ctr"])
};

/**
 * `c:trendline` and `c:errBars` are forbidden inside pie-family
 * series (`CT_PieSer` has neither slot per schema). They are also
 * forbidden on surface series. Emitting one produces a series Excel
 * refuses to render. `c:dataLabels` is forbidden on surface series.
 */
const FORBIDDEN_CHILDREN_BY_CHART_TYPE: Record<string, ReadonlySet<string>> = {
  pieChart: new Set(["trendline", "errBars"]),
  pie3DChart: new Set(["trendline", "errBars"]),
  doughnutChart: new Set(["trendline", "errBars"]),
  ofPieChart: new Set(["trendline", "errBars"]),
  surfaceChart: new Set(["trendline", "errBars", "dLbls", "marker"]),
  surface3DChart: new Set(["trendline", "errBars", "dLbls", "marker"])
};

/**
 * `c:errBars` maxOccurs per series, per parent chart type.
 *
 * Scatter and bubble series use `CT_ScatterSer` / `CT_BubbleSer` whose
 * `errBars` element has `maxOccurs="2"` — one for direction `x`, one
 * for direction `y`. Every other series type caps at 1. Two entries
 * with the same `c:errDir` inside the same series are a schema
 * violation; Excel silently drops the duplicate (first one wins).
 */
const ERRBARS_MAX_BY_CHART_TYPE: Record<string, number> = {
  scatterChart: 2,
  bubbleChart: 2,
  barChart: 1,
  bar3DChart: 1,
  lineChart: 1,
  line3DChart: 1,
  areaChart: 1,
  area3DChart: 1,
  radarChart: 1,
  stockChart: 1
};

/**
 * Required series count per chart type. `stockChart` needs 3 or 4
 * series (HLC or OHLC); everything else needs at least 1.
 */
const SERIES_COUNT_BY_CHART_TYPE: Record<string, { min: number; max?: number }> = {
  barChart: { min: 1 },
  bar3DChart: { min: 1 },
  lineChart: { min: 1 },
  line3DChart: { min: 1 },
  areaChart: { min: 1 },
  area3DChart: { min: 1 },
  scatterChart: { min: 1 },
  bubbleChart: { min: 1 },
  radarChart: { min: 1 },
  pieChart: { min: 1 },
  pie3DChart: { min: 1 },
  doughnutChart: { min: 1 },
  ofPieChart: { min: 1 },
  surfaceChart: { min: 1 },
  surface3DChart: { min: 1 },
  stockChart: { min: 3, max: 4 }
};

/**
 * Walk each chart-type group in the plot area and apply the
 * context-sensitive rules above:
 *   - `c:dLblPos` value matches the allow-list for this type.
 *   - `c:trendline` / `c:errBars` not present when forbidden.
 *   - `c:errBars` cardinality + `c:errDir` uniqueness.
 *   - Series count within the schema-permitted range.
 *   - Series `c:idx` / `c:order` values unique inside the group.
 */
function checkContextAwareChartRules(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const chartType of Object.keys(VALID_DLBL_POSITIONS_BY_CHART_TYPE)) {
    for (const group of collectDescendantsLocal(root, chartType)) {
      if (ctx.reporter.capped) {
        return;
      }
      checkDLblPosForChartType(ctx, path, group, chartType);
      checkForbiddenSeriesChildren(ctx, path, group, chartType);
      checkErrBarsCardinality(ctx, path, group, chartType);
      checkSeriesIdxOrderUnique(ctx, path, group, chartType);
      checkSeriesCount(ctx, path, group, chartType);
    }
  }
  // Surface / surface3D only participate in series-count + forbidden-
  // children checks — no dLblPos allow-list because Excel rejects
  // data labels on them wholesale.
  for (const chartType of ["surfaceChart", "surface3DChart"]) {
    for (const group of collectDescendantsLocal(root, chartType)) {
      if (ctx.reporter.capped) {
        return;
      }
      checkForbiddenSeriesChildren(ctx, path, group, chartType);
      checkSeriesCount(ctx, path, group, chartType);
      checkSeriesIdxOrderUnique(ctx, path, group, chartType);
    }
  }
}

function checkDLblPosForChartType(
  ctx: ValidationContext,
  path: string,
  group: XmlElement,
  chartType: string
): void {
  const allowed = VALID_DLBL_POSITIONS_BY_CHART_TYPE[chartType];
  if (!allowed) {
    return;
  }
  for (const pos of collectDescendantsLocal(group, "dLblPos")) {
    if (ctx.reporter.capped) {
      return;
    }
    const val = attrByLocalName(pos, "val");
    if (val === undefined) {
      continue;
    }
    if (!allowed.has(val)) {
      const allowedList =
        allowed.size === 0
          ? "(none — this chart type does not accept c:dLblPos)"
          : [...allowed].sort().join(", ");
      ctx.reporter.error(
        "chart-invalid-enum-value",
        `${path}: <c:dLblPos val="${val}"> inside <c:${chartType}> — Excel only accepts {${allowedList}} for this chart type.`,
        path
      );
    }
  }
}

function checkForbiddenSeriesChildren(
  ctx: ValidationContext,
  path: string,
  group: XmlElement,
  chartType: string
): void {
  const forbidden = FORBIDDEN_CHILDREN_BY_CHART_TYPE[chartType];
  if (!forbidden || forbidden.size === 0) {
    return;
  }
  for (const series of findChildrenLocal(group, "ser")) {
    for (const child of series.children) {
      if (ctx.reporter.capped) {
        return;
      }
      if (child.type !== "element") {
        continue;
      }
      const name = localName(child.name);
      if (forbidden.has(name)) {
        ctx.reporter.error(
          "chart-forbidden-child",
          `${path}: <c:ser> inside <c:${chartType}> contains <c:${name}>, which is not allowed for this chart type per ECMA-376.`,
          path
        );
      }
    }
  }
  // Surface charts forbid dLbls at the GROUP level too.
  if (forbidden.has("dLbls")) {
    for (const dLbls of findChildrenLocal(group, "dLbls")) {
      if (ctx.reporter.capped) {
        return;
      }
      void dLbls;
      ctx.reporter.error(
        "chart-forbidden-child",
        `${path}: <c:${chartType}> contains group-level <c:dLbls>, which is not allowed for this chart type.`,
        path
      );
    }
  }
}

function checkErrBarsCardinality(
  ctx: ValidationContext,
  path: string,
  group: XmlElement,
  chartType: string
): void {
  const max = ERRBARS_MAX_BY_CHART_TYPE[chartType];
  if (max === undefined) {
    return;
  }
  for (const series of findChildrenLocal(group, "ser")) {
    if (ctx.reporter.capped) {
      return;
    }
    const errBars = findChildrenLocal(series, "errBars");
    if (errBars.length > max) {
      ctx.reporter.error(
        "chart-wrong-child-count",
        `${path}: <c:ser> inside <c:${chartType}> has ${errBars.length} <c:errBars> children; schema permits at most ${max}.`,
        path
      );
    }
    // When maxOccurs=2 (scatter/bubble), the two entries must carry
    // distinct `c:errDir` values.
    if (errBars.length === 2) {
      const dirs = errBars.map(eb => {
        const dirEl = findChildLocal(eb, "errDir");
        return dirEl ? attrByLocalName(dirEl, "val") : undefined;
      });
      if (dirs[0] !== undefined && dirs[1] !== undefined && dirs[0] === dirs[1]) {
        ctx.reporter.error(
          "chart-duplicate-errBars-direction",
          `${path}: <c:ser> inside <c:${chartType}> has two <c:errBars> with the same <c:errDir val="${dirs[0]}"> — schema requires distinct directions (x + y).`,
          path
        );
      }
    }
  }
}

function checkSeriesIdxOrderUnique(
  ctx: ValidationContext,
  path: string,
  group: XmlElement,
  chartType: string
): void {
  const series = findChildrenLocal(group, "ser");
  const seenIdx = new Set<string>();
  const seenOrder = new Set<string>();
  for (const s of series) {
    if (ctx.reporter.capped) {
      return;
    }
    const idxEl = findChildLocal(s, "idx");
    const orderEl = findChildLocal(s, "order");
    const idx = idxEl ? attrByLocalName(idxEl, "val") : undefined;
    const order = orderEl ? attrByLocalName(orderEl, "val") : undefined;
    if (idx !== undefined) {
      if (seenIdx.has(idx)) {
        ctx.reporter.error(
          "chart-duplicate-series-idx",
          `${path}: <c:${chartType}> has two <c:ser> entries with <c:idx val="${idx}">; idx must be unique within a chart-type group.`,
          path
        );
      }
      seenIdx.add(idx);
    }
    if (order !== undefined) {
      if (seenOrder.has(order)) {
        ctx.reporter.error(
          "chart-duplicate-series-order",
          `${path}: <c:${chartType}> has two <c:ser> entries with <c:order val="${order}">; order must be unique within a chart-type group.`,
          path
        );
      }
      seenOrder.add(order);
    }
  }
}

function checkSeriesCount(
  ctx: ValidationContext,
  path: string,
  group: XmlElement,
  chartType: string
): void {
  const bounds = SERIES_COUNT_BY_CHART_TYPE[chartType];
  if (!bounds) {
    return;
  }
  const count = findChildrenLocal(group, "ser").length;
  if (count < bounds.min) {
    ctx.reporter.error(
      "chart-missing-required-child",
      `${path}: <c:${chartType}> has ${count} <c:ser> children; schema requires at least ${bounds.min}${bounds.max !== undefined ? ` (and at most ${bounds.max})` : ""}.`,
      path
    );
  }
  if (bounds.max !== undefined && count > bounds.max) {
    ctx.reporter.error(
      "chart-wrong-child-count",
      `${path}: <c:${chartType}> has ${count} <c:ser> children; schema permits at most ${bounds.max}.`,
      path
    );
  }
}

// -----------------------------------------------------------------------------
// Data-reference structural checks — `c:numRef` / `c:strRef` /
// `c:multiLvlStrRef` require `c:f`; their caches require `c:ptCount`;
// every `c:pt` inside a cache needs `@idx` and a `c:v` child; `c:pt
// idx` must stay inside the declared cache range.
// -----------------------------------------------------------------------------

const REF_ELEMENTS = ["numRef", "strRef", "multiLvlStrRef"] as const;
const LIT_ELEMENTS = ["numLit", "strLit"] as const;
const CACHE_ELEMENTS = ["numCache", "strCache", "multiLvlStrCache"] as const;

function checkDataReferenceStructure(ctx: ValidationContext, path: string, root: XmlElement): void {
  // `c:numRef`, `c:strRef`, `c:multiLvlStrRef` must carry `c:f`.
  for (const refName of REF_ELEMENTS) {
    for (const ref of collectDescendantsLocal(root, refName)) {
      if (ctx.reporter.capped) {
        return;
      }
      if (!findChildLocal(ref, "f")) {
        ctx.reporter.error(
          "chart-missing-required-child",
          `${path}: <c:${refName}> is missing the required <c:f> formula child.`,
          path
        );
      }
    }
  }
  // `c:numLit` / `c:strLit` should carry `c:ptCount`.
  for (const litName of LIT_ELEMENTS) {
    for (const lit of collectDescendantsLocal(root, litName)) {
      if (ctx.reporter.capped) {
        return;
      }
      if (!findChildLocal(lit, "ptCount")) {
        ctx.reporter.error(
          "chart-missing-required-child",
          `${path}: <c:${litName}> is missing the required <c:ptCount> child.`,
          path
        );
      }
    }
  }
  // Caches + `c:pt` integrity.
  for (const cacheName of CACHE_ELEMENTS) {
    for (const cache of collectDescendantsLocal(root, cacheName)) {
      if (ctx.reporter.capped) {
        return;
      }
      const ptCountEl = findChildLocal(cache, "ptCount");
      const ptCountVal = ptCountEl ? parseInt(attrByLocalName(ptCountEl, "val") ?? "", 10) : NaN;
      const points = findChildrenLocal(cache, "pt");
      for (const pt of points) {
        const idxRaw = attrByLocalName(pt, "idx");
        if (idxRaw === undefined) {
          ctx.reporter.error(
            "chart-missing-required-child",
            `${path}: <c:pt> inside <c:${cacheName}> is missing the required idx attribute.`,
            path
          );
          continue;
        }
        const idx = parseInt(idxRaw, 10);
        if (Number.isFinite(ptCountVal) && (idx < 0 || idx >= ptCountVal)) {
          ctx.reporter.error(
            "chart-pt-idx-out-of-range",
            `${path}: <c:pt idx="${idx}"> outside declared range [0, ${ptCountVal - 1}] (from <c:ptCount val="${ptCountVal}">).`,
            path
          );
        }
        // `numCache` / `strCache` points need a `c:v` child carrying
        // the cached value.
        if (cacheName !== "multiLvlStrCache" && !findChildLocal(pt, "v")) {
          ctx.reporter.error(
            "chart-missing-required-child",
            `${path}: <c:pt idx="${idx}"> inside <c:${cacheName}> is missing the required <c:v> value child.`,
            path
          );
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// End of classic chart schema conformance
// -----------------------------------------------------------------------------

function checkChartEx(ctx: ValidationContext, path: string): void {
  const dom = ctx.readDom(path);
  if (!dom) {
    return;
  }
  const root = dom.root;
  if (!hasDescendantLocal(root, "chart")) {
    ctx.reporter.error("chartEx-missing-chart", `${path}: missing cx:chart`, path);
  }
  if (!hasDescendantLocal(root, "plotArea")) {
    ctx.reporter.error("chartEx-missing-plotArea", `${path}: missing cx:plotArea`, path);
  }
  const seriesList = collectDescendantsLocal(root, "series");
  if (seriesList.length === 0) {
    ctx.reporter.error("chartEx-missing-series", `${path}: missing cx:series`, path);
    return;
  }

  const dataIds = new Set(
    collectDescendantsLocal(root, "data")
      .map(el => parseInt(attrByLocalName(el, "id") ?? "", 10))
      .filter(Number.isFinite)
  );
  const axisIds = new Set(
    collectDescendantsLocal(root, "axis")
      .map(el => parseInt(attrByLocalName(el, "id") ?? "", 10))
      .filter(Number.isFinite)
  );
  for (const series of seriesList) {
    if (!attrByLocalName(series, "layoutId")) {
      ctx.reporter.error(
        "chartEx-series-missing-layoutId",
        `${path}: cx:series missing layoutId`,
        path
      );
    }
    const dataIdChildren = findChildrenLocal(series, "dataId");
    // Schema cardinality: `CT_Series/dataId` has `maxOccurs="1"`.
    // Multi-dimensional series (box-whisker, sunburst, treemap) must
    // point at a single `<cx:data>` entry that holds every strDim /
    // numDim they need; emitting multiple dataIds tells Excel the
    // series references multiple data entries which is the "Removed
    // Part: drawingN.xml" trigger.
    if (dataIdChildren.length > 1) {
      ctx.reporter.error(
        "chartEx-series-too-many-dataId",
        `${path}: cx:series has ${dataIdChildren.length} <cx:dataId> children; schema permits at most 1. ` +
          `Consolidate the referenced <cx:data> entries into a single entry.`,
        path
      );
    }
    for (const dataId of dataIdChildren) {
      const id = parseInt(attrByLocalName(dataId, "val") ?? "", 10);
      if (!dataIds.has(id)) {
        ctx.reporter.error(
          "chartEx-series-missing-data-id",
          `${path}: cx:series references missing cx:data id ${attrByLocalName(dataId, "val")}`,
          path
        );
      }
    }
    for (const axisId of findChildrenLocal(series, "axisId")) {
      const id = parseInt(attrByLocalName(axisId, "val") ?? "", 10);
      if (!axisIds.has(id)) {
        ctx.reporter.error(
          "chartEx-series-missing-axis-id",
          `${path}: cx:series references missing cx:axis id ${attrByLocalName(axisId, "val")}`,
          path
        );
      }
    }
  }

  // externalData (e.g. cx:externalData r:id="...") must resolve in the chart's rels.
  const externalDataRids = collectDescendantsLocal(root, "externalData")
    .map(el => attrByLocalName(el, "id"))
    .filter((id): id is string => !!id);
  if (externalDataRids.length > 0) {
    const relsPath = chartRelsPath(path);
    const rels = ctx.readRels(relsPath);
    for (const rid of externalDataRids) {
      if (!rels.byId.has(rid)) {
        ctx.reporter.error(
          "chartEx-externalData-missing-rel",
          `${path}: cx:externalData references missing relationship ${rid}`,
          path
        );
      }
    }
  }

  // Schema-conformance checks: text-form violations of typed elements,
  // invalid `<cx:auto/>` element, `<cx:paretoLine>` in layoutPr, and
  // direct `<cx:layout>` child of `<cx:title>`.
  checkTypedElementAttrForm(ctx, path, root);
  checkInvalidAutoElement(ctx, path, root);
  checkParetoLineInLayoutPr(ctx, path, root);
  checkTitleDirectLayoutChild(ctx, path, root);

  // Tier-2 semantic checks.
  checkAxisPosAndType(ctx, path, root);
  checkSeriesFDefinedName(ctx, path, root);
  checkWaterfallSubtotals(ctx, path, root);
}

/**
 * `<cx:axisId>`, `<cx:dataId>`, `<cx:binCount>`, `<cx:binSize>` and
 * their siblings use the `val="N"` attribute form. Earlier writer
 * revisions serialised them as text content (`<cx:axisId>2</cx:axisId>`),
 * which Excel's strict loader rejects. Flag every occurrence so the
 * output never regresses to the broken shape.
 */
const TYPED_ATTR_ONLY_ELEMENTS: readonly string[] = ["axisId", "dataId", "binCount", "binSize"];

function checkTypedElementAttrForm(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const name of TYPED_ATTR_ONLY_ELEMENTS) {
    for (const el of collectDescendantsLocal(root, name)) {
      if (ctx.reporter.capped) {
        return;
      }
      const val = attrByLocalName(el, "val");
      const text = directTextContent(el).trim();
      // Missing `val` AND present non-empty text = the broken text-form.
      if (val === undefined && text.length > 0) {
        ctx.reporter.error(
          "chartEx-typed-element-text-form",
          `${path}: <cx:${name}>${text}</cx:${name}> uses text-content form; schema requires val="${text}" attribute.`,
          path
        );
      }
    }
  }
}

/**
 * `<cx:auto/>` is NOT a valid element — auto binning is expressed by
 * the absence of both `binSize` and `binCount` inside `<cx:binning>`.
 * A literal `<cx:auto/>` tag anywhere in the chartEx makes Excel drop
 * the part on load.
 */
function checkInvalidAutoElement(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const _el of collectDescendantsLocal(root, "auto")) {
    if (ctx.reporter.capped) {
      return;
    }
    ctx.reporter.error(
      "chartEx-invalid-auto-element",
      `${path}: <cx:auto/> element is not in the chartEx schema. ` +
        `Auto binning is expressed by omitting both <cx:binSize> and <cx:binCount>.`,
      path
    );
  }
}

/**
 * `<cx:paretoLine>` is not a child of `<cx:layoutPr>` in the schema.
 * A real pareto chart expresses the line as a second `<cx:series>` with
 * `layoutId="paretoLine"`. The mis-placed child made earlier Excel
 * builds reject the chartEx.
 */
function checkParetoLineInLayoutPr(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const lp of collectDescendantsLocal(root, "layoutPr")) {
    if (ctx.reporter.capped) {
      return;
    }
    const pl = findChildLocal(lp, "paretoLine");
    if (pl) {
      ctx.reporter.error(
        "chartEx-paretoLine-in-layoutPr",
        `${path}: <cx:paretoLine> is not a valid child of <cx:layoutPr>. ` +
          `Add a second <cx:series layoutId="paretoLine"/> instead.`,
        path
      );
    }
  }
}

/**
 * `<cx:title><cx:layout/></cx:title>` is schema-invalid. Title layout
 * lives in `extLst`-based extensions or (in some clients) `<cx:offset>`
 * — never as a direct `<cx:layout>` child.
 */
function checkTitleDirectLayoutChild(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const title of collectDescendantsLocal(root, "title")) {
    if (ctx.reporter.capped) {
      return;
    }
    const layout = findChildLocal(title, "layout");
    if (layout) {
      ctx.reporter.error(
        "chartEx-title-direct-layout",
        `${path}: <cx:title> has a direct <cx:layout> child. Title layout ` +
          `information belongs in extLst-based extensions.`,
        path
      );
    }
  }
}

/**
 * Concatenate direct text/cdata children of an element, ignoring any
 * nested elements. Useful for "typed element with stray text content"
 * detection where a nested element's text should NOT count as the
 * offending text form.
 */
function directTextContent(el: XmlElement): string {
  let out = "";
  for (const child of el.children) {
    if (child.type === "text" || child.type === "cdata") {
      out += child.value;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Tier-2 semantic checks
// -----------------------------------------------------------------------------

/**
 * `<cx:axis>` must declare its axis role — either via a structural
 * `<cx:catScaling>` / `<cx:valScaling>` CHILD element (the form Excel
 * itself emits; the role is inferred from which scaling child is
 * present) OR via legacy `pos` / `type` attributes. When NONE of
 * these are present, Excel's loader cannot disambiguate the axis
 * role and drops the whole `<cx:chartSpace>` on open, cascading
 * into "Removed Part: /xl/charts/chartExN.xml".
 *
 * Verified against Excel 2021's own output (`tmp/aaaaa.xlsx`,
 * `tmp/ttttt.xlsx`): every `<cx:axis>` it emits omits the
 * `pos` / `type` attributes and relies on the scaling child.
 */
function checkAxisPosAndType(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const axis of collectDescendantsLocal(root, "axis")) {
    if (ctx.reporter.capped) {
      return;
    }
    const pos = attrByLocalName(axis, "pos");
    const type = attrByLocalName(axis, "type");
    const id = attrByLocalName(axis, "id") ?? "?";
    // Accept either legacy attribute form OR the schema-native
    // `<cx:catScaling>` / `<cx:valScaling>` child.
    const hasCatScaling = axis.children.some(
      c => c.type === "element" && matchesLocal(c.name, "catScaling")
    );
    const hasValScaling = axis.children.some(
      c => c.type === "element" && matchesLocal(c.name, "valScaling")
    );
    if (pos === undefined && type === undefined && !hasCatScaling && !hasValScaling) {
      ctx.reporter.error(
        "chartEx-axis-missing-pos-and-type",
        `${path}: <cx:axis id="${id}"> has no role marker — emit either a ` +
          `<cx:catScaling>/<cx:valScaling> child (preferred, matches Excel) ` +
          `or a pos/type attribute. Excel's loader drops the chartEx otherwise.`,
        path
      );
    }
  }
}

/**
 * `<cx:f>` formulas must point at hidden defined names (the
 * `_xlchart.v1.0`, `_xlchart.v1.1`, … convention Excel itself uses),
 * NOT directly at worksheet ranges. A bare `<cx:f>Sheet1!$A$1:$A$3</cx:f>`
 * is rejected on open with "Removed Part: /xl/drawings/drawingN.xml".
 *
 * Detection heuristic: a formula body that contains `!$` or `!` followed
 * by absolute cell references is a direct sheet reference. Defined-name
 * references are bare identifiers like `_xlchart.v1.0` (no `!`).
 */
function checkSeriesFDefinedName(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const f of collectDescendantsLocal(root, "f")) {
    if (ctx.reporter.capped) {
      return;
    }
    const formula = directTextContent(f).trim();
    if (formula === "") {
      continue;
    }
    // Heuristic for a direct sheet-qualified range:
    //   - Contains "!" (sheet qualifier), AND
    //   - Does NOT start with `_xl` or other defined-name prefix.
    if (!formula.includes("!")) {
      continue; // bare defined name like `_xlchart.v1.0`
    }
    if (formula.startsWith("_xlchart.") || formula.startsWith("_xlfn.")) {
      continue; // defined-name-qualified alias
    }
    // Looks like `Sheet1!$A$1:$A$3` or `'Some Name'!$A$1`.
    ctx.reporter.error(
      "chartEx-f-uses-direct-range-not-defined-name",
      `${path}: <cx:f>${formula}</cx:f> points at a worksheet range directly. ` +
        `ChartEx requires an indirection through hidden defined names ` +
        `(e.g. _xlchart.v1.0) — otherwise Excel 2016+ drops the chartEx part on load.`,
      path
    );
  }
}

/**
 * Waterfall charts must have `layoutPr.subtotals` on their series —
 * even empty `<cx:subtotals/>` is meaningful: it marks the plot as
 * subtotals-aware. Without it Excel falls back to generic series
 * rendering and has been observed to reject the chartEx as malformed
 * at load time.
 */
function checkWaterfallSubtotals(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const series of collectDescendantsLocal(root, "series")) {
    if (ctx.reporter.capped) {
      return;
    }
    const layoutId = attrByLocalName(series, "layoutId");
    if (layoutId !== "waterfall") {
      continue;
    }
    const layoutPr = findChildLocal(series, "layoutPr");
    const hasSubtotals = !!layoutPr && findChildLocal(layoutPr, "subtotals") !== undefined;
    if (!hasSubtotals) {
      ctx.reporter.error(
        "chartEx-waterfall-missing-subtotals",
        `${path}: waterfall series has no <cx:layoutPr><cx:subtotals/> marker. ` +
          `Emit the element (even empty) so Excel renders the series as ` +
          `waterfall-aware instead of rejecting the chartEx.`,
        path
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Series child order — context-aware, since `c:ser` has a different
// content model under each chart-type element (CT_BarSer, CT_LineSer,
// CT_PieSer, CT_AreaSer, CT_ScatterSer, CT_BubbleSer, CT_RadarSer,
// CT_SurfaceSer). See {@link SERIES_ORDER_RULES} for the table.
// -----------------------------------------------------------------------------

function checkSeriesChildOrder(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const rule of SERIES_ORDER_RULES) {
    for (const chartType of rule.chartTypes) {
      for (const group of collectDescendantsLocal(root, chartType)) {
        for (const series of findChildrenLocal(group, "ser")) {
          if (ctx.reporter.capped) {
            return;
          }
          const children = series.children.filter(c => c.type === "element") as XmlElement[];
          let lastRank = -1;
          let lastTag = "";
          for (const child of children) {
            const name = localName(child.name);
            const rank = rule.order.indexOf(name);
            if (rank < 0) {
              continue;
            }
            if (rank < lastRank) {
              ctx.reporter.error(
                "chart-child-out-of-order",
                `${path}: <c:ser> inside <c:${chartType}> has <c:${name}> after <c:${lastTag}>; CT_${seriesTypeNameFor(chartType)}Ser requires <c:${name}> earlier in the sequence.`,
                path
              );
            }
            if (rank >= lastRank) {
              lastRank = rank;
              lastTag = name;
            }
          }
        }
      }
    }
  }
}

/** Map a chart-type tag to the series content-type short name. */
function seriesTypeNameFor(chartType: string): string {
  if (chartType.startsWith("bar")) {
    return "Bar";
  }
  if (chartType.startsWith("line") || chartType === "stockChart") {
    return "Line";
  }
  if (chartType.startsWith("pie") || chartType === "doughnutChart" || chartType === "ofPieChart") {
    return "Pie";
  }
  if (chartType.startsWith("area")) {
    return "Area";
  }
  if (chartType === "scatterChart") {
    return "Scatter";
  }
  if (chartType === "bubbleChart") {
    return "Bubble";
  }
  if (chartType === "radarChart") {
    return "Radar";
  }
  if (chartType.startsWith("surface")) {
    return "Surface";
  }
  return chartType;
}

// -----------------------------------------------------------------------------
// axId cross-reference resolution — every `c:axId` inside a chart-type
// element must match one of the axis `c:axId` values in the enclosing
// plot area; every axis `c:crossAx` must reference another axis in
// the same plot area. Unresolved references are schema-valid (they
// parse) but produce charts Excel renders with phantom / missing
// axes — a common symptom when combo charts are hand-edited.
// -----------------------------------------------------------------------------

const ALL_CHART_TYPE_NAMES = new Set(CT_CHART_TYPE_TAGS);
const ALL_AXIS_NAMES = new Set(CT_AXIS_TAGS);

function checkAxIdResolution(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const plotArea of collectDescendantsLocal(root, "plotArea")) {
    if (ctx.reporter.capped) {
      return;
    }
    // Gather every axis axId declared in this plot area.
    const axisIds = new Set<string>();
    for (const child of plotArea.children) {
      if (child.type !== "element") {
        continue;
      }
      const name = localName(child.name);
      if (!ALL_AXIS_NAMES.has(name)) {
        continue;
      }
      const axIdEl = findChildLocal(child, "axId");
      const val = axIdEl ? attrByLocalName(axIdEl, "val") : undefined;
      if (val !== undefined) {
        axisIds.add(val);
      }
    }
    // Chart-type groups must reference an axis that exists.
    for (const child of plotArea.children) {
      if (child.type !== "element") {
        continue;
      }
      const name = localName(child.name);
      if (!ALL_CHART_TYPE_NAMES.has(name)) {
        continue;
      }
      for (const axIdEl of findChildrenLocal(child, "axId")) {
        const val = attrByLocalName(axIdEl, "val");
        if (val === undefined) {
          continue;
        }
        if (!axisIds.has(val)) {
          ctx.reporter.error(
            "chart-axid-unresolved",
            `${path}: <c:${name}> references <c:axId val="${val}"> but no matching axis exists in the enclosing <c:plotArea>.`,
            path
          );
        }
      }
    }
    // Each axis's `crossAx` must resolve to another axis in the
    // same plot area.
    for (const child of plotArea.children) {
      if (child.type !== "element") {
        continue;
      }
      const name = localName(child.name);
      if (!ALL_AXIS_NAMES.has(name)) {
        continue;
      }
      const crossAxEl = findChildLocal(child, "crossAx");
      const val = crossAxEl ? attrByLocalName(crossAxEl, "val") : undefined;
      if (val !== undefined && !axisIds.has(val)) {
        ctx.reporter.error(
          "chart-axid-unresolved",
          `${path}: <c:${name}> has <c:crossAx val="${val}"> but no matching axis exists in the enclosing <c:plotArea>.`,
          path
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// ErrBars conditional children — `c:val` is required when
// `c:errValType` is NOT "cust", and forbidden when it IS. `c:plus`
// and `c:minus` are required for custom error bars and forbidden
// otherwise. stdErr allows `c:val` to be absent (Excel defaults to
// 1) so we skip the required-child check for that type.
// -----------------------------------------------------------------------------

function checkErrBarsConditionalChildren(
  ctx: ValidationContext,
  path: string,
  root: XmlElement
): void {
  for (const eb of collectDescendantsLocal(root, "errBars")) {
    if (ctx.reporter.capped) {
      return;
    }
    const typeEl = findChildLocal(eb, "errValType");
    const type = typeEl ? attrByLocalName(typeEl, "val") : undefined;
    const hasVal = findChildLocal(eb, "val") !== undefined;
    const hasPlus = findChildLocal(eb, "plus") !== undefined;
    const hasMinus = findChildLocal(eb, "minus") !== undefined;
    if (type === "cust") {
      if (!hasPlus || !hasMinus) {
        ctx.reporter.error(
          "chart-missing-required-child",
          `${path}: <c:errBars> with <c:errValType val="cust"> requires both <c:plus> and <c:minus> children.`,
          path
        );
      }
      if (hasVal) {
        ctx.reporter.error(
          "chart-forbidden-child",
          `${path}: <c:errBars> with <c:errValType val="cust"> must not contain <c:val>; use <c:plus> / <c:minus> for custom bounds.`,
          path
        );
      }
    } else if (type === "fixedVal" || type === "percentage" || type === "stdDev") {
      if (!hasVal) {
        ctx.reporter.error(
          "chart-missing-required-child",
          `${path}: <c:errBars> with <c:errValType val="${type}"> requires a <c:val> child.`,
          path
        );
      }
      if (hasPlus || hasMinus) {
        ctx.reporter.error(
          "chart-forbidden-child",
          `${path}: <c:errBars> with <c:errValType val="${type}"> must not contain <c:plus> or <c:minus> — those belong to "cust" only.`,
          path
        );
      }
    }
    // `stdErr` leaves `val` optional and disallows plus/minus — enforce
    // the disallowed side only.
    if (type === "stdErr" && (hasPlus || hasMinus)) {
      ctx.reporter.error(
        "chart-forbidden-child",
        `${path}: <c:errBars> with <c:errValType val="stdErr"> must not contain <c:plus> or <c:minus>.`,
        path
      );
    }
  }
}

// -----------------------------------------------------------------------------
// CT_Tx / CT_SerTx choice exclusivity — `c:tx` is
// `choice(strRef | rich)` at chart / axis / legend-entry level and
// `choice(strRef | v)` at series level. Having more than one branch
// is a schema violation; Excel silently keeps the first and drops
// the rest, so the feature authors intended gets lost on save.
// -----------------------------------------------------------------------------

function checkTxChoice(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const tx of collectDescendantsLocal(root, "tx")) {
    if (ctx.reporter.capped) {
      return;
    }
    const hasStrRef = findChildLocal(tx, "strRef") !== undefined;
    const hasRich = findChildLocal(tx, "rich") !== undefined;
    const hasV = findChildLocal(tx, "v") !== undefined;
    const branches = [hasStrRef, hasRich, hasV].filter(Boolean).length;
    // Zero branches is tolerated by Excel (auto-generated title / blank
    // series name) — we intentionally don't flag it to avoid noise on
    // round-tripped files. More than one branch is a real schema
    // violation.
    if (branches > 1) {
      ctx.reporter.error(
        "chart-child-out-of-order",
        `${path}: <c:tx> must contain at most one of <c:strRef>, <c:rich>, or <c:v>; found ${branches} branches.`,
        path
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Series-child whitelist — every `c:ser` element may only contain
// children declared in its per-chart-type CT_*Ser content model.
// Elements from the global "known chart child" set that aren't
// declared for this parent are schema violations even though the
// tag name is otherwise valid OOXML. Catches e.g. `<c:bubbleSize>`
// inside a `<c:barChart>` series, `<c:explosion>` inside a line
// series, or `<c:smooth>` on a bar series.
// -----------------------------------------------------------------------------

/**
 * Union of every element name that appears in at least one
 * `SERIES_ORDER_RULES` entry. A series child inside this set that
 * isn't in the current chart type's allow-list is a schema
 * violation; a child outside this set is probably a vendor
 * extension we should leave alone.
 */
const ALL_KNOWN_SERIES_CHILDREN = new Set<string>(SERIES_ORDER_RULES.flatMap(r => r.order));

function checkSeriesChildWhitelist(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const rule of SERIES_ORDER_RULES) {
    const allowed = new Set(rule.order);
    for (const chartType of rule.chartTypes) {
      for (const group of collectDescendantsLocal(root, chartType)) {
        for (const series of findChildrenLocal(group, "ser")) {
          if (ctx.reporter.capped) {
            return;
          }
          for (const child of series.children) {
            if (child.type !== "element") {
              continue;
            }
            const name = localName(child.name);
            if (!ALL_KNOWN_SERIES_CHILDREN.has(name)) {
              continue; // unknown tag — vendor extension, leave alone
            }
            if (!allowed.has(name)) {
              ctx.reporter.error(
                "chart-forbidden-child",
                `${path}: <c:ser> inside <c:${chartType}> contains <c:${name}>, which is not in CT_${seriesTypeNameFor(chartType)}Ser's schema.`,
                path
              );
            }
          }
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// `<a:srgbClr val>` — CT_SRgbColor requires a 6-hex-digit value.
// Excel reliably ignores malformed colours; callers pay the cost of
// a silently-grey series. Matches uppercase and lowercase hex.
// -----------------------------------------------------------------------------

const SRGB_HEX_RE = /^[0-9A-Fa-f]{6}$/;

function checkSrgbClrFormat(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const el of collectDescendantsLocal(root, "srgbClr")) {
    if (ctx.reporter.capped) {
      return;
    }
    const val = attrByLocalName(el, "val");
    if (val === undefined) {
      ctx.reporter.error(
        "chart-missing-required-child",
        `${path}: <a:srgbClr> is missing the required val attribute.`,
        path
      );
      continue;
    }
    if (!SRGB_HEX_RE.test(val)) {
      ctx.reporter.error(
        "chart-invalid-enum-value",
        `${path}: <a:srgbClr val="${val}"> must be a 6-digit hex colour (e.g. "4472C4").`,
        path
      );
    }
  }
}

// -----------------------------------------------------------------------------
// `<c:numFmt formatCode>` is required by CT_NumFmt. The OOXML
// serialiser always emits it, but round-tripped / hand-edited files
// sometimes drop the attribute; Excel falls back to "General" and
// loses the author's intended format.
// -----------------------------------------------------------------------------

function checkNumFmtFormatCode(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const el of collectDescendantsLocal(root, "numFmt")) {
    if (ctx.reporter.capped) {
      return;
    }
    const formatCode = attrByLocalName(el, "formatCode");
    if (formatCode === undefined) {
      ctx.reporter.error(
        "chart-missing-required-child",
        `${path}: <c:numFmt> is missing the required formatCode attribute.`,
        path
      );
    }
  }
}

// -----------------------------------------------------------------------------
// `<c:rich>` wraps a DrawingML `CT_TextBody`: required children are
// `<a:bodyPr>` (first, exactly 1) and `<a:p>` (1+). The list style
// `<a:lstStyle>` is optional and goes between them. Without
// `<a:bodyPr>` or `<a:p>` Excel renders the title / label blank.
// -----------------------------------------------------------------------------

function checkRichStructure(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const rich of collectDescendantsLocal(root, "rich")) {
    if (ctx.reporter.capped) {
      return;
    }
    const hasBodyPr = findChildLocal(rich, "bodyPr") !== undefined;
    const paragraphs = findChildrenLocal(rich, "p").length;
    if (!hasBodyPr) {
      ctx.reporter.error(
        "chart-missing-required-child",
        `${path}: <c:rich> is missing the required <a:bodyPr> child (CT_TextBody requires it first).`,
        path
      );
    }
    if (paragraphs === 0) {
      ctx.reporter.error(
        "chart-missing-required-child",
        `${path}: <c:rich> has no <a:p> children; CT_TextBody requires at least one paragraph.`,
        path
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Cross-part references
//
// These checks leave the chart XML boundary and validate links
// against sibling parts in the xlsx package:
//   - `<a:schemeClr val>` must reference a colour slot actually
//     declared in `xl/theme/theme1.xml`'s `<a:clrScheme>`.
//   - `<c:f>` formula bodies must parse as a valid cell reference,
//     range, or defined-name identifier.
//   - `<c:f>` defined-name references must resolve against
//     `xl/workbook.xml`'s `<definedNames>` or be a reserved
//     Excel-internal name (`_xlnm.*`, `_xlchart.*`, `_xlfn.*`).
// -----------------------------------------------------------------------------

/**
 * Theme's `<a:clrScheme>` declares twelve colour slots under the
 * short names `dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink`. The
 * four workbook-facing aliases (`bg1, tx1, bg2, tx2`) resolve through
 * `<a:clrMap>` — the default Office map is `bg1=lt1, tx1=dk1,
 * bg2=lt2, tx2=dk2`. `phClr` is a run-time placeholder that's always
 * valid. Anything else is theme-missing.
 */
const SCHEME_COLOR_ALIASES: Record<string, string> = {
  bg1: "lt1",
  tx1: "dk1",
  bg2: "lt2",
  tx2: "dk2"
};

function collectThemeColorSlots(ctx: ValidationContext): Set<string> | undefined {
  const dom = ctx.readDom("xl/theme/theme1.xml");
  if (!dom) {
    return undefined;
  }
  const clrScheme = findFirstDescendantLocal(dom.root, "clrScheme");
  if (!clrScheme) {
    return undefined;
  }
  const slots = new Set<string>();
  for (const child of clrScheme.children) {
    if (child.type === "element") {
      slots.add(localName(child.name));
    }
  }
  return slots;
}

function findFirstDescendantLocal(root: XmlElement, local: string): XmlElement | undefined {
  const hits = collectDescendantsLocal(root, local);
  return hits.length > 0 ? hits[0] : undefined;
}

function checkThemeSchemeColorSlots(ctx: ValidationContext, path: string, root: XmlElement): void {
  const slots = collectThemeColorSlots(ctx);
  // Skip silently when the theme is absent or doesn't declare a
  // `<a:clrScheme>`: either situation is flagged by the content-
  // types / relationships checkers and we'd just produce duplicate
  // noise here. We also skip when the slot set is empty — that
  // would reject every `schemeClr` reference as "missing" which
  // isn't the author's mistake.
  if (!slots || slots.size === 0) {
    return;
  }
  for (const el of collectDescendantsLocal(root, "schemeClr")) {
    if (ctx.reporter.capped) {
      return;
    }
    const val = attrByLocalName(el, "val");
    if (!val) {
      continue;
    }
    if (val === "phClr") {
      continue; // placeholder colour — always valid at run time
    }
    const resolved = SCHEME_COLOR_ALIASES[val] ?? val;
    if (!slots.has(resolved)) {
      ctx.reporter.error(
        "chart-theme-missing-schemeClr-slot",
        `${path}: <a:schemeClr val="${val}"> references theme slot <a:${resolved}> which is not declared in xl/theme/theme1.xml's <a:clrScheme>.`,
        path
      );
    }
  }
}

/**
 * `<c:f>` bodies used by classic charts come in several flavours:
 *   - `Sheet1!$A$1[:$B$2]`     — qualified cell / range
 *   - `'Quoted Sheet'!$A$1`    — quoted sheet with spaces / specials
 *   - `DefinedName`            — bare defined-name identifier
 *   - `Sheet1!LocalName`       — sheet-qualified defined name
 *   - `TableName[ColumnName]`  — Excel structured reference
 *   - `TableName[[#Headers],[Col]]` — structured ref with specifier
 *   - `(f1,f2)`                — multi-range (scatter / combo)
 *   - `SUM(A1:A10)`            — function call (rare but valid)
 *   - `_xl*.*`                 — reserved Excel-internal prefix
 *     (`_xlnm.Print_Area`, `_xlchart.v1.0`, `_xlfn.IFS`…)
 *
 * Full formula parsing would require the `@formula` tokenizer;
 * instead we apply a structural sanity check (balanced brackets /
 * parens / quotes, non-empty body) plus quick classification for
 * the two common forms that route into the defined-name resolver
 * (`bare identifier` and `Sheet!identifier`). Everything else is
 * assumed to be a valid complex expression — false-negatives here
 * are preferable to flagging legitimate structured references like
 * `Transactions[Revenue]`.
 */

/** Cell or range reference like `A1`, `$A$1`, or `A1:B10`. */
const A1_REF_RE = /^\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?$/;

/** Unicode-aware identifier regex matching Excel defined-name rules. */
const IDENTIFIER_RE = /^[A-Za-z_\\\u00C0-\uFFFF][A-Za-z0-9_.\\\u00C0-\uFFFF]*$/;

interface ParsedFormulaBody {
  kind: "invalid" | "cell" | "range" | "name" | "special";
  /** When `kind === "name"`, the defined-name identifier. */
  name?: string;
}

/**
 * Balanced-bracket / paren / quote check — returns `false` when
 * the formula is syntactically broken (unclosed bracket, orphan
 * quote, etc.). Excel silently swallows such formulas on open; the
 * chart loses its backing data.
 */
function isFormulaBalanced(body: string): boolean {
  let parens = 0;
  let brackets = 0;
  let inQuote = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'") {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) {
      continue;
    }
    if (c === "(") {
      parens++;
    } else if (c === ")") {
      parens--;
    } else if (c === "[") {
      brackets++;
    } else if (c === "]") {
      brackets--;
    }
    if (parens < 0 || brackets < 0) {
      return false;
    }
  }
  return parens === 0 && brackets === 0 && !inQuote;
}

function parseCFBody(raw: string): ParsedFormulaBody {
  let body = raw.trim();
  if (body.startsWith("=")) {
    body = body.substring(1).trim();
  }
  if (body === "") {
    return { kind: "invalid" };
  }
  if (!isFormulaBalanced(body)) {
    return { kind: "invalid" };
  }
  // `_xl`-prefixed names are reserved: `_xlnm.*`, `_xlchart.*`,
  // `_xlfn.*`. Always treat as valid without cross-reference.
  if (body.startsWith("_xl")) {
    return { kind: "special" };
  }
  // Expressions wrapped in parens cover multi-range references
  // (`(Sheet1!$A$1:$A$5,Sheet1!$C$1:$C$5)` on scatter / combo charts)
  // and function-call formulas (`SUM(A1:A10)`). The balanced-bracket
  // check above already caught unclosed parens; the full inner
  // grammar is out of scope for this schema check, so trust the
  // author and skip.
  if (body.startsWith("(")) {
    return { kind: "special" };
  }
  // Bare defined-name identifier (no punctuation, no !).
  if (IDENTIFIER_RE.test(body)) {
    return { kind: "name", name: body };
  }
  // Sheet-qualified form `Sheet!xxx`. Only classify as a defined-
  // name reference when the RHS is a pure identifier — structured
  // refs like `Table[Col]` or cell ranges like `$A$1:$B$10` route
  // through the generic "special" bucket so the defined-name check
  // skips them.
  const bangIdx = body.indexOf("!");
  if (bangIdx >= 0) {
    const sheet = body.substring(0, bangIdx);
    const ref = body.substring(bangIdx + 1);
    const sheetValid =
      (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 3) ||
      IDENTIFIER_RE.test(sheet);
    if (!sheetValid || ref === "") {
      return { kind: "invalid" };
    }
    if (A1_REF_RE.test(ref)) {
      return { kind: ref.includes(":") ? "range" : "cell" };
    }
    // Reserved `_xl*` names also appear sheet-qualified
    // (`Sheet1!_xlchart.v1.0`). Treat them as special regardless of
    // which side of the `!` they sit on.
    if (ref.startsWith("_xl")) {
      return { kind: "special" };
    }
    if (IDENTIFIER_RE.test(ref)) {
      return { kind: "name", name: ref };
    }
    // Anything else (structured table ref, function call, complex
    // expression) — assume valid, skip further validation.
    return { kind: "special" };
  }
  // Unqualified and not a bare identifier: could be a structured
  // reference (`Table[Col]`, `Table[#All]`) or an expression. Both
  // legal in `<c:f>`; accept without further validation.
  return { kind: "special" };
}

function extractTextContent(el: XmlElement): string {
  let out = "";
  for (const child of el.children) {
    if (child.type === "text" || child.type === "cdata") {
      out += child.value;
    }
  }
  return out;
}

function checkFormulaSyntax(ctx: ValidationContext, path: string, root: XmlElement): void {
  for (const f of collectDescendantsLocal(root, "f")) {
    if (ctx.reporter.capped) {
      return;
    }
    const body = extractTextContent(f);
    const parsed = parseCFBody(body);
    if (parsed.kind === "invalid") {
      ctx.reporter.error(
        "chart-f-invalid-syntax",
        `${path}: <c:f>${body}</c:f> is not a valid cell reference, range, or defined name.`,
        path
      );
    }
  }
}

/**
 * Collect every defined-name declared in `xl/workbook.xml`, plus the
 * well-known built-in reserved names that don't appear in the file
 * but Excel always recognises (`_xlnm.*` family).
 */
function collectWorkbookDefinedNames(ctx: ValidationContext): Set<string> {
  const names = new Set<string>();
  // Built-in reserved names Excel treats as always-defined.
  names.add("_xlnm.Print_Area");
  names.add("_xlnm.Print_Titles");
  names.add("_xlnm.Database");
  names.add("_xlnm.Criteria");
  names.add("_xlnm.Extract");
  names.add("_xlnm.Sheet_Title");
  names.add("_xlnm._FilterDatabase");
  names.add("_xlnm.Auto_Open");
  names.add("_xlnm.Auto_Close");
  const dom = ctx.readDom("xl/workbook.xml");
  if (!dom) {
    return names;
  }
  for (const dn of collectDescendantsLocal(dom.root, "definedName")) {
    const name = attrByLocalName(dn, "name");
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function checkDefinedNameResolution(ctx: ValidationContext, path: string, root: XmlElement): void {
  let names: Set<string> | undefined;
  for (const f of collectDescendantsLocal(root, "f")) {
    if (ctx.reporter.capped) {
      return;
    }
    const body = extractTextContent(f);
    const parsed = parseCFBody(body);
    if (parsed.kind !== "name" || !parsed.name) {
      continue;
    }
    // Lazily load the workbook's defined names on first need.
    if (!names) {
      names = collectWorkbookDefinedNames(ctx);
    }
    if (!names.has(parsed.name)) {
      ctx.reporter.error(
        "chart-f-undefined-name",
        `${path}: <c:f>${body}</c:f> references defined name "${parsed.name}" but no matching <definedName> exists in xl/workbook.xml.`,
        path
      );
    }
  }
}

function chartRelsPath(chartPath: string): string {
  const slash = chartPath.lastIndexOf("/");
  const dir = slash >= 0 ? chartPath.slice(0, slash) : "";
  const name = slash >= 0 ? chartPath.slice(slash + 1) : chartPath;
  return dir ? `${dir}/_rels/${name}.rels` : `_rels/${name}.rels`;
}
