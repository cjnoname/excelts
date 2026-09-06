import { internalLinkLocation } from "@excel/core/hyperlink";
import type { WorkbookModel } from "@excel/core/workbook.browser";
import type {
  Alignment,
  Borders,
  DataValidationRule,
  Fill,
  Font,
  HeaderFooter,
  Margins,
  Protection,
  RichText,
  TableColumnProperties,
  TableStyleProperties
} from "@excel/types";
import { decodeCell, encodeCol } from "@excel/utils/address";
import { tryDecodeRange, type BiffRange } from "@excel/xlsb/binary";
import type { SheetComment } from "@excel/xlsb/comments";
import type { SheetValidation } from "@excel/xlsb/data-validation";
/**
 * Turning a `WorkbookModel` into the shapes the part writers take.
 *
 * **This is the only place that knows the model's field names**, and keeping it that way is the point:
 * the part writers below it take rows, columns and ranges, so they can be tested against hand-built
 * inputs rather than against a whole workbook. The model is also the looser of the two shapes — a
 * column's width may be absent, a merge reference may be unbounded — so the narrowing belongs here
 * rather than being repeated at each use.
 *
 * A conversion that cannot be made is *reported*, not dropped. `mergesFromModel` returns the references
 * it could not express alongside the ones it could, because a merge that silently disappears is a
 * workbook that comes back subtly rearranged with nothing said.
 */
import type { PrintOptionsLike, WorksheetViewLike } from "@excel/xlsb/defaults";
import type { SheetBreak } from "@excel/xlsb/page-breaks";
import type { ReadPageSetup, SheetFormatInfo } from "@excel/xlsb/page-setup";
import type { SheetPane } from "@excel/xlsb/pane";
import type { SheetProperties } from "@excel/xlsb/sheet-properties";
import type { SheetTable } from "@excel/xlsb/tables";
import {
  formulaCachedResultLoss,
  hyperlinkLabelLoss,
  numberFormatOf,
  unsupportedKind,
  writableValue
} from "@excel/xlsb/write/cells";
import type { CellLike, SheetCell, SheetColumn, SheetRow } from "@excel/xlsb/write/types";
import {
  normalisePrintAreaRange,
  normalisePrintTitlesAxis
} from "@excel/xlsx/xform/book/workbook-xform";

/**
 * Rows from a workbook model's worksheet, in the shape the part writer wants.
 *
 * `CellModel` is flat: a formula cell carries `formula` and `result` as sibling fields
 * and leaves `value` undefined, and rich text, errors and hyperlinks are the same shape
 * of thing. Reading `value` alone therefore reports a formula cell as blank, which is the
 * one failure mode this writer's "unsupported" list exists to prevent — so the classifier
 * looks at the fields that are actually set, not at `value`.
 */
export function sheetRowsFromModel(
  worksheet: WorkbookModel["worksheets"][number],
  date1904 = false
): SheetRow[] {
  const sharedRanges = sharedFormulaRanges(worksheet);
  const rows: SheetRow[] = [];
  for (const row of worksheet.rows ?? []) {
    const cells: SheetCell[] = [];
    for (const cell of row.cells ?? []) {
      const column = columnIndex(cell.address);
      if (column === undefined) {
        continue;
      }
      // The shared-formula fields are resolved *before* the cell is classified, because the classifier's
      // question — "is there a range for this share type?" — is answered by that resolution and not by the
      // model. Asking first reported every hand-written shared master as unwritable, since the XLSX writer's
      // `prepare` had given it a `shareType` while leaving the range somewhere this writer does not read.
      const shared = sharedFormulaFacets(cell, sharedRanges);
      const unsupported = unsupportedKind({ ...cell, ...shared });
      cells.push({
        row: row.number - 1,
        column,
        value: writableValue(cell),
        numberFormat: numberFormatOf(cell),
        font: cell.style?.font,
        fill: cell.style?.fill,
        border: cell.style?.border,
        alignment: cell.style?.alignment,
        protection: cell.style?.protection,
        // Withheld when the cell was classified unsupported, and that is the whole mechanism by
        // which an unsupported cell becomes a blank. Passing the formula through anyway meant a
        // cell reported as an array formula was *written as an ordinary one*: it computed a single
        // value where the author had asked for a spilled range, and `unsupported: "ignore"` —
        // documented as writing such cells as blanks — silently produced a different formula
        // instead. Reporting a loss and then not taking it is worse than either alone.
        ...(unsupported === undefined ? { formula: cell.formula } : {}),
        // A shared or array formula, in both its roles. The master carries `shareType` and the `ref` its
        // range covers; a follower carries only `sharedFormula`, the master's address. Both were dropped
        // here, so the writer never saw them and reported the cell as unsupported instead.
        ...shared,
        // The destination and the display text. Carried together because the text *is* the cell's
        // content for such a cell — `value` is empty — while the destination becomes a separate
        // `BrtHLink` and an external relationship.
        ...(cell.hyperlink === undefined
          ? {}
          : { hyperlink: cell.hyperlink, ...(cell.text === undefined ? {} : { text: cell.text }) }),
        date1904,
        // One field for both kinds of loss, because both are things the caller needs told. Which of
        // the two it is decides whether the cell above kept its formula, not what is reported.
        unsupported: unsupported ?? formulaCachedResultLoss(cell) ?? hyperlinkLabelLoss(cell)
      });
    }
    rows.push({
      row: row.number - 1,
      cells,
      ...(typeof row.height === "number" ? { heightPoints: row.height } : {}),
      // The three flags that share the byte at offset 11 with `fUnsynced`. They were on the loss list not
      // because the record lacked room for them but because that byte was being written from the wrong
      // offset — see `write/rows.ts`.
      ...(row.hidden ? { hidden: true } : {}),
      ...(typeof row.outlineLevel === "number" && row.outlineLevel > 0
        ? { outlineLevel: row.outlineLevel }
        : {}),
      ...(row.collapsed ? { collapsed: true } : {}),
      ...styleOf(row)
    });
  }
  // Every cell an array formula covers must carry its own forwarding record — see `expandArrayRanges`.
  expandArrayRanges(rows, date1904);
  // The styled blanks a collapsed read folded into rectangles, put back as the records they came from.
  expandStyledBlanks(rows, worksheet, date1904);
  return rows;
}

