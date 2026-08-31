/**
 * What a binary workbook drops, named so a caller can be told.
 *
 * **Why this exists at all.** The writer's `unsupported` list covered cell values and merge
 * references, and `unsupported: "error"` — the default — reads as "refuse anything this container
 * cannot express". It did not: a workbook with tables, filters, validations, conditional formatting,
 * frozen panes, page breaks, comments, shapes or charts wrote successfully and arrived with none of
 * them, and the caller was told nothing. The gap between the promise and the behaviour is the defect;
 * the missing features are merely the reason the gap exists.
 *
 * **Why it is a scan rather than a report from each writer.** Nothing in the record writers touches
 * these fields, so there is nowhere in them to notice the omission — an unwritten feature leaves no
 * trace in the code that does not write it. Reading the model directly is what makes the list
 * complete by construction rather than by whoever remembered.
 *
 * **Compared against the defaults, not against presence.** A freshly created worksheet already carries
 * a fully populated `pageSetup`, a `properties` with outline levels of zero and rows with
 * `hidden: false`. Reporting a field because it *exists* would report every workbook ever built, which
 * is the one outcome worse than silence: it trains callers to pass `"ignore"` permanently. So each
 * check below names the value the writer would have produced anyway, and fires only on a difference.
 * `WRITER_DEFAULTS` is that set, in one place, so a reader can check it against the writer.
 *
 * **What is deliberately not here.** Anything the writer *does* express — rows, columns, merges, tab
 * colour, code name, the page-setup subset established from the corpus, header and footer, placed
 * images, and the workbook's default font. And the cursor: the writer emits a default `BrtSel`, so an
 * `activeCell` is a scroll position rather than content, and reporting one would be noise of exactly
 * the kind described above.
 *
 * The default font is worth naming as a *former* entry. The scan reported it, which is how the gap was
 * found — and the right answer to a loss whose record layout is already established is to write it, not
 * to report it. `writeStyles` now applies it at font index 0.
 */
import type { WorkbookModel } from "@excel/core/workbook.browser";
import type { CellLike } from "@excel/xlsb/write/types";

/**
 * The page-setup values this writer produces regardless of the model.
 *
 * Read off a freshly created worksheet rather than assumed, because that is the model every one of
 * these fields arrives populated from — and a "default" guessed differently from the one the model
 * actually uses would make every workbook report a loss it does not have.
 */
const WRITER_DEFAULTS = {
  pageOrder: "downThenOver",
  blackAndWhite: false,
  draft: false,
  cellComments: "None",
  errors: "displayed",
  showRowColHeaders: false,
  showGridLines: false,
  horizontalCentered: false,
  verticalCentered: false
} as const;

/** A worksheet field that carries a feature, and the name to report it under. */
const SHEET_FEATURES: readonly {
  readonly name: string;
  readonly of: (worksheet: SheetLike) => unknown;
}[] = [
  { name: "data validation", of: sheet => countKeys(sheet.dataValidations) },
  { name: "conditional formatting", of: sheet => sheet.conditionalFormattings?.length },
  { name: "table", of: sheet => sheet.tables?.length },
  { name: "pivot table", of: sheet => sheet.pivotTables?.length },
  { name: "auto filter", of: sheet => (sheet.autoFilter ? 1 : 0) },
  // Configured protection only. The writer emits a default `BrtSheetProtection` for every sheet
  // because Excel does, so an *unprotected* sheet loses nothing.
  { name: "sheet protection", of: sheet => (sheet.sheetProtection ? 1 : 0) },
  { name: "row page break", of: sheet => sheet.rowBreaks?.length },
  { name: "column page break", of: sheet => sheet.colBreaks?.length },
  { name: "shape", of: sheet => sheet.shapes?.length },
  { name: "chart", of: sheet => sheet.charts?.length },
  { name: "sparkline group", of: sheet => sheet.sparklineGroups?.length },
  { name: "form control", of: sheet => sheet.formControls?.length },
  { name: "ignored error", of: sheet => sheet.ignoredErrors?.length },
  { name: "threaded comment", of: sheet => sheet.threadedComments?.length },
  { name: "watermark", of: sheet => (sheet.watermark ? 1 : 0) },
  // A frozen or split pane is `BrtPane`, whose layout no corpus workbook establishes.
  {
    name: "frozen or split pane",
    of: sheet =>
      (sheet.views ?? []).filter(view => view.state === "frozen" || view.state === "split").length
  },
  // The rest of a view. Not "a scroll position": a page-layout view, a right-to-left sheet or a zoom
  // level are all settings an author chose and would notice the absence of. The writer emits one fixed
  // `BrtWsView`, so every one of them is dropped.
  {
    name: "worksheet view setting",
    of: sheet =>
      (sheet.views ?? []).filter(
        view =>
          view.style !== undefined ||
          view.rightToLeft === true ||
          view.showGridLines === false ||
          view.showRowColHeaders === false ||
          view.showRuler === false ||
          (view.zoomScale !== undefined && view.zoomScale !== 100)
      ).length
  },
  { name: "print area", of: sheet => (sheet.pageSetup?.printArea ? 1 : 0) },
  {
    name: "print titles",
    of: sheet => (sheet.pageSetup?.printTitlesRow || sheet.pageSetup?.printTitlesColumn ? 1 : 0)
  },
  // Media that is not a placed picture. `drawingForWorksheet` selects `type === "image"` and nothing
  // else, so a background, a header picture or a watermark image never reaches the package.
  {
    name: "background image",
    of: sheet => (sheet.media ?? []).filter(medium => medium.type === "background").length
  },
  {
    name: "header image",
    of: sheet => (sheet.media ?? []).filter(medium => medium.type === "headerImage").length
  },
  {
    name: "watermark image",
    of: sheet => (sheet.media ?? []).filter(medium => medium.type === "watermark").length
  },
  // Outline levels on the sheet itself, which is where a grouped sheet records its depth.
  {
    name: "outline level",
    of: sheet =>
      (sheet.properties?.outlineLevelCol ?? 0) > 0 || (sheet.properties?.outlineLevelRow ?? 0) > 0
        ? 1
        : 0
  }
];

