import type {
  ChartDataSnapshot,
  ChartWorksheetSnapshot
} from "@excel/chart/core/chart-data-snapshot";
import { chartSnapshotCellKey } from "@excel/chart/core/chart-data-snapshot";
import type {
  ChartExModel,
  ChartExNumericDimension,
  ChartExStringDimension
} from "@excel/chart/model/chart-ex-types";
/**
 * Chart cache populator.
 *
 * Walks a ChartModel, finds every `numRef`/`strRef` formula, resolves it against
 * the actual worksheet cell values in the workbook, and populates the cache
 * points so that headless consumers (PDF export, image preview, other readers
 * that don't recalculate formulas) see non-empty charts.
 *
 * Excel itself recomputes caches on open, so this is a best-effort enrichment:
 *   - empty/missing cells produce null values at the correct index
 *   - formula-bearing cells use their cached result when available
 *   - non-existent sheets or malformed formulas are skipped silently
 */
import type {
  AxisDataSource,
  ChartModel,
  ChartTitle,
  ChartTypeGroup,
  DataLabelsRange,
  MultiLevelStringCache,
  NumberCache,
  NumberReference,
  SeriesBase,
  StringCache,
  StringReference,
  MultiLevelStringReference
} from "@excel/chart/model/types";
import { colCache } from "@excel/utils/col-cache";
import { dateToExcel } from "@utils/utils.base";

/**
 * Populate all number/string caches in a ChartModel from the given workbook.
 * Mutates the model in place. Safe to call multiple times (idempotent).
 *
 * @param model - The chart model to enrich
 * @param workbook - The workbook used to resolve sheet/cell references
 * @param contextWorksheet - Optional worksheet providing the default scope for
 *   defined-name resolution. When a defined name has a sheet-scoped entry
 *   matching this worksheet's workbook index (`localSheetId`), that entry
 *   wins over the workbook-scoped entry. Supplying this argument is required
 *   to correctly resolve sheet-scoped names; omitting it falls back to
 *   workbook-scoped names only.
 */
export interface ChartCachePlan {
  readonly writes: readonly ChartCacheWrite[];
  readonly diagnostics: readonly { code: "unresolved-reference"; formula: string }[];
}

export type ChartCacheWrite =
  | {
      readonly kind: "number-cache";
      readonly target: NumberReference;
      readonly expectedFormula: string;
      readonly value: NumberCache;
    }
  | {
      readonly kind: "string-cache";
      readonly target: StringReference | DataLabelsRange;
      readonly expectedFormula: string;
      readonly value: StringCache;
    }
  | {
      readonly kind: "multi-level-cache";
      readonly target: MultiLevelStringReference;
      readonly expectedFormula: string;
      readonly value: MultiLevelStringCache;
    }
  | {
      readonly kind: "chart-ex-string-levels";
      readonly target: ChartExStringDimension;
      readonly expectedFormula: string;
      readonly value: NonNullable<ChartExStringDimension["levels"]>;
    }
  | {
      readonly kind: "chart-ex-number-levels";
      readonly target: ChartExNumericDimension;
      readonly expectedFormula: string;
      readonly value: NonNullable<ChartExNumericDimension["levels"]>;
    };

export interface ChartCachePlanningOptions {
  readonly includeSkippedDimensions?: boolean;
}

export function collectChartReferencedCells(
  formulas: readonly string[],
  snapshot: ChartDataSnapshot
): Map<string, Set<string>> | undefined {
  const requested = new Map<string, Set<string>>();
  const ctx = buildResolverContext(snapshot, [], requested);
  for (const formula of formulas) {
    if (!resolveReference(formula, ctx) && !resolveReferenceMatrix(formula, ctx)) {
      return undefined;
    }
  }
  return requested;
}

export function buildChartCachePlan(
  model: Readonly<ChartModel>,
  snapshot: ChartDataSnapshot
): ChartCachePlan {
  const writes: ChartCacheWrite[] = [];
  populateChartCaches(model as ChartModel, snapshot, writes);
  return { writes, diagnostics: [] };
}

export function applyChartCachePlan(plan: ChartCachePlan): void {
  applyCacheWrites(plan.writes);
}

function populateChartCaches(
  model: ChartModel,
  snapshot: ChartDataSnapshot,
  writes: ChartCacheWrite[]
): void {
  const plotArea = model.chart?.plotArea;
  if (!plotArea) {
    return;
  }
  const date1904 = snapshot.date1904;
  const ctx = buildResolverContext(snapshot, writes);
  // Fill the classic chart title's `<c:strRef>` cache when the title
  // was authored as `{ formula: "..." }`. The writer already emits
  // `<c:strCache>` for any `strRef.cache.points` it finds; without
  // this fill a formula-bound title round-trips as
  // `<c:strRef><c:f>…</c:f></c:strRef>` with no cache, so readers that
  // don't recalculate formulas (preview tooling, headless converters)
  // see a blank title frame. ChartEx has the same machinery in
  // `fillChartExCaches`; keeping them symmetric.
  fillClassicTitleCache(model.chart?.title, ctx);
  // Axis titles follow the same shape — `ChartTitle` is the same type
  // on `axis.title` and carries the same `strRef.cache`. Round-trip
  // parity requires filling them too.
  for (const axis of plotArea.axes ?? []) {
    fillClassicTitleCache(axis.title, ctx);
  }
  for (const group of plotArea.chartTypes) {
    fillGroupCaches(group, ctx, date1904);
  }
}

/**
 * Populate a classic `ChartTitle.strRef.cache` from its formula when
 * the cache is empty. Shared between chart title and axis titles.
 * No-ops for titles that were authored as rich text / rawTx / a
 * literal string — only formula-bound titles carry a strRef.
 */
