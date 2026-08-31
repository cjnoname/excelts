/**
 * `sheet_edit` — patch an existing workbook in place.
 *
 * The counterpart to `sheet_write`: that one builds a file, this one changes a
 * file someone already has. The distinction matters because the risky operation
 * is the second — a user's real spreadsheet, whose other sheets, formatting and
 * formulas must survive untouched.
 *
 * Two safeguards follow from that. Operations are applied to an in-memory copy
 * and only written once every one of them has succeeded, so a bad op cannot
 * leave a half-edited file. And `dryRun` reports what *would* change without
 * writing, because a model's decision to edit is far likelier to be wrong than
 * its ability to execute the edit.
 */

import { stat } from "node:fs/promises";

import { Cell, Workbook, Worksheet } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { toolError } from "../errors.js";
import { assertWritable, resolveEditTarget, resolveInRoot } from "../sandbox.js";
import { addChart, chartSchema } from "./chart.js";
import { requireSpreadsheetFormat } from "./document.js";
import {
  assertUnchanged,
  backupOnce,
  describeBackup,
  fingerprint,
  replaceAtomically
} from "./fs-helpers.js";
import { newImageBudget, resolveImageSource, type ResolvedImage } from "./image.js";
import { textResult } from "./result.js";
import { imageSchema, placeImage } from "./sheet-image.js";
import {
  describeWindow,
  normalizeFormula,
  parseRange,
  requireSheet,
  sheetName,
  toArgb,
  type SheetHandle
} from "./spreadsheet.js";
import { defineTool } from "./types.js";

/** Cells one op may touch, so an unbounded range cannot hang the server. */
const MAX_OP_CELLS = 100_000;

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * One edit.
 *
 * A discriminated union keeps the schema small while still describing every
 * operation precisely — the model sees one `op` field and only the parameters
 * that operation needs.
 */
const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_cell"),
    ref: z.string().describe('Cell address, e.g. "B7".'),
    value: cellValue
  }),
  z.object({
    op: z.literal("set_range"),
    range: z.string().describe('Target range, e.g. "A2:C4".'),
    rows: z
      .array(z.array(cellValue))
      .describe("Row-major values, written from the range's top-left.")
  }),
  z.object({
    op: z.literal("set_formula"),
    range: z.string().describe('Cell or range, e.g. "D2:D99".'),
    formula: z
      .string()
      .describe('Formula, with or without a leading "=". Applied to every cell in the range.')
  }),
  z.object({
    op: z.literal("clear"),
    range: z.string().describe("Range whose values are removed.")
  }),
  z.object({
    op: z.literal("insert_rows"),
    at: z.number().int().positive().describe("1-based row to insert before."),
    rows: z.array(z.array(cellValue)).min(1).describe("Rows to insert.")
  }),
  z.object({
    op: z.literal("delete_rows"),
    at: z.number().int().positive().describe("1-based first row to delete."),
    count: z.number().int().positive().describe("How many rows to delete.")
  }),
  z.object({
    op: z.literal("set_style"),
    range: z.string(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    fontColor: z.string().optional().describe('Hex RGB, e.g. "C00000".'),
    fillColor: z.string().optional().describe('Hex RGB, e.g. "FFEB3B".'),
    numFmt: z.string().optional().describe('Number format, e.g. "#,##0.00".')
  }),
  z.object({
    op: z.literal("add_sheet"),
    name: z.string().min(1).max(31),
    rows: z.array(z.array(cellValue)).optional()
  }),
  z.object({
    op: z.literal("add_image"),
    ...imageSchema.shape
  }),
  z.object({
    op: z.literal("add_chart"),
    chart: chartSchema
  })
  // Renaming is deliberately absent: the public worksheet model setter does
  // not rewrite cross-sheet formulas/charts and can fail on merged sheets. A
  // half-working rename silently corrupts more than it helps.
]);

