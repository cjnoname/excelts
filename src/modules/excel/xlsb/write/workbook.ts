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
  NAME_FLAG_HIDDEN,
  encodeNullableWideString,
  encodeWideString
} from "@excel/xlsb/binary";
import {
  bookProtection,
  bookProtectionIso,
  bookView,
  calculationProperties,
  fileVersion,
  workbookProperties,
  type BookProtectionLike,
  type WorkbookViewLike
} from "@excel/xlsb/defaults";
import {
  FUTURE_FUNCTION_FLAGS,
  FUTURE_FUNCTION_STUB_RGCE,
  encodePtg,
  externSheetWasUsed,
  type PtgContext
} from "@excel/xlsb/formula/ptg";
import { pivotCacheIdRecords } from "@excel/xlsb/pivot-cache";
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
    /**
     * The cache bindings. Each is a `BrtBeginPivotCacheID` naming a workbook relationship, and the package
     * MUST contain one cache definition part per entry — so this list and the parts are planned together.
     */
    readonly pivotCaches?: readonly { readonly cacheId: number; readonly relationshipId: string }[];
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
    /** The first workbook view. One `BrtBookView` is written, so later views are reported. */
    readonly views?: readonly WorkbookViewLike[];
    /** Structure, window and revision locks. */
    readonly protection?: BookProtectionLike;
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
    // **Immediately after `BrtWbProp`, before the book views.** This sat after `BrtCalcProp`, near the end of
    // the stream, and Excel would not open the file at all — not a repaired record, not a removed feature.
    // Moving the pair here is the whole fix; the records themselves were byte-correct, which is why nothing
    // that inspected them found anything. It is also where ISO/IEC 29500 puts `<workbookProtection>`: right
    // after `<workbookPr>` and before `<bookViews>`.
    //
    // The old position cited `poi-Simple.xlsb` as precedent. That was worthless as evidence — it is a file
    // from Apache POI's test corpus, and there is nothing to say Excel wrote it. Do not treat a corpus file
    // as Excel's own output without knowing which produced it.
    //
    // Written only when something is locked: Excel omits the record otherwise, and one saying "nothing is
    // protected" is a claim rather than the absence of one.
    ...(options.protection === undefined ||
    Object.values(options.protection).every(value => value !== true)
      ? []
      : [
          // The Iso record carries the password and MUST immediately precede the legacy one.
          ...(() => {
            const iso = bookProtectionIso(options.protection);
            return iso === undefined ? [] : [record("BrtBookProtectionIso", iso)];
          })(),
          record("BrtBookProtection", bookProtection(options.protection))
        ]),
    record("BrtBeginBookViews"),
    record("BrtBookView", bookView(options.views?.[0])),
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
          // The sheet's own relationship id, not `rId${index + 1}`. A chartsheet follows the worksheets
          // in the relationship sequence, so deriving the id from the bundle position pointed every
          // chartsheet at a worksheet — a sheet whose tab said "Chart1" and whose contents were a grid.
          encodeNullableWideString(sheet.relationshipId ?? `rId${index + 1}`),
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
  // **Written only when something needs it**, which is now a fact rather than a guess.
  //
  // This block used to be unconditional, and the comment here argued for that at length: the table is always
  // *valid*, getting the condition wrong is silent and severe, and Excel's rule "is not inferable from the
  // evidence available". The last part was the weak link — it was not inferable from *what the model appears to
  // contain*, which is what had been tried. `externSheetWasUsed` asks the encoder instead, and the encoder is
  // the only thing that resolves an `ixti`.
  //
  // The rule agrees with Excel on twelve of the fifteen references and is deliberately narrower on the other
  // three. Excel writes the block for `03-conditional-formats`, `05-pivots` and `12-charts` where nothing here
  // resolves an `ixti`, and each has been checked:
  //
  // - `03` — its `containsText` rule does carry a formula, but the formula's reference is a `PtgRefN`, an
  //   offset within the same sheet. No `ixti`.
  // - `05` — the pivot cache names its source sheet by *name*, in `BrtBeginPCDSRange`, not by index.
  // - `12` — the chart's series formulas live in an XML part, which has no `ixti` at all.
  //
  // So at least one input to Excel's decision is not visible from here, and the honest position is to write the
  // block when something needs it rather than to reproduce a rule that has not been worked out. Nothing in this
  // codec resolves an `ixti` outside `sheetIndex` — verified by grep, and the reason it is safe to be narrow:
  // the failure mode of omitting it wrongly is a dangling index, and there is no index to dangle.
  //
  // The ordering constraint the old comment identified is real and is why the names are encoded first: a
  // defined name's own formula can contain a 3D reference, so the decision cannot be made before they are
  // written. The records are assembled in the file's order afterwards.
  const unsupported: string[] = [];
  const nameRecords: Emitted[] = [];
  for (const name of options.definedNames ?? []) {
    const encoded = encodeName(name, options.formulaContext ?? {});
    nameRecords.push(record("BrtName", encoded.bytes));
    unsupported.push(...encoded.lost.map(reason => `${name.name}: ${reason}`));
  }

  if (options.formulaContext !== undefined && externSheetWasUsed(options.formulaContext)) {
    // The externals block, in the position every reference workbook puts it: after the sheet bundle and before
    // the names, both of which it is needed by.
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
  }

  // Names, in the order `PtgName`'s one-based index refers to them.
  records.push(...nameRecords);

  records.push(
    record("BrtCalcProp", calculationProperties(options.calcProperties)),
    // `BrtFileRecover` — one byte of AutoRecover state, every bit clear because this is a normal save, not a
    // recovery. Excel writes it here in every workbook part it produces and this wrote none.
    record("BrtFileRecover", new Uint8Array(1)),
    // The cache bindings, after the calculation properties. Each `idSx` here is what a view's
    // `BrtBeginSXView.idCache` must equal.
    ...pivotCacheIdRecords(options.pivotCaches ?? []).map(([name, payload]) =>
      record(name, payload)
    ),
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
  // A stub for a function the `Ftab` cannot name. Its body is `PtgErr(#NAME?)` and its flags are fixed by the
  // specification — neither is a property of the *model*, so both are decided from the name itself rather than
  // asked of the caller. `package.ts` creates these; nothing else may be called `_xlfn.*`.
  const isFutureFunctionStub = name.name.startsWith("_xlfn.");
  let tokens: Uint8Array = isFutureFunctionStub ? FUTURE_FUNCTION_STUB_RGCE : new Uint8Array(0);
  // A reference name's definition is its first range. A *formula* name holds an expression instead and
  // an *opaque* one holds the raw XML it was read from — both arrive with `ranges` empty, so reading
  // only `ranges[0]` wrote them as a name defined as nothing and reported that as a success. Neither is
  // encodable here (a formula name needs the same Ptg support a cell formula would, and opaque raw XML
  // has no BIFF12 form at all), so what matters is that both are now named rather than assumed absent.
  // A multi-range name is a *union*, and Excel writes it as one — this codec already emits `UnionRefNode`
  // as `PtgMemFunc`. Taking `ranges[0]` instead truncated the name silently, so `=SUM(Region)` over two
  // blocks came back summing one.
  //
  // **The parentheses are required.** A bare `A1:B2,C3:D4` is not a union in Excel's grammar — a comma
  // only separates function arguments there — so this library's parser rejects it with "unexpected
  // trailing token". `(A1:B2,C3:D4)` is the union form, and joining without them made every multi-range
  // name fail to encode and be reported as an unwritable definition.
  const definition =
    name.ranges !== undefined && name.ranges.length > 0
      ? name.ranges.length === 1
        ? name.ranges[0]
        : `(${name.ranges.join(",")})`
      : name.formulaExpression;
  if (isFutureFunctionStub) {
    // Nothing to encode: the body is the constant above. Writing the model's `#NAME?` text through the
    // formula encoder would work, and would put a second spelling of the same two bytes in the file.
  } else if (definition !== undefined) {
    try {
      tokens = encodePtg(parse(tokenize(definition)), context, `name ${name.name}`);
    } catch {
      lost.push("defined name definition");
    }
  } else if (name.rawText !== undefined || name.kind === "opaque") {
    lost.push("opaque defined name definition");
  }
  // `localSheetId` is the model's field, and this check used to read `sheetName` — which
  // `DefinedNameModel` does not have. So every sheet-local name in a real workbook was silently
  // promoted to workbook scope while the report stayed empty, and the test that covered it passed
  // because it hand-built the field the check was looking for rather than the one the model uses.
  const bytes = concatUint8Arrays([
    new BinaryWriter()
      // `fHidden` at bit 0. The corpus establishes the field's *position* — every one of its seven names
      // has flags 0 — and the bit's meaning comes from the documented convention the XLSX `hidden`
      // attribute follows, so it is registered in `INFERRED_VALUES`.
      //
      // A future function's stub is the one name with more than that: MS-XLSB 2.4.674 makes
      // `fHidden | fFunc | fProc | fFutureFunction` mandatory together, and Excel's own stubs carry exactly
      // that value. See `FUTURE_FUNCTION_FLAGS`.
      .writeUint32(
        isFutureFunctionStub ? FUTURE_FUNCTION_FLAGS : name.hidden === true ? NAME_FLAG_HIDDEN : 0
      )
      .writeUint8(0) // keyboard shortcut
      // The sheet index, or `0xFFFFFFFF` for workbook scope. Both values are read off Excel's own
      // output, so a sheet-local name is expressible — this writer used to force every name to the
      // workbook and report the demotion, which turned `Sheet2!Total` into a name two sheets could see.
      .writeUint32(name.localSheetId ?? 0xffffffff)
      .toUint8Array(),
    encodeWideString(name.name),
    new BinaryWriter().writeUint32(tokens.length).toUint8Array(),
    tokens,
    new BinaryWriter()
      .writeUint32(0) // cb: no extra token data
      .writeUint32(0xffffffff) // comment: absent
      .toUint8Array(),
    // **`fProc` brings four more strings with it, and omitting them truncates the record.**
    //
    // `BrtName` ends with `comment` for an ordinary name, but a name that declares itself a macro — which is
    // what `fProc` says — carries `menu`, `description`, `help` and `statusBar` after it. This writer set the
    // flag and stopped at `comment`, so every future-function stub was 16 bytes short: Excel could not read the
    // name, dropped it ("Removed Feature: Named range from /xl/workbook.bin"), and then could not resolve the
    // formula that called through it ("Repaired Records: Formula") — two entries in the repair log from one
    // missing field, which is why the second one was misleading on its own.
    //
    // Measured, not inferred. Excel's own `_xlfn.CONCAT` stub in `cal-issue_182.xlsb` ends with a zero `cb`
    // and *five* `0xFFFFFFFF` strings, where its ordinary names in the same file end with one — and the only
    // difference between them is this flag.
    //
    // This is the shape of specification statement this module has been caught by before: "if A then B" binds
    // any file that sets A. Setting `fProc` for the flag byte's sake while skipping the fields it introduces is
    // not a partial implementation, it is a malformed record.
    isFutureFunctionStub
      ? new BinaryWriter()
          .writeUint32(0xffffffff) // menu: absent
          .writeUint32(0xffffffff) // description: absent
          .writeUint32(0xffffffff) // help: absent
          .writeUint32(0xffffffff) // statusBar: absent
          .toUint8Array()
      : new Uint8Array(0)
  ]);
  return { bytes, lost };
}