function fillClassicTitleCache(title: ChartTitle | undefined, ctx: ResolverContext): void {
  const strRef = title?.strRef;
  if (!strRef?.formula) {
    return;
  }
  if (strRef.cache?.points && strRef.cache.points.length > 0) {
    return;
  }
  const resolved = resolveReference(strRef.formula, ctx);
  if (!resolved) {
    return;
  }
  const points: Array<{ index: number; value: string }> = [];
  let idx = 0;
  for (const cell of resolved.cells) {
    const s = toString(cell.value);
    if (s !== undefined) {
      points.push({ index: idx, value: s });
    }
    idx += 1;
  }
  // Gate on "any resolved cell", not "any non-empty stringified
  // value". Sibling fillers (`fillNumRefInternal` / `fillStrRefInternal`)
  // emit a sparse cache `{ pointCount: N, points: [] }` when the
  // resolved range had no stringifiable cells — that's the whole
  // reason the fill exists: readers that don't recalculate formulas
  // still need the `pointCount` envelope to size sparse arrays
  // correctly. The title filler was previously inconsistent: it
  // tracked `idx` through empty cells but then dropped the cache
  // entirely unless at least one cell yielded a non-empty string.
  // That meant a formula-bound title whose source cell is currently
  // blank round-tripped as `<c:strRef><c:f>…</c:f></c:strRef>` with
  // no cache — exactly the failure mode the fill was written to
  // prevent.
  if (resolved.cells.length > 0) {
    setCache(strRef, { pointCount: idx, points }, ctx);
  }
}

export function buildChartExCachePlan(
  model: Readonly<ChartExModel>,
  snapshot: ChartDataSnapshot,
  options: ChartCachePlanningOptions = {}
): ChartCachePlan {
  const writes: ChartCacheWrite[] = [];
  populateChartExCaches(model as ChartExModel, snapshot, writes, options);
  return { writes, diagnostics: [] };
}

export function applyChartExCachePlan(plan: ChartCachePlan): void {
  applyCacheWrites(plan.writes);
}

function populateChartExCaches(
  model: ChartExModel,
  snapshot: ChartDataSnapshot,
  writes: ChartCacheWrite[],
  options: ChartCachePlanningOptions
): void {
  // Defensive guard — parseChartEx emits `chartData.data = []` even for
  // malformed documents, but downstream callers (and unit fixtures) can
  // construct partial models. Match the classic `fillChartCaches` which
  // no-ops when `plotArea` is missing.
  const data = model.chartSpace?.chartData?.data;
  const ctx = buildResolverContext(snapshot, writes);
  // Fill the ChartEx title's `<cx:txData>` cache. The builder accepts a
  // `{ formula: string }` title and parks `strRef: { formula, cache:
  // { points: [] } }` on the model; the writer emits `<cx:v>` from the
  // first cached point. Without this fill, a formula-linked title
  // round-trips as `<cx:txData><cx:f>…</cx:f></cx:txData>` (no cached
  // value), so readers without a formula engine see an empty title
  // until Excel recalculates.
  const title = model.chartSpace?.chart?.title;
  const titleStrRef = (
    title as
      | {
          strRef?: {
            formula?: string;
            cache?: { points: Array<{ index: number; value: string }> };
          };
        }
      | undefined
  )?.strRef;
  if (titleStrRef?.formula && (titleStrRef.cache?.points?.length ?? 0) === 0) {
    const resolved = resolveReference(titleStrRef.formula, ctx);
    if (resolved) {
      const first = resolved.cells.find(cell => toString(cell.value) !== undefined);
      if (first) {
        const value = toString(first.value);
        if (value !== undefined) {
          setCache(titleStrRef as StringReference, { points: [{ index: 0, value }] }, ctx);
        }
      }
    }
  }
  if (!data || data.length === 0) {
    return;
  }
  for (const entry of data) {
    if (
      entry.strDim?.formula &&
      (options.includeSkippedDimensions || !hasChartExStringPoints(entry.strDim))
    ) {
      const resolved = resolveReference(entry.strDim.formula, ctx);
      if (resolved && resolved.cells.length > 0) {
        const points: Array<{ index: number; value: string }> = [];
        let idx = 0;
        for (const cell of resolved.cells) {
          const value = toString(cell.value);
          if (value !== undefined && value !== "") {
            points.push({ index: idx, value });
          }
          idx++;
        }
        // Write levels whenever we had resolvable cells: even all-empty
        // resolves should emit `[{ ptCount: N, points: [] }]` so Excel
        // sizes the sparse array correctly. This matches the classic
        // `fillNumRefInternal` / `fillStrRefInternal` behaviour which
        // the null-value-cell test explicitly depends on.
        setLevels(entry.strDim, [{ ptCount: idx, points }], "chart-ex-string-levels", ctx);
      }
    }
    if (
      entry.numDim?.formula &&
      (options.includeSkippedDimensions || !hasChartExNumberPoints(entry.numDim))
    ) {
      const resolved = resolveReference(entry.numDim.formula, ctx);
      if (resolved && resolved.cells.length > 0) {
        const points: Array<{ index: number; value: number }> = [];
        let idx = 0;
        for (const cell of resolved.cells) {
          const value = toNumber(cell.value, snapshot.date1904);
          if (value !== undefined) {
            points.push({ index: idx, value });
          }
          idx++;
        }
        // Preserve any `formatCode` already attached to the original
        // numeric level so a round-tripped `<cx:lvl formatCode="…">`
        // keeps its numFmt — the old path blindly replaced `levels`
        // with a freshly-built object and silently dropped the
        // attribute on every save.
        const existingLvl = entry.numDim.levels?.[0];
        setLevels(
          entry.numDim,
          [
            {
              ptCount: idx,
              points,
              ...(existingLvl?.formatCode ? { formatCode: existingLvl.formatCode } : {})
            }
          ],
          "chart-ex-number-levels",
          ctx
        );
      }
    }
  }
}

function fillGroupCaches(group: ChartTypeGroup, ctx: ResolverContext, date1904?: boolean): void {
  // Group-level `dataLabels.dataLabelsRange` (Excel 2013+ "Value From
  // Cells" at the chart-type group level). The builder places
  // `dataLabelsRange` on the group when the caller passes `dataLabels:
  // { valueFromCells }` at the group level — we previously only filled
  // the per-series variant, so a group-wide value-from-cells range
  // silently stayed empty until a formula engine recalculated it.
  const groupDataLabels = (group as { dataLabels?: { dataLabelsRange?: DataLabelsRange } })
    .dataLabels;
  if (groupDataLabels?.dataLabelsRange?.formula) {
    fillDataLabelsRange(groupDataLabels.dataLabelsRange, ctx);
  }
  const series = (group as { series?: SeriesBase[] }).series;
  if (!series) {
    return;
  }
  for (const s of series) {
    fillSeriesCaches(s, ctx, date1904);
  }
}