/** The subset of a worksheet model these checks read. */
interface SheetLike {
  readonly dataValidations?: unknown;
  readonly conditionalFormattings?: readonly unknown[];
  readonly tables?: readonly unknown[];
  readonly pivotTables?: readonly unknown[];
  readonly autoFilter?: unknown;
  readonly sheetProtection?: unknown;
  readonly rowBreaks?: readonly unknown[];
  readonly colBreaks?: readonly unknown[];
  readonly shapes?: readonly unknown[];
  readonly charts?: readonly unknown[];
  readonly sparklineGroups?: readonly unknown[];
  readonly formControls?: readonly unknown[];
  readonly ignoredErrors?: readonly unknown[];
  readonly threadedComments?: readonly unknown[];
  readonly watermark?: unknown;
  readonly media?: readonly { readonly type?: string }[];
  readonly views?: readonly {
    readonly state?: string;
    readonly style?: string;
    readonly rightToLeft?: boolean;
    readonly showGridLines?: boolean;
    readonly showRowColHeaders?: boolean;
    readonly showRuler?: boolean;
    readonly zoomScale?: number;
  }[];
  readonly properties?: {
    readonly outlineLevelCol?: number;
    readonly outlineLevelRow?: number;
  };
  readonly pageSetup?: Record<string, unknown> & {
    readonly printArea?: string;
    readonly printTitlesRow?: string;
    readonly printTitlesColumn?: string;
  };
  readonly rows?: readonly RowLike[];
  readonly cols?: readonly ColumnLike[];
}

interface RowLike {
  readonly style?: CellLike["style"];
  readonly cells?: readonly { readonly style?: CellLike["style"]; readonly comment?: unknown }[];
  readonly hidden?: boolean;
  readonly outlineLevel?: number;
  readonly collapsed?: boolean;
}

interface ColumnLike {
  readonly style?: CellLike["style"];
  readonly hidden?: boolean;
  readonly outlineLevel?: number;
  readonly collapsed?: boolean;
  readonly bestFit?: boolean;
}

/**
 * Features a worksheet carries and this writer does not emit.
 *
 * Counted rather than listed per item: a sheet with four hundred conditionally formatted ranges
 * produces one line saying so, where four hundred lines would bury everything else in the report.
 */
export function worksheetLosses(worksheet: unknown): readonly string[] {
  const sheet = worksheet as SheetLike;
  const losses: string[] = [];
  for (const feature of SHEET_FEATURES) {
    add(losses, feature.name, Number(feature.of(sheet) ?? 0));
  }
  // Borders are a cell format rather than a sheet feature. A `BrtBorder` layout is not established by
  // any corpus workbook — `styles.ts` writes every cell format with border index zero — and a border
  // silently removed from a table of figures is the kind of loss a reader notices immediately and a
  // differential test that compares only values does not.
  //
  // The count is of *owners* that ask for a border, which is the honest unit and is why the name says
  // so: a column model covers a range, and a row's border is inherited by cells that never declared
  // one, so neither "cells affected" nor "distinct borders" would be a number this scan can produce.
  add(losses, "border (owner)", countOwners(sheet, hasBorder));
  add(
    losses,
    "cell comment",
    countCells(sheet, cell => cell.comment !== undefined)
  );
  add(
    losses,
    "hidden row",
    countRows(sheet, row => row.hidden === true)
  );
  add(
    losses,
    "grouped row",
    countRows(sheet, row => (row.outlineLevel ?? 0) > 0)
  );
  add(
    losses,
    "collapsed row",
    countRows(sheet, row => row.collapsed === true)
  );
  add(
    losses,
    "hidden column",
    countColumns(sheet, column => column.hidden === true)
  );
  add(
    losses,
    "grouped column",
    countColumns(sheet, column => (column.outlineLevel ?? 0) > 0)
  );
  add(
    losses,
    "collapsed column",
    countColumns(sheet, column => column.collapsed === true)
  );
  add(
    losses,
    "best-fit column",
    countColumns(sheet, column => column.bestFit === true)
  );
  // Page-setup fields outside the subset whose `BrtPageSetup` layout the corpus establishes. Compared
  // against the value the writer produces anyway, so a default-constructed `pageSetup` is silent.
  for (const [field, expected] of Object.entries(WRITER_DEFAULTS)) {
    const actual = sheet.pageSetup?.[field];
    if (actual !== undefined && actual !== expected) {
      losses.push(`page setup ${field}`);
    }
  }
  return losses;
}

