/**
 * Read an XLSB package into a workbook.
 *
 * The part readers in `read/parts.ts` hand back cells; this turns them into a populated
 * `WorkbookData` through the public cell API, so an XLSB read produces a workbook
 * indistinguishable from an XLSX one — same handles, same accessors, same everything
 * downstream.
 *
 * Going through `Cell.setValue` rather than assembling a `WorkbookModel` and calling
 * `setWorkbookModel` is deliberate. The model is a serialisation shape with a dozen
 * interdependent fields, and building one by hand means reproducing invariants that the
 * cell API already maintains — dimensions, row materialisation, shared-string bookkeeping.
 * The cost is one function call per cell; the benefit is that a reader cannot construct a
 * workbook the rest of the library considers malformed.
 */

import { extractAll } from "@archive/unzip/extract";
import { ZipParser } from "@archive/unzip/zip-parser";
// The public cell surface, on purpose: setting a value through it is what keeps dimensions,
// row materialisation and shared-string bookkeeping consistent.
import { definedNamesAdd } from "@excel/core/defined-names";
import type { OpaqueSourceRelationship } from "@excel/core/opaque-part";
import type { WorkbookData } from "@excel/core/workbook-core";
import { getDefinedNames } from "@excel/core/workbook-core";
import type { WorkbookModel } from "@excel/core/workbook.browser";
import {
  addWorksheet,
  createWorkbook,
  getWorkbookModel,
  setWorkbookModel
} from "@excel/core/workbook.browser";
import type { Worksheet } from "@excel/core/worksheet";
import { ExcelFileError } from "@excel/errors";
import { setStyle, setValue } from "@excel/surface/cell";
import { setStyle as setColumnStyle, setWidth as setColumnWidth } from "@excel/surface/column";
import { setHeight as setRowHeight, setStyle as setRowStyle } from "@excel/surface/row";
import { merge } from "@excel/surface/worksheet";
import type { Alignment, Fill, Font, Protection } from "@excel/types";
import { encodeCol } from "@excel/utils/address";
import {
  attrByLocalName,
  findChildrenLocal,
  tryParseXml
} from "@excel/utils/ooxml-validator/xml-utils";
import {
  readSharedStrings,
  readWorkbookPart,
  readWorksheetPart,
  type ReadCell
} from "@excel/xlsb/read/parts";
import type { StyleTable } from "@excel/xlsb/styles";
import { readStyles } from "@excel/xlsb/styles";
import {
  collectOpaqueParts,
  groupOpaqueRelationshipsBySource,
  isRelationshipsPart,
  ownerOfRelationshipsPart
} from "@excel/xlsx/opaque-parts";
import { excelToDate, isDateFmt } from "@utils/utils";

/** What a read could not fully recover, for the caller to inspect. */
export interface XlsbReadDiagnostics {
  /** Cell records recognised but not decodable, by record name. */
  readonly unreadRecords: ReadonlyMap<string, number>;
  /**
   * Record ids this library has no name for, counted by id across every sheet.
   *
   * A non-empty map is not an error — a workbook may legitimately carry records from a newer
   * schema — but it is the only signal that the file holds something this reader passed over.
   */
  readonly unknownRecords: ReadonlyMap<number, number>;
  /** Formula expressions that could not be decoded, as `Sheet!A1`. */
  readonly undecodedFormulas: readonly string[];
  /** Cells deferring to a shared formula, which is not resolved yet. */
  readonly sharedFormulaCells: readonly string[];
  /**
   * Everything above that is an actual *loss*, as `Sheet!A1: reason` or `Sheet: reason`.
   *
   * The maps above are structured for a test to assert against; this is the list a caller is told.
   * They are not the same set, and the difference is `unknownRecords`: a record id this library has
   * no name for is usually a newer schema's extension rather than missing content — every workbook in
   * the reference corpus has some — so treating it as a loss would make `unsupported: "error"` reject
   * ordinary files and teach callers to switch it off, which is the one outcome worse than silence.
   */
  readonly lost: readonly string[];
}

const WORKBOOK_PART = "xl/workbook.bin";

