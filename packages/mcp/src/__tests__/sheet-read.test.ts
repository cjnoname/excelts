/**
 * `sheet_read` tests.
 *
 * The behaviours worth pinning are the ones that protect the model's context:
 * the row cap, the used-area intersection, the pagination cursor, and the
 * column-letter/row-number header that lets the model reference cells by
 * address afterwards.
 */

import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Cell, Workbook, Worksheet } from "documonster/excel";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { sheetReadTool } from "../tools/sheet-read.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-sheetread-")));
  return { config: resolveConfig([], { cwd: root }), root };
}

async function read(fx: Fixture, args: Record<string, unknown>): Promise<string> {
  const result = await sheetReadTool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(`tool returned isError: ${text}`);
  }
  return text;
}

/** Build a workbook with `rows` data rows plus a header. */
async function makeWorkbook(fx: Fixture, name: string, rows: number): Promise<string> {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Data");
  Worksheet.addAoa(ws, [
    ["region", "amount"],
    ...Array.from({ length: rows }, (_, index) => [`r${index + 1}`, (index + 1) * 10])
  ]);
  Workbook.addWorksheet(wb, "Notes");
  const target = path.join(fx.root, name);
  await Workbook.writeFile(wb, target);
  return name;
}

/**
 * Split a rendered table row on its real delimiters, the way GFM does.
 *
 * A `|` ends a cell unless an odd number of backslashes precedes it. Counting
 * cells this way is the only way to prove an escaped value stayed in one column
 * instead of silently shifting the rest of the row.
 */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let backslashes = 0;
  for (const char of row) {
    if (char === "|" && backslashes % 2 === 0) {
      cells.push(current);
      current = "";
      backslashes = 0;
      continue;
    }
    backslashes = char === "\\" ? backslashes + 1 : 0;
    current += char;
  }
  cells.push(current);
  // Drop the empty leading and trailing fields created by the outer pipes.
  return cells.slice(1, -1).map(cell => cell.trim());
}

