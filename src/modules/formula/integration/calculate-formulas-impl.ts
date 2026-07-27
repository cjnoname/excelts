/**
 * Formula Calculation Implementation
 *
 * The pipeline that implements the snapshot → compile → evaluate →
 * materialize → apply architecture.
 *
 * ## Pipeline Steps
 *
 * 1. **Snapshot** — `buildWorkbookSnapshot()` creates an immutable snapshot
 *    of the entire workbook.
 * 2. **Normalize** — `collectFormulaInstances()` extracts all formula cells
 *    into uniform `FormulaInstance` objects.
 * 3. **Parse** — Each formula's source text is tokenized and parsed into an AST.
 * 4. **Compile** — The binder transforms each AST into a `BoundExpr` tree,
 *    resolving names, structured references, and sheet references.
 * 5. **Dependency Analysis** — Static dependencies are extracted from bound
 *    expressions and a topological evaluation order is computed.
 * 6. **Evaluate** — Formulas are evaluated in dependency order using the
 *    evaluator which operates on `BoundExpr` and produces `RuntimeValue`.
 * 7. **Materialize** — Evaluation results are converted into a `WritebackPlan`.
 * 8. **Apply** — The plan is applied to the live workbook.
 */

import { parseRefRange } from "@formula/compile/address-utils";
import type { BindingContext } from "@formula/compile/binder";
import { bind } from "@formula/compile/binder";
import type { NameDepResolver, CompiledFormula } from "@formula/compile/compiled-formula";
import {
  extractStaticDeps,
  analyzeExpr,
  detectDynamicArrayFunction,
  detectSubtotalOutput
} from "@formula/compile/compiled-formula";
import type { DependencyGraph } from "@formula/compile/dependency-analysis";
import {
  buildDependencyGraphFromDeps,
  topologicalSort,
  mergeDynamicDeps
} from "@formula/compile/dependency-analysis";
import type { FormulaFunction } from "@formula/integration/calculate-formulas";
import { PARSE_FAILED } from "@formula/integration/calculation-state";
import type { CachedAst, FormulaCalculationState } from "@formula/integration/calculation-state";
import { collectFormulaInstances } from "@formula/integration/formula-instance";
import type { FormulaInstance } from "@formula/integration/formula-instance";
import type { WorkbookSnapshot } from "@formula/integration/workbook-snapshot";
import {
  formulaCellKey,
  resolveDefinedName,
  snapshotCellKey,
  spillCellKeyFromId
} from "@formula/integration/workbook-snapshot";
import {
  buildWritebackPlan,
  isGhostUnmodified,
  shouldPreserveCompileFailure
} from "@formula/materialize/build-writeback-plan";
import type { WritebackPlan } from "@formula/materialize/writeback-plan";
import type { EvalContext } from "@formula/runtime/evaluator";
import { EvalSession, evaluateFormula, evaluateFormulaRaw } from "@formula/runtime/evaluator";
import type { FunctionDescriptor } from "@formula/runtime/function-registry";
import type { RuntimeValue } from "@formula/runtime/values";
import {
  RVKind,
  rvNumber,
  BLANK,
  ERRORS,
  fromSnapshotValue,
  isScalar,
  scalarEquals,
  topLeft
} from "@formula/runtime/values";
import type { AstNode } from "@formula/syntax/ast";
import { parse } from "@formula/syntax/parser";
import { tokenize } from "@formula/syntax/tokenizer";

// ============================================================================
// AST Cache
// ============================================================================

/**
 * Persistent AST cache: formula text → parsed AstNode.
 * Since AST is a pure function of formula text, this is safe to cache
 * across calculation cycles. Keyed by workbook to allow GC.
 *
 * The inner `Map` is bounded by `AST_CACHE_MAX_ENTRIES` using simple LRU
 * eviction (least-recently-used key removed when full). This prevents a
 * long-lived workbook that churns through unique formula texts — e.g.
 * templated generation that embeds timestamps — from growing the cache
 * without bound. See `parseFormulaText` for the hit-path bookkeeping.
 */
const AST_CACHE_MAX_ENTRIES = 10000;
// ============================================================================
// Main: Formula Calculation Implementation
// ============================================================================