/**
 * Read XLSB bytes into `workbook`, replacing its contents and returning what was lost.
 *
 * **The read happens into a workbook of this function's own, and `workbook` is only touched once it
 * has succeeded.** Both halves of that were wrong before, and both were wrong in a way a test that
 * reads into a fresh workbook cannot see:
 *
 * - It *added* to the target instead of replacing it. `Workbook.read` on a workbook that already had
 *   sheets appended new ones, kept the old defined names, and threw part-way through on a duplicate
 *   sheet name — while the XLSX path, which builds a model and applies it with `setWorkbookModel`,
 *   has always replaced. Two readers behind one public function disagreeing about what "read" means is
 *   not a defensible difference.
 * - It was not atomic. The epoch was assigned, then the names, then each sheet in turn, so a package
 *   that failed on its fourth sheet left the caller holding three sheets, a changed epoch and no
 *   error-free way to tell.
 *
 * The commit goes through `getWorkbookModel`/`setWorkbookModel` — the same pair the XLSX reader ends
 * with — rather than a hand-written field copy. That is the point: a field the pair does not carry is
 * already not carried for an XLSX read, so the two formats cannot drift apart here, and adding a field
 * to the model does not create a third place to remember.
 *
 * A field-by-field copy would be cheaper and is wrong for a reason worth recording, because it looks
 * like it would work: a worksheet holds a back-reference to the workbook that owns it, so moving the
 * `_worksheets` array across leaves every sheet pointing at the scratch workbook. `setWorkbookModel`
 * rebuilds them against the target, which is exactly the coupling a property copy would silently break.
 *
 * The measured cost of the transplant is about 50 ms on a 20,000-row, 40,000-cell workbook — 76 ms to
 * 124 ms. That is proportionate rather than free, and the comparison that settles it is the other
 * reader: XLSX reads the same data in 264 ms, and pays this same cost at the end for the same reason.
 * An XLSB read remains more than twice as fast, and it is now as difficult to leave a workbook
 * half-updated as it already was there.
 *
 * @returns Diagnostics describing what could not be recovered. Returned rather than thrown, because
 *          the decision belongs to the caller: a workbook whose cells read but whose rich text did not
 *          is still useful, and `writeXlsbBytes`'s counterpart for this is the `unsupported` option.
 */
export async function readXlsbPackage(
  workbook: WorkbookData,
  bytes: Uint8Array,
  source = "<buffer>"
): Promise<XlsbReadDiagnostics> {
  const parsed = await parseXlsbPackage(bytes, source);
  commitXlsbRead(workbook, parsed);
  return parsed.diagnostics;
}

/** A package read but not yet applied to anything. */
export interface ParsedXlsbPackage {
  readonly model: WorkbookModel;
  readonly diagnostics: XlsbReadDiagnostics;
}

/**
 * Read a package into a model, touching no caller's workbook.
 *
 * Separate from the commit so a caller can **decide before anything is applied**. That is what
 * `unsupported: "error"` needs and did not have: the check ran on the diagnostics this returns, but the
 * commit had already happened, so a rejected read still replaced the caller's workbook. A failure that
 * leaves the target modified is not a failure a caller can recover from, which is the whole reason the
 * scratch workbook exists.
 */
export async function parseXlsbPackage(
  bytes: Uint8Array,
  source = "<buffer>"
): Promise<ParsedXlsbPackage> {
  // `createWorkbook` rather than a bare object so every invariant the cell API maintains below is
  // maintained against a real workbook.
  const scratch = createWorkbook();
  const diagnostics = await readInto(scratch, bytes, source);
  return { model: getWorkbookModel(scratch), diagnostics };
}

/** Apply a parsed package, replacing whatever the workbook held. */
export function commitXlsbRead(workbook: WorkbookData, parsed: ParsedXlsbPackage): void {
  setWorkbookModel(workbook, parsed.model);
}