function hasChartExStringPoints(
  dim: NonNullable<ChartExModel["chartSpace"]["chartData"]["data"][number]["strDim"]>
): boolean {
  // Hierarchical charts (treemap / sunburst) point their `<cx:strDim>`
  // at a contiguous multi-column range (`$A$2:$C$N`). A single flat
  // `<cx:lvl>` cache across 3 columns × N rows (3×N points) does not
  // survive Excel's hierarchical-data pivot: the chart draws nothing
  // because the loader cannot re-derive the row × column layout from
  // a flat point list. Excel's own writer omits the cache entirely for
  // treemap + sunburst and re-reads the cells on open. Mirror that:
  // when a strDim is tagged `_skipCache` (set by the builder for
  // hierarchical chartEx series), treat it as "already populated"
  // so `fillChartExCaches` leaves it alone and the renderer emits
  // just the `<cx:f>` reference.
  if ((dim as { _skipCache?: boolean })._skipCache) {
    return true;
  }
  return dim.levels?.some(level => level.points.length > 0) ?? false;
}

function hasChartExNumberPoints(
  dim: NonNullable<ChartExModel["chartSpace"]["chartData"]["data"][number]["numDim"]>
): boolean {
  if ((dim as { _skipCache?: boolean })._skipCache) {
    return true;
  }
  return dim.levels?.some(level => level.points.length > 0) ?? false;
}

function fillSeriesCaches(series: SeriesBase, ctx: ResolverContext, date1904?: boolean): void {
  // Series name (tx): may be strRef
  const tx = (series as { tx?: { strRef?: StringReference } }).tx;
  if (tx?.strRef) {
    fillStrRefInternal(tx.strRef, ctx);
  }

  // Category / X axis data source
  const cat = (series as { cat?: AxisDataSource }).cat;
  if (cat) {
    fillAxisDataSource(cat, ctx, date1904);
  }
  const xVal = (series as { xVal?: AxisDataSource }).xVal;
  if (xVal) {
    fillAxisDataSource(xVal, ctx, date1904);
  }

  // Numeric values — val, yVal, bubbleSize
  const val = (series as { val?: { numRef?: NumberReference } }).val;
  if (val?.numRef) {
    fillNumRefInternal(val.numRef, ctx, date1904);
  }
  const yVal = (series as { yVal?: { numRef?: NumberReference } }).yVal;
  if (yVal?.numRef) {
    fillNumRefInternal(yVal.numRef, ctx, date1904);
  }
  const bubbleSize = (series as { bubbleSize?: { numRef?: NumberReference } }).bubbleSize;
  if (bubbleSize?.numRef) {
    fillNumRefInternal(bubbleSize.numRef, ctx, date1904);
  }

  // Error bars may have custom plus/minus references
  const errorBars = (series as { errorBars?: unknown }).errorBars;
  if (errorBars) {
    const list = Array.isArray(errorBars) ? errorBars : [errorBars];
    for (const eb of list as Array<{
      plus?: { numRef?: NumberReference };
      minus?: { numRef?: NumberReference };
    }>) {
      if (eb.plus?.numRef) {
        fillNumRefInternal(eb.plus.numRef, ctx, date1904);
      }
      if (eb.minus?.numRef) {
        fillNumRefInternal(eb.minus.numRef, ctx, date1904);
      }
    }
  }

  // "Value From Cells" data labels (Excel 2013+) — populate the
  // `c15:datalabelsRange` cache so readers without a formula engine see
  // the right labels and so the writer can emit `<c15:dlblRangeCache>`.
  const dataLabels = (series as { dataLabels?: { dataLabelsRange?: DataLabelsRange } }).dataLabels;
  if (dataLabels?.dataLabelsRange?.formula) {
    fillDataLabelsRange(dataLabels.dataLabelsRange, ctx);
  }
}

function fillDataLabelsRange(range: DataLabelsRange, ctx: ResolverContext): void {
  if (range.cache?.points && range.cache.points.length > 0) {
    return;
  }
  const resolved = resolveReference(range.formula, ctx);
  if (!resolved) {
    return;
  }
  const points: Array<{ index: number; value: string }> = [];
  let idx = 0;
  for (const cell of resolved.cells) {
    const s = toString(cell.value);
    if (s !== undefined && s !== "") {
      points.push({ index: idx, value: s });
    }
    idx++;
  }
  // Match the sibling fillers (`fillNumRefInternal`, `fillStrRefInternal`,
  // `fillChartExCaches`) — gate on "resolved any cells" rather than
  // "collected any non-empty values". An all-blank range still needs a
  // sparse `{ pointCount: N, points: [] }` cache so Excel sizes the
  // label array correctly; dropping the cache entirely under-counted
  // the label index and desynchronised labels from their data points.
  if (idx > 0) {
    setCache(range, { pointCount: idx, points }, ctx);
  }
}

function fillAxisDataSource(src: AxisDataSource, ctx: ResolverContext, date1904?: boolean): void {
  if (src.strRef) {
    fillStrRefInternal(src.strRef, ctx);
  }
  if (src.numRef) {
    fillNumRefInternal(src.numRef, ctx, date1904);
  }
  if (src.multiLvlStrRef) {
    fillMultiLvlStrRefInternal(src.multiLvlStrRef, ctx);
  }
}

/**
 * Populate a NumberReference cache from the workbook.
 * Only fills if `cache.points` is currently empty.
 *
 * @param contextWorksheet - Optional worksheet whose sheet-scoped defined
 *   names take precedence over workbook-scoped ones.
 */
function fillNumRefInternal(ref: NumberReference, ctx: ResolverContext, date1904?: boolean): void {
  if (!ref.formula) {
    return;
  }
  if (ref.cache?.points && ref.cache.points.length > 0) {
    return; // already populated
  }
  const resolved = resolveReference(ref.formula, ctx);
  if (!resolved) {
    return;
  }
  const points: NumberCache["points"] = [];
  let idx = 0;
  for (const cell of resolved.cells) {
    const n = toNumber(cell.value, date1904);
    if (n !== undefined) {
      points.push({ index: idx, value: n });
    }
    idx++;
  }
  // `idx === 0` means we resolved no cells at all — treat the same as
  // an un-resolvable reference and keep any pre-existing cache intact.
  // When we did resolve cells but all of them were empty/undefined,
  // still emit the cache with `points: []` and the correct
  // `pointCount`: Excel needs the pointCount to size sparse arrays
  // correctly even when every slot is blank.
  if (idx === 0) {
    return;
  }
  setCache(ref, { points, pointCount: idx }, ctx);
}