/**
 * Turn the rectangles from a collapsed read back into one blank cell each.
 *
 * **This is what makes `blankCells: "collapse"` lossless.** The reader accumulated every `BrtCellBlank` into as few
 * rectangles as describe it exactly; this walks them back out, so the records written are the records read and a
 * round trip is unchanged. Without it the collapse would be a discard with a nicer name — which is the trade the
 * option exists to avoid.
 *
 * Expanded at write time rather than at read time on purpose: the compact form is what a caller holds, so a workbook
 * with a formatted column costs a handful of objects while it is open and only pays for the cells at the moment they
 * are serialised.
 *
 * **They are not handed to the ZIP row by row, and this used to claim they were.** The expansion materialises the whole
 * `SheetRow[]`, so the peak during a write is proportional to the *expanded* cell count rather than to the rectangles.
 * That is the binding constraint for a collapsed workbook, measured on 400,000 styled blanks in one column: reading and
 * writing succeeds at a 900 MB heap and fails at 600, while the same file read with `blankCells: "keep"` fails at 900.
 * So the option delivers a real advantage through the write path — it is not undone here — but the advantage is
 * smaller than "a handful of objects" suggests, and the write is where it runs out.
 *
 * Lowering it means `sheetRowsFromModel` returning an `Iterable<SheetRow>` and the worksheet writer consuming it
 * lazily, which changes a contract every caller shares. Deliberately not done here; the numbers above are what a
 * future attempt should be measured against.
 *
 * The `cells.some` scan below looks like the expensive part and is not: doubling both the existing columns and the
 * rectangle's width quadruples the cells and roughly doubles the time (38 ms → 65 → 132 for 2,000 rows at 20/40/80
 * columns), because the scan is bounded by a row's own width. Replacing it with a `Set` would be tidier and would not
 * measurably help.
 *
 * A cell the model already has wins. The rectangles cover cells that held nothing when they were read, but a caller
 * may have written into one since, and a blank must not overwrite a value.
 */
function expandStyledBlanks(
  rows: SheetRow[],
  worksheet: WorkbookModel["worksheets"][number],
  date1904: boolean
): void {
  const ranges = (worksheet as { styledBlankRanges?: readonly StyledBlankRectangle[] })
    .styledBlankRanges;
  if (ranges === undefined || ranges.length === 0) {
    return;
  }
  const cellsByRow = new Map(rows.map(row => [row.row, [...row.cells]]));
  const indexByRow = new Map(rows.map((row, at) => [row.row, at]));
  for (const range of ranges) {
    for (let row = range.firstRow; row <= range.lastRow; row++) {
      let cells = cellsByRow.get(row);
      if (cells === undefined) {
        cells = [];
        cellsByRow.set(row, cells);
        indexByRow.set(row, rows.length);
        rows.push({ row, cells });
      }
      for (let column = range.firstColumn; column <= range.lastColumn; column++) {
        if (cells.some(cell => cell.column === column)) {
          continue;
        }
        cells.push({
          row,
          column,
          value: null,
          ...(range.style?.numFmt === undefined ? {} : { numberFormat: range.style.numFmt }),
          ...(range.style?.font === undefined ? {} : { font: range.style.font }),
          ...(range.style?.fill === undefined ? {} : { fill: range.style.fill }),
          ...(range.style?.border === undefined ? {} : { border: range.style.border }),
          ...(range.style?.alignment === undefined ? {} : { alignment: range.style.alignment }),
          ...(range.style?.protection === undefined ? {} : { protection: range.style.protection }),
          date1904
        } as SheetCell);
      }
    }
  }
  for (const [row, cells] of cellsByRow) {
    const at = indexByRow.get(row);
    if (at !== undefined) {
      rows[at] = {
        ...rows[at],
        cells: [...cells].sort((left, right) => left.column - right.column)
      };
    }
  }
}

/** A rectangle of blank cells sharing one resolved style, as a collapsed read records it. */
interface StyledBlankRectangle {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly style?: {
    readonly numFmt?: string;
    readonly font?: unknown;
    readonly fill?: unknown;
    readonly border?: unknown;
    readonly alignment?: unknown;
    readonly protection?: unknown;
  };
}

/**
 * Give every cell of a multi-cell array formula its own `PtgExp` record.
 *
 * **An array formula's range is a claim about cells, and every one of them has to exist.** A `BrtArrFmla`
 * declares `E1:E4`; Excel then expects a formula record in E1, E2, E3 *and* E4, each forwarding to the master.
 * This writer emitted the master and left the rest as whatever the model held — literal values where the caller
 * had supplied them, nothing at all where it had not — and Excel **crashed on open** rather than repairing.
 *
 * Isolated rather than deduced: four workbooks differing in one construct each established that a 1×1 array
 * opens and a 4×1 and a 2×2 do not, and Excel's own re-save of `formulas.xlsb` then showed exactly what the
 * missing records look like — `BrtFmlaNum` with `cce=5`, rgce `01 <masterRow>`, and the master's column in
 * `rgbExtra`, which is precisely a follower. The cached value is the master's, in every one of the seven cells
 * Excel wrote.
 *
 * Note what this does *not* do: it never rewrites the master, and it does not shrink a range to fit the cells
 * that happen to exist. The caller said `J1:K2`, and a writer that quietly narrowed that to `J1` would produce
 * a file that opens and is wrong, which is worse than one that crashes.
 */
function expandArrayRanges(rows: SheetRow[], date1904: boolean): void {
  const masters = rows.flatMap(row =>
    row.cells.filter(
      (cell): cell is SheetCell & { shareType: "array"; ref: string } =>
        (cell as { shareType?: string }).shareType === "array" &&
        typeof (cell as { ref?: string }).ref === "string"
    )
  );
  if (masters.length === 0) {
    return;
  }
  // `SheetRow.cells` is `readonly`, which is right for its consumers — so the mutation happens on a local
  // copy and is written back, rather than by widening the type everyone else relies on.
  const cellsByRow = new Map(rows.map(row => [row.row, [...row.cells]]));
  const indexByRow = new Map(rows.map((row, at) => [row.row, at]));
  for (const master of masters) {
    const bounds = parseRefBounds(master.ref);
    if (bounds === undefined) {
      continue;
    }
    const address = `${encodeCol(master.column)}${master.row + 1}`;
    for (let row = bounds.top; row <= bounds.bottom; row++) {
      let cells = cellsByRow.get(row);
      if (cells === undefined) {
        cells = [];
        cellsByRow.set(row, cells);
        indexByRow.set(row, rows.length);
        rows.push({ row, cells });
      }
      for (let column = bounds.left; column <= bounds.right; column++) {
        if (row === master.row && column === master.column) {
          continue;
        }
        const existing = cells.find(cell => cell.column === column);
        if (existing === undefined) {
          cells.push({
            row,
            column,
            value: master.value,
            sharedFormula: address,
            date1904
          } as SheetCell);
          continue;
        }
        // An existing cell keeps its own cached value — the caller may have supplied a real one per cell — and
        // becomes a follower. A literal value inside a declared array range is the contradiction Excel choked
        // on, so this replaces the classification rather than adding to it.
        Object.assign(existing, {
          sharedFormula: address,
          formula: undefined,
          shareType: undefined,
          ref: undefined,
          ...(existing.value === undefined || existing.value === null
            ? { value: master.value }
            : {})
        });
      }
    }
  }
  // Written back in one pass, and the cells sorted, because a synthesised column may land left of one the model
  // already had — `encodeRowRecords` computes the row's span from the order it is handed.
  for (const [row, cells] of cellsByRow) {
    const at = indexByRow.get(row);
    if (at !== undefined) {
      rows[at] = {
        ...rows[at],
        cells: [...cells].sort((left, right) => left.column - right.column)
      };
    }
  }
}