async function readInto(
  workbook: WorkbookData,
  bytes: Uint8Array,
  source: string
): Promise<XlsbReadDiagnostics> {
  const entries = await extractAll(bytes);

  const workbookPart = findPart(entries, WORKBOOK_PART);
  if (!workbookPart) {
    throw new ExcelFileError(
      source,
      "read",
      `not an XLSB package: no ${WORKBOOK_PART}. An XLSX package stores its workbook as XML, ` +
        `so a package without this part is not one this reader can interpret.`
    );
  }

  const {
    sheets,
    sheetNames,
    definedNames,
    namedRanges,
    namedExpressions,
    externSheets,
    date1904
  } = readWorkbookPart(workbookPart, WORKBOOK_PART);
  // Recorded on the workbook so a caller sees what the file said, and so a later write can
  // reproduce the epoch rather than silently normalising every date to 1900.
  workbook.properties = { ...workbook.properties, date1904 };

  /** Losses in the order they were found, as `Sheet!A1: reason` or `Sheet: reason`. */
  const lost: string[] = [];

  // Applied through the public `DefinedNames` surface rather than assigned to the model, for the
  // same reason cell values go through `Cell.setValue`: the invariants a caller gets are the ones
  // a read should produce. Only the user-visible names are added — the raw table also carries
  // hidden function stubs like `_xlfn.CONCAT`, which no user created.
  const names = getDefinedNames(workbook);
  for (const named of namedRanges) {
    for (const range of named.ranges) {
      definedNamesAdd(names, range, named.name);
    }
  }
  // Names whose definition is an expression rather than a reference — `=TRUE`, `=OFFSET(…)`. They cannot
  // go through `definedNamesAdd`, which takes an A1 reference and *throws* on anything else: a workbook
  // carrying one used to fail the entire read with `ColumnOutOfBoundsError: Column TRUE is out of
  // bounds`. Losing the name is a gap; failing the read is a different and worse thing.
  for (const named of namedExpressions) {
    lost.push(`${named.name}: defined name defined by an expression (${named.expression})`);
  }

  // Before the sheets, so that a malformed properties part fails the read rather than half of it.
  await readDocumentProperties(workbook, entries);

  const sharedStringsPart = findPart(entries, "xl/sharedStrings.bin");
  const readStrings = sharedStringsPart
    ? readSharedStrings(sharedStringsPart, "xl/sharedStrings.bin")
    : { texts: [], richCount: 0 };
  const sharedStrings = readStrings.texts;
  if (readStrings.richCount > 0) {
    // The text survives and its formatting runs do not — the right trade, since dropping the string
    // because it was bold would be worse. But the reader knew this and told nobody, so a workbook of
    // styled text read back as plain text with nothing said.
    lost.push(`xl/sharedStrings.bin: formatting runs on ${readStrings.richCount} rich string(s)`);
  }

  // Read before any worksheet, because a cell's style index means nothing without it.
  const stylesPart = findPart(entries, "xl/styles.bin");
  const styles = stylesPart ? readStyles(stylesPart, "xl/styles.bin") : undefined;
  // Font index 0 is what an unstyled cell inherits, so it belongs to the workbook rather than to any
  // cell format. `writeStyles` reads it back from here; without it an XLSB round trip replaced the
  // author's default with Calibri 11.
  if (styles?.defaultFont !== undefined) {
    workbook._defaultFont = styles.defaultFont;
  }

  const unreadRecords = new Map<string, number>();
  const unknownRecords = new Map<number, number>();
  const undecodedFormulas: string[] = [];
  const sharedFormulaCells: string[] = [];

  // Everything the reader did not interpret, preserved verbatim. The corpus makes the cost of not
  // doing this concrete: two workbooks carry `xl/vbaProject.bin`, one carries
  // `xl/printerSettings/`, two carry `xl/media/` and `xl/drawings/`, and **all nine** carry
  // `xl/theme/theme1.xml`. A read-modify-write silently dropped every one of them — and losing the
  // theme is not cosmetic, because a `{ theme: 1 }` colour resolves through it.
  //
  // This reuses the mechanism `xlsx/` already has rather than a second one: the drop policy (stale
  // caches, invalidated signatures), the relationship rewriting and the content-type declarations
  // are the same problem in a different container.
  const sheetParts = resolveSheetParts(
    entries,
    sheets.map(sheet => sheet.relId)
  );
  const contentTypes = readContentTypes(entries);
  const opaque = collectOpaqueParts({
    unknownEntries: opaqueCandidates(entries, interpretedPaths(sheetParts, entries)),
    contentTypeOverrides: contentTypes.overrides,
    relationshipsBySource: readRelationshipsBySource(entries)
  });
  workbook._opaqueParts = [...opaque.parts];
  workbook._opaqueDrops = [...opaque.drops];
  // Relationships declared by a *worksheet* rather than by the workbook. `picture.xlsb` reaches its
  // drawings this way, and without distributing them the drawing survives the round trip with
  // nothing pointing at it — a dangling part, which is one of the things Excel offers to repair.
  const inboundBySource = groupOpaqueRelationshipsBySource(opaque.parts);
  // Kept so a preserved part that relied on a `Default` for its extension keeps its type.
  workbook._opaqueContentTypeDefaults = contentTypes.defaults;

  sheets.forEach((sheet, index) => {
    const name = sheet.name;
    // The relationship first; the positional guess only when the file gives no usable one, which
    // keeps a package with a missing or malformed rels file readable.
    const resolved = sheetParts[index];
    const path = resolved?.path ?? `xl/worksheets/sheet${index + 1}.bin`;
    const part = findPart(entries, path);
    const worksheet = addWorksheet(workbook, name, { state: sheet.state });
    // Attached to the sheet rather than to its position, so it travels with the sheet.
    const sheetRelationships =
      resolved === undefined ? undefined : inboundBySource.get(resolved.path);
    if (sheetRelationships !== undefined && sheetRelationships.length > 0) {
      worksheet._opaqueRels = [...sheetRelationships];
    }
    if (resolved?.isChartsheet === true) {
      // Kept as an empty sheet so nothing after it shifts, and reported because the sheet the caller
      // gets back is not the sheet the file holds — writing this workbook again turns a chartsheet
      // into an ordinary one permanently.
      lost.push(`${name}: chartsheet read as an empty worksheet`);
    }
    if (!part) {
      // The workbook declares a sheet whose part is not in the package. The empty sheet keeps the
      // sheet list matching what the workbook says, which is the right repair — but it is a repair,
      // and a whole worksheet's worth of content is missing. Reported so strict mode can refuse: a
      // structural loss this large reaching the caller unremarked, while a single undecodable cell
      // did not, was the wrong way round.
      lost.push(`${name}: worksheet part is missing from the package`);
    }
    if (!part || resolved?.isChartsheet === true) {
      // A sheet declared in the workbook with no part is a broken package, which the validator
      // reports. Here it becomes an empty sheet rather than a missing one, so the sheet list
      // still matches what the workbook declares.
      //
      // A chartsheet is deliberately the same outcome: it holds a chart, not a cell grid, and
      // reading its records as though they were rows would invent cells that do not exist. The
      // sheet keeps its name and position so nothing after it shifts.
      return;
    }

    const read = readWorksheetPart(
      part,
      path,
      sharedStrings,
      // `externSheets` is what a 3D reference's `ixti` indexes; without it every cross-sheet
      // reference in this workbook silently resolves to the wrong sheet.
      { sheetNames, definedNames, externSheets },
      styles
    );
    for (const [record, count] of read.unreadRecords) {
      unreadRecords.set(record, (unreadRecords.get(record) ?? 0) + count);
    }
    for (const [id, count] of read.unknownRecords) {
      unknownRecords.set(id, (unknownRecords.get(id) ?? 0) + count);
    }
    undecodedFormulas.push(...read.undecodedFormulas.map(address => `${name}!${address}`));
    lost.push(...read.undecodedFormulas.map(address => `${name}!${address}: formula expression`));
    lost.push(...read.errorCells.map(address => `${name}!${address}: error value`));
    // Counted rather than listed: a sheet whose every cell uses an unimplemented record would
    // otherwise produce one line per cell and bury the rest of the report.
    for (const [record, count] of read.unreadRecords) {
      lost.push(`${name}: ${count} cell(s) in ${record}`);
    }

    // The drawing reference the sheet already carried. Kept on the worksheet so it travels with the
    // sheet rather than with its position, exactly as `opaqueRels` does — and so a rewrite reproduces
    // the one part of a picture that is binary. Without it the drawing XML and the media both survived
    // and the sheet pointed at neither, which is a workbook whose images have silently vanished.
    if (read.drawingRelationshipId !== undefined) {
      worksheet._xlsbDrawingRelationshipId = read.drawingRelationshipId;
    }

    // Row and column formatting go on **before** the cells, and the order is the whole point:
    // `Row.setStyle` propagates to every cell in the row, so applying it afterwards overwrites the
    // format each cell declared for itself. That inverts the format's own rule — a cell's
    // `iStyleRef` is what wins over the row's `ixfe` — and the symptom is subtle: a rotated cell in
    // a styled header row comes back with the header's alignment and no rotation.
    //
    // Applied per column rather than through `setColumns`, which takes a *positional* array:
    // handing it `{ min: 4, max: 4 }` sets the fourth entry's width on the second column. A
    // `BrtColInfo` describes an inclusive range, so each column in it is set on its own.
    for (const column of read.columns) {
      for (let index = column.min; index <= column.max; index++) {
        setColumnWidth(worksheet, index, column.widthCharacters);
        const style = styleAt(styles, column.styleIndex);
        if (style !== undefined) {
          setColumnStyle(worksheet, index, style);
        }
      }
    }
    for (const [row, index] of read.rowStyles) {
      const style = styleAt(styles, index);
      if (style !== undefined) {
        setRowStyle(worksheet, row, style);
      }
    }

    for (const cell of read.cells) {
      applyCell(worksheet, cell, name, sharedFormulaCells, date1904, styles);
    }

    // Merged after the cells, because merging clears every covered cell but the master — doing
    // it first would erase values that were about to be written.
    for (const range of read.merges) {
      merge(worksheet, range);
    }

    // After the row styles, which reset a row's height as a side effect of setting its format.
    for (const [row, height] of read.rowHeights) {
      setRowHeight(worksheet, row, height);
    }

    // Page setup and the sheet's own defaults. Merged into whatever the freshly-created worksheet
    // already holds rather than replacing it, so a field this reader does not carry keeps the
    // model's default instead of becoming undefined.
    if (read.pageSetup !== undefined || read.margins !== undefined) {
      worksheet.pageSetup = {
        ...worksheet.pageSetup,
        ...read.pageSetup,
        ...(read.margins === undefined ? {} : { margins: read.margins }),
        // `fitToWidth`/`fitToHeight` only mean anything with fit-to-page on, and the record
        // carries them unconditionally — so the flag is derived rather than read.
        ...(read.pageSetup?.fitToWidth !== undefined || read.pageSetup?.fitToHeight !== undefined
          ? { fitToPage: true }
          : {})
      };
    }
    if (read.headerFooter !== undefined) {
      worksheet.headerFooter = { ...worksheet.headerFooter, ...read.headerFooter };
    }
    if (read.formatInfo !== undefined || read.sheetProperties !== undefined) {
      worksheet.properties = {
        ...worksheet.properties,
        ...read.formatInfo,
        ...read.sheetProperties
      };
    }
  });

  lost.push(...sharedFormulaCells.map(address => `${address}: shared formula`));
  return { unreadRecords, unknownRecords, undecodedFormulas, sharedFormulaCells, lost };
}