/**
 * Populate a StringReference cache from the workbook.
 * Only fills if `cache.points` is currently empty.
 *
 * @param contextWorksheet - Optional worksheet whose sheet-scoped defined
 *   names take precedence over workbook-scoped ones.
 */
function fillStrRefInternal(ref: StringReference, ctx: ResolverContext): void {
  if (!ref.formula) {
    return;
  }
  if (ref.cache?.points && ref.cache.points.length > 0) {
    return;
  }
  const resolved = resolveReference(ref.formula, ctx);
  if (!resolved) {
    return;
  }
  const points: StringCache["points"] = [];
  let idx = 0;
  for (const cell of resolved.cells) {
    const s = toString(cell.value);
    if (s !== undefined && s !== "") {
      points.push({ index: idx, value: s });
    }
    idx++;
  }
  // See `fillNumRefInternal`: no cells resolved → preserve any
  // pre-existing cache; otherwise write the computed cache (possibly
  // with `points: []` and `pointCount` reflecting blank slots).
  if (idx === 0) {
    return;
  }
  setCache(ref, { points, pointCount: idx }, ctx);
}

function fillMultiLvlStrRefInternal(ref: MultiLevelStringReference, ctx: ResolverContext): void {
  if (!ref.formula) {
    return;
  }
  if (ref.cache?.levels?.some(level => level.points.length > 0)) {
    return;
  }
  const resolved = resolveReferenceMatrix(ref.formula, ctx);
  if (!resolved) {
    return;
  }

  const levels: StringCache[] = [];
  for (let col = 0; col < resolved.columnCount; col++) {
    const points: StringCache["points"] = [];
    for (let row = 0; row < resolved.rowCount; row++) {
      const value = toString(resolved.values[row]?.[col]);
      if (value !== undefined && value !== "") {
        points.push({ index: row, value });
      }
    }
    levels.push({ pointCount: resolved.rowCount, points });
  }
  setCache(ref, { pointCount: resolved.rowCount, levels }, ctx);
}

export function buildChartCachePlanForReferences(
  refs: {
    readonly number?: Readonly<NumberReference>;
    readonly string?: Readonly<StringReference>;
    readonly multiLevelString?: Readonly<MultiLevelStringReference>;
  },
  snapshot: ChartDataSnapshot
): ChartCachePlan {
  const writes: ChartCacheWrite[] = [];
  const ctx = buildResolverContext(snapshot, writes);
  const number = refs.number as NumberReference | undefined;
  const string = refs.string as StringReference | undefined;
  const multiLevelString = refs.multiLevelString as MultiLevelStringReference | undefined;
  if (number) {
    fillNumRefInternal(number, ctx, snapshot.date1904);
  }
  if (string) {
    fillStrRefInternal(string, ctx);
  }
  if (multiLevelString) {
    fillMultiLvlStrRefInternal(multiLevelString, ctx);
  }
  return { writes, diagnostics: [] };
}

