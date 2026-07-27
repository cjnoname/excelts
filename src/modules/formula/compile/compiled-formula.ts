/**
 * Compiled Formula — The output of the full compilation pipeline.
 *
 * A `CompiledFormula` packages together:
 * - The original `FormulaInstance` metadata
 * - The bound expression tree (from the binder)
 * - Static dependency information
 * - Metadata flags (volatile, dynamic refs, etc.)
 *
 * ## Static Dependency Extraction
 *
 * Dependencies are extracted from the `BoundExpr` tree. Since names and
 * structured refs are already resolved by the binder, the dependency
 * extraction is a simple tree walk that collects `BoundCellRef` and
 * `BoundAreaRef` nodes.
 *
 * Runtime-dependent references (INDIRECT, OFFSET) cannot be captured
 * statically — the `hasDynamicRefs` flag marks formulas that may have
 * additional runtime dependencies. Those functions re-parse their dynamic
 * arguments at evaluation time using their own parser invocation (the raw
 * AST is not retained on the CompiledFormula).
 */

import type { BoundExpr } from "@formula/compile/bound-ast";
import { BoundExprKind } from "@formula/compile/bound-ast";
import {
  resolveStructuredRefRows,
  buildTableGeometry,
  resolveStructuredRefColumns
} from "@formula/compile/structured-ref-utils";
import type { FormulaInstance } from "@formula/integration/formula-instance";
import type { ResolvedTable, WorkbookSnapshot } from "@formula/integration/workbook-snapshot";
import type { AstNode } from "@formula/syntax/ast";
import { NodeType } from "@formula/syntax/ast";
import { stripFunctionPrefix } from "@formula/syntax/token-types";

// ============================================================================
// CompiledFormula
// ============================================================================

/**
 * The complete compiled representation of a formula.
 */
export interface CompiledFormula {
  /** The original formula instance metadata. */
  readonly instance: FormulaInstance;
  /** The bound expression tree (the evaluator executes this). */
  readonly bound: BoundExpr;
  /** Statically extractable dependencies. */
  readonly staticDeps: StaticDependencySet;
  /** Whether this formula uses volatile functions (RAND, NOW, etc.). */
  readonly isVolatile: boolean;
  /** Whether this formula contains INDIRECT/OFFSET (runtime-dependent refs). */
  readonly hasDynamicRefs: boolean;
  /** Whether this formula contains any lambda expressions. */
  readonly containsLambda: boolean;
  /**
   * Whether the top-level function is a known dynamic array function
   * (FILTER, SORT, UNIQUE, SEQUENCE, etc.). Determined once at compile
   * time — consumers should use this flag instead of re-checking the AST
   * or bound expression.
   */
  readonly isDynamicArrayFunction: boolean;
  /**
   * Whether the top-level function is SUBTOTAL or AGGREGATE. When an
   * outer SUBTOTAL/AGGREGATE range aggregates a cell whose formula is
   * itself a SUBTOTAL/AGGREGATE call, that cell must be skipped so its
   * result is not double-counted. This flag lets `buildRangeArray`
   * mark those cells with the array's `subtotalMask`.
   */
  readonly isSubtotalOutput: boolean;
}

// ============================================================================
// Static Dependency Set
// ============================================================================

/**
 * A single cell dependency.
 */
export interface CellDep {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
}

/**
 * A rectangular area dependency.
 */
