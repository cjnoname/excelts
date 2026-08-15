/**
 * `formula_evaluate` — run a spreadsheet formula against a supplied cell context.
 *
 * The most distinctive tool here. A model asked "is this XLOOKUP right?" can
 * only answer from memory of Excel semantics, and it is often confidently wrong
 * about match modes, error propagation and date serials. This turns the
 * question into an execution: build a throwaway workbook, populate the context,
 * evaluate with the real engine (450-odd functions, spill support), read back
 * what Excel would actually show.
 *
 * Touches no files, so it is safe under --readonly.
 */

import { Address, Cell, Workbook } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";
import { z } from "zod";

import { toolError } from "../errors.js";
import { textResult } from "./result.js";
import {
  MAX_EXCEL_COLUMNS,
  MAX_EXCEL_ROWS,
  normalizeFormula,
  renderCell,
  type SheetHandle
} from "./spreadsheet.js";
import { defineTool } from "./types.js";

/** Default formula location, clear of typical context but with room to spill. */
const DEFAULT_PROBE = "Z1";

/** Cap on spilled cells reported back. */
const MAX_SPILL_REPORTED = 200;

/** Furthest a spill is probed in either direction. */
const MAX_SPILL_SPAN = 500;

export const formulaEvaluateTool = defineTool({
  name: "formula_evaluate",
  group: "excel",
  title: "Evaluate a spreadsheet formula",
  description:
    "Evaluate an Excel formula against cell values you supply, using the real calculation engine (450+ functions including XLOOKUP, LET, LAMBDA, dynamic arrays, financial and statistical functions). Use it to check a formula's result or semantics instead of reasoning about Excel from memory. Reads and writes no files.",
  inputSchema: {
    formula: z
      .string()
      .min(1)
      .describe('The formula, with or without a leading "=", e.g. "=SUM(A1:A3)*1.08".'),
    context: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe(
        'Cell values the formula references, by address: { "A1": 10, "A2": 20, "B1": "widget" }. Omit for self-contained formulas.'
      ),
    contextFormulas: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Context cells that are themselves formulas, by address — for testing dependency chains."
      ),
    cell: z
      .string()
      .optional()
      .describe(
        'Cell where the formula is evaluated. Defaults to "Z1". Set this when testing ROW(), COLUMN() or relative references. It must not also appear in context.'
      )
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  mutates: false,
  handler: async (args, context) => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");

    for (const [address, value] of Object.entries(args.context ?? {})) {
      Cell.setValue(ws, requireAddress(address, "context"), value);
    }
    for (const [address, formula] of Object.entries(args.contextFormulas ?? {})) {
      Cell.setValue(ws, requireAddress(address, "contextFormulas"), {
        formula: normalizeFormula(formula)
      });
    }

    const probe = requireAddress(args.cell ?? DEFAULT_PROBE, "cell");
    if (probe in (args.context ?? {}) || probe in (args.contextFormulas ?? {})) {
      throw toolError.invalidInput(
        `probe cell ${probe} is also present in the context`,
        "Choose a different `cell`; the formula result would otherwise overwrite that context value."
      );
    }
    const probeAddress = Address.decodeCell(probe);
    Cell.setValue(ws, probe, { formula: normalizeFormula(args.formula) });

    try {
      calculateFormulas(wb);
    } catch (cause) {
      throw toolError.invalidInput(
        `the formula could not be evaluated: ${cause instanceof Error ? cause.message : String(cause)}`,
        "Check the syntax — argument separators are commas, and sheet-qualified references need a sheet that exists in `context`.",
        { cause }
      );
    }

    const lines = [
      "# formula_evaluate",
      "",
      `- formula: \`=${normalizeFormula(args.formula)}\``,
      `- evaluated at: \`${probe}\``,
      `- result: **${describeResult(ws, probe)}**`,
      `- displayed as: \`${Cell.getDisplayText(ws, probe)}\``
    ];

    const spill = collectSpill(ws, probeAddress.r + 1, probeAddress.c + 1);
    if (spill.length > 0) {
      lines.push(
        `- this is a dynamic array: it spills over ${spill.length + 1} cells`,
        "",
        "Spilled values:",
        "",
        ...[
          `| offset | value |`,
          `| --- | --- |`,
          `| 0 (anchor) | ${Cell.getDisplayText(ws, probe)} |`
        ],
        ...spill.slice(0, MAX_SPILL_REPORTED).map(entry => `| ${entry.label} | ${entry.text} |`),
        ...(spill.length > MAX_SPILL_REPORTED
          ? [`[${spill.length - MAX_SPILL_REPORTED} more spilled value(s) not listed]`]
          : [])
      );
    }

    const contextCells =
      Object.keys(args.context ?? {}).length + Object.keys(args.contextFormulas ?? {}).length;
    if (contextCells > 0) {
      lines.push("", `Evaluated with ${contextCells} context cell(s).`);
      const derived = Object.keys(args.contextFormulas ?? {});
      if (derived.length > 0) {
        lines.push(
          "",
          "Context formula results:",
          "",
          ...derived.map(address => {
            const upper = requireAddress(address, "contextFormulas");
            return `- \`${upper}\` = ${Cell.getDisplayText(ws, upper)}`;
          })
        );
      }
    }

    return textResult(context.config, lines.join("\n"));
  }
});