function replaceObjectValue(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): void {
  if (Array.isArray(target) && Array.isArray(source)) {
    target.splice(0, target.length, ...structuredClone(source));
    return;
  }
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key];
    }
  }
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isObject(current) && isObject(value) && Array.isArray(current) === Array.isArray(value)) {
      replaceObjectValue(current, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
}

function applyCacheWrites(writes: readonly ChartCacheWrite[]): void {
  for (const write of writes) {
    if (write.target.formula !== write.expectedFormula) {
      throw new Error("Chart reference changed after cache planning");
    }
  }
  for (const write of writes) {
    const key = write.kind.endsWith("levels") ? "levels" : "cache";
    const target = write.target as unknown as Record<string, unknown>;
    const current = target[key];
    if (isObject(current) && isObject(write.value)) {
      replaceObjectValue(current, write.value as Record<string, unknown>);
    } else {
      target[key] = structuredClone(write.value);
    }
  }
}

function setCache<
  T extends NumberReference | StringReference | MultiLevelStringReference | DataLabelsRange
>(
  target: T,
  value: T extends NumberReference
    ? NumberCache
    : T extends MultiLevelStringReference
      ? MultiLevelStringCache
      : StringCache,
  ctx: ResolverContext
): void {
  if (target.formula) {
    const kind =
      "levels" in value
        ? "multi-level-cache"
        : typeof value.points[0]?.value === "number"
          ? "number-cache"
          : "string-cache";
    ctx.writes.push({ kind, target, expectedFormula: target.formula, value } as ChartCacheWrite);
  }
}

function setLevels<T extends ChartExStringDimension | ChartExNumericDimension>(
  target: T,
  value: NonNullable<T["levels"]>,
  kind: "chart-ex-string-levels" | "chart-ex-number-levels",
  ctx: ResolverContext
): void {
  if (target.formula) {
    ctx.writes.push({ kind, target, expectedFormula: target.formula, value } as ChartCacheWrite);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedReference {
  worksheet: ChartWorksheetSnapshot;
  cells: Array<{ value: unknown }>;
}

interface ResolvedReferenceMatrix {
  worksheet: ChartWorksheetSnapshot;
  values: unknown[][];
  rowCount: number;
  columnCount: number;
}

/**
 * Internal context carried through recursive reference resolution.
 *
 * `localSheetId` is the 0-based workbook position of {@link contextWorksheet}
 * in `workbook.worksheets`, matching the semantics of OOXML's
 * `definedName/@localSheetId`. It is used to give sheet-scoped defined names
 * precedence over workbook-scoped names when both exist with the same bare
 * name.
 *
 * `visitedDefinedNames` tracks the set of defined names currently being
 * expanded in the call stack so that `A -> B -> A` cycles terminate.
 * The set is mutated (added/deleted) rather than copied on each call; this
 * is safe because resolution is single-threaded and each recursive call
 * properly cleans up before returning.
 *
 * `definedNameDepth` is a defence-in-depth counter against non-cyclic but
 * pathologically-deep chains (`A → B → C → D → …`) that the cycle guard
 * cannot catch. Without a hard cap, a malicious or malformed workbook
 * with hundreds of non-cyclic nested names can exhaust the JS call
 * stack and throw `RangeError: Maximum call stack size exceeded` from
 * deep inside the resolver. The limit matches LibreOffice's defined-name
 * expansion ceiling.
 */
interface ResolverContext {
  snapshot: ChartDataSnapshot;
  writes: ChartCacheWrite[];
  requestedCells?: Map<string, Set<string>>;
  localSheetId?: number;
  visitedDefinedNames: Set<string>;
  definedNameDepth: number;
}

/**
 * Maximum defined-name expansion depth. Picked to match LibreOffice and
 * comfortably exceed anything a legitimate workbook produces (Excel's UI
 * stops the user well before this).
 */
const MAX_DEFINED_NAME_DEPTH = 128;

function buildResolverContext(
  snapshot: ChartDataSnapshot,
  writes: ChartCacheWrite[],
  requestedCells?: Map<string, Set<string>>
): ResolverContext {
  return {
    snapshot,
    writes,
    requestedCells,
    localSheetId: snapshot.contextLocalSheetId,
    visitedDefinedNames: new Set(),
    definedNameDepth: 0
  };
}

/**
 * Resolve a chart formula like `Sheet1!$A$1:$A$4` or `'My Sheet'!$B$2:$B$5`
 * into a sequence of cell values in row-major order.
 *
 * Multi-range unions (`Sheet1!A1:A3,Sheet1!A5:A7`) are flattened preserving order.
 * Returns undefined if the reference cannot be resolved.
 *
 * Resolution strategy (first match wins):
 *   1. Structured table reference (`Table1[Column]`)
 *   2. Defined name (workbook- or sheet-scoped), recursively expanded
 *   3. Direct A1 cell/range references (possibly comma-separated union)
 */
function resolveReference(formula: string, ctx: ResolverContext): ResolvedReference | undefined {
  const structured = resolveStructuredReference(formula, ctx);
  if (structured) {
    return structured;
  }

  const named = resolveDefinedNameReference(formula, ctx);
  if (named) {
    return named;
  }

  // Multi-range support: Excel uses commas or semicolons between sub-refs.
  // Inside quoted sheet names, commas don't count — do a safe split.
  const parts = splitFormulaRanges(formula);
  let worksheet: ChartWorksheetSnapshot | undefined;
  const cells: Array<{ value: unknown }> = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    let decoded;
    try {
      decoded = colCache.decodeEx(trimmed);
    } catch {
      return undefined;
    }
    // `decodeEx` can also return `{ sheetName, error: "#REF!" }` for
    // malformed references — that shape has neither `row`/`col` nor
    // `top`/`left`, so without an explicit check we would return
    // `{ worksheet, cells: [] }` and silently mask an invalid formula as a
    // successful empty resolution.
    if ("error" in decoded) {
      return undefined;
    }
    const sheetName = decoded.sheetName;
    if (!sheetName) {
      return undefined;
    }
    const ws = getSnapshotWorksheet(ctx.snapshot, sheetName);
    if (!ws) {
      return undefined;
    }
    // Track first resolved worksheet for the return value
    if (!worksheet) {
      worksheet = ws;
    }

    if ("top" in decoded && "left" in decoded) {
      // Range: iterate in row-major order matching Excel's cache layout.
      // For vertical ranges (single column), this is top→bottom.
      // For horizontal ranges (single row), this is left→right.
      // For 2D ranges, row-major (left→right, top→bottom).
      const top = decoded.top as number;
      const left = decoded.left as number;
      const bottom = decoded.bottom as number;
      const right = decoded.right as number;
      for (let r = top; r <= bottom; r++) {
        for (let c = left; c <= right; c++) {
          cells.push({ value: readCell(ws, r, c, ctx) });
        }
      }
    } else if ("row" in decoded && "col" in decoded) {
      const r = decoded.row as number;
      const c = decoded.col as number;
      cells.push({ value: readCell(ws, r, c, ctx) });
    }
  }

  if (!worksheet) {
    return undefined;
  }
  return { worksheet, cells };
}

/**
 * Regex matching a bare Excel defined name (no sheet prefix, no `$`, no `:`,
 * no `!`, no `,`). Excel's grammar requires the first character to be a
 * letter, underscore, or backslash, and disallows names that look like cell
 * references; we don't try to validate name legality here — the final
 * authority is whether `workbook.definedNames` has a matching entry.
 *
 * Allowing Unicode letters makes this work for CJK defined names, which are
 * common in Chinese Excel files.
 */
const BARE_DEFINED_NAME_RE = /^[A-Za-z_\\\u00A0-\uFFFF][\w.?\\\u00A0-\uFFFF]*$/;

/**
 * Attempt to resolve {@link formula} as a defined name and expand to the
 * underlying A1 ranges. Supports both bare names (`MyRange`) and qualified
 * names (`Sheet1!MyRange`, `'My Sheet'!MyRange`).
 *
 * Name-scope resolution matches Excel semantics:
 *   - Qualified `Sheet!Name` → sheet-scoped entry on `Sheet`, else
 *     workbook-scoped
 *   - Bare `Name` → sheet-scoped entry on the context worksheet (when
 *     provided), else workbook-scoped
 *
 * The result of expanding the name is resolved recursively, so chart
 * formulas that target a named formula (e.g. `OFFSET(...)` stored as a
 * defined name) do not silently fall through — when the name resolves to
 * another reference-like expression, we follow it.
 */
function resolveDefinedNameReference(
  formula: string,
  ctx: ResolverContext
): ResolvedReference | undefined {
  const resolution = findDefinedName(formula, ctx);
  if (!resolution) {
    return undefined;
  }

  // Cycle guard: A -> B -> A must terminate.
  const visitKey = storageKey(resolution.name, resolution.localSheetId);
  if (ctx.visitedDefinedNames.has(visitKey)) {
    return undefined;
  }
  // Depth guard: terminate pathological non-cyclic chains
  // (A → B → C → D → … with hundreds of links) before the JS call
  // stack blows up.
  if (ctx.definedNameDepth >= MAX_DEFINED_NAME_DEPTH) {
    return undefined;
  }
  ctx.visitedDefinedNames.add(visitKey);
  ctx.definedNameDepth += 1;

  try {
    // A defined name may expand to multiple ranges (comma-separated union).
    // We recursively resolve each part through the full reference pipeline
    // so that nested names, structured refs, and A1 refs all work.
    const aggregated: Array<{ value: unknown }> = [];
    let firstWorksheet: ChartWorksheetSnapshot | undefined;
    for (const rangeStr of resolution.ranges) {
      if (!rangeStr) {
        continue;
      }
      const inner = resolveReference(rangeStr, ctx);
      if (!inner) {
        continue;
      }
      if (!firstWorksheet) {
        firstWorksheet = inner.worksheet;
      }
      for (const cell of inner.cells) {
        aggregated.push(cell);
      }
    }
    if (!firstWorksheet) {
      return undefined;
    }
    return { worksheet: firstWorksheet, cells: aggregated };
  } finally {
    ctx.visitedDefinedNames.delete(visitKey);
    ctx.definedNameDepth -= 1;
  }
}

/**
 * Look up a defined name in the workbook, honouring sheet-scoped vs
 * workbook-scoped precedence. Returns `undefined` when the formula does not
 * look like a defined-name reference at all, or when no entry matches.
 */
function findDefinedName(
  formula: string,
  ctx: ResolverContext
): { name: string; localSheetId?: number; ranges: string[] } | undefined {
  const trimmed = formula.trim();
  if (!trimmed) {
    return undefined;
  }

  // Qualified form: Sheet!Name or 'Sheet Name'!Name
  const qualified = splitQualifiedName(trimmed);
  if (qualified) {
    // Sheet-scoped entry on the qualifying sheet wins; fall back to
    // workbook-scoped if the sheet has no matching entry.
    const qualifyingSheet = getSnapshotWorksheet(ctx.snapshot, qualified.sheetName);
    if (qualifyingSheet) {
      // Match the scoping key used in `buildResolverContext` — always
      // prefer `orderNo` (the mixed-tab workbook position, counting
      // chartsheets) over `worksheets.indexOf` (the worksheets-only
      // position). When these disagree — e.g. in a workbook ordered
      // `[WS1, ChartSheet, WS2]`, `WS2.orderNo === 2` but
      // `worksheets.indexOf(WS2) === 1` — sheet-scoped defined name
      // lookups via bare and qualified paths must agree, otherwise
      // the qualified path silently falls back to the workbook-scoped
      // entry (or misses entirely) while the bare path finds the
      // correct sheet-scoped one.
      const sheetIdx =
        typeof qualifyingSheet.orderNo === "number"
          ? qualifyingSheet.orderNo
          : ctx.snapshot.worksheets.indexOf(qualifyingSheet);
      if (sheetIdx >= 0) {
        const scoped = getDefinedNameRanges(ctx.snapshot, qualified.name, sheetIdx);
        if (scoped) {
          return { name: qualified.name, localSheetId: sheetIdx, ranges: scoped };
        }
      }
    }
    const global = getDefinedNameRanges(ctx.snapshot, qualified.name, undefined);
    if (global) {
      return { name: qualified.name, ranges: global };
    }
    return undefined;
  }

  // Bare form: must pass the name shape gate to avoid calling into the
  // defined-names API for every failed cell reference.
  if (!BARE_DEFINED_NAME_RE.test(trimmed)) {
    return undefined;
  }
  // Sheet-scoped on the context worksheet wins, then workbook-scoped.
  if (ctx.localSheetId !== undefined) {
    const scoped = getDefinedNameRanges(ctx.snapshot, trimmed, ctx.localSheetId);
    if (scoped) {
      return { name: trimmed, localSheetId: ctx.localSheetId, ranges: scoped };
    }
  }
  const global = getDefinedNameRanges(ctx.snapshot, trimmed, undefined);
  if (global) {
    return { name: trimmed, ranges: global };
  }
  return undefined;
}

/**
 * Read the ranges (or formula expression) associated with a defined name at
 * a specific scope. Returns `undefined` when no entry exists at that scope.
 */
function getDefinedNameRanges(
  snapshot: ChartDataSnapshot,
  name: string,
  localSheetId: number | undefined
): string[] | undefined {
  const entry = snapshot.definedNames.find(
    candidate =>
      candidate.name.toLowerCase() === name.toLowerCase() && candidate.localSheetId === localSheetId
  );
  return entry?.ranges.length ? [...entry.ranges] : undefined;
}

function storageKey(name: string, localSheetId: number | undefined): string {
  return localSheetId !== undefined ? `${name}\0${localSheetId}` : name;
}

/**
 * Split `Sheet!Name` or `'Quoted Sheet'!Name` into its components. Returns
 * `undefined` when the input is not of that shape or the right-hand side
 * contains range punctuation (in which case it is a cell reference, not a
 * defined-name reference).
 */
function splitQualifiedName(formula: string): { sheetName: string; name: string } | undefined {
  let i = 0;
  let sheetName = "";
  if (formula[0] === "'") {
    // Walk a quoted sheet name, treating '' as an escaped single quote.
    i = 1;
    while (i < formula.length) {
      if (formula[i] === "'" && formula[i + 1] === "'") {
        sheetName += "'";
        i += 2;
      } else if (formula[i] === "'") {
        i++;
        break;
      } else {
        sheetName += formula[i];
        i++;
      }
    }
  } else {
    // Unquoted sheet name — ends at the first '!'.
    const bang = formula.indexOf("!");
    if (bang <= 0) {
      return undefined;
    }
    sheetName = formula.slice(0, bang);
    i = bang;
  }
  if (formula[i] !== "!") {
    return undefined;
  }
  const name = formula.slice(i + 1);
  if (!BARE_DEFINED_NAME_RE.test(name)) {
    return undefined;
  }
  return { sheetName, name };
}

/**
 * Peel off an optional `Sheet1!` or `'My Sheet'!` prefix from a formula
 * without validating the shape of the remainder. Unlike
 * {@link splitQualifiedName} (which additionally checks that the RHS is a
 * bare defined name), this helper is safe to use on structured
 * references (`Table1[Col]`), absolute ranges (`$A$1:$B$2`) and anything
 * else that might follow a sheet prefix.
 *
 * Returns `undefined` when the input has no sheet prefix — callers should
 * treat that as "use the input unchanged".
 */
function splitSheetPrefix(formula: string): { sheetName: string; remainder: string } | undefined {
  let i = 0;
  let sheetName = "";
  if (formula[0] === "'") {
    i = 1;
    while (i < formula.length) {
      if (formula[i] === "'" && formula[i + 1] === "'") {
        sheetName += "'";
        i += 2;
      } else if (formula[i] === "'") {
        i++;
        break;
      } else {
        sheetName += formula[i];
        i++;
      }
    }
    if (formula[i] !== "!") {
      return undefined;
    }
  } else {
    const bang = formula.indexOf("!");
    if (bang <= 0) {
      return undefined;
    }
    sheetName = formula.slice(0, bang);
    i = bang;
  }
  if (formula[i] !== "!") {
    return undefined;
  }
  return { sheetName, remainder: formula.slice(i + 1) };
}

function resolveStructuredReference(
  formula: string,
  ctx: ResolverContext
): ResolvedReference | undefined {
  // Excel accepts both bare (`Table1[Col]`) and sheet-qualified
  // (`Sheet1!Table1[Col]`) structured references. Strip the optional sheet
  // prefix so table lookup can operate on the bare `Table1[Col]` form; we
  // also use the prefix to bias the worksheet search order so a same-named
  // table on the referenced sheet wins over an unrelated sheet that
  // happens to carry the same name.
  //
  // NOTE: `splitQualifiedName` validates the RHS against
  // `BARE_DEFINED_NAME_RE`, which rejects structured references because
  // they contain `[`. We therefore use a dedicated sheet-prefix splitter
  // that does not gate on name shape — `splitSheetPrefix` only peels off
  // the quoted / unquoted sheet name, leaving the table reference
  // syntactically intact.
  const split = splitSheetPrefix(formula.trim());
  const bareFormula = split ? split.remainder : formula.trim();
  const preferredSheetName = split?.sheetName;
  const parsed = parseStructuredReference(bareFormula);
  if (!parsed) {
    return undefined;
  }
  const worksheets = [...ctx.snapshot.worksheets];
  if (preferredSheetName) {
    // Move the preferred sheet to the front of the search (case-insensitive).
    const target = preferredSheetName.toLowerCase();
    const idx = worksheets.findIndex(ws => ws.name.toLowerCase() === target);
    if (idx > 0) {
      worksheets.unshift(...worksheets.splice(idx, 1));
    }
  }
  for (const worksheet of worksheets) {
    const table = worksheet.tables.find(
      candidate => candidate.name === parsed.tableName || candidate.displayName === parsed.tableName
    );
    if (!table) {
      continue;
    }
    const columnIndex = table.columns.findIndex(column => column === parsed.columnName);
    if (columnIndex < 0) {
      return undefined;
    }
    const tableRef = colCache.decode(table.ref);
    if (!("top" in tableRef)) {
      return undefined;
    }
    const dataStartRow = tableRef.top + (table.headerRow ? 1 : 0);
    const dataEndRow = tableRef.bottom - (table.totalsRow ? 1 : 0);
    const col = tableRef.left + columnIndex;
    const cells: Array<{ value: unknown }> = [];
    for (let row = dataStartRow; row <= dataEndRow; row++) {
      cells.push({ value: readCell(worksheet, row, col, ctx) });
    }
    return { worksheet, cells };
  }
  return undefined;
}

function parseStructuredReference(
  formula: string
): { tableName: string; columnName: string } | undefined {
  const table = readStructuredTableName(formula);
  if (!table || formula[table.end] !== "[" || !formula.endsWith("]")) {
    return undefined;
  }
  const body = formula.slice(table.end + 1, -1);
  if (body.length === 0) {
    return undefined;
  }
  const columnName = extractStructuredReferenceColumn(body);
  return columnName ? { tableName: table.name, columnName } : undefined;
}

function readStructuredTableName(formula: string): { name: string; end: number } | undefined {
  if (formula.startsWith("'")) {
    let name = "";
    for (let i = 1; i < formula.length; i++) {
      if (formula[i] === "'" && formula[i + 1] === "'") {
        name += "'";
        i++;
      } else if (formula[i] === "'") {
        return { name, end: i + 1 };
      } else {
        name += formula[i];
      }
    }
    return undefined;
  }
  const bracket = formula.indexOf("[");
  if (bracket <= 0) {
    return undefined;
  }
  return { name: formula.slice(0, bracket), end: bracket };
}

function extractStructuredReferenceColumn(body: string): string | undefined {
  if (body.startsWith("@")) {
    const inner = body.slice(1).replace(/^\[(.*)\]$/, "$1");
    const item = readStructuredReferenceItem(`${inner}]`, 0);
    return item.value;
  }
  if (!body.startsWith("[")) {
    if (body.startsWith("#")) {
      return undefined;
    }
    const item = readStructuredReferenceItem(`${body}]`, 0);
    return item.value;
  }
  const items: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "[") {
      i++;
      continue;
    }
    const item = readStructuredReferenceItem(body, i + 1);
    items.push(item.value);
    i = item.end;
  }
  return items.filter(item => item && !item.startsWith("#")).pop();
}