function applyCell(
  worksheet: Worksheet,
  cell: ReadCell,
  sheetName: string,
  sharedFormulaCells: string[],
  date1904: boolean,
  styles: StyleTable | undefined
): void {
  const address = `${encodeCol(cell.column)}${cell.row + 1}`;

  if (cell.sharedFormulaOrigin) {
    // The expression lives in another cell. Recording the deferral and keeping the cached
    // value is the honest outcome: inventing the master's formula here would be a guess, and
    // dropping the cell would lose a value the file really contains.
    sharedFormulaCells.push(`${sheetName}!${address}`);
  }

  if (cell.formula !== undefined) {
    setValue(worksheet, address, {
      formula: cell.formula,
      result: asDateIfFormatted(cell.value, cell.numberFormat, date1904) ?? undefined
    });
    applyCellFormat(worksheet, address, cell, styles);
    return;
  }
  if (cell.value === null) {
    // A blank cell with a format still carries information — a formatted-but-empty cell is how
    // a template says "put a date here" — so the format is applied and the value is not.
    applyCellFormat(worksheet, address, cell, styles);
    return;
  }
  setValue(worksheet, address, asDateIfFormatted(cell.value, cell.numberFormat, date1904));
  applyCellFormat(worksheet, address, cell, styles);
}

