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
import { cellGetValue, cellSetNote } from "@excel/core/cell";
import { dataValidationAdd } from "@excel/core/data-validations";
// The public cell surface, on purpose: setting a value through it is what keeps dimensions,
// row materialisation and shared-string bookkeeping consistent.
import { definedNamesAdd } from "@excel/core/defined-names";
import type { OpaqueSourceRelationship } from "@excel/core/opaque-part";
import { applyPrintName, isPrintName, type PrintSetup } from "@excel/core/print-names";
import { createTable, tableSetModel, type TableModel } from "@excel/core/table";
import type { WorkbookData } from "@excel/core/workbook-core";
import {
  addWorkbookImage,
  defineCellStyle,
  getDefinedNames,
  getWorksheets
} from "@excel/core/workbook-core";
import type { WorkbookModel } from "@excel/core/workbook.browser";
import {
  addWorksheet,
  createWorkbook,
  getWorkbookModel,
  setWorkbookModel
} from "@excel/core/workbook.browser";
import {
  addBackgroundImage,
  getColumn as worksheetColumn,
  getRow as worksheetRow,
  setHeaderFooterImage
} from "@excel/core/worksheet";
import type { Worksheet } from "@excel/core/worksheet";
import { getCell, type WorksheetData } from "@excel/core/worksheet-core";
import { ExcelFileError, XlsbFormulaDecodeError } from "@excel/errors";
import { getValue, setStyle, setValue } from "@excel/surface/cell";
import { setStyle as setColumnStyle, setWidth as setColumnWidth } from "@excel/surface/column";
import { setHeight as setRowHeight, setStyle as setRowStyle } from "@excel/surface/row";
import { merge } from "@excel/surface/worksheet";
import type { Alignment, Borders, Fill, Font, Protection } from "@excel/types";
import { decodeRange, encodeCol } from "@excel/utils/address";
import {
  attrByLocalName,
  findChildrenLocal,
  tryParseXml
} from "@excel/utils/ooxml-validator/xml-utils";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { readCommentsPart } from "@excel/xlsb/comments";
import { modelHash } from "@excel/xlsb/model-hash";
import {
  readSharedStrings,
  readWorkbookPart,
  readWorksheetPart,
  type ReadCell
} from "@excel/xlsb/read/parts";
import { recordSpec } from "@excel/xlsb/spec/records";
import type { StyleTable } from "@excel/xlsb/styles";
import { readStyles } from "@excel/xlsb/styles";
import { readTablePart } from "@excel/xlsb/tables";
import {
  collectOpaqueParts,
  groupOpaqueRelationshipsBySource,
  isRelationshipsPart,
  ownerOfRelationshipsPart,
  resolveRelationshipTarget
} from "@excel/xlsx/opaque-parts";
import { RelType } from "@excel/xlsx/rel-type";
import {
  parsePersonList,
  parseThreadedComments
} from "@excel/xlsx/xform/comment/threaded-comments-xform";
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
  /**
   * Cells whose expression was deliberately not decoded, as `Sheet!A1`.
   *
   * Non-empty only under `formulas: "cached"`, and *not* a loss report: the caller asked for the cached value. Kept
   * separate from {@link undecodedFormulas} for exactly that reason — merging them would make a deliberate choice
   * indistinguishable from a failure.
   */
  readonly cachedOnlyFormulas: readonly string[];
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
  /**
   * The package's own bytes, when the caller may want them back verbatim.
   *
   * Absent when the read cannot support that — a collapsed blank-cell read is still exact, but a caller who asked
   * for a *partial* read would get a package that no longer matches its model.
   */
  readonly source?: Uint8Array;
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
/**
 * How an XLSB read treats things the model can hold more than one way.
 */
export interface XlsbReadOptions {
  /**
   * What to do with cells that carry formatting and no value.
   *
   * - `"keep"` (the default) gives each one a cell in the model, which is what every reader here has always done
   *   and what a caller iterating cells expects.
   * - `"collapse"` accumulates them into rectangles instead. Excel writes a `BrtCellBlank` for every cell that
   *   carries formatting past the data, so a sheet with a formatted column has one per row to the sheet's end:
   *   measured at 169.7 MB of retained heap for 322,520 such records against 253 rows of actual data.
   *
   * **`"collapse"` is lossless for XLSB, which is the point of the name.** The rectangles describe exactly the
   * records they came from, so writing the workbook back reproduces them and nothing is owed to a fidelity
   * report. Writing a collapsed read as *XLSX* does drop the blank formatting — and **it does not currently say so**:
   * this used to claim the `unsupported` channel carried it, and that channel does not exist on the XLSX write path.
   * `Workbook.toBuffer(..., { format: "xlsx", unsupported: "error" })` accepts the option and never consults it, so the
   * only writer that reports losses is the XLSB one. Stated here rather than left as an inaccurate promise; the same gap
   * is why a chartsheet read from XLSB and written as XLSX becomes an empty worksheet silently.
   */
  readonly blankCells?: "keep" | "collapse";
  /**
   * What to do with a formula cell's expression.
   *
   * A formula cell in XLSB carries two things: the value Excel last computed, and the token stream that computed it.
   * The value always decodes — it is a number, a string or an error in a fixed layout. The token stream is where the
   * format is genuinely hard, and where this codec can be defeated by a construct it has not met.
   *
   * The three answers differ in what happens then, and a caller has a real stake in the choice:
   *
   * - `"preserve"` (the default) decodes what it can and keeps the cached value where it cannot, listing the address
   *   under `diagnostics.undecodedFormulas`. Nothing is invented and nothing throws, which is what a caller opening
   *   an arbitrary file wants; the cost is that the loss is only visible to someone who reads the diagnostics.
   * - `"cached"` does not decode expressions at all. Every formula cell becomes its cached value, and the addresses
   *   are listed under `diagnostics.cachedOnlyFormulas`. Choose it to extract numbers from a large workbook without
   *   paying for token decoding, or when a computed value from Excel is worth more than an expression from this
   *   library. Writing such a read back therefore emits literals, and the fidelity report says so.
   * - `"error"` throws {@link XlsbFormulaDecodeError} on the first expression it cannot decode. Choose it when a
   *   dropped formula is a corrupt result rather than a degraded one — a pipeline recalculating the workbook gets a
   *   failure it can act on instead of a silently constant cell.
   *
   * The default is `"preserve"` because it is what this reader has always done, so the option adds a choice without
   * changing an existing caller's behaviour.
   */
  readonly formulas?: "preserve" | "cached" | "error";
}