function readStructuredReferenceItem(value: string, start: number): { value: string; end: number } {
  let i = start;
  let result = "";
  while (i < value.length) {
    if (value[i] === "'" && i + 1 < value.length) {
      result += value[i + 1];
      i += 2;
    } else if (value[i] === "]") {
      i++;
      break;
    } else {
      result += value[i];
      i++;
    }
  }
  return { value: result.trim(), end: i };
}

function resolveReferenceMatrix(
  formula: string,
  ctx: ResolverContext
): ResolvedReferenceMatrix | undefined {
  // Expand defined-name references up front so a named multi-area range can
  // still drive a multi-level string cache.
  const named = findDefinedName(formula, ctx);
  if (named) {
    const visitKey = storageKey(named.name, named.localSheetId);
    if (ctx.visitedDefinedNames.has(visitKey)) {
      return undefined;
    }
    // Same depth guard as `resolveDefinedNameReference`; matrices route
    // through a separate code path so they need their own bail-out.
    if (ctx.definedNameDepth >= MAX_DEFINED_NAME_DEPTH) {
      return undefined;
    }
    ctx.visitedDefinedNames.add(visitKey);
    ctx.definedNameDepth += 1;
    try {
      let firstWorksheet: ChartWorksheetSnapshot | undefined;
      const mergedValues: unknown[][] = [];
      let mergedColumnCount = 0;
      for (const rangeStr of named.ranges) {
        const inner = resolveReferenceMatrix(rangeStr, ctx);
        if (!inner) {
          continue;
        }
        if (!firstWorksheet) {
          firstWorksheet = inner.worksheet;
        }
        mergedValues.push(...inner.values);
        mergedColumnCount = Math.max(mergedColumnCount, inner.columnCount);
      }
      if (!firstWorksheet) {
        return undefined;
      }
      return {
        worksheet: firstWorksheet,
        values: mergedValues,
        rowCount: mergedValues.length,
        columnCount: mergedColumnCount
      };
    } finally {
      ctx.visitedDefinedNames.delete(visitKey);
      ctx.definedNameDepth -= 1;
    }
  }

  const parts = splitFormulaRanges(formula);
  let worksheet: ChartWorksheetSnapshot | undefined;
  const rows: unknown[][] = [];
  let columnCount = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    let decoded;
    try {
      decoded = colCache.decodeEx(trimmed);
    } catch {
      return undefined;
    }
    // See `resolveReference`: treat `{ error: ... }` results from
    // `decodeEx` as unresolved rather than as empty cell sets.
    if ("error" in decoded) {
      return undefined;
    }
    const sheetName = decoded.sheetName;
    if (!sheetName) {
      return undefined;
    }
    const ws = getSnapshotWorksheet(ctx.snapshot, sheetName);
    if (!ws) {
      return undefined;
    }
    if (!worksheet) {
      worksheet = ws;
    }

    if ("top" in decoded && "left" in decoded) {
      const top = decoded.top as number;
      const left = decoded.left as number;
      const bottom = decoded.bottom as number;
      const right = decoded.right as number;
      columnCount = Math.max(columnCount, right - left + 1);
      for (let r = top; r <= bottom; r++) {
        const row: unknown[] = [];
        for (let c = left; c <= right; c++) {
          row.push(readCell(ws, r, c, ctx));
        }
        rows.push(row);
      }
    } else if ("row" in decoded && "col" in decoded) {
      columnCount = Math.max(columnCount, 1);
      rows.push([readCell(ws, decoded.row as number, decoded.col as number, ctx)]);
    }
  }

  if (!worksheet) {
    return undefined;
  }
  return { worksheet, values: rows, rowCount: rows.length, columnCount };
}