/** `"E1:E4"` as zero-based bounds, or `undefined` when it is not a range this writer can read. */
function parseRefBounds(
  ref: string
): { top: number; left: number; bottom: number; right: number } | undefined {
  const [start, end = start] = ref.split(":");
  const first = tryDecodeCell(start);
  const last = tryDecodeCell(end);
  if (first === undefined || last === undefined) {
    return undefined;
  }
  return {
    top: Math.min(first.row, last.row),
    left: Math.min(first.column, last.column),
    bottom: Math.max(first.row, last.row),
    right: Math.max(first.column, last.column)
  };
}

/**
 * Column widths from a worksheet model.
 *
 * Only columns with an explicit width are emitted. A column that never had one set does not
 * need a record, and writing one would pin the default as though the author had chosen it.
 */
/** Excel's default column width in characters, for a column that carries flags but no width of its own. */
const DEFAULT_COLUMN_WIDTH_CHARACTERS = 8.43;

export function columnsFromModel(worksheet: WorkbookModel["worksheets"][number]): SheetColumn[] {
  const columns: SheetColumn[] = [];
  (worksheet.cols ?? []).forEach(column => {
    const width = (column as { width?: number }).width;
    const min = (column as { min?: number }).min;
    const max = (column as { max?: number }).max;
    if (typeof min !== "number") {
      return;
    }
    const settings = column as {
      hidden?: boolean;
      bestFit?: boolean;
      outlineLevel?: number;
      collapsed?: boolean;
    };
    const hasFlags =
      settings.hidden === true ||
      settings.bestFit === true ||
      settings.collapsed === true ||
      (settings.outlineLevel ?? 0) > 0;
    // A column with no width used to be skipped outright, which meant a *hidden* column with no explicit
    // width produced no `BrtColInfo` at all — the flags had nowhere to live. Excel's own default width stands
    // in, and `fUserSet` is left clear for it below so the width is not claimed as deliberate.
    if (typeof width !== "number" && !hasFlags) {
      return;
    }
    // `isCustomWidth` rather than "is `width` a number": `setModel` fills the default width into every column
    // it normalises, so by the time this runs a column that was never given one is indistinguishable by
    // presence. The model records the distinction itself, and this is the field that carries it.
    const custom = (column as { isCustomWidth?: boolean }).isCustomWidth;
    columns.push({
      firstColumn: min - 1,
      lastColumn: (typeof max === "number" ? max : min) - 1,
      widthCharacters: typeof width === "number" ? width : DEFAULT_COLUMN_WIDTH_CHARACTERS,
      widthWasSet: custom ?? typeof width === "number",
      ...(settings.hidden === true ? { hidden: true } : {}),
      ...(settings.bestFit === true ? { bestFit: true } : {}),
      ...((settings.outlineLevel ?? 0) > 0 ? { outlineLevel: settings.outlineLevel } : {}),
      ...(settings.collapsed === true ? { collapsed: true } : {}),
      ...styleOf(column as { style?: CellLike["style"] })
    });
  });
  return columns;
}

/**
 * The view settings a sheet's first view carries.
 *
 * The model holds a list, one per workbook view, and `BrtBeginWsViews` is a collection — so every one of
 * them is written, each naming its workbook view through `iWbkView`. The *pane* is still per sheet rather
 * than per view, so it goes on the first only.
 */
export function viewSettingsFromModel(
  worksheet: WorkbookModel["worksheets"][number],
  isActiveSheet = false
): readonly WorksheetViewLike[] {
  const views =
    (worksheet as unknown as { views?: readonly Record<string, unknown>[] }).views ?? [];
  // `fSelected` on the workbook's active sheet. The model does not carry `tabSelected` unless a file supplied
  // it, and Excel sets the bit on the active sheet of every workbook it writes — a workbook without it opens
  // with no tab highlighted. So the workbook's active index stands in, and a view that states the flag wins.
  return views.length === 0
    ? isActiveSheet
      ? [{ tabSelected: true }]
      : []
    : views.map((view, index) => ({
        ...viewOf(view),
        ...(typeof view.tabSelected === "boolean"
          ? { tabSelected: view.tabSelected }
          : isActiveSheet && index === 0
            ? { tabSelected: true }
            : {})
      }));
}

/** One view's settings. */
function viewOf(view: Record<string, unknown>): WorksheetViewLike {
  {
    const style = view.style;
    return {
      ...(typeof view.showGridLines === "boolean" ? { showGridLines: view.showGridLines } : {}),
      ...(typeof view.showRowColHeaders === "boolean"
        ? { showRowColHeaders: view.showRowColHeaders }
        : {}),
      ...(typeof view.showRuler === "boolean" ? { showRuler: view.showRuler } : {}),
      ...(typeof view.rightToLeft === "boolean" ? { rightToLeft: view.rightToLeft } : {}),
      ...(typeof view.zoomScale === "number" ? { zoomScale: view.zoomScale } : {}),
      ...(typeof view.zoomScaleNormal === "number"
        ? { zoomScaleNormal: view.zoomScaleNormal }
        : {}),
      ...(style === "pageBreakPreview" || style === "pageLayout" ? { style } : {})
    };
  }
}

/**
 * Print areas and print titles, expressed as the `_xlnm.*` defined names Excel actually stores them as.
 *
 * **Neither is a record.** A print area is a sheet-local defined name called `_xlnm.Print_Area`, and
 * print titles are `_xlnm.Print_Titles` — which is why they were on the loss list behind a *different*
 * gap: the `BrtName` writer forced every name to workbook scope, so there was nowhere to put them. With
 * sheet-local scope working they are two more names rather than two more features.
 *
 * The reference normalisation is imported from the XLSX writer rather than repeated. It handles the
 * cases that make these easy to get wrong — a bare `A1:B2` needs the sheet name and absolute markers, a
 * print title is a whole-row or whole-column reference and nothing else is valid — and a second
 * implementation here would be a second place for that to drift.
 */