export interface AreaDep {
  readonly sheet: string;
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/**
 * All statically extractable dependencies of a formula.
 */
export interface StaticDependencySet {
  /** Individual cell references. */
  readonly cells: readonly CellDep[];
  /** Range references. */
  readonly areas: readonly AreaDep[];
}

// ============================================================================
// Dependency Extraction
// ============================================================================

/**
 * Callback to resolve a defined name into its parsed/bound expression
 * for dependency extraction. Returns the bound expression if the name
 * resolves to a formula, or undefined if it can't be resolved.
 */
export type NameDepResolver = (name: string) =>
  | {
      deps: StaticDependencySet;
      hasDynamicRefs: boolean;
      /**
       * Whether the defined-name's formula (transitively) uses a volatile
       * function like NOW/RAND/OFFSET/INDIRECT. The resolver must propagate
       * this so the OUTER formula inherits volatility — otherwise the
       * session result cache would hold stale values across calc runs.
       */
      isVolatile: boolean;
    }
  | undefined;

/**
 * Extract static dependencies from a bound expression tree.
 *
 * @param expr - The bound expression tree to analyze
 * @param snapshot - Optional snapshot for resolving structured references
 * @param nameResolver - Optional resolver for formula-based defined name dependencies
 */
export function extractStaticDeps(
  expr: BoundExpr,
  snapshot?: WorkbookSnapshot,
  nameResolver?: NameDepResolver
): StaticDependencySet {
  const cells: CellDep[] = [];
  const areas: AreaDep[] = [];
  walkDeps(expr, cells, areas, snapshot?.tablesByName, nameResolver, new Set());
  // Deduplicate — a formula like `=A1+A1+A1` would otherwise add three
  // copies of A1 to the dep list, bloating both the dependency graph's
  // intermediate storage and the `expandRefsToKeys` pass downstream. We
  // use positional keys that mirror the Set<string> dedup logic that the
  // graph builder already applies, so we can pay the cost here once
  // instead of in every consumer. (R6 architectural note #5)
  return { cells: dedupeCells(cells), areas: dedupeAreas(areas) };
}

function dedupeCells(cells: CellDep[]): CellDep[] {
  if (cells.length < 2) {
    return cells;
  }
  const seen = new Set<string>();
  const out: CellDep[] = [];
  for (const c of cells) {
    const key = `${c.sheet}\u0000${c.row}\u0001${c.col}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(c);
  }
  return out;
}

function dedupeAreas(areas: AreaDep[]): AreaDep[] {
  if (areas.length < 2) {
    return areas;
  }
  const seen = new Set<string>();
  const out: AreaDep[] = [];
  for (const a of areas) {
    const key = `${a.sheet}\u0000${a.top}\u0001${a.left}\u0002${a.bottom}\u0003${a.right}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(a);
  }
  return out;
}

function walkDeps(
  expr: BoundExpr,
  cells: CellDep[],
  areas: AreaDep[],
  tablesByName?: ReadonlyMap<string, ResolvedTable>,
  nameResolver?: NameDepResolver,
  visitedNames?: Set<string>
): void {
  switch (expr.kind) {
    case BoundExprKind.CellRef:
      cells.push({ sheet: expr.sheet, row: expr.row, col: expr.col });
      break;

    case BoundExprKind.AreaRef:
      areas.push({
        sheet: expr.sheet,
        top: expr.top,
        left: expr.left,
        bottom: expr.bottom,
        right: expr.right
      });
      break;

    case BoundExprKind.ColRangeRef:
      areas.push({
        sheet: expr.sheet,
        top: 1,
        left: expr.leftCol,
        bottom: 1_048_576,
        right: expr.rightCol
      });
      break;

    case BoundExprKind.RowRangeRef:
      areas.push({
        sheet: expr.sheet,
        top: expr.topRow,
        left: 1,
        bottom: expr.bottomRow,
        right: 16_384
      });
      break;

    case BoundExprKind.Ref3D:
      for (const sheet of expr.sheets) {
        if (expr.inner.kind === BoundExprKind.CellRef) {
          cells.push({ sheet, row: expr.inner.row, col: expr.inner.col });
        } else {
          areas.push({
            sheet,
            top: expr.inner.top,
            left: expr.inner.left,
            bottom: expr.inner.bottom,
            right: expr.inner.right
          });
        }
      }
      break;

    case BoundExprKind.BinaryOp:
      walkDeps(expr.left, cells, areas, tablesByName, nameResolver, visitedNames);
      walkDeps(expr.right, cells, areas, tablesByName, nameResolver, visitedNames);
      break;

    case BoundExprKind.UnaryOp:
      walkDeps(expr.operand, cells, areas, tablesByName, nameResolver, visitedNames);
      break;

    case BoundExprKind.Percent:
      walkDeps(expr.operand, cells, areas, tablesByName, nameResolver, visitedNames);
      break;

    case BoundExprKind.Call:
      for (const arg of expr.args) {
        walkDeps(arg, cells, areas, tablesByName, nameResolver, visitedNames);
      }
      break;

    case BoundExprKind.SpecialCall:
      for (const arg of expr.args) {
        walkDeps(arg, cells, areas, tablesByName, nameResolver, visitedNames);
      }
      break;

    case BoundExprKind.Array:
      for (const row of expr.rows) {
        for (const elem of row) {
          walkDeps(elem, cells, areas, tablesByName, nameResolver, visitedNames);
        }
      }
      break;

    case BoundExprKind.Lambda:
      walkDeps(expr.body, cells, areas, tablesByName, nameResolver, visitedNames);
      break;

    case BoundExprKind.StructuredRef:
      // Try to resolve structured reference to static deps using the table index.
      // Only possible when we have the table name and the table exists in the snapshot.
      if (tablesByName && expr.tableName) {
        const resolved = tablesByName.get(expr.tableName.toLowerCase());
        if (resolved) {
          const t = resolved.table;
          const geo = buildTableGeometry(t);

          // Permissive column resolution — static-deps is conservative, so
          // unknown column names fall back to the full table width rather
          // than being treated as errors.
          const colRange = resolveStructuredRefColumns(expr.columns, t, "permissive");
          if (colRange === "error") {
            // Not reachable in permissive mode, but guard for exhaustiveness.
            break;
          }

          // #This Row can't be resolved statically; we still record the data
          // range as a conservative dependency bound.
          const rowRange = resolveStructuredRefRows(expr.specials, geo);
          let rowTop = geo.dataRowStart;
          let rowBottom = geo.dataRowEnd;
          if (rowRange !== "thisRow" && rowRange !== "error") {
            rowTop = rowRange.rowTop;
            rowBottom = rowRange.rowBottom;
          }

          areas.push({
            sheet: resolved.sheetName,
            top: rowTop,
            left: colRange.colLeft,
            bottom: rowBottom,
            right: colRange.colRight
          });
          break;
        }
      }
      // Cannot resolve — no static deps (will be handled at runtime)
      break;

    case BoundExprKind.Literal:
      // No static dependencies
      break;

    case BoundExprKind.NameExpr:
      // Try to resolve the defined name and extract its dependencies.
      // Guard against infinite recursion with visitedNames.
      if (nameResolver && visitedNames && !visitedNames.has(expr.upperName)) {
        visitedNames.add(expr.upperName);
        const resolved = nameResolver(expr.upperName);
        if (resolved) {
          for (const c of resolved.deps.cells) {
            cells.push(c);
          }
          for (const a of resolved.deps.areas) {
            areas.push(a);
          }
        }
      }
      break;

    case BoundExprKind.UnionRef:
      // Each member of a `(a1, a2, ...)` union contributes its own
      // dependencies — downstream reads target cells in every area.
      for (const area of expr.areas) {
        walkDeps(area, cells, areas, tablesByName, nameResolver, visitedNames);
      }
      break;
  }
}

// ============================================================================
// Volatility / Dynamic Ref / Dynamic Array Detection
// ============================================================================

// Excel's volatile-function list: any formula containing one of these
// must be re-evaluated on every calc pass, because the result can change
// without any explicit input change. INDIRECT / OFFSET are additionally
// flagged as "dynamic ref" (their dependency set isn't known at compile
// time), but they're also volatile in the usual sense — the target
// cell's value may change even when the INDIRECT string itself is
// constant. INFO and CELL with the "row"/"col" info-type also qualify
// but those require per-invocation arg inspection; the coarse opt-in
// below is intentionally conservative.
const VOLATILE_FUNCTIONS = new Set([
  "RAND",
  "RANDBETWEEN",
  "RANDARRAY",
  "NOW",
  "TODAY",
  "INDIRECT",
  "OFFSET",
  "INFO",
  "CELL"
]);

const DYNAMIC_REF_FUNCTIONS = new Set(["INDIRECT", "OFFSET"]);

/**
 * Function names that naturally produce arrays and should trigger spill
 * behavior even when `isDynamicArray` is not explicitly set in the XLSX model.
 */
const DYNAMIC_ARRAY_FUNCTION_NAMES = new Set([
  "FILTER",
  "SORT",
  "UNIQUE",
  "SORTBY",
  "SEQUENCE",
  "RANDARRAY",
  "TOCOL",
  "TOROW",
  "CHOOSEROWS",
  "CHOOSECOLS",
  "VSTACK",
  "HSTACK",
  "WRAPROWS",
  "WRAPCOLS",
  "EXPAND",
  "TAKE",
  "DROP"
]);

/**
 * Check if the formula's top-level expression is a known dynamic array
 * function. Checks both the raw AST (for prefixed names like `_XLFN.FILTER`)
 * and the bound expression (for the canonical uppercase name).
 */
export function detectDynamicArrayFunction(ast: AstNode, bound: BoundExpr): boolean {
  // Check AST level (handles _XLFN. prefixed names)
  if (ast.type === NodeType.FunctionCall) {
    const upper = ast.name.toUpperCase();
    if (DYNAMIC_ARRAY_FUNCTION_NAMES.has(upper)) {
      return true;
    }
    const canonical = stripFunctionPrefix(upper);
    if (DYNAMIC_ARRAY_FUNCTION_NAMES.has(canonical)) {
      return true;
    }
  }
  // Check bound expression level. Strip `_XLFN.` prefix here too —
  // `boundCall` preserves the prefix on the bound name, so without the
  // strip a synthesised bound call (e.g. from INDIRECT re-parse) would
  // miss detection.
  if (bound.kind === BoundExprKind.Call) {
    const canonical = stripFunctionPrefix(bound.name);
    if (DYNAMIC_ARRAY_FUNCTION_NAMES.has(canonical)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the formula's top-level expression is SUBTOTAL or AGGREGATE.
 *
 * Excel's SUBTOTAL/AGGREGATE functions deliberately skip any cell whose
 * own source formula is itself a SUBTOTAL or AGGREGATE call — this is
 * what makes the classic "totals row inside a filtered range" case not
 * double-count. `buildRangeArray` reads this flag off the compiled
 * formula to decide whether to set `subtotalMask[r][c]`.
 */
export function detectSubtotalOutput(ast: AstNode, bound: BoundExpr): boolean {
  if (ast.type === NodeType.FunctionCall) {
    const upper = ast.name.toUpperCase();
    const canonical = stripFunctionPrefix(upper);
    if (canonical === "SUBTOTAL" || canonical === "AGGREGATE") {
      return true;
    }
  }
  if (bound.kind === BoundExprKind.Call) {
    // Strip `_XLFN.` / `_XLFN._XLWS.` prefixes before matching — otherwise
    // `_XLFN.AGGREGATE(...)` silently wouldn't be marked as a subtotal
    // output, so an outer SUBTOTAL / AGGREGATE over its cell would
    // double-count the aggregated value.
    const canonical = stripFunctionPrefix(bound.name);
    if (canonical === "SUBTOTAL" || canonical === "AGGREGATE") {
      return true;
    }
  }
  return false;
}

/**
 * Analyze a bound expression for volatile functions and dynamic references.
 *
 * @param nameResolver - Optional; if a NameExpr resolves to a formula-based
 *   defined name containing INDIRECT/OFFSET, the outer formula inherits
 *   `hasDynamicRefs = true`.
 */
export function analyzeExpr(
  expr: BoundExpr,
  nameResolver?: NameDepResolver,
  additionalVolatileFunctions?: ReadonlySet<string>
): {
  isVolatile: boolean;
  hasDynamicRefs: boolean;
  containsLambda: boolean;
} {
  let isVolatile = false;
  let hasDynamicRefs = false;
  let containsLambda = false;

  walkAnalyze(expr);

  return { isVolatile, hasDynamicRefs, containsLambda };

  function walkAnalyze(e: BoundExpr): void {
    switch (e.kind) {
      case BoundExprKind.Call: {
        // `boundCall` stores the function name uppercased but preserves
        // any `_XLFN.` / `_XLFN._XLWS.` prefix the source text contained.
        // Strip the prefix before VOLATILE_FUNCTIONS lookup so e.g.
        // `_XLFN.RANDARRAY()` (an XLFN-prefixed volatile) correctly
        // invalidates the session cache across calc cycles.
        const canonical = stripFunctionPrefix(e.name);
        if (VOLATILE_FUNCTIONS.has(canonical) || additionalVolatileFunctions?.has(canonical)) {
          isVolatile = true;
        }
        for (const arg of e.args) {
          walkAnalyze(arg);
        }
        break;
      }

      case BoundExprKind.SpecialCall:
        // Special-call names are already stripped of any `_XLFN.` prefix
        // by `canonicalSpecialForm` in the binder, so no re-strip here.
        if (DYNAMIC_REF_FUNCTIONS.has(e.name)) {
          hasDynamicRefs = true;
        }
        if (VOLATILE_FUNCTIONS.has(e.name) || additionalVolatileFunctions?.has(e.name)) {
          isVolatile = true;
        }
        for (const arg of e.args) {
          walkAnalyze(arg);
        }
        break;

      case BoundExprKind.Lambda:
        containsLambda = true;
        walkAnalyze(e.body);
        break;

      case BoundExprKind.NameExpr:
        // If the name resolves to a formula that contains dynamic refs
        // or volatile functions, the outer formula inherits both flags.
        // Forgetting to propagate `isVolatile` meant that a defined name
        // pointing at `NOW()` stayed cached between calculations — the
        // bug drove R5-P0-5.
        if (nameResolver) {
          const resolved = nameResolver(e.upperName);
          if (resolved?.hasDynamicRefs) {
            hasDynamicRefs = true;
          }
          if (resolved?.isVolatile) {
            isVolatile = true;
          }
        }
        break;

      case BoundExprKind.BinaryOp:
        walkAnalyze(e.left);
        walkAnalyze(e.right);
        break;

      case BoundExprKind.UnaryOp:
        walkAnalyze(e.operand);
        break;

      case BoundExprKind.Percent:
        walkAnalyze(e.operand);
        break;

      case BoundExprKind.Array:
        for (const row of e.rows) {
          for (const elem of row) {
            walkAnalyze(elem);
          }
        }
        break;

      case BoundExprKind.UnionRef:
        for (const area of e.areas) {
          walkAnalyze(area);
        }
        break;

      default:
        // Literal, CellRef, AreaRef, etc. — no children to analyze
        break;
    }
  }
}