/**
 * A serial number wearing a date format is a date.
 *
 * BIFF12 stores a date as a number and says so only through the format, exactly as XLSX does —
 * so this uses the same `isDateFmt` and `excelToDate` the XLSX cell reader uses. A second
 * opinion about which formats mean "date" would make the same workbook read back differently
 * depending on which container it arrived in, which is the one thing two readers of the same
 * document must not do.
 */
function asDateIfFormatted(
  value: string | number | boolean | null,
  numberFormat: string | undefined,
  date1904: boolean
): string | number | boolean | Date | null {
  return typeof value === "number" && numberFormat !== undefined && isDateFmt(numberFormat)
    ? excelToDate(value, date1904)
    : value;
}

/**
 * Apply the formatting a cell's `BrtXF` named.
 *
 * Applied through `Cell.setStyle` rather than assigned to the model, so the same invariants hold
 * as for a caller setting it — and so formatting that arrives for a cell with no value still
 * lands somewhere the writer will find it again.
 *
 * Written as one call rather than three because `setStyle` merges: three calls would each read
 * and rewrite the style, and the last would win on any field the earlier ones also touched.
 */
/**
 * Apply the style a cell's format index names.
 *
 * Resolved here rather than carried on the cell. `ReadCell` used to hold all five fields, which made a
 * sheet of fifty thousand cells sharing one format carry fifty thousand copies of it — of references
 * into a table the caller already has. The index is what the record contains, so the index is what
 * travels; this is where it means something.
 */