export function printNamesFromModel(
  worksheets: WorkbookModel["worksheets"],
  /**
   * A worksheet's index → its position on the tab bar.
   *
   * **`localSheetId` scopes a name to a sheet by its bundle ordinal, not by its position among the worksheets**, and
   * those differ as soon as a chartsheet sits before a worksheet. Measured on worksheet `A`, chartsheet `C`, worksheet
   * `B`: `B`'s print area was written with `localSheetId` 1, which is `C` — so the print area belonged to a chartsheet
   * that has no cells. Defaults to identity, which is exactly right for a workbook with no chartsheets.
   */
  tabPositionOf: (index: number) => number = index => index
): readonly { name: string; ranges: string[]; localSheetId: number }[] {
  const names: { name: string; ranges: string[]; localSheetId: number }[] = [];
  worksheets.forEach((worksheet, index) => {
    const localSheetId = tabPositionOf(index);
    const setup = (
      worksheet as unknown as {
        pageSetup?: {
          printArea?: string;
          printTitlesRow?: string;
          printTitlesColumn?: string;
        };
      }
    ).pageSetup;
    if (setup === undefined) {
      return;
    }
    const sheetName = (worksheet as unknown as { name?: string }).name ?? "";
    if (setup.printArea !== undefined && setup.printArea !== "") {
      // A print area may hold several blocks, separated by commas — Excel prints each on its own page.
      const ranges = setup.printArea
        .split(",")
        .map(part => normalisePrintAreaRange(part.trim(), sheetName))
        .filter((range): range is string => range !== undefined);
      if (ranges.length > 0) {
        names.push({ name: "_xlnm.Print_Area", ranges, localSheetId });
      }
    }
    // Column before row, which is the order the XLSX writer uses and the order Excel writes.
    const titles = [setup.printTitlesColumn, setup.printTitlesRow]
      .filter((axis): axis is string => axis !== undefined && axis !== "")
      .map(axis => normalisePrintTitlesAxis(axis, sheetName))
      .filter((range): range is string => range !== undefined);
    if (titles.length > 0) {
      names.push({ name: "_xlnm.Print_Titles", ranges: titles, localSheetId });
    }
  });
  return names;
}

/**
 * Tables from a worksheet model.
 *
 * The `id` is left at 0 here and assigned by the package writer, because `BrtBeginList.idList` must be
 * unique across the *workbook* and a per-sheet adapter cannot know what the other sheets used.
 */
export function tablesFromModel(
  worksheet: WorkbookModel["worksheets"][number]
): readonly Omit<SheetTable, "id">[] {
  const tables =
    (worksheet as unknown as { tables?: readonly Record<string, unknown>[] }).tables ?? [];
  const found: Omit<SheetTable, "id">[] = [];
  for (const table of tables) {
    // **`tableRef` wins, and the order matters.** `ref` is the anchor the *caller* passed to `Table.add` and
    // is left exactly as given — `"A1"` stays `"A1"` — while `tableRef` is the range the table actually
    // occupies once its header, rows and totals row are counted. Reading `ref` first therefore wrote a
    // one-cell table whenever a caller anchored one instead of spelling out the whole range, which is the
    // documented way to add a table: `BrtBeginList` said `A1:A1` where the same workbook's XLSX said
    // `A1:B5`. The XLSX writer has always used `tableRef` (`table-xform.ts` renders `ref: model.tableRef`),
    // so the two formats disagreed about the size of every anchored table.
    const ref = table.tableRef ?? table.ref;
    const name = table.name;
    const columns = table.columns;
    if (typeof ref !== "string" || typeof name !== "string" || !Array.isArray(columns)) {
      continue;
    }
    found.push({
      ref,
      name,
      ...(typeof table.displayName === "string" ? { displayName: table.displayName } : {}),
      ...(typeof table.headerRow === "boolean" ? { headerRow: table.headerRow } : {}),
      ...(typeof table.totalsRow === "boolean" ? { totalsRow: table.totalsRow } : {}),
      // The style and the filter range, both of which the XLSX writer already used and this dropped — so a
      // table's banding and its filter buttons survived one format and not the other.
      ...(isRecord(table.style) ? { style: table.style as TableStyleProperties } : {}),
      ...(typeof table.autoFilterRef === "string" ? { autoFilterRef: table.autoFilterRef } : {}),
      columns: columns as TableColumnProperties[]
    });
  }
  return found;
}

/**
 * Cell comments from a worksheet model.
 *
 * The model nests them at `rows[].cells[].comment.note`, one per cell, while the part is a flat list with
 * a deduplicated author table — so flattening happens here and the deduplication in `encodeCommentsPart`,
 * which is where the author *indices* are assigned.
 *
 * A note carries no author in this model. Excel's own placeholder is used rather than inventing one,
 * which is also what the XLSX writer does — so a workbook written to either container names its comment
 * authors identically.
 */
export function commentsFromModel(
  worksheet: WorkbookModel["worksheets"][number]
): readonly SheetComment[] {
  // **A streamed sheet has no rows left, so it carries its notes directly.**
  //
  // This reads notes off `rows[].cells[].comment`, and a streaming worksheet releases `_rows` at `commit()` — so a note
  // written through the streaming XLSB writer reached here as nothing. It was absent from the package entirely: no
  // `comments1.bin`, no VML, no indicator. Streaming *XLSX* was unaffected because its row writer feeds an incremental
  // comments stream, and buffered XLSB was unaffected because its rows are still there.
  //
  // Preferred over the row walk rather than merged with it: a streamed sheet's rows are empty, and a buffered sheet has
  // no retained list, so exactly one of the two is ever non-empty.
  const retained = (worksheet as { retainedComments?: readonly SheetComment[] }).retainedComments;
  if (retained !== undefined && retained.length > 0) {
    return retained;
  }
  const comments: SheetComment[] = [];
  for (const row of (worksheet as { rows?: readonly WorksheetRowLike[] }).rows ?? []) {
    for (const cell of row.cells ?? []) {
      const note = cell.comment?.note;
      if (note === undefined || cell.address === undefined) {
        continue;
      }
      const texts = note.texts ?? [];
      if (texts.length === 0) {
        // A note with no text is a box with nothing in it. Excel does not create one, and writing it
        // would put an empty comment marker on a cell the author never annotated.
        continue;
      }
      comments.push({
        ref: cell.address,
        author: cell.comment?.author ?? "Author",
        texts,
        // Carried whole, not reduced to its text. The margins, protection and `editAs` block belongs to
        // the note's *box*, which is VML rather than a record — the VML renderer requires all three and
        // throws without them, so reconstructing defaults here would be duplicating what `cellSetNote`
        // already put on the model.
        note: note as unknown as Record<string, unknown>
      });
    }
  }
  return comments;
}

