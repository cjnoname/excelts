import { cellGetValue } from "@excel/core/cell";
import {
  definedNamesAdd,
  definedNamesAddFormula,
  definedNamesGetAllNames,
  definedNamesSetModel
} from "@excel/core/defined-names";
import { calculateFormulas } from "@excel/core/formula-adapter";
import { getDefinedNames } from "@excel/core/workbook";
import { addTable, findCell, setSheetName } from "@excel/core/worksheet";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

/** Cell value, or null when the cell is absent — preserves the original `findCell(...)?.value ?? null` semantics. */
function cellValueOrNull(c: ReturnType<typeof findCell>): unknown {
  return c ? (cellGetValue(c) ?? null) : null;
}

describe("calculateFormulas", () => {
  // ==========================================================================
  // Basic Arithmetic
  // ==========================================================================
  describe("basic arithmetic", () => {
    it("should calculate simple addition", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", { formula: "A1+A2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A3")).toBe(30);
    });

    it("should calculate subtraction, multiplication, division", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 100);
      Cell.setValue(ws, "A2", 25);
      Cell.setValue(ws, "B1", { formula: "A1-A2", result: 0 });
      Cell.setValue(ws, "B2", { formula: "A1*A2", result: 0 });
      Cell.setValue(ws, "B3", { formula: "A1/A2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(75);
      expect(Cell.getResult(ws, "B2")).toBe(2500);
      expect(Cell.getResult(ws, "B3")).toBe(4);
    });

    it("should handle exponentiation", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 2);
      Cell.setValue(ws, "A2", { formula: "A1^10", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe(1024);
    });

    it("should respect operator precedence", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 2);
      Cell.setValue(ws, "A2", 3);
      Cell.setValue(ws, "A3", 4);
      Cell.setValue(ws, "B1", { formula: "A1+A2*A3", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(14); // 2 + (3*4) = 14
    });

    it("should handle parenthesized expressions", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 2);
      Cell.setValue(ws, "A2", 3);
      Cell.setValue(ws, "A3", 4);
      Cell.setValue(ws, "B1", { formula: "(A1+A2)*A3", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(20); // (2+3)*4 = 20
    });

    it("should handle division by zero", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 0);
      Cell.setValue(ws, "A3", { formula: "A1/A2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A3")).toEqual({ error: "#DIV/0!" });
    });
  });

  // ==========================================================================
  // SUM and Aggregate Functions
  // ==========================================================================
  describe("SUM and aggregate functions", () => {
    it("should calculate SUM over a range", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);
      Cell.setValue(ws, "A4", { formula: "SUM(A1:A3)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A4")).toBe(60);
    });

    it("should calculate SUM with multiple arguments", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "B1", 20);
      Cell.setValue(ws, "C1", { formula: "SUM(A1,B1,5)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toBe(35);
    });

    it("should calculate AVERAGE", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);
      Cell.setValue(ws, "A4", { formula: "AVERAGE(A1:A3)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A4")).toBe(20);
    });

    it("should calculate MIN and MAX", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 5);
      Cell.setValue(ws, "A2", 15);
      Cell.setValue(ws, "A3", 10);
      Cell.setValue(ws, "B1", { formula: "MIN(A1:A3)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "MAX(A1:A3)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(5);
      expect(Cell.getResult(ws, "B2")).toBe(15);
    });

    it("should calculate COUNT and COUNTA", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", "hello");
      Cell.setValue(ws, "A3", 30);
      // A4 left empty
      Cell.setValue(ws, "B1", { formula: "COUNT(A1:A4)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "COUNTA(A1:A4)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(2); // Only numbers
      expect(Cell.getResult(ws, "B2")).toBe(3); // Non-empty cells
    });

    it("should calculate PRODUCT", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 2);
      Cell.setValue(ws, "A2", 3);
      Cell.setValue(ws, "A3", 5);
      Cell.setValue(ws, "A4", { formula: "PRODUCT(A1:A3)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A4")).toBe(30);
    });
  });

  // ==========================================================================
  // Formula values after cell modification
  // ==========================================================================
  describe("formula values after cell modification", () => {
    it("should recalculate SUM after modifying referenced cells", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Setup: create a SUM formula with initial values
      Cell.setValue(ws, "B1", 0);
      Cell.setValue(ws, "B2", 0);
      Cell.setValue(ws, "B3", 0);
      Cell.setValue(ws, "B4", { formula: "SUM(B1:B3)", result: 0 });

      // Modify values (simulating the user's code in the issue)
      Cell.setValue(ws, "B1", 1);
      Cell.setValue(ws, "B2", 2);
      Cell.setValue(ws, "B3", 3);

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B4")).toBe(6);
    });

    it("should handle multiple columns with formulas", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Setup column D with SUM formula
      Cell.setValue(ws, "D1", 0);
      Cell.setValue(ws, "D2", 0);
      Cell.setValue(ws, "D3", 0);
      Cell.setValue(ws, "D4", { formula: "SUM(D1:D3)", result: 0 });

      // Setup column E with SUM formula
      Cell.setValue(ws, "E1", 0);
      Cell.setValue(ws, "E2", 0);
      Cell.setValue(ws, "E3", 0);
      Cell.setValue(ws, "E4", { formula: "SUM(E1:E3)", result: 0 });

      // Modify values (as in the issue)
      Cell.setValue(ws, "D1", 10.5);
      Cell.setValue(ws, "D2", 23.75);
      Cell.setValue(ws, "D3", 7.001);
      Cell.setValue(ws, "E1", 100);
      Cell.setValue(ws, "E2", 3.14);
      Cell.setValue(ws, "E3", 99.99);

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "D4")).toBeCloseTo(41.251);
      expect(Cell.getResult(ws, "E4")).toBeCloseTo(203.13);
    });
  });

  // ==========================================================================
  // Logical Functions
  // ==========================================================================
  describe("logical functions", () => {
    it("should evaluate IF", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", { formula: 'IF(A1>5,"big","small")', result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe("big");
    });

    it("should evaluate nested IF", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 75);
      Cell.setValue(ws, "A2", {
        formula: 'IF(A1>=90,"A",IF(A1>=80,"B",IF(A1>=70,"C","D")))',
        result: ""
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe("C");
    });

    it("should evaluate AND and OR", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", true);
      Cell.setValue(ws, "A2", false);
      Cell.setValue(ws, "B1", { formula: "AND(A1,A2)", result: false });
      Cell.setValue(ws, "B2", { formula: "OR(A1,A2)", result: false });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(false);
      expect(Cell.getResult(ws, "B2")).toBe(true);
    });

    it("should evaluate IFERROR", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 0);
      Cell.setValue(ws, "B1", { formula: 'IFERROR(A1/A2,"Error")', result: "" });
      Cell.setValue(ws, "B2", { formula: "IFERROR(A1*A1,0)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe("Error");
      expect(Cell.getResult(ws, "B2")).toBe(100);
    });
  });

  // ==========================================================================
  // Text Functions
  // ==========================================================================
  describe("text functions", () => {
    it("should evaluate CONCATENATE", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "Hello");
      Cell.setValue(ws, "A2", "World");
      Cell.setValue(ws, "A3", { formula: 'CONCATENATE(A1,", ",A2,"!")', result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A3")).toBe("Hello, World!");
    });

    it("should evaluate string concatenation operator &", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "foo");
      Cell.setValue(ws, "A2", "bar");
      Cell.setValue(ws, "A3", { formula: 'A1&" "&A2', result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A3")).toBe("foo bar");
    });

    it("should evaluate LEN, LEFT, RIGHT, MID", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "Hello World");
      Cell.setValue(ws, "B1", { formula: "LEN(A1)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "LEFT(A1,5)", result: "" });
      Cell.setValue(ws, "B3", { formula: "RIGHT(A1,5)", result: "" });
      Cell.setValue(ws, "B4", { formula: "MID(A1,7,5)", result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(11);
      expect(Cell.getResult(ws, "B2")).toBe("Hello");
      expect(Cell.getResult(ws, "B3")).toBe("World");
      expect(Cell.getResult(ws, "B4")).toBe("World");
    });

    it("should evaluate UPPER, LOWER, TRIM", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "  hello  WORLD  ");
      Cell.setValue(ws, "B1", { formula: "UPPER(A1)", result: "" });
      Cell.setValue(ws, "B2", { formula: "LOWER(A1)", result: "" });
      Cell.setValue(ws, "B3", { formula: "TRIM(A1)", result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe("  HELLO  WORLD  ");
      expect(Cell.getResult(ws, "B2")).toBe("  hello  world  ");
      expect(Cell.getResult(ws, "B3")).toBe("hello WORLD");
    });
  });

  // ==========================================================================
  // Math Functions
  // ==========================================================================
  describe("math functions", () => {
    it("should evaluate ROUND, ROUNDUP, ROUNDDOWN", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 3.456);
      Cell.setValue(ws, "B1", { formula: "ROUND(A1,2)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "ROUNDUP(A1,2)", result: 0 });
      Cell.setValue(ws, "B3", { formula: "ROUNDDOWN(A1,2)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(3.46);
      expect(Cell.getResult(ws, "B2")).toBe(3.46);
      expect(Cell.getResult(ws, "B3")).toBe(3.45);
    });

    it("should evaluate ABS, SQRT, POWER, MOD", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", -16);
      Cell.setValue(ws, "B1", { formula: "ABS(A1)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "SQRT(ABS(A1))", result: 0 });
      Cell.setValue(ws, "B3", { formula: "POWER(2,8)", result: 0 });
      Cell.setValue(ws, "B4", { formula: "MOD(17,5)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(16);
      expect(Cell.getResult(ws, "B2")).toBe(4);
      expect(Cell.getResult(ws, "B3")).toBe(256);
      expect(Cell.getResult(ws, "B4")).toBe(2);
    });

    it("should evaluate INT, CEILING, FLOOR", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 7.8);
      Cell.setValue(ws, "B1", { formula: "INT(A1)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "CEILING(A1,1)", result: 0 });
      Cell.setValue(ws, "B3", { formula: "FLOOR(A1,1)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(7);
      expect(Cell.getResult(ws, "B2")).toBe(8);
      expect(Cell.getResult(ws, "B3")).toBe(7);
    });
  });

  // ==========================================================================
  // Cross-sheet References
  // ==========================================================================
  describe("cross-sheet references", () => {
    it("should resolve references to another sheet", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Data");
      const ws2 = Workbook.addWorksheet(wb, "Summary");

      Cell.setValue(ws1, "A1", 100);
      Cell.setValue(ws1, "A2", 200);
      Cell.setValue(ws1, "A3", 300);

      Cell.setValue(ws2, "A1", { formula: "SUM(Data!A1:A3)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws2, "A1")).toBe(600);
    });

    it("should resolve single cell cross-sheet reference", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      const ws2 = Workbook.addWorksheet(wb, "Sheet2");

      Cell.setValue(ws1, "A1", 42);
      Cell.setValue(ws2, "A1", { formula: "Sheet1!A1*2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws2, "A1")).toBe(84);
    });
  });

  // ==========================================================================
  // Chained Dependencies
  // ==========================================================================
  describe("chained formula dependencies", () => {
    it("should handle a chain of dependent formulas", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 5);
      Cell.setValue(ws, "A2", { formula: "A1*2", result: 0 }); // 10
      Cell.setValue(ws, "A3", { formula: "A2+A1", result: 0 }); // 15
      Cell.setValue(ws, "A4", { formula: "SUM(A1:A3)", result: 0 }); // 30

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe(10);
      expect(Cell.getResult(ws, "A3")).toBe(15);
      expect(Cell.getResult(ws, "A4")).toBe(30);
    });

    it("should detect and handle circular references", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "A2+1", result: 0 });
      Cell.setValue(ws, "A2", { formula: "A1+1", result: 0 });

      calculateFormulas(wb);

      // Should not hang — circular refs return 0 (Excel behavior)
      const r1 = Cell.getResult(ws, "A1");
      const r2 = Cell.getResult(ws, "A2");
      // Both should be numbers (circular refs get fallback 0, then evaluate)
      expect(typeof r1).toBe("number");
      expect(typeof r2).toBe("number");
    });
  });

  // ==========================================================================
  // Comparison Operators
  // ==========================================================================
  describe("comparison operators", () => {
    it("should evaluate = <> < > <= >=", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "B1", { formula: "A1=A2", result: false });
      Cell.setValue(ws, "B2", { formula: "A1<>A2", result: false });
      Cell.setValue(ws, "B3", { formula: "A1<A2", result: false });
      Cell.setValue(ws, "B4", { formula: "A1>A2", result: false });
      Cell.setValue(ws, "B5", { formula: "A1<=A2", result: false });
      Cell.setValue(ws, "B6", { formula: "A1>=A2", result: false });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(false);
      expect(Cell.getResult(ws, "B2")).toBe(true);
      expect(Cell.getResult(ws, "B3")).toBe(true);
      expect(Cell.getResult(ws, "B4")).toBe(false);
      expect(Cell.getResult(ws, "B5")).toBe(true);
      expect(Cell.getResult(ws, "B6")).toBe(false);
    });
  });

  // ==========================================================================
  // Absolute References
  // ==========================================================================
  describe("absolute references", () => {
    it("should handle $A$1 style references", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 100);
      Cell.setValue(ws, "B1", { formula: "$A$1+50", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(150);
    });
  });

  // ==========================================================================
  // Unary Operators
  // ==========================================================================
  describe("unary operators", () => {
    it("should handle unary minus", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 42);
      Cell.setValue(ws, "A2", { formula: "-A1", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe(-42);
    });

    it("should handle percentage", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "50%", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(0.5);
    });
  });

  // ==========================================================================
  // VLOOKUP
  // ==========================================================================
  describe("VLOOKUP", () => {
    it("should perform exact match lookup", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "Apple");
      Cell.setValue(ws, "B1", 1.5);
      Cell.setValue(ws, "A2", "Banana");
      Cell.setValue(ws, "B2", 0.75);
      Cell.setValue(ws, "A3", "Cherry");
      Cell.setValue(ws, "B3", 3.0);

      Cell.setValue(ws, "D1", { formula: 'VLOOKUP("Banana",A1:B3,2,FALSE)', result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "D1")).toBe(0.75);
    });
  });

  // ==========================================================================
  // Information Functions
  // ==========================================================================
  describe("information functions", () => {
    it("should evaluate ISNUMBER, ISTEXT, ISBLANK", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 42);
      Cell.setValue(ws, "A2", "text");
      // A3 left blank

      Cell.setValue(ws, "B1", { formula: "ISNUMBER(A1)", result: false });
      Cell.setValue(ws, "B2", { formula: "ISTEXT(A2)", result: false });
      Cell.setValue(ws, "B3", { formula: "ISBLANK(A3)", result: false });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(true);
      expect(Cell.getResult(ws, "B2")).toBe(true);
      expect(Cell.getResult(ws, "B3")).toBe(true);
    });
  });

  // ==========================================================================
  // Constant Formulas (no cell references)
  // ==========================================================================
  describe("constant formulas", () => {
    it("should evaluate formulas with only constants", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "1+1", result: 0 });
      Cell.setValue(ws, "A2", { formula: "PI()", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(2);
      expect(Cell.getResult(ws, "A2")).toBeCloseTo(Math.PI);
    });
  });

  // ==========================================================================
  // Unsupported Formulas (graceful fallback)
  // ==========================================================================
  describe("unsupported formulas", () => {
    it("should preserve cached result when function is not implemented", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Use a completely made-up function name that will never be implemented
      Cell.setValue(ws, "A1", {
        formula: "XYZNONEXISTENT(1,2,3)",
        result: 42
      });

      calculateFormulas(wb);

      // The engine cannot evaluate this formula, so it must preserve
      // the original cached result (42) rather than overwriting with #NAME?
      expect(Cell.getResult(ws, "A1")).toBe(42);
    });

    it("should return #NAME? when no cached result exists", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", {
        formula: "XYZNONEXISTENT(1,2,3)"
      });

      calculateFormulas(wb);

      // No cached result to preserve — #NAME? is the only option
      expect(Cell.getResult(ws, "A1")).toEqual({ error: "#NAME?" });
    });
  });

  // ==========================================================================
  // ROW() and COLUMN()
  // ==========================================================================
  describe("ROW and COLUMN functions", () => {
    it("should evaluate ROW with cell reference", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "ROW(B5)", result: 0 });
      Cell.setValue(ws, "A2", { formula: "COLUMN(D1)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(5);
      expect(Cell.getResult(ws, "A2")).toBe(4);
    });
  });

  // ==========================================================================
  // Empty cells in ranges
  // ==========================================================================
  describe("empty cells in ranges", () => {
    it("should treat empty cells as 0 in SUM", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      // A2 intentionally left empty
      Cell.setValue(ws, "A3", 30);
      Cell.setValue(ws, "A4", { formula: "SUM(A1:A3)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A4")).toBe(40);
    });
  });

  // ==========================================================================
  // Boolean values in formulas
  // ==========================================================================
  describe("boolean values", () => {
    it("should handle TRUE and FALSE in arithmetic", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "TRUE+TRUE", result: 0 });
      Cell.setValue(ws, "A2", { formula: "FALSE+1", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(2);
      expect(Cell.getResult(ws, "A2")).toBe(1);
    });
  });

  // ==========================================================================
  // C1 fix: formula with no initial cached result
  // ==========================================================================
  describe("formula with undefined initial result", () => {
    it("should write result even when formula had no cached result", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      // Formula with NO initial result (result is undefined)
      Cell.setValue(ws, "A3", { formula: "A1+A2" });

      expect(Cell.getResult(ws, "A3")).toBeUndefined();

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A3")).toBe(30);
    });
  });

  // ==========================================================================
  // C2 fix: recursive dependency persists results
  // ==========================================================================
  describe("recursive dependency result persistence", () => {
    it("should persist results for cells evaluated as dependencies", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 5);
      // A2 depends on A1, A3 depends on A2, A4 depends on A3
      // If A4 is evaluated first, it should trigger A3 → A2 recursively
      // and all intermediate results should be persisted
      Cell.setValue(ws, "A2", { formula: "A1*2", result: 0 }); // 10
      Cell.setValue(ws, "A3", { formula: "A2+3", result: 0 }); // 13
      Cell.setValue(ws, "A4", { formula: "A3+7", result: 0 }); // 20

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe(10);
      expect(Cell.getResult(ws, "A3")).toBe(13);
      expect(Cell.getResult(ws, "A4")).toBe(20);
    });
  });

  // ==========================================================================
  // I2 fix: circular reference returns 0 (not #REF!)
  // ==========================================================================
  describe("circular reference returns 0", () => {
    it("should return 0 for circular references like Excel", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "A2+1", result: 0 });
      Cell.setValue(ws, "A2", { formula: "A1+1", result: 0 });

      calculateFormulas(wb);

      // Excel returns 0 for circular references, not #REF!
      // At least one cell in the cycle should resolve to a number
      const r1 = Cell.getResult(ws, "A1");
      const r2 = Cell.getResult(ws, "A2");
      // Both cells in the cycle should resolve to numbers
      expect(typeof r1).toBe("number");
      expect(typeof r2).toBe("number");
    });
  });

  // ==========================================================================
  // I6 fix: RIGHT(text, 0) returns ""
  // ==========================================================================
  describe("RIGHT edge cases", () => {
    it("should return empty string for RIGHT(text, 0)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "Hello");
      Cell.setValue(ws, "B1", { formula: "RIGHT(A1,0)", result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe("");
    });
  });

  // ==========================================================================
  // I1 fix: session isolation (no global state pollution)
  // ==========================================================================
  describe("session isolation", () => {
    it("should correctly calculate two workbooks independently", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Sheet1");
      Cell.setValue(ws1, "A1", 100);
      Cell.setValue(ws1, "A2", { formula: "A1*2", result: 0 });

      const wb2 = Workbook.create();
      const ws2 = Workbook.addWorksheet(wb2, "Sheet1");
      Cell.setValue(ws2, "A1", 999);
      Cell.setValue(ws2, "A2", { formula: "A1*3", result: 0 });

      calculateFormulas(wb1);
      calculateFormulas(wb2);

      expect(Cell.getResult(ws1, "A2")).toBe(200);
      expect(Cell.getResult(ws2, "A2")).toBe(2997);
    });
  });

  // ==========================================================================
  // Memoization: same formula cell is not evaluated twice
  // ==========================================================================
  describe("memoization", () => {
    it("should not produce different results when a cell is referenced multiple times", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 7);
      Cell.setValue(ws, "A2", { formula: "A1*A1", result: 0 }); // 49
      Cell.setValue(ws, "B1", { formula: "A2+A2", result: 0 }); // 98 (references A2 twice)

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe(49);
      expect(Cell.getResult(ws, "B1")).toBe(98);
    });
  });

  // ==========================================================================
  // Conditional Functions: SUMIF, COUNTIF, AVERAGEIF, SUMIFS, COUNTIFS
  // ==========================================================================
  describe("conditional aggregate functions", () => {
    it("should evaluate SUMIF", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "Apple");
      Cell.setValue(ws, "A2", "Banana");
      Cell.setValue(ws, "A3", "Apple");
      Cell.setValue(ws, "B1", 10);
      Cell.setValue(ws, "B2", 20);
      Cell.setValue(ws, "B3", 30);
      Cell.setValue(ws, "C1", { formula: 'SUMIF(A1:A3,"Apple",B1:B3)', result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toBe(40);
    });

    it("should evaluate SUMIF with operator criteria", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 5);
      Cell.setValue(ws, "A2", 15);
      Cell.setValue(ws, "A3", 25);
      Cell.setValue(ws, "B1", { formula: 'SUMIF(A1:A3,">10")', result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(40);
    });

    it("should evaluate COUNTIF", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "Yes");
      Cell.setValue(ws, "A2", "No");
      Cell.setValue(ws, "A3", "Yes");
      Cell.setValue(ws, "A4", "Yes");
      Cell.setValue(ws, "B1", { formula: 'COUNTIF(A1:A4,"Yes")', result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(3);
    });

    it("should evaluate COUNTIFS", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "A");
      Cell.setValue(ws, "A2", "B");
      Cell.setValue(ws, "A3", "A");
      Cell.setValue(ws, "B1", 10);
      Cell.setValue(ws, "B2", 20);
      Cell.setValue(ws, "B3", 30);
      Cell.setValue(ws, "C1", { formula: 'COUNTIFS(A1:A3,"A",B1:B3,">5")', result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toBe(2);
    });

    it("should evaluate AVERAGEIF", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);
      Cell.setValue(ws, "B1", { formula: 'AVERAGEIF(A1:A3,">15")', result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(25);
    });
  });

  // ==========================================================================
  // Statistical Functions: MEDIAN, LARGE, SMALL, STDEV
  // ==========================================================================
  describe("statistical functions", () => {
    it("should evaluate MEDIAN", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 5);
      Cell.setValue(ws, "A3", 3);
      Cell.setValue(ws, "A4", 7);
      Cell.setValue(ws, "A5", 9);
      Cell.setValue(ws, "B1", { formula: "MEDIAN(A1:A5)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(5);
    });

    it("should evaluate LARGE and SMALL", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 30);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "B1", { formula: "LARGE(A1:A3,1)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "SMALL(A1:A3,1)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(30);
      expect(Cell.getResult(ws, "B2")).toBe(10);
    });
  });

  // ==========================================================================
  // Dynamic Array Functions: FILTER, SORT, UNIQUE
  // ==========================================================================
  describe("dynamic array functions", () => {
    it("should evaluate FILTER", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "Apple");
      Cell.setValue(ws, "A2", "Banana");
      Cell.setValue(ws, "A3", "Cherry");
      Cell.setValue(ws, "B1", 1);
      Cell.setValue(ws, "B2", 0);
      Cell.setValue(ws, "B3", 1);
      // _xlfn._xlws.FILTER — the dynamic array function
      Cell.setValue(ws, "D1", { formula: "_xlfn._xlws.FILTER(A1:A3,B1:B3)", result: "" });

      calculateFormulas(wb);

      // FILTER returns an array; result should reflect the first element
      // since evaluateFormula unwraps to scalar
      expect(Cell.getResult(ws, "D1")).toBe("Apple");
    });

    it("should evaluate SORT", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "B1", { formula: "_xlfn._xlws.SORT(A1:A3)", result: 0 });

      calculateFormulas(wb);

      // Result is first element of sorted array
      expect(Cell.getResult(ws, "B1")).toBe(10);
    });

    it("should evaluate UNIQUE", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "A");
      Cell.setValue(ws, "A2", "B");
      Cell.setValue(ws, "A3", "A");
      Cell.setValue(ws, "A4", "C");
      Cell.setValue(ws, "B1", { formula: "_xlfn._xlws.UNIQUE(A1:A4)", result: "" });

      calculateFormulas(wb);

      // First unique element
      expect(Cell.getResult(ws, "B1")).toBe("A");
    });
  });

  // ==========================================================================
  // Date Functions: DATE, TIME, HOUR, MINUTE, SECOND, WEEKDAY, EOMONTH
  // ==========================================================================
  describe("date/time functions", () => {
    it("should evaluate DATE", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "YEAR(DATE(2024,3,15))", result: 0 });
      Cell.setValue(ws, "A2", { formula: "MONTH(DATE(2024,3,15))", result: 0 });
      Cell.setValue(ws, "A3", { formula: "DAY(DATE(2024,3,15))", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(2024);
      expect(Cell.getResult(ws, "A2")).toBe(3);
      expect(Cell.getResult(ws, "A3")).toBe(15);
    });

    it("should evaluate TIME, HOUR, MINUTE, SECOND", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "TIME(14,30,45)", result: 0 });
      Cell.setValue(ws, "A2", { formula: "HOUR(TIME(14,30,45))", result: 0 });
      Cell.setValue(ws, "A3", { formula: "MINUTE(TIME(14,30,45))", result: 0 });
      Cell.setValue(ws, "A4", { formula: "SECOND(TIME(14,30,45))", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe(14);
      expect(Cell.getResult(ws, "A3")).toBe(30);
      expect(Cell.getResult(ws, "A4")).toBe(45);
    });
  });

  // ==========================================================================
  // Additional Math: TRUNC, GCD, LCM, SUMSQ
  // ==========================================================================
  describe("additional math functions", () => {
    it("should evaluate TRUNC", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "TRUNC(3.789,2)", result: 0 });
      Cell.setValue(ws, "A2", { formula: "TRUNC(-3.789)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(3.78);
      expect(Cell.getResult(ws, "A2")).toBe(-3);
    });

    it("should evaluate GCD and LCM", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "GCD(12,18)", result: 0 });
      Cell.setValue(ws, "A2", { formula: "LCM(4,6)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(6);
      expect(Cell.getResult(ws, "A2")).toBe(12);
    });
  });

  // ==========================================================================
  // TEXT function enhancements
  // ==========================================================================
  describe("TEXT function", () => {
    it("should format percentages", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 0.75);
      Cell.setValue(ws, "B1", { formula: 'TEXT(A1,"0%")', result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe("75%");
    });

    it("should format with thousands separator", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 1234567.89);
      Cell.setValue(ws, "B1", { formula: 'TEXT(A1,"#,##0.00")', result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe("1,234,567.89");
    });
  });

  // ==========================================================================
  // MATCH with approximate match
  // ==========================================================================
  describe("MATCH approximate match", () => {
    it("should find approximate match in sorted ascending data", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);
      Cell.setValue(ws, "A4", 40);
      Cell.setValue(ws, "B1", { formula: "MATCH(25,A1:A4,1)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(2); // 20 is the largest <= 25
    });
  });

  // ==========================================================================
  // T2: IF short-circuit — should not evaluate unused branch
  // ==========================================================================
  describe("IF short-circuit", () => {
    it("should not return error from un-taken IF branch", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 0);
      // IF(TRUE, 1, 1/A1) — false branch would be #DIV/0! but should not be evaluated
      Cell.setValue(ws, "B1", { formula: "IF(TRUE,1,1/A1)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(1);
    });

    it("should evaluate IFERROR correctly with error in first arg", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 0);
      Cell.setValue(ws, "B1", { formula: 'IFERROR(1/A1,"safe")', result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe("safe");
    });

    it("should evaluate IFERROR correctly with non-error in first arg", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 2);
      Cell.setValue(ws, "B1", { formula: 'IFERROR(1/A1,"safe")', result: "" });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(0.5);
    });
  });

  // ==========================================================================
  // T4: SUMPRODUCT test
  // ==========================================================================
  describe("SUMPRODUCT", () => {
    it("should calculate SUMPRODUCT of two ranges", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "A3", 3);
      Cell.setValue(ws, "B1", 4);
      Cell.setValue(ws, "B2", 5);
      Cell.setValue(ws, "B3", 6);
      // SUMPRODUCT = 1*4 + 2*5 + 3*6 = 4+10+18 = 32
      Cell.setValue(ws, "C1", { formula: "SUMPRODUCT(A1:A3,B1:B3)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toBe(32);
    });
  });

  // ==========================================================================
  // T5: Shared formulas
  // ==========================================================================
  describe("shared formulas", () => {
    it("should calculate shared formulas via fillFormula", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);
      // B1:B3 as shared formula B1=A1*2, B2=A2*2, B3=A3*2
      Worksheet.fillFormula(ws, "B1:B3", "A1*2", [20, 40, 60]);

      // Override A values — cached results should be stale
      Cell.setValue(ws, "A1", 100);
      Cell.setValue(ws, "A2", 200);
      Cell.setValue(ws, "A3", 300);

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(200);
      expect(Cell.getResult(ws, "B2")).toBe(400);
      expect(Cell.getResult(ws, "B3")).toBe(600);
    });
  });

  // ==========================================================================
  // B3 regression: SUM should ignore booleans in ranges
  // ==========================================================================
  describe("SUM ignores booleans in ranges", () => {
    it("should not count TRUE as 1 in a range", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", true);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "B1", { formula: "SUM(A1:A3)", result: 0 });

      calculateFormulas(wb);

      // Excel: SUM over a range ignores TRUE — result should be 30, not 31
      expect(Cell.getResult(ws, "B1")).toBe(30);
    });

    it("should count TRUE as 1 when passed as direct argument", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "SUM(10,TRUE,20)", result: 0 });

      calculateFormulas(wb);

      // Direct argument: TRUE → 1, so 10+1+20 = 31
      expect(Cell.getResult(ws, "A1")).toBe(31);
    });
  });

  // ==========================================================================
  // Unary minus vs exponentiation precedence
  // ==========================================================================
  describe("unary minus vs exponentiation", () => {
    it("should parse -1^2 as (-1)^2 = 1 (Excel's unique precedence)", () => {
      // Regression: Excel's precedence table ranks "Negation (as in –1)"
      // at rank 1 — tighter than exponentiation (rank 4). So `=-1^2` is
      // `(-1)^2 = 1`, not `-(1^2) = -1`. The engine used to parse
      // unary-minus at precedence 55 (below `^`'s 60/61), producing
      // `-(1^2)` — matching Python/C but not Excel.
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", { formula: "-1^2", result: 0 });
      Cell.setValue(ws, "A2", { formula: "-2^3", result: 0 });
      Cell.setValue(ws, "A3", { formula: "-2^2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(1); // (-1)^2 = 1
      expect(Cell.getResult(ws, "A2")).toBe(-8); // (-2)^3 = -8 (happens to match either way)
      expect(Cell.getResult(ws, "A3")).toBe(4); // (-2)^2 = 4 — key case
    });

    it("should parse -A1^2 as (-A1)^2 (Excel)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 3);
      Cell.setValue(ws, "B1", { formula: "-A1^2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(9); // (-3)^2 = 9
    });
  });

  // ==========================================================================
  // Quoted sheet names with spaces
  // ==========================================================================
  describe("quoted sheet names", () => {
    it("should resolve 'Sheet Name'!A1 with spaces", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "My Data");
      const ws2 = Workbook.addWorksheet(wb, "Results");

      Cell.setValue(ws1, "A1", 100);
      Cell.setValue(ws1, "A2", 200);
      Cell.setValue(ws2, "A1", { formula: "SUM('My Data'!A1:A2)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws2, "A1")).toBe(300);
    });
  });

  // ==========================================================================
  // XLSX Round-trip Integration: write → read → recalculate
  // ==========================================================================
  describe("xlsx round-trip", () => {
    it("should recalculate formulas after write+read round-trip", async () => {
      // Build a workbook with formulas
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Sheet1");
      Cell.setValue(ws1, "A1", 10);
      Cell.setValue(ws1, "A2", 20);
      Cell.setValue(ws1, "A3", { formula: "SUM(A1:A2)", result: 30 });
      Cell.setValue(ws1, "B1", { formula: "A3*2", result: 60 });

      // Write to buffer
      const buffer = await Workbook.toBuffer(wb1);

      // Read back
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer as Buffer);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

      // Modify data cells — cached results are now stale
      Cell.setValue(ws2, "A1", 100);
      Cell.setValue(ws2, "A2", 200);

      // Recalculate
      calculateFormulas(wb2);

      expect(Cell.getResult(ws2, "A3")).toBe(300);
      expect(Cell.getResult(ws2, "B1")).toBe(600);
    });
  });

  // ==========================================================================
  // Edge cases: empty workbook, no formulas, formula-only
  // ==========================================================================
  describe("edge cases", () => {
    it("should handle workbook with no worksheets", () => {
      const wb = Workbook.create();
      expect(() => calculateFormulas(wb)).not.toThrow();
    });

    it("should handle worksheet with no formulas", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 42);
      Cell.setValue(ws, "A2", "hello");

      expect(() => calculateFormulas(wb)).not.toThrow();
    });

    it("should handle formula referencing empty cells", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      // Formula references cells that don't exist at all
      Cell.setValue(ws, "Z1", { formula: "SUM(A1:A100)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "Z1")).toBe(0);
    });
  });

  // ==========================================================================
  // Idempotency: calling calculateFormulas multiple times
  // ==========================================================================
  describe("idempotency", () => {
    it("should produce same results when called multiple times", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 5);
      Cell.setValue(ws, "A2", { formula: "A1*3", result: 0 });
      Cell.setValue(ws, "A3", { formula: "A2+A1", result: 0 });

      calculateFormulas(wb);
      const r1a = Cell.getResult(ws, "A2");
      const r1b = Cell.getResult(ws, "A3");

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A2")).toBe(r1a);
      expect(Cell.getResult(ws, "A3")).toBe(r1b);

      // Verify actual values
      expect(r1a).toBe(15);
      expect(r1b).toBe(20);
    });
  });

  // ==========================================================================
  // Deep dependency chain (>10 levels)
  // ==========================================================================
  describe("deep dependency chain", () => {
    it("should handle 50-level deep formula chain without stack overflow", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 1);
      for (let i = 2; i <= 50; i++) {
        Cell.setValue(ws, `A${i}`, { formula: `A${i - 1}+1`, result: 0 });
      }

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A50")).toBe(50);
    });
  });

  // ==========================================================================
  // INDEX + MATCH combination
  // ==========================================================================
  describe("INDEX+MATCH", () => {
    it("should evaluate INDEX(MATCH()) combination", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Lookup table
      Cell.setValue(ws, "A1", "Alpha");
      Cell.setValue(ws, "A2", "Beta");
      Cell.setValue(ws, "A3", "Gamma");
      Cell.setValue(ws, "B1", 100);
      Cell.setValue(ws, "B2", 200);
      Cell.setValue(ws, "B3", 300);

      // INDEX(B1:B3, MATCH("Beta", A1:A3, 0))
      Cell.setValue(ws, "D1", {
        formula: 'INDEX(B1:B3,MATCH("Beta",A1:A3,0))',
        result: 0
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "D1")).toBe(200);
    });
  });

  // ==========================================================================
  // Complex nested: IF + AND + VLOOKUP
  // ==========================================================================
  describe("complex nested formulas", () => {
    it("should evaluate IF(AND(...), VLOOKUP(...), ...)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Lookup table
      Cell.setValue(ws, "A1", "X");
      Cell.setValue(ws, "B1", 10);
      Cell.setValue(ws, "A2", "Y");
      Cell.setValue(ws, "B2", 20);

      // Conditions
      Cell.setValue(ws, "D1", true);
      Cell.setValue(ws, "D2", true);

      // IF(AND(D1,D2), VLOOKUP("Y",A1:B2,2,FALSE), -1)
      Cell.setValue(ws, "E1", {
        formula: 'IF(AND(D1,D2),VLOOKUP("Y",A1:B2,2,FALSE),-1)',
        result: 0
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "E1")).toBe(20);
    });

    it("should take else branch when condition is false", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "X");
      Cell.setValue(ws, "B1", 10);
      Cell.setValue(ws, "D1", true);
      Cell.setValue(ws, "D2", false); // AND will be false

      Cell.setValue(ws, "E1", {
        formula: 'IF(AND(D1,D2),VLOOKUP("X",A1:B1,2,FALSE),-1)',
        result: 0
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "E1")).toBe(-1);
    });
  });

  // ==========================================================================
  // Statistical functions: STDEV, VAR
  // ==========================================================================
  describe("STDEV and VAR", () => {
    it("should calculate STDEV.S (sample standard deviation)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 2);
      Cell.setValue(ws, "A2", 4);
      Cell.setValue(ws, "A3", 4);
      Cell.setValue(ws, "A4", 4);
      Cell.setValue(ws, "A5", 5);
      Cell.setValue(ws, "A6", 5);
      Cell.setValue(ws, "A7", 7);
      Cell.setValue(ws, "A8", 9);
      Cell.setValue(ws, "B1", { formula: "STDEV(A1:A8)", result: 0 });

      calculateFormulas(wb);

      // stdev.s of [2,4,4,4,5,5,7,9]: mean=5, Σ(xi-mean)²=32, s²=32/7≈4.571, s≈2.138
      expect(Cell.getResult(ws, "B1")).toBeCloseTo(2.138, 2);
    });

    it("should calculate VAR.S (sample variance)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 2);
      Cell.setValue(ws, "A2", 4);
      Cell.setValue(ws, "A3", 4);
      Cell.setValue(ws, "A4", 4);
      Cell.setValue(ws, "A5", 5);
      Cell.setValue(ws, "A6", 5);
      Cell.setValue(ws, "A7", 7);
      Cell.setValue(ws, "A8", 9);
      Cell.setValue(ws, "B1", { formula: "VAR(A1:A8)", result: 0 });

      calculateFormulas(wb);

      // var.s = 32/7 ≈ 4.571
      expect(Cell.getResult(ws, "B1")).toBeCloseTo(4.571, 2);
    });
  });

  // ==========================================================================
  // Date functions: DATEDIF, EOMONTH, EDATE
  // ==========================================================================
  describe("DATEDIF, EOMONTH, EDATE", () => {
    it("should calculate DATEDIF in years", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // DATEDIF(DATE(2020,1,1), DATE(2024,6,15), "Y") = 4 years
      Cell.setValue(ws, "A1", {
        formula: 'DATEDIF(DATE(2020,1,1),DATE(2024,6,15),"Y")',
        result: 0
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(4);
    });

    it("should calculate EOMONTH", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // EOMONTH(DATE(2024,1,15), 2) → end of March 2024 = 2024-03-31
      // Then extract DAY to verify
      Cell.setValue(ws, "A1", {
        formula: "DAY(EOMONTH(DATE(2024,1,15),2))",
        result: 0
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(31); // March has 31 days
    });

    it("should calculate EDATE", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // EDATE(DATE(2024,1,15), 3) → 2024-04-15
      Cell.setValue(ws, "A1", {
        formula: "MONTH(EDATE(DATE(2024,1,15),3))",
        result: 0
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(4); // April
    });
  });

  // ==========================================================================
  // Dynamic Array Spill Engine
  // ==========================================================================
  describe("dynamic array spill engine", () => {
    it("should spill FILTER results to adjacent cells", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Data in A1:B3
      Cell.setValue(ws, "A1", "Apple");
      Cell.setValue(ws, "A2", "Banana");
      Cell.setValue(ws, "A3", "Cherry");
      Cell.setValue(ws, "B1", 1);
      Cell.setValue(ws, "B2", 0);
      Cell.setValue(ws, "B3", 1);

      // Dynamic array formula in D1
      Cell.setValue(ws, "D1", {
        formula: "_xlfn._xlws.FILTER(A1:A3,B1:B3)",
        result: "",
        shareType: "array",
        ref: "D1",
        isDynamicArray: true
      });

      calculateFormulas(wb);

      // Should spill: D1=Apple, D2=Cherry
      expect(Cell.getResult(ws, "D1")).toBe("Apple");
      expect(Cell.getValue(ws, "D2")).toBe("Cherry");
    });

    it("should spill SORT results to adjacent cells", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);

      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);
      expect(Cell.getValue(ws, "C3")).toBe(30);
    });

    it("should spill UNIQUE results to adjacent cells", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "A");
      Cell.setValue(ws, "A2", "B");
      Cell.setValue(ws, "A3", "A");
      Cell.setValue(ws, "A4", "C");

      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.UNIQUE(A1:A4)",
        result: "",
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toBe("A");
      expect(Cell.getValue(ws, "C2")).toBe("B");
      expect(Cell.getValue(ws, "C3")).toBe("C");
    });

    it("should produce #SPILL! error when target cells are occupied", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);

      // Put data in C2 — this will conflict with spill from C1
      Cell.setValue(ws, "C2", "blocked");

      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      calculateFormulas(wb);

      // Should get #SPILL! because C2 is occupied
      expect(Cell.getResult(ws, "C1")).toEqual({ error: "#SPILL!" });
    });

    it("should spill multi-column results", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // 2-column data
      Cell.setValue(ws, "A1", "Apple");
      Cell.setValue(ws, "B1", 1.5);
      Cell.setValue(ws, "A2", "Banana");
      Cell.setValue(ws, "B2", 0.75);
      Cell.setValue(ws, "A3", "Cherry");
      Cell.setValue(ws, "B3", 3.0);

      // Include mask
      Cell.setValue(ws, "C1", 1);
      Cell.setValue(ws, "C2", 0);
      Cell.setValue(ws, "C3", 1);

      Cell.setValue(ws, "E1", {
        formula: "_xlfn._xlws.FILTER(A1:B3,C1:C3)",
        result: "",
        shareType: "array",
        ref: "E1",
        isDynamicArray: true
      });

      calculateFormulas(wb);

      // Should spill 2x2: E1:F2
      expect(Cell.getResult(ws, "E1")).toBe("Apple");
      expect(Cell.getValue(ws, "F1")).toBe(1.5);
      expect(Cell.getValue(ws, "E2")).toBe("Cherry");
      expect(Cell.getValue(ws, "F2")).toBe(3.0);
    });

    it("should handle scalar result from dynamic array formula", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "OnlyOne");
      Cell.setValue(ws, "B1", 1);

      Cell.setValue(ws, "D1", {
        formula: "_xlfn._xlws.FILTER(A1:A1,B1:B1)",
        result: "",
        shareType: "array",
        ref: "D1",
        isDynamicArray: true
      });

      calculateFormulas(wb);

      // Single result — no spill needed
      expect(Cell.getResult(ws, "D1")).toBe("OnlyOne");
    });

    it("should drop stale spill ghosts when source changes to non-dynamic formula", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "X1", 10);
      Cell.setValue(ws, "X2", 20);
      Cell.setValue(ws, "X3", 30);
      // First: A1 is a dynamic array that spills to A1:A3
      Cell.setValue(ws, "A1", {
        formula: "_xlfn._xlws.SORT(X1:X3)",
        result: 0,
        shareType: "array",
        ref: "A1",
        isDynamicArray: true
      });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1")).toBe(10);
      // Ghost cells populated
      expect(Cell.getValue(ws, "A2")).toBe(20);
      expect(Cell.getValue(ws, "A3")).toBe(30);

      // Replace A1 with a non-dynamic formula
      Cell.setValue(ws, "A1", { formula: "SUM(X1:X3)", result: 0 });
      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(60);
      // Ghost cells should be cleared
      expect(cellValueOrNull(findCell(ws, 2, 1))).toBeNull();
      expect(cellValueOrNull(findCell(ws, 3, 1))).toBeNull();
    });
  });

  // ==========================================================================
  // CSE Array Formulas
  // ==========================================================================
  describe("CSE array formulas", () => {
    it("should distribute array formula results across ref range", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Data
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "A3", 3);
      Cell.setValue(ws, "B1", 10);
      Cell.setValue(ws, "B2", 20);
      Cell.setValue(ws, "B3", 30);

      // CSE array formula: {=A1:A3*B1:B3} in C1:C3
      // Master cell at C1 with ref="C1:C3"
      Cell.setValue(ws, "C1", {
        formula: "A1:A3*B1:B3",
        result: 0,
        shareType: "array",
        ref: "C1:C3"
      });
      // Slave cells — shared formula referencing master
      Cell.setValue(ws, "C2", {
        formula: "A1:A3*B1:B3",
        result: 0,
        shareType: "array"
      });
      Cell.setValue(ws, "C3", {
        formula: "A1:A3*B1:B3",
        result: 0,
        shareType: "array"
      });

      calculateFormulas(wb);

      // Array multiplication: [1*10, 2*20, 3*30] = [10, 40, 90]
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getResult(ws, "C2")).toBe(40);
      expect(Cell.getResult(ws, "C3")).toBe(90);
    });

    it("should fill CSE range with scalar when formula returns scalar", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // CSE formula that returns a scalar: {=SUM(A1:A3)} in B1:B3
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);

      Cell.setValue(ws, "B1", {
        formula: "SUM(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "B1:B3"
      });
      Cell.setValue(ws, "B2", {
        formula: "SUM(A1:A3)",
        result: 0,
        shareType: "array"
      });
      Cell.setValue(ws, "B3", {
        formula: "SUM(A1:A3)",
        result: 0,
        shareType: "array"
      });

      calculateFormulas(wb);

      // All cells in ref range get the same scalar value
      expect(Cell.getResult(ws, "B1")).toBe(60);
      expect(Cell.getResult(ws, "B2")).toBe(60);
      expect(Cell.getResult(ws, "B3")).toBe(60);
    });
  });

  // ==========================================================================
  // Array Arithmetic Broadcasting
  // ==========================================================================
  describe("array arithmetic broadcasting", () => {
    it("should broadcast scalar * array", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "A3", 3);

      // CSE: {=A1:A3*10} — scalar broadcast
      Cell.setValue(ws, "B1", {
        formula: "A1:A3*10",
        result: 0,
        shareType: "array",
        ref: "B1:B3"
      });
      Cell.setValue(ws, "B2", {
        formula: "A1:A3*10",
        result: 0,
        shareType: "array"
      });
      Cell.setValue(ws, "B3", {
        formula: "A1:A3*10",
        result: 0,
        shareType: "array"
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(10);
      expect(Cell.getResult(ws, "B2")).toBe(20);
      expect(Cell.getResult(ws, "B3")).toBe(30);
    });

    it("should broadcast row + column to produce matrix", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Row: A1:C1 = {1, 2, 3}
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "B1", 2);
      Cell.setValue(ws, "C1", 3);

      // Column: A3:A5 = {10; 20; 30}
      Cell.setValue(ws, "A3", 10);
      Cell.setValue(ws, "A4", 20);
      Cell.setValue(ws, "A5", 30);

      // Dynamic array: A1:C1 + A3:A5 should produce 3x3 matrix
      Cell.setValue(ws, "E1", {
        formula: "A1:C1+A3:A5",
        result: 0,
        shareType: "array",
        ref: "E1",
        isDynamicArray: true
      });

      calculateFormulas(wb);

      // Broadcasting: each row of column + each col of row
      // Row 0: 10+1=11, 10+2=12, 10+3=13
      expect(Cell.getResult(ws, "E1")).toBe(11);
      expect(Cell.getValue(ws, "F1")).toBe(12);
      expect(Cell.getValue(ws, "G1")).toBe(13);
      // Row 1: 20+1=21, 20+2=22, 20+3=23
      expect(Cell.getValue(ws, "E2")).toBe(21);
      expect(Cell.getValue(ws, "F2")).toBe(22);
      expect(Cell.getValue(ws, "G2")).toBe(23);
      // Row 2: 30+1=31, 30+2=32, 30+3=33
      expect(Cell.getValue(ws, "E3")).toBe(31);
      expect(Cell.getValue(ws, "F3")).toBe(32);
      expect(Cell.getValue(ws, "G3")).toBe(33);
    });

    it("should handle element-wise operations on same-sized arrays", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "A3", 3);
      Cell.setValue(ws, "B1", 10);
      Cell.setValue(ws, "B2", 20);
      Cell.setValue(ws, "B3", 30);

      // CSE: {=A1:A3+B1:B3}
      Cell.setValue(ws, "C1", {
        formula: "A1:A3+B1:B3",
        result: 0,
        shareType: "array",
        ref: "C1:C3"
      });
      Cell.setValue(ws, "C2", {
        formula: "A1:A3+B1:B3",
        result: 0,
        shareType: "array"
      });
      Cell.setValue(ws, "C3", {
        formula: "A1:A3+B1:B3",
        result: 0,
        shareType: "array"
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toBe(11);
      expect(Cell.getResult(ws, "C2")).toBe(22);
      expect(Cell.getResult(ws, "C3")).toBe(33);
    });

    it("should apply unary minus element-wise on arrays", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "A3", 3);

      // CSE: {=-A1:A3}
      Cell.setValue(ws, "B1", {
        formula: "-A1:A3",
        result: 0,
        shareType: "array",
        ref: "B1:B3"
      });
      Cell.setValue(ws, "B2", {
        formula: "-A1:A3",
        result: 0,
        shareType: "array"
      });
      Cell.setValue(ws, "B3", {
        formula: "-A1:A3",
        result: 0,
        shareType: "array"
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(-1);
      expect(Cell.getResult(ws, "B2")).toBe(-2);
      expect(Cell.getResult(ws, "B3")).toBe(-3);
    });
  });

  // ==========================================================================
  // Implicit Intersection
  // ==========================================================================
  describe("implicit intersection", () => {
    it("should use implicit intersection for range in scalar context", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Column data A1:A3
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);

      // Formulas in B1:B3 that reference A1:A3 in a scalar context
      // B1 should pick A1 (same row), B2→A2, B3→A3
      Cell.setValue(ws, "B1", { formula: "A1:A3+100", result: 0 });
      Cell.setValue(ws, "B2", { formula: "A1:A3+100", result: 0 });
      Cell.setValue(ws, "B3", { formula: "A1:A3+100", result: 0 });

      calculateFormulas(wb);

      // Implicit intersection: each formula picks the element from its own row
      expect(Cell.getResult(ws, "B1")).toBe(110);
      expect(Cell.getResult(ws, "B2")).toBe(120);
      expect(Cell.getResult(ws, "B3")).toBe(130);
    });
  });

  // ==========================================================================
  // Spill cleanup on re-evaluation
  // ==========================================================================
  describe("spill idempotency", () => {
    it("should produce correct results on repeated calculateFormulas calls", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);

      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);
      expect(Cell.getValue(ws, "C3")).toBe(30);

      // Recalculate — should produce identical results
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);
      expect(Cell.getValue(ws, "C3")).toBe(30);
    });
  });

  // ==========================================================================
  // Spill data safety: user-written data must not be silently destroyed
  // ==========================================================================
  describe("spill data safety", () => {
    it("should return #SPILL! when user writes into a former ghost cell", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Set up source data and a SORT formula that spills 3 rows
      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      // First calculation — spills to C1:C3
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);
      expect(Cell.getValue(ws, "C3")).toBe(30);

      // User writes a formula into C2 (a former ghost cell)
      Cell.setValue(ws, "C2", { formula: "42+1", result: 0 });

      // Recalculate — should detect conflict and return #SPILL!, not overwrite
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toEqual({ error: "#SPILL!" });
      // User's formula in C2 must be preserved
      expect(Cell.getResult(ws, "C2")).toBe(43);
    });

    it("should clean up old ghost cells when spill region shrinks", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // FILTER that initially returns 3 results
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);
      Cell.setValue(ws, "B1", 1);
      Cell.setValue(ws, "B2", 1);
      Cell.setValue(ws, "B3", 1);
      Cell.setValue(ws, "D1", {
        formula: "_xlfn._xlws.FILTER(A1:A3,B1:B3)",
        result: 0,
        shareType: "array",
        ref: "D1",
        isDynamicArray: true
      });

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "D1")).toBe(10);
      expect(Cell.getValue(ws, "D2")).toBe(20);
      expect(Cell.getValue(ws, "D3")).toBe(30);

      // Now change filter so only 1 result matches
      Cell.setValue(ws, "B2", 0);
      Cell.setValue(ws, "B3", 0);

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "D1")).toBe(10);
      // Old ghost cells must be cleared
      const d2 = findCell(ws, 2, 4); // D2
      const d3 = findCell(ws, 3, 4); // D3
      const d2Val = d2 ? cellGetValue(d2) : null;
      const d3Val = d3 ? cellGetValue(d3) : null;
      expect(d2Val).toBeNull();
      expect(d3Val).toBeNull();
    });

    it("should return #SPILL! when user writes a plain value into a former ghost cell", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Set up source data and a SORT formula that spills 3 rows
      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      // First calculation — spills to C1:C3
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);
      expect(Cell.getValue(ws, "C3")).toBe(30);

      // User writes a plain number into C2 (a former ghost cell)
      Cell.setValue(ws, "C2", 42);

      // Recalculate — should detect conflict and return #SPILL!, not overwrite
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toEqual({ error: "#SPILL!" });
      // User's value in C2 must be preserved
      expect(Cell.getValue(ws, "C2")).toBe(42);
    });

    it("should return #SPILL! when user writes a string into a former ghost cell", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);

      // User writes a string into C3
      Cell.setValue(ws, "C3", "user data");

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toEqual({ error: "#SPILL!" });
      expect(Cell.getValue(ws, "C3")).toBe("user data");
    });

    it("should not clear user-modified ghost cells when source formula is deleted", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      // First calculation — spills to C1:C3
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);
      expect(Cell.getValue(ws, "C3")).toBe(30);

      // User writes a plain value into C2
      Cell.setValue(ws, "C2", 99);

      // Delete the source formula (replace with a plain value)
      Cell.setValue(ws, "C1", "no formula");

      // Recalculate — stale cleanup should NOT clear user's C2 value
      calculateFormulas(wb);
      expect(Cell.getValue(ws, "C2")).toBe(99);
      // C3 was not modified by the user, so it should be cleaned up
      const c3 = findCell(ws, 3, 3); // C3
      const c3Val = c3 ? cellGetValue(c3) : null;
      expect(c3Val).toBeNull();
    });
  });

  // ==========================================================================
  // Spill stability across sheet rename / delete
  // ==========================================================================
  describe("spill stability across sheet rename and delete", () => {
    it("should preserve spill ghosts after renaming the sheet", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);
      expect(Cell.getValue(ws, "C3")).toBe(30);

      // Rename the sheet
      setSheetName(ws, "Renamed");

      // Recalculate — spill should still work correctly
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);
      expect(Cell.getValue(ws, "C3")).toBe(30);
    });

    it("should detect #SPILL! after rename when user modifies a ghost cell", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);

      // Rename the sheet, then user writes into a ghost cell
      setSheetName(ws, "Renamed");
      Cell.setValue(ws, "C2", "user data");

      // Recalculate — should detect conflict and return #SPILL!
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toEqual({ error: "#SPILL!" });
      expect(Cell.getValue(ws, "C2")).toBe("user data");
    });

    it("should clean up stale ghosts after rename when source formula is deleted", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 30);
      Cell.setValue(ws, "A2", 10);
      Cell.setValue(ws, "A3", 20);
      Cell.setValue(ws, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
      expect(Cell.getValue(ws, "C2")).toBe(20);
      expect(Cell.getValue(ws, "C3")).toBe(30);

      // User modifies C2 before rename
      Cell.setValue(ws, "C2", 99);

      // Rename the sheet, then delete the source formula
      setSheetName(ws, "Renamed");
      Cell.setValue(ws, "C1", "no formula");

      // Recalculate — stale cleanup should clear unmodified C3, preserve user C2
      calculateFormulas(wb);
      expect(Cell.getValue(ws, "C2")).toBe(99);
      const c3 = findCell(ws, 3, 3);
      const c3Val = c3 ? cellGetValue(c3) : null;
      expect(c3Val).toBeNull();
    });

    it("should not error when a sheet with spill data is deleted", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      const ws2 = Workbook.addWorksheet(wb, "Sheet2");

      Cell.setValue(ws1, "A1", 30);
      Cell.setValue(ws1, "A2", 10);
      Cell.setValue(ws1, "A3", 20);
      Cell.setValue(ws1, "C1", {
        formula: "_xlfn._xlws.SORT(A1:A3)",
        result: 0,
        shareType: "array",
        ref: "C1",
        isDynamicArray: true
      });

      // Put a formula on Sheet2 so calculateFormulas has something to process
      Cell.setValue(ws2, "A1", { formula: "1+1", result: 0 });

      calculateFormulas(wb);
      expect(Cell.getResult(ws1, "C1")).toBe(10);
      expect(Cell.getValue(ws1, "C2")).toBe(20);

      // Delete Sheet1 — spill metadata should be silently discarded
      Workbook.removeWorksheet(wb, ws1.id);

      // Recalculate — should not throw
      expect(() => calculateFormulas(wb)).not.toThrow();
      expect(Cell.getResult(ws2, "A1")).toBe(2);
    });
  });
  describe("whole-column and whole-row implicit intersection", () => {
    it("should use implicit intersection for whole-column reference (A:A*2)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);

      // B2 = A:A * 2 — implicit intersection should pick A2 (row 2)
      Cell.setValue(ws, "B1", { formula: "A:A*2", result: 0 });
      Cell.setValue(ws, "B2", { formula: "A:A*2", result: 0 });
      Cell.setValue(ws, "B3", { formula: "A:A*2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(20);
      expect(Cell.getResult(ws, "B2")).toBe(40);
      expect(Cell.getResult(ws, "B3")).toBe(60);
    });

    it("should use implicit intersection for whole-row reference (1:1+1)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 100);
      Cell.setValue(ws, "B1", 200);
      Cell.setValue(ws, "C1", 300);

      // A2, B2, C2 = 1:1 + 1 — implicit intersection picks column
      Cell.setValue(ws, "A2", { formula: "1:1+1", result: 0 });
      Cell.setValue(ws, "B2", { formula: "1:1+1", result: 0 });
      Cell.setValue(ws, "C2", { formula: "1:1+1", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe(101);
      expect(Cell.getResult(ws, "B2")).toBe(201);
      expect(Cell.getResult(ws, "C2")).toBe(301);
    });
  });

  // ==========================================================================
  // Self-referencing + iterative calculation
  // ==========================================================================
  describe("self-reference with iterative calculation", () => {
    it("should handle A1=A1+1 with iterate enabled", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Enable iterative calculation
      wb.calcProperties = {
        fullCalcOnLoad: false,
        iterate: true,
        iterateCount: 10,
        iterateDelta: 0
      };

      Cell.setValue(ws, "A1", { formula: "A1+1", result: 0 });

      calculateFormulas(wb);

      // Initial pass: circular ref returns 0 → 0+1=1
      // Then 10 iterations: 1→2→3→...→11
      expect(Cell.getResult(ws, "A1")).toBe(11);
    });

    it("should converge with iterateDelta", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      wb.calcProperties = {
        fullCalcOnLoad: false,
        iterate: true,
        iterateCount: 100,
        iterateDelta: 0.001
      };

      // A1 = A1 / 2 + 1 converges to 2
      Cell.setValue(ws, "A1", { formula: "A1/2+1", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBeCloseTo(2, 2);
    });
  });

  // ==========================================================================
  // Multi-area defined names
  // ==========================================================================
  describe("multi-area defined names", () => {
    it("should not silently truncate multi-area defined names", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "C1", 30);
      Cell.setValue(ws, "C2", 40);

      // Add a defined name with two non-adjacent ranges (separated by column B)
      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1:$A$2", "MyRange");
      definedNamesAdd(getDefinedNames(wb), "Sheet1!$C$1:$C$2", "MyRange");

      // Formula using the multi-area name
      Cell.setValue(ws, "D1", { formula: "SUM(MyRange)", result: 0 });

      calculateFormulas(wb);

      // Multi-area names are not supported — should NOT silently return
      // SUM of just the first range (which would be 30).
      // Our implementation returns #VALUE! for multi-area names.
      const result = Cell.getResult(ws, "D1");
      expect(result).toEqual({ error: "#VALUE!" });
    });

    it("should work correctly with single-area defined names", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);

      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1:$A$3", "MyRange");

      Cell.setValue(ws, "B1", { formula: "SUM(MyRange)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(60);
    });
  });

  // ==========================================================================
  // XLOOKUP reverse search and approximate match
  // ==========================================================================
  describe("XLOOKUP advanced modes", () => {
    it("should support reverse search (searchMode = -1)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Duplicate values — reverse search should find the last occurrence
      Cell.setValue(ws, "A1", "Apple");
      Cell.setValue(ws, "A2", "Banana");
      Cell.setValue(ws, "A3", "Apple");
      Cell.setValue(ws, "B1", 1);
      Cell.setValue(ws, "B2", 2);
      Cell.setValue(ws, "B3", 3);

      Cell.setValue(ws, "C1", {
        formula: 'XLOOKUP("Apple",A1:A3,B1:B3,,0,-1)',
        result: 0
      });

      calculateFormulas(wb);

      // Reverse search: should find the last "Apple" at row 3, return 3
      expect(Cell.getResult(ws, "C1")).toBe(3);
    });

    it("should support approximate match - next smaller (matchMode = -1)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);
      Cell.setValue(ws, "B1", "low");
      Cell.setValue(ws, "B2", "mid");
      Cell.setValue(ws, "B3", "high");

      // Look for 25 — next smaller is 20 → "mid"
      Cell.setValue(ws, "C1", {
        formula: "XLOOKUP(25,A1:A3,B1:B3,,-1)",
        result: 0
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toBe("mid");
    });

    it("should support approximate match - next larger (matchMode = 1)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);
      Cell.setValue(ws, "B1", "low");
      Cell.setValue(ws, "B2", "mid");
      Cell.setValue(ws, "B3", "high");

      // Look for 25 — next larger is 30 → "high"
      Cell.setValue(ws, "C1", {
        formula: "XLOOKUP(25,A1:A3,B1:B3,,1)",
        result: 0
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toBe("high");
    });
  });

  // ==========================================================================
  // Named range implicit intersection
  // ==========================================================================
  describe("named range implicit intersection", () => {
    it("should use implicit intersection when named range resolves to a column range", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);

      // Define MyCol as A1:A3
      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1:$A$3", "MyCol");

      // B1:B3 = MyCol * 2 — should pick the value from the formula's own row
      Cell.setValue(ws, "B1", { formula: "MyCol*2", result: 0 });
      Cell.setValue(ws, "B2", { formula: "MyCol*2", result: 0 });
      Cell.setValue(ws, "B3", { formula: "MyCol*2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(20); // A1*2
      expect(Cell.getResult(ws, "B2")).toBe(40); // A2*2
      expect(Cell.getResult(ws, "B3")).toBe(60); // A3*2
    });

    it("should use implicit intersection when named range resolves to a row range", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "B1", 20);
      Cell.setValue(ws, "C1", 30);

      // Define MyRow as A1:C1
      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1:$C$1", "MyRow");

      // A2:C2 = MyRow + 1 — should pick the value from the formula's own column
      Cell.setValue(ws, "A2", { formula: "MyRow+1", result: 0 });
      Cell.setValue(ws, "B2", { formula: "MyRow+1", result: 0 });
      Cell.setValue(ws, "C2", { formula: "MyRow+1", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe(11); // A1+1
      expect(Cell.getResult(ws, "B2")).toBe(21); // B1+1
      expect(Cell.getResult(ws, "C2")).toBe(31); // C1+1
    });
  });

  // ==========================================================================
  // Named range alias with iterative calculation
  // ==========================================================================
  describe("named range alias with iterative calculation", () => {
    it("should use circularFallback for self-reference through named range", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      wb.calcProperties = {
        fullCalcOnLoad: false,
        iterate: true,
        iterateCount: 10,
        iterateDelta: 0
      };

      // Foo -> A1, A1 = Foo + 1 (self-reference through named range)
      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1", "Foo");
      Cell.setValue(ws, "A1", { formula: "Foo+1", result: 0 });

      calculateFormulas(wb);

      // Same behavior as A1=A1+1: initial pass 0→1, then 10 iterations → 11
      expect(Cell.getResult(ws, "A1")).toBe(11);
    });

    it("should converge through named range alias", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      wb.calcProperties = {
        fullCalcOnLoad: false,
        iterate: true,
        iterateCount: 100,
        iterateDelta: 0.001
      };

      // Bar -> A1, A1 = Bar/2 + 1 converges to 2
      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1", "Bar");
      Cell.setValue(ws, "A1", { formula: "Bar/2+1", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBeCloseTo(2, 2);
    });
  });

  // ==========================================================================
  // Formula-based defined names
  // ==========================================================================
  describe("formula-based defined names", () => {
    it("should evaluate a formula-based defined name", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Register a formula-based name that evaluates to 42
      definedNamesAddFormula(getDefinedNames(wb), "TheAnswer", "40+2");

      Cell.setValue(ws, "A1", { formula: "TheAnswer", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(42);
    });

    it("should not degrade array result to scalar on second use in same formula round", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Register a formula-based name that returns an array (SUM over range)
      // We use a cell-reference name + a formula that uses it twice to test caching
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);

      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1:$A$3", "MyRange");

      // Both B1 and B2 use MyRange — the second evaluation must not get a
      // degraded scalar from the cache
      Cell.setValue(ws, "B1", { formula: "SUM(MyRange)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "SUM(MyRange)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(60);
      expect(Cell.getResult(ws, "B2")).toBe(60);
    });

    it("addFormula overrides a previous add, and vice versa", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);

      // First bind as cell reference
      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1", "MyName");
      // Override with formula
      definedNamesAddFormula(getDefinedNames(wb), "MyName", "99");

      Cell.setValue(ws, "B1", { formula: "MyName", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(99);

      // Now override back to cell reference
      definedNamesAdd(getDefinedNames(wb), "Sheet1!$A$1", "MyName");

      Cell.setValue(ws, "C1", { formula: "MyName", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C1")).toBe(10);
    });

    it("should handle Unicode characters in defined name identifiers", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 100);
      definedNamesAdd(getDefinedNames(wb), "Sheet1!A1", "销售额");
      Cell.setValue(ws, "B1", { formula: "销售额*2", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(200);
    });
  });

  // ==========================================================================
  // Scoped Defined Names
  // ==========================================================================
  describe("scoped defined names", () => {
    it("should resolve sheet-scoped name over workbook-scoped name", async () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      const ws2 = Workbook.addWorksheet(wb, "Sheet2");

      Cell.setValue(ws1, "A1", 100);
      Cell.setValue(ws2, "A1", 200);

      // Global "MyVal" → Sheet1!A1, Sheet1-local "MyVal" → Sheet2!A1
      definedNamesSetModel(getDefinedNames(wb), [
        { name: "MyVal", ranges: ["Sheet1!$A$1"], rawText: "Sheet1!$A$1" },
        {
          name: "MyVal",
          ranges: ["Sheet2!$A$1"],
          rawText: "Sheet2!$A$1",
          localSheetId: 0
        }
      ]);

      // Verify the DefinedNames layer works correctly
      const allNames = definedNamesGetAllNames(getDefinedNames(wb));
      expect(allNames.length).toBe(2);

      // Check snapshot construction
      const { captureFormulaSnapshot } = await import("@excel/core/formula-capture");
      const snapshot = captureFormulaSnapshot(wb);

      // Verify we have both entries in the snapshot
      expect(snapshot.definedNames.size).toBe(2);

      // Verify scope resolution
      const { resolveDefinedName } = await import("@formula/integration/workbook-snapshot");
      const fromSheet1 = resolveDefinedName(snapshot.definedNames, "MyVal", "Sheet1");
      const fromSheet2 = resolveDefinedName(snapshot.definedNames, "MyVal", "Sheet2");
      expect(fromSheet1).toBeDefined();
      expect(fromSheet1!.ranges[0]).toContain("Sheet2"); // sheet-local on Sheet1 → Sheet2
      expect(fromSheet2).toBeDefined();
      expect(fromSheet2!.ranges[0]).toContain("Sheet1"); // global fallback → Sheet1

      // Formula on Sheet1 should see the sheet-local "MyVal" → 200
      Cell.setValue(ws1, "B1", { formula: "MyVal", result: 0 });
      // Formula on Sheet2 should see the global "MyVal" → 100
      Cell.setValue(ws2, "B1", { formula: "MyVal", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws1, "B1")).toBe(200);
      expect(Cell.getResult(ws2, "B1")).toBe(100);
    });

    it("should fall back to global name when no sheet-local exists", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      const ws2 = Workbook.addWorksheet(wb, "Sheet2");

      Cell.setValue(ws1, "A1", 42);

      // Only a global "GlobalOnly" name, no sheet-local override
      definedNamesSetModel(getDefinedNames(wb), [
        { name: "GlobalOnly", ranges: ["Sheet1!$A$1"], rawText: "Sheet1!$A$1" }
      ]);

      Cell.setValue(ws1, "B1", { formula: "GlobalOnly", result: 0 });
      Cell.setValue(ws2, "B1", { formula: "GlobalOnly", result: 0 });

      calculateFormulas(wb);

      // Both sheets should resolve to the global name
      expect(Cell.getResult(ws1, "B1")).toBe(42);
      expect(Cell.getResult(ws2, "B1")).toBe(42);
    });

    it("should not cross-contaminate scoped and global name content in snapshot", async () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      const ws2 = Workbook.addWorksheet(wb, "Sheet2");

      Cell.setValue(ws1, "A1", 10);
      Cell.setValue(ws2, "A1", 20);

      // Global "X" = Sheet1!A1, Sheet2-local "X" = Sheet2!A1
      definedNamesSetModel(getDefinedNames(wb), [
        { name: "X", ranges: ["Sheet1!$A$1"], rawText: "Sheet1!$A$1" },
        {
          name: "X",
          ranges: ["Sheet2!$A$1"],
          rawText: "Sheet2!$A$1",
          localSheetId: 1
        }
      ]);
      const { captureFormulaSnapshot } = await import("@excel/core/formula-capture");
      const snapshot = captureFormulaSnapshot(wb);

      // Verify distinct entries exist and don't cross-contaminate
      const globalEntry = snapshot.definedNames.get("X");
      expect(globalEntry).toBeDefined();
      expect(globalEntry!.ranges[0]).toContain("Sheet1");
      expect(globalEntry!.scope).toBeUndefined();

      const { scopedNameKey } = await import("@formula/integration/workbook-snapshot");
      const scopedEntry = snapshot.definedNames.get(scopedNameKey("Sheet2", "X"));
      expect(scopedEntry).toBeDefined();
      expect(scopedEntry!.ranges[0]).toContain("Sheet2");
      expect(scopedEntry!.scope).toBe("Sheet2");
    });

    it("should propagate deps for formula-based scoped defined name", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");

      // A1=5, A2=10, formula name "MySum" = Sheet1!A1+Sheet1!A2
      Cell.setValue(ws1, "A1", 5);
      Cell.setValue(ws1, "A2", 10);
      definedNamesAddFormula(getDefinedNames(wb), "MySum", "Sheet1!$A$1+Sheet1!$A$2");

      Cell.setValue(ws1, "B1", { formula: "MySum", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws1, "B1")).toBe(15);
    });
  });

  // ==========================================================================
  // Critical Edge Cases
  // ==========================================================================
  describe("critical edge cases", () => {
    it("should resolve INDIRECT to correct sheet", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      const ws2 = Workbook.addWorksheet(wb, "Sheet2");
      Cell.setValue(ws1, "A1", 10);
      Cell.setValue(ws2, "A1", 20);
      // INDIRECT("A1") on Sheet1 should get Sheet1!A1
      Cell.setValue(ws1, "B1", { formula: 'INDIRECT("A1")', result: 0 });
      // INDIRECT("A1") on Sheet2 should get Sheet2!A1
      Cell.setValue(ws2, "B1", { formula: 'INDIRECT("A1")', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws1, "B1")).toBe(10);
      expect(Cell.getResult(ws2, "B1")).toBe(20);
    });

    it("should handle OFFSET with negative height", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "A3", 3);
      // OFFSET(A3,0,0,-3,1) should reference A1:A3
      Cell.setValue(ws, "B1", { formula: "SUM(OFFSET(A3,0,0,-3,1))", result: 0 });
      // OFFSET(A1,0,0,-1,1) → just A1
      Cell.setValue(ws, "B2", { formula: "SUM(OFFSET(A1,0,0,-1,1))", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(6);
      expect(Cell.getResult(ws, "B2")).toBe(1);
    });

    it("should return #REF! for OFFSET with zero height", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "B1", { formula: "OFFSET(A1,0,0,0,1)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toEqual({ error: "#REF!" });
    });

    it("should re-evaluate non-circular dependents after iterative convergence", () => {
      const wb = Workbook.create();
      wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      // Circular: A1 = IF(A1>0, A1, 1) — self-ref that seeds to 1
      Cell.setValue(ws, "A1", { formula: "IF(A1>0,A1,1)", result: 0 });
      // Non-circular dependent
      Cell.setValue(ws, "B1", { formula: "A1*10", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1")).toBe(1);
      expect(Cell.getResult(ws, "B1")).toBe(10);
    });

    it("should propagate errors through text functions", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", { formula: "1/0", result: 0 });
      Cell.setValue(ws, "B1", { formula: "LEFT(A1, 2)", result: 0 });
      Cell.setValue(ws, "C1", { formula: 'CONCATENATE("x", A1)', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toEqual({ error: "#DIV/0!" });
      expect(Cell.getResult(ws, "C1")).toEqual({ error: "#DIV/0!" });
    });

    it("should merge INDIRECT dynamic deps and re-evaluate dependents", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // A1 holds a cell address, B1 holds the value at that address
      Cell.setValue(ws, "A1", "C1");
      Cell.setValue(ws, "C1", 42);
      // INDIRECT(A1) resolves "C1" → C1 at runtime (dynamic dep)
      Cell.setValue(ws, "B1", { formula: "INDIRECT(A1)", result: 0 });
      // D1 depends on B1 (downstream of dynamic dep)
      Cell.setValue(ws, "D1", { formula: "B1*2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(42);
      expect(Cell.getResult(ws, "D1")).toBe(84);
    });

    it("should evaluate position-dependent formula names per cell", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Formula name "R" = ROW() — depends on calling cell's position
      definedNamesAddFormula(getDefinedNames(wb), "R", "ROW()");

      Cell.setValue(ws, "A1", { formula: "R", result: 0 });
      Cell.setValue(ws, "A2", { formula: "R", result: 0 });
      Cell.setValue(ws, "A3", { formula: "R", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(1);
      expect(Cell.getResult(ws, "A2")).toBe(2);
      expect(Cell.getResult(ws, "A3")).toBe(3);
    });

    it("should re-evaluate defined name dependents after iterative convergence", () => {
      const wb = Workbook.create();
      wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Circular: A1 = IF(A1>0,A1,1)
      Cell.setValue(ws, "A1", { formula: "IF(A1>0,A1,1)", result: 0 });
      // Name "N" references A1
      definedNamesAddFormula(getDefinedNames(wb), "N", "Sheet1!$A$1");
      // B1 depends on N (indirect dependency on circular A1)
      Cell.setValue(ws, "B1", { formula: "N*10", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(1);
      expect(Cell.getResult(ws, "B1")).toBe(10);
    });

    it("should handle OFFSET with negative width", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "B1", 2);
      Cell.setValue(ws, "C1", 3);

      // OFFSET(C1,0,0,1,-3) → A1:C1
      Cell.setValue(ws, "A2", { formula: "SUM(OFFSET(C1,0,0,1,-3))", result: 0 });
      // OFFSET(A1,0,0,1,0) → #REF!
      Cell.setValue(ws, "B2", { formula: "OFFSET(A1,0,0,1,0)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A2")).toBe(6);
      expect(Cell.getResult(ws, "B2")).toEqual({ error: "#REF!" });
    });

    it("should handle 3D cell reference across sheets", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      const ws2 = Workbook.addWorksheet(wb, "Sheet2");
      const ws3 = Workbook.addWorksheet(wb, "Sheet3");
      const wsResult = Workbook.addWorksheet(wb, "Result");

      Cell.setValue(ws1, "A1", 1);
      Cell.setValue(ws2, "A1", 2);
      Cell.setValue(ws3, "A1", 3);

      // 3D cell reference: SUM across Sheet1:Sheet3!A1
      Cell.setValue(wsResult, "A1", { formula: "SUM(Sheet1:Sheet3!A1)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(wsResult, "A1")).toBe(6);
    });

    it("should handle 3D whole-row reference across sheets", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      const ws2 = Workbook.addWorksheet(wb, "Sheet2");
      const wsResult = Workbook.addWorksheet(wb, "Result");

      Cell.setValue(ws1, "A1", 10);
      Cell.setValue(ws1, "B1", 20);
      Cell.setValue(ws2, "A1", 30);
      Cell.setValue(ws2, "B1", 40);

      // 3D row range: SUM(Sheet1:Sheet2!1:1)
      Cell.setValue(wsResult, "A1", { formula: "SUM(Sheet1:Sheet2!1:1)", result: 0 });

      calculateFormulas(wb);

      // 10 + 20 + 30 + 40 = 100
      expect(Cell.getResult(wsResult, "A1")).toBe(100);
    });

    it("should propagate errors through FILTER include array", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "B1", true);
      Cell.setValue(ws, "B2", { formula: "1/0", result: 0 });

      Cell.setValue(ws, "C1", {
        formula: "FILTER(A1:A2,B1:B2)",
        result: 0,
        isDynamicArray: true
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toEqual({ error: "#DIV/0!" });
    });

    it("should return correct weekday for return types 11-17", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // 2024-01-01 is a Monday. Excel serial = 45292
      Cell.setValue(ws, "A1", 45292);
      // Type 11: Mon=1
      Cell.setValue(ws, "B1", { formula: "WEEKDAY(A1,11)", result: 0 });
      // Type 17: Sun=1, Mon=2
      Cell.setValue(ws, "C1", { formula: "WEEKDAY(A1,17)", result: 0 });
      // Invalid type → #NUM!
      Cell.setValue(ws, "D1", { formula: "WEEKDAY(A1,4)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(1); // Monday → 1 for type 11
      expect(Cell.getResult(ws, "C1")).toBe(2); // Monday → 2 for type 17
      expect(Cell.getResult(ws, "D1")).toEqual({ error: "#NUM!" });
    });

    it("should handle structured ref #Headers+#Data combination", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      addTable(ws, {
        name: "Sales",
        ref: "A1",
        headerRow: true,
        totalsRow: false,
        columns: [{ name: "Item" }, { name: "Price" }],
        rows: [
          ["Apple", 1],
          ["Banana", 2],
          ["Cherry", 3]
        ]
      });

      // COUNTA of #Headers + #Data for the Price column = header + 3 data rows = 4
      Cell.setValue(ws, "D1", {
        formula: "COUNTA(Sales[[#Headers],[#Data],[Price]])",
        result: 0
      });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "D1")).toBe(4);
    });

    it("should handle structured ref #Data+#Totals combination", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      addTable(ws, {
        name: "Inventory",
        ref: "A1",
        headerRow: true,
        totalsRow: true,
        columns: [{ name: "Item" }, { name: "Qty", totalsRowFunction: "sum" }],
        rows: [
          ["Apple", 10],
          ["Banana", 20]
        ]
      });

      // #Data + #Totals for Qty = data rows + totals row = 3 cells
      Cell.setValue(ws, "D1", {
        formula: "COUNTA(Inventory[[#Data],[#Totals],[Qty]])",
        result: 0
      });

      calculateFormulas(wb);

      // 2 data cells + 1 totals cell = 3
      expect(Cell.getResult(ws, "D1")).toBe(3);
    });

    it("should re-evaluate INDIRECT when target address changes", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "C1");
      Cell.setValue(ws, "C1", 100);
      Cell.setValue(ws, "E1", 200);
      Cell.setValue(ws, "B1", { formula: "INDIRECT(A1)", result: 0 });

      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(100);

      // Change the target address
      Cell.setValue(ws, "A1", "E1");
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(200);
    });

    it("should re-evaluate multi-hop downstream after iterative convergence", () => {
      const wb = Workbook.create();
      wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // A1 = circular self-ref that converges to 1
      Cell.setValue(ws, "A1", { formula: "IF(A1>0,A1,1)", result: 0 });
      // B1 = first hop
      Cell.setValue(ws, "B1", { formula: "A1*10", result: 0 });
      // C1 = second hop
      Cell.setValue(ws, "C1", { formula: "B1+5", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toBe(1);
      expect(Cell.getResult(ws, "B1")).toBe(10);
      expect(Cell.getResult(ws, "C1")).toBe(15);
    });

    it("should handle structured ref [#This Row]", () => {
      // Regression: `#This Row` is supported end-to-end. The original
      // variant of this test used `"T1"` as the table name, which the
      // library's Table constructor sanitises to `"_T1"` because
      // bare-letter+digit names collide with cell refs — the formula
      // then referenced a non-existent table. Using an unambiguous
      // table name (`MyTable`) exercises the intended path.
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      addTable(ws, {
        name: "MyTable",
        ref: "A1",
        headerRow: true,
        totalsRow: false,
        columns: [{ name: "Val" }, { name: "Double" }],
        rows: [
          [10, null],
          [20, null],
          [30, null]
        ]
      });

      // Formulas in the Double column reference [#This Row]
      Cell.setValue(ws, "B2", { formula: "MyTable[[#This Row],[Val]]*2", result: 0 });
      Cell.setValue(ws, "B3", { formula: "MyTable[[#This Row],[Val]]*2", result: 0 });
      Cell.setValue(ws, "B4", { formula: "MyTable[[#This Row],[Val]]*2", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B2")).toBe(20);
      expect(Cell.getResult(ws, "B3")).toBe(40);
      expect(Cell.getResult(ws, "B4")).toBe(60);
    });

    it("should propagate error from SUMIF criteria", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "B1", 10);
      Cell.setValue(ws, "B2", 20);

      // Criteria is an error
      Cell.setValue(ws, "C1", { formula: "1/0", result: 0 });
      Cell.setValue(ws, "D1", { formula: "SUMIF(A1:A2,C1,B1:B2)", result: 0 });
      Cell.setValue(ws, "D2", { formula: "COUNTIF(A1:A2,C1)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "D1")).toEqual({ error: "#DIV/0!" });
      expect(Cell.getResult(ws, "D2")).toEqual({ error: "#DIV/0!" });
    });
  });

  // ==========================================================================
  // Newly added functions — ISFORMULA, FORMULATEXT, HYPERLINK,
  // F.DIST.RT, F.INV.RT, SKEW, SKEW.P, KURT, PRICE, YIELD, DURATION,
  // MDURATION, ACCRINT.
  // ==========================================================================
  describe("newly added functions dispatch", () => {
    it("should dispatch ISFORMULA, FORMULATEXT, HYPERLINK, stats, and bond functions", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // A1 contains a value; A2 contains a formula referring to A1.
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", { formula: "A1*2", result: 0 });

      // ISFORMULA / FORMULATEXT.
      Cell.setValue(ws, "B1", { formula: "ISFORMULA(A1)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "ISFORMULA(A2)", result: 0 });
      Cell.setValue(ws, "B3", { formula: "FORMULATEXT(A2)", result: 0 });
      Cell.setValue(ws, "B4", { formula: "FORMULATEXT(A1)", result: 0 });

      // HYPERLINK(url, friendly) and HYPERLINK(url) alone.
      Cell.setValue(ws, "C1", {
        formula: 'HYPERLINK("http://x.com","click me")',
        result: 0
      });
      Cell.setValue(ws, "C2", { formula: 'HYPERLINK("http://x.com")', result: 0 });

      // Statistical data for SKEW / SKEW.P / KURT — known values:
      // sample 1..10: SKEW ≈ 0, SKEW.P = 0, KURT ≈ -1.2
      Cell.setValue(ws, "D1", 1);
      Cell.setValue(ws, "D2", 2);
      Cell.setValue(ws, "D3", 3);
      Cell.setValue(ws, "D4", 4);
      Cell.setValue(ws, "D5", 5);
      Cell.setValue(ws, "D6", 6);
      Cell.setValue(ws, "D7", 7);
      Cell.setValue(ws, "D8", 8);
      Cell.setValue(ws, "D9", 9);
      Cell.setValue(ws, "D10", 10);
      Cell.setValue(ws, "E1", { formula: "SKEW(D1:D10)", result: 0 });
      Cell.setValue(ws, "E2", { formula: "SKEW.P(D1:D10)", result: 0 });
      Cell.setValue(ws, "E3", { formula: "KURT(D1:D10)", result: 0 });

      // F.DIST.RT and F.INV.RT — self-consistency check:
      // F.INV.RT(F.DIST.RT(2, 5, 10), 5, 10) ≈ 2.
      Cell.setValue(ws, "F1", { formula: "F.DIST.RT(2,5,10)", result: 0 });
      Cell.setValue(ws, "F2", { formula: "F.INV.RT(F.DIST.RT(2,5,10),5,10)", result: 0 });

      // Bond functions using simple parameters (basis 0, semi-annual).
      // Settlement 2020-01-01 = 43831, maturity 2025-01-01 = 45658.
      Cell.setValue(ws, "G1", 43831); // settlement
      Cell.setValue(ws, "G2", 45658); // maturity
      Cell.setValue(ws, "G3", {
        formula: "PRICE(G1,G2,0.05,0.05,100,2,0)",
        result: 0
      });
      // For equal rate and yield, price should be ~100.
      Cell.setValue(ws, "G4", {
        formula: "YIELD(G1,G2,0.05,100,100,2,0)",
        result: 0
      });
      Cell.setValue(ws, "G5", {
        formula: "DURATION(G1,G2,0.05,0.05,2,0)",
        result: 0
      });
      Cell.setValue(ws, "G6", {
        formula: "MDURATION(G1,G2,0.05,0.05,2,0)",
        result: 0
      });
      // ACCRINT: issue 2020-01-01, settlement 2020-07-01 (= 44013),
      // rate 0.05, par 1000, basis 0 → 1000 * 0.05 * (180/360) = 25.
      Cell.setValue(ws, "H1", 44013);
      Cell.setValue(ws, "H2", {
        formula: "ACCRINT(G1,G1,H1,0.05,1000,2,0)",
        result: 0
      });

      calculateFormulas(wb);

      // ISFORMULA / FORMULATEXT.
      expect(Cell.getResult(ws, "B1")).toBe(false);
      expect(Cell.getResult(ws, "B2")).toBe(true);
      expect(Cell.getResult(ws, "B3")).toBe("=A1*2");
      expect(Cell.getResult(ws, "B4")).toEqual({ error: "#N/A" });

      // HYPERLINK — friendly name wins; otherwise URL.
      expect(Cell.getResult(ws, "C1")).toBe("click me");
      expect(Cell.getResult(ws, "C2")).toBe("http://x.com");

      // SKEW/SKEW.P should be ~0 for the symmetric sample 1..10.
      expect(Math.abs(Cell.getResult(ws, "E1") as number)).toBeLessThan(1e-9);
      expect(Math.abs(Cell.getResult(ws, "E2") as number)).toBeLessThan(1e-9);
      // KURT for 1..10 is approximately -1.2.
      expect(Cell.getResult(ws, "E3") as number).toBeCloseTo(-1.2, 5);

      // F.DIST.RT in (0,1); round-trip through F.INV.RT returns ~2.
      const frt = Cell.getResult(ws, "F1") as number;
      expect(frt).toBeGreaterThan(0);
      expect(frt).toBeLessThan(1);
      expect(Cell.getResult(ws, "F2") as number).toBeCloseTo(2, 4);

      // PRICE at par when yield == coupon.
      expect(Cell.getResult(ws, "G3") as number).toBeCloseTo(100, 4);
      // YIELD given price 100 should return 0.05.
      expect(Cell.getResult(ws, "G4") as number).toBeCloseTo(0.05, 4);
      // 5-year par bond, 5% coupon semi-annual → duration ≈ 4.49 years.
      expect(Cell.getResult(ws, "G5") as number).toBeGreaterThan(4);
      expect(Cell.getResult(ws, "G5") as number).toBeLessThan(5);
      // Modified duration slightly less than Macaulay duration.
      expect(Cell.getResult(ws, "G6") as number).toBeLessThan(Cell.getResult(ws, "G5") as number);
      // ACCRINT on a 30/360 half-year → $25.
      expect(Cell.getResult(ws, "H2") as number).toBeCloseTo(25, 6);
    });

    it("should handle F.DIST.RT at x=0 boundary", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", { formula: "F.DIST.RT(0,5,10)", result: 0 });
      Cell.setValue(ws, "A2", { formula: "F.DIST.RT(-1,5,10)", result: 0 });
      calculateFormulas(wb);
      // x=0 → entire distribution above 0 → probability = 1
      expect(Cell.getResult(ws, "A1")).toBe(1);
      // x<0 → #NUM! (F-distribution only defined for x ≥ 0)
      expect(Cell.getResult(ws, "A2")).toEqual({ error: "#NUM!" });
    });
  });

  // ==========================================================================
  // CELL — information about a referenced cell.
  // Covers the implemented info-type subset: address/row/col/contents/type/
  // width/filename, plus the #N/A fallback for unsupported info types.
  // ==========================================================================
  describe("CELL function", () => {
    it("should return $A$1-style absolute address strings", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "B1", { formula: 'CELL("address",A1)', result: 0 });
      Cell.setValue(ws, "B2", { formula: 'CELL("address",Z99)', result: 0 });
      Cell.setValue(ws, "B3", { formula: 'CELL("address",AA1)', result: 0 });
      Cell.setValue(ws, "B4", { formula: 'CELL("address",XFD1048576)', result: 0 });
      // Area ref → top-left.
      Cell.setValue(ws, "B5", { formula: 'CELL("address",C3:D4)', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe("$A$1");
      expect(Cell.getResult(ws, "B2")).toBe("$Z$99");
      expect(Cell.getResult(ws, "B3")).toBe("$AA$1");
      expect(Cell.getResult(ws, "B4")).toBe("$XFD$1048576");
      expect(Cell.getResult(ws, "B5")).toBe("$C$3");
    });

    it("should return row and column numbers", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "B1", { formula: 'CELL("row",A1)', result: 0 });
      Cell.setValue(ws, "B2", { formula: 'CELL("row",B5)', result: 0 });
      Cell.setValue(ws, "B3", { formula: 'CELL("col",A1)', result: 0 });
      Cell.setValue(ws, "B4", { formula: 'CELL("col",Z7)', result: 0 });
      // Area ref top-left wins.
      Cell.setValue(ws, "B5", { formula: 'CELL("row",D3:E4)', result: 0 });
      Cell.setValue(ws, "B6", { formula: 'CELL("col",D3:E4)', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(1);
      expect(Cell.getResult(ws, "B2")).toBe(5);
      expect(Cell.getResult(ws, "B3")).toBe(1);
      expect(Cell.getResult(ws, "B4")).toBe(26);
      expect(Cell.getResult(ws, "B5")).toBe(3);
      expect(Cell.getResult(ws, "B6")).toBe(4);
    });

    it("should return cell contents for various value kinds", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 42);
      Cell.setValue(ws, "A2", "hello");
      Cell.setValue(ws, "A3", true);
      // A4 is intentionally empty.
      Cell.setValue(ws, "B1", { formula: 'CELL("contents",A1)', result: 0 });
      Cell.setValue(ws, "B2", { formula: 'CELL("contents",A2)', result: 0 });
      Cell.setValue(ws, "B3", { formula: 'CELL("contents",A3)', result: 0 });
      Cell.setValue(ws, "B4", { formula: 'CELL("contents",A4)', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(42);
      expect(Cell.getResult(ws, "B2")).toBe("hello");
      expect(Cell.getResult(ws, "B3")).toBe(true);
      // Excel represents empty contents as 0 in numeric contexts, but
      // our writeback path preserves BLANK as `undefined` so that
      // downstream consumers can distinguish "empty" from "literal
      // zero" (see R5-P1-2).
      const b4 = Cell.getResult(ws, "B4");
      expect(b4 === undefined || b4 === 0).toBe(true);
    });

    it('should classify cell type as "b"/"l"/"v"', () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 10); // number → "v"
      Cell.setValue(ws, "A2", "text"); // string → "l"
      // A3 blank → "b"
      Cell.setValue(ws, "A4", true); // boolean → "v"
      Cell.setValue(ws, "B1", { formula: 'CELL("type",A1)', result: 0 });
      Cell.setValue(ws, "B2", { formula: 'CELL("type",A2)', result: 0 });
      Cell.setValue(ws, "B3", { formula: 'CELL("type",A3)', result: 0 });
      Cell.setValue(ws, "B4", { formula: 'CELL("type",A4)', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe("v");
      expect(Cell.getResult(ws, "B2")).toBe("l");
      expect(Cell.getResult(ws, "B3")).toBe("b");
      expect(Cell.getResult(ws, "B4")).toBe("v");
    });

    it("should return default width=8 and empty filename", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "B1", { formula: 'CELL("width",A1)', result: 0 });
      Cell.setValue(ws, "B2", { formula: 'CELL("filename",A1)', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(8);
      expect(Cell.getResult(ws, "B2")).toBe("");
    });

    it("should return #N/A for unsupported info types", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "B1", { formula: 'CELL("format",A1)', result: 0 });
      Cell.setValue(ws, "B2", { formula: 'CELL("color",A1)', result: 0 });
      Cell.setValue(ws, "B3", { formula: 'CELL("parentheses",A1)', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toEqual({ error: "#N/A" });
      expect(Cell.getResult(ws, "B2")).toEqual({ error: "#N/A" });
      expect(Cell.getResult(ws, "B3")).toEqual({ error: "#N/A" });
    });

    it("should resolve the reference produced by INDIRECT", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 99);
      Cell.setValue(ws, "B1", { formula: 'CELL("address",INDIRECT("A1"))', result: 0 });
      Cell.setValue(ws, "B2", { formula: 'CELL("row",INDIRECT("B5"))', result: 0 });
      Cell.setValue(ws, "B3", { formula: 'CELL("contents",INDIRECT("A1"))', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe("$A$1");
      expect(Cell.getResult(ws, "B2")).toBe(5);
      expect(Cell.getResult(ws, "B3")).toBe(99);
    });

    it("should default to the current cell when reference is omitted", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "C5", { formula: 'CELL("address")', result: 0 });
      Cell.setValue(ws, "C6", { formula: 'CELL("row")', result: 0 });
      Cell.setValue(ws, "C7", { formula: 'CELL("col")', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "C5")).toBe("$C$5");
      expect(Cell.getResult(ws, "C6")).toBe(6);
      expect(Cell.getResult(ws, "C7")).toBe(3);
    });
  });

  // ==========================================================================
  // ISREF — reference detection at the evaluator level.
  // ==========================================================================
  describe("ISREF function", () => {
    it("should return TRUE for direct cell and range references", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "B1", { formula: "ISREF(A1)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "ISREF(A1:B3)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(true);
      expect(Cell.getResult(ws, "B2")).toBe(true);
    });

    it("should return FALSE for literals and computed scalars", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "B1", { formula: "ISREF(1)", result: 0 });
      Cell.setValue(ws, "B2", { formula: 'ISREF("text")', result: 0 });
      Cell.setValue(ws, "B3", { formula: "ISREF(1+2)", result: 0 });
      Cell.setValue(ws, "B4", { formula: "ISREF(TRUE)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(false);
      expect(Cell.getResult(ws, "B2")).toBe(false);
      expect(Cell.getResult(ws, "B3")).toBe(false);
      expect(Cell.getResult(ws, "B4")).toBe(false);
    });

    it("should return TRUE when INDIRECT produces a valid reference", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 1);
      // INDIRECT yields a ReferenceValue at runtime.
      Cell.setValue(ws, "B1", { formula: 'ISREF(INDIRECT("A1"))', result: 0 });
      Cell.setValue(ws, "B2", { formula: 'ISREF(INDIRECT("A1:B2"))', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(true);
      expect(Cell.getResult(ws, "B2")).toBe(true);
    });

    it("should return FALSE when INDIRECT cannot resolve a reference", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      // INDIRECT on an invalid address yields #REF! — ISREF suppresses to FALSE.
      Cell.setValue(ws, "B1", { formula: 'ISREF(INDIRECT("not a ref"))', result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(false);
    });

    it("should return #VALUE! for wrong arity", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "B1", { formula: "ISREF(A1,A2)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toEqual({ error: "#VALUE!" });
    });
  });

  // ==========================================================================
  // Language features: intersection operator and external references
  // ==========================================================================
  describe("intersection operator and external references", () => {
    it("should compute intersection of two overlapping ranges (space operator)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // A1:A4 contain 1..4. A1:A3 ∩ A2:A4 = A2:A3 → sum = 2+3 = 5.
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "A3", 3);
      Cell.setValue(ws, "A4", 4);

      Cell.setValue(ws, "B1", { formula: "SUM(A1:A3 A2:A4)", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "B1")).toBe(5);
    });

    it("should return #NULL! when intersected ranges do not overlap", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "B1", 20);

      // A1 and B1 are distinct single-cell refs with no overlap.
      Cell.setValue(ws, "C1", { formula: "A1 B1", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "C1")).toEqual({ error: "#NULL!" });
    });

    it("should return #REF! for an external workbook reference", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Cross-workbook references like [Book1]Sheet1!A1 are recognised but
      // unsupported — the engine reports #REF! instead of silently
      // swallowing the text.
      Cell.setValue(ws, "A1", { formula: "[Book1]Sheet1!A1", result: 0 });

      calculateFormulas(wb);

      expect(Cell.getResult(ws, "A1")).toEqual({ error: "#REF!" });
    });

    it("should return #REF! for OFFSET beyond sheet upper bound", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 1);
      // Row overflow
      Cell.setValue(ws, "B1", { formula: "OFFSET(A1,1048577,0)", result: 0 });
      // Column overflow
      Cell.setValue(ws, "B2", { formula: "OFFSET(A1,0,16384)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toEqual({ error: "#REF!" });
      expect(Cell.getResult(ws, "B2")).toEqual({ error: "#REF!" });
    });

    it("should return #NULL! for cross-sheet intersection", () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "Sheet1");
      const ws2 = Workbook.addWorksheet(wb, "Sheet2");
      Cell.setValue(ws1, "A1", 1);
      Cell.setValue(ws1, "A2", 2);
      Cell.setValue(ws1, "A3", 3);
      Cell.setValue(ws2, "A1", 10);
      Cell.setValue(ws2, "A2", 20);
      Cell.setValue(ws2, "A3", 30);
      // Intersection across different sheets should be #NULL!
      Cell.setValue(ws1, "B1", {
        formula: "SUM(Sheet1!A1:A2 Sheet2!A1:A3)",
        result: 0
      });
      calculateFormulas(wb);
      expect(Cell.getResult(ws1, "B1")).toEqual({ error: "#NULL!" });
    });

    it("should detect all nodes in a diamond dependency cycle", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      // Diamond: A→B→C→A, plus A→D→C
      // All four cells should be in the cycle (not just A, B, C)
      Cell.setValue(ws, "A1", { formula: "B1+D1", result: 0 });
      Cell.setValue(ws, "B1", { formula: "C1+1", result: 0 });
      Cell.setValue(ws, "C1", { formula: "A1*0.5", result: 0 });
      Cell.setValue(ws, "D1", { formula: "C1+2", result: 0 });
      calculateFormulas(wb);
      // All four should resolve to numbers (circular fallback = 0, then one pass)
      expect(typeof Cell.getResult(ws, "A1")).toBe("number");
      expect(typeof Cell.getResult(ws, "B1")).toBe("number");
      expect(typeof Cell.getResult(ws, "C1")).toBe("number");
      expect(typeof Cell.getResult(ws, "D1")).toBe("number");
    });

    it("should return #VALUE! when coercing empty string to number", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", { formula: '1+""', result: 0 });
      // Empty cell should coerce to 0
      Cell.setValue(ws, "A2", { formula: "1+B1", result: 0 });
      // Explicit empty string should error
      Cell.setValue(ws, "B1", "");
      Cell.setValue(ws, "A3", { formula: "1+B1", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1")).toEqual({ error: "#VALUE!" });
      // A2 references B1 which is empty string; A3 references B1 too.
      // Depending on whether empty cell and empty string are distinguished,
      // the behavior differs. If B1 reads as empty string, expect #VALUE!
      expect(Cell.getResult(ws, "A3")).toEqual({ error: "#VALUE!" });
    });

    it("should return #REF! for external reference nested in a function", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", { formula: "SUM([Book1]Sheet1!A1:A5)", result: 0 });
      Cell.setValue(ws, "A2", { formula: "[Book1]Sheet1!A1 + 1", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1")).toEqual({ error: "#REF!" });
      expect(Cell.getResult(ws, "A2")).toEqual({ error: "#REF!" });
    });

    it("should return #NULL! for rectangles disjoint in column axis", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "B1", 2);
      Cell.setValue(ws, "C1", 3);
      Cell.setValue(ws, "D1", 4);
      // A1:B2 and C1:D2 share no cells
      Cell.setValue(ws, "E1", { formula: "SUM(A1:B2 C1:D2)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "E1")).toEqual({ error: "#NULL!" });
    });
  });

  // ==========================================================================
  // User-registered custom functions
  // ==========================================================================
  describe("registerFunction", () => {
    it("invokes a simple user function inside a formula", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Workbook.registerFunction(
        wb,
        "DOUBLE",
        args => {
          const v = args[0] as { kind: number; value: number };
          return { kind: 1 /* Number */, value: v.value * 2 };
        },
        { minArity: 1, maxArity: 1 }
      );
      Cell.setValue(ws, "A1", 7);
      Cell.setValue(ws, "B1", { formula: "DOUBLE(A1)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(14);
    });

    it("is case-insensitive and accepts _XLFN. prefixed names", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Workbook.registerFunction(wb, "answer", () => ({ kind: 1, value: 42 }));
      Cell.setValue(ws, "A1", { formula: "ANSWER()", result: 0 });
      Cell.setValue(ws, "A2", { formula: "_xlfn.ANSWER()", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1")).toBe(42);
      expect(Cell.getResult(ws, "A2")).toBe(42);
    });

    it("shadows built-in functions of the same name", () => {
      // Registering `SUM` as a custom always-returns-99 function should
      // override the built-in aggregator for this workbook only.
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Workbook.registerFunction(wb, "SUM", () => ({ kind: 1, value: 99 }));
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "B1", { formula: "SUM(A1:A2)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(99);
    });

    it("arity validation rejects wrong arg count with #VALUE!", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Workbook.registerFunction(wb, "TWO", () => ({ kind: 1, value: 0 }), {
        minArity: 2,
        maxArity: 2
      });
      Cell.setValue(ws, "A1", { formula: "TWO(1)", result: 0 });
      Cell.setValue(ws, "A2", { formula: "TWO(1,2)", result: 0 });
      Cell.setValue(ws, "A3", { formula: "TWO(1,2,3)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1")).toEqual({ error: "#VALUE!" });
      expect(Cell.getResult(ws, "A2")).toBe(0);
      expect(Cell.getResult(ws, "A3")).toEqual({ error: "#VALUE!" });
    });

    it("unregisterFunction removes the entry", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Workbook.registerFunction(wb, "TMP", () => ({ kind: 1, value: 42 }));
      // With TMP registered, the formula evaluates to 42.
      Cell.setValue(ws, "A1", { formula: "TMP()", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1")).toBe(42);

      // Remove the registration; subsequent calculate should surface
      // #NAME? via the engine's unknown-function path.
      expect(Workbook.unregisterFunction(wb, "TMP")).toBe(true);
      expect(Workbook.unregisterFunction(wb, "TMP")).toBe(false);
      // Reset the cached result so the engine has no prior value to
      // preserve (the "preserve cached result on #NAME?" path would
      // otherwise hide the behaviour we're testing).
      Cell.setValue(ws, "A1", { formula: "TMP()" });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1")).toEqual({ error: "#NAME?" });
    });

    it("throwing user function surfaces as #VALUE! (doesn't tear down calc)", () => {
      // Regression: without a try/catch boundary a buggy custom
      // function would throw through the evaluator and leave the
      // whole calculation pass half-done.
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Workbook.registerFunction(wb, "BOOM", () => {
        throw new Error("boom");
      });
      Cell.setValue(ws, "A1", { formula: "BOOM()", result: 0 });
      // Other formulas should still complete successfully.
      Cell.setValue(ws, "A2", 5);
      Cell.setValue(ws, "A3", { formula: "A2 * 2", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "A1")).toEqual({ error: "#VALUE!" });
      expect(Cell.getResult(ws, "A3")).toBe(10);
    });

    it("user function composes with built-ins (IF, SUM, etc.)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Workbook.registerFunction(wb, "NEGATE", args => {
        const v = args[0] as { kind: number; value: number };
        return { kind: 1, value: -v.value };
      });
      Cell.setValue(ws, "A1", 5);
      Cell.setValue(ws, "A2", 3);
      Cell.setValue(ws, "B1", { formula: "IF(A1>0, NEGATE(A1), A2)", result: 0 });
      Cell.setValue(ws, "B2", { formula: "SUM(NEGATE(A1), A2)", result: 0 });
      calculateFormulas(wb);
      expect(Cell.getResult(ws, "B1")).toBe(-5); // IF true branch runs NEGATE
      expect(Cell.getResult(ws, "B2")).toBe(-2); // -5 + 3 = -2
    });
  });
});