function applyCellFormat(
  worksheet: Worksheet,
  address: string,
  cell: ReadCell,
  styles: StyleTable | undefined
): void {
  const style: {
    numFmt?: string;
    font?: Partial<Font>;
    fill?: Fill;
    alignment?: Partial<Alignment>;
    protection?: Partial<Protection>;
  } = {};
  // `readStyles` already normalises `General` to undefined, so presence is the only check needed.
  if (cell.numberFormat !== undefined) {
    style.numFmt = cell.numberFormat;
  }
  const font = styles?.fonts[cell.styleIndex];
  if (font !== undefined) {
    style.font = font;
  }
  const fill = styles?.fills[cell.styleIndex];
  if (fill !== undefined) {
    style.fill = fill;
  }
  const alignment = styles?.alignments[cell.styleIndex];
  if (alignment !== undefined) {
    style.alignment = alignment;
  }
  const protection = styles?.protections[cell.styleIndex];
  if (protection !== undefined) {
    style.protection = protection;
  }
  if (Object.keys(style).length === 0) {
    return;
  }
  setStyle(worksheet, address, style);
}

/**
 * Which package part holds each sheet, resolved through `xl/_rels/workbook.bin.rels`.
 *
 * The part path used to be computed as `xl/worksheets/sheet${index + 1}.bin`, which is what a
 * writer that names its own parts produces and therefore always correct for this library's own
 * output — and wrong for real files. `any_sheets.xlsb` declares four sheets whose fourth is a
 * *chartsheet* at `xl/chartsheets/sheet1.bin`, so the numbering has a hole in it. With the
 * chartsheet last the arithmetic costs only that sheet; with one in the middle every sheet after
 * it reads the previous sheet's data, which is silent misplacement rather than a missing part.
 *
 * `BrtBundleSh` already carries the `relId`, so the mapping is available; it was simply not used.
 * Relationships are unordered in the XML, so this builds a map rather than reading positionally.
 */
function resolveSheetParts(
  entries: Awaited<ReturnType<typeof extractAll>>,
  relIds: readonly (string | undefined)[]
): (SheetPart | undefined)[] {
  const rels = findPart(entries, "xl/_rels/workbook.bin.rels");
  if (rels === undefined) {
    return relIds.map(() => undefined);
  }
  const document = tryParseXml(new TextDecoder().decode(rels), () => {
    // A malformed rels file falls back to the positional guess below, which is better than
    // reading nothing at all.
  });
  const byId = new Map<string, { target: string; type: string }>();
  if (document !== undefined) {
    for (const element of findChildrenLocal(document.root, "Relationship")) {
      const id = attrByLocalName(element, "Id");
      const target = attrByLocalName(element, "Target");
      const type = attrByLocalName(element, "Type");
      if (id !== undefined && target !== undefined && type !== undefined) {
        byId.set(id, { target, type });
      }
    }
  }
  return relIds.map(relId => {
    const rel = relId === undefined ? undefined : byId.get(relId);
    if (rel === undefined) {
      return undefined;
    }
    // Targets are relative to the owning part's directory, which is `xl/`.
    const path = rel.target.startsWith("/")
      ? rel.target.slice(1)
      : `xl/${rel.target.replace(/^\.\//, "")}`;
    return { path, isChartsheet: rel.type.endsWith("/chartsheet") };
  });
}

/** Where a declared sheet's records live, and whether it is a chartsheet rather than a grid. */
interface SheetPart {
  readonly path: string;
  readonly isChartsheet: boolean;
}

function findPart(
  entries: Awaited<ReturnType<typeof extractAll>>,
  path: string
): Uint8Array | undefined {
  const direct = entries.get(path);
  if (direct) {
    return direct.data;
  }
  // OPC part names are compared case-insensitively, and producers do vary the casing.
  const lower = path.toLowerCase();
  for (const [candidate, file] of entries) {
    if (candidate.toLowerCase() === lower) {
      return file.data;
    }
  }
  return undefined;
}

/**
 * Whether these bytes are an XLSB package.
 *
 * Looks for `xl/workbook.bin` in the ZIP *central directory* only. That is the one reliable
 * test — XLSB and XLSX are both OPC ZIP packages with the same outer shape, and which workbook
 * part is present is the distinguishing feature — and reading the directory costs O(entries)
 * rather than the O(bytes) that decompressing the package would. An earlier version used
 * `extractAll`, which inflates every part to answer a question about one file name.
 *
 * Returns false rather than throwing for input that is not a ZIP at all, so the caller falls
 * through to the XLSX loader and lets *it* produce the error: a message from a loader that
 * tried to read the file says more than one from a sniffer that declined to.
 */