export const sheetEditTool = defineTool({
  name: "sheet_edit",
  group: "excel",
  title: "Edit an existing spreadsheet",
  description:
    "Apply a list of edits to an existing .xlsx, .xlsm, or .xlsb: set cells, ranges or formulas, clear, insert or delete rows, restyle, add a chart or add a sheet. All edits succeed or none are written. Charts currently require .xlsx/.xlsm output. Use dryRun first to see what would change. Read the sheet with sheet_read before editing so cell references are right. Renaming is intentionally not exposed because formulas and chart references cannot be rewritten safely.",
  inputSchema: {
    path: z.string().min(1).describe("Workbook to edit, relative to the server root."),
    out: z
      .string()
      .optional()
      .describe(
        "Write the edited workbook here under @output/. Required for input files unless --allow-in-place is enabled; omit when editing an @output file."
      ),
    sheet: z
      .union([z.string(), z.number().int().positive()])
      .optional()
      .describe("Sheet the edits apply to, by name or 1-based index. Defaults to the first."),
    ops: z.array(opSchema).min(1).describe("Edits, applied in order."),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "Report what would change without writing. Do this first when editing a file the user cares about — a wrong edit produces a plausible-looking but incorrect document, which is worse than an error."
      ),
    backup: z
      .boolean()
      .optional()
      .describe("Copy the original to <name>.bak before writing. Defaults to true."),
    recalculate: z
      .boolean()
      .optional()
      .describe("Re-evaluate formulas after editing so values stay consistent. Defaults to true.")
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  },
  mutates: true,
  handler: async (args, context) => {
    const { config } = context;
    assertWritable(config);
    requireSpreadsheetFormat(args.path, "path");
    const outputFormat = requireSpreadsheetFormat(args.out ?? args.path, args.out ? "out" : "path");
    if (outputFormat === "xlsb" && args.ops.some(op => op.op === "add_chart")) {
      throw toolError.unsupported(
        "cannot add charts to XLSB output yet",
        "Use an .xlsx output path, or omit the add_chart operation. Other sheet_edit operations are supported in XLSB."
      );
    }

    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    const inputVersion = await fingerprint(resolved);
    const stats = await stat(resolved);
    if (stats.size > config.maxFileSize) {
      throw toolError.tooLarge(
        `${args.path} is ${stats.size} bytes, over the ${config.maxFileSize} byte limit`,
        "Ask the user to raise --max-file-size."
      );
    }

    const wb = Workbook.create();
    try {
      await Workbook.readFile(wb, resolved);
    } catch (cause) {
      throw toolError.unsupported(
        `could not read ${args.path} as a workbook`,
        "Run doc_inspect to confirm the file really is an XLSX, XLSM, or XLSB package.",
        { cause }
      );
    }

    const ws = requireSheet(wb, args.sheet);
    const target = sheetName(ws);
    const applied: string[] = [];

    // Images are read, and diagrams drawn, before the first op runs. The op loop
    // is synchronous by design — every change lands in memory before anything is
    // written — so the one asynchronous step has to happen ahead of it, and a
    // picture that cannot be read fails before any edit is applied.
    const images = await resolveOpImages(config, args.ops);

    // Every op runs against the in-memory workbook first. Nothing is written
    // until all of them have succeeded, so a failure leaves the file untouched.
    for (const [index, op] of args.ops.entries()) {
      try {
        applied.push(applyOp(wb, ws, op, images));
      } catch (cause) {
        throw cause instanceof Error && cause.name === "McpToolError"
          ? cause
          : toolError.invalidInput(
              `op ${index + 1} (${op.op}) failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              "No changes were written. Fix this operation and retry.",
              { cause }
            );
      }
    }

    const recalculate = args.recalculate ?? true;
    let formulaNote = "formulas not re-evaluated (recalculate: false)";
    if (recalculate) {
      try {
        calculateFormulas(wb);
        formulaNote = "formulas re-evaluated";
      } catch (cause) {
        formulaNote = `formula re-evaluation failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }

    if (args.dryRun === true) {
      return textResult(
        config,
        [
          `**Dry run** — nothing was written to ${args.path}.`,
          `- sheet: ${JSON.stringify(target)}`,
          `- ${formulaNote}`,
          "",
          "Would apply:",
          ...applied.map((line, index) => `${index + 1}. ${line}`),
          "",
          "Re-run without dryRun to write these changes."
        ].join("\n")
      );
    }

    // Cheap insurance against a well-formed but wrong edit, which is the
    // likeliest failure and the one no error message can catch.
    await assertUnchanged(resolved, inputVersion);
    const writeTarget = await resolveEditTarget(config, args.path, args.out);
    const backupPath = (args.backup ?? true) ? await backupOnce(writeTarget) : undefined;

    // Written to a sibling and renamed: the in-memory application above is only
    // half of "atomic" — writing straight to the path would truncate the user's
    // file before the new bytes are complete.
    try {
      await replaceAtomically(writeTarget.path, temporary =>
        Workbook.writeFile(wb, temporary, { format: outputFormat })
      );
    } catch (cause) {
      if (outputFormat === "xlsb" && errorChainHasName(cause, "ExcelNotSupportedError")) {
        throw toolError.unsupported(
          "could not edit the XLSB without discarding unsupported workbook state",
          "The XLSB writer is strict by default. Use a tool that understands the unsupported feature; this MCP server does not expose lossy XLSB writes.",
          { cause }
        );
      }
      throw cause;
    }

    return textResult(
      config,
      [
        `Edited **${args.path}**, sheet ${JSON.stringify(target)} — ${applied.length} operation(s) applied.`,
        `- ${formulaNote}`,
        ...(backupPath === undefined
          ? ["- no backup was taken (backup: false)"]
          : describeBackup(writeTarget.display, backupPath)),
        "",
        ...applied.map((line, index) => `${index + 1}. ${line}`),
        "",
        "Read it back with sheet_read to verify before reporting success to the user."
      ].join("\n")
    );
  }
});

/**
 * Resolve every `add_image` source up front, keyed by its own op.
 *
 * Keyed by object identity rather than by position so `applyOp` stays
 * synchronous without carrying an index it could get wrong.
 */
async function resolveOpImages(
  config: ServerConfig,
  ops: readonly z.infer<typeof opSchema>[]
): Promise<Map<object, ResolvedImage>> {
  const resolved = new Map<object, ResolvedImage>();
  const budget = newImageBudget();
  for (const op of ops) {
    if (op.op === "add_image") {
      resolved.set(op, await resolveImageSource(config, op, { budget }));
    }
  }
  return resolved;
}

/** Apply one op, returning a human description of what it did. */
function applyOp(
  wb: ReturnType<typeof Workbook.create>,
  ws: SheetHandle,
  op: z.infer<typeof opSchema>,
  images: Map<object, ResolvedImage>
): string {
  switch (op.op) {
    case "set_cell": {
      const ref = requireAddress(op.ref);
      Cell.setValue(ws, ref, op.value);
      return `set ${ref} = ${JSON.stringify(op.value)}`;
    }

    case "set_range": {
      const window = boundedRange(op.range);
      let written = 0;
      for (const [rowOffset, row] of op.rows.entries()) {
        for (const [colOffset, value] of row.entries()) {
          const targetRow = window.top + rowOffset;
          const targetCol = window.left + colOffset;
          if (targetRow > window.bottom || targetCol > window.right) {
            continue;
          }
          Cell.setValue(ws, targetRow, targetCol, value);
          written += 1;
        }
      }
      return `set ${written} cell(s) in ${op.range}`;
    }

    case "set_formula": {
      const window = boundedRange(op.range);
      const formula = normalizeFormula(op.formula);
      const cells = (window.bottom - window.top + 1) * (window.right - window.left + 1);

      // `fillFormula` writes a real OOXML shared formula and translates relative
      // references per cell, which is what a caller asking for "=B2*C2 down
      // D2:D4" means. Writing the same literal text into every cell — the
      // obvious implementation — makes all three rows compute row 2, and looks
      // entirely plausible in the result.
      Worksheet.fillFormula(ws, describeWindow(window), formula);

      return cells === 1
        ? `set formula \`=${formula}\` on ${describeWindow(window)}`
        : `filled formula \`=${formula}\` across ${cells} cell(s) in ${describeWindow(window)}, translating relative references per cell`;
    }

    case "clear": {
      const window = boundedRange(op.range);
      let count = 0;
      for (let row = window.top; row <= window.bottom; row += 1) {
        for (let column = window.left; column <= window.right; column += 1) {
          Cell.setValue(ws, row, column, null);
          count += 1;
        }
      }
      return `cleared ${count} cell(s) in ${op.range}`;
    }

    // Structural moves shift cells but do not rewrite references that point at
    // them: a formula or chart elsewhere in the workbook keeps its old
    // coordinates. That is a limitation of the underlying operation, not
    // something this tool can paper over, so it is reported rather than hidden.
    case "insert_rows":
      Worksheet.insertRows(ws, op.at, op.rows as unknown[][] as never);
      return `inserted ${op.rows.length} row(s) before row ${op.at} — references to shifted cells elsewhere in the workbook are NOT adjusted; verify any formulas or charts that pointed below row ${op.at}`;

    case "delete_rows":
      Worksheet.spliceRows(ws, op.at, op.count);
      return `deleted ${op.count} row(s) from row ${op.at} — references to those cells elsewhere in the workbook are NOT adjusted and may now be wrong; verify any formulas or charts that pointed at them`;

    case "set_style": {
      const window = boundedRange(op.range);
      for (let row = window.top; row <= window.bottom; row += 1) {
        for (let column = window.left; column <= window.right; column += 1) {
          if (op.bold !== undefined || op.italic !== undefined || op.fontColor !== undefined) {
            Cell.setFont(ws, row, column, {
              ...(Cell.getFont(ws, row, column) ?? {}),
              ...(op.bold === undefined ? {} : { bold: op.bold }),
              ...(op.italic === undefined ? {} : { italic: op.italic }),
              ...(op.fontColor === undefined ? {} : { color: { argb: toArgb(op.fontColor) } })
            });
          }
          if (op.fillColor !== undefined) {
            Cell.setFill(ws, row, column, {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: toArgb(op.fillColor) }
            });
          }
          if (op.numFmt !== undefined) {
            Cell.setNumFmt(ws, row, column, op.numFmt);
          }
        }
      }
      return `restyled ${op.range}`;
    }

    case "add_sheet": {
      if (Workbook.getWorksheet(wb, op.name) !== undefined) {
        throw toolError.invalidInput(
          `a sheet named ${JSON.stringify(op.name)} already exists`,
          "Pick a different name. Renaming an existing sheet is not exposed because references elsewhere cannot be rewritten safely."
        );
      }
      const added = Workbook.addWorksheet(wb, op.name);
      if (op.rows !== undefined && op.rows.length > 0) {
        for (const [rowOffset, row] of op.rows.entries()) {
          for (const [columnOffset, value] of row.entries()) {
            Cell.setValue(added, rowOffset + 1, columnOffset + 1, value);
          }
        }
      }
      return `added sheet ${JSON.stringify(op.name)}${op.rows === undefined ? "" : ` with ${op.rows.length} row(s)`}`;
    }

    case "add_image": {
      const image = images.get(op);
      if (image === undefined) {
        // Unreachable: `resolveOpImages` walked this very list.
        throw toolError.invalidInput("an add_image op was not resolved before placement");
      }
      return placeImage(wb, ws, op.at, image);
    }

    case "add_chart":
      return addChart(ws, op.chart);
  }
}

/** Parse a range and refuse one large enough to hang the server. */
function boundedRange(range: string) {
  const window = parseRange(range);
  const cells = (window.bottom - window.top + 1) * (window.right - window.left + 1);
  if (cells > MAX_OP_CELLS) {
    throw toolError.tooLarge(
      `range ${JSON.stringify(range)} covers ${cells} cells, over the ${MAX_OP_CELLS} limit`,
      "Target only the rows that hold data."
    );
  }
  return window;
}

function requireAddress(address: string): string {
  const upper = address.trim().toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(upper)) {
    throw toolError.invalidInput(
      `${JSON.stringify(address)} is not a cell address`,
      'Use A1 notation for a single cell, e.g. "B10".'
    );
  }
  // Reuse the range parser for the Excel row/column bounds.
  parseRange(upper);
  return upper;
}

/** Whether an error or one of its ES2022 causes has the requested name. */
function errorChainHasName(value: unknown, name: string): boolean {
  const seen = new Set<Error>();
  let current = value;
  while (current instanceof Error && !seen.has(current)) {
    if (current.name === name) {
      return true;
    }
    seen.add(current);
    current = current.cause;
  }
  return false;
}