/** Features a workbook carries, outside any one sheet, that this writer does not emit. */
export function workbookLosses(model: WorkbookModel): readonly string[] {
  const losses: string[] = [];
  const book = model as unknown as Record<string, unknown>;
  // A chartsheet holds a chart rather than a cell grid. The reader already declines to invent cells for
  // one; the writer emits only `model.worksheets`, so a chartsheet does not reach the file at all.
  add(losses, "chartsheet", (book.chartsheets as readonly unknown[] | undefined)?.length ?? 0);
  // `BrtBookProtection` is not a record this writer emits, so a structure- or window-locked workbook
  // comes back unlocked — and a lock silently removed is worse than one that fails to apply.
  add(losses, "workbook protection", book.protection === undefined ? 0 : 1);
  // A workbook view carries the window geometry and the active tab. The writer emits one fixed
  // `BrtBookView`, so anything the model said is replaced.
  add(losses, "workbook view", (book.views as readonly unknown[] | undefined)?.length ?? 0);
  // Named cell styles, and the `Normal` entry the writer hard-codes in their place. A cell referring to
  // one by `styleName` therefore loses the reference as well as the style.
  add(losses, "named cell style", countKeys(book.cellStyles));
  // Iterative calculation. The *count* and the *delta* are written — their `BrtCalcProp` offsets are
  // established — but the bit that turns iteration on is in a flags word every corpus workbook leaves
  // off, so it is unobserved. A guessed bit would enable or disable recalculation of every circular
  // reference in the file, which is why this one is reported rather than approximated.
  const calc = book.calcProperties as { iterate?: boolean } | undefined;
  add(losses, "iterative calculation", calc?.iterate === true ? 1 : 0);
  return losses;
}

function add(losses: string[], name: string, count: number): void {
  if (count > 0) {
    losses.push(count === 1 ? name : `${name} (${count})`);
  }
}

function countRows(sheet: SheetLike, matches: (row: RowLike) => boolean): number {
  return (sheet.rows ?? []).filter(matches).length;
}

function countColumns(sheet: SheetLike, matches: (column: ColumnLike) => boolean): number {
  return (sheet.cols ?? []).filter(matches).length;
}

function countCells(
  sheet: SheetLike,
  matches: (cell: { readonly style?: CellLike["style"]; readonly comment?: unknown }) => boolean
): number {
  let count = 0;
  for (const row of sheet.rows ?? []) {
    count += (row.cells ?? []).filter(matches).length;
  }
  return count;
}

/** Rows, their cells, and columns that satisfy a style predicate. */
function countOwners(sheet: SheetLike, matches: (style: CellLike["style"]) => boolean): number {
  let count = 0;
  for (const row of sheet.rows ?? []) {
    if (matches(row.style)) {
      count++;
    }
    count += (row.cells ?? []).filter(cell => matches(cell.style)).length;
  }
  return count + (sheet.cols ?? []).filter(column => matches(column.style)).length;
}

/**
 * Whether a style asks for a border that would actually draw.
 *
 * `Object.keys(border).length > 0` was not enough: `{ border: { top: {} } }` and
 * `{ border: { diagonal: { up: false, down: false } } }` are both shapes the model produces, and
 * neither draws anything — so reporting them was a loss report for a workbook that had lost nothing.
 */
function hasBorder(style: CellLike["style"]): boolean {
  const border = (style as { border?: Record<string, unknown> } | undefined)?.border;
  if (border === undefined) {
    return false;
  }
  for (const [edge, value] of Object.entries(border)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (edge === "diagonal") {
      const diagonal = value as { up?: boolean; down?: boolean; style?: unknown };
      if (diagonal.up === true || diagonal.down === true || diagonal.style !== undefined) {
        return true;
      }
      continue;
    }
    const side = value as { style?: unknown; color?: unknown };
    if (side.style !== undefined || side.color !== undefined) {
      return true;
    }
  }
  return false;
}

function countKeys(value: unknown): number {
  return value === undefined || value === null ? 0 : Object.keys(value as object).length;
}