/**
 * Recalculate all formula cells using the new pipeline.
 *
 * This implements the full snapshot → compile → evaluate → materialize → apply
 * architecture. The workbook is mutated only at the final apply step.
 */
export function calculateFormulasImpl(
  snapshot: WorkbookSnapshot,
  state: FormulaCalculationState,
  hostFunctions?: ReadonlyMap<string, FormulaFunction>
): WritebackPlan {
  // ── Step 2: Normalize ──
  const instances = collectFormulaInstances(snapshot);
  if (instances.length === 0) {
    // Clean up stale spills even when there are no formulas
    return buildStaleSpillCleanupPlan(state, snapshot);
  }

  // ── Step 3: Parse ──
  // Use persistent AST cache — formula text → AST is a pure function,
  // so parsed ASTs can be safely reused across calculation cycles.
  const astCache = state.astCache;
  for (const inst of instances) {
    parseFormulaText(inst.sourceText, astCache);
  }

  // ── Step 4: Compile (Bind) ──
  const compiledMap = new Map<string, CompiledFormula>();
  const volatileHostFunctions = new Set<string>();
  for (const [name, descriptor] of hostFunctions ?? []) {
    if (descriptor.volatile) {
      volatileHostFunctions.add(name.toUpperCase());
    }
  }
  const failedInstances: FormulaInstance[] = [];
  const results = new Map<string, RuntimeValue>();
  for (const inst of instances) {
    const compiled = compileFormula(inst, astCache, snapshot, volatileHostFunctions);
    const key = formulaCellKey(inst.sheetName, inst.row, inst.col);
    if ("reason" in compiled) {
      failedInstances.push(inst);
      // Parse or bind failure — produce an explicit error result.
      // #CALC! for engine-level failures, #NAME? for parse errors that
      // may indicate an unsupported construct.
      results.set(key, compiled.reason === "parse" ? ERRORS.NAME : ERRORS.CALC);
    } else {
      compiledMap.set(key, compiled);
    }
  }

  // ── Step 5: Dependency Analysis + Topological Sort ──
  // Build a producer map so that formulas depending on cells that are:
  //   (a) CSE target range slaves, or
  //   (b) previous-cycle spill ghost cells
  // correctly get ordered after their producing formula.
  const producerMap = new Map<string, string>();

  // CSE: distribute targetRef across all slave cells → master key
  for (const [masterKey, cf] of compiledMap) {
    const inst = cf.instance;
    if (inst.kind === "cse" && inst.targetRef) {
      const rng = parseRefRange(inst.targetRef);
      if (rng) {
        for (let r = rng.top; r <= rng.bottom; r++) {
          for (let c = rng.left; c <= rng.right; c++) {
            const slaveKey = formulaCellKey(inst.sheetName, r, c);
            if (slaveKey !== masterKey) {
              producerMap.set(slaveKey, masterKey);
            }
          }
        }
      }
    }
  }

  // Dynamic array spill: use previous-cycle spill regions as static hint
  // for dependency ordering. The actual spill may differ this cycle — if the
  // master formula is no longer a dynamic-array producer, skip it so stale
  // ghost cells don't introduce false edges.
  const persistentSpills = state.spillRegions;
  for (const [, region] of persistentSpills) {
    const ws = snapshot.worksheetsById.get(region.worksheetId);
    if (!ws) {
      continue;
    }
    const masterKey = formulaCellKey(ws.name, region.sourceRow, region.sourceCol);
    const masterCf = compiledMap.get(masterKey);
    if (!masterCf) {
      continue; // source formula no longer exists
    }
    // Only remap if the master is still a dynamic-array formula this cycle
    const isStillDynamic = masterCf.instance.isDynamicArray || masterCf.isDynamicArrayFunction;
    if (!isStillDynamic) {
      continue;
    }
    for (let r = 0; r < region.rows; r++) {
      for (let c = 0; c < region.cols; c++) {
        if (r === 0 && c === 0) {
          continue; // skip source
        }
        const ghostKey = formulaCellKey(ws.name, region.sourceRow + r, region.sourceCol + c);
        if (!producerMap.has(ghostKey)) {
          producerMap.set(ghostKey, masterKey);
        }
      }
    }
  }

  // Build the dependency graph with producer remapping.
  let graph = buildDependencyGraphFromDeps(compiledMap, producerMap);
  let evalOrder = topologicalSort(graph);

  // ── Step 6: Evaluate ──
  const session = new EvalSession();
  // Previous ghosts that still match the engine-owned value are logically
  // absent during this pass. A new spill may overwrite them; if its footprint
  // shrinks, downstream formulas must see blank rather than stale snapshot data.
  for (const region of state.spillRegions.values()) {
    const ws = snapshot.worksheetsById.get(region.worksheetId);
    if (!ws) {
      continue;
    }
    for (let r = 0; r < region.rows; r++) {
      for (let c = 0; c < region.cols; c++) {
        if (r === 0 && c === 0) {
          continue;
        }
        const row = region.sourceRow + r;
        const col = region.sourceCol + c;
        const cell = ws.cells.get(snapshotCellKey(row, col));
        const sourceKey = spillCellKeyFromId(
          region.worksheetId,
          region.sourceRow,
          region.sourceCol
        );
        if (isGhostUnmodified(cell, sourceKey)) {
          session.staleGhosts.add(formulaCellKey(ws.name, row, col));
        }
      }
    }
  }
  // Compile failures are still formula producers. Seed the evaluator cache so
  // dependents observe exactly what this cell will end up holding: the
  // preserved cached result when the plan keeps it, otherwise the error.
  for (const inst of failedInstances) {
    const key = formulaCellKey(inst.sheetName, inst.row, inst.col);
    const value = results.get(key);
    if (value === undefined) {
      continue;
    }
    const cached = snapshot.worksheetsByName
      .get(inst.sheetName.toLowerCase())
      ?.cells.get(snapshotCellKey(inst.row, inst.col))?.cachedResult;
    const seeded =
      value.kind === RVKind.Error &&
      shouldPreserveCompileFailure(value, inst, snapshot) &&
      cached !== undefined
        ? fromSnapshotValue(cached)
        : value;
    session.resultCache.set(key, { scalar: seeded, raw: seeded });
  }
  // Convert user-registered functions from the host capture
  // into the evaluator's typed `FunctionDescriptor` shape. We take a
  // snapshot up front so later mutations to the workbook's map during
  // evaluation can't observe a half-built state.
  let userFunctions: ReadonlyMap<string, FunctionDescriptor> | undefined;
  if (hostFunctions && hostFunctions.size > 0) {
    const adapted = new Map<string, FunctionDescriptor>();
    for (const [name, desc] of hostFunctions) {
      const upperName = name.toUpperCase();
      adapted.set(upperName, {
        name: upperName,
        minArity: desc.minArity,
        maxArity: desc.maxArity,
        volatile: desc.volatile,
        invoke: desc.invoke
      });
    }
    userFunctions = adapted;
  }
  const date1904 = snapshot.properties.date1904 ?? false;
  const ctx: EvalContext = {
    snapshot,
    compiledFormulas: compiledMap,
    currentSheet: snapshot.worksheets[0]?.name ?? "",
    userFunctions,
    date1904,
    functionContext: { date1904 }
  };

  // Evaluate in topological order
  evaluateInOrder(evalOrder, compiledMap, results, ctx, session);

  ({ graph, evalOrder } = stabilizeDependencyGraph(
    graph,
    evalOrder,
    producerMap,
    compiledMap,
    results,
    ctx,
    session
  ));

  // ── Iterative Calculation for Circular References ──
  const iterateEnabled = snapshot.calcProperties.iterate === true;
  if (iterateEnabled && graph.circularKeys.size > 0) {
    const maxGraphPasses = compiledMap.size + 1;
    for (let pass = 0; pass < maxGraphPasses; pass++) {
      runIterativeCalc(evalOrder, graph, compiledMap, results, ctx, session, snapshot);
      const stabilized = stabilizeDependencyGraph(
        graph,
        evalOrder,
        producerMap,
        compiledMap,
        results,
        ctx,
        session
      );
      graph = stabilized.graph;
      evalOrder = stabilized.evalOrder;
      if (!stabilized.changed) {
        break;
      }
    }
    reevaluateDownstreamOfCircular(evalOrder, graph, compiledMap, results, ctx, session);
  }

  // ── Step 7: Materialize (Build Writeback Plan) ──
  const previousSpills = state.spillRegions;
  const previousGhosts = state.ghostSnapshots;

  const plan = buildWritebackPlan(
    snapshot,
    [...compiledMap.values()],
    failedInstances,
    results,
    previousSpills,
    previousGhosts
  );

  return plan;
}

