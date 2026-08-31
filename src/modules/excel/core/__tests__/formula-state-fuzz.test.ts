import { calculateFormulas } from "@excel/core/formula-adapter";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { createRng } from "@test/rng";
import { describe, expect, it } from "vitest";

describe("formula workbook state-machine fuzz", () => {
  it("preserves spill, dynamic dependency, SCC, and structural-edit invariants", () => {
    for (let seed = 1; seed <= 48; seed++) {
      const rng = createRng(seed);
      const wb = Workbook.create();
      wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.0001 };
      const ws = Workbook.addWorksheet(wb, "S");

      const leftRows = rng.int(1, 4);
      const rightRows = rng.int(1, 4);
      Cell.setValue(ws, "A1", { formula: `SEQUENCE(${leftRows})`, result: 0 });
      Cell.setValue(ws, "C1", { formula: `SEQUENCE(${rightRows},1,10)`, result: 0 });
      Cell.setValue(ws, "E1", rng.bool() ? 1 : 0);
      Cell.setValue(ws, "F1", {
        formula: 'INDIRECT(IF(E1=1,"A3","C3"))',
        result: 0
      });
      const divisor = rng.int(2, 5);
      const base = rng.int(1, 5);
      Cell.setValue(ws, "H1", { formula: `H1/${divisor}+${base}`, result: 0 });

      calculateFormulas(wb);
      const expectedFixedPoint = (base * divisor) / (divisor - 1);
      expect(Cell.getResult(ws, "H1"), `seed ${seed}: SCC`).toBeCloseTo(expectedFixedPoint, 2);

      const selected = Cell.getValue(ws, Cell.getValue(ws, "E1") === 1 ? "A3" : "C3");
      const expectedDynamic = typeof selected === "number" ? selected : undefined;
      expect(Cell.getResult(ws, "F1"), `seed ${seed}: dynamic branch`).toBe(expectedDynamic);

      const blockRow = rng.int(2, Math.max(2, leftRows));
      const blockAddress = `A${blockRow}`;
      const sentinel = 10_000 + seed;
      Cell.setValue(ws, blockAddress, sentinel);
      calculateFormulas(wb);
      expect(Cell.getValue(ws, blockAddress), `seed ${seed}: user sentinel`).toBe(sentinel);
      if (leftRows >= blockRow) {
        expect(Cell.getResult(ws, "A1"), `seed ${seed}: spill blocked`).toEqual({
          error: "#SPILL!"
        });
      }

      Cell.setValue(ws, blockAddress, null);
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1"), `seed ${seed}: spill restored`).toBe(1);

      if (rng.bool()) {
        Worksheet.spliceRows(ws, 1, 0, []);
        calculateFormulas(wb);
        expect(Cell.getResult(ws, "A2"), `seed ${seed}: row splice`).toBe(1);
      } else {
        Worksheet.spliceColumns(ws, 1, 0, []);
        calculateFormulas(wb);
        expect(Cell.getResult(ws, "B1"), `seed ${seed}: column splice`).toBe(1);
      }

      const snapshot = JSON.stringify(Worksheet.getValues(ws));
      calculateFormulas(wb);
      expect(JSON.stringify(Worksheet.getValues(ws)), `seed ${seed}: idempotence`).toBe(snapshot);
    }
  });
});