export function isXlsbPackage(bytes: Uint8Array): boolean {
  try {
    return new ZipParser(bytes)
      .getEntries()
      .some(entry => entry.path.toLowerCase() === WORKBOOK_PART);
  } catch {
    return false;
  }
}

/**
 * Document properties, from the two parts that carry them.
 *
 * **Read rather than preserved, and both halves of that are deliberate.** They are excluded from the
 * opaque set because both writers *author* them from `WorkbookModel` — preserving the bytes as well
 * produced a package declaring each part twice, which Excel rejects. But excluding them from
 * preservation while never reading them meant every property was silently replaced by a fresh
 * workbook's defaults: `creator` came back as `"Unknown"`, and the title, company and dates came back
 * empty. Interpreting a part and then not interpreting it is the one combination that loses data.
 *
 * The XLSX xforms do the parsing. A second reader for `dc:creator` and friends would be a second
 * place for the same schema, and the whole point of these two parts being identical across containers
 * is that neither container needs its own opinion about them.
 */
async function readDocumentProperties(
  workbook: WorkbookData,
  entries: Awaited<ReturnType<typeof extractAll>>
): Promise<void> {
  const core = findPart(entries, "docProps/core.xml");
  const app = findPart(entries, "docProps/app.xml");
  if (core === undefined && app === undefined) {
    return;
  }
  const [{ CoreXform }, { AppXform }] = await Promise.all([
    import("@excel/xlsx/xform/core/core-xform"),
    import("@excel/xlsx/xform/core/app-xform")
  ]);
  if (core !== undefined) {
    Object.assign(workbook, (await new CoreXform().parseStream(bytesAsStream(core))) ?? {});
  }
  if (app !== undefined) {
    Object.assign(workbook, (await new AppXform().parseStream(bytesAsStream(app))) ?? {});
  }
}

