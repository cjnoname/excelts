import { definedNamesAdd } from "@excel/core/defined-names";
import { calculateFormulas } from "@excel/core/formula-adapter";
import { getDefinedNames } from "@excel/core/workbook";
import { getCell, getSheetModel } from "@excel/core/worksheet";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

/**
 * XLSX Round-Trip Formula Tests
 *
 * These tests exercise the FULL pipeline:
 *   1. Create a workbook with data + formulas
 *   2. Write to XLSX buffer via Workbook.toBuffer(wb)
 *   3. Read back via new Workbook() + Workbook.read(wb, buffer)
 *   4. Call wb.calculateFormulas()
 *   5. Verify ALL formula results match expected values
 *
 * This is not a unit test with mock data — it tests real XLSX
 * serialization → deserialization → formula evaluation.
 */
describe("Formula XLSX Round-Trip", () => {
  it("reconstructs calculated dynamic-array ghosts after round-trip", async () => {
    const wb1 = Workbook.create();
    const ws1 = Workbook.addWorksheet(wb1, "Sheet1");
    Cell.setValue(ws1, "A1", { formula: "SEQUENCE(3)", result: 0 });
    calculateFormulas(wb1);
    expect(Cell.getValue(ws1, "A3")).toBe(3);
    expect(getCell(ws1, "A2")._formulaGhostOwner).toBeDefined();
    const ghostModel = getSheetModel(ws1)
      .rows?.flatMap(row => row.cells)
      .find(cell => cell.address === "A2");
    expect(ghostModel?.type).toBe(0);
    expect(ghostModel?.value).toBeUndefined();

    const buffer = await Workbook.toBuffer(wb1);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

    calculateFormulas(wb2);
    expect(Cell.getResult(ws2, "A1")).toBe(1);
    expect(Cell.getValue(ws2, "A2")).toBe(2);
    expect(Cell.getValue(ws2, "A3")).toBe(3);
  });

  // ==========================================================================
  // Test 1: Complex workbook with mixed data types and diverse formulas
  // ==========================================================================
  describe("complex workbook round-trip", () => {
    it("should create, write, read, and calculate a workbook with diverse formulas", async () => {
      // ── Step 1: Create the workbook ──────────────────────────────────────
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Sheet1");

      // Row 1: Headers
      Cell.setValue(ws1, "A1", "Name");
      Cell.setValue(ws1, "B1", "Score");
      Cell.setValue(ws1, "C1", "Grade");
      Cell.setValue(ws1, "D1", "Active");

      // Row 2–6: Data (numbers, strings, booleans)
      Cell.setValue(ws1, "A2", "Alice");
      Cell.setValue(ws1, "B2", 92);
      Cell.setValue(ws1, "C2", "A");
      Cell.setValue(ws1, "D2", true);

      Cell.setValue(ws1, "A3", "Bob");
      Cell.setValue(ws1, "B3", 78);
      Cell.setValue(ws1, "C3", "C");
      Cell.setValue(ws1, "D3", true);

      Cell.setValue(ws1, "A4", "Charlie");
      Cell.setValue(ws1, "B4", 85);
      Cell.setValue(ws1, "C4", "B");
      Cell.setValue(ws1, "D4", false);

      Cell.setValue(ws1, "A5", "Diana");
      Cell.setValue(ws1, "B5", 95);
      Cell.setValue(ws1, "C5", "A");
      Cell.setValue(ws1, "D5", true);

      Cell.setValue(ws1, "A6", "Eve");
      Cell.setValue(ws1, "B6", 62);
      Cell.setValue(ws1, "C6", "D");
      Cell.setValue(ws1, "D6", false);

      // Row 7–10: More numeric data
      Cell.setValue(ws1, "A7", "Frank");
      Cell.setValue(ws1, "B7", 88);
      Cell.setValue(ws1, "C7", "B");
      Cell.setValue(ws1, "D7", true);

      Cell.setValue(ws1, "A8", "Grace");
      Cell.setValue(ws1, "B8", 71);
      Cell.setValue(ws1, "C8", "C");
      Cell.setValue(ws1, "D8", true);

      Cell.setValue(ws1, "A9", "Hank");
      Cell.setValue(ws1, "B9", 43);
      Cell.setValue(ws1, "C9", "F");
      Cell.setValue(ws1, "D9", false);

      Cell.setValue(ws1, "A10", "Ivy");
      Cell.setValue(ws1, "B10", 99);
      Cell.setValue(ws1, "C10", "A");
      Cell.setValue(ws1, "D10", true);

      // ── Formula cells ────────────────────────────────────────────────────

      // F1: SUM of all scores
      Cell.setValue(ws1, "F1", { formula: "SUM(B2:B10)", result: 0 });

      // F2: AVERAGE of scores
      Cell.setValue(ws1, "F2", { formula: "AVERAGE(B2:B10)", result: 0 });

      // F3: MAX score
      Cell.setValue(ws1, "F3", { formula: "MAX(B2:B10)", result: 0 });

      // F4: MIN score
      Cell.setValue(ws1, "F4", { formula: "MIN(B2:B10)", result: 0 });

      // F5: COUNT of numeric scores
      Cell.setValue(ws1, "F5", { formula: "COUNT(B2:B10)", result: 0 });

      // F6: COUNTA (all non-empty in A column)
      Cell.setValue(ws1, "F6", { formula: "COUNTA(A2:A10)", result: 0 });

      // F7: IF — check if average > 80
      Cell.setValue(ws1, "F7", {
        formula: 'IF(AVERAGE(B2:B10)>80,"Pass","Fail")',
        result: ""
      });

      // F8: CONCATENATE
      Cell.setValue(ws1, "F8", {
        formula: 'CONCATENATE(A2," scored ",B2)',
        result: ""
      });

      // F9: VLOOKUP — look up Bob's score
      Cell.setValue(ws1, "F9", {
        formula: 'VLOOKUP("Bob",A2:B10,2,FALSE)',
        result: 0
      });

      // F10: Nested IF (grade based on average)
      Cell.setValue(ws1, "F10", {
        formula:
          'IF(AVERAGE(B2:B10)>=90,"A",IF(AVERAGE(B2:B10)>=80,"B",IF(AVERAGE(B2:B10)>=70,"C","D")))',
        result: ""
      });

      // F11: COUNTIF — count "A" grades
      Cell.setValue(ws1, "F11", {
        formula: 'COUNTIF(C2:C10,"A")',
        result: 0
      });

      // F12: SUMIF — sum scores of active students
      Cell.setValue(ws1, "F12", {
        formula: "SUMIF(D2:D10,TRUE,B2:B10)",
        result: 0
      });

      // F13: ROUND of average
      Cell.setValue(ws1, "F13", {
        formula: "ROUND(AVERAGE(B2:B10),1)",
        result: 0
      });

      // F14: Chained dependency — F1 * 2
      Cell.setValue(ws1, "F14", { formula: "F1*2", result: 0 });

      // F15: DATE function
      Cell.setValue(ws1, "F15", {
        formula: "YEAR(DATE(2024,6,15))",
        result: 0
      });

      // F16: LEN of a name
      Cell.setValue(ws1, "F16", { formula: "LEN(A4)", result: 0 });

      // F17: LEFT
      Cell.setValue(ws1, "F17", { formula: "LEFT(A4,3)", result: "" });

      // F18: IFERROR with safe expression
      Cell.setValue(ws1, "F18", {
        formula: 'IFERROR(B2/B3,"Error")',
        result: 0
      });

      // F19: PRODUCT
      Cell.setValue(ws1, "F19", { formula: "PRODUCT(B2,B3)", result: 0 });

      // ── Named range ──────────────────────────────────────────────────────
      // Define "Scores" as Sheet1!$B$2:$B$10
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$B$2", "Scores");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$B$3", "Scores");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$B$4", "Scores");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$B$5", "Scores");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$B$6", "Scores");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$B$7", "Scores");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$B$8", "Scores");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$B$9", "Scores");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$B$10", "Scores");

      // F20: Formula using named range
      Cell.setValue(ws1, "F20", { formula: "SUM(Scores)", result: 0 });

      // ── Step 2: Write to buffer ──────────────────────────────────────────
      const buffer = await Workbook.toBuffer(wb1);
      expect(buffer).toBeInstanceOf(Uint8Array);
      expect(buffer.length).toBeGreaterThan(0);

      // ── Step 3: Read back ────────────────────────────────────────────────
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer as Buffer);

      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
      expect(ws2).toBeDefined();

      // Verify raw data survived the round-trip
      expect(Cell.getValue(ws2, "A2")).toBe("Alice");
      expect(Cell.getValue(ws2, "B2")).toBe(92);
      expect(Cell.getValue(ws2, "D2")).toBe(true);

      // ── Step 4: Calculate formulas ───────────────────────────────────────
      calculateFormulas(wb2);

      // ── Step 5: Verify ALL formula results ───────────────────────────────
      // Expected scores: 92, 78, 85, 95, 62, 88, 71, 43, 99
      const expectedSum = 92 + 78 + 85 + 95 + 62 + 88 + 71 + 43 + 99; // 713
      const expectedAvg = expectedSum / 9; // ~79.222...

      // F1: SUM
      expect(Cell.getResult(ws2, "F1")).toBe(expectedSum);

      // F2: AVERAGE
      expect(Cell.getResult(ws2, "F2")).toBeCloseTo(expectedAvg, 5);

      // F3: MAX
      expect(Cell.getResult(ws2, "F3")).toBe(99);

      // F4: MIN
      expect(Cell.getResult(ws2, "F4")).toBe(43);

      // F5: COUNT
      expect(Cell.getResult(ws2, "F5")).toBe(9);

      // F6: COUNTA
      expect(Cell.getResult(ws2, "F6")).toBe(9);

      // F7: IF — average is ~79.2, which is < 80
      expect(Cell.getResult(ws2, "F7")).toBe("Fail");

      // F8: CONCATENATE
      expect(Cell.getResult(ws2, "F8")).toBe("Alice scored 92");

      // F9: VLOOKUP
      expect(Cell.getResult(ws2, "F9")).toBe(78);

      // F10: Nested IF — avg ~79.2, so falls into >=70 branch → "C"
      expect(Cell.getResult(ws2, "F10")).toBe("C");

      // F11: COUNTIF "A" grades — Alice, Diana, Ivy → 3
      expect(Cell.getResult(ws2, "F11")).toBe(3);

      // F12: SUMIF active=TRUE scores: 92+78+95+88+71+99 = 523
      expect(Cell.getResult(ws2, "F12")).toBe(523);

      // F13: ROUND(avg, 1) = ROUND(79.222..., 1) = 79.2
      expect(Cell.getResult(ws2, "F13")).toBeCloseTo(79.2, 1);

      // F14: chained — SUM * 2
      expect(Cell.getResult(ws2, "F14")).toBe(expectedSum * 2);

      // F15: YEAR(DATE(2024,6,15)) = 2024
      expect(Cell.getResult(ws2, "F15")).toBe(2024);

      // F16: LEN("Charlie") = 7
      expect(Cell.getResult(ws2, "F16")).toBe(7);

      // F17: LEFT("Charlie", 3) = "Cha"
      expect(Cell.getResult(ws2, "F17")).toBe("Cha");

      // F18: IFERROR(92/78, "Error") ≈ 1.179...
      expect(Cell.getResult(ws2, "F18")).toBeCloseTo(92 / 78, 5);

      // F19: PRODUCT(92, 78) = 7176
      expect(Cell.getResult(ws2, "F19")).toBe(92 * 78);

      // F20: SUM(Scores) via named range = same as SUM(B2:B10)
      expect(Cell.getResult(ws2, "F20")).toBe(expectedSum);
    });
  });

  // ==========================================================================
  // Test 2: Every reference type
  // ==========================================================================
  describe("all reference types round-trip", () => {
    it("should handle simple, absolute, cross-sheet, range, and named range references", async () => {
      // ── Step 1: Create workbook with two sheets ──────────────────────────
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Sheet1");
      const ws2sheet = Workbook.addWorksheet(wb1, "Sheet2");

      // Sheet1 data
      Cell.setValue(ws1, "A1", 10);
      Cell.setValue(ws1, "A2", 20);
      Cell.setValue(ws1, "A3", 30);
      Cell.setValue(ws1, "B1", 100);
      Cell.setValue(ws1, "B2", 200);
      Cell.setValue(ws1, "B3", 300);

      // Sheet2 data
      Cell.setValue(ws2sheet, "A1", 1000);
      Cell.setValue(ws2sheet, "A2", 2000);
      Cell.setValue(ws2sheet, "A3", 3000);

      // Named range: "MyValues" → Sheet1!$A$1:$A$3
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$A$1", "MyValues");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$A$2", "MyValues");
      definedNamesAdd(getDefinedNames(wb1), "Sheet1!$A$3", "MyValues");

      // Named range: "Sheet2Total" → single cell Sheet2!$A$1
      definedNamesAdd(getDefinedNames(wb1), "Sheet2!$A$1", "Sheet2Val");

      // ── Formulas exercising every reference type ─────────────────────────

      // D1: Simple reference — A1
      Cell.setValue(ws1, "D1", { formula: "A1+5", result: 0 });

      // D2: Absolute reference — $A$1
      Cell.setValue(ws1, "D2", { formula: "$A$1+$B$1", result: 0 });

      // D3: Mixed reference — $A2 (absolute col, relative row)
      Cell.setValue(ws1, "D3", { formula: "$A2*3", result: 0 });

      // D4: Range reference — SUM(A1:A3)
      Cell.setValue(ws1, "D4", { formula: "SUM(A1:A3)", result: 0 });

      // D5: Multi-column range — SUM(A1:B3)
      Cell.setValue(ws1, "D5", { formula: "SUM(A1:B3)", result: 0 });

      // D6: Cross-sheet reference — Sheet2!A1
      Cell.setValue(ws1, "D6", { formula: "Sheet2!A1", result: 0 });

      // D7: Cross-sheet range — SUM(Sheet2!A1:A3)
      Cell.setValue(ws1, "D7", { formula: "SUM(Sheet2!A1:A3)", result: 0 });

      // D8: Named range — SUM(MyValues)
      Cell.setValue(ws1, "D8", { formula: "SUM(MyValues)", result: 0 });

      // D9: Named single-cell range
      Cell.setValue(ws1, "D9", { formula: "Sheet2Val*2", result: 0 });

      // D10: Complex — combines cross-sheet + range + arithmetic
      Cell.setValue(ws1, "D10", {
        formula: "SUM(A1:A3)+Sheet2!A1",
        result: 0
      });

      // D11: Absolute in function — AVERAGE($B$1:$B$3)
      Cell.setValue(ws1, "D11", {
        formula: "AVERAGE($B$1:$B$3)",
        result: 0
      });

      // D12: Cross-sheet with absolute — Sheet2!$A$2
      Cell.setValue(ws1, "D12", { formula: "Sheet2!$A$2+1", result: 0 });

      // D13: Named range in expression — SUM(MyValues) * 10
      Cell.setValue(ws1, "D13", {
        formula: "SUM(MyValues)*10",
        result: 0
      });

      // ── Also add a formula on Sheet2 referencing Sheet1 ──────────────────
      Cell.setValue(ws2sheet, "B1", {
        formula: "SUM(Sheet1!A1:A3)",
        result: 0
      });

      Cell.setValue(ws2sheet, "B2", {
        formula: "Sheet1!B2+A1",
        result: 0
      });

      // ── Step 2: Write to buffer ──────────────────────────────────────────
      const buffer = await Workbook.toBuffer(wb1);

      // ── Step 3: Read back ────────────────────────────────────────────────
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer as Buffer);

      const s1 = Workbook.getWorksheet(wb2, "Sheet1")!;
      const s2 = Workbook.getWorksheet(wb2, "Sheet2")!;
      expect(s1).toBeDefined();
      expect(s2).toBeDefined();

      // Verify data survived
      expect(Cell.getValue(s1, "A1")).toBe(10);
      expect(Cell.getValue(s1, "B3")).toBe(300);
      expect(Cell.getValue(s2, "A1")).toBe(1000);

      // ── Step 4: Calculate ────────────────────────────────────────────────
      calculateFormulas(wb2);

      // ── Step 5: Verify results ───────────────────────────────────────────

      // D1: A1 + 5 = 10 + 5 = 15
      expect(Cell.getResult(s1, "D1")).toBe(15);

      // D2: $A$1 + $B$1 = 10 + 100 = 110
      expect(Cell.getResult(s1, "D2")).toBe(110);

      // D3: $A2 * 3 = 20 * 3 = 60
      expect(Cell.getResult(s1, "D3")).toBe(60);

      // D4: SUM(A1:A3) = 10 + 20 + 30 = 60
      expect(Cell.getResult(s1, "D4")).toBe(60);

      // D5: SUM(A1:B3) = (10+20+30) + (100+200+300) = 660
      expect(Cell.getResult(s1, "D5")).toBe(660);

      // D6: Sheet2!A1 = 1000
      expect(Cell.getResult(s1, "D6")).toBe(1000);

      // D7: SUM(Sheet2!A1:A3) = 1000 + 2000 + 3000 = 6000
      expect(Cell.getResult(s1, "D7")).toBe(6000);

      // D8: SUM(MyValues) = SUM(A1:A3) = 60
      expect(Cell.getResult(s1, "D8")).toBe(60);

      // D9: Sheet2Val * 2 = 1000 * 2 = 2000
      expect(Cell.getResult(s1, "D9")).toBe(2000);

      // D10: SUM(A1:A3) + Sheet2!A1 = 60 + 1000 = 1060
      expect(Cell.getResult(s1, "D10")).toBe(1060);

      // D11: AVERAGE($B$1:$B$3) = (100+200+300)/3 = 200
      expect(Cell.getResult(s1, "D11")).toBe(200);

      // D12: Sheet2!$A$2 + 1 = 2000 + 1 = 2001
      expect(Cell.getResult(s1, "D12")).toBe(2001);

      // D13: SUM(MyValues) * 10 = 60 * 10 = 600
      expect(Cell.getResult(s1, "D13")).toBe(600);

      // Sheet2 B1: SUM(Sheet1!A1:A3) = 60
      expect(Cell.getResult(s2, "B1")).toBe(60);

      // Sheet2 B2: Sheet1!B2 + A1 = 200 + 1000 = 1200
      expect(Cell.getResult(s2, "B2")).toBe(1200);
    });
  });

  // ==========================================================================
  // Test 3: Modify data after load, then recalculate
  // ==========================================================================
  describe("modify after load and recalculate", () => {
    it("should produce correct results after modifying data post-load", async () => {
      // Create original workbook with known values
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Sheet1");
      Cell.setValue(ws1, "A1", 10);
      Cell.setValue(ws1, "A2", 20);
      Cell.setValue(ws1, "A3", 30);
      Cell.setValue(ws1, "B1", { formula: "SUM(A1:A3)", result: 60 });
      Cell.setValue(ws1, "B2", { formula: "AVERAGE(A1:A3)", result: 20 });
      Cell.setValue(ws1, "B3", { formula: "A1*A2+A3", result: 230 });
      Cell.setValue(ws1, "B4", {
        formula: 'IF(B1>100,"big","small")',
        result: "small"
      });
      Cell.setValue(ws1, "B5", { formula: "B1+B3", result: 290 });

      // Write
      const buffer = await Workbook.toBuffer(wb1);

      // Read back
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer as Buffer);
      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

      // Modify the data cells — cached formula results are now stale
      Cell.setValue(ws2, "A1", 100);
      Cell.setValue(ws2, "A2", 200);
      Cell.setValue(ws2, "A3", 300);

      // Recalculate
      calculateFormulas(wb2);

      // Verify with new data
      expect(Cell.getResult(ws2, "B1")).toBe(600); // SUM(100,200,300)
      expect(Cell.getResult(ws2, "B2")).toBe(200); // AVERAGE(100,200,300)
      expect(Cell.getResult(ws2, "B3")).toBe(100 * 200 + 300); // 20300
      expect(Cell.getResult(ws2, "B4")).toBe("big"); // 600 > 100
      expect(Cell.getResult(ws2, "B5")).toBe(600 + 20300); // B1 + B3 = 20900
    });
  });

  // ==========================================================================
  // Test 4: Multi-sheet cross-references through round-trip
  // ==========================================================================
  describe("multi-sheet cross-reference round-trip", () => {
    it("should maintain cross-sheet formula relationships after round-trip", async () => {
      const wb1 = Workbook.create();

      // Sheet: Revenue
      const revenue = Workbook.addWorksheet(wb1, "Revenue");
      Cell.setValue(revenue, "A1", "Q1");
      Cell.setValue(revenue, "B1", 10000);
      Cell.setValue(revenue, "A2", "Q2");
      Cell.setValue(revenue, "B2", 15000);
      Cell.setValue(revenue, "A3", "Q3");
      Cell.setValue(revenue, "B3", 12000);
      Cell.setValue(revenue, "A4", "Q4");
      Cell.setValue(revenue, "B4", 20000);
      Cell.setValue(revenue, "A5", "Total");
      Cell.setValue(revenue, "B5", { formula: "SUM(B1:B4)", result: 0 });

      // Sheet: Expenses
      const expenses = Workbook.addWorksheet(wb1, "Expenses");
      Cell.setValue(expenses, "A1", "Q1");
      Cell.setValue(expenses, "B1", 8000);
      Cell.setValue(expenses, "A2", "Q2");
      Cell.setValue(expenses, "B2", 9000);
      Cell.setValue(expenses, "A3", "Q3");
      Cell.setValue(expenses, "B3", 7500);
      Cell.setValue(expenses, "A4", "Q4");
      Cell.setValue(expenses, "B4", 11000);
      Cell.setValue(expenses, "B5", { formula: "SUM(B1:B4)", result: 0 });

      // Sheet: Summary — references both other sheets
      const summary = Workbook.addWorksheet(wb1, "Summary");
      Cell.setValue(summary, "A1", "Total Revenue");
      Cell.setValue(summary, "B1", {
        formula: "Revenue!B5",
        result: 0
      });
      Cell.setValue(summary, "A2", "Total Expenses");
      Cell.setValue(summary, "B2", {
        formula: "Expenses!B5",
        result: 0
      });
      Cell.setValue(summary, "A3", "Net Profit");
      Cell.setValue(summary, "B3", { formula: "B1-B2", result: 0 });
      Cell.setValue(summary, "A4", "Profit Margin");
      Cell.setValue(summary, "B4", {
        formula: "ROUND(B3/B1*100,1)",
        result: 0
      });

      // Write → Read
      const buffer = await Workbook.toBuffer(wb1);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer as Buffer);

      // Calculate
      calculateFormulas(wb2);

      const s = Workbook.getWorksheet(wb2, "Summary")!;
      const r = Workbook.getWorksheet(wb2, "Revenue")!;
      const e = Workbook.getWorksheet(wb2, "Expenses")!;

      // Revenue total: 10000+15000+12000+20000 = 57000
      expect(Cell.getResult(r, "B5")).toBe(57000);

      // Expenses total: 8000+9000+7500+11000 = 35500
      expect(Cell.getResult(e, "B5")).toBe(35500);

      // Summary references
      expect(Cell.getResult(s, "B1")).toBe(57000);
      expect(Cell.getResult(s, "B2")).toBe(35500);
      expect(Cell.getResult(s, "B3")).toBe(21500); // Net profit
      // Profit margin: ROUND(21500/57000*100, 1) = ROUND(37.719..., 1) = 37.7
      expect(Cell.getResult(s, "B4")).toBeCloseTo(37.7, 1);
    });
  });

  // ==========================================================================
  // Test 5: Formula types variety — INDEX/MATCH, logical, text, math
  // ==========================================================================
  describe("formula variety round-trip", () => {
    it("should correctly evaluate INDEX/MATCH, SUMPRODUCT, and text formulas after round-trip", async () => {
      const wb1 = Workbook.create();
      const ws = Workbook.addWorksheet(wb1, "Sheet1");

      // Lookup table
      Cell.setValue(ws, "A1", "Product");
      Cell.setValue(ws, "B1", "Price");
      Cell.setValue(ws, "C1", "Qty");
      Cell.setValue(ws, "A2", "Widget");
      Cell.setValue(ws, "B2", 9.99);
      Cell.setValue(ws, "C2", 5);
      Cell.setValue(ws, "A3", "Gadget");
      Cell.setValue(ws, "B3", 24.5);
      Cell.setValue(ws, "C3", 3);
      Cell.setValue(ws, "A4", "Doohickey");
      Cell.setValue(ws, "B4", 14.75);
      Cell.setValue(ws, "C4", 8);

      // E1: INDEX+MATCH — find Gadget's price
      Cell.setValue(ws, "E1", {
        formula: 'INDEX(B2:B4,MATCH("Gadget",A2:A4,0))',
        result: 0
      });

      // E2: SUMPRODUCT — total revenue
      Cell.setValue(ws, "E2", {
        formula: "SUMPRODUCT(B2:B4,C2:C4)",
        result: 0
      });

      // E3: UPPER
      Cell.setValue(ws, "E3", { formula: "UPPER(A2)", result: "" });

      // E4: MID
      Cell.setValue(ws, "E4", { formula: "MID(A4,4,3)", result: "" });

      // E5: ABS of negative
      Cell.setValue(ws, "E5", { formula: "ABS(-42.5)", result: 0 });

      // E6: MOD
      Cell.setValue(ws, "E6", { formula: "MOD(17,5)", result: 0 });

      // E7: POWER
      Cell.setValue(ws, "E7", { formula: "POWER(2,10)", result: 0 });

      // Write → Read → Calculate
      const buffer = await Workbook.toBuffer(wb1);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer as Buffer);
      calculateFormulas(wb2);

      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

      // E1: Gadget price = 24.5
      expect(Cell.getResult(ws2, "E1")).toBe(24.5);

      // E2: SUMPRODUCT = 9.99*5 + 24.5*3 + 14.75*8 = 49.95+73.5+118 = 241.45
      expect(Cell.getResult(ws2, "E2")).toBeCloseTo(241.45, 2);

      // E3: UPPER("Widget") = "WIDGET"
      expect(Cell.getResult(ws2, "E3")).toBe("WIDGET");

      // E4: MID("Doohickey", 4, 3) = "hic"
      expect(Cell.getResult(ws2, "E4")).toBe("hic");

      // E5: ABS(-42.5) = 42.5
      expect(Cell.getResult(ws2, "E5")).toBe(42.5);

      // E6: MOD(17, 5) = 2
      expect(Cell.getResult(ws2, "E6")).toBe(2);

      // E7: POWER(2, 10) = 1024
      expect(Cell.getResult(ws2, "E7")).toBe(1024);
    });
  });

  // ==========================================================================
  // Test 6: Shared formulas through round-trip
  // ==========================================================================
  describe("shared formulas round-trip", () => {
    it("should handle fillFormula through round-trip correctly", async () => {
      const wb1 = Workbook.create();
      const ws = Workbook.addWorksheet(wb1, "Sheet1");

      // Data
      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 20);
      Cell.setValue(ws, "A3", 30);
      Cell.setValue(ws, "A4", 40);
      Cell.setValue(ws, "A5", 50);

      // Shared formula: B1=A1*2, B2=A2*2, ... B5=A5*2
      Worksheet.fillFormula(ws, "B1:B5", "A1*2", [20, 40, 60, 80, 100]);

      // Write → Read → Calculate
      const buffer = await Workbook.toBuffer(wb1);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer as Buffer);
      calculateFormulas(wb2);

      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

      expect(Cell.getResult(ws2, "B1")).toBe(20);
      expect(Cell.getResult(ws2, "B2")).toBe(40);
      expect(Cell.getResult(ws2, "B3")).toBe(60);
      expect(Cell.getResult(ws2, "B4")).toBe(80);
      expect(Cell.getResult(ws2, "B5")).toBe(100);
    });
  });

  // ==========================================================================
  // Test 7: Error formulas survive round-trip
  // ==========================================================================
  describe("error handling round-trip", () => {
    it("should correctly produce errors after round-trip", async () => {
      const wb1 = Workbook.create();
      const ws = Workbook.addWorksheet(wb1, "Sheet1");

      Cell.setValue(ws, "A1", 10);
      Cell.setValue(ws, "A2", 0);

      // Division by zero
      Cell.setValue(ws, "B1", { formula: "A1/A2", result: 0 });

      // IFERROR wrapping division by zero
      Cell.setValue(ws, "B2", {
        formula: 'IFERROR(A1/A2,"Div/0!")',
        result: ""
      });

      // VLOOKUP not found
      Cell.setValue(ws, "C1", "Apple");
      Cell.setValue(ws, "D1", 1);
      Cell.setValue(ws, "B3", {
        formula: 'VLOOKUP("Mango",C1:D1,2,FALSE)',
        result: 0
      });

      // Write → Read → Calculate
      const buffer = await Workbook.toBuffer(wb1);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer as Buffer);
      calculateFormulas(wb2);

      const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

      // B1: #DIV/0!
      expect(Cell.getResult(ws2, "B1")).toEqual({ error: "#DIV/0!" });

      // B2: IFERROR catches it
      expect(Cell.getResult(ws2, "B2")).toBe("Div/0!");

      // B3: #N/A (not found)
      expect(Cell.getResult(ws2, "B3")).toEqual({ error: "#N/A" });
    });
  });

  // ==========================================================================
  // Test 8: Double round-trip (write → read → write → read → calculate)
  // ==========================================================================
  describe("double round-trip", () => {
    it("should survive write→read→write→read→calculate", async () => {
      // First workbook
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Sheet1");
      Cell.setValue(ws1, "A1", 7);
      Cell.setValue(ws1, "A2", 8);
      Cell.setValue(ws1, "A3", { formula: "A1+A2", result: 15 });
      Cell.setValue(ws1, "A4", { formula: "A3*A1", result: 105 });

      // First round-trip
      const buf1 = await Workbook.toBuffer(wb1);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buf1 as Buffer);

      // Second round-trip
      const buf2 = await Workbook.toBuffer(wb2);
      const wb3 = Workbook.create();
      await Workbook.read(wb3, buf2 as Buffer);

      // Calculate on the doubly-round-tripped workbook
      calculateFormulas(wb3);

      const ws3 = Workbook.getWorksheet(wb3, "Sheet1")!;
      expect(Cell.getResult(ws3, "A3")).toBe(15);
      expect(Cell.getResult(ws3, "A4")).toBe(105);
    });
  });
});
