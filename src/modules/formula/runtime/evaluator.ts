/**
 * Evaluator — Execute BoundExpr using the RuntimeValue system.
 *
 * The evaluator operates on BoundExpr (from the compile phase),
 * WorkbookSnapshot (from the snapshot phase), and RuntimeValue
 * (the value system).
 */

import { parseDefinedNameRange } from "@formula/compile/address-utils";
import type { BindingContext } from "@formula/compile/binder";
import { bind } from "@formula/compile/binder";
import type {
  BoundExpr,
  BoundCellRef,
  BoundAreaRef,
  BoundCall,
  BoundSpecialCall,
  BoundNameExpr,
  BoundLambda
} from "@formula/compile/bound-ast";
import { BoundExprKind } from "@formula/compile/bound-ast";
import type { CompiledFormula } from "@formula/compile/compiled-formula";
import {
  resolveStructuredRefRows,
  buildTableGeometry,
  resolveStructuredRefColumns
} from "@formula/compile/structured-ref-utils";
import { FormulaError } from "@formula/errors";
import type { WorkbookSnapshot } from "@formula/integration/workbook-snapshot";
import {
  snapshotCellKey,
  formulaCellKey,
  resolveDefinedName as resolveDefinedNameFromSnapshot
} from "@formula/integration/workbook-snapshot";
import { isSpillAvailable } from "@formula/materialize/spill-availability";
import type { FunctionRuntimeContext } from "@formula/runtime/function-context";
import { lookupFunction } from "@formula/runtime/function-registry";
import type { FunctionDescriptor } from "@formula/runtime/function-registry";
import type {
  RuntimeValue,
  ScalarValue,
  ArrayValue,
  LambdaValue,
  ErrorValue,
  RefArea
} from "@formula/runtime/values";
import {
  RVKind,
  BLANK,
  ERRORS,
  rvNumber,
  rvString,
  rvBoolean,
  rvError,
  rvArray,
  rvArrayRect,
  rvRef,
  rvCellRef,
  rvLambda,
  isError,
  isScalar,
  isLambda,
  toNumberRV,
  toStringRV,
  toBooleanRV,
  topLeft,
  scalarEquals,
  compareScalarsSameKind,
  fromSnapshotValue
} from "@formula/runtime/values";
import { parse } from "@formula/syntax/parser";
import { stripFunctionPrefix } from "@formula/syntax/token-types";
import { tokenize } from "@formula/syntax/tokenizer";

// ============================================================================
// Eval Session
// ============================================================================

/**
 * Cached formula evaluation result with both scalar and raw forms.
 * The scalar form is used by dependent formulas (implicit intersection applied).
 * The raw form preserves the full array for dynamic array / CSE materialization.
 */
interface CachedResult {
  /** Scalar (implicit-intersected, dereferenced) result. */
  readonly scalar: RuntimeValue;
  /** Raw (full array) result. Only differs from scalar for array formulas. */
  readonly raw: RuntimeValue;
}

/**
 * Per-calculation mutable state.
 */
export class EvalSession {
  /** Cells currently on the evaluation call stack (circular-ref detection). */
  readonly evaluating = new Set<string>();
  /**
   * Unified formula result cache.
   * Each entry holds both the scalar form (for dependents) and the raw form
   * (for materialize). This replaces the previous separate cache/rawCache
   * pattern with a single, self-documenting structure.
   */
  readonly resultCache = new Map<string, CachedResult>();
  /** Cache for runtime name resolution (defined names that need parsing). */
  readonly nameCache = new Map<string, RuntimeValue>();
  /** Fallback values for circular references during iterative calculation. */
  readonly circularFallback = new Map<string, RuntimeValue>();
  /** Full previous-iteration results used when reading circular spill elements. */
  readonly circularRawFallback = new Map<string, RuntimeValue>();

  /**
   * Live spill map: cell key → (masterKey, row-offset, col-offset).
   *
   * Populated as soon as a dynamic-array formula is evaluated and yields
   * an array result. Downstream formulas that read a cell inside the
   * spill region look the master's cached array up via this map and
   * return the correct element — even before materialize has written
   * the ghost cells to the snapshot.
   *
   * This is the fix for "first-pass `=SUM(A1:A5)` over a `=SEQUENCE(5)`
   * spill" — without the live map, `getCellValue("S", 2, 1)` returned
   * BLANK and SUM only counted the master cell.
   */
  readonly liveSpills = new Map<
    string,
    { masterKey: string; rowOffset: number; colOffset: number }
  >();
  /** Previous unmodified ghost cells, keyed like formula cells. */
  readonly staleGhosts = new Set<string>();

  /**
   * Runtime dependency recorder — tracks cell accesses made during evaluation.
   *
   * When a formula with `hasDynamicRefs` (INDIRECT/OFFSET) is being evaluated,
   * every `getCellValue` / `buildRangeArray` call records the accessed cell/range
   * key here. After evaluation, these dynamic edges can be merged with the
   * compiled static dependency set to produce a complete dependency graph.
   *
   * Key: formula cell key being evaluated → Set of accessed cell keys.
   * Only populated for formulas that have `hasDynamicRefs === true`.
   */
  readonly dynamicDeps = new Map<string, Set<string>>();

  /**
   * The formula cell key currently being recorded (null if recording is off).
   * Set before evaluating a formula with dynamic refs, cleared after.
   */
  recordingKey: string | null = null;

  /**
   * Current LAMBDA invocation depth. Guards against unbounded recursion
   * (e.g. `LAMBDA(x, x(x))(LAMBDA(x, x(x)))`) that would otherwise overflow
   * the JS call stack. Excel documents a recursion limit of ~256.
   */
  lambdaDepth = 0;

  /**
   * AST cache for INDIRECT re-parsing. INDIRECT receives a runtime string
   * describing a reference; re-parsing it per invocation would be wasted
   * work, so we memoise the `bound` expression keyed on the reference
   * text. This belongs to the session (per-calculation lifetime) rather
   * than the snapshot because the bindings depend on the evaluation
   * context.
   */
  readonly indirectAstCache = new Map<string, BoundExpr>();

  makeKey(sheet: string, row: number, col: number): string {
    return formulaCellKey(sheet, row, col);
  }

  /**
   * Record a cell access for the currently-recording formula.
   */
  recordAccess(sheet: string, row: number, col: number): void {
    if (this.recordingKey === null) {
      return;
    }
    let deps = this.dynamicDeps.get(this.recordingKey);
    if (!deps) {
      deps = new Set();
      this.dynamicDeps.set(this.recordingKey, deps);
    }
    deps.add(formulaCellKey(sheet, row, col));
  }
}

// ============================================================================
// Eval Context
// ============================================================================

/**
 * The evaluation context. Carries the snapshot and compiled formula map
 * for the evaluator to access cell values and resolve names at runtime.
 * Short-lived per-calculation state (caches, iteration flags, etc.) lives
 * on `EvalSession` instead.
 */
export interface EvalContext {
  /** The workbook snapshot. */
  readonly snapshot: WorkbookSnapshot;
  /** Map from formula cell key to CompiledFormula. */
  readonly compiledFormulas: ReadonlyMap<string, CompiledFormula>;
  /** The current sheet name (for relative references). */
  currentSheet: string;
  /** Current cell address being evaluated. */
  currentAddress?: { sheet: string; row: number; col: number };
  /** Local variable bindings from LET expressions. */
  localBindings?: Map<string, RuntimeValue>;
  /**
   * User-registered functions that take precedence over the built-in
   * registry. Lookup happens in `evaluateCall` — a matching
   * descriptor here shadows any built-in of the same name. Keys are
   * canonical uppercase names (prefix-stripped on register).
   */
  readonly userFunctions?: ReadonlyMap<string, FunctionDescriptor>;
  /** Workbook date system passed explicitly to native functions. */
  readonly date1904: boolean;
  /**
   * Pre-built native-function context for this calculation. Reused across every
   * `invoke` call so hot paths do not allocate one object per function call.
   */
  readonly functionContext: FunctionRuntimeContext;
}

// ============================================================================
// Main Evaluate Function
// ============================================================================

/**
 * Exhaustiveness helper — TypeScript narrows `never` here to prove that
 * every discriminated-union variant was handled. At runtime this should be
 * unreachable; if a new variant is added without a case, compilation fails.
 */
function assertNever(x: never): never {
  throw new FormulaError(`unexpected variant: ${JSON.stringify(x)}`);
}

/**
 * Evaluate a BoundExpr to produce a RuntimeValue.
 */
export function evaluate(expr: BoundExpr, ctx: EvalContext, session: EvalSession): RuntimeValue {
  switch (expr.kind) {
    case BoundExprKind.Literal:
      return evaluateLiteral(expr);

    case BoundExprKind.CellRef:
      // Inlined: the wrapper function did nothing beyond forwarding.
      // Cell refs are the hottest AST node in the evaluator; saving one
      // call frame per reference meaningfully shortens the trace for
      // workbooks with tens of thousands of cells.
      return rvCellRef(expr.sheet, expr.row, expr.col);

    case BoundExprKind.AreaRef:
      return rvRef(expr.sheet, expr.top, expr.left, expr.bottom, expr.right);

    case BoundExprKind.ColRangeRef:
      return evaluateColRange(expr, ctx, session);

    case BoundExprKind.RowRangeRef:
      return evaluateRowRange(expr, ctx, session);

    case BoundExprKind.Ref3D:
      return evaluateRef3D(expr, ctx, session);

    case BoundExprKind.BinaryOp:
      return evaluateBinaryOp(expr.op, expr.left, expr.right, ctx, session);

    case BoundExprKind.UnaryOp:
      return evaluateUnaryOp(expr.op, expr.operand, ctx, session);

    case BoundExprKind.Percent:
      return evaluatePercent(expr.operand, ctx, session);

    case BoundExprKind.Call:
      return evaluateCall(expr, ctx, session);

    case BoundExprKind.SpecialCall:
      return evaluateSpecialCall(expr, ctx, session);

    case BoundExprKind.Array:
      return evaluateArrayLiteral(expr, ctx, session);

    case BoundExprKind.NameExpr:
      return evaluateNameExpr(expr, ctx, session);

    case BoundExprKind.Lambda:
      return evaluateLambdaExpr(expr, ctx);

    case BoundExprKind.StructuredRef:
      return evaluateStructuredRef(expr, ctx, session);

    case BoundExprKind.UnionRef:
      return evaluateUnionRef(expr, ctx, session);

    default:
      return assertNever(expr);
  }
}

// ============================================================================
// Literal
// ============================================================================

function evaluateLiteral(expr: {
  value: number | string | boolean | null;
  errorCode?: string;
}): ScalarValue {
  if (expr.errorCode) {
    return rvError(expr.errorCode as ErrorValue["code"]);
  }
  if (expr.value === null) {
    return BLANK;
  }
  if (typeof expr.value === "number") {
    return rvNumber(expr.value);
  }
  if (typeof expr.value === "string") {
    return rvString(expr.value);
  }
  if (typeof expr.value === "boolean") {
    return rvBoolean(expr.value);
  }
  return BLANK;
}

// ============================================================================
// Cell Reference
// ============================================================================

// ============================================================================
// Cell / Area Reference — inlined at the `evaluate` switch above.
// ============================================================================
// Single-arg wrappers used to exist here (`evaluateCellRef` / `evaluateAreaRef`);
// they did nothing beyond forwarding to `rvCellRef` / `rvRef`. Since the
// evaluator dispatches these on every cell in every formula, we inline
// them at the caller to shave one call frame.

function evaluateColRange(
  expr: { sheet: string; leftCol: number; rightCol: number },
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const ws = ctx.snapshot.worksheetsByName.get(expr.sheet.toLowerCase());
  if (!ws || !ws.dimensions) {
    return rvArray([]);
  }
  return rvRef(expr.sheet, ws.dimensions.top, expr.leftCol, ws.dimensions.bottom, expr.rightCol);
}

function evaluateRowRange(
  expr: { sheet: string; topRow: number; bottomRow: number },
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const ws = ctx.snapshot.worksheetsByName.get(expr.sheet.toLowerCase());
  if (!ws || !ws.dimensions) {
    return rvArray([]);
  }
  return rvRef(expr.sheet, expr.topRow, ws.dimensions.left, expr.bottomRow, ws.dimensions.right);
}

function evaluateRef3D(
  expr: { sheets: readonly string[]; inner: BoundCellRef | BoundAreaRef },
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const areas: RefArea[] = [];
  for (const sheet of expr.sheets) {
    if (expr.inner.kind === BoundExprKind.CellRef) {
      areas.push({
        sheet,
        top: expr.inner.row,
        left: expr.inner.col,
        bottom: expr.inner.row,
        right: expr.inner.col
      });
    } else {
      // For AreaRef: if the inner range is a whole-column or whole-row
      // reference (top = 1 & bottom = 1048576, or left = 1 & right =
      // 16384), clamp it against each sheet's actual used dimensions.
      // Without this clamp, a 3D reference like `Sheet1:Sheet3!A:A`
      // would allocate 3 × 1M rows of BLANK values and spend seconds
      // (or OOM) before SUM even starts. The non-3D path already does
      // this clamp in `evaluateColRange`; parity with that is what we
      // want here.
      let top = expr.inner.top;
      let left = expr.inner.left;
      let bottom = expr.inner.bottom;
      let right = expr.inner.right;
      const isWholeCol = top === 1 && bottom === 1_048_576;
      const isWholeRow = left === 1 && right === 16_384;
      if (isWholeCol || isWholeRow) {
        const ws = ctx.snapshot.worksheetsByName.get(sheet.toLowerCase());
        const dims = ws?.dimensions;
        if (dims) {
          if (isWholeCol) {
            top = dims.top;
            bottom = dims.bottom;
          }
          if (isWholeRow) {
            left = dims.left;
            right = dims.right;
          }
        }
      }
      areas.push({ sheet, top, left, bottom, right });
    }
  }
  return { kind: RVKind.Reference, areas };
}

// ============================================================================
// Build Range Array from Snapshot
// ============================================================================

