/**
 * What each part of an XLSB package is.
 *
 * Determined by content type, not by path or extension. That is not a stylistic
 * preference — it is what the format says, and getting it wrong makes the validator
 * useless on real files. Checked against two Excel-authored workbooks, a `.bin` part may
 * be any of:
 *
 * | Content type                                          | What it is                  |
 * | ----------------------------------------------------- | --------------------------- |
 * | `…ms-excel.sheet.binary.macroEnabled.main`             | the workbook, a record stream |
 * | `…ms-excel.worksheet`                                 | a worksheet                 |
 * | `…ms-excel.binIndexWs`                                | Excel's own row index       |
 * | `…ms-excel.styles` / `.sharedStrings` / `.calcChain`   | record streams              |
 * | `…ms-office.vbaProject`                               | **an OLE2 compound file**   |
 * | `…spreadsheetml.printerSettings`                       | **a DEVMODE struct**        |
 *
 * The last two are not record streams at all. An earlier version of this validator keyed
 * off the `.bin` extension and reported both as `framing-payload-overrun`, and matched
 * `binaryIndex1.bin` with a `xl/worksheets/*.bin` pattern so it demanded the part open
 * with `BrtBeginSheet`. Every real workbook produced four or more false positives, while
 * fifty-odd hand-built tests passed — which is exactly the shape of gap a differential
 * check against real output exists to find.
 */

import { recordNamesInCategory } from "@excel/xlsb/spec/records";

/** The kinds of part this validator knows about. */
export type XlsbPartRole =
  | "workbook"
  | "worksheet"
  | "sharedStrings"
  | "styles"
  | "table"
  | "comments"
  | "binaryIndex"
  | "calcChain"
  /** A record stream whose vocabulary this validator does not model. */
  | "unknownRecordStream"
  /** A binary part that is not a record stream; skipped entirely. */
  | "opaqueBinary";

/**
 * Content type → role.
 *
 * Lower-cased keys: OPC compares content types case-insensitively, and the macro-enabled
 * workbook type is written with varying capitalisation in the wild.
 */
const ROLE_BY_CONTENT_TYPE: ReadonlyMap<string, XlsbPartRole> = new Map(
  (
    [
      ["application/vnd.ms-excel.sheet.binary.macroenabled.main", "workbook"],
      ["application/vnd.ms-excel.template.macroenabled.main", "workbook"],
      ["application/vnd.ms-excel.addin.macroenabled.main", "workbook"],
      ["application/vnd.ms-excel.worksheet", "worksheet"],
      ["application/vnd.ms-excel.chartsheet", "unknownRecordStream"],
      ["application/vnd.ms-excel.dialogsheet", "unknownRecordStream"],
      ["application/vnd.ms-excel.macrosheet", "unknownRecordStream"],
      ["application/vnd.ms-excel.intlmacrosheet", "unknownRecordStream"],
      ["application/vnd.ms-excel.sharedstrings", "sharedStrings"],
      ["application/vnd.ms-excel.styles", "styles"],
      ["application/vnd.ms-excel.table", "table"],
      ["application/vnd.ms-excel.comments", "comments"],
      ["application/vnd.ms-excel.threadedcomments+xml", "opaqueBinary"],
      ["application/vnd.ms-excel.binindexws", "binaryIndex"],
      ["application/vnd.ms-excel.calcchain", "calcChain"],
      ["application/vnd.ms-excel.pivottable", "unknownRecordStream"],
      ["application/vnd.ms-excel.pivotcachedefinition", "unknownRecordStream"],
      ["application/vnd.ms-excel.pivotcacherecords", "unknownRecordStream"],
      ["application/vnd.ms-excel.querytable", "unknownRecordStream"],
      ["application/vnd.ms-excel.connections", "unknownRecordStream"],
      // Not record streams. Reading either as one produces a framing error on a part
      // that is perfectly valid.
      ["application/vnd.ms-office.vbaproject", "opaqueBinary"],
      [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.printersettings",
        "opaqueBinary"
      ]
    ] as const
  ).map(([type, role]) => [type, role as XlsbPartRole])
);

/** Whether a role denotes a stream of BIFF12 records. */
export function isRecordStream(role: XlsbPartRole): boolean {
  return role !== "opaqueBinary";
}

/**
 * Classify a part.
 *
 * @param contentType Effective content type: the part's `Override`, or the `Default` for
 *                    its extension. Excel declares the workbook itself with a `Default`,
 *                    so requiring an `Override` here rejects every real file.
 */
export function partRole(path: string, contentType: string | undefined): XlsbPartRole {
  const known = contentType && ROLE_BY_CONTENT_TYPE.get(contentType.toLowerCase());
  if (known) {
    // A package has exactly one workbook part. When the workbook type arrives at another
    // path it came from the `bin` Default rather than from an Override — a package that
    // under-declares its worksheets — and concluding there is a second workbook would
    // demand `BrtBeginBook` of a worksheet. Treat it as a stream of unknown vocabulary:
    // framing and scope balance still apply, the part-specific expectations do not.
    if (known === "workbook" && path.toLowerCase() !== "xl/workbook.bin") {
      return "unknownRecordStream";
    }
    return known;
  }
  // No declaration, or one this table does not list. A `.bin` under a path Excel uses for
  // record streams is treated as one so framing is still checked; anything else is left
  // alone, because guessing that an undeclared binary is a record stream is how the
  // OLE2 false positive happened.
  return /\.bin$/i.test(path) && /^xl\//i.test(path) ? "unknownRecordStream" : "opaqueBinary";
}

