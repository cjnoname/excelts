/**
 * The workbook part: `xl/workbook.bin`.
 *
 * Three of the records here exist because their absence made Excel refuse the file. A workbook that
 * opened straight into its sheet bundle — no `BrtFileVersion`, no `BrtBookView`, no `BrtCalcProp` —
 * satisfied every structural rule this library checked, and "internally coherent" turns out not to
 * imply "acceptable to Excel". The sequence below mirrors nine Excel-authored workbooks.
 *
 * The externals block and the names are the other half of that lesson, in the opposite direction:
 * `encodePtg` emits a `PtgRef3d` whose `ixti` indexes `BrtExternSheet`, and a `PtgName` that indexes
 * these records. Until both tables were written, every cross-sheet and named reference pointed into
 * nothing — and a round trip could not see it, because it read back the *cached result* rather than the
 * expression.
 */
import {
  SHEET_STATE,
  encodeBiffRecords,
  encodeNullableWideString,
  encodeWideString
} from "@excel/xlsb/binary";
import {
  bookView,
  calculationProperties,
  fileVersion,
  workbookProperties
} from "@excel/xlsb/defaults";
import { encodePtg, type PtgContext } from "@excel/xlsb/formula/ptg";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import { type SheetEntry } from "@excel/xlsb/write/types";
import { parse } from "@formula/syntax/parser";
import { tokenize } from "@formula/syntax/tokenizer";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** A workbook part, and what the names in it could not carry. */
export interface WrittenWorkbook {
  readonly bytes: Uint8Array;
  /** Defined names whose meaning did not survive, as `name: reason`. */
  readonly unsupported: readonly string[];
}

/** Serialise `xl/workbook.bin`. */
export function writeWorkbookPart(
  sheets: readonly SheetEntry[],
  options: {
    readonly date1904?: boolean;
    /** Names to emit, in the order `PtgName` indexes them. */
    readonly definedNames?: readonly DefinedNameLike[];
    /** Context for encoding each name's definition — the same one the cells use. */
    readonly formulaContext?: PtgContext;
    /**
     * The `BrtExternSheet` table to emit.
     *
     * Supplied rather than derived because the cells may have *added* to it: a reference across a span
     * of sheets needs an entry the identity mapping does not contain. Deriving it here again would emit
     * a table the formulas were not encoded against, which is the same class of bug as emitting none.
     */
    readonly externSheets?: readonly { readonly first: number; readonly last: number }[];
    /** Iteration count and convergence delta, at the two established `BrtCalcProp` offsets. */
    readonly calcProperties?: { readonly iterateCount?: number; readonly iterateDelta?: number };
  } = {}
): WrittenWorkbook {
  // The order and the membership are Excel's. A workbook that opened straight into its sheet bundle
  // satisfied every rule this library checks and was rejected by Excel, because a consumer is
  // entitled to find a file version and a window to restore before it finds any content.
  const records: Emitted[] = [
    record("BrtBeginBook"),
    record("BrtFileVersion", fileVersion()),
    // Unconditional now. The epoch lives in bit 0, and a workbook read from a 1904 file and written
    // back without it would have every date silently shifted by four years.
    record("BrtWbProp", workbookProperties(options.date1904 === true)),
    record("BrtBeginBookViews"),
    record("BrtBookView", bookView()),
    record("BrtEndBookViews")
  ];

  records.push(record("BrtBeginBundleShs"));
  sheets.forEach((sheet, index) => {
    records.push(
      record(
        "BrtBundleSh",
        concatUint8Arrays([
          new BinaryWriter()
            // The state encoding was read off a workbook whose three sheets are named
            // Visible, Hidden and VeryHidden and carry 0, 1 and 2 — which is as direct a
            // confirmation as reference data gets.
            .writeUint32(SHEET_STATE[sheet.state ?? "visible"])
            .writeUint32(index + 1)
            .toUint8Array(),
          encodeNullableWideString(`rId${index + 1}`),
          encodeWideString(sheet.name)
        ])
      )
    );
  });
  records.push(record("BrtEndBundleShs"));

  // The externals block, in the position every reference workbook puts it: after the sheet
  // bundle and before the names, both of which it is needed by.
  //
  // **This closes a silent correctness bug.** `encodePtg` emits a `PtgRef3d` whose `ixti` is an
  // index into `BrtExternSheet`, and until this block existed no such table was written — so
  // every cross-sheet reference this library produced pointed into nothing, while a read-back
  // still returned the right answer because it read the *cached* result. An identity table, one
  // single-sheet entry per sheet in declaration order, is what makes `ixti = sheet position`
  // true by construction rather than by coincidence.
  records.push(record("BrtBeginExternals"), record("BrtSupSelf"));
  const table =
    options.externSheets ?? sheets.map((_sheet, index) => ({ first: index, last: index }));
  const externSheets = new BinaryWriter().writeUint32(table.length);
  table.forEach(entry => {
    externSheets
      .writeUint32(0) // iSupBook: this workbook
      .writeUint32(entry.first) // itabFirst
      .writeUint32(entry.last); // itabLast
  });
  records.push(record("BrtExternSheet", externSheets.toUint8Array()));
  records.push(record("BrtEndExternals"));

  // Names, in the order `PtgName`'s one-based index refers to them.
  const unsupported: string[] = [];
  for (const name of options.definedNames ?? []) {
    const encoded = encodeName(name, options.formulaContext ?? {});
    records.push(record("BrtName", encoded.bytes));
    unsupported.push(...encoded.lost.map(reason => `${name.name}: ${reason}`));
  }

  records.push(
    record("BrtCalcProp", calculationProperties(options.calcProperties)),
    record("BrtEndBook")
  );
  return { bytes: encodeBiffRecords(records), unsupported };
}