function buildRangeArray(
  ctx: EvalContext,
  session: EvalSession,
  sheet: string,
  top: number,
  left: number,
  bottom: number,
  right: number
): ArrayValue {
  // Hoist the worksheet lookup once for the entire range — avoids
  // N redundant toLowerCase()/Map.get() calls inside the hot loop.
  const ws = ctx.snapshot.worksheetsByName.get(sheet.toLowerCase());
  const cells = ws?.cells;
  const wsHiddenRows = ws?.hiddenRows;
  // Use the canonical sheet name for cache-key computation so that a
  // mis-cased sheet identifier (e.g. `sheet1` when the workbook has
  // `Sheet1`) doesn't bypass the compiled-formula / result caches. The
  // map is keyed by snapshot.worksheets[].name, so any divergence would
  // cause spurious re-compilation.
  const canonicalSheet = ws?.name ?? sheet;
  const compiledFormulas = ctx.compiledFormulas;
  const resultCache = session.resultCache;
  // Hoist the recording guard — when not recording, skip recordAccess
  // entirely in the loop instead of paying the function-call overhead.
  const recording = session.recordingKey !== null;

  const height = bottom - top + 1;
  const width = right - left + 1;

  // Missing worksheet: emit an all-BLANK rectangle without entering the
  // hot path. The tokenizer and binder usually report these as #REF! at
  // compile time, but `evaluateRef3D` and runtime INDIRECT can still
  // synthesise refs into non-existent sheets.
  if (!cells) {
    const rows: ScalarValue[][] = new Array<ScalarValue[]>(height);
    for (let r = 0; r < height; r++) {
      rows[r] = new Array<ScalarValue>(width).fill(BLANK);
    }
    if (recording) {
      for (let r = top; r <= bottom; r++) {
        for (let c = left; c <= right; c++) {
          session.recordAccess(sheet, r, c);
        }
      }
    }
    return rvArrayRect(rows, height, width, top, left);
  }

  const rows: ScalarValue[][] = new Array<ScalarValue[]>(height);
  // Lazily-allocated masks: only materialized once we encounter a
  // SUBTOTAL/AGGREGATE cell or a hidden row inside the range. For the
  // common case (plain data range, no hidden rows) we never touch these
  // and emit an ArrayValue without extra metadata.
  let subtotalMask: boolean[][] | undefined;
  let hiddenRowMask: boolean[] | undefined;
  for (let r = top; r <= bottom; r++) {
    const ri = r - top;
    const row = new Array<ScalarValue>(width);
    // Record row visibility — SUBTOTAL 1xx / AGGREGATE opt 5/7 use it.
    if (wsHiddenRows?.has(r)) {
      if (!hiddenRowMask) {
        hiddenRowMask = new Array<boolean>(height).fill(false);
      }
      hiddenRowMask[ri] = true;
    }
    for (let c = left; c <= right; c++) {
      const ci = c - left;
      if (recording) {
        session.recordAccess(canonicalSheet, r, c);
      }

      const cell = cells.get(snapshotCellKey(r, c));
      if (!cell) {
        // No snapshot cell yet — might still be inside a live spill
        // (e.g. reading A2..A5 while A1 = SEQUENCE(5) is still being
        // materialized). See `readLiveSpill` for the lookup path.
        const live = readLiveSpill(canonicalSheet, r, c, session);
        row[ci] = live ? topLeft(live) : BLANK;
        continue;
      }

      if (cell.formulaKind !== "none" && cell.formula) {
        const fKey = formulaCellKey(canonicalSheet, r, c);
        const compiled = compiledFormulas.get(fKey);
        // Mark SUBTOTAL/AGGREGATE output cells so an outer SUBTOTAL /
        // AGGREGATE over this range knows to skip them (Excel's
        // no-double-count semantics).
        if (compiled?.isSubtotalOutput) {
          if (!subtotalMask) {
            subtotalMask = new Array<boolean[]>(height);
            for (let i = 0; i < height; i++) {
              subtotalMask[i] = new Array<boolean>(width).fill(false);
            }
          }
          subtotalMask[ri][ci] = true;
        }
        const cached = resultCache.get(fKey);
        if (cached !== undefined) {
          row[ci] = topLeft(cached.scalar);
          continue;
        }
        if (compiled) {
          row[ci] = topLeft(evaluateFormula(compiled, ctx, session));
          continue;
        }
      }

      // Non-formula snapshot cell — but it might still be a ghost slot
      // that a fresh dynamic-array spill is about to overwrite. Prefer
      // the live value when a master is registered so this-pass SUM /
      // LOOKUP / etc. see the new spill immediately.
      const live = readLiveSpill(canonicalSheet, r, c, session);
      if (live) {
        row[ci] = topLeft(live);
        continue;
      }
      if (session.staleGhosts.has(formulaCellKey(canonicalSheet, r, c))) {
        row[ci] = BLANK;
        continue;
      }
      row[ci] = topLeft(fromSnapshotValue(cell.value));
    }
    rows[ri] = row;
  }
  return rvArrayRect(rows, height, width, top, left, subtotalMask, hiddenRowMask);
}

// ============================================================================
// Dereference: Reference → concrete value
// ============================================================================

/**
 * Resolve a `ReferenceValue` to its concrete value (scalar or array).
 * - Single-cell references (from CellRef nodes) resolve to a scalar.
 * - Area references (even 1x1 from A1:A1) produce an array.
 * - Multi-area references (from 3D refs) flatten all areas into one array.
 * Non-reference values are returned unchanged.
 */
function dereferenceValue(v: RuntimeValue, ctx: EvalContext, session: EvalSession): RuntimeValue {
  if (v.kind !== RVKind.Reference) {
    return v;
  }
  if (v.areas.length === 0) {
    return BLANK;
  }
  // Single-cell references (from CellRef nodes) resolve to scalar
  if (v.singleCell) {
    const area = v.areas[0];
    return getCellValue(area.sheet, area.top, area.left, ctx, session);
  }
  // Single area — build range array
  if (v.areas.length === 1) {
    const area = v.areas[0];
    return buildRangeArray(ctx, session, area.sheet, area.top, area.left, area.bottom, area.right);
  }
  // Multi-area (3D reference) — flatten all areas into one array
  const allRows: ScalarValue[][] = [];
  let mergedSubtotal: boolean[][] | undefined;
  let mergedHidden: boolean[] | undefined;
  for (const area of v.areas) {
    const arr = buildRangeArray(
      ctx,
      session,
      area.sheet,
      area.top,
      area.left,
      area.bottom,
      area.right
    );
    const startRow = allRows.length;
    for (const row of arr.rows) {
      allRows.push([...row]);
    }
    // Merge masks from this area into the flattened output. Only
    // allocate the merged masks when the first masked area shows up —
    // most multi-area refs have no masks and should pay no overhead.
    if (arr.subtotalMask || arr.hiddenRowMask) {
      const height = arr.height;
      if (arr.subtotalMask) {
        if (!mergedSubtotal) {
          mergedSubtotal = [];
          for (let i = 0; i < startRow; i++) {
            // Widths may differ across areas; mask rows use each area's
            // own width so an outer SUBTOTAL reads the right positions.
            mergedSubtotal.push([]);
          }
        }
        for (let r = 0; r < height; r++) {
          mergedSubtotal.push([...arr.subtotalMask[r]]);
        }
      } else if (mergedSubtotal) {
        // Pad with empty rows so indices stay aligned.
        for (let r = 0; r < height; r++) {
          mergedSubtotal.push([]);
        }
      }
      if (arr.hiddenRowMask) {
        if (!mergedHidden) {
          mergedHidden = new Array<boolean>(startRow).fill(false);
        }
        for (let r = 0; r < height; r++) {
          mergedHidden.push(arr.hiddenRowMask[r] ?? false);
        }
      } else if (mergedHidden) {
        for (let r = 0; r < height; r++) {
          mergedHidden.push(false);
        }
      }
    } else if (mergedSubtotal || mergedHidden) {
      // An earlier area had masks; pad this area's rows with non-masked
      // entries to keep row indices aligned.
      const height = arr.height;
      if (mergedSubtotal) {
        for (let r = 0; r < height; r++) {
          mergedSubtotal.push([]);
        }
      }
      if (mergedHidden) {
        for (let r = 0; r < height; r++) {
          mergedHidden.push(false);
        }
      }
    }
  }
  return rvArray(allRows, undefined, undefined, mergedSubtotal, mergedHidden);
}

// ============================================================================
// Get Cell Value from Snapshot
// ============================================================================

function getCellValue(
  sheetName: string,
  row: number,
  col: number,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const ws = ctx.snapshot.worksheetsByName.get(sheetName.toLowerCase());
  if (!ws) {
    // Record the access before returning — still a valid dependency
    // edge even if the sheet is missing (it'll surface as BLANK
    // downstream, but an INDIRECT-produced read should still register).
    if (session.recordingKey !== null) {
      session.recordAccess(sheetName, row, col);
    }
    return BLANK;
  }
  // Normalise to the canonical sheet name so downstream cache keys
  // (compiled formulas, result cache, spill map) all hit the same
  // entries regardless of how the caller cased the input.
  const canonicalSheet = ws.name;
  // Record this access for runtime dependency tracking. Inline guard
  // avoids the function call overhead in the common case where no
  // recording is active (formulas without dynamic refs).
  if (session.recordingKey !== null) {
    session.recordAccess(canonicalSheet, row, col);
  }

  const cellKey = snapshotCellKey(row, col);
  const cell = ws.cells.get(cellKey);
  if (!cell) {
    // The cell isn't in the snapshot, but we might still have a live
    // spill value for it — look up the master formula and extract the
    // right array element. Matters when a downstream formula like
    // `SUM(A1:A5)` runs before materialize writes the ghost cells for
    // `A1 = SEQUENCE(5)` into the snapshot.
    return readLiveSpill(canonicalSheet, row, col, session) ?? BLANK;
  }

  // If this cell has a formula, evaluate it
  if (cell.formulaKind !== "none" && cell.formula) {
    // Use `ws.name` (the snapshot's canonical case) rather than the
    // caller's `sheetName`, which could arrive mis-cased (e.g. the
    // user wrote `sheet1!A1` but the workbook has `Sheet1`). The
    // compiled-formula map is keyed by the canonical form, so a
    // mis-cased key would produce a spurious cache-miss + re-compile
    // per read — and worse, a different key than the one the
    // write-back cycle will later upsert.
    const fKey = formulaCellKey(canonicalSheet, row, col);

    // Check cache — return scalar form for dependency resolution
    const cached = session.resultCache.get(fKey);
    if (cached !== undefined) {
      return cached.scalar;
    }

    // Get compiled formula
    const compiled = ctx.compiledFormulas.get(fKey);
    if (compiled) {
      return evaluateFormula(compiled, ctx, session);
    }
  }

  // Non-formula cell — but it might also be a ghost for a live spill
  // (e.g. a value that exists in the snapshot from a previous calc
  // cycle but is about to be overwritten by a fresh spill). Prefer the
  // live value when a master is registered.
  const spill = readLiveSpill(canonicalSheet, row, col, session);
  if (spill) {
    return spill;
  }
  if (session.staleGhosts.has(formulaCellKey(canonicalSheet, row, col))) {
    return BLANK;
  }
  return fromSnapshotValue(cell.value);
}

/**
 * Retrieve the spill-target value at (sheetName, row, col) from an
 * already-evaluated dynamic-array master. Returns `undefined` when no
 * master is registered for that cell — callers fall back to the
 * snapshot value or BLANK.
 */
function readLiveSpill(
  sheetName: string,
  row: number,
  col: number,
  session: EvalSession
): RuntimeValue | undefined {
  const key = session.makeKey(sheetName, row, col);
  const spill = session.liveSpills.get(key);
  if (!spill) {
    return undefined;
  }
  const current = session.resultCache.get(spill.masterKey)?.raw;
  const raw = current ?? session.circularRawFallback.get(spill.masterKey);
  if (!raw || raw.kind !== RVKind.Array) {
    return undefined;
  }
  const arr = raw;
  if (spill.rowOffset >= arr.height || spill.colOffset >= arr.width) {
    return undefined;
  }
  return arr.rows[spill.rowOffset][spill.colOffset];
}

// ============================================================================
// Evaluate a Compiled Formula
// ============================================================================

/**
 * Shared implementation for evaluateFormula and evaluateFormulaRaw.
 *
 * Handles key computation, cache lookup, circular reference detection,
 * expression evaluation, and result caching.
 */
