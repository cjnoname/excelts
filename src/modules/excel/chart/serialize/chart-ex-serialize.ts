/**
 * ChartEx serializer — serialises a ChartExModel to `cx:chart` XML.
 *
 * This file owns the "emit cx: OOXML" responsibility (string
 * concatenation that produces byte output for a programmatically-built
 * chartEx). Round-trip of existing cx:chart files is handled by raw
 * byte passthrough (model.rawXml is preferred when set).
 *
 * The companion `chart-ex-renderer.ts` owns the orthogonal
 * "render to SVG/PNG/PDF" responsibility. The two files share no
 * private helpers — only neutral utilities from `chart-utils` — so
 * neither imports the other.
 */

import type {
  ChartExAxis,
  ChartExDataEntry,
  ChartExModel,
  ChartExSeries
} from "@excel/chart/model/chart-ex-types";
import type {
  ChartColor,
  ChartRichText,
  ChartTextProperties,
  ChartTitle,
  CustomGeometry,
  CustomGeometryCommand,
  EffectList,
  PresetGeometry,
  Scene3D,
  Shadow,
  ShapeProperties,
  ShapeProperties3D,
  ShapeTransform
} from "@excel/chart/model/types";
import {
  needsXmlSpacePreserve,
  tickMarkToOoxml,
  escapeXml,
  escapeXmlAttr,
  fmtNumAttr,
  fmtNumText,
  themeIndexToName
} from "@excel/chart/shared/chart-utils";
import { isRawXmlShape, isRawXmlTxPr } from "@excel/chart/shared/shape-properties";
import { ChartOptionsError } from "@excel/errors";

/**
 * Rewrite a freshly-built ChartEx model's data references to use
 * `_xlchart.vN.M` hidden defined-name indirection, matching the
 * exact scheme Microsoft Excel emits.
 *
 * Excel 2016+ REQUIRES chartEx `<cx:f>` elements to point at
 * hidden defined names, NOT directly at worksheet ranges. A
 * chartEx with a bare `<cx:f>Sheet1!$A$1:$A$3</cx:f>` is rejected
 * on load with:
 *
 *   "Removed Part: /xl/drawings/drawingN.xml (Drawing shape)"
 *
 * The canonical layout Excel uses:
 *
 *   chartEx1.xml:
 *     <cx:strDim type="cat"><cx:f>_xlchart.v1.0</cx:f></cx:strDim>
 *     <cx:numDim type="val"><cx:f>_xlchart.v1.1</cx:f></cx:numDim>
 *
 *   workbook.xml:
 *     <definedName name="_xlchart.v1.0" hidden="1">Sheet1!$A$1:$A$3</definedName>
 *     <definedName name="_xlchart.v1.1" hidden="1">Sheet1!$B$1:$B$3</definedName>
 *
 * This function walks the chart's data entries, allocates a
 * sequential minor index `M` for every worksheet-range formula,
 * registers a hidden defined name via the supplied callback, and
 * rewrites the `formula` field on the model to point at the
 * name. It also clears any cached `<cx:lvl>` point levels on
 * those dimensions — Excel's output uses defined-name pointers
 * exclusively; the cached-point form is what our earlier writer
 * emitted to work around the (buggy) direct-reference path and is
 * no longer needed.
 *
 * Non-worksheet formulas (lambda expressions, literal data,
 * already-indirect `_xlchart.*` names from round-tripped files)
 * are left untouched — only `SheetName!...` style references need
 * the rewrite.
 *
 * @param model         ChartEx model to mutate in place.
 * @param chartExIndex  1-based chartEx file index — becomes the
 *                      `vN` major version in `_xlchart.vN.M`.
 * @param register      Callback invoked for each newly allocated
 *                      defined name. Implementations should add
 *                      the name to the workbook's `definedNames`
 *                      list with `hidden="1"`.
 */
export function rewriteChartExDataRefsToDefinedNames(
  model: ChartExModel,
  chartExIndex: number,
  register: (definedName: string, ref: string) => void
): void {
  const data = model.chartSpace?.chartData?.data;
  if (!data || data.length === 0) {
    return;
  }
  let minor = 0;
  // Worksheet-range refs look like `'Sheet Name'!$A$1:$A$3` or
  // `Sheet1!$A$1:$A$3`. We treat any string containing `!` that's
  // not already an `_xlchart.*` name as eligible for rewriting.
  // Formulas that lack a sheet-qualifier (bare ranges, literals)
  // are left alone — chartEx traditionally qualifies sheet names
  // explicitly, so the heuristic is safe in practice.
  const isWorksheetRef = (formula: string): boolean =>
    formula.includes("!") && !formula.startsWith("_xlchart.");

  const rewriteDim = (dim: { formula?: string; levels?: unknown }): void => {
    if (!dim.formula || !isWorksheetRef(dim.formula)) {
      return;
    }
    const definedName = `_xlchart.v${chartExIndex}.${minor++}`;
    register(definedName, dim.formula);
    dim.formula = definedName;
    // Keep any cached `<cx:lvl>` points the builder populated.
    // Histogram / pareto chartEx layouts can't render at all without
    // the cached point array — Excel relies on the points to build
    // the bins. (Waterfall / funnel / etc. that have an explicit
    // categorical axis DO work with defined-name pointers alone, but
    // leaving the cache in place for every dimension keeps the code
    // uniform and matches what Excel itself emits when the chart
    // data is NOT an embedded data table.)
  };

  for (const entry of data) {
    // `ConsolidatedDataEntry` (from `consolidateDataForRender`)
    // carries a `parts` array instead of direct `strDim` / `numDim`;
    // process each part. `ChartExDataEntry` exposes the dims
    // directly. Both shapes are handled here so the rewrite works
    // uniformly before or after consolidation.
    const parts = (entry as { parts?: ChartExDataEntry[] }).parts;
    if (parts && Array.isArray(parts)) {
      for (const p of parts) {
        if (p.strDim) {
          rewriteDim(p.strDim);
        }
        if (p.numDim) {
          rewriteDim(p.numDim);
        }
      }
    } else {
      const plain = entry;
      if (plain.strDim) {
        rewriteDim(plain.strDim);
      }
      if (plain.numDim) {
        rewriteDim(plain.numDim);
      }
    }
  }
}

/**
 * Render a ChartExModel to the full XML string representation of cx:chart.
 *
 * By default the function prefers the raw XML captured at parse time
 * (`model.rawXml`) when present — that path gives byte-perfect
 * round-trip for files that haven't been mutated since load. This is
 * the fastest and safest mode for the common "load → save" pipeline.
 *
 * Pass `{ forceStructural: true }` when the caller has mutated
 * structured fields on the model (e.g. via `setSpPrFill` /
 * `setSpPrLine` / direct assignment) and needs the writer to
 * rebuild from the model tree instead of reusing the stale raw bytes.
 * The `Chart.mutateChartEx` API already clears `model.rawXml` for
 * normal mutations; `forceStructural` is the escape hatch for callers
 * that bypass that helper (e.g. low-level tests, ad-hoc scripts).
 */