describe("sheet_read", () => {
  it("renders a table with column letters and row numbers", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsx", 2);

    const text = await read(fx, { path: file });
    // The header row and row numbers are what let the model say "B3" next.
    expect(text).toContain("|  | A | B |");
    expect(text).toContain("| 1 | region | amount |");
    expect(text).toContain("| 2 | r1 | 10 |");
  });

  it("reports the used area and the sheet it read", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsx", 3);
    const text = await read(fx, { path: file });
    expect(text).toContain('sheet "Data"');
    expect(text).toContain("used area: **A1:B4**");
  });

  it("lists the other sheets so the model can switch", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsx", 1);
    expect(await read(fx, { path: file })).toContain("other sheets: Notes");
  });

  it("selects a sheet by name and by index", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsx", 1);
    expect(await read(fx, { path: file, sheet: "Notes" })).toContain("The sheet is empty.");
    expect(await read(fx, { path: file, sheet: 2 })).toContain("The sheet is empty.");
  });

  it("names the available sheets when the requested one is wrong", async () => {
    // The handler throws; server.ts is what turns a throw into an isError
    // result. Asserting on the throw keeps this a unit test of the message the
    // model will read.
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsx", 1);
    // The list of real names is the actionable part, so it lives in `hint`;
    // formatToolError shows both to the model.
    await expect(
      sheetReadTool.handler({ path: file, sheet: "Nope" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpToolError &&
        error.message.includes('no sheet named "Nope"') &&
        (error.hint ?? "").includes('"Data", "Notes"'),
      "expected the error to name the sheets that do exist"
    );
  });

  it("reports an out-of-range sheet index", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsx", 1);
    await expect(
      sheetReadTool.handler({ path: file, sheet: 9 }, { config: fx.config })
    ).rejects.toThrow(/out of range \(workbook has 2\)/);
  });

  it("caps the rows returned and says how to continue", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "big.xlsx", 200);

    const text = await read(fx, { path: file, maxRows: 10 });
    expect(text).toContain("showing: **A1:B10**");
    // Truncation must be explicit and actionable, or the model treats a partial
    // read as the whole sheet.
    expect(text).toContain("191 row(s) not shown");
    expect(text).toContain("`startRow: 11`");
    expect(text).not.toContain("| 11 |");
  });

  it("resumes from startRow", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "big.xlsx", 200);
    const text = await read(fx, { path: file, maxRows: 5, startRow: 11 });
    expect(text).toContain("showing: **A11:B15**");
    expect(text).toContain("| 11 | r10 | 100 |");
  });

  it("intersects an oversized range with the used area instead of padding blanks", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsx", 2);
    const text = await read(fx, { path: file, range: "A1:B400" });
    expect(text).toContain("showing: **A1:B3**");
    expect(text).not.toContain("| 4 |");
  });

  it("says so when the range misses the data entirely", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsx", 2);
    expect(await read(fx, { path: file, range: "Z100:AA200" })).toContain("lies entirely outside");
  });

  it("shows formulas rather than results when asked", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 4);
    Cell.setValue(ws, "A2", 6);
    // Stored without a leading "=" — that is the core's contract.
    Cell.setValue(ws, "A3", { formula: "SUM(A1:A2)", result: 10 });
    await Workbook.writeFile(wb, path.join(fx.root, "f.xlsx"));

    expect(await read(fx, { path: "f.xlsx", mode: "values" })).toContain("| 3 | 10 |");
    expect(await read(fx, { path: "f.xlsx", mode: "formulas" })).toContain("| 3 | =SUM(A1:A2) |");
    const both = await read(fx, { path: "f.xlsx", mode: "both" });
    expect(both).toContain("10");
    expect(both).toContain("=SUM(A1:A2)");
  });

  it("reports merged regions, whose neighbours read blank", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addAoa(ws, [["title"], ["a"]]);
    Worksheet.merge(ws, "A1:C1");
    await Workbook.writeFile(wb, path.join(fx.root, "m.xlsx"));

    expect(await read(fx, { path: "m.xlsx" })).toContain("merged regions: A1:C1");
  });

  it("applies the number format, so values read as the user sees them", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 1234.5);
    Cell.setNumFmt(ws, "A1", "#,##0.00");
    await Workbook.writeFile(wb, path.join(fx.root, "n.xlsx"));

    expect(await read(fx, { path: "n.xlsx" })).toContain("1,234.50");
  });

  it("escapes a pipe so it cannot shift every later column", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addAoa(ws, [["a|b", "c"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "p.xlsx"));

    const text = await read(fx, { path: "p.xlsx" });
    expect(text).toContain("a\\|b");
  });

  it("escapes a backslash so it cannot neutralize the pipe's escape", async () => {
    // `a\|b` escaped as pipe-only becomes `a\\|b`: GFM reads `\\` as one literal
    // backslash and the pipe as a live delimiter, so the row silently gains a
    // column and every later value is attributed to the wrong one.
    const fx = await fixture();
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Worksheet.addAoa(ws, [["a\\|b", "c"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "b.xlsx"));

    const text = await read(fx, { path: "b.xlsx" });
    const row = text.split("\n").find(line => line.startsWith("| 1 |"));
    expect(row).toBeDefined();
    expect(row).toContain("a\\\\\\|b");
    // Row number plus two cells — the pipe inside the value must not add a third.
    expect(splitCells(row ?? "")).toEqual(["1", "a\\\\\\|b", "c"]);
  });

  it("rejects a non-workbook with an actionable error", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "not.xlsx"), "just text", "utf8");

    await expect(
      sheetReadTool.handler({ path: "not.xlsx" }, { config: fx.config })
    ).rejects.toThrow(/could not read not\.xlsx as a workbook/);
  });

  it("rejects a startRow past the end of the range", async () => {
    const fx = await fixture();
    const file = await makeWorkbook(fx, "book.xlsx", 2);
    await expect(
      sheetReadTool.handler({ path: file, startRow: 900 }, { config: fx.config })
    ).rejects.toThrow(/past the end of the range/);
  });
});