function evaluateFormulaInner(
  compiled: CompiledFormula,
  ctx: EvalContext,
  session: EvalSession
): CachedResult {
  const inst = compiled.instance;
  const key = session.makeKey(inst.sheetName, inst.row, inst.col);

  // Check cache
  const cached = session.resultCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // Circular reference detection. Under iterative calculation the driver
  // (calculate-formulas-impl.ts) seeds `circularFallback` with the previous
  // iteration's result so the re-entrant lookup receives a stable value.
  // Outside of iterative mode the map is empty — we return 0 as the fallback,
  // matching Excel's "iterate with 0 seed" convention. This keeps simple
  // cycles like A1=A1+1 producing a number instead of an error, which is the
  // established behaviour for this engine (tests depend on this). For strict
  // circular-reference error reporting, enable iterative calculation and
  // observe convergence failure, or configure a custom fallback value.
  if (session.evaluating.has(key)) {
    const fallback = session.circularFallback.get(key);
    const val = fallback !== undefined ? fallback : rvNumber(0);
    return { scalar: val, raw: val };
  }

  session.evaluating.add(key);
  const prevAddress = ctx.currentAddress;
  const prevSheet = ctx.currentSheet;
  const prevRecording = session.recordingKey;
  ctx.currentAddress = { sheet: inst.sheetName, row: inst.row, col: inst.col };
  ctx.currentSheet = inst.sheetName;
  // Enable runtime dependency recording for formulas with dynamic refs
  if (compiled.hasDynamicRefs) {
    session.recordingKey = key;
    session.dynamicDeps.set(key, new Set());
  }

  try {
    const result = evaluate(compiled.bound, ctx, session);
    const intersected = implicitIntersect(result, ctx);
    const scalar = dereferenceValue(intersected, ctx, session);
    const raw = dereferenceValue(result, ctx, session);
    const isDyn = compiled.instance.isDynamicArray || compiled.isDynamicArrayFunction;
    removeLiveSpillMappings(key, session);
    const spillBlocked =
      isDyn &&
      raw.kind === RVKind.Array &&
      (raw.height > 1 || raw.width > 1) &&
      !canExposeLiveSpill(compiled, raw, ctx, session);
    const entry: CachedResult = spillBlocked
      ? { scalar: ERRORS.SPILL, raw: ERRORS.SPILL }
      : { scalar, raw };
    session.resultCache.set(key, entry);
    // Register the spill region if this is a dynamic-array formula
    // whose result is a multi-cell array. Downstream formulas that
    // read into the spill range (e.g. `=SUM(A1:A5)` over a
    // `=SEQUENCE(5)` master) can now pick up the ghost-cell values
    // before materialize writes them back to the snapshot.
    if (!spillBlocked && isDyn && raw.kind === RVKind.Array && (raw.height > 1 || raw.width > 1)) {
      for (let r = 0; r < raw.height; r++) {
        for (let c = 0; c < raw.width; c++) {
          if (r === 0 && c === 0) {
            continue; // master cell already points to its own cache entry
          }
          const targetKey = session.makeKey(inst.sheetName, inst.row + r, inst.col + c);
          session.liveSpills.set(targetKey, {
            masterKey: key,
            rowOffset: r,
            colOffset: c
          });
        }
      }
    }
    return entry;
  } catch (err) {
    // Cache a #CALC! sentinel so a re-entrant lookup for the same cell does
    // not trigger repeated (exponentially growing) re-evaluation under
    // iterative calc or dependent recomputation. The exception is re-thrown
    // so the outer caller can still log / translate it into a sheet error.
    const fallback: CachedResult = { scalar: ERRORS.CALC, raw: ERRORS.CALC };
    session.resultCache.set(key, fallback);
    throw err;
  } finally {
    session.evaluating.delete(key);
    ctx.currentAddress = prevAddress;
    ctx.currentSheet = prevSheet;
    session.recordingKey = prevRecording;
  }
}

function canExposeLiveSpill(
  compiled: CompiledFormula,
  raw: ArrayValue,
  ctx: EvalContext,
  session: EvalSession
): boolean {
  const inst = compiled.instance;
  return isSpillAvailable({
    snapshot: ctx.snapshot,
    sheetName: inst.sheetName,
    sourceRow: inst.row,
    sourceCol: inst.col,
    rows: raw.height,
    cols: raw.width,
    isReusableGhost: (row, col) =>
      session.staleGhosts.has(formulaCellKey(inst.sheetName, row, col)),
    isClaimed: (row, col) => session.liveSpills.has(formulaCellKey(inst.sheetName, row, col))
  });
}

function removeLiveSpillMappings(masterKey: string, session: EvalSession): void {
  for (const [key, spill] of session.liveSpills) {
    if (spill.masterKey === masterKey) {
      session.liveSpills.delete(key);
    }
  }
}

/**
 * Evaluate a compiled formula and return its **scalar** result.
 *
 * This is the standard evaluation path for regular (non-array) formulas.
 * The result is:
 * 1. Evaluated from the bound expression tree
 * 2. Implicit-intersected to a single value/reference
 * 3. Dereferenced if it's a reference
 * 4. Cached for subsequent lookups by dependent formulas
 *
 * Use `evaluateFormulaRaw` instead when the full array result is needed
 * (dynamic array formulas, CSE formulas).
 */
export function evaluateFormula(
  compiled: CompiledFormula,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  return evaluateFormulaInner(compiled, ctx, session).scalar;
}

/**
 * Evaluate a compiled formula and return the **raw** (possibly array) result.
 *
 * This is the evaluation path for dynamic array and CSE formulas where
 * the full array shape must be preserved for spill/distribution.
 *
 * Semantics:
 * - Both scalar and raw forms are stored in `session.resultCache` as a
 *   `CachedResult{scalar, raw}`. Dependent scalar formulas see the scalar
 *   form; the materialize layer retrieves the raw form.
 * - The return value is the full dereferenced result — may be an ArrayValue
 *   with height > 1 or width > 1.
 */
export function evaluateFormulaRaw(
  compiled: CompiledFormula,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  return evaluateFormulaInner(compiled, ctx, session).raw;
}

// ============================================================================
// Binary Operations
// ============================================================================

function evaluateBinaryOp(
  op: string,
  leftExpr: BoundExpr,
  rightExpr: BoundExpr,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  // Intersection operator (whitespace between two refs). Must be handled
  // BEFORE dereferencing so we can inspect the reference areas.
  if (op === " ") {
    return evaluateIntersection(leftExpr, rightExpr, ctx, session);
  }

  // Range operator `:` — union of two references into the bounding
  // rectangle. Needed when one side is a function call (e.g.
  // `B11:INDIRECT("B" & ROW()-1)`). Both sides must be references or
  // coerce to references; otherwise Excel returns #REF!.
  if (op === ":") {
    return evaluateRangeUnion(leftExpr, rightExpr, ctx, session);
  }

  const left = dereferenceValue(evaluate(leftExpr, ctx, session), ctx, session);
  const right = dereferenceValue(evaluate(rightExpr, ctx, session), ctx, session);

  const lIsArr = left.kind === RVKind.Array;
  const rIsArr = right.kind === RVKind.Array;

  if (lIsArr || rIsArr) {
    return broadcastBinaryOp(op, left, right);
  }

  return applyScalarBinaryOp(op, topLeft(left), topLeft(right));
}

/**
 * Excel's intersection operator — a whitespace character separating two
 * references (e.g. `A1:A10 B1:B10`).
 *
 * Semantics:
 * - Both operands must evaluate to single-area references. Otherwise the
 *   result is `#VALUE!` (matches Excel's behaviour when non-refs or
 *   multi-area refs are intersected).
 * - Intersection is the rectangle overlap of the two areas on the same
 *   sheet.
 * - If the areas do not overlap (or are on different sheets) the result
 *   is `#NULL!`, Excel's canonical "empty intersection" error.
 */
function evaluateIntersection(
  leftExpr: BoundExpr,
  rightExpr: BoundExpr,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const left = evaluate(leftExpr, ctx, session);
  const right = evaluate(rightExpr, ctx, session);

  if (isError(left)) {
    return left;
  }
  if (isError(right)) {
    return right;
  }
  if (left.kind !== RVKind.Reference || right.kind !== RVKind.Reference) {
    return ERRORS.VALUE;
  }
  if (left.areas.length !== 1 || right.areas.length !== 1) {
    return ERRORS.VALUE;
  }

  const la = left.areas[0];
  const ra = right.areas[0];

  if (la.sheet.toLowerCase() !== ra.sheet.toLowerCase()) {
    return ERRORS.NULL;
  }

  const top = Math.max(la.top, ra.top);
  const left_ = Math.max(la.left, ra.left);
  const bottom = Math.min(la.bottom, ra.bottom);
  const right_ = Math.min(la.right, ra.right);

  if (top > bottom || left_ > right_) {
    return ERRORS.NULL;
  }

  return rvRef(la.sheet, top, left_, bottom, right_);
}

/**
 * Range operator `:` applied at runtime. Normally `A1:B2` is merged by
 * the tokenizer, but patterns like `A1:INDIRECT("B5")` leave the colon
 * as a standalone operator. Both operands must evaluate to references
 * (single-cell or area); the result is the bounding rectangle of the
 * two reference ranges on the same sheet.
 *
 * Semantics:
 *   - Both sides must be references. Literal numbers / strings → #VALUE!.
 *   - References must live on the same sheet → else #REF!.
 *   - Multi-area references on either side → #REF! (Excel behavior).
 */
function evaluateRangeUnion(
  leftExpr: BoundExpr,
  rightExpr: BoundExpr,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const left = evaluate(leftExpr, ctx, session);
  const right = evaluate(rightExpr, ctx, session);

  if (isError(left)) {
    return left;
  }
  if (isError(right)) {
    return right;
  }
  if (left.kind !== RVKind.Reference || right.kind !== RVKind.Reference) {
    return ERRORS.VALUE;
  }
  if (left.areas.length !== 1 || right.areas.length !== 1) {
    return ERRORS.REF;
  }

  const la = left.areas[0];
  const ra = right.areas[0];

  if (la.sheet.toLowerCase() !== ra.sheet.toLowerCase()) {
    return ERRORS.REF;
  }

  // Bounding rectangle that spans both areas — this is the union /
  // range-op semantics (Excel), distinct from intersection which uses
  // min/max in the opposite direction.
  const top = Math.min(la.top, ra.top);
  const left_ = Math.min(la.left, ra.left);
  const bottom = Math.max(la.bottom, ra.bottom);
  const right_ = Math.max(la.right, ra.right);

  return rvRef(la.sheet, top, left_, bottom, right_);
}

function applyScalarBinaryOp(op: string, left: ScalarValue, right: ScalarValue): ScalarValue {
  if (isError(left)) {
    return left;
  }
  if (isError(right)) {
    return right;
  }

  // Concatenation
  if (op === "&") {
    const lStr = toStringRV(left);
    const rStr = toStringRV(right);
    return rvString(lStr + rStr);
  }

  // Comparison
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    return rvBoolean(compareScalars(left, right, op));
  }

  // Arithmetic
  const lNum = toNumberRV(left);
  if (isError(lNum)) {
    return lNum;
  }
  const rNum = toNumberRV(right);
  if (isError(rNum)) {
    return rNum;
  }

  let result: number;
  switch (op) {
    case "+":
      result = lNum.value + rNum.value;
      break;
    case "-":
      result = lNum.value - rNum.value;
      break;
    case "*":
      result = lNum.value * rNum.value;
      break;
    case "/":
      if (rNum.value === 0) {
        return ERRORS.DIV0;
      }
      result = lNum.value / rNum.value;
      break;
    case "^":
      // Excel distinguishes `0 ^ n` for n < 0 (→ #DIV/0!, since it's
      // semantically 1/0) from other overflows (→ #NUM!). The generic
      // `isFinite` check below loses that distinction, so route the
      // division-by-zero case explicitly first. 0^0 is conventionally 1
      // (matches Excel and POWER()).
      if (lNum.value === 0) {
        if (rNum.value < 0) {
          return ERRORS.DIV0;
        }
        if (rNum.value === 0) {
          return rvNumber(1);
        }
      }
      result = Math.pow(lNum.value, rNum.value);
      if (Number.isNaN(result)) {
        // `Math.pow(-1, 0.5)` etc. — complex result; Excel reports #NUM!.
        return ERRORS.NUM;
      }
      break;
    default:
      return ERRORS.VALUE;
  }

  return !isFinite(result) ? ERRORS.NUM : rvNumber(result);
}

function compareScalars(left: ScalarValue, right: ScalarValue, op: string): boolean {
  let cmp: number;

  // Fast path — same kind, no blanks. Covers the vast majority of
  // comparisons and avoids the blank-normalisation allocation dance
  // below. compareScalarsSameKind handles Number/String/Boolean/Blank
  // intrinsically; the NaN case only arises for Error kinds.
  if (left.kind === right.kind && left.kind !== RVKind.Blank) {
    cmp = compareScalarsSameKind(left, right);
    if (!Number.isFinite(cmp)) {
      cmp = 0;
    }
  } else {
    // Normalize blanks to a neutral form of the opposing kind so formulas like
    // `"" = A1` (where A1 is blank) compare equal. Without this normalisation
    // Excel would route us to the cross-type tiebreak below.
    const l =
      left.kind === RVKind.Blank
        ? right.kind === RVKind.String
          ? rvString("")
          : right.kind === RVKind.Boolean
            ? rvBoolean(false)
            : rvNumber(0)
        : left;
    const r =
      right.kind === RVKind.Blank
        ? left.kind === RVKind.String
          ? rvString("")
          : left.kind === RVKind.Boolean
            ? rvBoolean(false)
            : rvNumber(0)
        : right;

    if (l.kind === r.kind) {
      cmp = compareScalarsSameKind(l, r);
      if (!Number.isFinite(cmp)) {
        cmp = 0;
      }
    } else {
      // Excel orders scalar kinds: Number < String < Boolean < Error/Blank.
      cmp = scalarKindOrder(l) - scalarKindOrder(r);
    }
  }

  switch (op) {
    case "=":
      return cmp === 0;
    case "<>":
      return cmp !== 0;
    case "<":
      return cmp < 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case ">=":
      return cmp >= 0;
    default:
      return false;
  }
}

/** Kind-priority used by Excel when comparing scalars of different kinds. */
function scalarKindOrder(v: ScalarValue): number {
  switch (v.kind) {
    case RVKind.Number:
      return 0;
    case RVKind.String:
      return 1;
    case RVKind.Boolean:
      return 2;
    default:
      return 3; // Error / Blank — callers rarely reach this branch.
  }
}