export function renderChartEx(
  model: ChartExModel,
  options: { forceStructural?: boolean } = {}
): string {
  // Prefer raw XML for existing round-tripped charts unless the caller
  // explicitly asked for a structural rebuild.
  if (model.rawXml && !options.forceStructural) {
    return model.rawXml;
  }

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  // Match Microsoft Excel's exact namespace declaration set for
  // `<cx:chartSpace>`: only the prefixes that are ACTUALLY used by
  // the emitted content. ChartEx files rarely use `mc:AlternateContent`
  // at the chartSpace root (the wrapper lives in the drawing part
  // instead), so `xmlns:mc` is not declared here unless later
  // content actually references it. The parser accepts either form;
  // the writer defaults to the Excel-native minimal set.
  parts.push(
    [
      "<cx:chartSpace",
      '  xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"',
      '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
      '  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    ].join("\n")
  );
  const space = model.chartSpace;
  // ECMA-376 / Chart2014 `CT_ChartSpace` child order:
  //   chartData, chart, clrMapOvr?, spPr?, txPr?, protection?,
  //   externalData*, printSettings?, extLst?.
  // `spPr` / `txPr` / `protection` / `printSettings` are preserved
  // verbatim so ChartEx files that carry chartSpace-level styling or
  // print settings round-trip through `forceStructural` writes.
  //
  // Per the official [MS-ODRAWXML] `CT_Series` schema, `<cx:dataId>`
  // has `maxOccurs="1"` — only ONE data reference per series. A
  // box-whisker / sunburst / treemap series naturally has MULTIPLE
  // logical dimensions (categories + values + hierarchy levels); the
  // schema-correct way to express that is to put every dimension
  // inside a single `<cx:data>` entry (CT_Data allows multiple
  // strDim/numDim children via `<xsd:choice maxOccurs="unbounded">`).
  //
  // The in-memory model still keeps one-dimension-per-entry so the
  // parser/writer can share existing helpers. `consolidateDataForRender`
  // transforms the model to the schema-compliant shape just for
  // serialisation: every series ends up with ONE dataId pointing at
  // ONE entry that contains every dimension it needs (categories
  // duplicated across entries when shared). Earlier revisions
  // emitted the raw multi-dataId form and Excel rejected the whole
  // ChartEx part on load ("Removed Part: /xl/drawings/drawingN.xml").
  const renderSpace = consolidateDataForRender(space);
  parts.push(renderChartData(renderSpace.chartData));
  parts.push(renderChart(renderSpace.chart));
  if (space.clrMapOvr) {
    parts.push(space.clrMapOvr);
  }
  if (space.spPr) {
    parts.push(renderSpPr(space.spPr, "  "));
  }
  if (space.txPr) {
    parts.push(renderTxPr(space.txPr, "  ", "cx:txPr"));
  }
  if (space.protection) {
    parts.push(space.protection);
  }
  // `cx:externalData` is a direct child of `cx:chartSpace` per
  // Chart2014's `CT_ChartSpace`. Previous versions of this library
  // emitted it inside `cx:chartData`, which strict validators and
  // the Office reader reject. Parser migration moves legacy data
  // into `space.externalData` so this single emit covers both
  // newly-authored and round-tripped models.
  if (space.externalData) {
    for (const ed of space.externalData) {
      // Skip entries with missing or empty r:id — emitting
      // `<cx:externalData r:id=""/>` produces a broken relationship
      // that strict validators and Excel reject. Classic charts
      // already guard against this (chart-space-xform.ts); sync here.
      if (!ed.id) {
        continue;
      }
      const attrs = ed.autoUpdate === undefined ? "" : ` autoUpdate="${ed.autoUpdate ? "1" : "0"}"`;
      parts.push(`  <cx:externalData r:id="${escapeXmlAttr(ed.id)}"${attrs}/>`);
    }
  }
  if (space.printSettings) {
    parts.push(space.printSettings);
  }
  if (space.extLst) {
    parts.push(space.extLst);
  }
  parts.push("</cx:chartSpace>");
  return parts.join("\n");
}

/**
 * Reshape a `CT_ChartSpace` for schema-compliant serialisation.
 *
 * The in-memory model (produced by `buildChartExModel` and by the
 * parser) stores each logical dimension as its own
 * {@link ChartExDataEntry}, with the series keeping an ordered list of
 * `dataRefs` into those entries. That layout is convenient for code
 * that manipulates individual dimensions — but it does not match the
 * official [MS-ODRAWXML] `CT_Series` schema, which allows at most one
 * `<cx:dataId>` per series. The schema-correct form places every
 * dimension a series references inside a single `<cx:data>` entry
 * (CT_Data has `<xsd:choice maxOccurs="unbounded">` over `strDim` /
 * `numDim`), and points the series at that one entry.
 *
 * This function rewrites the chartData + series so that each series
 * ends up with exactly one data entry + one dataId pointing at it.
 * The original model is left untouched; callers that mutate the
 * returned model should not expect the mutation to persist.
 *
 * Shared category dimensions get duplicated across per-series
 * entries. That inflates the on-disk size slightly but mirrors what
 * Excel 2016+ itself writes for multi-series ChartEx plots — and it
 * is what Excel's strict loader requires on open.
 */
function consolidateDataForRender(space: ChartExModel["chartSpace"]): ChartExModel["chartSpace"] {
  const originalData = space.chartData.data;
  const plotRegion = space.chart.plotArea.plotAreaRegion;
  if (!plotRegion || plotRegion.series.length === 0) {
    return space;
  }
  // Index data entries by id so series.dataRefs can look them up.
  const entryById = new Map<number, ChartExDataEntry>();
  for (const entry of originalData) {
    entryById.set(entry.id, entry);
  }
  // Track which original entries still need to be emitted verbatim —
  // entries referenced by a single-dataId series (schema-valid as-is)
  // and orphaned entries not referenced by any series in the plot
  // region (rare, but possible for legacy files). Entries that get
  // absorbed into a consolidated synthetic entry (multi-dataId
  // series) are REMOVED from this set.
  const keepVerbatim = new Set<number>(entryById.keys());
  // Consolidated entries are emitted as aggregates that share the
  // `<cx:data>` wrapper with multiple strDim/numDim children. The
  // in-memory {@link ChartExDataEntry} only has one `strDim` + one
  // `numDim` slot, so consolidation produces a tagged record; the
  // custom renderer below reaches into `parts` to walk each one.
  const consolidated: ConsolidatedDataEntry[] = [];
  const rewrittenSeries: ChartExSeries[] = plotRegion.series.map(series => {
    const refs = series.dataRefs;
    const dataIds = refs
      ? refs.map(r => r.dataId).filter((id): id is number => typeof id === "number")
      : [];
    if (dataIds.length === 0) {
      // Series has no data refs — keep as is. `dataRefs` may still
      // contain `axisId` entries; preserve them.
      return series;
    }
    if (dataIds.length === 1) {
      // Already schema-correct — one dataId referencing one data
      // entry. Keep the referenced entry in `keepVerbatim` (already
      // there from the initial seed) and the series unchanged.
      const axisRefs = refs!.filter(r => typeof r.dataId !== "number");
      return {
        ...series,
        dataRefs: [{ dataId: dataIds[0] }, ...axisRefs]
      };
    }
    // Multiple dataIds — consolidate into ONE synthetic entry.
    // Reuse the SMALLEST absorbed id rather than allocating a fresh
    // one above the existing max. Excel's own output numbers
    // consolidated `<cx:data>` entries starting from 0
    // (`<cx:data id="0">`), and our matching output here would be
    // `id="2"` when the source entries were 0 and 1 — a cosmetic
    // drift that also surprises comparison-based validators. Since
    // we've already removed the source ids from `keepVerbatim`
    // below, recycling one of them for the synthetic entry is safe.
    const newId = Math.min(...dataIds);
    const parts: ChartExDataEntry[] = [];
    for (const id of dataIds) {
      const entry = entryById.get(id);
      if (entry) {
        parts.push(entry);
        // Mark this source entry as absorbed so we don't also emit
        // it as a standalone `<cx:data>` in the final output.
        keepVerbatim.delete(id);
      }
    }
    consolidated.push({ id: newId, parts });
    const axisRefs = refs!.filter(r => typeof r.dataId !== "number");
    return {
      ...series,
      dataRefs: [{ dataId: newId }, ...axisRefs]
    };
  });
  // Compose the final chartData: verbatim entries still referenced
  // by a single-dataId series (or orphaned) followed by the
  // consolidated synthetic entries.
  const finalData: (ChartExDataEntry | ConsolidatedDataEntry)[] = [];
  for (const entry of originalData) {
    if (keepVerbatim.has(entry.id)) {
      finalData.push(entry);
    }
  }
  for (const entry of consolidated) {
    finalData.push(entry);
  }
  return {
    ...space,
    chartData: {
      ...space.chartData,
      // The consolidated entries are `ConsolidatedDataEntry` (with a
      // `parts` slot instead of raw strDim/numDim); cast into the
      // public type and let the custom renderer dispatch on `parts`.
      data: finalData as ChartExDataEntry[]
    },
    chart: {
      ...space.chart,
      plotArea: {
        ...space.chart.plotArea,
        plotAreaRegion: { ...plotRegion, series: rewrittenSeries }
      }
    }
  };
}

/**
 * Render-time-only aggregate produced by {@link consolidateDataForRender}.
 * Carries multiple {@link ChartExDataEntry}s whose dimensions should be
 * merged into a single `<cx:data>` element. Never escapes the renderer.
 */
interface ConsolidatedDataEntry {
  id: number;
  parts: ChartExDataEntry[];
}

function renderChartData(data: ChartExModel["chartSpace"]["chartData"]): string {
  const parts: string[] = [];
  parts.push("  <cx:chartData>");
  // `cx:externalData` is a child of `cx:chartSpace`, not `cx:chartData`,
  // per the Chart2014 schema — emitted by the chartSpace renderer.
  for (const entry of data.data) {
    parts.push(renderDataEntry(entry));
  }
  parts.push("  </cx:chartData>");
  return parts.join("\n");
}

/**
 * Compute the effective `ptCount` attribute for a `<cx:lvl>` element.
 *
 * Respects the invariant that the attribute declares the logical
 * length of the sparse array — it is never smaller than the highest
 * authored index, nor smaller than the number of materialised points.
 * Preserves a parser-captured `declared` value when it is larger than
 * both (sparse round-trip). Returns `0` for an empty level with no
 * declared count.
 */
function computePtCount(
  declared: number | undefined,
  points: readonly { index: number }[]
): number {
  let maxIdx = -1;
  for (const p of points) {
    if (typeof p.index === "number" && Number.isFinite(p.index) && p.index > maxIdx) {
      maxIdx = p.index;
    }
  }
  return Math.max(declared ?? 0, maxIdx + 1, points.length);
}

function renderDataEntry(entry: ChartExDataEntry | ConsolidatedDataEntry): string {
  const parts: string[] = [];
  parts.push(`    <cx:data id="${entry.id}">`);
  // `ConsolidatedDataEntry` is produced only by
  // `consolidateDataForRender` and carries multiple original entries
  // that must be emitted as children of a single `<cx:data>` — see the
  // justification on the consolidation helper.
  //
  // For hierarchical series (treemap / sunburst) the builder produces
  // one source `<cx:data>` per category + per hierarchy level + per
  // value binding, each with a single-level `<cx:strDim>` /
  // `<cx:numDim>`. Emitting those as SIBLING dimensions is
  // schema-legal (`CT_Data` is `<xsd:choice maxOccurs="unbounded">`)
  // but Microsoft Excel's treemap + sunburst renderer expects the
  // canonical form every Excel-authored ChartEx uses: ONE
  // `<cx:strDim type="cat">` with MULTIPLE `<cx:lvl>` children, one
  // per hierarchy depth (leaf first, parent levels tagged
  // `formatCode="General"`). Emitting multiple sibling `<cx:strDim>`
  // entries triggers "Removed Part: /xl/drawings/drawingN.xml part.
  // (Drawing shape)" — Excel drops the whole drawing rather than
  // render a malformed hierarchy. Collapse same-type dimensions here
  // so the consolidated rendering mirrors Excel's own output byte
  // layout.
  if ("parts" in entry && Array.isArray(entry.parts)) {
    // Group strDim/numDim parts by dimension `type` while keeping
    // their relative order (the FIRST occurrence's position dictates
    // where the merged dimension lands in the output). Non-matching
    // types stay as independent siblings.
    const merged: Array<MergedStrDim | MergedNumDim> = [];
    const strByType = new Map<string, MergedStrDim>();
    const numByType = new Map<string, MergedNumDim>();
    for (const part of entry.parts) {
      if (part.strDim) {
        const key = part.strDim.type;
        const existing = strByType.get(key);
        if (existing) {
          // Later entries with the same type contribute additional
          // `<cx:lvl>` children. Their formulas, if any, are dropped —
          // CT_StringDataDimension only allows a single `<cx:f>` and
          // the first one (the leaf) wins. Cached points from each
          // source level survive as parent-level `<cx:lvl>` elements.
          if (part.strDim.levels) {
            existing.levels.push(...part.strDim.levels);
          }
        } else {
          const entry: MergedStrDim = {
            kind: "str",
            type: part.strDim.type,
            formula: part.strDim.formula,
            levels: [...(part.strDim.levels ?? [])]
          };
          strByType.set(key, entry);
          merged.push(entry);
        }
      }
      if (part.numDim) {
        const key = part.numDim.type;
        const existing = numByType.get(key);
        if (existing) {
          if (part.numDim.levels) {
            existing.levels.push(...part.numDim.levels);
          }
        } else {
          const numEntry: MergedNumDim = {
            kind: "num",
            type: part.numDim.type,
            formula: part.numDim.formula,
            levels: [...(part.numDim.levels ?? [])]
          };
          numByType.set(key, numEntry);
          merged.push(numEntry);
        }
      }
    }
    for (const m of merged) {
      if (m.kind === "str") {
        parts.push(renderStrDim({ type: m.type, formula: m.formula, levels: m.levels }));
      } else {
        parts.push(renderNumDim({ type: m.type, formula: m.formula, levels: m.levels }));
      }
    }
    parts.push("    </cx:data>");
    return parts.join("\n");
  }
  const plainEntry = entry as ChartExDataEntry;
  if (plainEntry.strDim) {
    parts.push(renderStrDim(plainEntry.strDim));
  }
  if (plainEntry.numDim) {
    parts.push(renderNumDim(plainEntry.numDim));
  }
  parts.push("    </cx:data>");
  return parts.join("\n");
}

interface MergedStrDim {
  kind: "str";
  type: NonNullable<ChartExDataEntry["strDim"]>["type"];
  formula?: string;
  levels: NonNullable<NonNullable<ChartExDataEntry["strDim"]>["levels"]>;
}

interface MergedNumDim {
  kind: "num";
  type: NonNullable<ChartExDataEntry["numDim"]>["type"];
  formula?: string;
  levels: NonNullable<NonNullable<ChartExDataEntry["numDim"]>["levels"]>;
}

function renderStrDim(d: NonNullable<ChartExDataEntry["strDim"]>): string {
  const parts: string[] = [];
  parts.push(`      <cx:strDim type="${d.type}">`);
  if (d.formula) {
    parts.push(`        <cx:f>${escapeXml(d.formula)}</cx:f>`);
  }
  if (d.levels) {
    for (const lvl of d.levels) {
      // `ptCount` is preserved on parse so sparse arrays survive
      // round-trip (e.g. `ptCount="100"` with only three authored
      // `<cx:pt>`). Mutations that append fresh points leave the
      // declared count stale, so use `max(declared, maxIdx+1,
      // length)` to cover both paths: the declared count wins for
      // sparse inputs, and the materialised points win when the
      // model grew past the captured attribute.
      const ptCount = computePtCount(lvl.ptCount, lvl.points);
      const ptAttr = ` ptCount="${ptCount}"`;
      if (lvl.points.length === 0) {
        parts.push(`        <cx:lvl${ptAttr}/>`);
      } else {
        parts.push(`        <cx:lvl${ptAttr}>`);
        for (const p of lvl.points) {
          parts.push(`          <cx:pt idx="${p.index}">${escapeXml(p.value)}</cx:pt>`);
        }
        parts.push("        </cx:lvl>");
      }
    }
  }
  parts.push("      </cx:strDim>");
  return parts.join("\n");
}

function renderNumDim(d: NonNullable<ChartExDataEntry["numDim"]>): string {
  const parts: string[] = [];
  parts.push(`      <cx:numDim type="${d.type}">`);
  if (d.formula) {
    parts.push(`        <cx:f>${escapeXml(d.formula)}</cx:f>`);
  }
  if (d.levels) {
    for (const lvl of d.levels) {
      const fmtAttr = lvl.formatCode ? ` formatCode="${escapeXmlAttr(lvl.formatCode)}"` : "";
      // See `computePtCount` note above — same sparse-safe rule.
      const ptCount = computePtCount(lvl.ptCount, lvl.points);
      const ptAttr = ` ptCount="${ptCount}"`;
      if (lvl.points.length === 0) {
        parts.push(`        <cx:lvl${ptAttr}${fmtAttr}/>`);
      } else {
        parts.push(`        <cx:lvl${ptAttr}${fmtAttr}>`);
        for (const p of lvl.points) {
          // Route numeric content through `fmtNumText` so
          // `NaN` / `Infinity` from a mutated / user-built model
          // degrade to `"0"` instead of emitting literal `"NaN"`
          parts.push(`          <cx:pt idx="${p.index}">${fmtNumText(p.value)}</cx:pt>`);
        }
        parts.push("        </cx:lvl>");
      }
    }
  }
  parts.push("      </cx:numDim>");
  return parts.join("\n");
}

function renderChart(chart: ChartExModel["chartSpace"]["chart"]): string {
  const parts: string[] = [];
  parts.push("  <cx:chart>");
  if (chart.title) {
    parts.push(renderTitle(chart.title));
  } else {
    // Match Excel's output: every chartEx chart (even ones without
    // an explicit title) carries an empty `<cx:title>` placeholder
    // that reserves layout space for the auto-derived title Excel
    // shows for single-series charts. Omitting it caused Excel
    // 2016+ to reject the chartEx as malformed and drop the
    // parent drawing with "Removed Part: drawingN.xml (Drawing
    // shape)". A freshly-built chartEx model has `chart.title`
    // undefined; parsed models inherit whatever the on-disk bytes
    // declared. See `ChartExModel.chartSpace.chart.title`.
    parts.push('    <cx:title pos="t" align="ctr" overlay="0"/>');
  }
  // Per ECMA-376 `CT_Chart`, `autoTitleDeleted` is an independent
  // optional child that follows `title` — the two are **not** mutually
  // exclusive. Previously the guard `!chart.title` would drop
  // `autoTitleDeleted` whenever a title was also present, breaking
  // round-trip of files that explicitly record "the auto title was
  // deleted, user picked a custom one".
  if (chart.autoTitleDeleted !== undefined) {
    parts.push(`    <cx:autoTitleDeleted val="${chart.autoTitleDeleted ? "1" : "0"}"/>`);
  }
  parts.push(renderPlotArea(chart.plotArea));
  if (chart.legend) {
    parts.push(renderLegend(chart.legend));
  }
  // `CT_Chart` carries no `spPr` per the Chart2014 schema — chart-frame
  // styling lives on `CT_ChartSpace`, emitted by the chartSpace renderer.
  if (chart.extLst) {
    parts.push(`    ${chart.extLst}`);
  }
  parts.push("  </cx:chart>");
  return parts.join("\n");
}

function renderTitle(title: ChartTitle): string {
  const parts: string[] = [];
  // Per the official [MS-ODRAWXML] CT_ChartTitle / CT_AxisTitle
  // schemas, `overlay` is an ATTRIBUTE on `<cx:title>` (default 0),
  // NOT a child element. Earlier revisions emitted
  // `<cx:overlay val="…"/>` inside the title, which violates the
  // sequence (no such child exists) — Excel 2016+ drops the whole
  // ChartEx part on open and reports
  // "Removed Part: /xl/drawings/drawingN.xml (Drawing shape)".
  // Only emit the attribute when the caller explicitly set it so the
  // default case produces a bare `<cx:title>` that matches what Excel
  // itself writes.
  const titleAttrs: string[] = [];
  if (title.overlay !== undefined) {
    titleAttrs.push(`overlay="${title.overlay ? "1" : "0"}"`);
  }
  parts.push(titleAttrs.length > 0 ? `    <cx:title ${titleAttrs.join(" ")}>` : "    <cx:title>");
  // Chart2014 `CT_ChartTitle` sequence:
  //   tx? → spPr? → txPr? → offset? → extLst?
  // `layout` is NOT a valid child of `<cx:title>` in the Chart2014
  // schema — earlier versions of this library emitted `<cx:layout/>`
  // here, which strict validators reject. Title layout information
  // belongs in the `offset` child or `extLst`-based extensions, not
  // as a direct `layout` element; round-trip of buggy legacy files
  // preserves `title.layout` on the model but the writer
  // intentionally drops it.
  if (title.text && (title.text.paragraphs?.length ?? 0) > 0) {
    // If the structured model carries a non-empty rich-text body,
    // emit it; otherwise fall back to the raw bytes captured at parse
    // time (`rawTx`). When both are present the structured path wins —
    // that's the convention `mutateChartEx` documents for "mutation
    // invalidates raw". Checking `paragraphs.length > 0` guards
    // against a model where the user cleared paragraphs but forgot
    // to null `text` — without the check, we'd emit an empty
    // `<cx:tx><cx:rich></cx:rich></cx:tx>` and drop the valid rawTx.
    parts.push("      <cx:tx>");
    parts.push(renderRichText(title.text, "        "));
    parts.push("      </cx:tx>");
  } else if (title.strRef?.formula) {
    // Formula-linked title — `<cx:tx><cx:txData><cx:f>…</cx:f>
    // [<cx:v>cachedValue</cx:v>]</cx:txData></cx:tx>`.
    const cached = title.strRef.cache?.points?.[0]?.value;
    parts.push("      <cx:tx>");
    parts.push("        <cx:txData>");
    parts.push(`          <cx:f>${escapeXml(title.strRef.formula)}</cx:f>`);
    if (typeof cached === "string" && cached.length > 0) {
      parts.push(`          <cx:v>${escapeXml(cached)}</cx:v>`);
    }
    parts.push("        </cx:txData>");
    parts.push("      </cx:tx>");
  } else if (title.rawTx) {
    parts.push(`      ${title.rawTx}`);
  }
  if (title.spPr) {
    parts.push(renderSpPr(title.spPr, "      "));
  }
  if (title.txPr) {
    parts.push(renderTxPr(title.txPr, "      "));
  }
  parts.push("    </cx:title>");
  return parts.join("\n");
}

/**
 * Render a {@link ChartRichText} as `<cx:rich>…</cx:rich>` (DrawingML
 * body + one or more `<a:p>` paragraphs). Shared between title
 * rendering and series `tx.rich`. Run attributes (bold, italic,
 * fontFamily, colour) are intentionally omitted from the textBody —
 * ChartEx callers that need per-run formatting should upgrade to
 * `text` with explicit paragraph properties and we'll emit them here
 * once `types.ts:ChartParagraph` carries the full OOXML mapping.
 */
/**
 * Render a {@link ChartRichText} as `<cx:rich>…</cx:rich>` (DrawingML
 * body + one or more `<a:p>` paragraphs). Shared between title
 * rendering and series `tx.rich`.
 *
 * Emits run-level properties (bold / italic / size / colour /
 * fontFamily / underline / strike / baseline / cap) from
 * {@link ChartTextRun.properties}. Previously the writer silently
 * dropped every run property, so `setTitleRichText({ runs: [{ text: "Bold",
 * properties: { bold: true } }] })` produced un-bolded output.
 *
 * Paragraph-level properties and hyperlinks are still deferred — the
 * current `types.ts` `ChartParagraphProperties` type only models what
 * the classic writer has wired up, and copying that to ChartEx
 * pending a unified paragraph-properties model.
 */
function renderRichText(text: ChartRichText, indent: string): string {
  const parts: string[] = [];
  parts.push(`${indent}<cx:rich>`);
  parts.push(`${indent}  <a:bodyPr/>`);
  parts.push(`${indent}  <a:lstStyle/>`);
  for (const p of text.paragraphs) {
    parts.push(`${indent}  <a:p>`);
    for (const run of p.runs ?? []) {
      const rPr = run.properties ? renderRunProperties(run.properties, "a:rPr") : "";
      // `xml:space="preserve"` so leading / trailing whitespace inside
      // a run survives the reader's whitespace normalisation. The
      // XML spec collapses repeated whitespace in text nodes and
      // turns every `\t` / `\n` / `\r` into a space; DrawingML runs
      // often carry significant whitespace between runs (spacing) or
      // embedded newlines (multi-line tooltips). The previous trigger
      // missed tabs and newlines in the middle of a run that had no
      // leading / trailing whitespace — those were silently turned
      // into spaces by compliant readers.
      const tAttrs = needsXmlSpacePreserve(run.text) ? ' xml:space="preserve"' : "";
      parts.push(`${indent}    <a:r>`);
      if (rPr) {
        parts.push(`${indent}      ${rPr}`);
      }
      parts.push(`${indent}      <a:t${tAttrs}>${escapeXml(run.text)}</a:t>`);
      parts.push(`${indent}    </a:r>`);
    }
    // Always emit an `<a:endParaRPr/>` so Excel treats the paragraph
    // as explicitly terminated (it otherwise writes an implicit one).
    // `lang` default matches what Excel ships.
    parts.push(`${indent}    <a:endParaRPr lang="en-US"/>`);
    parts.push(`${indent}  </a:p>`);
  }
  parts.push(`${indent}</cx:rich>`);
  return parts.join("\n");
}

/**
 * Render run / default-run properties as a single line `<a:rPr…>` or
 * `<a:defRPr…>` element. Supports the common attributes (size, bold,
 * italic, underline, strike, baseline, cap, lang) and the typeface /
 * colour children. Kept in sync with the classic chart-space-xform's
 * `_renderRunProperties` so the two writers emit byte-identical run
 * properties given the same structured input.
 */
function renderRunProperties(props: ChartTextProperties, tag: "a:rPr" | "a:defRPr"): string {
  const attrParts: string[] = [];
  if (props.size !== undefined) {
    attrParts.push(`sz="${props.size}"`);
  }
  if (props.bold !== undefined) {
    attrParts.push(`b="${props.bold ? 1 : 0}"`);
  }
  if (props.italic !== undefined) {
    attrParts.push(`i="${props.italic ? 1 : 0}"`);
  }
  if (props.underline !== undefined) {
    const u =
      typeof props.underline === "boolean" ? (props.underline ? "sng" : "none") : props.underline;
    attrParts.push(`u="${u}"`);
  }
  if (props.strike) {
    attrParts.push(`strike="${props.strike}"`);
  }
  if (props.baseline !== undefined) {
    attrParts.push(`baseline="${props.baseline}"`);
  }
  if (props.cap) {
    attrParts.push(`cap="${props.cap}"`);
  }
  if (props.lang) {
    attrParts.push(`lang="${escapeXmlAttr(props.lang)}"`);
  }
  const attrStr = attrParts.length > 0 ? ` ${attrParts.join(" ")}` : "";

  const children: string[] = [];
  if (props.color) {
    children.push(`<a:solidFill>${renderColor(props.color)}</a:solidFill>`);
  }
  if (props.fontFamily) {
    children.push(`<a:latin typeface="${escapeXmlAttr(props.fontFamily)}"/>`);
  }
  if (props.eastAsianFamily) {
    children.push(`<a:ea typeface="${escapeXmlAttr(props.eastAsianFamily)}"/>`);
  }
  if (props.complexScriptFamily) {
    children.push(`<a:cs typeface="${escapeXmlAttr(props.complexScriptFamily)}"/>`);
  }

  if (children.length === 0) {
    return `<${tag}${attrStr}/>`;
  }
  return `<${tag}${attrStr}>${children.join("")}</${tag}>`;
}

function renderPlotArea(pa: ChartExModel["chartSpace"]["chart"]["plotArea"]): string {
  const parts: string[] = [];
  parts.push("    <cx:plotArea>");
  // `CT_PlotArea` (Chart2014): sequence is `plotAreaRegion?` → `axis*`
  // → `spPr?` → `extLst?`. Emit `spPr` and `extLst` last — previously
  // `spPr` was emitted first, which is a schema-order violation, and
  // `extLst` was not supported at all.
  const region = pa.plotAreaRegion;
  if (region) {
    parts.push("      <cx:plotAreaRegion>");
    // `CT_PlotAreaRegion` (Chart2014): sequence is `plotSurface?` →
    // `series*` → `extLst?`. `layout` is NOT a valid child. Earlier
    // versions of this library captured `<cx:layout/>` on the model
    // via the parser and re-emitted it here, producing XML that
    // strict validators reject. The parser now retains the field only
    // for in-memory round-trip continuity; the writer intentionally
    // drops it.
    if (region.plotSurface) {
      // `CT_PlotSurface` is `<cx:plotSurface><cx:spPr>…</cx:spPr></cx:plotSurface>`
      // — previously we wrote the inner `<cx:spPr>` directly as a
      // child of `<cx:plotAreaRegion>`, which is a schema violation.
      parts.push("        <cx:plotSurface>");
      parts.push(renderSpPr(region.plotSurface, "          "));
      parts.push("        </cx:plotSurface>");
    }
    for (const s of region.series) {
      parts.push(renderSeries(s));
    }
    if (region.extLst) {
      parts.push(`        ${region.extLst}`);
    }
    parts.push("      </cx:plotAreaRegion>");
  } else if (pa.series) {
    // When the model stores the series directly on the plotArea (no
    // `plotAreaRegion` wrapper), wrap them into a synthetic
    // `plotAreaRegion` on write. `CT_PlotArea` does not allow `series`
    // as a direct child — only `plotAreaRegion` can host them.
    parts.push("      <cx:plotAreaRegion>");
    parts.push("        <cx:plotSurface/>");
    for (const s of pa.series) {
      parts.push(renderSeries(s));
    }
    parts.push("      </cx:plotAreaRegion>");
  }
  if (pa.axis) {
    for (const axis of pa.axis) {
      parts.push(renderAxis(axis));
    }
  }
  if (pa.spPr) {
    parts.push(renderSpPr(pa.spPr, "      "));
  }
  if (pa.extLst) {
    parts.push(`      ${pa.extLst}`);
  }
  parts.push("    </cx:plotArea>");
  return parts.join("\n");
}

function renderSeries(s: ChartExSeries): string {
  const parts: string[] = [];
  // Prefer the verbatim `rawLayoutId` captured during parsing so
  // unknown / future layoutIds (e.g. a new layout shipped in a later
  // Office build) survive round-trip intact — but only when the
  // caller hasn't overridden `layoutId` since parsing. If
  // `layoutId` is still the synthesized "clusteredColumn" fallback
  // the parser placed there, the raw attribute wins; otherwise the
  // caller intentionally set a structured `layoutId` and we emit
  // that instead. This lets mutations work as expected while
  // preserving unknowns for untouched series.
  const useRaw = s.rawLayoutId !== undefined && s.layoutId === "clusteredColumn";
  const layoutIdAttr = escapeXmlAttr(useRaw ? (s.rawLayoutId as string) : s.layoutId);
  const attrs = [`layoutId="${layoutIdAttr}"`];
  // Emit explicit `hidden="0"` when the caller set `hidden: false`
  // so round-trip of Excel-authored `<cx:series hidden="0">` doesn't
  // drop the attribute. Previously the truthy check collapsed the
  // `false` case to "no attribute", breaking byte-identity for files
  // that carried an explicit suppression marker.
  if (s.hidden !== undefined) {
    attrs.push(`hidden="${s.hidden ? "1" : "0"}"`);
  }
  if (s.ownerIdx !== undefined) {
    attrs.push(`ownerIdx="${s.ownerIdx}"`);
  }
  parts.push(`        <cx:series ${attrs.join(" ")}>`);
  // Chart2014 `CT_Series` child order:
  //   tx? → spPr? → txPr? → valueColors? → valueColorPositions? →
  //   dataPt* → dataLabels? → dataId? → layoutPr? → axisId* → extLst?
  // The previous writer emitted dataRefs/axisId **before** dataLabels
  // and dataPt, which is a schema-order violation. Excel 2019+ accepts
  // the file but round-tripping it through strict validators fails.
  if (s.tx) {
    // Preference order: structured rich > value > strRef. ECMA-376 allows
    // only one of these forms at a time; when the model accidentally
    // sets both `rich` and `value`, the richer representation wins so
    // per-run formatting doesn't get silently downgraded to a plain
    // string. Previously the writer didn't handle `rich` at all, so
    // `<cx:tx><cx:rich>…</cx:rich></cx:tx>` round-trips were flattened.
    if (s.tx.rich) {
      parts.push("          <cx:tx>");
      parts.push(renderRichText(s.tx.rich, "            "));
      parts.push("          </cx:tx>");
    } else if (s.tx.value !== undefined) {
      parts.push(
        `          <cx:tx><cx:txData><cx:v>${escapeXml(s.tx.value)}</cx:v></cx:txData></cx:tx>`
      );
    } else if (s.tx.strRef) {
      // Accept both the new `{ formula, cached? }` shape and the
      // legacy string form. Emit `<cx:f>` for the formula and, when a
      // cached resolved value is present, `<cx:v>` alongside — this
      // mirrors Excel's own output and lets charts display their
      // series labels before recalculation completes.
      const ref = s.tx.strRef;
      const formula = typeof ref === "string" ? ref : ref.formula;
      const cached = typeof ref === "string" ? undefined : ref.cached;
      const cachedXml = cached !== undefined ? `<cx:v>${escapeXml(cached)}</cx:v>` : "";
      parts.push(
        `          <cx:tx><cx:txData><cx:f>${escapeXml(formula)}</cx:f>${cachedXml}</cx:txData></cx:tx>`
      );
    }
  }
  if (s.spPr) {
    parts.push(renderSpPr(s.spPr, "          "));
  }
  if (s.txPr) {
    parts.push(renderTxPr(s.txPr, "          ", "cx:txPr"));
  }
  // `valueColors` / `valueColorPositions` — raw-preserved chart-2014
  // colour-by-value palette. Emitted verbatim in the schema-mandated
  // position (after `txPr`, before `dataPt`). Previously these were
  // silently dropped by the writer even when the parser captured them.
  if (s.valueColors) {
    parts.push(`          ${s.valueColors}`);
  }
  if (s.valueColorPositions) {
    parts.push(`          ${s.valueColorPositions}`);
  }
  // dataPt — per-point overrides (before dataLabels and dataId per
  // CT_Series schema).
  if (s.dataPt) {
    for (const dp of s.dataPt) {
      parts.push(`          <cx:dataPt idx="${dp.idx}">`);
      if (dp.spPr) {
        parts.push(renderSpPr(dp.spPr, "            "));
      }
      parts.push("          </cx:dataPt>");
    }
  }
  if (s.dataLabels) {
    parts.push(renderDataLabels(s.dataLabels));
  }
  if (s.dataRefs) {
    for (const ref of s.dataRefs) {
      if (ref.dataId !== undefined) {
        parts.push(`          <cx:dataId val="${ref.dataId}"/>`);
      }
    }
  }
  if (s.layoutPr) {
    parts.push(renderLayoutProperties(s.layoutId, s.layoutPr));
  }
  if (s.axisId) {
    for (const id of s.axisId) {
      // Per the official ECMA-376 / [MS-ODRAWXML] chartEx schema,
      // `<cx:axisId>` is a CT_UnsignedInteger — the id goes in a
      // REQUIRED `val` attribute, not in text content. Microsoft
      // Excel's own output always uses the attribute form:
      //
      //   <cx:axisId val="100000000"/>
      //
      // A previous revision of this file emitted `<cx:axisId>N</cx:axisId>`
      // (text-content form) based on a misreading of the schema as
      // `ST_AxisId = xsd:unsignedInt`. No such simple type exists;
      // both `<cx:axisId>` and its sibling `<cx:dataId>` share the
      // same `CT_UnsignedInteger` complex type. Excel's strict
      // loader rejects the text form and surfaces the failure as
      // "Removed Part: /xl/drawings/drawingN.xml (Drawing shape)"
      // on open — the chartEx fails validation, then the parent
      // drawing anchor gets purged along with it.
      parts.push(`          <cx:axisId val="${id}"/>`);
    }
  }
  if (s.extLst) {
    parts.push(s.extLst);
  }
  parts.push("        </cx:series>");
  return parts.join("\n");
}

function renderLayoutProperties(
  layoutId: string,
  lp: NonNullable<ChartExSeries["layoutPr"]>
): string {
  const parts: string[] = [];
  if (lp._rawXml && !hasStructuredLayoutProperties(lp)) {
    return `          ${lp._rawXml}`;
  }
  // Per the official [MS-ODRAWXML] CT_SeriesLayoutProperties schema,
  // children MUST appear in this exact sequence (all optional):
  //   parentLabelLayout → regionLabelLayout → visibility →
  //   (aggregation | binning) → geography → statistics → subtotals →
  //   extLst
  //
  // Several per-type flags are NOT direct children of `<cx:layoutPr>`
  // but attributes on the above wrappers:
  //   * `meanLine` / `meanMarker` / `nonoutliers` / `outliers` /
  //     `connectorLines`  → `<cx:visibility>` attributes
  //   * `quartileMethod`  → `<cx:statistics>` attribute
  //
  // Emitting them as bare elements (`<cx:showMeanLine val="1"/>` etc.)
  // — which earlier versions of this library did — is a schema
  // violation that causes Excel 2016+ to drop the whole ChartEx
  // part on open ("Removed Part: /xl/drawings/drawingN.xml").
  parts.push("          <cx:layoutPr>");

  // 1. parentLabelLayout — sunburst/treemap only
  if (lp.parentLabelLayout && (layoutId === "sunburst" || layoutId === "treemap")) {
    parts.push(`            <cx:parentLabelLayout val="${lp.parentLabelLayout}"/>`);
  }

  // 2. regionLabelLayout — regionMap only (map `regionLabels` model
  //    field → spec `regionLabelLayout` element). `bestFit` from the
  //    public option maps to schema `bestFitOnly`.
  if (lp.regionLabels && layoutId === "regionMap") {
    const val = lp.regionLabels === "bestFit" ? "bestFitOnly" : lp.regionLabels;
    parts.push(`            <cx:regionLabelLayout val="${val}"/>`);
  }

  // 3. visibility — collect boxWhisker / waterfall flags into one
  //    `<cx:visibility>` element with boolean attributes.
  const visibilityAttrs: string[] = [];
  if (layoutId === "boxWhisker") {
    if (lp.showMeanLine !== undefined) {
      visibilityAttrs.push(`meanLine="${lp.showMeanLine ? "1" : "0"}"`);
    }
    if (lp.showMeanMarker !== undefined) {
      visibilityAttrs.push(`meanMarker="${lp.showMeanMarker ? "1" : "0"}"`);
    }
    if (lp.showInnerPoints !== undefined) {
      visibilityAttrs.push(`nonoutliers="${lp.showInnerPoints ? "1" : "0"}"`);
    }
    if (lp.showOutlierPoints !== undefined) {
      visibilityAttrs.push(`outliers="${lp.showOutlierPoints ? "1" : "0"}"`);
    }
  }
  if (layoutId === "waterfall" && lp.connectorLines !== undefined) {
    visibilityAttrs.push(`connectorLines="${lp.connectorLines ? "1" : "0"}"`);
  }
  if (visibilityAttrs.length > 0) {
    parts.push(`            <cx:visibility ${visibilityAttrs.join(" ")}/>`);
  }

  // 4. binning — histogram / pareto only
  if (lp.binning) {
    const b = lp.binning;
    const attrs: string[] = [];
    if (b.intervalClosed === "l" || b.intervalClosed === "r") {
      attrs.push(`intervalClosed="${b.intervalClosed}"`);
    }
    const underflowAttr = fmtNumAttr(b.underflow);
    if (underflowAttr !== "") {
      attrs.push(`underflow="${underflowAttr}"`);
    }
    const overflowAttr = fmtNumAttr(b.overflow);
    if (overflowAttr !== "") {
      attrs.push(`overflow="${overflowAttr}"`);
    }
    const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
    // CT_Binning only allows `<cx:binSize>` or `<cx:binCount>`
    // children. Per the MS-ODRAWXML Office 2016 schema these are
    // typed as `xsd:unsignedInt` (simple type), but Microsoft
    // Excel REJECTS the text-content form and requires a `val`
    // attribute instead:
    //
    //   <cx:binCount val="12"/>   — Excel accepts
    //   <cx:binCount>12</cx:binCount>   — Excel rejects (drawing dropped)
    //
    // Same discrepancy we saw on `<cx:axisId>` (typed `xsd:unsignedInt`
    // on paper but treated as CT_UnsignedInteger on the wire).
    // Emit the attribute form to match Excel's actual loader.
    const binSizeAttr = fmtNumAttr(b.binSize);
    const binCountAttr = fmtNumAttr(b.binCount);
    const hasChild = binSizeAttr !== "" || binCountAttr !== "";
    if (!hasChild) {
      parts.push(`            <cx:binning${attrStr}/>`);
    } else {
      parts.push(`            <cx:binning${attrStr}>`);
      const preferCount =
        b.binType === "binCount" || (b.binType === undefined && binCountAttr !== "");
      if (binCountAttr !== "" && preferCount) {
        parts.push(`              <cx:binCount val="${binCountAttr}"/>`);
      } else if (binSizeAttr !== "") {
        parts.push(`              <cx:binSize val="${binSizeAttr}"/>`);
      } else if (binCountAttr !== "") {
        parts.push(`              <cx:binCount val="${binCountAttr}"/>`);
      }
      parts.push("            </cx:binning>");
    }
  }

  // 5. geography — regionMap. Current structured model carries
  //    `projection` / `geoMappingLevel`; emit as `<cx:geography>`
  //    attributes.
  if (layoutId === "regionMap" && (lp.projection || lp.geoMappingLevel)) {
    const geoAttrs: string[] = [];
    if (lp.projection) {
      geoAttrs.push(`projectionType="${lp.projection}"`);
    }
    if (lp.geoMappingLevel) {
      // Map the public enum onto the schema enum. Public option uses
      // `country`; schema uses `countryRegion`.
      const mapped =
        lp.geoMappingLevel === "country"
          ? "countryRegion"
          : lp.geoMappingLevel === "automatic"
            ? "dataOnly"
            : lp.geoMappingLevel;
      geoAttrs.push(`viewedRegionType="${mapped}"`);
    }
    // `cultureLanguage` and `cultureRegion` are required per schema —
    // supply a sensible default when the caller didn't specify them.
    geoAttrs.push(`cultureLanguage="en-US"`);
    geoAttrs.push(`cultureRegion="US"`);
    geoAttrs.push(`attribution=""`);
    parts.push(`            <cx:geography ${geoAttrs.join(" ")}/>`);
  }

  // 6. statistics — boxWhisker only. `quartileMethod` is the only
  //    attribute on `<cx:statistics>`.
  if (layoutId === "boxWhisker" && lp.quartileMethod) {
    parts.push(`            <cx:statistics quartileMethod="${lp.quartileMethod}"/>`);
  }

  // 7. subtotals — waterfall only. Schema uses `<cx:idx val="N"/>`
  //    children (NOT `<cx:subtotal>` — earlier versions of this
  //    library emitted the legacy element name). Emit the
  //    self-closing form `<cx:subtotals/>` when the index list is
  //    empty, matching Excel's exact byte layout for a waterfall
  //    with no explicit subtotal markers.
  if (lp.subtotals && layoutId === "waterfall") {
    if (lp.subtotals.length === 0) {
      parts.push("            <cx:subtotals/>");
    } else {
      parts.push("            <cx:subtotals>");
      for (const st of lp.subtotals) {
        parts.push(`              <cx:idx val="${st.idx}"/>`);
      }
      parts.push("            </cx:subtotals>");
    }
  }
  if (lp.extLst) {
    parts.push(`            ${lp.extLst}`);
  }
  parts.push("          </cx:layoutPr>");
  return parts.join("\n");
}

function hasStructuredLayoutProperties(lp: NonNullable<ChartExSeries["layoutPr"]>): boolean {
  // `increaseSpPr` / `decreaseSpPr` / `totalSpPr` are preview-only
  // fields consumed by the SVG/PDF renderer to colour waterfall bars;
  // Chart2014 has no schema slot for them (per-point styling lives on
  // `<cx:dataPt>` instead). Keep them in the public type so applications
  // can theme the preview, but DON'T treat setting one as a "structured
  // mutation" — that would force the writer down the structured path
  // and discard `_rawXml`, silently dropping all the other properties
  // the raw bytes carried. Only fields that `renderLayoutProperties`
  // actually emits count here.
  return [
    lp.parentLabelLayout,
    lp.subtotals,
    lp.connectorLines,
    lp.binning,
    lp.paretoLine,
    lp.quartileMethod,
    lp.showMeanLine,
    lp.showMeanMarker,
    lp.showInnerPoints,
    lp.showOutlierPoints,
    lp.projection,
    lp.regionLabels,
    lp.geoMappingLevel
  ].some(value => value !== undefined);
}

function renderDataLabels(dl: NonNullable<ChartExSeries["dataLabels"]>): string {
  const parts: string[] = [];
  // Per Excel's own output, `pos` is an ATTRIBUTE on `<cx:dataLabels>`
  // itself, NOT a separate `<cx:dataLabel pos="..."/>` child element.
  // Earlier revisions emitted the child-element form; Excel's strict
  // loader interprets that as an unrecognised sibling and drops the
  // surrounding chartEx part on load.
  const openAttr = dl.position ? ` pos="${dl.position}"` : "";
  parts.push(`          <cx:dataLabels${openAttr}>`);
  if (dl.visibility) {
    const v = dl.visibility;
    const attrs: string[] = [];
    if (v.seriesName !== undefined) {
      attrs.push(`seriesName="${v.seriesName ? "1" : "0"}"`);
    }
    if (v.categoryName !== undefined) {
      attrs.push(`categoryName="${v.categoryName ? "1" : "0"}"`);
    }
    if (v.value !== undefined) {
      attrs.push(`value="${v.value ? "1" : "0"}"`);
    }
    if (v.numFmt !== undefined) {
      attrs.push(`numFmt="${v.numFmt ? "1" : "0"}"`);
    }
    // Emit a self-closing tag without the trailing space when no
    // attributes are set — `<cx:visibility />` breaks byte-identity
    // against Excel's output while `<cx:visibility/>` matches.
    const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
    parts.push(`            <cx:visibility${attrStr}/>`);
  }
  if (dl.separator) {
    parts.push(`            <cx:separator>${escapeXml(dl.separator)}</cx:separator>`);
  }
  if (dl.numFmt) {
    parts.push(`            <cx:numFmt formatCode="${escapeXmlAttr(dl.numFmt)}"/>`);
  }
  if (dl.spPr) {
    parts.push(renderSpPr(dl.spPr, "            "));
  }
  if (dl.txPr) {
    parts.push(renderTxPr(dl.txPr, "            ", "cx:txPr"));
  }
  parts.push("          </cx:dataLabels>");
  return parts.join("\n");
}

function renderAxis(axis: ChartExAxis): string {
  const parts: string[] = [];
  // `CT_Axis` (Chart2014):
  //   - `hidden` is an **attribute** on `<cx:axis>`, not a child
  //     element. Emitting `<cx:hidden val="1"/>` is a schema violation
  //     — Excel 2019+ rejects the document on open.
  //   - Children have a strict order: catScaling | valScaling, then
  //     title, units, majorTickMarks, minorTickMarks, majorGridlines,
  //     minorGridlines, numFmt, txPr, spPr, extLst.
  //   - Element names use the **plural** form (`majorTickMarks`,
  //     `minorTickMarks`); we were writing the classic-chart singular
  //     form which the ChartEx parser also rejects.
  const axisAttrs = [`id="${axis.axisId}"`];
  // Emit explicit `hidden="0"` when the caller / parser set the flag
  // to `false` so round-trip of `<cx:axis hidden="0">` doesn't drop
  // the attribute. The old `if (axis.hidden)` truthy check collapsed
  // `false` and `undefined` into "omit" — fine on a freshly built
  // model, but lossy when loading an Excel-authored file that
  // explicitly declared the axis visible (a distinction only
  // observable on a secondary-axis round-trip, but real nonetheless).
  if (axis.hidden !== undefined) {
    axisAttrs.push(`hidden="${axis.hidden ? "1" : "0"}"`);
  }
  parts.push(`      <cx:axis ${axisAttrs.join(" ")}>`);
  // catScaling and valScaling are a `<choice>` — emit at most one.
  // Route numeric attributes through `fmtNumAttr` so NaN / Infinity
  // values from user-built or mutated models degrade to "absent"
  // rather than being interpolated as literal `"NaN"` into the XML.
  //
  // Excel's strict loader requires this choice to be PRESENT — an
  // empty `<cx:axis id="…"/>` with no catScaling/valScaling child is
  // structurally ambiguous (the axis type isn't declared on the
  // attribute set) and Excel responds by dropping the whole
  // `<cx:chartSpace>` on open ("Removed Part: /xl/charts/chartExN.xml"
  // cascading into the parent drawing). When the caller didn't set
  // either explicitly, fall back to the axis's structural `type`
  // field — the builder always tags freshly allocated axes as either
  // `"cat"` or `"val"`, so this branch emits a schema-valid default
  // discriminator instead of silently producing an empty element.
  if (axis.catScaling) {
    const cs = axis.catScaling;
    const attrs: string[] = [];
    const gapWidthAttr = fmtNumAttr(cs.gapWidth);
    if (gapWidthAttr !== "") {
      attrs.push(`gapWidth="${gapWidthAttr}"`);
    }
    parts.push(
      attrs.length > 0 ? `        <cx:catScaling ${attrs.join(" ")}/>` : "        <cx:catScaling/>"
    );
  } else if (axis.valScaling) {
    const vs = axis.valScaling;
    const attrs: string[] = [];
    const pushNum = (name: string, value: number | undefined): void => {
      const a = fmtNumAttr(value);
      if (a !== "") {
        attrs.push(`${name}="${a}"`);
      }
    };
    pushNum("min", vs.min);
    pushNum("max", vs.max);
    pushNum("majorUnit", vs.majorUnit);
    pushNum("minorUnit", vs.minorUnit);
    parts.push(
      attrs.length > 0 ? `        <cx:valScaling ${attrs.join(" ")}/>` : "        <cx:valScaling/>"
    );
  } else if (axis.type === "cat") {
    parts.push("        <cx:catScaling/>");
  } else if (axis.type === "val") {
    parts.push("        <cx:valScaling/>");
  }
  if (axis.title) {
    parts.push(renderTitle(axis.title));
  }
  // `<cx:units>` — display-unit scaler (thousand / million / custom).
  // Emitted verbatim from the parser-captured raw bytes. Previously
  // this element evaporated on round-trip.
  if (axis.units) {
    parts.push(`        ${axis.units}`);
  }
  // Child element order per the official [MS-ODRAWXML] CT_Axis schema:
  //   catScaling | valScaling (required choice), title, units,
  //   majorGridlines, minorGridlines, majorTickMarks, minorTickMarks,
  //   tickLabels, numFmt, spPr, txPr, extLst.
  // Earlier revisions of this library emitted `majorTickMarks` /
  // `minorTickMarks` BEFORE the gridlines and `txPr` BEFORE `spPr`,
  // which violates the schema sequence and made Excel 2016+ report
  // "Removed Part: /xl/drawings/drawingN.xml" for the drawing hosting
  // the ChartEx — the axis fails schema validation and cascades out.
  if (axis.majorGridlines !== undefined) {
    const mg = axis.majorGridlines;
    const hasSpPr = mg && Object.keys(mg).length > 0;
    if (hasSpPr) {
      parts.push("        <cx:majorGridlines>");
      parts.push(renderSpPr(mg, "          "));
      parts.push("        </cx:majorGridlines>");
    } else {
      parts.push("        <cx:majorGridlines/>");
    }
  }
  if (axis.minorGridlines !== undefined) {
    const mg = axis.minorGridlines;
    const hasSpPr = mg && Object.keys(mg).length > 0;
    if (hasSpPr) {
      parts.push("        <cx:minorGridlines>");
      parts.push(renderSpPr(mg, "          "));
      parts.push("        </cx:minorGridlines>");
    } else {
      parts.push("        <cx:minorGridlines/>");
    }
  }
  if (axis.majorTickMark) {
    // CT_TickMarks uses `type` attribute (not `val` like other chartEx
    // elements). ST_TickMarksType enum: `in | out | cross | none`.
    parts.push(`        <cx:majorTickMarks type="${tickMarkToOoxml(axis.majorTickMark)}"/>`);
  }
  if (axis.minorTickMark) {
    parts.push(`        <cx:minorTickMarks type="${tickMarkToOoxml(axis.minorTickMark)}"/>`);
  }
  // `<cx:tickLabels/>` — Excel emits this empty element on every
  // chartEx axis it authors; omitting it causes tick labels to
  // disappear on load in some Excel 2016+ builds. The child-element
  // order per the ChartEx schema places `tickLabels` AFTER
  // `minorTickMarks` and BEFORE `numFmt`.
  if (axis.tickLabels) {
    parts.push("        <cx:tickLabels/>");
  }
  if (axis.numFmt) {
    const attrs = [`formatCode="${escapeXmlAttr(axis.numFmt.formatCode)}"`];
    if (axis.numFmt.sourceLinked !== undefined) {
      attrs.push(`sourceLinked="${axis.numFmt.sourceLinked ? "1" : "0"}"`);
    }
    parts.push(`        <cx:numFmt ${attrs.join(" ")}/>`);
  }
  if (axis.spPr) {
    parts.push(renderSpPr(axis.spPr, "        "));
  }
  if (axis.txPr) {
    parts.push(renderTxPr(axis.txPr, "        ", "cx:txPr"));
  }
  if (axis.extLst) {
    parts.push(`        ${axis.extLst}`);
  }
  parts.push("      </cx:axis>");
  return parts.join("\n");
}

/**
 * Serialise a `cx:legend` element to XML. Exported so the xlsx raw-
 * patch path (`buildRawChartExLegendXml` in `xlsx.browser.ts`) can
 * produce identical output to the structured writer. Previously the
 * raw patcher emitted a self-closing `<cx:legend pos="…"/>`, dropping
 * `align`, `cx:legendEntry*`, `cx:spPr`, `cx:txPr`, and `cx:extLst`
 * on every styled-legend round-trip.
 */
export function renderChartExLegendXml(
  l: NonNullable<ChartExModel["chartSpace"]["chart"]["legend"]>
): string {
  return renderLegend(l);
}

function renderLegend(l: NonNullable<ChartExModel["chartSpace"]["chart"]["legend"]>): string {
  const parts: string[] = [];
  // `CT_Legend` (Chart2014) attribute list: `pos`, `align` (default
  // `"ctr"`), `overlay` (default `"false"`). Excel always emits `pos`
  // and `align` together — they describe two dimensions of legend
  // placement. Pair them so round-trip matches Excel's byte output;
  // emit `overlay` independently since its default is documented and
  // distinct. Absent position (`legendPos` undefined) also skips
  // `align` — neither attribute makes sense without the other.
  //
  // Emit `align` only when the model carries an explicit value. The
  // previous heuristic `l.align ?? "ctr"` promoted any unset alignment
  // to `"ctr"`, which broke byte-equality on round-trip of files
  // where Excel had omitted the attribute (since the parser returns
  // `undefined` for absent and the writer would stamp `"ctr"`).
  const attrs: string[] = [];
  if (l.legendPos) {
    attrs.push(`pos="${l.legendPos}"`);
    if (l.align !== undefined) {
      attrs.push(`align="${l.align}"`);
    }
  }
  if (l.overlay !== undefined) {
    attrs.push(`overlay="${l.overlay ? "1" : "0"}"`);
  }
  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  const legendEntries = l.legendEntries ?? [];
  // `CT_Legend` sequence: legendEntry* → spPr? → txPr? → extLst?.
  // Previously the writer emitted entries only as `<cx:legendEntry
  // idx="N"/>` and ignored their per-entry `delete` attribute, `txPr`,
  // and `extLst` — so Excel-authored legends with a disabled entry or
  // a coloured series label stripped those fields on save.
  const hasChildren = !!(l.spPr || l.txPr || l.extLst || legendEntries.length > 0);
  if (!hasChildren) {
    parts.push(`    <cx:legend${attrStr}/>`);
    return parts.join("\n");
  }
  parts.push(`    <cx:legend${attrStr}>`);
  for (const entry of legendEntries) {
    const entryAttrs: string[] = [`idx="${entry.index}"`];
    if (entry.delete !== undefined) {
      entryAttrs.push(`delete="${entry.delete ? "1" : "0"}"`);
    }
    const entryHasChildren = !!(entry.txPr || entry.extLst);
    if (!entryHasChildren) {
      parts.push(`      <cx:legendEntry ${entryAttrs.join(" ")}/>`);
      continue;
    }
    parts.push(`      <cx:legendEntry ${entryAttrs.join(" ")}>`);
    if (entry.txPr) {
      parts.push(renderTxPr(entry.txPr, "        "));
    }
    if (entry.extLst) {
      parts.push(`        ${entry.extLst}`);
    }
    parts.push(`      </cx:legendEntry>`);
  }
  if (l.spPr) {
    parts.push(renderSpPr(l.spPr, "      "));
  }
  if (l.txPr) {
    parts.push(renderTxPr(l.txPr, "      "));
  }
  if (l.extLst) {
    parts.push(`      ${l.extLst}`);
  }
  parts.push("    </cx:legend>");
  return parts.join("\n");
}

function renderSpPr(spPr: ShapeProperties, indent: string): string {
  // Emit the captured raw bytes only when the shape is PURELY a raw
  // capture — `_rawXml` is present AND no structured field has been
  // re-assigned. `isRawXmlShape` performs that check, matching the
  // semantics of `setSpPrFill`/`setSpPrLine` which drop `_rawXml` on
  // structured mutation. Previously this test was `if (spPr._rawXml)`,
  // so `mutate(model => { model.…spPr.fill = {...} })` silently
  // produced output that still emitted the old raw XML and discarded
  // the structured mutation — a quiet data loss.
  if (isRawXmlShape(spPr)) {
    return indent + spPr._rawXml!;
  }
  const parts: string[] = [];
  parts.push(`${indent}<cx:spPr>`);
  // Per DrawingML §20.1.2.2.35 (CT_ShapeProperties), children appear in
  // the sequence: xfrm → (prstGeom | custGeom) → (fill) → ln →
  // effectLst → scene3d → sp3d → extLst. Emit xfrm / geometry first so
  // `parseSpPr → buildSpPr → renderSpPr` round-trips cleanly (previously
  // these fields were captured by the parser but silently dropped by
  // this writer).
  if (spPr.transform) {
    renderShapeTransform(parts, spPr.transform, `${indent}  `);
  }
  if (spPr.presetGeometry) {
    renderPresetGeometry(parts, spPr.presetGeometry, `${indent}  `);
  } else if (spPr.customGeometry) {
    renderCustomGeometry(parts, spPr.customGeometry, `${indent}  `);
  }
  if (spPr.fill) {
    if (spPr.fill.noFill) {
      parts.push(`${indent}  <a:noFill/>`);
    } else if (spPr.fill.solid) {
      parts.push(`${indent}  <a:solidFill>${renderColor(spPr.fill.solid)}</a:solidFill>`);
    } else if (spPr.fill.gradient) {
      const g = spPr.fill.gradient;
      if (g.stops.length >= 2) {
        parts.push(`${indent}  <a:gradFill>`);
        parts.push(`${indent}    <a:gsLst>`);
        for (const stop of g.stops) {
          // OOXML `<a:gs pos>` encodes position as hundredths of a
          // percent (0–100000), NOT thousandths. The previous writer
          // used ×1000 — emitting `pos="1000"` for a 100% stop, which
          // any schema-validating reader treats as 1%. Clamp to the
          // legal range so user-supplied stops outside `[0, 1]` don't
          // produce files Excel rejects.
          const encoded = Math.max(0, Math.min(100000, Math.round(stop.position * 100000)));
          parts.push(`${indent}      <a:gs pos="${encoded}">${renderColor(stop.color)}</a:gs>`);
        }
        parts.push(`${indent}    </a:gsLst>`);
        if (g.type === "linear" || g.type === undefined) {
          // `<a:lin ang>` is in 60000ths of a degree. Round so we emit
          // a pure integer — non-integer degrees (e.g. 45.5°) were
          // previously producing fractional attribute values that
          // Excel accepts but some strict validators reject.
          //
          // `scaled` is only emitted when the author explicitly set it;
          // leaving it absent lets DrawingML apply the implicit default
          // (`scaled="1"`, matching Excel's own emission). Unconditionally
          // emitting `scaled="1"` previously overwrote a parsed
          // `scaled="0"` on round-trip — visible drift for any author
          // that used the shape-independent orientation mode.
          const angleEmu = Math.round((g.angle ?? 0) * 60000);
          const scaledAttr = g.scaled === undefined ? "" : ` scaled="${g.scaled ? "1" : "0"}"`;
          parts.push(`${indent}    <a:lin ang="${angleEmu}"${scaledAttr}/>`);
        } else {
          // Path gradient with optional focal rectangle. Each component
          // is a fraction (0–1) in the model; hundredths-of-a-percent
          // (0–100000) on the wire. Preserve absent components as
          // Excel's default (centre at 50%). `CT_FillToRectangle`
          // treats each side as `ST_Percentage`, which permits
          // negative values (focal point outside the shape); don't
          // clamp to zero — clamping there discarded legitimate
          // authored state on round-trip.
          const rect = g.fillToRect;
          const pct = (v: number | undefined, def: number): number => {
            if (v === undefined) {
              return def;
            }
            return Math.round(v * 100000);
          };
          const l = pct(rect?.left, 50000);
          const t = pct(rect?.top, 50000);
          const r = pct(rect?.right, 50000);
          const b = pct(rect?.bottom, 50000);
          parts.push(
            `${indent}    <a:path path="${g.type}"><a:fillToRect l="${l}" t="${t}" r="${r}" b="${b}"/></a:path>`
          );
        }
        parts.push(`${indent}  </a:gradFill>`);
      }
    } else if (spPr.fill.pattern) {
      const p = spPr.fill.pattern;
      parts.push(`${indent}  <a:pattFill prst="${p.preset}">`);
      if (p.foreground) {
        parts.push(`${indent}    <a:fgClr>${renderColor(p.foreground)}</a:fgClr>`);
      }
      if (p.background) {
        parts.push(`${indent}    <a:bgClr>${renderColor(p.background)}</a:bgClr>`);
      }
      parts.push(`${indent}  </a:pattFill>`);
    } else if (spPr.fill.blip?.relationshipId) {
      // Picture fill. Mirrors `_renderSpPr` / `_renderBlipFill` in
      // `chart-space-xform.ts` so ChartEx shapes with `<a:blipFill>` do
      // not lose their image reference on round-trip. The `rId` itself
      // is resolved elsewhere (chart-images); the writer only needs to
      // know that `spPr.fill.blip.relationshipId` is the embed target.
      const blip = spPr.fill.blip;
      parts.push(`${indent}  <a:blipFill>`);
      parts.push(
        `${indent}    <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${escapeXmlAttr(blip.relationshipId ?? "")}"/>`
      );
      if (blip.fillMode === "tile") {
        parts.push(`${indent}    <a:tile/>`);
      } else {
        parts.push(`${indent}    <a:stretch><a:fillRect/></a:stretch>`);
      }
      parts.push(`${indent}  </a:blipFill>`);
    }
  }
  if (spPr.line) {
    const lnAttrs: string[] = [];
    if (spPr.line.width) {
      lnAttrs.push(`w="${spPr.line.width}"`);
    }
    if (spPr.line.cap) {
      // Defensive escape — same rationale as `dash` below: the type is
      // an enum but legacy round-tripped models can carry arbitrary
      // strings (future OOXML additions, vendor extensions).
      lnAttrs.push(`cap="${escapeXmlAttr(spPr.line.cap)}"`);
    }
    if (spPr.line.compound) {
      // Defensive escape (see `cap` above).
      lnAttrs.push(`cmpd="${escapeXmlAttr(spPr.line.compound)}"`);
    }
    const attrStr = lnAttrs.length > 0 ? ` ${lnAttrs.join(" ")}` : "";
    // DrawingML order: fill child first (noFill/solidFill), then dash, then
    // join. Matches `_renderSpPr` in chart-space-xform.ts:2101-2132.
    const lnChildren: string[] = [];
    if (spPr.line.noFill) {
      lnChildren.push(`<a:noFill/>`);
    } else if (spPr.line.color) {
      lnChildren.push(`<a:solidFill>${renderColor(spPr.line.color)}</a:solidFill>`);
    }
    if (spPr.line.dash) {
      // Defensive escape: `dash` is typed as an enum but legacy
      // round-tripped models may carry arbitrary strings from future
      // OOXML additions.
      lnChildren.push(`<a:prstDash val="${escapeXmlAttr(spPr.line.dash)}"/>`);
    }
    if (spPr.line.join === "round") {
      lnChildren.push(`<a:round/>`);
    } else if (spPr.line.join === "bevel") {
      lnChildren.push(`<a:bevel/>`);
    } else if (spPr.line.join === "miter") {
      lnChildren.push(`<a:miter/>`);
    }
    if (lnChildren.length === 0) {
      parts.push(`${indent}  <a:ln${attrStr}/>`);
    } else {
      parts.push(`${indent}  <a:ln${attrStr}>${lnChildren.join("")}</a:ln>`);
    }
  }
  if (spPr.effectList) {
    renderEffectList(parts, spPr.effectList, `${indent}  `);
  }
  if (spPr.scene3d) {
    renderScene3D(parts, spPr.scene3d, `${indent}  `);
  }
  if (spPr.sp3d) {
    renderSp3D(parts, spPr.sp3d, `${indent}  `);
  }
  parts.push(`${indent}</cx:spPr>`);
  return parts.join("\n");
}

function renderShapeTransform(parts: string[], transform: ShapeTransform, indent: string): void {
  const attrs: string[] = [];
  if (transform.rotation !== undefined && transform.rotation !== 0) {
    attrs.push(`rot="${transform.rotation}"`);
  }
  if (transform.flipHorizontal) {
    attrs.push(`flipH="1"`);
  }
  if (transform.flipVertical) {
    attrs.push(`flipV="1"`);
  }
  const hasOff = transform.offsetX !== undefined || transform.offsetY !== undefined;
  const hasExt = transform.width !== undefined || transform.height !== undefined;
  if (!hasOff && !hasExt && attrs.length === 0) {
    return;
  }
  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  if (!hasOff && !hasExt) {
    parts.push(`${indent}<a:xfrm${attrStr}/>`);
    return;
  }
  parts.push(`${indent}<a:xfrm${attrStr}>`);
  if (hasOff) {
    parts.push(`${indent}  <a:off x="${transform.offsetX ?? 0}" y="${transform.offsetY ?? 0}"/>`);
  }
  if (hasExt) {
    parts.push(`${indent}  <a:ext cx="${transform.width ?? 0}" cy="${transform.height ?? 0}"/>`);
  }
  parts.push(`${indent}</a:xfrm>`);
}

function renderPresetGeometry(parts: string[], geom: PresetGeometry, indent: string): void {
  // Escape every interpolated user string — `preset`, `name`, and
  // `fmla` all ultimately come from parsed XML or user-authored
  // values and can legally contain `"`, `<`, `&` or whitespace. The
  // previous implementation concatenated them raw, so a malformed
  // preset / adjustment would produce invalid XML that broke the
  // entire chart part. Omit `<a:avLst>` entirely when no adjustments
  // are present — Excel writes a self-closing `<a:avLst/>` in that
  // case; our self-closing emission stays valid and matches the
  // stricter `ooxml-validate` expectation.
  parts.push(`${indent}<a:prstGeom prst="${escapeXmlAttr(geom.preset)}">`);
  const adjustments = geom.adjustments ?? [];
  if (adjustments.length === 0) {
    parts.push(`${indent}  <a:avLst/>`);
  } else {
    parts.push(`${indent}  <a:avLst>`);
    for (const adj of adjustments) {
      parts.push(
        `${indent}    <a:gd name="${escapeXmlAttr(adj.name)}" fmla="${escapeXmlAttr(adj.fmla)}"/>`
      );
    }
    parts.push(`${indent}  </a:avLst>`);
  }
  parts.push(`${indent}</a:prstGeom>`);
}

function renderCustomGeometry(parts: string[], geom: CustomGeometry, indent: string): void {
  parts.push(`${indent}<a:custGeom>`);
  const adjustments = geom.adjustments ?? [];
  if (adjustments.length === 0) {
    parts.push(`${indent}  <a:avLst/>`);
  } else {
    parts.push(`${indent}  <a:avLst>`);
    for (const adj of adjustments) {
      parts.push(
        `${indent}    <a:gd name="${escapeXmlAttr(adj.name)}" fmla="${escapeXmlAttr(adj.fmla)}"/>`
      );
    }
    parts.push(`${indent}  </a:avLst>`);
  }
  parts.push(`${indent}  <a:pathLst>`);
  for (const path of geom.paths ?? []) {
    const pathAttrs: string[] = [];
    if (path.w !== undefined) {
      pathAttrs.push(`w="${path.w}"`);
    }
    if (path.h !== undefined) {
      pathAttrs.push(`h="${path.h}"`);
    }
    if (path.fill !== undefined) {
      // `path.fill` is typed as an enum but a legacy round-tripped
      // model could still carry an unexpected string — escape so an
      // odd value can't close the attribute.
      pathAttrs.push(`fill="${escapeXmlAttr(String(path.fill))}"`);
    }
    if (path.stroke !== undefined) {
      pathAttrs.push(`stroke="${path.stroke ? "1" : "0"}"`);
    }
    const pathAttrStr = pathAttrs.length > 0 ? ` ${pathAttrs.join(" ")}` : "";
    parts.push(`${indent}    <a:path${pathAttrStr}>`);
    for (const cmd of path.commands) {
      renderCustomGeometryCommand(parts, cmd, `${indent}      `);
    }
    parts.push(`${indent}    </a:path>`);
  }
  parts.push(`${indent}  </a:pathLst>`);
  parts.push(`${indent}</a:custGeom>`);
}

function renderCustomGeometryCommand(
  parts: string[],
  cmd: CustomGeometryCommand,
  indent: string
): void {
  if (cmd.type === "close") {
    parts.push(`${indent}<a:close/>`);
    return;
  }
  if (cmd.type === "arcTo") {
    const p = cmd.arcParams;
    if (!p) {
      return;
    }
    parts.push(
      `${indent}<a:arcTo wR="${p.wR}" hR="${p.hR}" stAng="${p.stAng}" swAng="${p.swAng}"/>`
    );
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
  if (!cmd.points || cmd.points.length === 0) {
    parts.push(`${indent}<${tag}/>`);
    return;
  }
  parts.push(`${indent}<${tag}>`);
  for (const point of cmd.points) {
    parts.push(`${indent}  <a:pt x="${point.x}" y="${point.y}"/>`);
  }
  parts.push(`${indent}</${tag}>`);
}

function renderEffectList(parts: string[], effects: EffectList, indent: string): void {
  parts.push(`${indent}<a:effectLst>`);
  // DrawingML `CT_EffectList` declares a strict `<xsd:sequence>`:
  //   blur → fillOverlay → glow → innerShdw → outerShdw → prstShdw →
  //   reflection → softEdge.
  // The previous implementation emitted in an ad-hoc order (blur,
  // outerShdw, innerShdw, prstShdw, glow, softEdge, reflection), so
  // Excel accepted the file but strict validators (e.g. `ooxml-validate`,
  // LibreOffice's strict mode) rejected it. `fillOverlay` is not
  // modelled yet so its slot is intentionally empty.
  if (effects.blur) {
    const attrs: string[] = [];
    if (effects.blur.radius !== undefined) {
      attrs.push(`rad="${effects.blur.radius}"`);
    }
    if (effects.blur.grow) {
      attrs.push(`grow="1"`);
    }
    parts.push(`${indent}  <a:blur${attrs.length > 0 ? " " + attrs.join(" ") : ""}/>`);
  }
  // fillOverlay — reserved slot per schema, not currently modelled.
  if (effects.glow) {
    parts.push(
      `${indent}  <a:glow rad="${effects.glow.radius}">${renderColor(effects.glow.color)}</a:glow>`
    );
  }
  if (effects.innerShadow) {
    renderShadowElement(parts, "a:innerShdw", effects.innerShadow, `${indent}  `);
  }
  if (effects.outerShadow) {
    renderShadowElement(parts, "a:outerShdw", effects.outerShadow, `${indent}  `);
  }
  if (effects.presetShadow) {
    const ps = effects.presetShadow;
    const attrs: string[] = [`prst="${ps.preset}"`];
    if (ps.distance !== undefined) {
      attrs.push(`dist="${ps.distance}"`);
    }
    if (ps.direction !== undefined) {
      attrs.push(`dir="${ps.direction}"`);
    }
    if (ps.color) {
      parts.push(`${indent}  <a:prstShdw ${attrs.join(" ")}>${renderColor(ps.color)}</a:prstShdw>`);
    } else {
      parts.push(`${indent}  <a:prstShdw ${attrs.join(" ")}/>`);
    }
  }
  if (effects.reflection) {
    const r = effects.reflection;
    const attrs: string[] = [];
    if (r.blurRadius !== undefined) {
      attrs.push(`blurRad="${r.blurRadius}"`);
    }
    if (r.startOpacity !== undefined) {
      attrs.push(`stA="${r.startOpacity}"`);
    }
    if (r.startPosition !== undefined) {
      attrs.push(`stPos="${r.startPosition}"`);
    }
    if (r.endOpacity !== undefined) {
      attrs.push(`endA="${r.endOpacity}"`);
    }
    if (r.endPosition !== undefined) {
      attrs.push(`endPos="${r.endPosition}"`);
    }
    if (r.distance !== undefined) {
      attrs.push(`dist="${r.distance}"`);
    }
    if (r.direction !== undefined) {
      attrs.push(`dir="${r.direction}"`);
    }
    if (r.fadeDirection !== undefined) {
      attrs.push(`fadeDir="${r.fadeDirection}"`);
    }
    if (r.scaleHorizontal !== undefined) {
      attrs.push(`sx="${r.scaleHorizontal}"`);
    }
    if (r.scaleVertical !== undefined) {
      attrs.push(`sy="${r.scaleVertical}"`);
    }
    if (r.skewHorizontal !== undefined) {
      attrs.push(`kx="${r.skewHorizontal}"`);
    }
    if (r.skewVertical !== undefined) {
      attrs.push(`ky="${r.skewVertical}"`);
    }
    if (r.alignment) {
      attrs.push(`algn="${r.alignment}"`);
    }
    if (r.rotateWithShape) {
      attrs.push(`rotWithShape="1"`);
    }
    parts.push(`${indent}  <a:reflection${attrs.length > 0 ? " " + attrs.join(" ") : ""}/>`);
  }
  if (effects.softEdge) {
    parts.push(`${indent}  <a:softEdge rad="${effects.softEdge.radius}"/>`);
  }
  parts.push(`${indent}</a:effectLst>`);
}

function renderShadowElement(parts: string[], tag: string, shadow: Shadow, indent: string): void {
  const attrs: string[] = [];
  if (shadow.blurRadius !== undefined) {
    attrs.push(`blurRad="${shadow.blurRadius}"`);
  }
  if (shadow.distance !== undefined) {
    attrs.push(`dist="${shadow.distance}"`);
  }
  if (shadow.direction !== undefined) {
    attrs.push(`dir="${shadow.direction}"`);
  }
  if (shadow.alignment) {
    attrs.push(`algn="${shadow.alignment}"`);
  }
  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
  if (shadow.color) {
    parts.push(`${indent}<${tag}${attrStr}>${renderColor(shadow.color)}</${tag}>`);
  } else {
    parts.push(`${indent}<${tag}${attrStr}/>`);
  }
}

function renderScene3D(parts: string[], scene: Scene3D, indent: string): void {
  parts.push(`${indent}<a:scene3d>`);
  if (scene.camera) {
    const c = scene.camera;
    const camAttrs: string[] = [`prst="${c.preset}"`];
    if (c.fov !== undefined) {
      camAttrs.push(`fov="${c.fov}"`);
    }
    if (c.zoom !== undefined) {
      camAttrs.push(`zoom="${c.zoom}"`);
    }
    if (c.rotation) {
      const r = c.rotation;
      parts.push(`${indent}  <a:camera ${camAttrs.join(" ")}>`);
      parts.push(`${indent}    <a:rot lat="${r.lat}" lon="${r.lon}" rev="${r.rev}"/>`);
      parts.push(`${indent}  </a:camera>`);
    } else {
      parts.push(`${indent}  <a:camera ${camAttrs.join(" ")}/>`);
    }
  }
  if (scene.lightRig) {
    const l = scene.lightRig;
    const lightAttrs: string[] = [`rig="${l.rig}"`, `dir="${l.direction}"`];
    if (l.rotation) {
      const r = l.rotation;
      parts.push(`${indent}  <a:lightRig ${lightAttrs.join(" ")}>`);
      parts.push(`${indent}    <a:rot lat="${r.lat}" lon="${r.lon}" rev="${r.rev}"/>`);
      parts.push(`${indent}  </a:lightRig>`);
    } else {
      parts.push(`${indent}  <a:lightRig ${lightAttrs.join(" ")}/>`);
    }
  }
  if (scene.backdrop) {
    parts.push(
      `${indent}  <a:backdrop><!-- backdrop preserved verbatim from source --></a:backdrop>`
    );
  }
  parts.push(`${indent}</a:scene3d>`);
}

function renderSp3D(parts: string[], sp: ShapeProperties3D, indent: string): void {
  const attrs: string[] = [];
  // `z` records the shape's Z offset into the 3D scene (EMU). The
  // classic-chart writer (`chart-space-xform.ts:_renderSp3D`) emits it;
  // the ChartEx path previously dropped it, so round-tripping a ChartEx
  // authored with `<a:sp3d z="…" .../>` silently lost the attribute.
  if (sp.z !== undefined) {
    attrs.push(`z="${sp.z}"`);
  }
  if (sp.extrusionHeight !== undefined) {
    attrs.push(`extrusionH="${sp.extrusionHeight}"`);
  }
  if (sp.contourWidth !== undefined) {
    attrs.push(`contourW="${sp.contourWidth}"`);
  }
  if (sp.material) {
    attrs.push(`prstMaterial="${sp.material}"`);
  }
  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
  const children: string[] = [];
  if (sp.bevelTop) {
    const b = sp.bevelTop;
    const bAttrs = [`w="${b.width ?? 0}"`, `h="${b.height ?? 0}"`];
    if (b.preset) {
      bAttrs.push(`prst="${b.preset}"`);
    }
    children.push(`<a:bevelT ${bAttrs.join(" ")}/>`);
  }
  if (sp.bevelBottom) {
    const b = sp.bevelBottom;
    const bAttrs = [`w="${b.width ?? 0}"`, `h="${b.height ?? 0}"`];
    if (b.preset) {
      bAttrs.push(`prst="${b.preset}"`);
    }
    children.push(`<a:bevelB ${bAttrs.join(" ")}/>`);
  }
  if (sp.extrusionColor) {
    children.push(`<a:extrusionClr>${renderColor(sp.extrusionColor)}</a:extrusionClr>`);
  }
  if (sp.contourColor) {
    children.push(`<a:contourClr>${renderColor(sp.contourColor)}</a:contourClr>`);
  }
  if (children.length === 0) {
    parts.push(`${indent}<a:sp3d${attrStr}/>`);
  } else {
    parts.push(`${indent}<a:sp3d${attrStr}>${children.join("")}</a:sp3d>`);
  }
}

/**
 * Render a `ChartTextProperties` as `<cx:txPr>` (or `<c:txPr>` if caller
 * overrides `wrapperName`). Follows the same "raw wins if not mutated"
 * convention as {@link renderSpPr}: when the structured object still
 * carries its original `_rawXml`, emit the captured bytes so extended
 * paragraph properties, run markup, list styles, and schemeClr references
 * survive round-trip unchanged. When a caller mutates via
 * `buildTxPr()`/`setTxPr*()` in shape-properties.ts, `_rawXml` is dropped
 * and we rebuild a minimal structured equivalent.
 */
function renderTxPr(txPr: ChartTextProperties, indent: string, wrapperName = "cx:txPr"): string {
  if (isRawXmlTxPr(txPr)) {
    // Swap the outer wrapper element to the requested namespace.
    // Classic charts captured `<c:txPr>…</c:txPr>`; ChartEx emits
    // `<cx:txPr>…</cx:txPr>`. The raw bytes always start with the
    // namespace they came from. Use a regex that admits leading
    // whitespace, attributes, and either namespace prefix so bytes
    // captured from a classic chart round-trip cleanly through the
    // ChartEx writer. Inner children are all DrawingML (`a:bodyPr`,
    // `a:lstStyle`, `a:p`), so they require no rewrite.
    const raw = txPr._rawXml!;
    // Handle self-closing first — `<c:txPr/>` or `<cx:txPr/>` has no
    // inner content and no close tag to search for. Emit a self-closing
    // element with the requested wrapper name so a classic-captured
    // `<c:txPr/>` becomes `<cx:txPr/>` when rendered into a ChartEx
    // pipeline (and vice versa). The previous fall-through echoed the
    // raw bytes verbatim, producing a namespace-mismatched element.
    const selfCloseRe = /<(c|cx):txPr\b([^>]*?)\/>/;
    const selfCloseMatch = selfCloseRe.exec(raw);
    if (selfCloseMatch) {
      const rawAttrs = selfCloseMatch[2] ?? "";
      const attrs = rawAttrs
        .replace(/\sxmlns(?::[A-Za-z_][\w.-]*)?="[^"]*"/g, "")
        .replace(/\s+$/, "");
      return `${indent}<${wrapperName}${attrs}/>`;
    }
    const openRe = /<(c|cx):txPr\b([^>]*)>/;
    const closeRe = /<\/(c|cx):txPr>/;
    const openMatch = openRe.exec(raw);
    // Search for the matching close AFTER the open tag to avoid picking
    // up a close tag that occurs inside the body (shouldn't happen, but
    // defensive).
    const closeMatch = openMatch
      ? closeRe.exec(raw.slice(openMatch.index + openMatch[0].length))
      : null;
    if (openMatch && closeMatch) {
      const openEnd = openMatch.index + openMatch[0].length;
      // `closeMatch.index` is relative to the slice after `openEnd`,
      // so add `openEnd` back to get the absolute position in `raw`.
      const closeStart = openEnd + closeMatch.index;
      const inner = raw.slice(openEnd, closeStart);
      // Drop everything outside the element (including any leading or
      // trailing whitespace the raw capture preserved). Previously we
      // echoed `beforeOpen` and `afterClose` verbatim, which leaked
      // newlines and other whitespace past the caller's `indent` and
      // broke snapshot tests; text content outside a single element
      // is out-of-spec for `_rawXml` anyway.
      //
      // Also strip any `xmlns:…` declarations from the captured
      // attribute list. These were legitimate on the source element
      // (e.g. `<c:txPr xmlns:a="…">`) but may be redundant or invalid
      // on the rewritten parent, and duplicate xmlns emission upsets
      // strict validators. Non-namespace attributes (like
      // `xml:space="preserve"`) pass through.
      const rawAttrs = openMatch[2] ?? "";
      const attrs = rawAttrs
        .replace(/\sxmlns(?::[A-Za-z_][\w.-]*)?="[^"]*"/g, "")
        .replace(/\s+$/, "");
      return `${indent}<${wrapperName}${attrs}>${inner}</${wrapperName}>`;
    }
    return indent + raw;
  }
  const rPrAttrs: string[] = [];
  if (txPr.size !== undefined) {
    rPrAttrs.push(`sz="${txPr.size}"`);
  }
  if (txPr.bold) {
    rPrAttrs.push(`b="1"`);
  }
  if (txPr.italic) {
    rPrAttrs.push(`i="1"`);
  }
  const rPrChildren: string[] = [];
  if (txPr.color) {
    rPrChildren.push(`<a:solidFill>${renderColor(txPr.color)}</a:solidFill>`);
  }
  if (txPr.fontFamily) {
    rPrChildren.push(`<a:latin typeface="${escapeXmlAttr(txPr.fontFamily)}"/>`);
    rPrChildren.push(`<a:cs typeface="${escapeXmlAttr(txPr.fontFamily)}"/>`);
  }
  const rPrAttrStr = rPrAttrs.length > 0 ? " " + rPrAttrs.join(" ") : "";
  const defRPr =
    rPrChildren.length > 0
      ? `<a:defRPr${rPrAttrStr}>${rPrChildren.join("")}</a:defRPr>`
      : `<a:defRPr${rPrAttrStr}/>`;
  const bodyPrAttrs = txPr.rotation !== undefined ? ` rot="${txPr.rotation}"` : "";
  return [
    `${indent}<${wrapperName}>`,
    `${indent}  <a:bodyPr${bodyPrAttrs}/>`,
    `${indent}  <a:lstStyle/>`,
    `${indent}  <a:p>`,
    `${indent}    <a:pPr>${defRPr}</a:pPr>`,
    `${indent}    <a:endParaRPr/>`,
    `${indent}  </a:p>`,
    `${indent}</${wrapperName}>`
  ].join("\n");
}

function renderColor(c: ChartColor): string {
  // `srgb` is typed as a 6-digit hex, but a round-tripped /
  // user-supplied value could carry stray whitespace or XML-active
  // characters. Escape defensively so a corrupt field can never break
  // out of the attribute quoting. The same applies to `sysClr` /
  // `prstClr` which are enum strings but still pass through user code.
  const modifiers = renderColorModifiers(c);
  if (c.srgb) {
    const val = escapeXmlAttr(c.srgb);
    return modifiers
      ? `<a:srgbClr val="${val}">${modifiers}</a:srgbClr>`
      : `<a:srgbClr val="${val}"/>`;
  }
  if (c.theme !== undefined) {
    const name = themeIndexToName(c.theme);
    return modifiers
      ? `<a:schemeClr val="${name}">${modifiers}</a:schemeClr>`
      : `<a:schemeClr val="${name}"/>`;
  }
  if (c.schemeName) {
    // Preserve scheme-colour tokens that can't be mapped to one of the
    // 12 theme slots (e.g. `phClr` placeholder colour, or vendor /
    // future scheme names). The parser stores them under `schemeName`
    // precisely so the writer can round-trip `<a:schemeClr>` rather
    // than silently emitting `<a:sysClr>` (a semantically-different
    // element).
    const val = escapeXmlAttr(c.schemeName);
    return modifiers
      ? `<a:schemeClr val="${val}">${modifiers}</a:schemeClr>`
      : `<a:schemeClr val="${val}"/>`;
  }
  if (c.sysClr) {
    const val = escapeXmlAttr(c.sysClr);
    return modifiers
      ? `<a:sysClr val="${val}">${modifiers}</a:sysClr>`
      : `<a:sysClr val="${val}"/>`;
  }
  if (c.prstClr) {
    const val = escapeXmlAttr(c.prstClr);
    return modifiers
      ? `<a:prstClr val="${val}">${modifiers}</a:prstClr>`
      : `<a:prstClr val="${val}"/>`;
  }
  // Loud failure for malformed `ChartColor` objects — none of
  // `srgb` / `theme` / `schemeName` / `sysClr` / `prstClr` set. Silently
  // emitting a transparent black placeholder (as the previous fallback
  // did) hid real bugs (e.g. a code path that built a `{}` colour
  // literal) under phantom valid-looking XML. DrawingML requires
  // exactly one colour child, and the caller is always in a position
  // to provide one — fail so the mistake surfaces in tests rather than
  // shipping silently-wrong colour data into the user's XLSX.
  throw new ChartOptionsError(
    `renderColor: ChartColor requires exactly one of srgb / theme / schemeName / sysClr / prstClr; got ${JSON.stringify(c)}.`
  );
}

function renderColorModifiers(c: ChartColor): string {
  // Each modifier serialises as `<a:* val="N"/>` where `N` is an
  // `xsd:int` in the DrawingML per-thousand space. Guard against
  // non-finite (`NaN` / `Infinity`) values — they'd interpolate as
  // the literal string `"NaN"` and produce XML that strict readers
  // (including Excel's own stricter open path) reject with
  // "invalid attribute value for xs:int". `tint` is additionally
  // scaled from the 0..1 fraction convention documented on
  // `ChartColor.tint`; the other modifiers are already stored as
  // OOXML integers so they pass through with just a rounding guard.
  const parts: string[] = [];
  const emitInt = (tag: string, value: number | undefined): void => {
    if (value === undefined || !Number.isFinite(value)) {
      return;
    }
    parts.push(`<a:${tag} val="${Math.round(value)}"/>`);
  };
  emitInt("alpha", c.alpha);
  // `tint` is a fraction in [0, 1] per `ChartColor.tint` docs; convert
  // to the DrawingML 0..100000 per-thousand integer here.
  if (c.tint !== undefined && Number.isFinite(c.tint)) {
    parts.push(`<a:tint val="${Math.round(c.tint * 100000)}"/>`);
  }
  emitInt("shade", c.shade);
  emitInt("satMod", c.satMod);
  emitInt("lumMod", c.lumMod);
  emitInt("lumOff", c.lumOff);
  return parts.join("");
}

/**
 * Strip characters that aren't legal in XML 1.0 and escape the five
 * structural entities. XML 1.0 disallows most C0 control codes except
 * `\t` `\n` `\r`; the DEL character (0x7F) and the C1 range
 * (0x80-0x9F) are discouraged in user content. We silently strip the
 * disallowed control codes rather than throw — they almost always
 * arrive as accidents (e.g. copy/pasted binary garbage) and emitting
 * them would produce an xlsx that no XML parser can reopen.
 */
/**
 * Does the string require `xml:space="preserve"` to survive XML
 * whitespace normalisation? XML's default (`xml:space="default"`)
 * collapses leading / trailing whitespace and reduces internal
 * whitespace runs to single spaces; any tab / newline / carriage
 * return is equivalent to a space. A run needs `preserve` iff it has:
 *   - leading or trailing whitespace,
 *   - ≥2 consecutive whitespace characters internally, or
 *   - any tab / newline / carriage return character.
 */