/** The parts of a row model this adapter reads. */
interface WorksheetRowLike {
  readonly cells?: readonly {
    readonly address?: string;
    readonly comment?: {
      readonly author?: string;
      readonly note?: { readonly texts?: RichText[] };
    };
  }[];
}

/**
 * Data validations from a worksheet model, grouped so that one record covers every range sharing a rule.
 *
 * The model keys validations by address, so a rule applied to fifty cells is fifty identical entries.
 * `BrtDVal` holds a *set* of ranges precisely so that it does not have to be repeated, and Excel writes
 * one record per distinct rule — so grouping here is not an optimisation but the shape the record was
 * designed for. Ungrouped, a list validation dragged across a column would emit fifty records carrying
 * the same string four times each.
 *
 * Grouping is by the rule's serialised form. That is exact for this purpose: two rules that stringify
 * identically produce identical bytes, which is the only property being relied on. Key order could in
 * principle differ between two equal rules built by different paths, which would merely split a group
 * that could have been merged — a larger file, not a wrong one.
 */
export function validationsFromModel(
  worksheet: WorkbookModel["worksheets"][number]
): readonly SheetValidation[] {
  const validations = (worksheet as { dataValidations?: Record<string, DataValidationRule> })
    .dataValidations;
  if (validations === undefined) {
    return [];
  }
  const groups = new Map<string, { rule: DataValidationRule; ranges: string[] }>();
  for (const [key_, rule] of Object.entries(validations)) {
    if (rule === null || typeof rule !== "object") {
      continue;
    }
    // A range is keyed `range:A1:B2` and a single cell by its bare address — the convention
    // `core/data-validations.ts` uses so that a range serialises as one element rather than one per
    // cell. Stripping the prefix here rather than treating it as part of the reference is the whole
    // difference between one record covering `A1:B2` and one covering a range literally named
    // `range:A1:B2`, which decodes to nothing and drops the validation.
    const address = key_.startsWith("range:") ? key_.slice("range:".length) : key_;
    const key = JSON.stringify(rule);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { rule, ranges: [address] });
    } else {
      group.ranges.push(address);
    }
  }
  return [...groups.values()].map(group => ({ ranges: group.ranges, rule: group.rule }));
}

/**
 * The pane a worksheet's view describes, when it has one.
 *
 * **The axis names cross between the two formats**, which is why the conversion is here rather than at
 * the record: the model uses XLSX's vocabulary, where `xSplit` counts columns, and `BrtPane`'s first
 * `Xnum` counts rows. `xlsb/pane.ts` names its fields `rows` and `columns` for that reason — a field
 * called `xSplit` on both sides of the boundary would make the crossover invisible.
 */
export function paneFromModel(
  worksheet: WorkbookModel["worksheets"][number]
): SheetPane | undefined {
  const view = (worksheet.views ?? []).find(
    entry => entry.state === "frozen" || entry.state === "split"
  ) as
    | {
        state?: string;
        xSplit?: number;
        ySplit?: number;
        topLeftCell?: string;
        activePane?: string;
      }
    | undefined;
  if (view === undefined) {
    return undefined;
  }
  const columns = view.xSplit ?? 0;
  const rows = view.ySplit ?? 0;
  if (columns === 0 && rows === 0) {
    // A pane record that splits nothing is a pane record that says nothing.
    return undefined;
  }
  // The first cell of the bottom-right pane. Excel derives it from the split when the sheet does not
  // say, which is the same thing this does — and a `topLeftCell` the model *does* carry wins.
  const corner = view.topLeftCell === undefined ? undefined : tryDecodeCell(view.topLeftCell);
  return {
    frozen: view.state === "frozen",
    columns,
    rows,
    topRow: corner?.row ?? rows,
    leftColumn: corner?.column ?? columns,
    activePane: isPaneName(view.activePane)
      ? view.activePane
      : view.state === "frozen"
        ? defaultActivePane(rows, columns)
        : // A split pane with no stated active pane is top-left, not derived. That is what this library's XLSX
          // writer says — it emits `activePane` for a frozen pane and omits it for a split one, and an omitted
          // `activePane` is `topLeft` — and what Excel writes when it converts that XLSX. Deriving it here gave
          // `bottomRight`, naming a pane Excel does not consider active.
          "topLeft"
  };
}

/**
 * Which pane is active when the model does not say — derived from the split, because **the split decides
 * which panes exist at all**.
 *
 * Freezing rows only divides the sheet into a top and a bottom; there is no right-hand pane to be active in.
 * This defaulted to `bottomRight` unconditionally, so a sheet with frozen rows named a pane that does not
 * exist. Excel repairs such a view — and it repairs the corrected one too, so this is a defect that was
 * found and fixed rather than the cause of that repair. The record was well formed and every length right;
 * the value was simply not a pane of that sheet.
 *
 * The mapping is Excel's own, verified against an XLSB it wrote: `ySplit` alone gives `bottomLeft`, `xSplit`
 * alone gives `topRight`, and both give `bottomRight`. It applies to a **frozen** pane only; see the call site
 * for why a split one is top-left.
 */
function defaultActivePane(rows: number, columns: number): SheetPane["activePane"] {
  if (rows > 0 && columns > 0) {
    return "bottomRight";
  }
  return rows > 0 ? "bottomLeft" : "topRight";
}

function isPaneName(value: unknown): value is SheetPane["activePane"] {
  return (
    value === "topLeft" || value === "topRight" || value === "bottomLeft" || value === "bottomRight"
  );
}

/**
 * `"B2"` to zero-based coordinates, or `undefined` when it is not an address.
 *
 * **The one address decoder in this file, and there were two returning the same shape.** The other scanned its own
 * regex and checked no bounds, so `AAAAA1` yielded column 475,254 — the sheet's last is 16,383 — while this one raises
 * `ColumnOutOfBoundsError` through the shared parser and reports `undefined`. They also disagreed about a
 * sheet-qualified reference. Two functions with one signature, one of them silently wrong, in a file whose other
 * duplicate pair (`columnLetter` against the `encodeCol` it imported) differed the same way.
 *
 * `columnIndex` below is deliberately *not* folded in: it answers a different question — the column of a reference that
 * may have no row at all, like `A` — and says so.
 */