function broadcastBinaryOp(op: string, left: RuntimeValue, right: RuntimeValue): RuntimeValue {
  const lArr = left.kind === RVKind.Array ? left : null;
  const rArr = right.kind === RVKind.Array ? right : null;

  const lRows = lArr ? lArr.height : 1;
  const lCols = lArr ? lArr.width : 1;
  const rRows = rArr ? rArr.height : 1;
  const rCols = rArr ? rArr.width : 1;

  const outRows = Math.max(lRows, rRows);
  const outCols = Math.max(lCols, rCols);

  if (
    (lRows !== 1 && rRows !== 1 && lRows !== rRows) ||
    (lCols !== 1 && rCols !== 1 && lCols !== rCols)
  ) {
    return ERRORS.VALUE;
  }

  // Guard against pathological broadcasts (e.g. A:A * 1:1 = ~17B cells).
  // 10M cells is well beyond any legitimate array use case.
  if (outRows * outCols > 10_000_000) {
    return ERRORS.CALC;
  }

  // Precompute scalar-broadcast values once outside the hot cell loop.
  // When one side is a non-array `RuntimeValue`, it expands to the same
  // `ScalarValue` for every (r, c); repeating `topLeft(left)` inside the
  // inner loop (outRows × outCols calls) was pure overhead.
  const lScalarFallback: ScalarValue | undefined = lArr ? undefined : topLeft(left);
  const rScalarFallback: ScalarValue | undefined = rArr ? undefined : topLeft(right);

  // Hoist broadcast-flag checks outside the hot loop. The four flags are
  // constant for the entire operation; JS engines usually fold these, but
  // turning them into `const` locals lets the inner loop read bools rather
  // than recomputing `=== 1` each cell.
  const lRowBroadcast = lRows === 1;
  const lColBroadcast = lCols === 1;
  const rRowBroadcast = rRows === 1;
  const rColBroadcast = rCols === 1;

  const rows: ScalarValue[][] = new Array<ScalarValue[]>(outRows);
  for (let r = 0; r < outRows; r++) {
    // Cache the row handle once per output row — avoids `arr.rows[lR]`
    // double-indexing per cell. When the left operand broadcasts along
    // rows (height 1) we read the same row handle every iteration.
    const lRow = lArr ? lArr.rows[lRowBroadcast ? 0 : r] : undefined;
    const rRow = rArr ? rArr.rows[rRowBroadcast ? 0 : r] : undefined;

    const outRow = new Array<ScalarValue>(outCols);
    for (let c = 0; c < outCols; c++) {
      const lVal: ScalarValue = lRow
        ? lRow[lColBroadcast ? 0 : c]
        : (lScalarFallback as ScalarValue);
      const rVal: ScalarValue = rRow
        ? rRow[rColBroadcast ? 0 : c]
        : (rScalarFallback as ScalarValue);
      outRow[c] = applyScalarBinaryOp(op, lVal, rVal);
    }
    rows[r] = outRow;
  }

  // Propagate origin metadata
  const originRow = lArr?.originRow ?? rArr?.originRow;
  const originCol = lArr?.originCol ?? rArr?.originCol;
  return rvArrayRect(rows, outRows, outCols, originRow, originCol);
}

// ============================================================================
// Unary Operations
// ============================================================================

function evaluateUnaryOp(
  op: string,
  operandExpr: BoundExpr,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const rawVal = evaluate(operandExpr, ctx, session);

  // @ implicit intersection
  if (op === "@") {
    const intersected = implicitIntersect(rawVal, ctx);
    return dereferenceValue(intersected, ctx, session);
  }

  const val = dereferenceValue(rawVal, ctx, session);

  if (val.kind === RVKind.Array) {
    const rows: ScalarValue[][] = [];
    for (const row of val.rows) {
      rows.push(row.map(cell => applyScalarUnary(op, cell)));
    }
    return rvArray(rows, val.originRow, val.originCol);
  }

  return applyScalarUnary(op, topLeft(val));
}

function applyScalarUnary(op: string, val: ScalarValue): ScalarValue {
  if (isError(val)) {
    return val;
  }
  const n = toNumberRV(val);
  if (isError(n)) {
    return n;
  }
  switch (op) {
    case "-":
      return rvNumber(-n.value);
    case "+":
      return n;
    default:
      return ERRORS.VALUE;
  }
}

// ============================================================================
// Percent
// ============================================================================

function evaluatePercent(
  operandExpr: BoundExpr,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const val = dereferenceValue(evaluate(operandExpr, ctx, session), ctx, session);
  if (val.kind === RVKind.Array) {
    const rows: ScalarValue[][] = [];
    for (const row of val.rows) {
      rows.push(
        row.map(cell => {
          if (isError(cell)) {
            return cell;
          }
          const n = toNumberRV(cell);
          if (isError(n)) {
            return n;
          }
          return rvNumber(n.value / 100);
        })
      );
    }
    return rvArray(rows);
  }
  const scalar = topLeft(val);
  if (isError(scalar)) {
    return scalar;
  }
  const n = toNumberRV(scalar);
  if (isError(n)) {
    return n;
  }
  return rvNumber(n.value / 100);
}

// ============================================================================
// Function Call (Eager)
// ============================================================================

function evaluateCall(expr: BoundCall, ctx: EvalContext, session: EvalSession): RuntimeValue {
  // Reference functions: ROW, COLUMN, ROWS, COLUMNS
  // (Accept _XLFN. prefixed names transparently.)
  const canonical = stripFunctionPrefix(expr.name);
  const refResult = tryEvaluateRefFunction(canonical, expr.args, ctx);
  if (refResult !== undefined) {
    return refResult;
  }

  // Reference-producing functions like INDIRECT/OFFSET yield a
  // ReferenceValue at runtime. ROW/COLUMN/ROWS/COLUMNS need to inspect
  // the resulting reference's address rather than its dereferenced value,
  // so we evaluate the argument *without* dereferencing and extract the
  // geometry directly. Only the 1-arg reference-only forms go down this
  // path; scalar/array arguments still fall through to the eager fallback
  // below, which returns #VALUE! for ROW/COLUMN and the correct count for
  // ROWS/COLUMNS.
  if (expr.args.length === 1 && isSimpleRefFunction(canonical)) {
    const raw = evaluate(expr.args[0], ctx, session);
    if (raw.kind === RVKind.Reference && raw.areas.length > 0) {
      // ROW / COLUMN pick the top-left coordinate of the first area —
      // matches Excel's reference-position rule for multi-area refs.
      // ROWS / COLUMNS match the flattened shape that `dereferenceValue`
      // would produce: for a multi-area union we stack all areas
      // vertically, so ROWS sums every area's height and COLUMNS takes
      // the max width. This keeps `ROWS(union)` consistent with
      // `SUMPRODUCT(–(union=union))` / `SUM(union)` — all of which see
      // the stacked view — instead of silently dropping the tail areas.
      const areas = raw.areas;
      switch (canonical) {
        case "ROW":
          return rvNumber(areas[0].top);
        case "COLUMN":
          return rvNumber(areas[0].left);
        case "ROWS": {
          if (areas.length === 1) {
            return rvNumber(areas[0].bottom - areas[0].top + 1);
          }
          let total = 0;
          for (const a of areas) {
            total += a.bottom - a.top + 1;
          }
          return rvNumber(total);
        }
        case "COLUMNS": {
          if (areas.length === 1) {
            return rvNumber(areas[0].right - areas[0].left + 1);
          }
          let maxW = 0;
          for (const a of areas) {
            const w = a.right - a.left + 1;
            if (w > maxW) {
              maxW = w;
            }
          }
          return rvNumber(maxW);
        }
      }
    }
  }

  // ── Reference-aware functions (ISREF, CELL) ──
  // These inspect the argument's reference-ness rather than its dereferenced
  // value. Handled here so the raw BoundExpr / ReferenceValue is visible.
  if (canonical === "ISREF") {
    return evaluateISREF(expr.args, ctx, session);
  }
  if (canonical === "CELL") {
    return evaluateCELL(expr.args, ctx, session);
  }

  // ── INDEX reference-aware path ──
  // Excel's INDEX takes an optional fourth `area_num` that selects
  // which member of a multi-area reference to index into, e.g.
  // `INDEX((A1:B2, D4:E5), 1, 1, 2) = D4`. We need to see the raw
  // ReferenceValue (not its flattened deref array) to support this.
  if (canonical === "INDEX") {
    const result = tryEvaluateINDEX(expr.args, ctx, session);
    if (result !== undefined) {
      return result;
    }
  }

  // ── AREAS reference-aware path ──
  // `AREAS((A1:B2, D4:E5))` should return 2, not 1. The standard
  // eager-dereference path flattens multi-area references into a single
  // stacked ArrayValue, losing the area count. Intercept here so we
  // see the raw ReferenceValue.
  if (canonical === "AREAS" && expr.args.length === 1) {
    const raw = evaluate(expr.args[0], ctx, session);
    if (isError(raw)) {
      return raw;
    }
    if (raw.kind === RVKind.Reference) {
      return rvNumber(raw.areas.length);
    }
    // AREAS expects a reference-producing argument. Non-references
    // (literals, scalars, arrays) are rejected with #VALUE! in Excel,
    // not silently coerced to `1`. Previously we returned 1 which hid
    // caller bugs like `AREAS(42)` that should surface as errors.
    return ERRORS.VALUE;
  }

  // Evaluate all arguments eagerly and dereference references
  const args: RuntimeValue[] = expr.args.map(arg =>
    dereferenceValue(evaluate(arg, ctx, session), ctx, session)
  );

  // Look up function via the canonical (prefix-stripped) name computed
  // above. Previously we passed `expr.name`, forcing `lookupFunction`
  // to re-strip the prefix on every call; reusing `canonical` skips
  // that redundant check.
  //
  // User-registered functions take precedence over the built-in
  // registry — this lets callers shadow a built-in (e.g. replace
  // `IRR` with a domain-specific variant) or register entirely new
  // names (`MYFN`). The resulting descriptor still goes through the
  // same arity check.
  const userDesc = ctx.userFunctions?.get(canonical);
  if (userDesc) {
    // Validate arity first — same rule as built-ins.
    if (args.length < userDesc.minArity || args.length > userDesc.maxArity) {
      return ERRORS.VALUE;
    }
    // User-supplied code can throw; catch at the boundary so a buggy
    // custom function surfaces as `#VALUE!` rather than tearing down
    // the whole calculation pass. Any RuntimeValue return (including
    // error values the user constructed intentionally) passes through.
    try {
      return userDesc.invoke(args, ctx.functionContext);
    } catch {
      return ERRORS.VALUE;
    }
  }
  const desc = lookupFunction(canonical);
  if (desc) {
    // Validate arity — produce #VALUE! for wrong argument count
    if (args.length < desc.minArity || args.length > desc.maxArity) {
      return ERRORS.VALUE;
    }
    // Context-aware overrides for functions that need evaluator state
    switch (canonical) {
      case "SHEET": {
        // SHEET() → current sheet number; SHEET(ref) → sheet number of ref
        if (args.length === 0) {
          const idx = ctx.snapshot.worksheets.findIndex(
            ws => ws.name.toLowerCase() === ctx.currentSheet.toLowerCase()
          );
          return rvNumber(idx >= 0 ? idx + 1 : 1);
        }
        return desc.invoke(args, ctx.functionContext);
      }
      case "SHEETS": {
        // SHEETS() → total sheet count
        if (args.length === 0) {
          return rvNumber(ctx.snapshot.worksheets.length);
        }
        return desc.invoke(args, ctx.functionContext);
      }
      case "ISFORMULA":
        return evaluateISFORMULA(expr.args, ctx, session);
      case "FORMULATEXT":
        return evaluateFORMULATEXT(expr.args, ctx, session);
      default:
        return desc.invoke(args, ctx.functionContext);
    }
  }

  // Check if name resolves to a lambda (defined name or local binding)
  const lambda = resolveLambdaName(expr.name, args, ctx, session);
  if (lambda !== undefined) {
    return lambda;
  }

  return ERRORS.NAME;
}

// ============================================================================
// Special Form Call (Lazy)
// ============================================================================

function evaluateSpecialCall(
  expr: BoundSpecialCall,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  switch (expr.name) {
    case "IF":
      return evaluateIF(expr.args, ctx, session);
    case "IFERROR":
      return evaluateIFERROR(expr.args, ctx, session);
    case "IFNA":
      return evaluateIFNA(expr.args, ctx, session);
    case "IFS":
      return evaluateIFS(expr.args, ctx, session);
    case "SWITCH":
      return evaluateSWITCH(expr.args, ctx, session);
    case "CHOOSE":
      return evaluateCHOOSE(expr.args, ctx, session);
    case "LET":
      return evaluateLET(expr.args, ctx, session);
    case "LAMBDA":
      return evaluateLAMBDA(expr.args, ctx);
    case "INDIRECT":
      return evaluateINDIRECT(expr.args, ctx, session);
    case "OFFSET":
      return evaluateOFFSET(expr.args, ctx, session);
    case "MAP":
    case "REDUCE":
    case "SCAN":
    case "MAKEARRAY":
    case "BYROW":
    case "BYCOL":
      return evaluateHigherOrder(expr.name, expr.args, ctx, session);
    default:
      return ERRORS.VALUE;
  }
}

// ============================================================================
// Special Forms Implementation
// ============================================================================

function evaluateIF(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 2) {
    return ERRORS.VALUE;
  }
  const condRaw = evalDeref(args[0], ctx, session);

  // Array condition: element-wise IF. Excel's dynamic-array mode makes
  // `IF({TRUE,FALSE,TRUE}, "Y", "N")` return `{"Y","N","Y"}`. The branches
  // are evaluated eagerly — Excel does this too because array broadcasting
  // requires both shapes to be known — and each cell in the output picks
  // from the corresponding cell of the chosen branch (with scalar branches
  // broadcasting to fill the condition array's shape).
  if (condRaw.kind === RVKind.Array) {
    const trueVal = evalDeref(args[1], ctx, session);
    const falseVal =
      args.length > 2 ? evalDeref(args[2], ctx, session) : (rvBoolean(false) as RuntimeValue);
    const rows: ScalarValue[][] = [];
    for (let r = 0; r < condRaw.height; r++) {
      const outRow: ScalarValue[] = [];
      for (let c = 0; c < condRaw.width; c++) {
        const cell = condRaw.rows[r][c];
        if (cell.kind === RVKind.Error) {
          outRow.push(cell);
          continue;
        }
        const b = toBooleanRV(cell);
        if (b.kind === RVKind.Error) {
          outRow.push(b);
          continue;
        }
        const branch = b.value ? trueVal : falseVal;
        outRow.push(pickCellBroadcast(branch, r, c));
      }
      rows.push(outRow);
    }
    return rvArray(rows);
  }

  const cond = topLeft(condRaw);
  if (isError(cond)) {
    return cond;
  }
  const bool = toBooleanRV(cond);
  if (isError(bool)) {
    return bool;
  }
  if (bool.value) {
    return evaluate(args[1], ctx, session);
  }
  return args.length > 2 ? evaluate(args[2], ctx, session) : rvBoolean(false);
}