/** The subset of `DefinedNameModel` this writer reads. */
interface DefinedNameLike {
  readonly name: string;
  readonly ranges?: readonly string[];
  /** Sheet index for a locally scoped name. `BrtName` can carry one; this writer does not. */
  readonly localSheetId?: number;
  /** Expression for a formula-valued name, in place of `ranges`. */
  readonly formulaExpression?: string;
  /** Original XML, preserved for a name this library did not recognise. */
  readonly rawText?: string;
  readonly kind?: "reference" | "formula" | "opaque";
  readonly hidden?: boolean;
}

/**
 * A `BrtName`, and what it could not carry.
 *
 * The definition is a token stream, so it goes through the same encoder a cell formula does. A
 * definition that cannot be encoded is written as a name with an empty stream rather than
 * dropped: the name still has to occupy its position, because `PtgName` indexes by position and
 * omitting one entry silently retargets every reference after it.
 *
 * **Every one of those outcomes is now reported.** Keeping the slot is the right repair for the
 * *indexing*, and it is not a repair for the name: a workbook came back with `Sales` defined as
 * nothing, and a formula reading `=SUM(Sales)` still there to reference it. The same is true of the
 * two narrowings below — only the first range is written, and the scope is forced to the workbook —
 * so a multi-range name comes back truncated and a sheet-local name comes back global, both silently
 * and both changing what a formula built on them computes.
 */
function encodeName(
  name: DefinedNameLike,
  context: PtgContext
): {
  readonly bytes: Uint8Array;
  readonly lost: readonly string[];
} {
  const lost: string[] = [];
  let tokens: Uint8Array = new Uint8Array(0);
  // A reference name's definition is its first range. A *formula* name holds an expression instead and
  // an *opaque* one holds the raw XML it was read from — both arrive with `ranges` empty, so reading
  // only `ranges[0]` wrote them as a name defined as nothing and reported that as a success. Neither is
  // encodable here (a formula name needs the same Ptg support a cell formula would, and opaque raw XML
  // has no BIFF12 form at all), so what matters is that both are now named rather than assumed absent.
  const definition = name.ranges?.[0] ?? name.formulaExpression;
  if (definition !== undefined) {
    try {
      tokens = encodePtg(parse(tokenize(definition)), context, `name ${name.name}`);
    } catch {
      lost.push("defined name definition");
    }
  } else if (name.rawText !== undefined || name.kind === "opaque") {
    lost.push("opaque defined name definition");
  }
  if ((name.ranges?.length ?? 0) > 1) {
    lost.push(`defined name with ${name.ranges!.length} ranges`);
  }
  // `localSheetId` is the model's field, and this check used to read `sheetName` — which
  // `DefinedNameModel` does not have. So every sheet-local name in a real workbook was silently
  // promoted to workbook scope while the report stayed empty, and the test that covered it passed
  // because it hand-built the field the check was looking for rather than the one the model uses.
  if (name.localSheetId !== undefined) {
    lost.push("sheet-local defined name scope");
  }
  if (name.hidden === true) {
    lost.push("hidden defined name flag");
  }
  const bytes = concatUint8Arrays([
    new BinaryWriter()
      .writeUint32(0) // flags: a plain, visible, workbook-scoped name
      .writeUint8(0) // keyboard shortcut
      .writeUint32(0xffffffff) // sheet index: workbook scope
      .toUint8Array(),
    encodeWideString(name.name),
    new BinaryWriter().writeUint32(tokens.length).toUint8Array(),
    tokens,
    new BinaryWriter()
      .writeUint32(0) // cb: no extra token data
      .writeUint32(0xffffffff) // comment: absent
      .toUint8Array()
  ]);
  return { bytes, lost };
}
