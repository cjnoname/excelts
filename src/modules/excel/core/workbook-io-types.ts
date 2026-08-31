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