export async function parseXlsbPackage(
  bytes: Uint8Array,
  source = "<buffer>",
  options: XlsbReadOptions = {}
): Promise<ParsedXlsbPackage> {
  // `createWorkbook` rather than a bare object so every invariant the cell API maintains below is
  // maintained against a real workbook.
  const scratch = createWorkbook();
  const diagnostics = await readInto(scratch, bytes, source, options);
  // **A lossy read keeps no passthrough source.**
  //
  // `_xlsbSource` lets an unchanged workbook be written back as the bytes it arrived as, and the argument for that is
  // that `writeXlsbPackage` is a function of the model — so an unchanged model would produce equivalent bytes anyway,
  // and the original merely carries the imperfectly-modelled parts more faithfully.
  //
  // `formulas: "cached"` breaks that premise: it deliberately drops every expression, so the model is *no longer*
  // equivalent to the package it came from. Keeping the source made a `cached` read write its formulas straight back —
  // nine of them, byte for byte — while the documented behaviour is to emit literals. Worse, one unrelated edit would
  // flip it, so the output's semantics depended on whether anything else had been touched.
  //
  // `blankCells: "collapse"` is *not* lossy in this container and keeps its source: the rectangles reproduce the
  // records they came from exactly, which is what the option's name promises and what `passthrough.node.test.ts` pins.
  const lossyRead = options.formulas === "cached";
  return {
    model: getWorkbookModel(scratch),
    diagnostics,
    ...(lossyRead ? {} : { source: bytes })
  };
}

/** Apply a parsed package, replacing whatever the workbook held. */
export function commitXlsbRead(workbook: WorkbookData, parsed: ParsedXlsbPackage): void {
  setWorkbookModel(workbook, parsed.model);
  // **The bytes this workbook arrived as, and what its model hashed to at that moment.**
  //
  // Kept so that writing it back *unchanged* can return the original package instead of rebuilding one. That is not
  // a shortcut: `writeXlsbPackage` is a function of the model, so an unchanged model would produce equivalent bytes
  // anyway — but the original also carries the parts this library models imperfectly exactly as Excel wrote them,
  // which no rebuild can promise. Charts, macros, pivot caches and anything not yet understood survive a
  // read-and-write untouched.
  //
  // A hash rather than a copy of the model: the workbook this matters most for is the large one, and doubling it to
  // detect a change is the wrong trade. See `modelHash` for why the walk is generic.
  if (parsed.source !== undefined) {
    (workbook as unknown as { _xlsbSource?: { bytes: Uint8Array; hash: Uint8Array } })._xlsbSource =
      {
        bytes: parsed.source,
        hash: modelHash(parsed.model)
      };
  }
}

