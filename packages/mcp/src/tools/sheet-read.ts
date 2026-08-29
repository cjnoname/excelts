/**
 * `sheet_read` — read a bounded window of a spreadsheet.
 *
 * The design constraint is context, not capability. A 340-row sheet rendered in
 * full costs more tokens than the answer is worth, so this tool always reads a
 * bounded window, states what it left out, and tells the caller how to continue.
 * Reading everything is not offered.
 */

import { Workbook, Worksheet } from "documonster/excel";
import { z } from "zod";

import { toolError } from "../errors.js";
import { resolveInRoot } from "../sandbox.js";
import { requireSpreadsheetFormat } from "./document.js";
import { assertReadableSize } from "./fs-helpers.js";
import { textResult } from "./result.js";
import {
  describeWindow,
  parseRange,
  renderGrid,
  requireSheet,
  sheetName,
  sheetNames,
  usedWindow,
  type GridWindow
} from "./spreadsheet.js";
import { defineTool } from "./types.js";

/** Rows returned when the caller does not say. Fits a screen and a small budget. */
const DEFAULT_MAX_ROWS = 50;

/** Hard ceiling on cells per call, whatever the caller asks for. */
const MAX_CELLS = 20_000;

export const sheetReadTool = defineTool({
  name: "sheet_read",
  group: "excel",
  title: "Read spreadsheet cells",
  description:
    "Read a bounded window of an .xlsx, .xlsm, or .xlsb sheet as a Markdown table with column letters and row numbers, so cells can be referenced by address afterwards. Call doc_inspect first to learn the sheet names. Reads at most 50 rows unless maxRows says otherwise, and always reports what was omitted.",
  inputSchema: {
    path: z.string().min(1).describe("Workbook path, relative to the server root."),
    sheet: z
      .union([z.string(), z.number().int().positive()])
      .optional()
      .describe("Sheet name, or 1-based index. Defaults to the first sheet."),
    range: z
      .string()
      .optional()
      .describe('A1 range such as "B2:D40". Defaults to the used area, capped by maxRows.'),
    mode: z
      .enum(["values", "formulas", "both"])
      .optional()
      .describe(
        'What each cell shows: "values" (formatted, as displayed in Excel), "formulas", or "both". Defaults to "values".'
      ),
    maxRows: z
      .number()
      .int()
      .positive()
      .max(5000)
      .optional()
      .describe(`Row cap for this call. Defaults to ${DEFAULT_MAX_ROWS}.`),
    startRow: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based row to resume from — use the value the previous call reported.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;
    requireSpreadsheetFormat(args.path, "path");
    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    await assertReadableSize(config, resolved, args.path);

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
    const used = usedWindow(ws);

    if (used === undefined) {
      return textResult(
        config,
        `# ${args.path} — ${sheetName(ws)}\n\nThe sheet is empty.\n\nSheets in this workbook: ${sheetNames(wb).join(", ")}`
      );
    }

    // Intersect with the used area: a caller asking for B2:D400 on a sheet with
    // ten rows of data should get ten rows, not 390 blank ones padding out its
    // context.
    const requested = args.range === undefined ? used : intersect(parseRange(args.range), used);
    if (requested === undefined) {
      return textResult(
        config,
        `# ${args.path} — sheet ${JSON.stringify(sheetName(ws))}\n\nRange ${JSON.stringify(args.range)} lies entirely outside the used area (${describeWindow(used)}), so there is nothing to read.`
      );
    }
    const maxRows = args.maxRows ?? DEFAULT_MAX_ROWS;
    const startRow = Math.max(args.startRow ?? requested.top, requested.top);

    if (startRow > requested.bottom) {
      throw toolError.invalidInput(
        `startRow ${startRow} is past the end of the range (${describeWindow(requested)})`,
        "There is nothing left to read; report the data you already have."
      );
    }

    const window = clamp({ ...requested, top: startRow }, maxRows, requested);

    const table = renderGrid(ws, window, args.mode ?? "values");
    const lines = [
      `# ${args.path} — sheet ${JSON.stringify(sheetName(ws))}`,
      "",
      `- used area: **${describeWindow(used)}** (${used.bottom - used.top + 1} rows × ${used.right - used.left + 1} cols)`,
      `- showing: **${describeWindow(window)}**`,
      `- mode: ${args.mode ?? "values"}`
    ];

    const merges = Worksheet.mergedRegions(ws);
    if (merges.length > 0) {
      // Merged cells report their value only in the top-left cell, so a model
      // reading a blank neighbour would otherwise conclude the data is missing.
      lines.push(
        `- merged regions: ${merges
          .slice(0, 10)
          .map(merge => `${describeWindow(merge)}`)
          .join(", ")}${merges.length > 10 ? ` (+${merges.length - 10} more)` : ""}`
      );
    }

    const remaining = requested.bottom - window.bottom;
    if (remaining > 0) {
      lines.push(
        `- **${remaining} row(s) not shown.** Continue with \`startRow: ${window.bottom + 1}\`.`
      );
    }

    const otherSheets = sheetNames(wb).filter(name => name !== sheetName(ws));
    if (otherSheets.length > 0) {
      lines.push(`- other sheets: ${otherSheets.join(", ")}`);
    }

    lines.push("", table);
    return textResult(config, lines.join("\n"));
  }
});

/** Overlap of two windows, or `undefined` when they do not intersect. */
function intersect(a: GridWindow, b: GridWindow): GridWindow | undefined {
  const window: GridWindow = {
    top: Math.max(a.top, b.top),
    left: Math.max(a.left, b.left),
    bottom: Math.min(a.bottom, b.bottom),
    right: Math.min(a.right, b.right)
  };
  return window.top > window.bottom || window.left > window.right ? undefined : window;
}

/**
 * Apply the row cap and the absolute cell ceiling.
 *
 * The cell ceiling matters independently of the row cap: 50 rows of a 500-column
 * sheet is 25 000 cells, which blows the output budget on its own.
 */
function clamp(window: GridWindow, maxRows: number, bounds: GridWindow): GridWindow {
  const bottom = Math.min(window.bottom, bounds.bottom, window.top + maxRows - 1);
  const width = Math.max(1, window.right - window.left + 1);
  const affordableRows = Math.max(1, Math.floor(MAX_CELLS / width));
  return {
    ...window,
    bottom: Math.min(bottom, window.top + affordableRows - 1)
  };
}
