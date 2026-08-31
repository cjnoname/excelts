/**
 * `sheet_write` — create a workbook from a declarative spec.
 *
 * Declarative rather than incremental for two reasons. A model driving twenty
 * `set_cell` calls burns twenty round trips and has to hold the intermediate
 * state; and `fromCsv` lets a source file be referenced by path so the rows
 * never pass through the model's context at all — which is the difference
 * between summarising three 4000-row CSVs and running out of budget trying.
 *
 * The schema is deliberately shallow. Every field here is sent to the model on
 * every request, so styling is limited to the handful of options that actually
 * change a report's usefulness; the deep option trees stay in `documonster_help`.
 */

import { Cell, Workbook, Worksheet } from "documonster/excel";
import { readCsvFile } from "documonster/excel/csv";
import { calculateFormulas } from "documonster/excel/formula";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { toolError } from "../errors.js";
import { assertWritable, outputDisplay, resolveInRoot, resolveOutputPath } from "../sandbox.js";
import { addChart, chartSchema, generateSchema, writeGenerated } from "./chart.js";
import { assertNonMacroOutput, requireSpreadsheetFormat } from "./document.js";
import { writeWithPolicy } from "./fs-helpers.js";
import { newImageBudget, resolveImageSource, type ResolvedImage } from "./image.js";
import { textResult } from "./result.js";
import { placeImage, imageSchema } from "./sheet-image.js";
import {
  normalizeFormula,
  parseRange,
  toArgb,
  type GridWindow,
  type SheetHandle,
  type WorkbookHandle
} from "./spreadsheet.js";
import { defineTool } from "./types.js";

/** A single cell value in `rows`. `null` writes a blank. */
const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const styleSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    fontColor: z.string().optional().describe('Hex RGB without "#", e.g. "C00000".'),
    fillColor: z
      .string()
      .optional()
      .describe('Solid background, hex RGB without "#", e.g. "FFEB3B".'),
    numFmt: z
      .string()
      .optional()
      .describe('Excel number format, e.g. "#,##0.00" or "0.0%" or "yyyy-mm-dd".')
  })
  .describe("Formatting applied to a range.");

const sheetSchema = z.object({
  name: z.string().min(1).max(31).describe("Sheet name (Excel allows at most 31 characters)."),
  fromCsv: z
    .string()
    .optional()
    .describe(
      "Path to a CSV to load as this sheet's contents, resolved on the server. Prefer this over `rows` for existing data: the rows never enter your context."
    ),
  csvDelimiter: z
    .string()
    .length(1)
    .optional()
    .describe("Delimiter for fromCsv. Omit to use a comma; doc_inspect reports the real one."),
  generate: generateSchema
    .optional()
    .describe(
      "Generate synthetic rows server-side instead of supplying them. Use this for test data — a few lines of column definitions beat emitting thousands of rows yourself."
    ),
  rows: z
    .array(z.array(cellValueSchema))
    .optional()
    .describe(
      "Row-major literal data, written from A1. Combine with fromCsv only if you mean to overwrite."
    ),
  cells: z
    .record(z.string(), cellValueSchema)
    .optional()
    .describe('Individual cells by address, e.g. { "D1": "Total" }. Applied after rows.'),
  formulas: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Formulas by address, e.g. { "B10": "=SUM(B2:B9)" }. A leading "=" is optional. Cross-sheet references work.'
    ),
  columnWidths: z
    .array(z.number().positive())
    .optional()
    .describe("Column widths in characters, left to right."),
  freezeRows: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Freeze this many top rows — use 1 when row 1 is a header."),
  merges: z.array(z.string()).optional().describe('Ranges to merge, e.g. ["A1:D1"].'),
  styles: z
    .array(z.object({ range: z.string(), style: styleSchema }))
    .optional()
    .describe('Formatting per range, e.g. [{ range: "A1:D1", style: { bold: true } }].'),
  charts: z
    .array(chartSchema)
    .optional()
    .describe(
      "Charts to place on this sheet. Ranges are plain A1 — the sheet qualification is added for you."
    ),
  images: z
    .array(imageSchema)
    .optional()
    .describe(
      'Pictures to place on this sheet: a .png/.jpg/.gif file, or a Mermaid diagram drawn server-side. e.g. [{ at: "F2", from: "logo.png" }, { at: "A10:H30", source: "flowchart LR\n A --> B" }].'
    )
});