async function readInto(
  workbook: WorkbookData,
  bytes: Uint8Array,
  source: string,
  options: XlsbReadOptions
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
    undefinedNames,
    externSheets,
    malformedSheets,
    date1904,
    calcProperties,
    bookViews,
    bookProtection,
    pivotCaches
  } = readWorkbookPart(workbookPart, WORKBOOK_PART);
  // Recorded on the workbook so a caller sees what the file said, and so a later write can
  // reproduce the epoch rather than silently normalising every date to 1900.
  workbook.properties = { ...workbook.properties, date1904 };
  if (calcProperties !== undefined) {
    workbook.calcProperties = { ...workbook.calcProperties, ...calcProperties };
  }
  if (bookViews !== undefined && bookViews.length > 0) {
    workbook.views = bookViews as never;
  }
  // The cache bindings. Carried on the workbook rather than turned into `pivotTables`, because the parts they
  // point at are opaque bytes and this reader does not model a pivot table — the binding is the one piece
  // that lives in a *rebuilt* part and would otherwise be dropped, leaving a cache definition nothing
  // announces.
  if (pivotCaches !== undefined && pivotCaches.length > 0) {
    // Each binding's own part path, resolved through the workbook's relationships — see
    // `PivotCacheBinding.definitionPath`. Without it the writer had to pair bindings with preserved parts by array
    // position, and ZIP order is not the order `workbook.bin` declares them in.
    const relationships = workbookRelationships(entries);
    (workbook as unknown as { _xlsbPivotCaches?: unknown })._xlsbPivotCaches = pivotCaches.map(
      binding => {
        const resolved = relationships.get(binding.relationshipId);
        return resolved === undefined
          ? binding
          : { ...binding, definitionPath: resolved.path.toLowerCase() };
      }
    );
  }
  // The workbook-level author list a threaded comment's `personId` points at. Read before the sheets,
  // because a comment without it is attributed to nobody.
  const personPart = findPart(entries, "xl/persons/person.xml");
  if (personPart !== undefined) {
    const persons = parsePersonList(new TextDecoder().decode(personPart));
    if (persons.length > 0) {
      // Assigned rather than passed through `registerPerson`, and that is the point: the setter mints a
      // *new* GUID, while a threaded comment's `personId` names the one in the file. Registering them
      // would leave every comment pointing at an id no person carries — attributed to nobody, which is
      // the outcome reading the part at all was meant to prevent.
      (workbook as unknown as { _persons: unknown[] })._persons = persons;
    }
  }
  if (bookProtection !== undefined) {
    workbook.protection = bookProtection as never;
  }

  /** Losses in the order they were found, as `Sheet!A1: reason` or `Sheet: reason`. */
  const lost: string[] = [];

  // Applied through the public `DefinedNames` surface rather than assigned to the model, for the
  // same reason cell values go through `Cell.setValue`: the invariants a caller gets are the ones
  // a read should produce. Only the user-visible names are added — the raw table also carries
  // hidden function stubs like `_xlfn.CONCAT`, which no user created.
  const names = getDefinedNames(workbook);
  /** `_xlnm.*` names, applied after the sheets exist. */
  const printNames: { name: string; ranges: readonly string[]; localSheetId?: number }[] = [];
  for (const named of namedRanges) {
    // `_xlnm.Print_Area` and `_xlnm.Print_Titles` are not user-visible names — they are how Excel stores
    // a sheet's print area and print titles, in XLSX and XLSB alike. Adding them as ordinary names would
    // put `_xlnm.Print_Area` in a caller's name list *and* leave `pageSetup.printArea` empty, so the
    // feature would look absent while the artefact of it was visible.
    if (isPrintName(named.name)) {
      // Deferred, not applied here: the sheets do not exist yet — they are created further down, from
      // the workbook's own sheet table — so `getWorksheets` is empty at this point and every print area
      // silently went nowhere. Collected now, applied once the sheets are there.
      printNames.push(named);
      continue;
    }
    for (const range of named.ranges) {
      definedNamesAdd(names, range, named.name);
    }
  }
  // Names whose definition is an expression rather than a reference — `=TRUE`, `=OFFSET(…)`. They cannot
  // go through `definedNamesAdd`, which takes an A1 reference and *throws* on anything else: a workbook
  // carrying one used to fail the entire read with `ColumnOutOfBoundsError: Column TRUE is out of
  // bounds`. Losing the name is a gap; failing the read is a different and worse thing.
  for (const position of malformedSheets) {
    lost.push(`sheet ${position}: the workbook's record for it could not be decoded`);
  }
  for (const named of namedExpressions) {
    lost.push(`${named.name}: defined name defined by an expression (${named.expression})`);
  }
  // A name whose record defines nothing. It cannot enter the model — `definedNamesAdd` needs a reference and there is
  // none — but it was leaving without a word, and a formula that names one loses its expression on the way back out.
  for (const name of undefinedNames) {
    lost.push(`${name}: defined name with no definition`);
  }

  // Before the sheets, so that a malformed properties part fails the read rather than half of it.
  await readDocumentProperties(workbook, entries);

  const sharedStringsPart = findPart(entries, "xl/sharedStrings.bin");
  const readStrings = sharedStringsPart
    ? readSharedStrings(sharedStringsPart, "xl/sharedStrings.bin")
    : { texts: [], runs: new Map(), richCount: 0 };
  const sharedStrings = readStrings.texts;
  if (readStrings.richCount > 0) {
    // What is left after the runs are read: an entry whose trailing bytes are not formatting runs — phonetic
    // data, or a record longer than the shape it declares. The text survives and whatever those bytes meant
    // does not, which is still worth naming.
    lost.push(
      `xl/sharedStrings.bin: unreadable trailing bytes on ${readStrings.richCount} string(s)`
    );
  }

  // Read before any worksheet, because a cell's style index means nothing without it.
  const stylesPart = findPart(entries, "xl/styles.bin");
  const styles = stylesPart ? readStyles(stylesPart, "xl/styles.bin") : undefined;
  // Named cell styles, through the public setter so that the name validation and the `_cellStyles` map
  // a caller reads are both the ones a fresh definition would produce.
  for (const named of styles?.namedStyles ?? []) {
    const { name, ...facets } = named;
    defineCellStyle(workbook, name, facets as never);
  }
  // Font index 0 is what an unstyled cell inherits, so it belongs to the workbook rather than to any
  // cell format. `writeStyles` reads it back from here; without it an XLSB round trip replaced the
  // author's default with Calibri 11.
  if (styles?.defaultFont !== undefined) {
    workbook._defaultFont = styles.defaultFont;
  }

  const unreadRecords = new Map<string, number>();
  const unknownRecords = new Map<number, number>();
  const undecodedFormulas: string[] = [];
  const cachedOnlyFormulas: string[] = [];
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
  // Every `.rels` in the package, kept rather than consumed. `collectOpaqueParts` only records the
  // relationships that reach a *preserved part*, which by construction excludes every external one — and
  // a hyperlink's destination is an external relationship. So the sheet-level lookup below reads from
  // here instead of from the opaque graph.
  const relationshipsBySource = readRelationshipsBySource(entries);
  // **A VML drawing whose notes are parsed is regenerated, so it must not also be preserved.**
  //
  // A note needs two parts: the text, and a legacy VML drawing that gives it a box. The text is parsed here and both
  // writers compose the VML again from it — at the same path the original used. Keeping the original as well left the
  // sheet with *two* `vmlDrawing` relationships pointing at one path, and since the XLSX reader builds a note from
  // the shape it finds there, three of `poi-comments.xlsb`'s four notes came back as nothing after a conversion.
  //
  // This is the other half of a defect fixed earlier in this reader: a part that is parsed must not be preserved.
  // The comments part was caught then; the drawing that renders it was not, because nothing reads it — and "nothing
  // reads it" was the wrong test. The right one is "a writer here authors it".
  //
  // Decided from the relationships rather than from the parsed notes, because the opaque set is collected before any
  // sheet is read. A sheet with a `Comments` relationship will have its notes parsed, which is all this needs to
  // know — and a sheet *without* one keeps its VML untouched, which is what leaves a form control's drawing alone.
  const regeneratedVml = new Set<string>();
  for (const [source, relationships] of relationshipsBySource) {
    if (!relationships.some(relationship => relationship.type === RelType.Comments)) {
      continue;
    }
    for (const relationship of relationships) {
      if (relationship.type !== RelType.VmlDrawing) {
        continue;
      }
      const target = resolveRelationshipTarget(
        source,
        relationship.target,
        relationship.targetMode
      );
      if (target !== undefined) {
        regeneratedVml.add(target.toLowerCase());
      }
    }
  }
  const opaque = collectOpaqueParts({
    unknownEntries: opaqueCandidates(
      entries,
      interpretedPaths(sheetParts, entries, regeneratedVml)
    ),
    contentTypeOverrides: contentTypes.overrides,
    relationshipsBySource
  });
  workbook._opaqueParts = [...opaque.parts];
  workbook._opaqueDrops = [...opaque.drops];
  // Relationships declared by a *worksheet* rather than by the workbook. `picture.xlsb` reaches its
  // drawings this way, and without distributing them the drawing survives the round trip with
  // nothing pointing at it — a dangling part, which is one of the things Excel offers to repair.
  const inboundBySource = groupOpaqueRelationshipsBySource(opaque.parts);
  // Kept so a preserved part that relied on a `Default` for its extension keeps its type.
  workbook._opaqueContentTypeDefaults = contentTypes.defaults;

  // Tables, read ahead of the sheets. A `PtgList` in *any* sheet's formula names a table by its `idList`,
  // and resolving it back to a name and a column needs the table definitions — which live in their own
  // parts, reached from the sheets. So they are collected first rather than as each sheet is walked,
  // because a formula on sheet 1 may reference a table on sheet 3.
  const tableContext = new Map<string, { id: number; columns: readonly string[]; sheet: string }>();
  for (const [index] of sheets.entries()) {
    const sheetPath = sheetParts[index]?.path ?? `xl/worksheets/sheet${index + 1}.bin`;
    for (const relationship of relationshipsBySource.get(sheetPath) ?? []) {
      if (relationship.type !== RelType.Table) {
        continue;
      }
      const target = resolveRelationshipTarget(
        sheetPath,
        relationship.target,
        relationship.targetMode
      );
      const bytes = target === undefined ? undefined : findPart(entries, target);
      const table =
        bytes === undefined
          ? undefined
          : readTablePart(bytes, target!, iterateInterpretableRecords, id => recordSpec(id)?.name);
      if (table !== undefined) {
        tableContext.set(table.name, {
          id: table.id,
          columns: table.columns.map(column => column.name),
          // The sheet the table is on — what a `PtgList`'s `ixti` names. Unused on the read side, where
          // `listIndex` locates the table on its own, but the context is shared with the writer and a
          // read-modify-write re-encodes these formulas.
          sheet: sheets[index]?.name ?? `Sheet${index + 1}`
        });
      }
    }
  }

  // `for…of` rather than `forEach`, because the header/footer VML has to be parsed and the xform's
  // parser is async. A `forEach` callback cannot await, so the images were written and never read.
  for (const [index, sheet] of sheets.entries()) {
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
      // gets back is not the sheet the file holds.
      //
      // **Why this is a placeholder and not a `ChartsheetModel`, having been weighed.** `readChartsheetPart` exists and
      // would give the zoom, the selection and the drawing relationship. What it cannot give is the chart, because this
      // reader does not model charts at all: `chartEntries` comes back empty for every XLSB, and the chart, its
      // drawing, its style and colour parts are preserved as opaque bytes. A `ChartsheetModel` names its chart through
      // `chartNumber`/`chartExNumber`, indices into that empty collection — so a real chartsheet here needs either a
      // chart reader for BIFF12 packages, or a new model form for "a chartsheet backed by an opaque drawing".
      //
      // What the placeholder costs, measured on `cal-any_sheets.xlsb`, is bounded: an XLSB→XLSB round trip keeps the
      // chartsheet exactly (the package is byte-identical when unmodified, and the bundle points at the preserved part
      // when it is not), while an XLSB→XLSX conversion turns the tab into an empty worksheet and reports it. The chart,
      // drawing, style and colour parts still travel — they are container-neutral — so the chart data is not destroyed;
      // it is unreferenced. The one part that must *not* travel is the `.bin` sheet itself, which
      // `isForeignSheetPart` drops with its own reason.
      //
      // A caller editing this placeholder is the sharp edge: it is an ordinary worksheet on the public surface, and the
      // XLSB writer skips it, so cells written into it are discarded. That is the strongest argument for doing the
      // larger piece of work, and it is why this comment records the decision rather than only the mechanism.
      lost.push(`${name}: chartsheet read as an empty worksheet`);
      // Marked so the writer does not give the placeholder a part of its own. The chartsheet's real part is preserved
      // and reachable; without this, writing the workbook back emitted both and left one declared sheet with two
      // relationship targets — see `WorksheetData._chartsheetPlaceholder`.
      worksheet._chartsheetPlaceholder = resolved.path;
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
      // `continue`, not `return`: this is a loop now, and returning would end the whole read.
      continue;
    }

    const read = readWorksheetPart(
      part,
      path,
      sharedStrings,
      // `externSheets` is what a 3D reference's `ixti` indexes; without it every cross-sheet
      // reference in this workbook silently resolves to the wrong sheet.
      { sheetNames, definedNames, externSheets, tables: tableContext },
      styles,
      // The formatting runs read off the shared-string table, so a cell pointing at a styled entry can be
      // given its `richText` back. Read once for the workbook and handed to every sheet.
      readStrings.runs,
      options.blankCells === "collapse",
      options.formulas === "cached" ? "cached" : "preserve"
    );
    // **`"error"` is enforced per sheet, as soon as that sheet is read.** Checking the accumulated diagnostics at the
    // end would work, but it would first build the whole workbook the caller has just said they do not want, and the
    // sheet name is in hand here — the aggregate list would have to be re-split to name it.
    if (options.formulas === "error" && read.undecodedFormulas.length > 0) {
      throw new XlsbFormulaDecodeError(name, read.undecodedFormulas, source);
    }
    for (const [record, count] of read.unreadRecords) {
      unreadRecords.set(record, (unreadRecords.get(record) ?? 0) + count);
    }
    for (const [id, count] of read.unknownRecords) {
      unknownRecords.set(id, (unknownRecords.get(id) ?? 0) + count);
    }
    undecodedFormulas.push(...read.undecodedFormulas.map(address => `${name}!${address}`));
    cachedOnlyFormulas.push(...read.cachedOnlyFormulas.map(address => `${name}!${address}`));
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
        // Hidden, grouped, collapsed and best-fit, plus whether the width was the author's. Only the width
        // and the style used to come back, so a hidden column returned as an ordinary one — and the next
        // write then had nothing to write, which is how "hidden column" stayed on the loss list while the
        // record's own field had room for it all along.
        const target = worksheetColumn(worksheet, index) as unknown as Record<string, unknown>;
        if (column.customWidth === false) {
          target.isCustomWidth = false;
        }
        if (column.hidden === true) {
          target.hidden = true;
        }
        if (column.bestFit === true) {
          target.bestFit = true;
        }
        if (column.outlineLevel !== undefined) {
          target.outlineLevel = column.outlineLevel;
        }
        if (column.collapsed === true) {
          target.collapsed = true;
        }
      }
    }
    for (const [row, index] of read.rowStyles) {
      const style = styleAt(styles, index);
      if (style !== undefined) {
        setRowStyle(worksheet, row, style);
      }
    }

    // **Which masters are array masters, before any follower is applied.** A follower's own record says only
    // "the formula lives at this address"; whether that address holds a `BrtArrFmla` or a `BrtShrFmla` decides
    // what the follower *is*, and the two are not the same thing in the model.
    //
    // A shared follower is a cell with its own formula, spelled as a reference to the master — which is what the
    // XLSX reader produces for the same cell. A cell inside a multi-cell array formula is not: XLSX gives it a
    // value and no formula, because it is one cell of one formula rather than a formula of its own. Treating
    // them alike made an XLSB read back with six formulas the XLSX did not have.
    //
    // Nothing is lost by dropping them: the master carries `shareType: "array"` and the `ref` its range covers,
    // and the writer regenerates every covered cell from exactly that.
    const arrayMasters = new Set(
      read.cells
        .filter(cell => cell.shareType === "array")
        .map(cell => `${cell.row}:${cell.column}`)
    );
    for (const cell of read.cells) {
      applyCell(worksheet, cell, name, sharedFormulaCells, date1904, styles, arrayMasters);
    }

    // Sparklines. Assigned onto the sheet so the next write emits them again: the records were written
    // correctly, came back absent from the model, and were deleted by the second write with the loss report
    // saying nothing — the writer was handed a model that genuinely had none. This was the last entry in
    // `read-write-symmetry.test.ts`'s `LOSES_ON_READ`.
    // **The collapsed blanks, with their style resolved once per rectangle.**
    //
    // Assigned onto the sheet the way sparklines are, so the next write emits the same records and the collapse
    // costs nothing in fidelity. The style is assembled here rather than carried as an index because the writer
    // works in style objects — and doing it per rectangle rather than per cell is the whole saving: one object for
    // a formatted column instead of one per row.
    if (read.styledBlanks.length > 0) {
      (worksheet as unknown as { _styledBlankRanges: unknown[] })._styledBlankRanges =
        read.styledBlanks.map(range => ({
          firstRow: range.firstRow,
          lastRow: range.lastRow,
          firstColumn: range.firstColumn,
          lastColumn: range.lastColumn,
          style: styleAt(styles, range.styleIndex)
        }));
    }

    if (read.sparklineGroups.length > 0) {
      // Assigned onto the sheet so the next write emits them again. This is `_sparklineGroups`, the field
      // `Worksheet.getModel` reads — the public `sparklineGroups` name is a *model* field, and setting it on a
      // live sheet creates a property nothing looks at.
      (worksheet as unknown as { _sparklineGroups: unknown[] })._sparklineGroups = [
        ...read.sparklineGroups
      ];
    }

    // Conditional formatting. Assigned onto the sheet the way the XLSX reader does, so a caller cannot tell
    // which container the workbook came from — and so the next write emits them again. Without this the
    // records were written once, came back absent from the model, and were deleted by the second write with
    // the loss report saying nothing, because the writer was handed a model that genuinely had none.
    if (read.conditionalFormattings !== undefined && read.conditionalFormattings.length > 0) {
      (worksheet as unknown as { conditionalFormattings?: unknown[] }).conditionalFormattings =
        read.conditionalFormattings.map(block => ({
          ...block,
          // `dxfId` resolved to the style it names, and dropped afterwards: the model's rule holds a `style`,
          // and leaving the index behind would be a field nothing reads pointing into a table that is rebuilt
          // from scratch on the next write.
          rules: block.rules.map(rule => {
            const { dxfId, ...rest } = rule as { dxfId?: number };
            const style = dxfId === undefined ? undefined : styles?.dxfs[dxfId];
            return style === undefined ? rest : { ...rest, style };
          })
        }));
    }

    // Data validations. The model keys them by address, so a record covering a range expands back to one
    // entry per range reference — the same shape the XLSX reader produces, so a caller cannot tell which
    // container the workbook came out of.
    if (read.validations.length > 0) {
      // Through `dataValidationAdd` rather than by assigning the map: the handle holds a
      // `DataValidationsData` wrapper, not a bare record, and the setter owns the key convention that
      // distinguishes a range (`range:A1:B2`) from a single address. Writing the record directly put a
      // plain object where the wrapper belonged, and the validations vanished on the next `getModel`,
      // which reads `.model` off it.
      for (const validation of read.validations) {
        for (const reference of validation.ranges) {
          dataValidationAdd(worksheet.dataValidations, reference, validation.rule);
        }
      }
    }

    // Panes and page breaks, both applied through the worksheet model rather than a setter, because
    // neither has one: a view is a whole object the sheet replaces, and the break arrays are read
    // straight off it.
    //
    // The pane and the view settings live in the *same* model view, so they are merged rather than
    // assigned in turn — writing the pane and then the settings replaced the array and lost the pane.
    if (read.pane !== undefined) {
      const pane = read.pane;
      worksheet.views = [
        {
          // The first view's settings, because the pane belongs to it. Later views are added below.
          ...(read.viewSettings[0] ?? {}),
          state: pane.frozen ? "frozen" : "split",
          // Crossed on purpose — see `xlsb/pane.ts`. The record counts rows first; the model calls that
          // `ySplit`.
          xSplit: pane.columns,
          ySplit: pane.rows,
          topLeftCell: `${encodeCol(pane.leftColumn)}${pane.topRow + 1}`,
          activePane: pane.activePane
        } as never
      ];
    } else if (read.viewSettings.some(view => Object.keys(view).length > 0)) {
      // No pane, but the sheet still departs from the default view in some way.
      worksheet.views = read.viewSettings.map(view => ({ state: "normal", ...view })) as never;
    }
    // Views beyond the first, which carry no pane. Appended rather than replacing, so a frozen sheet's
    // pane survives alongside them.
    if (read.viewSettings.length > 1 && worksheet.views !== undefined) {
      worksheet.views = [
        worksheet.views[0],
        ...read.viewSettings.slice(1).map(view => ({ state: "normal", ...view }))
      ] as never;
    }
    if (read.rowBreaks.length > 0) {
      worksheet.rowBreaks = [...read.rowBreaks] as never;
    }
    if (read.columnBreaks.length > 0) {
      worksheet.colBreaks = [...read.columnBreaks] as never;
    }

    if (read.sheetProtectionSettings !== undefined) {
      worksheet.sheetProtection = read.sheetProtectionSettings as never;
    }

    // Threaded comments. The part is XML in both containers — there is no BIFF12 form — so this is the
    // XLSX parser applied to a part found through the relationship type, not a translation.
    const threadedRel = (relationshipsBySource.get(path) ?? []).find(
      entry => entry.type === RelType.ThreadedComments
    );
    if (threadedRel !== undefined) {
      const target = resolveRelationshipTarget(path, threadedRel.target, threadedRel.targetMode);
      const bytes = target === undefined ? undefined : findPart(entries, target);
      if (bytes !== undefined) {
        const parsed = parseThreadedComments(new TextDecoder().decode(bytes));
        if (parsed.length > 0) {
          worksheet.threadedComments = parsed as never;
        }
      }
    }

    // Header, footer and watermark pictures. `BrtLegacyDrawingHF` names the VML, the VML names the images
    // through its *own* relationships, and the geometry — which corner, how big — is in the VML shapes.
    // So all three have to be read together; the record alone says only that they exist.
    if (read.headerFooterRelationshipId !== undefined) {
      const relationship = (relationshipsBySource.get(path) ?? []).find(
        entry => entry.id === read.headerFooterRelationshipId
      );
      const vmlTarget =
        relationship === undefined
          ? undefined
          : resolveRelationshipTarget(path, relationship.target, relationship.targetMode);
      const vmlBytes = vmlTarget === undefined ? undefined : findPart(entries, vmlTarget);
      if (vmlBytes !== undefined) {
        const { VmlDrawingXform } = await import("@excel/xlsx/xform/drawing/vml-drawing-xform");
        // Through the same xform the XLSX reader uses. `parseStream` takes an async iterable, and the
        // bytes are already in hand — so a one-chunk iterable is the adapter, rather than a second VML
        // parser appearing here.
        const shapes = await new VmlDrawingXform().parseStream(
          (async function* () {
            yield new TextDecoder().decode(vmlBytes);
          })()
        );
        const byRelId = new Map(
          (relationshipsBySource.get(vmlTarget!) ?? []).map(entry => [entry.id, entry])
        );
        for (const shape of shapes?.headerImages ?? []) {
          const imageRel = byRelId.get(String(shape.imageRelId));
          const imageTarget =
            imageRel === undefined
              ? undefined
              : resolveRelationshipTarget(vmlTarget!, imageRel.target, imageRel.targetMode);
          const imageBytes = imageTarget === undefined ? undefined : findPart(entries, imageTarget);
          if (imageBytes === undefined) {
            lost.push(`${name}: header image, whose part the package does not contain`);
            continue;
          }
          const imageId = addWorkbookImage(workbook, {
            buffer: imageBytes,
            extension: (imageTarget!.split(".").pop() ?? "png").toLowerCase()
          } as never);
          setHeaderFooterImage(worksheet, {
            imageId,
            position: shape.position,
            ...(shape.width === undefined ? {} : { width: shape.width }),
            ...(shape.height === undefined ? {} : { height: shape.height })
          } as never);
        }
      }
    }

    // A background image. `BrtBkHim` names the relationship; the medium behind it has already been read
    // as an opaque part, so the workbook-level image has to be registered and the sheet pointed at it.
    if (read.backgroundRelationshipId !== undefined) {
      const relationship = (relationshipsBySource.get(path) ?? []).find(
        entry => entry.id === read.backgroundRelationshipId
      );
      const target =
        relationship === undefined
          ? undefined
          : resolveRelationshipTarget(path, relationship.target, relationship.targetMode);
      const bytes = target === undefined ? undefined : findPart(entries, target);
      if (bytes !== undefined) {
        const extension = (target!.split(".").pop() ?? "png").toLowerCase();
        const imageId = addWorkbookImage(workbook, {
          buffer: bytes,
          extension
        } as never);
        addBackgroundImage(worksheet, imageId as never);
      } else {
        lost.push(`${name}: background image, whose part the package does not contain`);
      }
    }

    if (read.autoFilter !== undefined) {
      worksheet.autoFilter = read.autoFilter as never;
      // The criteria, rebuilt into the same raw-XML field the XLSX reader fills. Assigning it here means a
      // workbook read from XLSB and written to XLSX carries its criteria through the path that already
      // works, and that a second XLSB write emits the records again instead of dropping them.
      if (read.autoFilterCriteriaXml !== undefined) {
        (worksheet as unknown as { _autoFilterCriteria?: unknown })._autoFilterCriteria = {
          ref: read.autoFilter,
          xml: read.autoFilterCriteriaXml
        };
      }
    }
    if (read.ignoredErrors.length > 0) {
      worksheet.ignoredErrors = [...read.ignoredErrors] as never;
    }

    // Tables, one part each, found through the relationship type — nothing in the worksheet's record
    // stream names them, so the relationship is the only link there is.
    const tableRels = (relationshipsBySource.get(path) ?? []).filter(
      relationship => relationship.type === RelType.Table
    );
    if (tableRels.length > 0) {
      const found: unknown[] = [];
      for (const relationship of tableRels) {
        const target = resolveRelationshipTarget(
          path,
          relationship.target,
          relationship.targetMode
        );
        const tablePart = target === undefined ? undefined : findPart(entries, target);
        if (tablePart === undefined) {
          continue;
        }
        const table = readTablePart(
          tablePart,
          target!,
          iterateInterpretableRecords,
          id => recordSpec(id)?.name
        );
        if (table !== undefined) {
          // `id` is the workbook-unique `idList`, reassigned on the next write, so it does not travel
          // into the model — a model carrying it would let two workbooks merged by a caller collide.
          const { id: _id, ...rest } = table;
          void _id;
          // A table's *data* lives in the worksheet's own cells rather than in the table part, which
          // MS-XLSB 2.1.7.51 states directly — so the rows are read back off the cells that were
          // already applied above.
          //
          // **They cannot be left empty.** `tableSetModel` treats a model with fewer rows than the
          // sheet as a table that has *shrunk* and blanks the difference, so handing it `rows: []`
          // deleted every cell in the data region. The parity suite caught exactly that: seven cells
          // across two committed fixtures came back empty through XLSB and correct through XLSX.
          found.push({
            ...rest,
            rows: tableDataRows(
              worksheet,
              rest.ref,
              rest.headerRow !== false,
              rest.totalsRow === true
            )
          });
        }
      }
      // Through `createTable` and `tableSetModel`, keyed by name — the handle holds a
      // `Record<name, TableData>`, not the model's array, and the name also has to be registered with
      // the workbook so a second table cannot take it. Assigning the array put an array where a record
      // belonged and `setModel` then threw reading `.name` off an index.
      for (const model of found as TableModel[]) {
        const handle = createTable(worksheet, model);
        tableSetModel(handle, model);
        (worksheet.tables as Record<string, unknown>)[model.name] = handle;
      }
    }

    // Comments. The sheet's `BrtLegacyDrawing` names the VML, not the comments part — that one is reached
    // implicitly, exactly as `poi-comments.xlsb` does it: its `rId3` targets `../comments1.bin` and no
    // record refers to it. So the part is found through the relationship *type* rather than through an id
    // some record supplied.
    const commentsRel = (relationshipsBySource.get(path) ?? []).find(
      relationship => relationship.type === RelType.Comments
    );
    if (commentsRel !== undefined) {
      const target = resolveRelationshipTarget(path, commentsRel.target, commentsRel.targetMode);
      const commentsPart = target === undefined ? undefined : findPart(entries, target);
      if (commentsPart !== undefined) {
        for (const comment of readCommentsPart(
          commentsPart,
          target!,
          iterateInterpretableRecords,
          id => recordSpec(id)?.name
        )) {
          // Through the cell rather than the model: a note is attached to a `CellData`, and the setter
          // owns the default margins, protection and `editAs` block that Excel expects alongside the
          // text. Assigning `comment` directly would produce a note Excel renders without a box.
          const cell = getCell(worksheet, comment.ref);
          cellSetNote(cell, { texts: [...comment.texts] });
        }
      }
    }

    // Hyperlinks. `BrtHLink` names a relationship, not a URL: the destination is a
    // `TargetMode="External"` entry in the sheet's own `.rels`, so the record and the relationships have
    // to be resolved together. Applied after the cells, because a hyperlink upgrades a cell's value in
    // place and there has to be a value to upgrade.
    if (read.hyperlinks.length > 0) {
      const targets = new Map(
        (relationshipsBySource.get(path) ?? []).map(relationship => [
          relationship.id,
          relationship.target
        ])
      );
      for (const link of read.hyperlinks) {
        // **An internal link is recovered, not reported.**
        //
        // An empty `relId` means the destination is inside this workbook and `location` says where — which is a legal
        // `BrtHLink`, not a malformed one. This treated the two the same: an absent relationship *and* a deliberate
        // absence of one both fell into the loss branch, so `#Linked!A1` was written correctly by this library and then
        // dropped on the way back in. The model's form for it is the `#`-prefixed fragment, which is exactly what the
        // XLSX reader produces and what `core/hyperlink.ts` recognises.
        //
        // The two cases are now distinguished: no relationship *and* no location is a link with no destination at all,
        // which stays a loss.
        const internal = link.relId === "" && link.location !== "";
        const target = internal
          ? `#${link.location}`
          : link.relId === ""
            ? undefined
            : targets.get(link.relId);
        if (target === undefined) {
          lost.push(
            `${name}!${encodeCol(link.ref.firstColumn)}${link.ref.firstRow + 1}: ` +
              (link.relId === ""
                ? "hyperlink with no destination"
                : `hyperlink relationship ${link.relId}, which the sheet does not declare`)
          );
          continue;
        }
        // A hyperlink applies to a *range*; the model holds one per cell. The cell's existing text is
        // kept as the link's display text, which is what `Cell.getValue` returns for a hyperlink cell —
        // replacing it with the URL would show the address where the label belongs.
        for (let row = link.ref.firstRow; row <= link.ref.lastRow; row++) {
          for (let column = link.ref.firstColumn; column <= link.ref.lastColumn; column++) {
            const address = `${encodeCol(column)}${row + 1}`;
            const existing = getValue(worksheet, address);
            // The label is whatever the cell already said. When it said nothing the *destination* becomes
            // the label, which is both what Excel displays for an unlabelled link and what the cell model
            // requires: `Cell.setValue` only classifies a value as a hyperlink when it carries non-empty
            // text, so `{ text: "", hyperlink }` is stored as a plain object and `getHyperlink` returns
            // nothing. An earlier version wrote `String(existing ?? target)` instead, which stringified a
            // *non-string* value — a link over a number came back labelled with that number, and one over
            // an already-linked cell with the JSON of its own value.
            const label = typeof existing === "string" && existing !== "" ? existing : target;
            setValue(worksheet, address, {
              text: label,
              hyperlink: target,
              ...(link.tooltip === "" ? {} : { tooltip: link.tooltip })
            } as never);
          }
        }
      }
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
    // Hidden, grouped and collapsed rows. `setHidden` exists on the row surface; `outlineLevel` and
    // `collapsed` are plain fields with no setter, so all three go through the row object rather than one
    // going one way and two the other.
    for (const [row, settings] of read.rowSettings) {
      const target = worksheetRow(worksheet, row) as unknown as Record<string, unknown>;
      if (settings.outlineLevel !== undefined) {
        target.outlineLevel = settings.outlineLevel;
      }
      if (settings.collapsed === true) {
        target.collapsed = true;
      }
      if (settings.hidden === true) {
        target.hidden = true;
      }
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
  }

  // Print areas and print titles, now that the sheets exist. They arrived as `_xlnm.*` defined names
  // and `localSheetId` indexes the sheet order — the same order the writer numbered them in.
  const readSheets = getWorksheets(workbook);
  for (const named of printNames) {
    const worksheet = readSheets[named.localSheetId ?? -1];
    if (worksheet === undefined) {
      lost.push(`${named.name}: names a sheet the workbook does not have`);
      continue;
    }
    const setup = (worksheet.pageSetup ?? {}) as PrintSetup;
    applyPrintName(setup, named.name, named.ranges);
    worksheet.pageSetup = setup as never;
  }

  lost.push(...sharedFormulaCells.map(address => `${address}: shared formula`));
  return {
    unreadRecords,
    unknownRecords,
    undecodedFormulas,
    cachedOnlyFormulas,
    sharedFormulaCells,
    lost
  };
}