/** One chunk of bytes as the async iterable `parseStream` consumes. */
async function* bytesAsStream(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * Paths this reader interpreted, and which therefore must *not* be preserved verbatim.
 *
 * Anything else in the package travels through the opaque mechanism. The list is derived from what
 * was actually read rather than from a pattern, because the sheet parts are named by their
 * relationships and a chartsheet's part does not match `worksheets/sheetN.bin`.
 */
function interpretedPaths(
  resolvedSheets: readonly (
    | { readonly path: string; readonly isChartsheet?: boolean }
    | undefined
  )[],
  entries: Awaited<ReturnType<typeof extractAll>>
): Set<string> {
  const interpreted = new Set<string>([
    "[content_types].xml",
    WORKBOOK_PART,
    "xl/sharedstrings.bin",
    "xl/styles.bin",
    // The document properties are *modelled*, by both writers, from `WorkbookModel` — so preserving
    // them verbatim as well produces a package that declares each of them twice. Reading an XLSB and
    // writing it back as XLSX made exactly that file, and Excel rejected it: a duplicate
    // `Override PartName` is a malformed content-types part rather than a redundant one.
    //
    // This is the general shape of the rule and worth stating as such: a part belongs in the opaque
    // set when *no* writer in this library authors it. Membership follows from who writes it, not
    // from which module happens to read it.
    "docprops/core.xml",
    "docprops/app.xml"
  ]);
  // Handed in rather than resolved again. Parsing `workbook.bin.rels` twice was not only wasted work:
  // it meant "the paths this reader interpreted" and "the paths this reader read" were two computations
  // that could disagree, which is the sort of difference that shows up as a part preserved *and*
  // rewritten.
  for (const resolved of resolvedSheets) {
    if (resolved !== undefined && !resolved.isChartsheet) {
      interpreted.add(resolved.path.toLowerCase());
    }
  }
  // The binary index parts are a rebuildable lookup into the sheet they accompany, not content.
  // Writing a stale one back would describe a stream this library re-serialised from scratch.
  for (const path of entries.keys()) {
    if (/binaryindex\d*\.bin$/i.test(path)) {
      interpreted.add(path.toLowerCase());
    }
  }
  return interpreted;
}

/** Bytes of every entry the reader did not interpret, keyed by path. */
function opaqueCandidates(
  entries: Awaited<ReturnType<typeof extractAll>>,
  interpreted: ReadonlySet<string>
): Map<string, Uint8Array> {
  const candidates = new Map<string, Uint8Array>();
  for (const [path, file] of entries) {
    if (!interpreted.has(path.toLowerCase())) {
      candidates.set(path, file.data);
    }
  }
  return candidates;
}

/**
 * Content types from `[Content_Types].xml`.
 *
 * Both halves are needed. A part with an `Override` carries its type directly; a part with none
 * relies on the `Default` for its extension, and dropping those would leave a preserved image with
 * no declared type at all — which is a package Excel rejects rather than repairs.
 */
function readContentTypes(entries: Awaited<ReturnType<typeof extractAll>>): {
  overrides: Map<string, string>;
  defaults: Record<string, string>;
} {
  const overrides = new Map<string, string>();
  const defaults: Record<string, string> = {};
  const part = findPart(entries, "[Content_Types].xml");
  if (part === undefined) {
    return { overrides, defaults };
  }
  const document = tryParseXml(new TextDecoder().decode(part), () => {
    // A malformed content-types part costs the declarations, not the workbook.
  });
  if (document === undefined) {
    return { overrides, defaults };
  }
  for (const element of findChildrenLocal(document.root, "Override")) {
    const name = attrByLocalName(element, "PartName");
    const contentType = attrByLocalName(element, "ContentType");
    if (name !== undefined && contentType !== undefined) {
      overrides.set(name.replace(/^\//, ""), contentType);
    }
  }
  for (const element of findChildrenLocal(document.root, "Default")) {
    const extension = attrByLocalName(element, "Extension");
    const contentType = attrByLocalName(element, "ContentType");
    if (extension !== undefined && contentType !== undefined) {
      defaults[extension.toLowerCase()] = contentType;
    }
  }
  return { overrides, defaults };
}

/** Every `.rels` file in the package, parsed, keyed by the part that declares it. */
function readRelationshipsBySource(
  entries: Awaited<ReturnType<typeof extractAll>>
): Map<string, OpaqueSourceRelationship[]> {
  const bySource = new Map<string, OpaqueSourceRelationship[]>();
  for (const [path, file] of entries) {
    if (!isRelationshipsPart(path)) {
      continue;
    }
    const owner = ownerOfRelationshipsPart(path);
    if (owner === undefined) {
      continue;
    }
    const document = tryParseXml(new TextDecoder().decode(file.data), () => {
      // A malformed rels file costs its relationships, not the workbook.
    });
    if (document === undefined) {
      continue;
    }
    const relationships: OpaqueSourceRelationship[] = [];
    for (const element of findChildrenLocal(document.root, "Relationship")) {
      const id = attrByLocalName(element, "Id");
      const type = attrByLocalName(element, "Type");
      const target = attrByLocalName(element, "Target");
      if (id === undefined || type === undefined || target === undefined) {
        continue;
      }
      const targetMode = attrByLocalName(element, "TargetMode");
      relationships.push({
        id,
        type,
        target,
        source: owner,
        ...(targetMode === undefined ? {} : { targetMode })
      });
    }
    bySource.set(owner, relationships);
  }
  return bySource;
}

/**
 * The style a cell-format index names, in the model's shape.
 *
 * Shared by the row and the column paths, which reference their format the same way a cell does —
 * through an index into the same table.
 */
function styleAt(
  styles: StyleTable | undefined,
  index: number | undefined
):
  | {
      numFmt?: string;
      font?: Partial<Font>;
      fill?: Fill;
      alignment?: Partial<Alignment>;
      protection?: Partial<Protection>;
    }
  | undefined {
  // No check for index 0 here. `readStyles` already collapses a zero `iFmt`/`iFont`/`iFill` to
  // "no format", so a second copy of that policy in this function was unreachable — and two places
  // encoding one rule is how they come to disagree.
  if (styles === undefined || index === undefined) {
    return undefined;
  }
  const style = {
    ...(styles.numberFormats[index] === undefined ? {} : { numFmt: styles.numberFormats[index] }),
    ...(styles.fonts[index] === undefined ? {} : { font: styles.fonts[index] }),
    ...(styles.fills[index] === undefined ? {} : { fill: styles.fills[index] }),
    ...(styles.alignments[index] === undefined ? {} : { alignment: styles.alignments[index] }),
    ...(styles.protections[index] === undefined ? {} : { protection: styles.protections[index] })
  };
  return Object.keys(style).length === 0 ? undefined : style;
}