export interface XlsbPartExpectations {
  /** Record the part must open with, when its role requires one. */
  readonly rootScope?: string;
  /** Pairs of record names where the first must precede the second. */
  readonly precedes?: readonly (readonly [string, string])[];
  /** Whether cell records must sit inside `BrtBeginSheetData` and follow a row header. */
  readonly cellsInSheetData?: boolean;
  /**
   * Records every part of this role must contain, because Excel writes them into every one.
   *
   * This rule exists because of a gap the others could not close. A package can satisfy framing,
   * scoping, ordering, coordinates and indexes — every check here — and still be rejected by Excel,
   * since "internally coherent" and "acceptable to Excel" are different claims. Comparing this
   * library's output against Excel's record by record showed the difference was never a wrong
   * field: it was *absence*. A workbook with no `BrtFileVersion`, or a worksheet with no view, is
   * coherent and unopenable.
   *
   * The list is therefore derived from what every workbook in the reference corpus contains, not
   * from a specification's notion of "required" — that being the only evidence available here.
   */
  readonly requiredRecords?: readonly string[];
}

export const XLSB_PART_ROLES: Readonly<Record<XlsbPartRole, XlsbPartExpectations>> = {
  workbook: {
    rootScope: "BrtBeginBook",
    // The sheet bundle has to be declared before anything can reference a sheet by
    // index, which `BrtExternSheet` and defined names both do.
    precedes: [["BrtBeginBundleShs", "BrtExternSheet"]],
    // Present in all nine Excel-authored reference workbooks. `BrtFileVersion` is the first record in every one
    // of them, and a consumer reads it before it reads anything it has to interpret.
    requiredRecords: [
      "BrtFileVersion",
      "BrtWbProp",
      "BrtBeginBookViews",
      "BrtBookView",
      "BrtBeginBundleShs",
      "BrtBundleSh",
      "BrtCalcProp"
    ]
  },
  worksheet: {
    rootScope: "BrtBeginSheet",
    // A sheet with no view has nowhere to be displayed, which is the clearest of these: every
    // reference sheet declares one, and one is the minimum that means anything.
    requiredRecords: [
      "BrtWsProp",
      "BrtWsDim",
      "BrtBeginWsViews",
      "BrtBeginWsView",
      "BrtWsFmtInfo",
      "BrtBeginSheetData"
    ],
    // BrtWsDim declares the used range; a consumer sizes its buffers from it, so it
    // arriving after the cells it describes defeats the purpose.
    precedes: [
      ["BrtWsDim", "BrtBeginSheetData"],
      ["BrtBeginSheetData", "BrtBeginMergeCells"]
    ],
    cellsInSheetData: true
  },
  sharedStrings: { rootScope: "BrtBeginSst" },
  styles: {
    rootScope: "BrtBeginStyleSheet",
    // Cell formats reference fonts, fills, borders and number formats by index, so
    // every table they index into has to be declared first.
    precedes: [
      ["BrtBeginFmts", "BrtBeginCellXfs"],
      ["BrtBeginFonts", "BrtBeginCellXfs"],
      ["BrtBeginFills", "BrtBeginCellXfs"],
      ["BrtBeginBorders", "BrtBeginCellXfs"]
    ]
  },
  table: { rootScope: "BrtBeginList" },
  comments: {
    rootScope: "BrtBeginComments",
    // A comment names its author by index into the author list.
    precedes: [["BrtBeginCommentAuthors", "BrtBeginCommentList"]]
  },
  // Excel's own row index and calculation chain are record streams with vocabularies this
  // validator does not model. Framing and scope balance still apply — they are the
  // format-wide invariants — but there is no root scope to demand, and demanding one is
  // what made every real workbook fail.
  binaryIndex: {},
  calcChain: {},
  unknownRecordStream: {},
  opaqueBinary: {}
};

/** Records that carry a `Cell` and must therefore live inside a row. */
export const CELL_RECORD_NAMES = recordNamesInCategory("cell");

/** Records that open a row. */
export const ROW_RECORD_NAMES = recordNamesInCategory("row");

/**
 * Guess a role from a path, for validating a part with no package around it.
 *
 * Named to be unmistakable. Path patterns are what the package-level classifier
 * deliberately does *not* use, because `xl/worksheets/binaryIndex1.bin` matches every
 * reasonable worksheet pattern and is not a worksheet. This exists only for
 * `validateXlsbPart`, where there is no `[Content_Types].xml` to consult, and a caller
 * that knows the role should pass it instead.
 */
export function guessPartRoleFromPath(path: string): XlsbPartRole {
  const lower = path.toLowerCase();
  if (lower === "xl/workbook.bin") {
    return "workbook";
  }
  if (/^xl\/worksheets\/binaryindex\d*\.bin$/.test(lower)) {
    return "binaryIndex";
  }
  if (/^xl\/worksheets\/[^/]+\.bin$/.test(lower)) {
    return "worksheet";
  }
  if (lower === "xl/sharedstrings.bin") {
    return "sharedStrings";
  }
  if (lower === "xl/styles.bin") {
    return "styles";
  }
  if (lower === "xl/calcchain.bin") {
    return "calcChain";
  }
  if (/^xl\/tables\/[^/]+\.bin$/.test(lower)) {
    return "table";
  }
  if (/^xl\/comments\d*\.bin$/.test(lower)) {
    return "comments";
  }
  return "unknownRecordStream";
}