function syncProducerFootprints(
  producerMap: Map<string, string>,
  compiledMap: ReadonlyMap<string, CompiledFormula>,
  results: ReadonlyMap<string, RuntimeValue>
): boolean {
  const before = new Map(producerMap);
  const dynamicMasters = new Set<string>();
  for (const [key, compiled] of compiledMap) {
    if (compiled.instance.isDynamicArray || compiled.isDynamicArrayFunction) {
      dynamicMasters.add(key);
    }
  }
  for (const [key, producer] of producerMap) {
    if (dynamicMasters.has(producer)) {
      producerMap.delete(key);
    }
  }
  for (const [masterKey, result] of results) {
    const compiled = compiledMap.get(masterKey);
    if (
      !compiled ||
      result.kind !== RVKind.Array ||
      (!compiled.instance.isDynamicArray && !compiled.isDynamicArrayFunction)
    ) {
      continue;
    }
    const inst = compiled.instance;
    for (let r = 0; r < result.height; r++) {
      for (let c = 0; c < result.width; c++) {
        if (r === 0 && c === 0) {
          continue;
        }
        const ghostKey = formulaCellKey(inst.sheetName, inst.row + r, inst.col + c);
        if (producerMap.get(ghostKey) !== masterKey) {
          producerMap.set(ghostKey, masterKey);
        }
      }
    }
  }
  return !mapsEqual(before, producerMap);
}