/**
 * Pick a scalar from `branch` corresponding to grid position (r, c), with
 * broadcasting: scalar branches are repeated; smaller arrays are indexed
 * modulo their bounds (out-of-range → BLANK) matching Excel's array
 * alignment rules for IF/IFS/etc.
 */
function pickCellBroadcast(branch: RuntimeValue, r: number, c: number): ScalarValue {
  if (branch.kind !== RVKind.Array) {
    return topLeft(branch);
  }
  const row = r < branch.height ? r : branch.height === 1 ? 0 : -1;
  const col = c < branch.width ? c : branch.width === 1 ? 0 : -1;
  if (row < 0 || col < 0) {
    // Misaligned array branch (smaller than the condition, and not a
    // broadcastable 1-row / 1-column shape). Excel fills the gaps with
    // `#N/A` rather than BLANK, so downstream consumers can distinguish
    // "branch didn't cover this cell" from "branch actually returned
    // empty". (R6-P1-7)
    return ERRORS.NA;
  }
  return branch.rows[row][col];
}

/**
 * Shared array-aware error replacement used by IFERROR and IFNA. Scans `val`
 * for cells matching `isMatch`; if any are found, replaces each with the
 * top-left scalar of `replacement` (lazily evaluated). Scalar inputs follow
 * the same match-or-pass-through logic.
 */
function replaceErrorsIn(
  val: RuntimeValue,
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession,
  isMatch: (err: ErrorValue) => boolean
): RuntimeValue {
  if (val.kind === RVKind.Array) {
    let anyMatch = false;
    for (const row of val.rows) {
      for (const cell of row) {
        if (cell.kind === RVKind.Error && isMatch(cell)) {
          anyMatch = true;
          break;
        }
      }
      if (anyMatch) {
        break;
      }
    }
    if (!anyMatch) {
      return val;
    }
    const replaceScalar = topLeft(evalDeref(args[1], ctx, session));
    const rows: ScalarValue[][] = [];
    for (const row of val.rows) {
      const newRow: ScalarValue[] = [];
      for (const cell of row) {
        newRow.push(cell.kind === RVKind.Error && isMatch(cell) ? replaceScalar : cell);
      }
      rows.push(newRow);
    }
    return rvArray(rows);
  }
  return isError(val) && isMatch(val) ? evalDeref(args[1], ctx, session) : val;
}

function evaluateIFERROR(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 2) {
    return ERRORS.VALUE;
  }
  const val = evalDeref(args[0], ctx, session);
  return replaceErrorsIn(val, args, ctx, session, () => true);
}

function evaluateIFNA(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 2) {
    return ERRORS.VALUE;
  }
  const val = evalDeref(args[0], ctx, session);
  return replaceErrorsIn(val, args, ctx, session, err => err.code === "#N/A");
}

function evaluateIFS(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 2) {
    return ERRORS.VALUE;
  }
  // Excel requires IFS args to come in test/value pairs. Odd-length
  // arg lists imply a trailing test with no value and are #N/A.
  if (args.length % 2 !== 0) {
    return ERRORS.NA;
  }
  for (let i = 0; i < args.length - 1; i += 2) {
    const cond = topLeft(evalDeref(args[i], ctx, session));
    if (isError(cond)) {
      return cond;
    }
    const bool = toBooleanRV(cond);
    if (isError(bool)) {
      return bool;
    }
    if (bool.value) {
      return evaluate(args[i + 1], ctx, session);
    }
  }
  return ERRORS.NA;
}

function evaluateSWITCH(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 3) {
    return ERRORS.VALUE;
  }
  const expr = topLeft(evalDeref(args[0], ctx, session));
  if (isError(expr)) {
    return expr;
  }
  for (let i = 1; i < args.length - 1; i += 2) {
    const caseVal = topLeft(evalDeref(args[i], ctx, session));
    if (scalarEquals(expr, caseVal)) {
      return evaluate(args[i + 1], ctx, session);
    }
  }
  if (args.length % 2 === 0) {
    return evaluate(args[args.length - 1], ctx, session);
  }
  return ERRORS.NA;
}

function evaluateCHOOSE(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 2) {
    return ERRORS.VALUE;
  }
  const idxVal = topLeft(evalDeref(args[0], ctx, session));
  if (isError(idxVal)) {
    return idxVal;
  }
  const num = toNumberRV(idxVal);
  if (isError(num)) {
    return num;
  }
  const idx = Math.floor(num.value);
  if (idx < 1 || idx >= args.length) {
    return ERRORS.VALUE;
  }
  return evaluate(args[idx], ctx, session);
}

function evaluateLET(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 3 || args.length % 2 !== 1) {
    return ERRORS.VALUE;
  }
  const prevBindings = ctx.localBindings;
  const newBindings = new Map<string, RuntimeValue>(prevBindings);

  try {
    const pairCount = (args.length - 1) / 2;
    for (let i = 0; i < pairCount; i++) {
      const nameExpr = args[i * 2];
      const valueExpr = args[i * 2 + 1];
      if (nameExpr.kind !== BoundExprKind.NameExpr) {
        return ERRORS.VALUE;
      }
      ctx.localBindings = newBindings;
      const val = evaluate(valueExpr, ctx, session);
      newBindings.set(nameExpr.upperName, val);
    }

    ctx.localBindings = newBindings;
    return evaluate(args[args.length - 1], ctx, session);
  } finally {
    ctx.localBindings = prevBindings;
  }
}

function evaluateLAMBDA(args: readonly BoundExpr[], ctx: EvalContext): RuntimeValue {
  if (args.length < 1) {
    return ERRORS.VALUE;
  }
  const paramExprs = args.slice(0, -1);
  const bodyExpr = args[args.length - 1];
  const params: string[] = [];
  for (const p of paramExprs) {
    if (p.kind !== BoundExprKind.NameExpr) {
      return ERRORS.VALUE;
    }
    params.push(p.upperName);
  }
  return rvLambda(params, bodyExpr, ctx.localBindings ? new Map(ctx.localBindings) : undefined);
}

function evaluateINDIRECT(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 1) {
    return ERRORS.VALUE;
  }
  const refArg = evalDeref(args[0], ctx, session);
  const refText = toStringRV(topLeft(refArg));
  if (!refText) {
    return ERRORS.REF;
  }

  let a1 = true;
  if (args.length >= 2) {
    const a1Val = topLeft(evalDeref(args[1], ctx, session));
    a1 =
      !(a1Val.kind === RVKind.Boolean && !a1Val.value) &&
      !(a1Val.kind === RVKind.Number && a1Val.value === 0);
  }

  if (!a1) {
    // R1C1 — delegate to runtime R1C1 parser
    return resolveR1C1(refText, ctx, session);
  }

  // A1 style — parse and bind at runtime
  try {
    // Use NUL (U+0000) as the separator so sheet names containing `__`
    // can't collide with distinct INDIRECT call sites. Neither formula
    // text nor an Excel sheet name is allowed to contain `\0`, so the
    // key is unambiguous. (R6-P1-12)
    const cacheKey = `${ctx.currentSheet}\u0000${refText}`;
    let bound = session.indirectAstCache.get(cacheKey);
    if (bound) {
      // LRU touch: delete-then-set moves the hit entry to the Map's
      // insertion-order tail so the oldest entry is always `keys().next()`.
      session.indirectAstCache.delete(cacheKey);
      session.indirectAstCache.set(cacheKey, bound);
    } else {
      const tokens = tokenize(refText);
      const ast = parse(tokens);
      const bindCtx: BindingContext = { snapshot: ctx.snapshot, currentSheet: ctx.currentSheet };
      bound = bind(ast, bindCtx);
      // Bound the cache so an adversarial formula that generates a fresh
      // INDIRECT string every call can't grow session memory unbounded.
      // The cap matches `astCache` in calculate-formulas-impl.ts. (R6
      // architectural note #6)
      if (session.indirectAstCache.size >= 10_000) {
        const oldestKey = session.indirectAstCache.keys().next().value;
        if (oldestKey !== undefined) {
          session.indirectAstCache.delete(oldestKey);
        }
      }
      session.indirectAstCache.set(cacheKey, bound);
    }
    return evaluate(bound, ctx, session);
  } catch {
    return ERRORS.REF;
  }
}

function evaluateOFFSET(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 3) {
    return ERRORS.VALUE;
  }
  const refExpr = args[0];
  let baseRow: number;
  let baseCol: number;
  let baseSheet: string;
  // Remember the base reference's shape — Excel's OFFSET uses it as the
  // default height/width when those optional arguments are omitted.
  let baseHeight: number;
  let baseWidth: number;

  if (refExpr.kind === BoundExprKind.CellRef) {
    baseRow = refExpr.row;
    baseCol = refExpr.col;
    baseSheet = refExpr.sheet;
    baseHeight = 1;
    baseWidth = 1;
  } else if (refExpr.kind === BoundExprKind.AreaRef) {
    baseRow = refExpr.top;
    baseCol = refExpr.left;
    baseSheet = refExpr.sheet;
    baseHeight = refExpr.bottom - refExpr.top + 1;
    baseWidth = refExpr.right - refExpr.left + 1;
  } else {
    // Evaluate — the base might be produced at runtime (INDIRECT, a
    // chained OFFSET, a defined name that bound to a reference, etc.).
    // Only accept single-area references; multi-area refs (3D / union)
    // are rejected by Excel too.
    const evaluated = evaluate(refExpr, ctx, session);
    if (isError(evaluated)) {
      return evaluated;
    }
    if (evaluated.kind !== RVKind.Reference || evaluated.areas.length !== 1) {
      return ERRORS.VALUE;
    }
    const area = evaluated.areas[0];
    baseRow = area.top;
    baseCol = area.left;
    baseSheet = area.sheet;
    baseHeight = area.bottom - area.top + 1;
    baseWidth = area.right - area.left + 1;
  }

  const rowsVal = topLeft(evalDeref(args[1], ctx, session));
  const rowsNum = toNumberRV(rowsVal);
  if (isError(rowsNum)) {
    return rowsNum;
  }
  const colsVal = topLeft(evalDeref(args[2], ctx, session));
  const colsNum = toNumberRV(colsVal);
  if (isError(colsNum)) {
    return colsNum;
  }

  // Excel truncates fractional rows/cols toward zero (not floor). Without
  // the `Math.trunc`, `OFFSET(A5, -0.7, 0)` would resolve to row 4.3 and
  // then fail the Map lookup silently, returning BLANK instead of A5.
  const newRow = baseRow + Math.trunc(rowsNum.value);
  const newCol = baseCol + Math.trunc(colsNum.value);
  if (newRow < 1 || newCol < 1 || newRow > 1048576 || newCol > 16384) {
    return ERRORS.REF;
  }

  // Default height / width come from the base reference itself. OFFSET
  // only shrinks/expands when the caller passes an explicit non-missing
  // fourth/fifth argument. A `MissingNode` (compile-time "omitted
  // argument") binds to a `null`-valued literal; we treat that the same
  // as "no argument provided" so `OFFSET(A1:C3, 0, 0, , )` keeps the
  // 3-row × 3-col span instead of collapsing to #REF! with `height = 0`.
  const isOmitted = (a: BoundExpr): boolean =>
    a.kind === BoundExprKind.Literal && a.value === null && a.errorCode === undefined;

  let height = baseHeight;
  let width = baseWidth;
  if (args.length > 3 && !isOmitted(args[3])) {
    const h = toNumberRV(topLeft(evalDeref(args[3], ctx, session)));
    if (isError(h)) {
      return h;
    }
    height = Math.trunc(h.value);
    if (height === 0) {
      return ERRORS.REF;
    }
  }
  if (args.length > 4 && !isOmitted(args[4])) {
    const w = toNumberRV(topLeft(evalDeref(args[4], ctx, session)));
    if (isError(w)) {
      return w;
    }
    width = Math.trunc(w.value);
    if (width === 0) {
      return ERRORS.REF;
    }
  }

  // Resolve range coordinates — negative height/width extend upward/leftward
  let top = newRow;
  let bottom = newRow + height - 1;
  if (height < 0) {
    top = newRow + height + 1;
    bottom = newRow;
  }
  let left = newCol;
  let right = newCol + width - 1;
  if (width < 0) {
    left = newCol + width + 1;
    right = newCol;
  }

  if (top < 1 || left < 1 || bottom > 1048576 || right > 16384) {
    return ERRORS.REF;
  }

  if (top === bottom && left === right) {
    return getCellValue(baseSheet, top, left, ctx, session);
  }

  return buildRangeArray(ctx, session, baseSheet, top, left, bottom, right);
}

// ============================================================================
// Higher-Order Functions
// ============================================================================

function evaluateHigherOrder(
  name: string,
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  switch (name) {
    case "MAP":
      return evaluateMAP(args, ctx, session);
    case "REDUCE":
      return evaluateREDUCE(args, ctx, session);
    case "SCAN":
      return evaluateSCAN(args, ctx, session);
    case "MAKEARRAY":
      return evaluateMAKEARRAY(args, ctx, session);
    case "BYROW":
      return evaluateBYROW(args, ctx, session);
    case "BYCOL":
      return evaluateBYCOL(args, ctx, session);
    default:
      return ERRORS.VALUE;
  }
}