/**
 * Describe the evaluated result, naming an Excel error explicitly.
 *
 * `#SPILL!` / `#NAME?` / `#DIV/0!` are answers, not failures — the caller
 * usually asked precisely to find out whether one occurs, so they are reported
 * as results rather than raised as tool errors.
 */
function describeResult(ws: SheetHandle, address: string): string {
  const value = Cell.getValue(ws, address);

  if (value !== null && typeof value === "object" && "result" in value) {
    const result = (value as { result?: unknown }).result;
    if (
      result !== null &&
      typeof result === "object" &&
      result !== undefined &&
      "error" in result
    ) {
      const code = (result as { error?: unknown }).error;
      return `${String(code)} (an Excel error value, not a tool failure)`;
    }
    return formatScalar(result);
  }

  return formatScalar(value);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "(blank)";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value);
}

/**
 * Find cells the probe spilled into.
 *
 * Grows the rectangle outward from the anchor rather than sweeping the used
 * area: the used area also contains the caller's context cells, so a sweep
 * would cost thousands of reads and could report unrelated values as spill.
 * A spill is contiguous, so stopping at the first empty row and column is both
 * cheaper and more accurate.
 */
function collectSpill(
  ws: SheetHandle,
  anchorRow: number,
  anchorColumn: number
): { label: string; text: string }[] {
  const width = measureRun(
    column => Cell.getValue(ws, anchorRow, anchorColumn + column),
    Math.min(MAX_SPILL_SPAN, MAX_EXCEL_COLUMNS - anchorColumn + 1)
  );
  const height = measureRun(
    row => Cell.getValue(ws, anchorRow + row, anchorColumn),
    Math.min(MAX_SPILL_SPAN, MAX_EXCEL_ROWS - anchorRow + 1)
  );

  const found: { label: string; text: string }[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if (row === 0 && column === 0) {
        continue;
      }
      const value = Cell.getValue(ws, anchorRow + row, anchorColumn + column);
      if (value === null || value === undefined) {
        continue;
      }
      found.push({
        label: `r+${row},c+${column}`,
        text: renderCell(ws, anchorRow + row, anchorColumn + column, "values")
      });
    }
  }
  return found;
}

/** Length of the contiguous non-empty run starting at offset 0. */
function measureRun(read: (offset: number) => unknown, limit: number): number {
  let length = 0;
  while (length < limit) {
    const value = read(length);
    if (value === null || value === undefined) {
      break;
    }
    length += 1;
  }
  return Math.max(1, length);
}

function requireAddress(address: string, field: string): string {
  const upper = address.trim().toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(upper)) {
    throw toolError.invalidInput(
      `${field} key ${JSON.stringify(address)} is not a cell address`,
      'Use plain A1 notation, e.g. "B2".'
    );
  }
  return upper;
}