function stabilizeDependencyGraph(
  initialGraph: DependencyGraph,
  initialOrder: readonly string[],
  producerMap: Map<string, string>,
  compiledMap: Map<string, CompiledFormula>,
  results: Map<string, RuntimeValue>,
  ctx: EvalContext,
  session: EvalSession
): { graph: DependencyGraph; evalOrder: string[]; changed: boolean } {
  let graph = initialGraph;
  let evalOrder = [...initialOrder];
  let changedAny = false;
  const maxPasses = compiledMap.size + 1;

  for (let pass = 0; pass < maxPasses; pass++) {
    const footprintChanged = syncProducerFootprints(producerMap, compiledMap, results);
    const staticGraph = buildDependencyGraphFromDeps(compiledMap, producerMap);
    const merged = mergeDynamicDeps(staticGraph, session.dynamicDeps, producerMap);
    const nextGraph = merged.graph;
    if (!footprintChanged && dependencyGraphsEqual(graph, nextGraph)) {
      break;
    }

    changedAny = true;
    const affected = collectChangedDependencies(graph, nextGraph, compiledMap);
    graph = nextGraph;
    evalOrder = topologicalSort(graph);
    for (const key of affected) {
      // A newly discovered SCC must retain its current values as the seed for
      // runIterativeCalc. Ordinary evaluation here would collapse circular
      // spills back to the zero fallback before the iterative driver can use
      // their previous raw arrays.
      if (graph.circularKeys.has(key) && !compiledMap.get(key)?.hasDynamicRefs) {
        continue;
      }
      results.delete(key);
      session.resultCache.delete(key);
      session.dynamicDeps.delete(key);
    }
    session.nameCache.clear();
    evaluateInOrder(evalOrder, compiledMap, results, ctx, session);
  }

  return { graph, evalOrder, changed: changedAny };
}