function invokeLambda(
  lambda: LambdaValue,
  lambdaArgs: RuntimeValue[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (lambdaArgs.length !== lambda.params.length) {
    return ERRORS.VALUE;
  }
  if (session.lambdaDepth >= 256) {
    return ERRORS.NUM;
  }
  session.lambdaDepth++;
  try {
    const prevBindings = ctx.localBindings;
    const newBindings = new Map<string, RuntimeValue>(lambda.closureBindings);
    for (let i = 0; i < lambda.params.length; i++) {
      newBindings.set(lambda.params[i], lambdaArgs[i]);
    }
    ctx.localBindings = newBindings;
    try {
      return dereferenceValue(evaluate(lambda.body, ctx, session), ctx, session);
    } finally {
      ctx.localBindings = prevBindings;
    }
  } finally {
    session.lambdaDepth--;
  }
}

function evaluateMAP(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 2) {
    return ERRORS.VALUE;
  }
  // Excel's MAP accepts N source arrays + 1 lambda; the lambda must take
  // exactly N parameters. Previously this implementation only read the
  // first array and ignored args[1..N-1], so `MAP(A1:A3, B1:B3,
  // LAMBDA(a,b, a+b))` silently behaved as `MAP(A1:A3, LAMBDA(a, a))`.
  const lambdaVal = evalDeref(args[args.length - 1], ctx, session);
  if (!isLambda(lambdaVal)) {
    return ERRORS.VALUE;
  }
  const arrayArgs: RuntimeValue[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    arrayArgs.push(evalDeref(args[i], ctx, session));
  }
  if (lambdaVal.params.length !== arrayArgs.length) {
    return ERRORS.VALUE;
  }
  // Determine shape — all arrays must agree. Scalar args broadcast to
  // the majority shape. If every arg is a scalar, invoke the lambda
  // once with them all.
  let height = 1;
  let width = 1;
  for (const a of arrayArgs) {
    if (a.kind === RVKind.Array) {
      height = Math.max(height, a.height);
      width = Math.max(width, a.width);
    }
  }
  const allScalar = arrayArgs.every(a => a.kind !== RVKind.Array);
  if (allScalar) {
    return invokeLambda(lambdaVal, arrayArgs, ctx, session);
  }
  // Shape-mismatch rejection for arrays that neither broadcast nor
  // agree: each non-scalar array must match the target shape exactly
  // (Excel does not broadcast beyond scalar).
  for (const a of arrayArgs) {
    if (a.kind === RVKind.Array && (a.height !== height || a.width !== width)) {
      return ERRORS.VALUE;
    }
  }
  const rows: ScalarValue[][] = [];
  for (let r = 0; r < height; r++) {
    const outRow: ScalarValue[] = [];
    for (let c = 0; c < width; c++) {
      const callArgs: RuntimeValue[] = arrayArgs.map(a =>
        a.kind === RVKind.Array ? a.rows[r][c] : a
      );
      outRow.push(topLeft(invokeLambda(lambdaVal, callArgs, ctx, session)));
    }
    rows.push(outRow);
  }
  return rvArray(rows);
}

function evaluateREDUCE(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 3) {
    return ERRORS.VALUE;
  }
  let acc = evalDeref(args[0], ctx, session);
  const arrVal = evalDeref(args[1], ctx, session);
  const lambdaVal = evalDeref(args[2], ctx, session);
  if (!isLambda(lambdaVal)) {
    return ERRORS.VALUE;
  }
  // REDUCE's reducer takes exactly 2 parameters: the accumulator and
  // the current value. A mismatched arity silently bound `acc` but
  // left `value` undefined (or silently dropped extra params).
  if (lambdaVal.params.length !== 2) {
    return ERRORS.VALUE;
  }
  if (arrVal.kind === RVKind.Array) {
    for (const row of arrVal.rows) {
      for (const cell of row) {
        // `acc` may legitimately be an array (the lambda returning one
        // is allowed — VSTACK inside the reducer, etc.). Only flatten
        // scalars when passing to the lambda; keeping the array shape
        // means subsequent iterations see the lambda's full output.
        acc = invokeLambda(lambdaVal, [acc, cell], ctx, session);
      }
    }
  } else {
    // Scalar input: Excel treats the scalar as a 1×1 array and invokes the
    // reducer exactly once. Previously we returned `init` unchanged, which
    // silently broke `REDUCE(0, some_scalar, lambda)` callers.
    acc = invokeLambda(lambdaVal, [acc, topLeft(arrVal)], ctx, session);
  }
  return acc;
}

function evaluateSCAN(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 3) {
    return ERRORS.VALUE;
  }
  let acc = evalDeref(args[0], ctx, session);
  const arrVal = evalDeref(args[1], ctx, session);
  const lambdaVal = evalDeref(args[2], ctx, session);
  if (!isLambda(lambdaVal)) {
    return ERRORS.VALUE;
  }
  // SCAN's reducer takes (acc, value) — same arity rule as REDUCE.
  if (lambdaVal.params.length !== 2) {
    return ERRORS.VALUE;
  }
  const rows: ScalarValue[][] = [];
  if (arrVal.kind === RVKind.Array) {
    for (const row of arrVal.rows) {
      const outRow: ScalarValue[] = [];
      for (const cell of row) {
        // Pass `acc` through without topLeft so the lambda sees the full
        // previous result (matches the REDUCE fix). Each output cell
        // still captures the scalar top-left of `acc` so the result
        // grid stays rectangular.
        acc = invokeLambda(lambdaVal, [acc, cell], ctx, session);
        outRow.push(topLeft(acc));
      }
      rows.push(outRow);
    }
    return rows.length > 0 ? rvArray(rows) : ERRORS.CALC;
  }
  // Scalar input: emit a single-cell array containing the one accumulated
  // value. Previously we returned #CALC! here, which was an artefact of the
  // array-only implementation path.
  const result = invokeLambda(lambdaVal, [acc, topLeft(arrVal)], ctx, session);
  return rvArray([[topLeft(result)]]);
}

function evaluateMAKEARRAY(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 3) {
    return ERRORS.VALUE;
  }
  const rowsNum = toNumberRV(topLeft(evalDeref(args[0], ctx, session)));
  if (isError(rowsNum)) {
    return rowsNum;
  }
  const colsNum = toNumberRV(topLeft(evalDeref(args[1], ctx, session)));
  if (isError(colsNum)) {
    return colsNum;
  }
  const lambdaVal = evalDeref(args[2], ctx, session);
  if (!isLambda(lambdaVal)) {
    return ERRORS.VALUE;
  }
  // Excel's MAKEARRAY requires a 2-parameter lambda (row, col).
  // A 0 / 1 / 3+ param lambda is rejected at call time — previously we
  // invoked with 2 args regardless, which silently extended the lambda's
  // bindings past its declared parameter list (or left declared params
  // undefined).
  if (lambdaVal.params.length !== 2) {
    return ERRORS.VALUE;
  }
  // Truncate toward zero and reject non-positive / overflow sizes.
  // Without the cell-count cap the engine can silently allocate billions
  // of scalars before blowing the heap; matching the broadcast limit
  // keeps MAKEARRAY in line with the rest of the array pipeline.
  const rCount = Math.trunc(rowsNum.value);
  const cCount = Math.trunc(colsNum.value);
  if (rCount < 1 || cCount < 1) {
    return ERRORS.VALUE;
  }
  if (rCount * cCount > 10_000_000) {
    return ERRORS.NUM;
  }
  const rows: ScalarValue[][] = [];
  for (let r = 1; r <= rCount; r++) {
    const outRow: ScalarValue[] = [];
    for (let c = 1; c <= cCount; c++) {
      outRow.push(topLeft(invokeLambda(lambdaVal, [rvNumber(r), rvNumber(c)], ctx, session)));
    }
    rows.push(outRow);
  }
  return rvArray(rows);
}

function evaluateBYROW(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 2) {
    return ERRORS.VALUE;
  }
  const arrVal = evalDeref(args[0], ctx, session);
  const lambdaVal = evalDeref(args[1], ctx, session);
  if (!isLambda(lambdaVal)) {
    return ERRORS.VALUE;
  }
  // BYROW requires a single-parameter lambda (the row). Mismatched arity
  // is rejected by Excel at call time — our previous impl silently left
  // extra params undefined.
  if (lambdaVal.params.length !== 1) {
    return ERRORS.VALUE;
  }
  if (arrVal.kind !== RVKind.Array) {
    return invokeLambda(lambdaVal, [rvArray([[topLeft(arrVal)]])], ctx, session);
  }
  // Empty array (height 0) → Excel's BYROW reports `#CALC!` because
  // there is nothing to iterate over. Previously we returned an empty
  // array value which downstream arithmetic could not use.
  if (arrVal.height === 0 || arrVal.width === 0) {
    return ERRORS.CALC;
  }
  const rows: ScalarValue[][] = [];
  for (const row of arrVal.rows) {
    const rowArr = rvArray([row.map(c => c)]);
    rows.push([topLeft(invokeLambda(lambdaVal, [rowArr], ctx, session))]);
  }
  return rvArray(rows);
}

function evaluateBYCOL(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 2) {
    return ERRORS.VALUE;
  }
  const arrVal = evalDeref(args[0], ctx, session);
  const lambdaVal = evalDeref(args[1], ctx, session);
  if (!isLambda(lambdaVal)) {
    return ERRORS.VALUE;
  }
  // BYCOL requires a single-parameter lambda (the column). See BYROW.
  if (lambdaVal.params.length !== 1) {
    return ERRORS.VALUE;
  }
  if (arrVal.kind !== RVKind.Array) {
    return invokeLambda(lambdaVal, [rvArray([[topLeft(arrVal)]])], ctx, session);
  }
  // Empty array → `#CALC!` (see BYROW).
  if (arrVal.height === 0 || arrVal.width === 0) {
    return ERRORS.CALC;
  }
  const numCols = arrVal.width;
  const outRow: ScalarValue[] = [];
  for (let c = 0; c < numCols; c++) {
    const colArr = rvArray(arrVal.rows.map(row => [row[c]]));
    outRow.push(topLeft(invokeLambda(lambdaVal, [colArr], ctx, session)));
  }
  return rvArray([outRow]);
}

// ============================================================================
// Reference Functions (ROW, COLUMN, ROWS, COLUMNS)
// ============================================================================

/** Whether `name` is one of the four "inspect a reference's geometry" builtins. */
function isSimpleRefFunction(name: string): boolean {
  return name === "ROW" || name === "COLUMN" || name === "ROWS" || name === "COLUMNS";
}

function tryEvaluateRefFunction(
  name: string,
  args: readonly BoundExpr[],
  ctx: EvalContext
): RuntimeValue | undefined {
  switch (name) {
    case "ROW":
      if (args.length === 0) {
        return ctx.currentAddress ? rvNumber(ctx.currentAddress.row) : ERRORS.VALUE;
      }
      if (args[0].kind === BoundExprKind.CellRef) {
        return rvNumber(args[0].row);
      }
      if (args[0].kind === BoundExprKind.AreaRef) {
        return rvNumber(args[0].top);
      }
      return undefined;
    case "COLUMN":
      if (args.length === 0) {
        return ctx.currentAddress ? rvNumber(ctx.currentAddress.col) : ERRORS.VALUE;
      }
      if (args[0].kind === BoundExprKind.CellRef) {
        return rvNumber(args[0].col);
      }
      if (args[0].kind === BoundExprKind.AreaRef) {
        return rvNumber(args[0].left);
      }
      return undefined;
    case "ROWS":
      if (args.length > 0 && args[0].kind === BoundExprKind.AreaRef) {
        return rvNumber(args[0].bottom - args[0].top + 1);
      }
      if (args.length > 0 && args[0].kind === BoundExprKind.CellRef) {
        return rvNumber(1);
      }
      return undefined;
    case "COLUMNS":
      if (args.length > 0 && args[0].kind === BoundExprKind.AreaRef) {
        return rvNumber(args[0].right - args[0].left + 1);
      }
      if (args.length > 0 && args[0].kind === BoundExprKind.CellRef) {
        return rvNumber(1);
      }
      return undefined;
    default:
      return undefined;
  }
}

// ============================================================================
// Reference-aware: ISREF
// ============================================================================

/**
 * Resolve the top-left cell targeted by an ISFORMULA / FORMULATEXT argument.
 *
 * Unlike `resolveCellRefArg` (used by CELL), these two functions must return
 * `#N/A` for non-reference arguments (arithmetic, literals, ...) rather than
 * `#VALUE!`. We support:
 *   - purely syntactic reference nodes (CellRef / AreaRef / ColRangeRef /
 *     RowRangeRef / Ref3D) — cheapest path, no evaluation needed
 *   - runtime-produced references (INDIRECT, OFFSET) — we evaluate without
 *     dereferencing and inspect the resulting ReferenceValue
 *
 * Anything else — including errors from INDIRECT("xx") — collapses to
 * `#N/A`, matching Excel's tolerant behaviour for these two functions.
 */
function resolveFormulaRefArg(
  arg: BoundExpr | undefined,
  ctx: EvalContext,
  session: EvalSession
): { sheet: string; row: number; col: number } | null {
  if (!arg) {
    return null;
  }
  // Syntactic reference forms — extract top-left directly, no evaluation.
  if (arg.kind === BoundExprKind.CellRef) {
    return { sheet: arg.sheet, row: arg.row, col: arg.col };
  }
  if (arg.kind === BoundExprKind.AreaRef) {
    return { sheet: arg.sheet, row: arg.top, col: arg.left };
  }
  if (arg.kind === BoundExprKind.ColRangeRef) {
    const ws = ctx.snapshot.worksheetsByName.get(arg.sheet.toLowerCase());
    const top = ws?.dimensions?.top ?? 1;
    return { sheet: arg.sheet, row: top, col: arg.leftCol };
  }
  if (arg.kind === BoundExprKind.RowRangeRef) {
    const ws = ctx.snapshot.worksheetsByName.get(arg.sheet.toLowerCase());
    const left = ws?.dimensions?.left ?? 1;
    return { sheet: arg.sheet, row: arg.topRow, col: left };
  }
  if (arg.kind === BoundExprKind.Ref3D) {
    const first = arg.sheets[0];
    if (first === undefined) {
      return null;
    }
    if (arg.inner.kind === BoundExprKind.CellRef) {
      return { sheet: first, row: arg.inner.row, col: arg.inner.col };
    }
    return { sheet: first, row: arg.inner.top, col: arg.inner.left };
  }
  // Evaluate without dereferencing — INDIRECT/OFFSET may yield a
  // ReferenceValue. Errors or non-references collapse to null (→ #N/A).
  const raw = evaluate(arg, ctx, session);
  if (raw.kind === RVKind.Reference && raw.areas.length > 0) {
    const area = raw.areas[0];
    return { sheet: area.sheet, row: area.top, col: area.left };
  }
  return null;
}