function tryDecodeCell(address: string): { row: number; column: number } | undefined {
  try {
    const decoded = decodeCell(address);
    return Number.isFinite(decoded.r) && Number.isFinite(decoded.c)
      ? { row: decoded.r, column: decoded.c }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Manual page breaks from a worksheet model.
 *
 * `pageSetup` also carries a `rowBreaks`, from an older shape of the model. Both are read, because a
 * workbook built through either path is a workbook someone expects to print the way they set it up.
 */
export function breaksFromModel(worksheet: WorkbookModel["worksheets"][number]): {
  readonly rows: readonly SheetBreak[];
  readonly columns: readonly SheetBreak[];
} {
  const sheet = worksheet as {
    rowBreaks?: readonly SheetBreak[];
    colBreaks?: readonly SheetBreak[];
    pageSetup?: { rowBreaks?: readonly SheetBreak[]; colBreaks?: readonly SheetBreak[] };
  };
  return {
    rows: sheet.rowBreaks ?? sheet.pageSetup?.rowBreaks ?? [],
    columns: sheet.colBreaks ?? sheet.pageSetup?.colBreaks ?? []
  };
}

/**
 * Hyperlinks a worksheet's cells declare, as one entry per cell.
 *
 * Excel writes one `BrtHLink` per range; the model holds one destination per cell, so this produces
 * single-cell entries rather than trying to recover the ranges the author drew. That is lossless — a
 * range of identical links and a run of identical single-cell links display the same — and the
 * alternative would be inventing a grouping the model does not record.
 */
export function hyperlinksFromModel(worksheet: WorkbookModel["worksheets"][number]): readonly {
  readonly row: number;
  readonly column: number;
  readonly target: string;
  /**
   * Set for a link *within the workbook*, which has no relationship at all.
   *
   * OOXML writes one as `<hyperlink ref="E4" location="Linked!A1"/>` — no `r:id` — and BIFF12 puts the same string in
   * `BrtHLink`'s location field with an empty relationship id. This writer used to allocate a relationship for every
   * link regardless, so an internal one became an external relationship whose target was `#Linked!A1`: a link that
   * navigated nowhere. Excel's own save of the same workbook is the reference — `location="Linked!A1"`, empty id.
   */
  readonly location?: string;
}[] {
  const links: { row: number; column: number; target: string; location?: string }[] = [];
  for (const row of worksheet.rows ?? []) {
    for (const cell of row.cells ?? []) {
      const target = hyperlinkOf(cell);
      const column = columnIndex(cell.address);
      if (target !== undefined && column !== undefined) {
        // `internalLinkLocation` rather than a `#` test written here: the same question is asked by the XLSX writer and
        // by the streaming rels writer, and asking it a third way is how this path came to allocate a relationship for
        // every link — see `core/hyperlink.ts`.
        const location = internalLinkLocation(target);
        links.push(
          location === undefined
            ? { row: row.number - 1, column, target }
            : { row: row.number - 1, column, target, location }
        );
      }
    }
  }
  return links;
}

/**
 * A cell's hyperlink destination, when it has one.
 *
 * A sibling field, not something nested in `value` — a hyperlink cell leaves `value` empty and carries
 * `text` and `hyperlink` alongside it. Looking in `value` found nothing, which wrote every such cell
 * blank while writing its link correctly beside it.
 */
function hyperlinkOf(cell: CellLike): string | undefined {
  return typeof cell.hyperlink === "string" && cell.hyperlink !== "" ? cell.hyperlink : undefined;
}

/**
 * Merge ranges from a worksheet model, as zero-based bounds.
 *
 * The model carries them as `"A1:B2"` strings, which is the shape the public API takes; BIFF12
 * wants four integers.
 */
/**
 * The grid each of a sheet's pivot tables is anchored at, as zero-based bounds.
 *
 * These regions occupy the sheet without contributing a cell record — the body is Excel's to render — so they have to
 * reach `BrtWsDim` or the sheet is declared empty. All three pivot sheets in the oracle's `05-pivots` went out as
 * `rows 0..0, cols 0..0`; Excel never writes that, stating a real extent in 21 of 21 records across the reference
 * workbooks.
 *
 * The *declared* `location.ref` is used, not the refreshed extent: Excel's is wider (`A3:B4` declared against
 * `rows 2..6` written) and is not derivable from the file. Understating it is the honest failure — the sheet is
 * reported as occupied, over the region the file itself names.
 */
export function pivotAnchorsFromModel(
  worksheet: WorkbookModel["worksheets"][number]
): readonly BiffRange[] {
  const source = worksheet as unknown as {
    pivotTables?: readonly { ref?: string; location?: { ref?: string } }[];
  };
  const regions: BiffRange[] = [];
  for (const pivot of source.pivotTables ?? []) {
    // **`ref` first, `location.ref` second — and only the second exists on a read.**
    //
    // `location` is computed by the XLSX serialiser from the field layout, so a workbook *read* from XLSX carries it
    // and one built through `Pivot.add` does not: it carries the anchor the caller gave, as `ref`. Reading only
    // `location` therefore fixed the read-then-write path and left the programmatic one — the main one — still
    // declaring an empty sheet.
    const anchor = pivot.location?.ref ?? pivot.ref;
    if (anchor === undefined) {
      continue;
    }
    // A range collapses to its own bounds; a single cell to itself, which is what `ref` normalises to.
    const range = tryDecodeRange(anchor);
    if (range) {
      regions.push(range);
      continue;
    }
    const single = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(anchor);
    if (single === null) {
      continue;
    }
    const column = columnIndex(single[1]!);
    if (column !== undefined) {
      const row = Number(single[2]) - 1;
      regions.push({ firstRow: row, lastRow: row, firstColumn: column, lastColumn: column });
    }
  }
  return regions;
}

export function mergesFromModel(worksheet: WorkbookModel["worksheets"][number]): {
  readonly ranges: readonly BiffRange[];
  /** References that could not be expressed, so a caller learns rather than guesses. */
  readonly unsupported: readonly string[];
} {
  const ranges: BiffRange[] = [];
  const unsupported: string[] = [];
  for (const reference of worksheet.mergeCells ?? []) {
    const range = tryDecodeRange(reference);
    // **The bounded-range test is shared; "more than one cell" is this caller's own rule.**
    //
    // `tryDecodeRange` refuses a whole-row (`1:2`) or whole-column (`A:B`) reference, because `BrtMergeCell` carries
    // four bounded indices and cannot express an unbounded one. It *accepts* a single cell as a 1×1 range, which is
    // right for a conditional format or a data validation and wrong here — Excel does not merge one cell — so the
    // extra condition lives here rather than in the shared parser.
    //
    // An inverted reference is no longer refused: `B2:A1` and `A1:B2` name the same rectangle, and the shared parser
    // normalises it. Refusing it dropped a merge the caller had described perfectly well, while the four other range
    // callers in this module wrote the inversion straight into an `RfX` the validator then rejected — one package, two
    // policies.
    if (
      range !== undefined &&
      (range.lastRow > range.firstRow || range.lastColumn > range.firstColumn)
    ) {
      ranges.push(range);
    } else {
      // Dropped, but not silently: a workbook coming back with its merges missing and nothing said was the defect this
      // report exists for.
      unsupported.push(`${reference}: merge range`);
    }
  }
  return { ranges, unsupported };
}

/**
 * The formatting a row or a column declares, in the shape the format table interns.
 *
 * Shared because a row and a column carry the same `style` object and reference it through an
 * `ixfe` in the same position of their respective records.
 */
function styleOf(owner: { readonly style?: CellLike["style"] }): {
  numberFormat?: string;
  font?: Partial<Font>;
  fill?: Fill;
  border?: Partial<Borders>;
  alignment?: Partial<Alignment>;
  protection?: Partial<Protection>;
} {
  const style = owner.style;
  if (style === undefined) {
    return {};
  }
  const numberFormat = numberFormatOf({ address: "A1", style });
  return {
    ...(numberFormat === undefined ? {} : { numberFormat }),
    ...(style.font === undefined ? {} : { font: style.font }),
    ...(style.fill === undefined ? {} : { fill: style.fill }),
    ...(style.border === undefined ? {} : { border: style.border }),
    ...(style.alignment === undefined ? {} : { alignment: style.alignment }),
    ...(style.protection === undefined ? {} : { protection: style.protection })
  };
}

/**
 * Zero-based column index from an A1 address, or `undefined` when it is not one.
 *
 * Delegates to `decodeCell` rather than scanning the letters here, and the difference is not merely
 * tidiness: a hand-rolled scan returned a column for `Sheet1!A1` — 8,826,681, from reading `Sheet` as
 * base-26 digits — and for a bare `XYZ` with no row at all. Sharing the parser means this agrees with
 * every other place in the library that reads an address.
 */
function columnIndex(address: string): number | undefined {
  try {
    const column = decodeCell(address).c;
    return Number.isFinite(column) ? column : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a value is a plain object, for the model fields this adapter copies through unchanged. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The range each shared-formula master covers, derived from its followers.
 *
 * **Derived here rather than read off the master**, because the master usually does not carry it. There are
 * two ways a shared formula reaches this writer:
 *
 * - `Worksheet.fillFormula` sets `shareType` and a `ref` string on the master directly;
 * - a caller writing `Cell.setValue(ws, "F2", { sharedFormula: "F1" })` by hand sets nothing on the master
 *   at all — the master learns its range only when the *XLSX* writer's `prepare` walks the followers and
 *   retroactively assigns `shareType`, `si` and a decoded `range` object to it.
 *
 * Depending on that second path would make this writer's output depend on **whether an XLSX was written
 * first**, since the promotion mutates the shared model. Writing the XLSB alone would leave every follower
 * emitting a `PtgExp` at a master with no `BrtShrFmla` behind it — a file whose formulas point into nothing.
 * So the walk is repeated here, from the followers, and the answer is used only when the master has no `ref`
 * of its own.
 */
function sharedFormulaRanges(
  worksheet: WorkbookModel["worksheets"][number]
): ReadonlyMap<string, { top: number; left: number; bottom: number; right: number }> {
  const ranges = new Map<string, { top: number; left: number; bottom: number; right: number }>();
  for (const row of worksheet.rows ?? []) {
    for (const cell of row.cells ?? []) {
      const master = (cell as { sharedFormula?: string }).sharedFormula;
      if (master === undefined) {
        continue;
      }
      // **`tryDecodeRange`, not `decodeCell`, because the guard below is unreachable otherwise.**
      //
      // `decodeCell` throws on a malformed address; it never returns `undefined`. So a follower whose `sharedFormula` was
      // empty raised `InvalidAddressError` out of `Workbook.toBuffer` rather than being skipped, and the `=== undefined`
      // test read as protection that was not there. The same shape appeared twice more in `write/cells.ts`. A single cell
      // decodes to a 1×1 range, which is what these two addresses are.
      const hereRange = tryDecodeRange(cell.address ?? "");
      const thereRange = tryDecodeRange(master);
      if (hereRange === undefined || thereRange === undefined) {
        continue;
      }
      const here = { r: hereRange.firstRow, c: hereRange.firstColumn };
      const there = { r: thereRange.firstRow, c: thereRange.firstColumn };
      const found = ranges.get(master);
      if (found === undefined) {
        ranges.set(master, { top: there.r, left: there.c, bottom: here.r, right: here.c });
        continue;
      }
      found.top = Math.min(found.top, here.r);
      found.left = Math.min(found.left, here.c);
      found.bottom = Math.max(found.bottom, here.r);
      found.right = Math.max(found.right, here.c);
    }
  }
  return ranges;
}

/** A cell's shared-formula fields, in the one spelling the writer reads. */
function sharedFormulaFacets(
  cell: { readonly address?: string },
  ranges: ReadonlyMap<string, { top: number; left: number; bottom: number; right: number }>
): { shareType?: string; ref?: string; sharedFormula?: string } {
  const source = cell as { shareType?: string; ref?: string; sharedFormula?: string };
  if (source.sharedFormula !== undefined) {
    return { sharedFormula: source.sharedFormula };
  }
  // An explicit `ref` is the caller's own statement and wins.
  if (source.ref !== undefined) {
    return { shareType: source.shareType ?? "shared", ref: source.ref };
  }
  // Otherwise the range derived from the followers, which is the only place it exists for a hand-written
  // shared formula. Checked *before* `shareType`, because the XLSX writer's `prepare` sets `shareType` on
  // such a master while putting the range in a decoded `range` object this writer does not read — so a
  // `shareType` with no `ref` says nothing about the range and must not be forwarded on its own.
  const derived = ranges.get(cell.address ?? "");
  if (derived !== undefined) {
    return {
      // A master reached only through its followers is always a *shared* formula: an array formula's
      // followers carry plain values, not a `sharedFormula` back-reference.
      shareType: "shared",
      ref: `${encodeCol(derived.left)}${derived.top + 1}:${encodeCol(derived.right)}${derived.bottom + 1}`
    };
  }
  // A `shareType` with neither an explicit nor a derived range is dropped rather than forwarded: the writer
  // would report it as unwritable, and it is the *range* that is missing, not the share type.
  return {};
}

/**
 * A worksheet's page setup, header/footer, protection, filters and format info, as part-writer options.
 *
 * Exported for the streaming writer, which reaches the same derivations rather than repeating them. Nothing about
 * it is buffered-specific: it reads a `WorksheetModel` and returns options, and a streamed sheet has a model.
 */
export function sheetOptionsFromModel(worksheet: WorkbookModel["worksheets"][number]): {
  readonly pageSetup?: ReadPageSetup & PrintOptionsLike & { readonly margins?: Partial<Margins> };
  readonly formatInfo?: SheetFormatInfo;
  readonly sheetProperties?: SheetProperties;
  readonly headerFooter?: Partial<HeaderFooter>;
} {
  const setup = worksheet.pageSetup;
  const properties = worksheet.properties;

  const headerFooter = worksheet.headerFooter;
  const pageSetup: ReadPageSetup & {
    -readonly [K in keyof PrintOptionsLike]: boolean | undefined;
  } & {
    margins?: Partial<Margins>;
  } = {};
  if (setup?.paperSize !== undefined) {
    pageSetup.paperSize = setup.paperSize;
  }
  if (setup?.scale !== undefined) {
    pageSetup.scale = setup.scale;
  }
  if (setup?.horizontalDpi !== undefined) {
    pageSetup.horizontalDpi = setup.horizontalDpi;
  }
  if (setup?.verticalDpi !== undefined) {
    pageSetup.verticalDpi = setup.verticalDpi;
  }
  if (setup?.orientation !== undefined) {
    pageSetup.orientation = setup.orientation;
  }
  // `fitToWidth` and `fitToHeight` only mean anything when fit-to-page is on; writing them
  // otherwise would turn scaling on in a file whose author did not ask for it.
  if (setup?.fitToPage) {
    pageSetup.fitToWidth = setup.fitToWidth ?? 1;
    pageSetup.fitToHeight = setup.fitToHeight ?? 1;
  }
  if (setup?.firstPageNumber !== undefined) {
    pageSetup.firstPageNumber = setup.firstPageNumber;
  }
  if (setup?.margins !== undefined) {
    pageSetup.margins = setup.margins;
  }
  // **The four `BrtPrintOptions` flags.** This function rebuilds `pageSetup` field by field, so anything it does
  // not name is dropped — and it named none of these, which is the second half of why they never reached the
  // file. Copied only when stated, so an unset option stays unset rather than becoming an explicit `false`.
  for (const key of PRINT_OPTION_KEYS) {
    const value = (setup as PrintOptionsLike | undefined)?.[key];
    if (value !== undefined) {
      pageSetup[key] = value;
    }
  }

  const sheetProperties: SheetProperties = {
    ...(properties?.tabColor === undefined || Object.keys(properties.tabColor).length === 0
      ? {}
      : { tabColor: properties.tabColor }),
    ...(properties?.codeName === undefined ? {} : { codeName: properties.codeName }),
    // Two flag-word bits that follow from the sheet's own content rather than from `sheetPr` — see `FLAG_BYTES`.
    // `pageSetup.fitToPage` is the model's spelling of `<pageSetUpPr fitToPage="1"/>`, and a sheet with an autofilter
    // is in filter mode by definition.
    // `setup` is the same `pageSetup` the rest of this function reads, already narrowed — a second cast to reach the
    // same field is how the two would come to disagree about it.
    ...(setup?.fitToPage ? { fitToPage: true } : {}),
    ...(worksheet.autoFilter === undefined || worksheet.autoFilter === null
      ? {}
      : { filterMode: true })
  };

  const formatInfo: {
    -readonly [K in keyof SheetFormatInfo]: SheetFormatInfo[K];
  } = {
    ...(properties?.defaultRowHeight === undefined
      ? {}
      : { defaultRowHeight: properties.defaultRowHeight }),
    ...(properties?.defaultColWidth === undefined
      ? {}
      : { defaultColWidth: properties.defaultColWidth }),
    // The outline depth, which lives in this record's last two bytes. A sheet's grouped rows are
    // written by the row records; this is the number Excel needs in order to draw the gutter that
    // collapses them.
    ...((properties as { outlineLevelRow?: number } | undefined)?.outlineLevelRow === undefined
      ? {}
      : { outlineLevelRow: (properties as { outlineLevelRow: number }).outlineLevelRow }),
    ...((properties as { outlineLevelCol?: number } | undefined)?.outlineLevelCol === undefined
      ? {}
      : { outlineLevelCol: (properties as { outlineLevelCol: number }).outlineLevelCol })
  };
  // Derived when the model does not state it, which is the usual case: `<sheetFormatPr>` carries
  // `outlineLevelRow`/`outlineLevelCol` but this library's XLSX writer does not emit them, so a workbook built
  // through the API arrives here with grouped rows and no depth. Excel computes the depth itself when it
  // converts that XLSX — verified against its output, where a sheet with one grouped row and one grouped column
  // gets `01 01` in this record's last two bytes while this writer had `00 00`.
  //
  // Without it the grouping survives on the rows and the gutter that collapses them is not drawn.
  // Derived when the model's value is absent **or zero**. Zero is what `setModel` normalises an unstated depth
  // to, so a sheet with grouped rows arrives here claiming a depth of none — and a claim of none is the one
  // thing the rows themselves can contradict. Only a positive stated value is taken as deliberate.
  if ((formatInfo.outlineLevelRow ?? 0) === 0) {
    const depth = maxOutlineLevel(worksheet.rows);
    if (depth > 0) {
      formatInfo.outlineLevelRow = depth;
    }
  }
  if ((formatInfo.outlineLevelCol ?? 0) === 0) {
    const depth = maxOutlineLevel(worksheet.cols);
    if (depth > 0) {
      formatInfo.outlineLevelCol = depth;
    }
  }

  return {
    ...(Object.keys(pageSetup).length === 0 ? {} : { pageSetup }),
    ...(Object.keys(formatInfo).length === 0 ? {} : { formatInfo }),
    ...(Object.keys(sheetProperties).length === 0 ? {} : { sheetProperties }),
    ...(headerFooter === undefined ? {} : { headerFooter })
  };
}

const PRINT_OPTION_KEYS = [
  "horizontalCentered",
  "verticalCentered",
  "showRowColHeaders",
  "showGridLines"
] as const satisfies readonly (keyof PrintOptionsLike)[];

/** The deepest outline level among a sheet's rows or columns, or 0 when none is grouped. */
function maxOutlineLevel(items: readonly { readonly outlineLevel?: number }[] | undefined): number {
  let depth = 0;
  for (const item of items ?? []) {
    const level = item.outlineLevel ?? 0;
    if (Number.isFinite(level) && level > depth) {
      depth = level;
    }
  }
  return depth;
}