function collectChangedDependencies(
  previous: DependencyGraph,
  current: DependencyGraph,
  compiledMap: ReadonlyMap<string, CompiledFormula>
): Set<string> {
  const affected = new Set<string>();
  const queue: string[] = [];
  for (const key of current.formulaKeys) {
    const before = previous.dependsOn.get(key);
    const after = current.dependsOn.get(key);
    const producerChanged =
      !setsEqual(before, after) &&
      [...(after ?? [])].some(dep => compiledMap.has(dep) && !before?.has(dep));
    if (producerChanged || current.circularKeys.has(key) !== previous.circularKeys.has(key)) {
      affected.add(key);
      queue.push(key);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++];
    for (const dependent of current.dependedBy.get(key) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return affected;
}

function dependencyGraphsEqual(a: DependencyGraph, b: DependencyGraph): boolean {
  if (!setsEqual(a.circularKeys, b.circularKeys)) {
    return false;
  }
  for (const key of b.formulaKeys) {
    if (!setsEqual(a.dependsOn.get(key), b.dependsOn.get(key))) {
      return false;
    }
  }
  return true;
}

function setsEqual(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

function mapsEqual(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Helper: Evaluate Formulas in Order
// ============================================================================

/**
 * Evaluate compiled formulas in the given topological order.
 *
 * For each formula in `evalOrder`:
 * - If already in `results` (from a previous pass or compile failure), skip.
 * - Volatile formulas always re-evaluate (bypass scalar cache).
 * - CSE / dynamic array formulas use `evaluateFormulaRaw`.
 * - Normal scalar formulas use `evaluateFormula` with cache.
 */
function evaluateInOrder(
  evalOrder: readonly string[],
  compiledMap: ReadonlyMap<string, CompiledFormula>,
  results: Map<string, RuntimeValue>,
  ctx: EvalContext,
  session: EvalSession
): void {
  for (const key of evalOrder) {
    // Skip if already computed (e.g. compile failure → #CALC!, or previous pass)
    if (results.has(key)) {
      continue;
    }

    const compiled = compiledMap.get(key);
    if (!compiled) {
      continue;
    }

    const inst = compiled.instance;
    const isCSE = inst.kind === "cse" && inst.targetRef;
    const isDynamic = inst.isDynamicArray || compiled.isDynamicArrayFunction;

    // Volatile formulas always re-evaluate — bypass cache
    if (compiled.isVolatile) {
      session.resultCache.delete(key);
    }

    if (isCSE || isDynamic) {
      try {
        const raw = evaluateFormulaRaw(compiled, ctx, session);
        results.set(key, raw);
        if (isCSE && inst.targetRef) {
          populateCSECache(inst, raw, session);
        }
      } catch {
        results.set(key, ERRORS.CALC);
      }
    } else {
      if (!compiled.isVolatile) {
        const cachedResult = session.resultCache.get(key);
        if (cachedResult !== undefined) {
          results.set(key, cachedResult.scalar);
          continue;
        }
      }
      try {
        const scalar = evaluateFormula(compiled, ctx, session);
        results.set(key, scalar);
      } catch {
        results.set(key, ERRORS.CALC);
      }
    }
  }
}

// ============================================================================
// Helper: Parse Formula Text
// ============================================================================

/**
 * Touch a cache entry to move it to the MRU (most-recently-used) position.
 * Relies on `Map`'s guaranteed insertion-order iteration: delete + re-set
 * pushes the entry to the end of the iteration order without changing its
 * value identity. Only called on cache hits.
 */
function touchAstCacheEntry(
  astCache: Map<string, CachedAst>,
  formula: string,
  ast: CachedAst
): void {
  astCache.delete(formula);
  astCache.set(formula, ast);
}

/**
 * Insert a new entry into the AST cache, evicting the least-recently-used
 * entry if the cache is at capacity. The LRU entry is the first key returned
 * by `Map.keys()` iteration, which corresponds to the oldest insertion/touch.
 */
function insertAstCacheEntry(
  astCache: Map<string, CachedAst>,
  formula: string,
  ast: CachedAst
): void {
  if (astCache.size >= AST_CACHE_MAX_ENTRIES) {
    // Evict one entry before adding the new one. `Map.keys().next().value`
    // is the least-recently-inserted (or -touched) key — O(1) access.
    const oldestKey = astCache.keys().next().value;
    if (oldestKey !== undefined) {
      astCache.delete(oldestKey);
    }
  }
  astCache.set(formula, ast);
}

function parseFormulaText(formula: string, astCache: Map<string, CachedAst>): AstNode | null {
  const cached = astCache.get(formula);
  if (cached === PARSE_FAILED) {
    // Touch so that a repeatedly-evaluated failing formula doesn't get
    // evicted and re-parsed (and re-failed) every cycle.
    touchAstCacheEntry(astCache, formula, PARSE_FAILED);
    return null;
  }
  if (cached) {
    touchAstCacheEntry(astCache, formula, cached);
    return cached;
  }
  try {
    const tokens = tokenize(formula);
    const ast = parse(tokens);
    insertAstCacheEntry(astCache, formula, ast);
    return ast;
  } catch {
    insertAstCacheEntry(astCache, formula, PARSE_FAILED);
    return null;
  }
}

// ============================================================================
// Helper: Compile Formula (with failure diagnostics)
// ============================================================================

/**
 * Failure reason codes for formula compilation.
 * These provide fine-grained diagnostics beyond the generic #CALC! error.
 */
type CompileFailure =
  | { reason: "parse"; formula: string }
  | { reason: "bind"; formula: string; sheet: string };

function compileFormula(
  inst: FormulaInstance,
  astCache: Map<string, CachedAst>,
  snapshot: WorkbookSnapshot,
  volatileHostFunctions: ReadonlySet<string>
): CompiledFormula | CompileFailure {
  const ast = astCache.get(inst.sourceText);
  if (!ast || ast === PARSE_FAILED) {
    return { reason: "parse", formula: inst.sourceText };
  }

  const bindCtx: BindingContext = {
    snapshot,
    currentSheet: inst.sheetName
  };

  try {
    const bound = bind(ast, bindCtx);

    // Build a name resolver that parses formula-based defined names
    // so their deps and dynamic-ref flags propagate to the outer formula.
    const nameDepCache = new Map<string, ReturnType<NameDepResolver>>();
    const nameResolver: NameDepResolver = upperName => {
      // Include sheet in cache key for scope-aware resolution
      const cacheKey = `${upperName}\0${inst.sheetName}`;
      if (nameDepCache.has(cacheKey)) {
        return nameDepCache.get(cacheKey);
      }
      // Prevent infinite recursion
      nameDepCache.set(cacheKey, undefined);

      // Use scope-aware resolution (sheet-local → workbook-global)
      const dn = resolveDefinedName(snapshot.definedNames, upperName, inst.sheetName);
      if (!dn || dn.ranges.length !== 1) {
        return undefined;
      }
      const rangeStr = dn.ranges[0];
      // Only process formula-based names (not cell/range refs)
      if (parseRefRange(rangeStr)) {
        return undefined;
      }
      try {
        const nameTokens = tokenize(rangeStr);
        const nameAst = parse(nameTokens);
        const nameBound = bind(nameAst, { snapshot, currentSheet: inst.sheetName });
        const nameDeps = extractStaticDeps(nameBound, snapshot, nameResolver);
        const nameAnalysis = analyzeExpr(nameBound, nameResolver, volatileHostFunctions);
        const result = {
          deps: nameDeps,
          hasDynamicRefs: nameAnalysis.hasDynamicRefs,
          // Propagate volatility so a defined-name body containing NOW()/
          // RAND() correctly invalidates the outer formula's session
          // cache on every calculation pass.
          isVolatile: nameAnalysis.isVolatile
        };
        nameDepCache.set(cacheKey, result);
        return result;
      } catch {
        return undefined;
      }
    };

    const staticDeps = extractStaticDeps(bound, snapshot, nameResolver);
    const analysis = analyzeExpr(bound, nameResolver, volatileHostFunctions);

    return {
      instance: inst,
      bound,
      staticDeps,
      isVolatile: analysis.isVolatile,
      hasDynamicRefs: analysis.hasDynamicRefs,
      containsLambda: analysis.containsLambda,
      isDynamicArrayFunction: detectDynamicArrayFunction(ast, bound),
      isSubtotalOutput: detectSubtotalOutput(ast, bound)
    };
  } catch {
    return { reason: "bind", formula: inst.sourceText, sheet: inst.sheetName };
  }
}

// ============================================================================
// Helper: Cleanup Stale Spills
// ============================================================================

function buildStaleSpillCleanupPlan(
  state: FormulaCalculationState,
  snapshot: WorkbookSnapshot
): WritebackPlan {
  const previousSpills = state.spillRegions;
  if (previousSpills.size === 0) {
    return {
      operations: [],
      spillState: { spillRegions: new Map(), ghostSnapshots: new Map() }
    };
  }

  // No formula cells → all spills are stale
  return buildWritebackPlan(snapshot, [], [], new Map(), previousSpills, state.ghostSnapshots);
}

// ============================================================================
// Helper: Populate CSE Session Cache
// ============================================================================

/**
 * For CSE array formulas, immediately populate the session cache for all
 * cells in the target range. This ensures that when other formulas reference
 * cells within a CSE range, they see the correct distributed values instead
 * of re-evaluating independently.
 */
function populateCSECache(inst: FormulaInstance, result: RuntimeValue, session: EvalSession): void {
  const ref = inst.targetRef;
  if (!ref) {
    return;
  }
  const range = parseRefRange(ref);
  if (!range) {
    return;
  }
  const { top, left, bottom, right } = range;

  const numRows = bottom - top + 1;
  const numCols = right - left + 1;

  if (result.kind === RVKind.Array) {
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const cellKey = formulaCellKey(inst.sheetName, top + r, left + c);
        const val = result.rows[r]?.[c];
        const sv = val ?? BLANK;
        session.resultCache.set(cellKey, { scalar: sv, raw: sv });
      }
    }
  } else {
    // Scalar — fill entire range
    const scalar =
      result.kind === RVKind.Error ||
      result.kind === RVKind.Number ||
      result.kind === RVKind.String ||
      result.kind === RVKind.Boolean
        ? result
        : BLANK;
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const cellKey = formulaCellKey(inst.sheetName, top + r, left + c);
        session.resultCache.set(cellKey, { scalar, raw: scalar });
      }
    }
  }
}