export const sheetWriteTool = defineTool({
  name: "sheet_write",
  group: "excel",
  title: "Write a spreadsheet",
  description:
    "Create an .xlsx or .xlsb from a declarative spec: one call describes every sheet, its data, formulas, widths, freeze panes, merges and formatting. Use `fromCsv` to pull existing data in server-side instead of copying rows through your reply. Formulas are evaluated before saving unless recalculate is false. Charts currently require .xlsx.",
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe("Output .xlsx or .xlsb path below --output-root; returned as @output/<path>."),
    sheets: z.array(sheetSchema).min(1).describe("One entry per worksheet, in order."),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        "Replace the file if it already exists. Defaults to false so existing work is never lost silently."
      ),
    recalculate: z
      .boolean()
      .optional()
      .describe(
        "Evaluate formulas and store their results so other tools can read values. Defaults to true."
      )
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  mutates: true,
  handler: async (args, context) => {
    const { config } = context;
    assertWritable(config);
    assertNonMacroOutput(args.path);
    const format = requireSpreadsheetFormat(args.path, "path");
    if (
      format === "xlsb" &&
      args.sheets.some(sheet => sheet.charts !== undefined && sheet.charts.length > 0)
    ) {
      throw toolError.unsupported(
        "cannot create charts in XLSB output yet",
        "Use an .xlsx output path, or omit charts. Other sheet_write fields are supported in XLSB."
      );
    }

    const target = await resolveOutputPath(config, args.path);
    for (const sheet of args.sheets) {
      assertLegalSheetName(sheet.name);
    }
    assertUniqueNames(args.sheets.map(sheet => sheet.name));

    const wb = Workbook.create();
    const report: string[] = [];

    // Every image is read and, where it is a diagram, drawn *before* a single
    // sheet is built. A picture that cannot be read must not leave a half-built
    // workbook behind, and the resolution is the only asynchronous step in the
    // whole spec.
    const images = await resolveImages(config, args.sheets);

    for (const spec of args.sheets) {
      const ws = await buildSheet(wb, spec, config, report);
      applyLayout(wb, ws, spec, images, report);
    }

    const recalculate = args.recalculate ?? true;
    let formulaNote = "formulas not evaluated (recalculate: false)";
    if (recalculate) {
      try {
        calculateFormulas(wb);
        formulaNote = "formulas evaluated";
      } catch (cause) {
        // A bad formula must not lose the whole document — save it and say so,
        // which leaves the model a file it can inspect and repair.
        formulaNote = `formula evaluation failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }

    // Written to a sibling and renamed, so a failure part-way through cannot
    // leave a truncated workbook where a valid one used to be. `ensureParent`
    // is handled by the atomic writer, since a model writes "out/report.xlsx"
    // without checking that "out" exists.
    await writeWithPolicy(target, args.overwrite === true, temporary =>
      Workbook.writeFile(wb, temporary, { format })
    );

    return textResult(
      config,
      [
        `Wrote **${outputDisplay(args.path)}** (${args.sheets.length} sheet(s)): ${args.sheets.map(sheet => JSON.stringify(sheet.name)).join(", ")}`,
        `- ${formulaNote}`,
        ...report,
        "",
        "Read the returned @output path with sheet_read to verify before reporting success."
      ].join("\n")
    );
  }
});

/** Create one worksheet and fill it from CSV and/or literal data. */
async function buildSheet(
  wb: WorkbookHandle,
  spec: z.infer<typeof sheetSchema>,
  config: ServerConfig,
  report: string[]
): Promise<SheetHandle> {
  let ws: SheetHandle;

  if (spec.fromCsv !== undefined) {
    const source = await resolveInRoot(config, spec.fromCsv, { mustExist: true });
    // readCsvFile appends a new sheet named after the file, so rename it to the
    // requested name afterwards rather than creating a second, empty sheet.
    ws = await readCsvFile(
      wb,
      source,
      spec.csvDelimiter === undefined ? undefined : { delimiter: spec.csvDelimiter }
    );
    Worksheet.setModel(ws, { ...Worksheet.getModel(ws), name: spec.name });
    report.push(
      `- sheet ${JSON.stringify(spec.name)}: loaded ${Worksheet.actualRowCount(ws)} row(s) from ${spec.fromCsv} server-side`
    );
  } else {
    ws = Workbook.addWorksheet(wb, spec.name);
  }

  if (spec.generate !== undefined) {
    report.push(`- sheet ${JSON.stringify(spec.name)}: ${writeGenerated(ws, spec.generate)}`);
  }

  if (spec.rows !== undefined && spec.rows.length > 0) {
    // addAoa intentionally skips nulls, which is useful for sparse imports but
    // violates this schema's "null writes a blank" contract when rows overlay
    // fromCsv/generated data. Write the matrix explicitly so null clears the
    // previous value.
    for (const [rowOffset, row] of spec.rows.entries()) {
      for (const [columnOffset, value] of row.entries()) {
        Cell.setValue(ws, rowOffset + 1, columnOffset + 1, value);
      }
    }
  }

  for (const [address, value] of Object.entries(spec.cells ?? {})) {
    Cell.setValue(ws, normalizeAddress(address), value);
  }

  for (const [address, formula] of Object.entries(spec.formulas ?? {})) {
    // Strip the leading "=" — the core stores formula text without it, and
    // leaving it in makes every function resolve to #NAME?.
    Cell.setValue(ws, normalizeAddress(address), { formula: normalizeFormula(formula) });
  }

  return ws;
}

/**
 * Resolve every image in the spec up front, keyed by its own entry.
 *
 * Keyed by object identity rather than by position so the placement loop below
 * can stay synchronous without carrying an index it could get wrong.
 */
async function resolveImages(
  config: ServerConfig,
  sheets: readonly z.infer<typeof sheetSchema>[]
): Promise<Map<object, ResolvedImage>> {
  const resolved = new Map<object, ResolvedImage>();
  // One budget for the whole call: twenty sheets of one big picture each is the
  // same memory as one sheet of twenty.
  const budget = newImageBudget();
  for (const sheet of sheets) {
    for (const spec of sheet.images ?? []) {
      resolved.set(spec, await resolveImageSource(config, spec, { budget }));
    }
  }
  return resolved;
}

/** Apply widths, freeze panes, merges, styles, charts and images. */
function applyLayout(
  wb: WorkbookHandle,
  ws: SheetHandle,
  spec: z.infer<typeof sheetSchema>,
  images: Map<object, ResolvedImage>,
  report: string[]
): void {
  if (spec.columnWidths !== undefined && spec.columnWidths.length > 0) {
    Worksheet.setColumns(
      ws,
      spec.columnWidths.map(width => ({ width }))
    );
  }

  if (spec.freezeRows !== undefined && spec.freezeRows > 0) {
    ws.views = [{ state: "frozen", ySplit: spec.freezeRows }];
  }

  for (const range of spec.merges ?? []) {
    try {
      Worksheet.merge(ws, range);
    } catch (cause) {
      throw toolError.invalidInput(
        `could not merge ${JSON.stringify(range)} on sheet ${JSON.stringify(spec.name)}`,
        "Merges must not overlap each other.",
        { cause }
      );
    }
  }

  for (const entry of spec.styles ?? []) {
    applyStyle(ws, entry.range, entry.style);
  }

  // Charts last, so a default anchor sees the sheet's final used area.
  for (const chart of spec.charts ?? []) {
    report.push(`- sheet ${JSON.stringify(spec.name)}: ${addChart(ws, chart)}`);
  }

  for (const entry of spec.images ?? []) {
    const image = images.get(entry);
    if (image === undefined) {
      // Unreachable: `resolveImages` walked this very array.
      throw toolError.invalidInput("an image entry was not resolved before placement");
    }
    report.push(`- sheet ${JSON.stringify(spec.name)}: ${placeImage(wb, ws, entry.at, image)}`);
  }
}

/**
 * Cells one `styles` entry may touch.
 *
 * Styling is applied cell by cell, so an unbounded range like `A1:XFD1048576`
 * would hang the server. A model that wants a whole-column look can restrict
 * itself to the rows that actually hold data.
 */
const MAX_STYLED_CELLS = 100_000;

/** Apply one style to every cell of a range. */
function applyStyle(ws: SheetHandle, range: string, style: z.infer<typeof styleSchema>): void {
  const window: GridWindow = parseRange(range);
  const cells = (window.bottom - window.top + 1) * (window.right - window.left + 1);
  if (cells > MAX_STYLED_CELLS) {
    throw toolError.tooLarge(
      `style range ${JSON.stringify(range)} covers ${cells} cells, over the ${MAX_STYLED_CELLS} limit`,
      "Style only the rows that hold data, e.g. the header row plus the populated range."
    );
  }
  for (let row = window.top; row <= window.bottom; row += 1) {
    for (let column = window.left; column <= window.right; column += 1) {
      if (style.bold !== undefined || style.italic !== undefined || style.fontColor !== undefined) {
        Cell.setFont(ws, row, column, {
          ...(Cell.getFont(ws, row, column) ?? {}),
          ...(style.bold === undefined ? {} : { bold: style.bold }),
          ...(style.italic === undefined ? {} : { italic: style.italic }),
          ...(style.fontColor === undefined ? {} : { color: { argb: toArgb(style.fontColor) } })
        });
      }
      if (style.fillColor !== undefined) {
        Cell.setFill(ws, row, column, {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: toArgb(style.fillColor) }
        });
      }
      if (style.numFmt !== undefined) {
        Cell.setNumFmt(ws, row, column, style.numFmt);
      }
    }
  }
}

function normalizeAddress(address: string): string {
  const upper = address.trim().toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(upper)) {
    throw toolError.invalidInput(
      `${JSON.stringify(address)} is not a cell address`,
      'Use A1 notation for a single cell, e.g. "B10".'
    );
  }
  return upper;
}

/**
 * Characters Excel forbids in a sheet name.
 *
 * Writing one produces a package Excel refuses to open, which the model would
 * see as a mysterious "corrupt file" much later — so reject it at the source.
 */
const ILLEGAL_SHEET_NAME = /[[\]:*?/\\]/;

function assertLegalSheetName(name: string): void {
  if (ILLEGAL_SHEET_NAME.test(name)) {
    throw toolError.invalidInput(
      `sheet name ${JSON.stringify(name)} contains a character Excel forbids`,
      "Sheet names may not contain any of : \\ / ? * [ ]"
    );
  }
  if (name.startsWith("'") || name.endsWith("'")) {
    throw toolError.invalidInput(
      `sheet name ${JSON.stringify(name)} may not start or end with an apostrophe`
    );
  }
}

function assertUniqueNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw toolError.invalidInput(
        `duplicate sheet name ${JSON.stringify(name)}`,
        "Excel sheet names must be unique, ignoring case."
      );
    }
    seen.add(key);
  }
}