function evaluateISFORMULA(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length !== 1) {
    return ERRORS.NA;
  }
  const target = resolveFormulaRefArg(args[0], ctx, session);
  if (!target) {
    return ERRORS.NA;
  }
  const ws = ctx.snapshot.worksheetsByName.get(target.sheet.toLowerCase());
  if (!ws) {
    return ERRORS.REF;
  }
  const cell = ws.cells.get(snapshotCellKey(target.row, target.col));
  return rvBoolean(cell !== undefined && cell.formulaKind !== "none");
}

function evaluateFORMULATEXT(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length !== 1) {
    return ERRORS.NA;
  }
  const target = resolveFormulaRefArg(args[0], ctx, session);
  if (!target) {
    return ERRORS.NA;
  }
  const ws = ctx.snapshot.worksheetsByName.get(target.sheet.toLowerCase());
  if (!ws) {
    return ERRORS.REF;
  }
  const cell = ws.cells.get(snapshotCellKey(target.row, target.col));
  if (cell && cell.formulaKind !== "none" && cell.formula !== undefined) {
    return rvString(`=${cell.formula}`);
  }
  return ERRORS.NA;
}

/**
 * INDEX reference-aware path.
 *
 * Standard INDEX takes `(array, row, col)` and returns a value or
 * sub-range. When the first argument is a multi-area UnionRef, INDEX
 * also accepts a fourth `area_num` argument to select which area to
 * index into — e.g. `INDEX((A1:B2, D4:E5), 1, 1, 2) = D4`.
 *
 * We intercept INDEX here (before the normal eager-dereference path)
 * because dereferencing a multi-area ReferenceValue flattens its
 * areas into a single stacked array, losing the per-area boundary
 * needed for `area_num`. For the common single-area case we return
 * `undefined` so the eager path runs and delegates to `fnINDEX`.
 */
function tryEvaluateINDEX(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue | undefined {
  if (args.length < 2 || args.length > 4) {
    return undefined; // Fall through — eager fnINDEX reports arity errors.
  }
  // Fast path: 2- and 3-arg INDEX has no area_num, so we can skip the
  // union-aware logic entirely for the common single-array case. Only
  // INDEX with an explicit area_num (4 args) OR a multi-area first
  // operand needs the reference-aware route.
  const first = evaluate(args[0], ctx, session);
  if (isError(first)) {
    // Errors from the source expression propagate regardless of arity.
    return first;
  }
  const isMultiArea = first.kind === RVKind.Reference && first.areas.length > 1;
  if (!isMultiArea && args.length < 4) {
    return undefined;
  }
  // Single-area reference with an explicit 4th arg still needs
  // area_num validation — Excel rejects `INDEX(A1:B2, 1, 1, 2)` as
  // #REF! since the source only has one area.
  if (first.kind !== RVKind.Reference || first.areas.length === 0) {
    // Non-reference first arg (array literal, number, etc.) — only
    // valid when args.length < 4. Let the eager path handle it.
    if (args.length < 4) {
      return undefined;
    }
    // With an explicit area_num on a non-reference, Excel returns #REF!.
    return ERRORS.REF;
  }
  const areas = first.areas;

  // Resolve `area_num` (1-based). Omitted / Blank → area 1. Truncate
  // toward zero and bounds-check against the union's cardinality.
  let areaNum = 1;
  if (args.length === 4) {
    const rawArea = dereferenceValue(evaluate(args[3], ctx, session), ctx, session);
    if (isError(rawArea)) {
      return rawArea;
    }
    const s = topLeft(rawArea);
    // Treat a blank / missing 4th argument as the default (area 1) —
    // matches Excel's tolerance for `INDEX(ref, r, c, )` and avoids the
    // surprise where a trailing comma would silently produce #REF!
    // (blank → toNumberRV = 0 → out-of-range).
    if (s.kind !== RVKind.Blank) {
      const aRV = toNumberRV(s);
      if (isError(aRV)) {
        return aRV;
      }
      areaNum = Math.trunc(aRV.value);
      if (areaNum < 1 || areaNum > areas.length) {
        return ERRORS.REF;
      }
    }
  }
  const area = areas[areaNum - 1];

  // Build a single-area ArrayValue for the selected region, then
  // delegate to `fnINDEX` using the row/col args. This keeps the
  // actual indexing logic in one place.
  const selectedArr = buildRangeArray(
    ctx,
    session,
    area.sheet,
    area.top,
    area.left,
    area.bottom,
    area.right
  );
  const indexArgs: RuntimeValue[] = [selectedArr];
  for (let i = 1; i < Math.min(args.length, 3); i++) {
    indexArgs.push(dereferenceValue(evaluate(args[i], ctx, session), ctx, session));
  }
  // Delegate to the registered INDEX implementation — keeps the actual
  // indexing logic (fractional truncation, single-col collapse, row=0
  // / col=0 semantics) in one place rather than reimplementing here.
  const indexFn = lookupFunction("INDEX");
  if (!indexFn) {
    return ERRORS.VALUE;
  }
  return indexFn.invoke(indexArgs, ctx.functionContext);
}

/**
 * ISREF(value) → TRUE if `value` is a reference; FALSE otherwise.
 *
 * Excel's rule is syntactic + runtime: any `CellRef` / `AreaRef` / 3-D ref /
 * `ColRangeRef` / `RowRangeRef` is a reference, and any call that *produces*
 * a `ReferenceValue` (INDIRECT, OFFSET) is also a reference. Errors in the
 * sub-expression are suppressed (Excel returns FALSE for `ISREF(INDIRECT("xx"))`
 * where INDIRECT returns `#REF!`).
 */
function evaluateISREF(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length !== 1) {
    return ERRORS.VALUE;
  }
  const arg = args[0];
  // Purely syntactic reference forms — always TRUE without evaluating.
  if (
    arg.kind === BoundExprKind.CellRef ||
    arg.kind === BoundExprKind.AreaRef ||
    arg.kind === BoundExprKind.ColRangeRef ||
    arg.kind === BoundExprKind.RowRangeRef ||
    arg.kind === BoundExprKind.Ref3D
  ) {
    return rvBoolean(true);
  }
  // Otherwise evaluate without dereferencing. INDIRECT/OFFSET yield a
  // ReferenceValue when successful; anything else (error, scalar, array)
  // is not a reference. Per Excel, ISREF suppresses errors to FALSE.
  const raw = evaluate(arg, ctx, session);
  return rvBoolean(raw.kind === RVKind.Reference);
}

// ============================================================================
// Reference-aware: CELL
// ============================================================================

/**
 * Resolve a CELL(..., ref) argument to a concrete {sheet,row,col} triple.
 * CELL always inspects the *top-left* cell of the referenced area.
 * Returns an error value if the argument cannot be resolved to a reference.
 */
function resolveCellRefArg(
  arg: BoundExpr,
  ctx: EvalContext,
  session: EvalSession
): { sheet: string; row: number; col: number } | ErrorValue {
  // Syntactic reference forms — extract top-left directly.
  if (arg.kind === BoundExprKind.CellRef) {
    return { sheet: arg.sheet, row: arg.row, col: arg.col };
  }
  if (arg.kind === BoundExprKind.AreaRef) {
    return { sheet: arg.sheet, row: arg.top, col: arg.left };
  }
  if (arg.kind === BoundExprKind.ColRangeRef) {
    const ws = ctx.snapshot.worksheetsByName.get(arg.sheet.toLowerCase());
    const top = ws?.dimensions?.top ?? 1;
    return { sheet: arg.sheet, row: top, col: arg.leftCol };
  }
  if (arg.kind === BoundExprKind.RowRangeRef) {
    const ws = ctx.snapshot.worksheetsByName.get(arg.sheet.toLowerCase());
    const left = ws?.dimensions?.left ?? 1;
    return { sheet: arg.sheet, row: arg.topRow, col: left };
  }
  if (arg.kind === BoundExprKind.Ref3D) {
    const first = arg.sheets[0];
    if (first === undefined) {
      return ERRORS.VALUE;
    }
    if (arg.inner.kind === BoundExprKind.CellRef) {
      return { sheet: first, row: arg.inner.row, col: arg.inner.col };
    }
    return { sheet: first, row: arg.inner.top, col: arg.inner.left };
  }
  // Fall back to evaluating — INDIRECT/OFFSET etc. may produce a ReferenceValue.
  const raw = evaluate(arg, ctx, session);
  if (raw.kind === RVKind.Error) {
    return raw;
  }
  if (raw.kind === RVKind.Reference && raw.areas.length > 0) {
    const area = raw.areas[0];
    return { sheet: area.sheet, row: area.top, col: area.left };
  }
  // Non-reference argument — Excel returns #VALUE! for CELL.
  return ERRORS.VALUE;
}

/** Convert a 1-based column number to its letter form (1 → "A", 27 → "AA"). */
function colNumberToLetter(colNum: number): string {
  let col = "";
  let cv = colNum;
  while (cv > 0) {
    cv--;
    col = String.fromCharCode(65 + (cv % 26)) + col;
    cv = Math.floor(cv / 26);
  }
  return col;
}

/**
 * CELL(info_type, [reference]) — limited, workbook-internal subset.
 *
 * Supported info types:
 * - `"address"`   → "$A$1"-style absolute reference (no sheet name)
 * - `"row"`       → 1-based row number of the top-left cell
 * - `"col"`       → 1-based column number of the top-left cell
 * - `"contents"`  → value of the top-left cell
 * - `"type"`      → "b" (blank), "l" (label/text), "v" (value/other)
 * - `"width"`     → 8 (column width is not tracked in the snapshot)
 * - `"filename"`  → "" (no file path available)
 *
 * Any other info type yields `#N/A`, matching Excel's treatment of
 * workbook-state-dependent info in contexts where the data is unavailable.
 *
 * When `reference` is omitted, the current formula's own cell is used —
 * if that cannot be determined, `#VALUE!` is returned.
 */
function evaluateCELL(
  args: readonly BoundExpr[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  if (args.length < 1 || args.length > 2) {
    return ERRORS.VALUE;
  }

  // Resolve info_type — this is a plain string expression, evaluate normally.
  const infoRV = dereferenceValue(evaluate(args[0], ctx, session), ctx, session);
  if (infoRV.kind === RVKind.Error) {
    return infoRV;
  }
  const infoScalar = topLeft(infoRV);
  if (infoScalar.kind === RVKind.Error) {
    return infoScalar;
  }
  if (infoScalar.kind !== RVKind.String) {
    return ERRORS.VALUE;
  }
  const info = infoScalar.value.toLowerCase();

  // Resolve reference: explicit arg, or the current formula cell.
  let target: { sheet: string; row: number; col: number };
  if (args.length === 2) {
    const resolved = resolveCellRefArg(args[1], ctx, session);
    if ("kind" in resolved) {
      return resolved;
    }
    target = resolved;
  } else {
    if (!ctx.currentAddress) {
      return ERRORS.VALUE;
    }
    target = {
      sheet: ctx.currentSheet,
      row: ctx.currentAddress.row,
      col: ctx.currentAddress.col
    };
  }

  switch (info) {
    case "address": {
      // Excel qualifies the address with the sheet name when the target
      // sheet differs from the formula-cell's own sheet (e.g.
      // `CELL("address", Sheet2!A1)` → `"Sheet2!$A$1"`). Same-sheet
      // refs stay unqualified. Without the qualifier, callers that
      // parse the result (INDIRECT(CELL("address", ref))) lose the
      // sheet context and misread remote cells.
      const addr = `$${colNumberToLetter(target.col)}$${target.row}`;
      const sameSheet = ctx.currentSheet.toLowerCase() === target.sheet.toLowerCase();
      if (sameSheet) {
        return rvString(addr);
      }
      // Quote sheet names that need it (spaces, special chars, starts
      // with digit). The same rule the tokenizer uses when parsing
      // quoted sheet refs on the way in.
      const needsQuote = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.sheet);
      const sheetPrefix = needsQuote ? `'${target.sheet.replace(/'/g, "''")}'` : target.sheet;
      return rvString(`${sheetPrefix}!${addr}`);
    }
    case "row":
      return rvNumber(target.row);
    case "col":
    case "column":
      return rvNumber(target.col);
    case "contents": {
      return getCellValue(target.sheet, target.row, target.col, ctx, session);
    }
    case "type": {
      const val = getCellValue(target.sheet, target.row, target.col, ctx, session);
      if (val.kind === RVKind.Blank) {
        return rvString("b");
      }
      if (val.kind === RVKind.String) {
        return rvString("l");
      }
      // Numbers, booleans, errors — all classified as "value".
      return rvString("v");
    }
    case "width":
      // Column width is not captured in the snapshot — return Excel's default.
      return rvNumber(8);
    case "filename":
      // No file path is available to the calculation engine.
      return rvString("");
    default:
      return ERRORS.NA;
  }
}

// ============================================================================
// Name Expression
// ============================================================================