// ============================================================================
// Iterative calculation (for circular references)
// ============================================================================

/**
 * Drive the iterative-calculation loop for the cells that participate in
 * cycles. Pre-computes the transitive downstream set once, then on each
 * iteration:
 *   1. invalidates the cached result of circular cells and their descendants;
 *   2. seeds `circularFallback` from the previous iteration's numbers;
 *   3. re-evaluates each circular cell and tracks the maximum absolute change.
 *
 * Exits early when all cells converge within `iterateDelta`, or after
 * `iterateCount` iterations. The `circularFallback` map is cleared on exit
 * so subsequent (non-iterative) evaluation paths revert to the zero-seed
 * fallback behaviour.
 */
function runIterativeCalc(
  evalOrder: readonly string[],
  graph: DependencyGraph,
  compiledMap: Map<string, CompiledFormula>,
  results: Map<string, RuntimeValue>,
  ctx: EvalContext,
  session: EvalSession,
  snapshot: WorkbookSnapshot
): void {
  const maxIter = snapshot.calcProperties.iterateCount ?? 100;
  const delta = snapshot.calcProperties.iterateDelta ?? 0.001;

  const circularKeys: string[] = [];
  for (const key of evalOrder) {
    if (graph.circularKeys.has(key)) {
      circularKeys.push(key);
    }
  }

  // Transitive downstream of circularKeys — cells upstream of every cycle
  // are stable across iterations, so their cached values remain valid.
  const circularAndDownstream = new Set<string>(graph.circularKeys);
  const downstreamQueue: string[] = [...graph.circularKeys];
  let downstreamHead = 0;
  while (downstreamHead < downstreamQueue.length) {
    const key = downstreamQueue[downstreamHead++];
    const deps = graph.dependedBy.get(key);
    if (!deps) {
      continue;
    }
    for (const depKey of deps) {
      if (!circularAndDownstream.has(depKey)) {
        circularAndDownstream.add(depKey);
        downstreamQueue.push(depKey);
      }
    }
  }

  for (let iter = 0; iter < maxIter; iter++) {
    let maxChange = 0;
    // A numeric delta alone cannot decide convergence: if a circular cell is
    // still non-numeric (e.g. `#CALC!` on the first pass) or flips kind between
    // iterations, `maxChange` would stay 0 and the loop would exit after a
    // single pass. Track those cases explicitly.
    let allStable = true;

    // Clear only circular cells and their transitive downstream.
    for (const key of circularAndDownstream) {
      session.resultCache.delete(key);
    }
    // Defined-name cache: cleared wholesale because formula-based names may
    // indirectly reference circular cells, and tracking which names touch
    // which cells would complicate the engine substantially.
    session.nameCache.clear();

    // Seed fallback from previous results
    for (const key of circularKeys) {
      const compiled = compiledMap.get(key);
      if (!compiled) {
        continue;
      }
      const prev = results.get(key);
      if (prev !== undefined && prev.kind !== RVKind.Error) {
        session.circularFallback.set(key, topLeft(prev));
        session.circularRawFallback.set(key, prev);
      } else {
        session.circularFallback.set(key, rvNumber(0));
        session.circularRawFallback.delete(key);
      }
    }

    for (const key of circularKeys) {
      const compiled = compiledMap.get(key);
      if (!compiled) {
        continue;
      }
      try {
        const oldResult = results.get(key);
        // Preserve array semantics inside a cycle: evaluating a CSE or
        // dynamic-array formula through the scalar path would collapse its
        // result, and the materialize step would then tear down the spill.
        const inst = compiled.instance;
        const isCSE = inst.kind === "cse" && inst.targetRef !== undefined;
        const isDynamic = inst.isDynamicArray || compiled.isDynamicArrayFunction;
        const newResult =
          isCSE || isDynamic
            ? evaluateFormulaRaw(compiled, ctx, session)
            : evaluateFormula(compiled, ctx, session);
        results.set(key, newResult);
        // The fallback feeds re-entrant scalar lookups, so seed it with the
        // scalar view even when this cell produced an array.
        session.circularFallback.set(key, topLeft(newResult));
        session.circularRawFallback.set(key, newResult);

        const change = compareIterationResults(oldResult, newResult);
        maxChange = Math.max(maxChange, change.maxChange);
        if (!change.stable) {
          allStable = false;
        }
        if (isCSE) {
          populateCSECache(inst, newResult, session);
        }
      } catch {
        // Iterative evaluation threw — set error and continue convergence.
        results.set(key, ERRORS.CALC);
        allStable = false;
      }
    }

    if (allStable && maxChange <= delta) {
      break;
    }
  }

  session.circularFallback.clear();
  session.circularRawFallback.clear();
}

