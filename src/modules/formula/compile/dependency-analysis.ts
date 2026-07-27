/**
 * Dependency Graph for Formula Calculation
 *
 * Builds a dependency graph from compiled formulas' static dependencies,
 * then produces a topological evaluation order with circular reference
 * detection.
 *
 * Key exports:
 * - `buildDependencyGraphFromDeps()` — build graph from CompiledFormula static deps
 * - `topologicalSort()` — produce evaluation order, detecting circular refs
 */

// ============================================================================
// Types
// ============================================================================

/**
 * A single cell coordinate used as a dependency target.
 */
interface CellCoord {
  sheet: string;
  row: number;
  col: number;
}

/**
 * A rectangular range of cells used as a dependency target.
 */
interface RangeCoord {
  sheet: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * A dependency reference: either a single cell or a range.
 */
type DepRef = CellCoord | RangeCoord;

/**
 * The dependency graph structure.
 *
 * - `dependsOn`: formula cell key → set of cell keys it reads from
 * - `dependedBy`: cell key → set of formula cell keys that read from it
 * - `formulaKeys`: ordered list of all formula cell keys
 * - `circularKeys`: set of formula cell keys involved in circular references
 */
export interface DependencyGraph {
  /** Forward edges: formula → cells it depends on */
  readonly dependsOn: ReadonlyMap<string, ReadonlySet<string>>;
  /** Reverse edges: cell → formulas that depend on it */
  readonly dependedBy: ReadonlyMap<string, ReadonlySet<string>>;
  /** All formula cell keys in insertion order */
  readonly formulaKeys: readonly string[];
  /** Formula cell keys that are part of a circular reference cycle */
  readonly circularKeys: ReadonlySet<string>;
}

// ============================================================================
// Cell Key Helpers
// ============================================================================

function makeKey(sheet: string, row: number, col: number): string {
  return `${sheet}!${row}:${col}`;
}

// ============================================================================
// Dependency Reference → Cell Key Expansion
// ============================================================================

/**
 * Type guard: is this a range reference (has `top` property)?
 */
function isRange(ref: DepRef): ref is RangeCoord {
  return "top" in ref;
}

/**
 * Expand a set of DepRefs into concrete cell keys.
 * For single-cell refs, the key is produced directly.
 * For range refs, we check which formula cells fall within the range rather
 * than enumerating every cell (which would be prohibitively expensive for
 * whole-column ranges like A:A).
 */
function expandRefsToKeys(
  refs: DepRef[],
  formulaKeySet: ReadonlySet<string>,
  formulaCellCoordsBySheet: ReadonlyMap<string, ReadonlyArray<readonly [string, CellCoord]>>
): Set<string> {
  const keys = new Set<string>();

  for (const ref of refs) {
    if (isRange(ref)) {
      const rangeSize = (ref.bottom - ref.top + 1) * (ref.right - ref.left + 1);

      if (rangeSize <= 10000) {
        // Small-to-medium range: enumerate every cell
        for (let r = ref.top; r <= ref.bottom; r++) {
          for (let c = ref.left; c <= ref.right; c++) {
            keys.add(makeKey(ref.sheet, r, c));
          }
        }
      } else {
        // Large range (e.g. whole column A:A): scan formula cells in the
        // referenced sheet only and check containment.
        const sheetCoords = formulaCellCoordsBySheet.get(ref.sheet);
        if (sheetCoords) {
          for (const [fKey, coord] of sheetCoords) {
            if (
              coord.row >= ref.top &&
              coord.row <= ref.bottom &&
              coord.col >= ref.left &&
              coord.col <= ref.right
            ) {
              keys.add(fKey);
            }
          }
        }
      }
    } else {
      // Single cell — always add
      keys.add(makeKey(ref.sheet, ref.row, ref.col));
    }
  }

  return keys;
}

// ============================================================================
// Build Dependency Graph from CompiledFormula StaticDeps
// ============================================================================

/**
 * Build a dependency graph from compiled formulas' static dependencies.
 *
 * Operates on the already-resolved `StaticDependencySet` from each compiled
 * formula. Since names and structured references are already resolved by
 * the binder, the dependency edges are complete.
 *
 * @param compiled - Map from formula cell key to compiled formula with static deps
 * @param producerMap - Optional map from cell key → formula key that produces
 *   that cell's value (via CSE distribution or dynamic-array spill). Allows
 *   dependency edges to be added to the producer even when the target cell
 *   isn't itself a formula.
 * @returns The complete dependency graph
 */
export function buildDependencyGraphFromDeps(
  compiled: ReadonlyMap<
    string,
    {
      instance: {
        sheetName: string;
        row: number;
        col: number;
        isDynamicArray?: boolean;
      };
      /**
       * Whether this formula's top-level function is a known dynamic-
       * array producer (SEQUENCE / FILTER / SORT / …). Used to collapse
       * downstream `A1:A5`-style range dependencies into a single edge
       * on the master so dependency ordering stays correct on the first
       * calc pass (before ghost cells exist in the snapshot).
       */
      isDynamicArrayFunction?: boolean;
      staticDeps: {
        cells: readonly { sheet: string; row: number; col: number }[];
        areas: readonly {
          sheet: string;
          top: number;
          left: number;
          bottom: number;
          right: number;
        }[];
      };
    }
  >,
  producerMap?: ReadonlyMap<string, string>
): DependencyGraph {
  // Build a lookup of all formula cell coordinates for range intersection.
  // We group by sheet so that large-range containment scans only visit the
  // relevant sheet's formula cells instead of the entire workbook.
  const formulaKeySet = new Set<string>();
  const formulaCellCoordsBySheet = new Map<string, Array<[string, CellCoord]>>();
  const formulaKeys: string[] = [];

  for (const [key, cf] of compiled) {
    formulaKeySet.add(key);
    // Use the instance's already-known coordinates instead of reverse-parsing
    // the key string — saves two lastIndexOf calls and two parseInt calls
    // per formula on cold-start.
    const inst = cf.instance;
    const coord: CellCoord = { sheet: inst.sheetName, row: inst.row, col: inst.col };
    let list = formulaCellCoordsBySheet.get(inst.sheetName);
    if (!list) {
      list = [];
      formulaCellCoordsBySheet.set(inst.sheetName, list);
    }
    list.push([key, coord]);
    formulaKeys.push(key);
  }

  // Forward edges: formula key → set of keys it depends on
  const dependsOn = new Map<string, Set<string>>();
  // Reverse edges: cell key → set of formula keys that depend on it
  const dependedBy = new Map<string, Set<string>>();

  for (const [key, cf] of compiled) {
    const deps = cf.staticDeps;

    // Convert StaticDependencySet to DepRef[]
    const refs: DepRef[] = [];
    // Keep direct cell coordinates until producer remapping. A direct ref may
    // point at a dynamic-array ghost that is not itself a formula cell.
    const directCellKeys: string[] = [];
    for (const cell of deps.cells) {
      directCellKeys.push(makeKey(cell.sheet, cell.row, cell.col));
    }
    // Area deps normally expand into every cell in the range. For areas
    // that start at a dynamic-array master (e.g. the `A1:A5` in
    // `SUM(A1:A5)` where A1 is a live `=SEQUENCE(5)`), we replace the
    // expansion with a single dependency on the master. Evaluator-time
    // `getCellValue` then reads the master's cached array result for
    // the ghost positions, so downstream formulas see the full spill
    // in the same calc pass. Without this, A2..A5 aren't yet in the
    // snapshot on the first run and the SUM only picks up A1.
    const dynMasterDeps: string[] = [];
    for (const area of deps.areas) {
      const topLeftKey = makeKey(area.sheet, area.top, area.left);
      const masterCf = compiled.get(topLeftKey);
      const isDynMaster =
        masterCf !== undefined &&
        (masterCf.instance.isDynamicArray || masterCf.isDynamicArrayFunction);
      if (isDynMaster) {
        dynMasterDeps.push(topLeftKey);
      }
      refs.push({
        sheet: area.sheet,
        top: area.top,
        left: area.left,
        bottom: area.bottom,
        right: area.right
      });
    }

    // Expand to concrete cell keys
    const depKeys = expandRefsToKeys(refs, formulaKeySet, formulaCellCoordsBySheet);
    for (const directKey of directCellKeys) {
      depKeys.add(directKey);
    }
    for (const mk of dynMasterDeps) {
      depKeys.add(mk);
    }

    // Remap producer keys: if a dep points to a cell that's not a formula
    // but IS produced by another formula (CSE target or spill target),
    // depend on the producer instead.
    if (producerMap && producerMap.size > 0) {
      const remapped = new Set<string>();
      for (const depKey of depKeys) {
        if (!formulaKeySet.has(depKey)) {
          const producer = producerMap.get(depKey);
          if (producer) {
            remapped.add(producer);
            continue;
          }
        }
        remapped.add(depKey);
      }
      dependsOn.set(key, remapped);
      for (const depKey of remapped) {
        let set = dependedBy.get(depKey);
        if (!set) {
          set = new Set();
          dependedBy.set(depKey, set);
        }
        set.add(key);
      }
      continue;
    }

    dependsOn.set(key, depKeys);

    // Build reverse index
    for (const depKey of depKeys) {
      let set = dependedBy.get(depKey);
      if (!set) {
        set = new Set();
        dependedBy.set(depKey, set);
      }
      set.add(key);
    }
  }

  // Detect circular references
  const { circularKeys } = detectCircularRefs(formulaKeys, dependsOn);

  return {
    dependsOn,
    dependedBy,
    formulaKeys,
    circularKeys
  };
}

// ============================================================================
// Merge Runtime Dynamic Dependencies
// ============================================================================

/**
 * Merge runtime-discovered dynamic dependencies into a dependency graph.
 *
 * After evaluating formulas that contain INDIRECT/OFFSET, the runtime
 * dependency recorder has collected the actual cell accesses. This function
 * incorporates those dynamic edges into the graph and re-detects cycles.
 *
 * Returns a new graph if edges were added, or the original graph if no
 * dynamic deps were recorded.
 */
export function mergeDynamicDeps(
  graph: DependencyGraph,
  dynamicDeps: ReadonlyMap<string, ReadonlySet<string>>,
  producerMap?: ReadonlyMap<string, string>
): { graph: DependencyGraph; changed: boolean } {
  if (dynamicDeps.size === 0) {
    return { graph, changed: false };
  }

  // First pass: detect whether any new edges would actually be added.
  // Cloning the full dependsOn/dependedBy maps is expensive for large
  // workbooks; skip it entirely when there's no real work to do.
  let needsClone = false;
  for (const [formulaKey, accessedKeys] of dynamicDeps) {
    const existing = graph.dependsOn.get(formulaKey);
    for (const k of accessedKeys) {
      const depKey = producerMap?.get(k) ?? k;
      if (!existing || !existing.has(depKey)) {
        needsClone = true;
        break;
      }
    }
    if (needsClone) {
      break;
    }
  }
  if (!needsClone) {
    return { graph, changed: false };
  }

  // Clone forward and reverse edges
  const newDependsOn = new Map<string, Set<string>>();
  for (const [k, v] of graph.dependsOn) {
    newDependsOn.set(k, new Set(v));
  }
  const newDependedBy = new Map<string, Set<string>>();
  for (const [k, v] of graph.dependedBy) {
    newDependedBy.set(k, new Set(v));
  }

  // Add dynamic edges
  for (const [formulaKey, accessedKeys] of dynamicDeps) {
    let deps = newDependsOn.get(formulaKey);
    if (!deps) {
      deps = new Set();
      newDependsOn.set(formulaKey, deps);
    }
    for (const accessedKey of accessedKeys) {
      const depKey = producerMap?.get(accessedKey) ?? accessedKey;
      if (!deps.has(depKey)) {
        deps.add(depKey);
        // Update reverse edge
        let rev = newDependedBy.get(depKey);
        if (!rev) {
          rev = new Set();
          newDependedBy.set(depKey, rev);
        }
        rev.add(formulaKey);
      }
    }
  }

  // Re-detect cycles with the augmented graph
  const { circularKeys } = detectCircularRefs(graph.formulaKeys, newDependsOn);

  return {
    graph: {
      dependsOn: newDependsOn,
      dependedBy: newDependedBy,
      formulaKeys: graph.formulaKeys,
      circularKeys
    },
    changed: true
  };
}

// ============================================================================
// Circular Reference Detection
// ============================================================================

/**
 * Detect circular references using Tarjan's SCC algorithm.
 *
 * A formula is "circular" if it belongs to a strongly connected component
 * of size > 1, or if it has a direct self-loop (A = f(A)).
 *
 * This correctly identifies ALL nodes in cycles, including nodes reachable
 * only through cross-edges to already-visited SCC members — a case that
 * a simple 3-color DFS misses (e.g. diamond cycles like A→B→C→A plus A→D→C).
 */
function detectCircularRefs(
  formulaKeys: readonly string[],
  dependsOn: ReadonlyMap<string, ReadonlySet<string>>
): { circularKeys: Set<string> } {
  const circularKeys = new Set<string>();

  // Tarjan's iterative SCC
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const sccStack: string[] = [];
  let nextIndex = 0;

  // DFS frame: [key, iterator, processingChild]
  // processingChild holds the key we just recursed into, so we can update
  // lowlink when we come back up.
  interface Frame {
    key: string;
    iter: Iterator<string>;
    pendingChild: string | null;
  }

  for (const startKey of formulaKeys) {
    if (index.has(startKey)) {
      continue;
    }

    const dfsStack: Frame[] = [];
    index.set(startKey, nextIndex);
    lowlink.set(startKey, nextIndex);
    nextIndex++;
    sccStack.push(startKey);
    onStack.add(startKey);
    dfsStack.push({
      key: startKey,
      iter: (dependsOn.get(startKey) ?? new Set<string>())[Symbol.iterator](),
      pendingChild: null
    });

    while (dfsStack.length > 0) {
      const frame = dfsStack[dfsStack.length - 1];

      // If we just returned from a child, update our lowlink
      if (frame.pendingChild !== null) {
        const childLow = lowlink.get(frame.pendingChild)!;
        lowlink.set(frame.key, Math.min(lowlink.get(frame.key)!, childLow));
        frame.pendingChild = null;
      }

      const next = frame.iter.next();
      if (next.done) {
        // Finished processing all children — check if this is an SCC root
        if (lowlink.get(frame.key) === index.get(frame.key)) {
          const scc: string[] = [];
          let node: string;
          do {
            node = sccStack.pop()!;
            onStack.delete(node);
            scc.push(node);
          } while (node !== frame.key);

          // Mark as circular if SCC has > 1 node, OR if it's a self-loop
          const hasSelfLoop = scc.length === 1 && dependsOn.get(scc[0])?.has(scc[0]);
          if (scc.length > 1 || hasSelfLoop) {
            for (const k of scc) {
              circularKeys.add(k);
            }
          }
        }
        dfsStack.pop();
        // Record returning to parent so it can update its lowlink
        if (dfsStack.length > 0) {
          dfsStack[dfsStack.length - 1].pendingChild = frame.key;
        }
        continue;
      }

      const depKey = next.value;
      if (!index.has(depKey)) {
        // Unvisited — push new frame
        index.set(depKey, nextIndex);
        lowlink.set(depKey, nextIndex);
        nextIndex++;
        sccStack.push(depKey);
        onStack.add(depKey);
        dfsStack.push({
          key: depKey,
          iter: (dependsOn.get(depKey) ?? new Set<string>())[Symbol.iterator](),
          pendingChild: null
        });
      } else if (onStack.has(depKey)) {
        // Back edge — update lowlink with dep's index
        lowlink.set(frame.key, Math.min(lowlink.get(frame.key)!, index.get(depKey)!));
      }
      // Cross edge to fully-processed SCC: skip (correct Tarjan behavior)
    }
  }

  return { circularKeys };
}

// ============================================================================
// Topological Sort (Kahn's Algorithm)
// ============================================================================

/**
 * Produce a topological evaluation order for formula cells using Kahn's algorithm.
 * Cells with no dependencies are evaluated first. Circular references are
 * appended at the end in their original order.
 */
export function topologicalSort(graph: DependencyGraph): string[] {
  const { formulaKeys, dependsOn, circularKeys } = graph;

  const formulaKeySet = new Set(formulaKeys);
  const inDegree = new Map<string, number>();

  for (const key of formulaKeys) {
    if (circularKeys.has(key)) {
      continue;
    }
    const deps = dependsOn.get(key);
    if (!deps) {
      inDegree.set(key, 0);
      continue;
    }
    let count = 0;
    for (const depKey of deps) {
      if (formulaKeySet.has(depKey) && !circularKeys.has(depKey)) {
        count++;
      }
    }
    inDegree.set(key, count);
  }

  const queue: string[] = [];
  for (const key of formulaKeys) {
    if (circularKeys.has(key)) {
      continue;
    }
    if ((inDegree.get(key) ?? 0) === 0) {
      queue.push(key);
    }
  }

  const sorted: string[] = [];
  let head = 0;

  while (head < queue.length) {
    const key = queue[head++];
    sorted.push(key);

    const dependents = graph.dependedBy.get(key);
    if (dependents) {
      for (const depKey of dependents) {
        if (circularKeys.has(depKey) || !formulaKeySet.has(depKey)) {
          continue;
        }
        const deg = (inDegree.get(depKey) ?? 1) - 1;
        inDegree.set(depKey, deg);
        if (deg === 0) {
          queue.push(depKey);
        }
      }
    }
  }

  // Append circular reference cells at the end in original order
  for (const key of formulaKeys) {
    if (circularKeys.has(key)) {
      sorted.push(key);
    }
  }

  return sorted;
}
