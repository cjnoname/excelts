import {
  createFormulaCalculationState,
  nextFormulaCalculationState
} from "@formula/integration/calculation-state";
import { NodeType } from "@formula/syntax/ast";
import { describe, expect, it } from "vitest";

describe("FormulaCalculationState", () => {
  it("creates independent explicit state objects", () => {
    const first = createFormulaCalculationState();
    const second = createFormulaCalculationState();
    first.astCache.set("1+1", { type: NodeType.Number, value: 1 });
    expect(second.astCache.size).toBe(0);
    expect(first.spillRegions).not.toBe(second.spillRegions);
  });

  it("adopts the plan's complete spill state without touching the committed one", () => {
    const committed = createFormulaCalculationState();
    const next = nextFormulaCalculationState(committed, {
      spillRegions: new Map([
        ["ws:1!1:1", { worksheetId: 1, sourceRow: 1, sourceCol: 1, rows: 3, cols: 1 }]
      ])
    });

    expect(committed.spillRegions.size).toBe(0);
    expect(next.spillRegions.get("ws:1!1:1")?.rows).toBe(3);
  });

  it("drops stale regions and ghost snapshots by adopting the new maps", () => {
    const committed = nextFormulaCalculationState(createFormulaCalculationState(), {
      spillRegions: new Map([
        ["old", { worksheetId: 1, sourceRow: 1, sourceCol: 1, rows: 3, cols: 1 }]
      ])
    });

    const next = nextFormulaCalculationState(committed, {
      spillRegions: new Map()
    });

    expect(next.spillRegions.has("old")).toBe(false);
  });

  it("shares the AST memo across states so parsed formulas survive", () => {
    const committed = createFormulaCalculationState();
    committed.astCache.set("1+1", { type: NodeType.Number, value: 1 });
    const next = nextFormulaCalculationState(committed, {
      spillRegions: new Map()
    });
    expect(next.astCache).toBe(committed.astCache);
  });
});