/**
 * Split a chart formula that may contain multiple ranges (union) separated
 * by commas or semicolons, respecting quoted sheet names.
 */
function splitFormulaRanges(formula: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < formula.length; i++) {
    const ch = formula[i];
    if (ch === "'") {
      // Excel escapes a single quote inside a sheet name as ''
      if (inQuote && formula[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && (ch === "," || ch === ";")) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

/**
 * Extract a raw value from a worksheet cell.
 * Avoids forcing creation of empty cells by using the row-level accessor.
 */
function readCell(
  ws: ChartWorksheetSnapshot,
  row: number,
  col: number,
  ctx: ResolverContext
): unknown {
  if (ctx.requestedCells) {
    const sheetKey = ws.name.toLowerCase();
    let cells = ctx.requestedCells.get(sheetKey);
    if (!cells) {
      cells = new Set();
      ctx.requestedCells.set(sheetKey, cells);
    }
    cells.add(chartSnapshotCellKey(row, col));
  }
  return ws.cells.get(chartSnapshotCellKey(row, col));
}

function getSnapshotWorksheet(
  snapshot: ChartDataSnapshot,
  name: string
): ChartWorksheetSnapshot | undefined {
  return snapshot.worksheetsByName.get(name.toLowerCase());
}

function toNumber(v: unknown, date1904?: boolean): number | undefined {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (v instanceof Date) {
    // Delegate to the canonical converter in `@utils/utils.base` so the
    // epoch / date1904 offset stays consistent with the rest of the
    // codebase (`cell-format`, formula engine, XML writer). A previous
    // local implementation used a `Date.UTC(1899, 11, 30)` epoch with
    // its own `serial >= 60 → +1` hack that was both off-by-one
    // (canonical epoch is Dec 31 1899) AND timezone-dependent (since
    // callers may pass local-time `Date`s whose UTC projection differs).
    return dateToExcel(v, date1904);
  }
  if (typeof v === "string") {
    // Try to coerce numeric string
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== "") {
      return n;
    }
  }
  return undefined;
}

function toString(v: unknown): string | undefined {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (v instanceof Date) {
    // Date-cells feeding a chart's category axis (via a `strRef` — e.g.
    // `=Sheet1!$A$1:$A$10` where A1:A10 are dates) should surface as
    // human-readable labels, not ISO 8601 timestamps. `toISOString()`
    // produced output like `"2023-01-15T00:00:00.000Z"` which rendered
    // verbatim on axis labels and diverged from Excel's cache (Excel
    // stores the formatted display text per the referenced cell's
    // numFmt).
    //
    // We don't have access to the source cell's numFmt from this
    // fallback path, but a locale-neutral `YYYY-MM-DD` (or
    // `YYYY-MM-DD HH:mm:ss` when the time portion is non-zero) is a
    // reasonable approximation that renders well in every preview and
    // matches Excel's default date format more closely than ISO.
    if (Number.isNaN(v.getTime())) {
      return undefined;
    }
    const year = v.getUTCFullYear().toString().padStart(4, "0");
    const month = (v.getUTCMonth() + 1).toString().padStart(2, "0");
    const day = v.getUTCDate().toString().padStart(2, "0");
    const hour = v.getUTCHours();
    const min = v.getUTCMinutes();
    const sec = v.getUTCSeconds();
    if (hour === 0 && min === 0 && sec === 0) {
      return `${year}-${month}-${day}`;
    }
    const hh = hour.toString().padStart(2, "0");
    const mm = min.toString().padStart(2, "0");
    const ss = sec.toString().padStart(2, "0");
    return `${year}-${month}-${day} ${hh}:${mm}:${ss}`;
  }
  return undefined;
}
