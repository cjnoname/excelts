/**
 * What a binary workbook drops, named so a caller can be told.
 *
 * **Why this exists at all.** The writer's `unsupported` list covered cell values and merge
 * references, and `unsupported: "error"` — the default — reads as "refuse anything this container
 * cannot express". It did not: a workbook with tables, filters, validations, conditional formatting,
 * shapes or charts wrote successfully and arrived with none of
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
import { filterCriteriaRecords } from "@excel/xlsb/filter-criteria";
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
  errors: "displayed"
} as const;

// `showRowColHeaders`, `showGridLines`, `horizontalCentered` and `verticalCentered` were listed here as losable
// and are not lost any more: `BrtPrintOptions` carries all four, and its bits went uninterpreted until Excel's
// own output pinned them. They are removed rather than left in place — a name in this list is a claim that the
// writer cannot express it.

/** A worksheet field that carries a feature, and the name to report it under. */
const SHEET_FEATURES: readonly {
  readonly name: string;
  readonly of: (worksheet: SheetLike) => unknown;
}[] = [
  // The filter's *criteria*, not the filter. `BrtBeginAFilter` carries the range and the arrows appear
  // on it; a condition a person applied lives in the `BrtBeginFilterColumn` collection.
  //
  // Values, custom comparisons and top-N are written now. What is not is a **dynamic, colour or icon**
  // filter, and the check names only those — the raw XML the reader preserved is parsed, so this can report
  // the kinds actually present instead of condemning every criterion the moment one appears.
  //
  // The field name matters and was wrong here first: it is `autoFilterCriteria` on the *sheet*, not a
  // `filterColumns` on the `autoFilter`. Reading a field the model does not have made the check both
  // dead and misleading — it never fired for a real dropped filter, and fired for a shape nothing
  // produces.
  {
    name: "auto filter criteria",
    of: sheet =>
      sheet.autoFilterCriteria?.xml === undefined
        ? 0
        : filterCriteriaRecords(sheet.autoFilterCriteria.xml).unsupported.length
  }
];

/** The subset of a worksheet model these checks read. */
interface SheetLike {
  readonly dataValidations?: unknown;
  readonly conditionalFormattings?: readonly unknown[];
  readonly tables?: readonly unknown[];
  readonly pivotTables?: readonly unknown[];
  readonly autoFilter?: unknown;
  /** Raw filter-criteria XML the XLSX reader preserved. No BIFF12 record holds XML. */
  readonly autoFilterCriteria?: { readonly xml?: string };
  /** Only `hashValue` is read: the permissions are written, the password is not. */
  readonly sheetProtection?: { readonly hashValue?: string };
  readonly rowBreaks?: readonly unknown[];
  readonly colBreaks?: readonly unknown[];
  readonly shapes?: readonly unknown[];
  readonly charts?: readonly unknown[];
  readonly sparklineGroups?: readonly unknown[];
  readonly formControls?: readonly unknown[];
  readonly ignoredErrors?: readonly unknown[];
  readonly threadedComments?: readonly unknown[];
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
  // One `BrtBookView` is written, so a *second* workbook view has nowhere to go. The first one's
  // geometry, tab ratio, active sheet and visibility are all expressed.
  add(
    losses,
    "additional workbook view",
    Math.max(0, ((book.views as readonly unknown[] | undefined)?.length ?? 0) - 1)
  );
  return losses;
}

function add(losses: string[], name: string, count: number): void {
  if (count > 0) {
    losses.push(count === 1 ? name : `${name} (${count})`);
  }
}