function compareIterationResults(
  previous: RuntimeValue | undefined,
  current: RuntimeValue
): { stable: boolean; maxChange: number } {
  if (!previous || previous.kind !== current.kind) {
    return { stable: false, maxChange: 0 };
  }
  if (previous.kind === RVKind.Array && current.kind === RVKind.Array) {
    if (previous.height !== current.height || previous.width !== current.width) {
      return { stable: false, maxChange: 0 };
    }
    let stable = true;
    let maxChange = 0;
    for (let r = 0; r < current.height; r++) {
      for (let c = 0; c < current.width; c++) {
        const change = compareIterationResults(previous.rows[r][c], current.rows[r][c]);
        stable = stable && change.stable;
        maxChange = Math.max(maxChange, change.maxChange);
      }
    }
    return { stable, maxChange };
  }
  if (previous.kind === RVKind.Number && current.kind === RVKind.Number) {
    return { stable: true, maxChange: Math.abs(current.value - previous.value) };
  }
  if (previous.kind === RVKind.Error && current.kind === RVKind.Error) {
    return { stable: previous.code === current.code, maxChange: 0 };
  }
  if (isScalar(previous) && isScalar(current)) {
    return { stable: scalarEquals(previous, current), maxChange: 0 };
  }
  return { stable: previous === current, maxChange: 0 };
}