function evaluateNameExpr(
  expr: BoundNameExpr,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  // Check local bindings first (LET variables)
  if (ctx.localBindings?.has(expr.upperName)) {
    return ctx.localBindings.get(expr.upperName)!;
  }

  // Try snapshot defined name resolution (for formula-based names).
  // Respects scope precedence: sheet-local > workbook-global.
  const dn = resolveDefinedNameFromSnapshot(ctx.snapshot.definedNames, expr.name, ctx.currentSheet);
  if (dn && dn.ranges.length > 0) {
    if (dn.ranges.length > 1) {
      return ERRORS.VALUE;
    }
    const rangeStr = dn.ranges[0];
    const parsed = parseDefinedNameRange(rangeStr);
    if (parsed) {
      // Validate against Excel's sheet coordinate limits before we pass
      // the values to `getCellValue` / `buildRangeArray`. An invalid
      // defined-name string (e.g. a range exceeding column XFD) should
      // surface as #REF! rather than silently reading BLANK cells.
      if (
        parsed.startRow < 1 ||
        parsed.endRow > 1_048_576 ||
        parsed.startCol < 1 ||
        parsed.endCol > 16_384
      ) {
        return ERRORS.REF;
      }
      if (parsed.startRow === parsed.endRow && parsed.startCol === parsed.endCol) {
        return getCellValue(parsed.sheet, parsed.startRow, parsed.startCol, ctx, session);
      }
      return buildRangeArray(
        ctx,
        session,
        parsed.sheet,
        Math.min(parsed.startRow, parsed.endRow),
        Math.min(parsed.startCol, parsed.endCol),
        Math.max(parsed.startRow, parsed.endRow),
        Math.max(parsed.startCol, parsed.endCol)
      );
    }
    // Formula expression — parse and evaluate via shared helper
    const nameResult = evaluateFormulaName(expr.upperName, rangeStr, ctx, session);
    return nameResult ?? ERRORS.NAME;
  }

  return ERRORS.NAME;
}

// ============================================================================
// Formula-based Defined Name Evaluation (shared helper)
// ============================================================================

/**
 * Evaluate a formula-based defined name expression, with caching.
 * Cache key includes name + sheet + cell address to handle position-dependent
 * formulas like ROW()/COLUMN().
 *
 * Returns the evaluated result, or undefined if parsing/evaluation fails.
 */
function evaluateFormulaName(
  upperName: string,
  formulaExpr: string,
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue | undefined {
  const addr = ctx.currentAddress;
  const cacheKey = addr
    ? `__NAME__${upperName}__${ctx.currentSheet}__${addr.row}:${addr.col}`
    : `__NAME__${upperName}__${ctx.currentSheet}`;
  const cached = session.nameCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  // Guard against recursion through a defined name that references itself.
  // Uses a dedicated prefix so it cannot collide with formula-cell guard keys.
  const guardKey = `__NAMEEVAL__${upperName}`;
  if (session.evaluating.has(guardKey)) {
    return ERRORS.CALC;
  }
  session.evaluating.add(guardKey);
  try {
    const tokens = tokenize(formulaExpr);
    const ast = parse(tokens);
    const bindCtx: BindingContext = { snapshot: ctx.snapshot, currentSheet: ctx.currentSheet };
    const bound = bind(ast, bindCtx);
    const result = evaluate(bound, ctx, session);
    session.nameCache.set(cacheKey, result);
    return result;
  } catch {
    return undefined;
  } finally {
    session.evaluating.delete(guardKey);
  }
}

// ============================================================================
// Lambda Expression
// ============================================================================

function evaluateLambdaExpr(expr: BoundLambda, ctx: EvalContext): RuntimeValue {
  return rvLambda(
    [...expr.params],
    expr.body,
    ctx.localBindings ? new Map(ctx.localBindings) : undefined
  );
}

// ============================================================================
// Union Reference `(A1:B2, D4:E5)` — yields a multi-area ReferenceValue
// ============================================================================

/**
 * Evaluate a reference union syntactically formed by `(area1, area2, …)`.
 *
 * Each member must resolve to a reference-producing value. The resulting
 * `ReferenceValue` carries every area in order so that `INDEX(union, r,
 * c, area_num)` can pick the right one. Any non-reference member
 * (scalar / array literal / error) short-circuits to `#VALUE!`.
 */
function evaluateUnionRef(
  expr: { areas: readonly BoundExpr[] },
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const areas: RefArea[] = [];
  for (const member of expr.areas) {
    const val = evaluate(member, ctx, session);
    if (isError(val)) {
      return val;
    }
    if (val.kind !== RVKind.Reference || val.areas.length === 0) {
      // Excel rejects non-reference members of a union outright —
      // `(A1, "text")` is `#VALUE!`, not a silent coerce to 1-cell.
      return ERRORS.VALUE;
    }
    for (const a of val.areas) {
      areas.push(a);
    }
  }
  if (areas.length === 0) {
    return ERRORS.VALUE;
  }
  return { kind: RVKind.Reference, areas };
}

// ============================================================================
// Structured Reference (runtime resolution)
// ============================================================================

function evaluateStructuredRef(
  expr: { tableName: string; columns: readonly string[]; specials: readonly string[] },
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const snapshot = ctx.snapshot;
  const addr = ctx.currentAddress;

  // Find the table
  const tableName = expr.tableName;
  let tableSheet: string | null = null;
  let tableInfo: {
    name: string;
    columns: readonly { name: string }[];
    topLeft: { row: number; col: number };
    dataRowCount: number;
    hasHeaderRow: boolean;
    hasTotalsRow: boolean;
  } | null = null;

  if (tableName === "") {
    // Implicit table — find the table containing the current cell
    if (!addr) {
      return ERRORS.REF;
    }
    // Sheet names are case-insensitive in Excel. Comparing the literal
    // `ws.name !== addr.sheet` would miss tables when the formula-cell's
    // address records its sheet in a different case than the workbook's
    // canonical name (possible after rename / import flows).
    const addrSheetLower = addr.sheet.toLowerCase();
    for (const ws of snapshot.worksheets) {
      if (ws.name.toLowerCase() !== addrSheetLower) {
        continue;
      }
      for (const t of ws.tables) {
        const g = buildTableGeometry(t);
        const width = t.columns.length;
        if (
          addr.row >= g.dataRowStart &&
          addr.row <= g.dataRowEnd &&
          addr.col >= t.topLeft.col &&
          addr.col < t.topLeft.col + width
        ) {
          tableInfo = t;
          tableSheet = ws.name;
          break;
        }
      }
      if (tableInfo) {
        break;
      }
    }
  } else {
    // Named table — use the pre-built index for O(1) lookup
    const resolved = snapshot.tablesByName.get(tableName.toLowerCase());
    if (resolved) {
      tableInfo = resolved.table;
      tableSheet = resolved.sheetName;
    }
  }

  if (!tableInfo || !tableSheet) {
    return ERRORS.REF;
  }

  const geo = buildTableGeometry(tableInfo);

  // Strict column resolution — unknown column names surface as #REF!
  const colRange = resolveStructuredRefColumns(expr.columns, tableInfo, "strict");
  if (colRange === "error") {
    return ERRORS.REF;
  }

  const rowRange = resolveStructuredRefRows(expr.specials, geo);

  let rowTop: number;
  let rowBottom: number;
  if (rowRange === "error") {
    return ERRORS.REF;
  } else if (rowRange === "thisRow") {
    if (addr) {
      rowTop = addr.row;
      rowBottom = addr.row;
    } else {
      return ERRORS.VALUE;
    }
  } else {
    rowTop = rowRange.rowTop;
    rowBottom = rowRange.rowBottom;
  }

  // Single cell — return as single-cell ReferenceValue
  if (rowTop === rowBottom && colRange.colLeft === colRange.colRight) {
    return rvCellRef(tableSheet, rowTop, colRange.colLeft);
  }

  // Range — return as area ReferenceValue
  return rvRef(tableSheet, rowTop, colRange.colLeft, rowBottom, colRange.colRight);
}

// ============================================================================
// Array Literal
// ============================================================================

function evaluateArrayLiteral(
  expr: { rows: readonly (readonly BoundExpr[])[] },
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue {
  const rows: ScalarValue[][] = [];
  for (const row of expr.rows) {
    const evalRow: ScalarValue[] = [];
    for (const elem of row) {
      evalRow.push(topLeft(evalDeref(elem, ctx, session)));
    }
    rows.push(evalRow);
  }
  return rvArray(rows);
}

// ============================================================================
// Implicit Intersection
// ============================================================================

export function implicitIntersect(val: RuntimeValue, ctx: EvalContext): RuntimeValue {
  if (isScalar(val)) {
    return val;
  }
  if (val.kind === RVKind.Lambda) {
    return val;
  }
  if (val.kind === RVKind.Reference) {
    // Implicit intersection on a reference: resolve using formula cell's row/col
    if (val.areas.length === 0) {
      return BLANK;
    }
    const area = val.areas[0];
    const isSingleCell = area.top === area.bottom && area.left === area.right;
    if (isSingleCell) {
      return val; // Single cell ref — keep as-is, will be dereferenced at use site
    }
    // Multi-cell reference — apply implicit intersection
    const addr = ctx.currentAddress;
    if (!addr) {
      return val;
    }
    // Single column — pick row
    if (area.left === area.right && addr.row >= area.top && addr.row <= area.bottom) {
      return rvCellRef(area.sheet, addr.row, area.left);
    }
    // Single row — pick column
    if (area.top === area.bottom && addr.col >= area.left && addr.col <= area.right) {
      return rvCellRef(area.sheet, area.top, addr.col);
    }
    // Both row and col
    if (
      addr.row >= area.top &&
      addr.row <= area.bottom &&
      addr.col >= area.left &&
      addr.col <= area.right
    ) {
      return rvCellRef(area.sheet, addr.row, addr.col);
    }
    return val;
  }
  if (val.kind !== RVKind.Array) {
    return val;
  }

  const arr = val;
  if (arr.height === 0 || arr.width === 0) {
    return BLANK;
  }
  if (arr.height === 1 && arr.width === 1) {
    return arr.rows[0][0];
  }

  const addr = ctx.currentAddress;
  if (!addr) {
    return arr.rows[0][0];
  }

  // Single row — pick column by offset
  if (arr.height === 1) {
    if (arr.originCol !== undefined) {
      const colIdx = addr.col - arr.originCol;
      if (colIdx >= 0 && colIdx < arr.width) {
        return arr.rows[0][colIdx];
      }
    }
    return arr.rows[0][0];
  }

  // Single column — pick row by offset
  if (arr.width === 1) {
    if (arr.originRow !== undefined) {
      const rowIdx = addr.row - arr.originRow;
      if (rowIdx >= 0 && rowIdx < arr.height) {
        return arr.rows[rowIdx][0];
      }
    }
    return arr.rows[0][0];
  }

  // Multi-row, multi-column
  if (arr.originRow !== undefined && arr.originCol !== undefined) {
    const rowIdx = addr.row - arr.originRow;
    const colIdx = addr.col - arr.originCol;
    if (rowIdx >= 0 && rowIdx < arr.height && colIdx >= 0 && colIdx < arr.width) {
      return arr.rows[rowIdx][colIdx];
    }
  }

  return arr.rows[0][0];
}

// ============================================================================
// R1C1 Reference Resolution
// ============================================================================

function resolveR1C1(refText: string, ctx: EvalContext, session: EvalSession): RuntimeValue {
  const upper = refText.toUpperCase().trim();
  // Check for range separator
  let depth = 0;
  let sepIdx = -1;
  for (let i = 0; i < upper.length; i++) {
    if (upper[i] === "[") {
      depth++;
    } else if (upper[i] === "]") {
      depth--;
    } else if (upper[i] === ":" && depth === 0) {
      sepIdx = i;
      break;
    }
  }

  if (sepIdx !== -1) {
    const s = parseR1C1Single(upper.slice(0, sepIdx), ctx);
    const e = parseR1C1Single(upper.slice(sepIdx + 1), ctx);
    if (!s || !e) {
      return ERRORS.REF;
    }
    const top = Math.min(s.row, e.row);
    const bottom = Math.max(s.row, e.row);
    const left = Math.min(s.col, e.col);
    const right = Math.max(s.col, e.col);
    return rvRef(ctx.currentSheet, top, left, bottom, right);
  }

  const ref = parseR1C1Single(upper, ctx);
  if (!ref || ref.row < 1 || ref.col < 1) {
    return ERRORS.REF;
  }
  return rvCellRef(ctx.currentSheet, ref.row, ref.col);
}

function parseR1C1Single(text: string, ctx: EvalContext): { row: number; col: number } | null {
  const re = /^R(\[(-?\d+)\]|(\d+))C(\[(-?\d+)\]|(\d+))$/;
  const m = re.exec(text);
  if (!m) {
    return null;
  }
  const addr = ctx.currentAddress;
  const row = m[2] !== undefined ? (addr?.row ?? 1) + parseInt(m[2], 10) : parseInt(m[3], 10);
  const col = m[5] !== undefined ? (addr?.col ?? 1) + parseInt(m[5], 10) : parseInt(m[6], 10);
  return { row, col };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Evaluate a BoundExpr and dereference any resulting ReferenceValue.
 * Use this whenever a concrete (non-reference) value is needed.
 */
function evalDeref(expr: BoundExpr, ctx: EvalContext, session: EvalSession): RuntimeValue {
  return dereferenceValue(evaluate(expr, ctx, session), ctx, session);
}

function resolveLambdaName(
  name: string,
  args: RuntimeValue[],
  ctx: EvalContext,
  session: EvalSession
): RuntimeValue | undefined {
  // Check local bindings
  if (ctx.localBindings?.has(name)) {
    const val = ctx.localBindings.get(name)!;
    if (isLambda(val)) {
      return invokeLambda(val, args, ctx, session);
    }
  }

  // Check defined names that resolve to lambdas (via snapshot, scope-aware)
  const dn = resolveDefinedNameFromSnapshot(ctx.snapshot.definedNames, name, ctx.currentSheet);
  if (dn && dn.ranges.length === 1) {
    const rangeStr = dn.ranges[0];
    const parsed = parseDefinedNameRange(rangeStr);
    if (parsed && parsed.startRow === parsed.endRow && parsed.startCol === parsed.endCol) {
      const cellVal = getCellValue(parsed.sheet, parsed.startRow, parsed.startCol, ctx, session);
      if (isLambda(cellVal)) {
        return invokeLambda(cellVal, args, ctx, session);
      }
    }
    // Formula-based name — evaluate via shared helper
    if (!parsed) {
      const nameVal = evaluateFormulaName(name.toUpperCase(), rangeStr, ctx, session);
      if (nameVal !== undefined && isLambda(nameVal)) {
        return invokeLambda(nameVal, args, ctx, session);
      }
    }
  }

  return undefined;
}
