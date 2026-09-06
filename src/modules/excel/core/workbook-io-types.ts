/**
 * The public IO option and report types, in one place for both platforms.
 *
 * **Why they are not declared where they are used.** `xlsx-io.ts` and `xlsx-io.browser.ts` are platform
 * variants, and these three types are not: a `format` option means the same thing in a browser as it does
 * under Node. Declaring them twice made them two copies of one public contract, and they had already
 * drifted — the write options' documentation differed between the two files, so a consumer reading the
 * browser declaration was told something the Node one did not say. Adding a field to only one of them is
 * the failure this file exists to make impossible.
 *
 * What genuinely differs stays in the variants: `toBuffer` returns a `Buffer` on Node and a
 * `Uint8Array` in a browser, the stream types are each platform's own, and file-path IO is Node-only.
 */
import type { WorkbookData } from "@excel/core/workbook-core";
import type { WorkbookFormat } from "@excel/core/workbook-format";
import type { XlsxReadOptions, XlsxWriteOptions } from "@excel/xlsx/xlsx.browser";

/**
 * Options common to reading either format.
 *
 * `format` is declared rather than inferred so a caller can be explicit, and so a misspelling is a
 * compile error — these option bags carry no index signature for exactly that reason.
 */
export interface WorkbookReadOptions extends XlsxReadOptions {
  /** Force a format instead of detecting one. */
  readonly format?: WorkbookFormat;
  /**
   * What to do about content the XLSB reader could not recover.
   *
   * `"ignore"` (the default) reads the workbook without it. `"error"` refuses and names what was lost, on
   * the thrown error's `items`. Ignored when reading XLSX.
   *
   * The default is the opposite of the write side's on purpose: writing a workbook this library holds in
   * memory can afford to stop, while refusing to *read* a real file because part of it uses a record
   * whose layout is unestablished would make the reader unusable. See `readXlsbInto`.
   */
  readonly unsupported?: "error" | "ignore";
  /**
   * What to do with cells that carry formatting and no value.
   *
   * - `"keep"` (the default) gives each one a cell in the model, which is what a caller iterating cells expects.
   * - `"collapse"` accumulates them into rectangles instead. Excel writes a `BrtCellBlank` for every cell of a
   *   formatted region, so a sheet with a formatted column has one per row to the sheet's end — measured at 186 MB of
   *   retained heap and 16,379 physical rows against 253 rows of actual data, against 0.4 MB and 253 rows collapsed.
   *
   * **`"collapse"` is lossless in both containers.** The rectangles describe exactly the cells they came from — a
   * `BrtCellBlank` run in XLSB, a `<c s="N"/>` run in XLSX — so writing the workbook back in the container it was read
   * from reproduces them byte for byte and nothing is owed to a fidelity report. Measured on XLSX at 43.8 MB and 8,000
   * physical rows against 200 rows of data, writing back to an identical 148,820 bytes.
   *
   * **Crossing containers costs nothing either, and the warning that used to sit here was wrong.** It said "a collapsed
   * read written as XLSX loses the blank formatting. That loss is currently silent". Measured on 300 styled blanks in one
   * column, all four combinations — `keep`/`collapse` read, written as XLSX/XLSB — come back with 300 formatted blanks and
   * the same fill on each. Both writers expand the rectangles; the XLSX one does it in `worksheet-xform`, the XLSB one in
   * `model-adapter`. There is no report owed because there is no loss.
   */
  readonly blankCells?: "keep" | "collapse";
  /**
   * What to do with a formula cell's expression when reading XLSB.
   *
   * A formula cell in XLSB carries two independent things: the value Excel last computed, and the token stream that
   * computed it. The value always decodes. The token stream is the hard part of the format, and the part where this
   * codec can be defeated by a construct it has not met — so what should happen then is a policy, not a default.
   *
   * - `"preserve"` (the default) keeps every expression it can decode and the cached value where it cannot, listing the
   *   address under `undecodedFormulas`. Nothing throws and nothing is invented, which is what a caller opening an
   *   arbitrary file wants.
   * - `"cached"` does not decode expressions at all: every formula cell becomes its cached value. Choose it to pull
   *   numbers out of a large workbook without paying for token decoding, or when Excel's computed value is worth more
   *   to you than an expression reconstructed by this library.
   * - `"error"` throws `XlsbFormulaDecodeError` on the first expression that fails, naming the sheet and the addresses.
   *   Choose it when a dropped formula makes the result wrong rather than merely poorer — a pipeline that recalculates
   *   the workbook would otherwise silently inherit a constant where a computation belonged.
   *
   * Ignored when reading XLSX, where a formula is stored as the text a caller would get back anyway.
   */
  readonly formulas?: "preserve" | "cached" | "error";
}

/**
 * Options for `readWithDiagnostics`.
 *
 * `unsupported` is deliberately **not** among them. That function's whole purpose is to hand back the
 * report instead of turning it into a rejection, so accepting a policy it then ignores would be a
 * silently inert option — and one whose obvious reading (`"error"` should throw) is the opposite of what
 * would happen. Omitting it from the type says so at the call site rather than in a paragraph.
 */
export type WorkbookDiagnosticReadOptions = Omit<WorkbookReadOptions, "unsupported">;