/**
 * After iterative calculation has converged, cells that sit on the non-
 * circular side but depend transitively on a circular cell still hold stale
 * values from the first pass (which used the fallback zero-seed). Find them
 * and re-evaluate, preserving topological order.
 */
function reevaluateDownstreamOfCircular(
  evalOrder: readonly string[],
  graph: DependencyGraph,
  compiledMap: Map<string, CompiledFormula>,
  results: Map<string, RuntimeValue>,
  ctx: EvalContext,
  session: EvalSession
): void {
  const affected = new Set<string>();
  const queue: string[] = [...graph.circularKeys];
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++];
    const deps = graph.dependedBy.get(key);
    if (!deps) {
      continue;
    }
    for (const depKey of deps) {
      if (!graph.circularKeys.has(depKey) && !affected.has(depKey)) {
        affected.add(depKey);
        queue.push(depKey);
      }
    }
  }
  if (affected.size === 0) {
    return;
  }
  for (const key of affected) {
    session.resultCache.delete(key);
    results.delete(key);
  }
  session.nameCache.clear();
  // Only re-evaluate the affected subset; filtering preserves the
  // topological ordering within that subset while skipping the (already
  // computed) non-affected cells entirely.
  const filteredOrder = evalOrder.filter(k => affected.has(k));
  evaluateInOrder(filteredOrder, compiledMap, results, ctx, session);
}