function applyCell(
  worksheet: Worksheet,
  cell: ReadCell,
  sheetName: string,
  sharedFormulaCells: string[],
  date1904: boolean,
  styles: StyleTable | undefined,
  /** Cells holding a `BrtArrFmla`, keyed `row:column` — see the call site. */
  arrayMasters: ReadonlySet<string> = new Set()
): void {
  const address = `${encodeCol(cell.column)}${cell.row + 1}`;

  if (
    cell.sharedFormulaOrigin !== undefined &&
    arrayMasters.has(`${cell.sharedFormulaOrigin.row}:${cell.sharedFormulaOrigin.column}`)
  ) {
    // **One cell of a multi-cell array formula: a value, and no formula of its own.**
    //
    // A shared follower is a cell with its own formula, spelled as the master's address — which is what the XLSX
    // reader produces for the same cell. A cell inside an array's range is not: it is one cell of one formula, and
    // XLSX gives it a bare `<v>`. Treating the two alike gave an XLSB read back six formulas the XLSX did not
    // have.
    //
    // Note the asymmetry this leaves, because it is the format's and not a defect here: XLSB *requires* a
    // forwarding record in every cell an array's range covers — omitting them makes Excel crash rather than
    // repair — while XLSX carries only the cells the author actually filled. So an XLSB written from a model
    // whose array range has gaps contains cells the XLSX does not, and `parity.node.test.ts` names that case.
    setValue(
      worksheet,
      address,
      (asDateIfFormatted(cell.value, cell.numberFormat, date1904) ?? cell.value) as never
    );
    applyCellFormat(worksheet, address, cell, styles);
    return;
  }
  if (cell.sharedFormulaOrigin) {
    // **A real follower, with the master's address.** This used to only *record* the deferral — a loss
    // entry and a bare cached value — on the grounds that "inventing the master's formula here would be a
    // guess". It is not a guess: `sharedFormula` is exactly this field in the model, spelled as an address,
    // and it is what the XLSX reader produces for the same cell. Recording it as a loss meant a workbook
    // read from XLSB and written back lost the sharing and kept only the numbers.
    setValue(worksheet, address, {
      sharedFormula: `${encodeCol(cell.sharedFormulaOrigin.column)}${cell.sharedFormulaOrigin.row + 1}`,
      result: asDateIfFormatted(cell.value, cell.numberFormat, date1904) ?? undefined
    } as never);
    applyCellFormat(worksheet, address, cell, styles);
    return;
  }

  // Rich text: the runs travel in `value`, which is what the model's rich-text shape is. Placed before the
  // formula branch because a rich string is never a formula's result, and before the plain-value branch
  // because `value` there is the flattened text — writing it would silently drop the formatting again.
  if (cell.richText !== undefined) {
    setValue(worksheet, address, { richText: cell.richText } as never);
    applyCellFormat(worksheet, address, cell, styles);
    return;
  }

  // An error value, which the model nests inside `value` as `{ error }`.
  //
  // **A formula's cached error goes in `result`, and writing it beside `formula` loses it.** The claim here used to be
  // that such a cell "keeps both: the expression and the error it currently evaluates to", and the shape below was
  // `{ formula, error }` — which the cell model does not recognise. Measured: `Cell.setValue` on `{ formula: "1/0",
  // error: "#DIV/0!" }` reads back as `{ formula: "1/0" }`, the error silently gone, while `{ formula: "1/0", result:
  // { error: "#DIV/0!" } }` round-trips intact through both containers. The XLSX reader has always produced the second
  // form, so this was also the two readers disagreeing about one model.
  //
  // Found by `verify:xlsb-corpus` once its fingerprint could see cell values at all: `poi-bug66682`'s `test2!C7` held
  // `#DIV/0!` and came back as a formula with no result, then rebuilt to a cached `0`.
  if (cell.isError === true && typeof cell.value === "string") {
    setValue(
      worksheet,
      address,
      (cell.formula === undefined
        ? { error: cell.value }
        : { formula: cell.formula, result: { error: cell.value } }) as never
    );
    applyCellFormat(worksheet, address, cell, styles);
    return;
  }

  if (cell.formula !== undefined) {
    setValue(worksheet, address, {
      formula: cell.formula,
      result: asDateIfFormatted(cell.value, cell.numberFormat, date1904) ?? undefined,
      // The master of a filled range: the kind and the range come from the `BrtShrFmla`/`BrtArrFmla` that
      // followed it, and both are what the XLSX reader puts on such a cell.
      ...(cell.shareType === undefined ? {} : { shareType: cell.shareType }),
      ...(cell.ref === undefined ? {} : { ref: cell.ref })
    } as never);
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
  // **Built on `styleAt`, which serves rows and columns, so the facet list exists once.**
  //
  // These were two parallel lists of the same six facets in the same order, kept in step by hand — and the comment that
  // used to sit here recorded what that costs: "adding a facet to one and not the other is exactly how borders came back
  // on a row and not on a cell". That had already happened. A convention plus a parity suite is a weaker guarantee than
  // not having two lists.
  //
  // The one real difference is where the number format comes from. `styleAt` reads it from the style table by index,
  // which is right for a row or a column; a *cell* carries an already-resolved `numberFormat` — the reader put it there —
  // and that takes precedence. `readStyles` normalises `General` to undefined, so presence is the only check needed.
  const indexed = styleAt(styles, cell.styleIndex);
  const style = {
    ...indexed,
    ...(cell.numberFormat === undefined ? {} : { numFmt: cell.numberFormat })
  };
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
/**
 * The workbook's own relationship table, by id.
 *
 * Extracted because two callers need it and each parsing it separately is how they would come to disagree about what an
 * id points at — the sheet resolver, and the pivot-cache bindings that have to be reconnected on a rewrite.
 */
function workbookRelationships(
  entries: Awaited<ReturnType<typeof extractAll>>
): ReadonlyMap<string, { readonly path: string; readonly type: string }> {
  const rels = findPart(entries, "xl/_rels/workbook.bin.rels");
  const byId = new Map<string, { path: string; type: string }>();
  if (rels === undefined) {
    return byId;
  }
  const document = tryParseXml(new TextDecoder().decode(rels), () => {
    // A malformed rels file leaves the map empty; each caller has its own fallback, which is better than reading
    // nothing at all.
  });
  if (document === undefined) {
    return byId;
  }
  for (const element of findChildrenLocal(document.root, "Relationship")) {
    const id = attrByLocalName(element, "Id");
    const target = attrByLocalName(element, "Target");
    const type = attrByLocalName(element, "Type");
    if (id === undefined || target === undefined || type === undefined) {
      continue;
    }
    // Targets are relative to the owning part's directory, which is `xl/`.
    byId.set(id, {
      path: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`,
      type
    });
  }
  return byId;
}

function resolveSheetParts(
  entries: Awaited<ReturnType<typeof extractAll>>,
  relIds: readonly (string | undefined)[]
): (SheetPart | undefined)[] {
  const byId = workbookRelationships(entries);
  return relIds.map(relId => {
    const rel = relId === undefined ? undefined : byId.get(relId);
    if (rel === undefined) {
      return undefined;
    }
    return { path: rel.path, isChartsheet: rel.type.endsWith("/chartsheet") };
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
  entries: Awaited<ReturnType<typeof extractAll>>,
  /** Legacy VML drawings a writer here will compose again — see the call site. */
  regeneratedVml: ReadonlySet<string> = new Set()
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
  // **The *effective* path, including the positional fallback the read itself uses.**
  //
  // This marked a sheet interpreted only when its relationship resolved. But the read falls back to
  // `xl/worksheets/sheetN.bin` when the workbook's `BrtBundleSh` cannot be decoded — and then reads the part, models it,
  // and left it in the opaque set. `poi-Simple.xlsb` is that file: all three of its sheet records are undecodable, so all
  // three parts were preserved *and* rewritten, and the writer reported `written twice, one copy dropped` for each.
  //
  // Which is precisely the failure the comment above this loop warns about — "two computations that could disagree" — so
  // the fix is to stop computing it twice. `resolvedSheets` now carries the path the read will use, resolved or not.
  for (const resolved of resolvedSheets) {
    if (resolved !== undefined && !resolved.isChartsheet) {
      interpreted.add(resolved.path.toLowerCase());
    }
  }
  for (const [index, resolved] of resolvedSheets.entries()) {
    // A sheet whose relationship did not resolve is still read, from the conventional path. A chartsheet is the one kind
    // that is *not* interpreted — it is preserved — and an unresolved sheet cannot be identified as one, which is the
    // same assumption the read makes when it treats it as a worksheet.
    if (resolved === undefined) {
      interpreted.add(`xl/worksheets/sheet${index + 1}.bin`);
    }
  }
  // The binary index parts are a rebuildable lookup into the sheet they accompany, not content.
  // Writing a stale one back would describe a stream this library re-serialised from scratch.
  for (const path of entries.keys()) {
    if (/binaryindex\d*\.bin$/i.test(path)) {
      interpreted.add(path.toLowerCase());
    }
  }
  // **The parts this reader parses**, by the rule stated above rather than by a second list of names. See
  // `PARSED_PART` for why this is narrower than "parts a writer here can author" — a first attempt used the
  // wider rule and broke the theme and pivot-table preservation guarantees.
  //
  // Note the asymmetry this closes. The *XLSX* reader never had the problem, because it does not put a part it
  // interprets into the opaque set — so the two containers disagreed about what "preserved" means, which is the
  // shape of defect this module has produced most often.
  for (const path of entries.keys()) {
    if (PARSED_PART.test(path) || regeneratedVml.has(path.toLowerCase())) {
      interpreted.add(path.toLowerCase());
    }
  }
  return interpreted;
}

/**
 * Paths this *reader* parses into the model, so preserving them as well would describe one thing twice.
 *
 * The distinction that matters — and that a first attempt at this got wrong — is between "a writer here can
 * author this part" and "this reader turned it into model state". Only the second belongs here:
 *
 * - **Comments and threaded comments** are parsed (`readCommentsPart`, the threaded-comments xform), so the next
 *   write composes them from the model. Keeping the original too produced a package with both `comments1.xml`
 *   and `comments1.bin`, with the sheet's relationship pointing at the `.bin` — seventeen example workbooks came
 *   out that way, and the self-check reported it as `rels-type-target-mismatch` rather than as duplication.
 * - **A theme and a pivot table are not**, even though writers here can produce both. An XLSB theme is preserved
 *   verbatim and the built-in one stands down for it; a pivot table read from an XLSB is carried through as
 *   opaque parts because the binary cache is kept rather than rebuilt. Excluding them broke exactly the tests
 *   that exist to pin those guarantees, which is the right outcome for a rule applied too widely.
 *
 * Everything else — `xl/media/*`, VML, `docProps/custom.xml`, a VBA project, printer settings — passes through
 * because nothing reads it either.
 */
const PARSED_PART = /^xl\/(?:comments\d*\.(?:bin|xml)|threadedComments\/)/i;

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
      border?: Partial<Borders>;
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
    ...(styles.borders[index] === undefined ? {} : { border: styles.borders[index] }),
    ...(styles.alignments[index] === undefined ? {} : { alignment: styles.alignments[index] }),
    ...(styles.protections[index] === undefined ? {} : { protection: styles.protections[index] })
  };
  return Object.keys(style).length === 0 ? undefined : style;
}

/**
 * A table's data rows, read off the cells already applied to the sheet.
 *
 * A table's *data* lives in the worksheet's own cells rather than in the table part — MS-XLSB 2.1.7.51
 * says so directly — so this recovers what the record stream never carried.
 *
 * **The rows cannot be left empty.** `tableSetModel` treats a model with fewer rows than the sheet as a
 * table that has *shrunk* and blanks the difference, so handing it `rows: []` deleted every cell in the
 * data region. The parity suite caught precisely that: seven cells across two committed fixtures came
 * back empty through XLSB and correct through XLSX.
 *
 * The header and totals rows are both excluded, because the model's `rows` is the data region alone.
 * Including either makes the table taller than it is on the next write.
 */
function tableDataRows(
  worksheet: WorksheetData,
  ref: string,
  hasHeader: boolean,
  hasTotals: boolean
): unknown[][] {
  let decoded;
  try {
    decoded = decodeRange(ref);
  } catch {
    return [];
  }
  const rows: unknown[][] = [];
  // Neither the header nor the totals row is data. MS-XLSB 2.4.100 puts it the same way: the range's
  // height MUST exceed `crwHeader + crwTotals`, so the data region is what is left between them.
  // Including the totals row made the table one row taller on the next write and stamped a second totals
  // row over the cells below it — which is what the parity suite reported as `Foo!A16, Foo!B16`.
  const last = decoded.e.r - (hasTotals ? 1 : 0);
  for (let row = decoded.s.r + (hasHeader ? 1 : 0); row <= last; row++) {
    const cells: unknown[] = [];
    for (let column = decoded.s.c; column <= decoded.e.c; column++) {
      cells.push(cellGetValue(getCell(worksheet, row + 1, column + 1)) ?? null);
    }
    rows.push(cells);
  }
  return rows;
}