/** Options common to writing either format. */
export interface WorkbookWriteOptions extends XlsxWriteOptions {
  /** Format to write. Defaults to `"xlsx"`, or to the extension for `writeFile`. */
  readonly format?: WorkbookFormat;
  /**
   * What to do about content the XLSB writer cannot express.
   *
   * `"error"` (the default) refuses the write and names what would be lost, on the thrown error's
   * `items`. `"ignore"` writes the workbook without it. Ignored when writing XLSX, which expresses
   * everything this library models.
   */
  readonly unsupported?: "error" | "ignore";
}

/**
 * What a read recovered, and what it could not.
 *
 * Returned by `readWithDiagnostics` for the case `unsupported` cannot serve: a caller who wants the
 * workbook *and* the report. `"error"` gives the report only by refusing, and the default gives the
 * workbook only by staying silent — so a tool that reads a file and then tells its user "these cells
 * could not be recovered" had no way to be written.
 */
export interface WorkbookReadReport {
  /** The workbook, already populated. */
  readonly workbook: WorkbookData;
  /**
   * Content that did not reach the workbook, as `Sheet!A1: reason` or `Sheet: reason`.
   *
   * Empty for an XLSX read, which has no equivalent channel — not because nothing is ever lost there, but
   * because that reader does not collect one. Saying so is better than implying a guarantee.
   */
  readonly lost: readonly string[];
  /**
   * Cell records recognised but not decodable, counted by record name.
   *
   * The same losses `lost` describes in prose, in the shape a program can act on. A converter reporting
   * "1,400 cells use `BrtShortReal`" should not have to parse a sentence to find that out, and the
   * sentence deliberately *aggregates* — one line per sheet — so the numbers are not all in it.
   */
  readonly unreadRecords: ReadonlyMap<string, number>;
  /** Formula expressions that could not be decoded, as `Sheet!A1`. The cached value survived. */
  readonly undecodedFormulas: readonly string[];
  /** Cells deferring to a shared formula, which this reader does not resolve, as `Sheet!A1`. */
  readonly sharedFormulaCells: readonly string[];
  /**
   * Record ids this library has no name for, counted by id.
   *
   * Deliberately *not* part of `lost`, and this is the field that makes the distinction usable. A record
   * from a newer schema is not missing content — every workbook in the reference corpus has some — so
   * counting them as losses would make `unsupported: "error"` reject ordinary files. A caller who wants
   * to know anyway can look here.
   */
  readonly unknownRecords: ReadonlyMap<number, number>;
}

/**
 * `readWithDiagnostics`, once, for both platforms.
 *
 * **The body was 26 identical lines in `xlsx-io.ts` and `xlsx-io.browser.ts`.** This file already exists because the
 * *types* were declared twice and drifted — its own header says so — and the function that produces them was duplicated
 * beside them. Adding a field to `WorkbookReadReport` meant editing two bodies, and missing one would leave a platform
 * returning a report short a field without any type error, because the type came from here.
 *
 * `read` is injected rather than imported: it is the one genuinely platform-specific piece, since Node accepts a file
 * path and a `Buffer` where a browser does not. Everything else — the format resolution, the XLSB branch, the empty
 * report an XLSX read yields — is identical and now exists once.
 */
export async function readWorkbookWithDiagnostics(
  wb: WorkbookData,
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options: WorkbookDiagnosticReadOptions | undefined,
  platform: {
    readonly read: (
      wb: WorkbookData,
      data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
      options?: WorkbookDiagnosticReadOptions
    ) => Promise<WorkbookData>;
    readonly normalizeBytes: (
      data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
      base64?: boolean
    ) => Uint8Array | undefined;
    readonly resolveReadFormat: (bytes: Uint8Array, format?: WorkbookFormat) => WorkbookFormat;
    readonly parseXlsbPackage: (
      bytes: Uint8Array,
      source: string,
      options: { blankCells?: "keep" | "collapse"; formulas?: "preserve" | "cached" | "error" }
    ) => Promise<{ readonly diagnostics: Omit<WorkbookReadReport, "workbook"> }>;
    readonly commitXlsbRead: (wb: WorkbookData, parsed: never) => void;
  }
): Promise<WorkbookReadReport> {
  const bytes = platform.normalizeBytes(data, options?.base64);
  if (bytes !== undefined && platform.resolveReadFormat(bytes, options?.format) === "xlsb") {
    // `blankCells` reaches here too: `readWithDiagnostics` is the same read with the report handed back instead of
    // thrown, so a caller inspecting a large formatted sheet needs the same policy the plain read offers.
    const parsed = await platform.parseXlsbPackage(bytes, "<buffer>", {
      ...(options?.blankCells === undefined ? {} : { blankCells: options.blankCells }),
      ...(options?.formulas === undefined ? {} : { formulas: options.formulas })
    });
    platform.commitXlsbRead(wb, parsed as never);
    wb.sourceFilePath = undefined;
    return { workbook: wb, ...parsed.diagnostics };
  }
  return {
    // **An XLSX read reports nothing because that reader collects nothing, not because nothing can be lost.** So an empty
    // report here means "not measured", which `WorkbookReadReport.lost` says in prose.
    //
    // It does *not* mean the reader truncates behind the caller's back: `maxRows` and `maxCols` throw
    // `MaxItemsExceededError` rather than skipping, which their own documentation used to deny and their tests have
    // always required.
    workbook: await platform.read(wb, data, options),
    lost: [],
    unreadRecords: new Map(),
    undecodedFormulas: [],
    sharedFormulaCells: [],
    unknownRecords: new Map()
  };
}
