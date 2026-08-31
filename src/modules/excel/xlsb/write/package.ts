/**
 * Assemble an XLSB package.
 *
 * The binary parts come from `workbook.ts`, `worksheet.ts` and `shared-strings.ts`; everything else in
 * the package is XML and is exactly the same XML an XLSX has. The relationship and content-type
 * writers are therefore reused rather than reimplemented — OPC is not the part of this that is
 * specific to XLSB, and a second relationships writer would be a second place for the same bug.
 *
 * What *is* specific: the workbook part is `xl/workbook.bin`, and its content type
 * declares a binary workbook. Getting that pair wrong is the fastest way to a package
 * Excel refuses, which is why `check-package.ts` looks at exactly those two things.
 *
 * This module owns the decisions that need to see the whole package at once, and each of them was a
 * bug first: what a drawing or a medium may be *named* (a preserved part may already hold the name),
 * which relationship ids are free (a preserved relationship may already hold `rId1`), and which
 * extensions this writer declares itself (a preserved part relying on a conflicting `Default` needs an
 * `Override`). None of those questions can be answered by a part writer looking at one sheet.
 */

import { ZipArchive } from "@archive/zip";
import type {
  OpaquePart,
  OpaqueRelationship,
  OpaqueSourceRelationship
} from "@excel/core/opaque-part";
import type { WorkbookModel } from "@excel/core/workbook.browser";
import type { HeaderFooter, Margins } from "@excel/types";
import {
  buildDrawingAnchorsAndRels,
  isExternalImage,
  type DrawingAnchor,
  type DrawingRel,
  type ImageMedium,
  type MediaLike
} from "@excel/utils/drawing-utils";
import {
  drawingPath,
  drawingRelTargetFromWorksheet,
  drawingRelsPath,
  mediaPath,
  themePath
} from "@excel/utils/ooxml-paths";
import type { ReadPageSetup, SheetFormatInfo } from "@excel/xlsb/page-setup";
import type { SheetProperties } from "@excel/xlsb/sheet-properties";
import { CellFormatTable, writeStyles } from "@excel/xlsb/styles";
import { workbookLosses, worksheetLosses } from "@excel/xlsb/write/losses";
import {
  columnsFromModel,
  mergesFromModel,
  sheetRowsFromModel
} from "@excel/xlsb/write/model-adapter";
import { SharedStringTable, writeSharedStrings } from "@excel/xlsb/write/shared-strings";
import { writeWorkbookPart } from "@excel/xlsb/write/workbook";
import { writeWorksheetPart } from "@excel/xlsb/write/worksheet";
import {
  appendOpaqueSourceRelationships,
  opaqueContentTypeDeclarations,
  relationshipsPathFor,
  resolveReachableOpaqueParts,
  resolveRelationshipTarget
} from "@excel/xlsx/opaque-parts";
import { RelType } from "@excel/xlsx/rel-type";
import { AppXform } from "@excel/xlsx/xform/core/app-xform";
import { CoreXform } from "@excel/xlsx/xform/core/core-xform";
import { RelationshipsXform } from "@excel/xlsx/xform/core/relationships-xform";
import { readFileBytes } from "@utils/fs";
import { base64ToUint8Array } from "@utils/utils.base";
import { XmlWriter } from "@xml/writer";

/** Content type for a binary workbook part. */
const WORKBOOK_PART = "xl/workbook.bin";
const WORKBOOK_CONTENT_TYPE = "application/vnd.ms-excel.sheet.binary.macroEnabled.main";
const WORKSHEET_CONTENT_TYPE = "application/vnd.ms-excel.worksheet";
const SHARED_STRINGS_CONTENT_TYPE = "application/vnd.ms-excel.sharedStrings";
const STYLES_CONTENT_TYPE = "application/vnd.ms-excel.styles";

const OFFICE_DOCUMENT_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const WORKSHEET_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const SHARED_STRINGS_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings";
const STYLES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";

export interface XlsbWriteResult {
  readonly bytes: Uint8Array;
  /**
   * Cell values that could not be expressed, as addresses.
   *
   * Returned rather than thrown or ignored: this writer covers strings, numbers,
   * booleans, dates and blanks, and a caller handed a formula needs to know it was
   * dropped. Silently omitting them is the failure mode that makes a converter
   * untrustworthy; failing outright would make the writer unusable before formulas
   * exist.
   */
  readonly unsupported: readonly string[];
}

export async function writeXlsbPackage(model: WorkbookModel): Promise<XlsbWriteResult> {
  const strings = new SharedStringTable();
  const formats = new CellFormatTable();
  const unsupported: string[] = [];

  const worksheets = model.worksheets ?? [];
  // Read once and threaded through, because both the workbook part and every date serial depend
  // on it. A mismatch between the two would produce a file whose declared epoch disagrees with
  // its own numbers.
  const date1904 = model.properties?.date1904 === true;
  /** Drawing parts, accumulated as the sheets are visited and written afterwards. */
  const drawings: DrawingPart[] = [];

  // Paths preserved parts already occupy. Consulted before this writer names a drawing or a medium,
  // because a name that collides with a preserved part produces two entries for one path.
  const reservedPaths = new Set((model.opaqueParts ?? []).map(part => part.path.toLowerCase()));
  // Images: resolved once, before anything references them, and without touching the caller's model.
  const media = await planMedia(model, reservedPaths);
  unsupported.push(...media.losses);
  /** Collected per sheet, then qualified with the sheet name alongside the other sheet-level losses. */
  const drawingLosses: string[] = [];
  // The theme, which a `{ theme: n }` colour resolves through. An XLSB *read* keeps it as an opaque part
  // — so it survived a same-format round trip and nothing noticed — but an XLSX read **models** it, and
  // this writer looked only at the opaque set. So every XLSX→XLSB conversion produced a package whose
  // cells still carried theme indices and whose theme part was gone, which is a workbook Excel renders in
  // different colours. Modelled themes are written here; a preserved one stays in `opaqueParts`.
  const themes = themeParts(model, reservedPaths);
  // Formulas name sheets and defined names by index, so the context has to be built before
  // any worksheet is serialised — a formula in sheet 1 may reference sheet 3.
  const definedNames = model.definedNames ?? [];
  const formulaContext = {
    sheetNames: worksheets.map((worksheet, index) => worksheet.name ?? `Sheet${index + 1}`),
    definedNames: definedNames.map(defined => defined.name),
    // The identity table `writeWorkbookPart` emits. Stated here rather than left implicit so the
    // encoder resolves an `ixti` against the same table the file will carry — if the two ever
    // disagree, every 3D reference in the output points at the wrong sheet.
    //
    // **Mutable on purpose.** A reference across a span of sheets has no identity entry, so the encoder
    // appends one; the worksheets are serialised before the workbook part, so an entry added while a
    // formula is being encoded still reaches the file. Freezing this would mean narrowing such a
    // reference to its first sheet, which is what it used to do.
    externSheets: worksheets.map((_worksheet, index) => ({ first: index, last: index }))
  };

  const sheetParts = worksheets.map((worksheet, index) => {
    const sheetName = worksheet.name ?? `sheet${index + 1}`;
    // Images. The drawing part and the media are XML and bytes respectively, both shared with the
    // XLSX path; the only binary part is a `BrtDrawing` naming the relationship. Built before the
    // sheet is serialised because the record has to go inside it.
    const drawing = drawingForWorksheet(
      worksheet,
      media.named,
      index,
      drawings,
      reservedPaths,
      media.usable,
      drawingLosses
    );
    const merges = mergesFromModel(worksheet);
    const written = writeWorksheetPart({
      rows: sheetRowsFromModel(worksheet, date1904),
      strings,
      formulaContext,
      formats,
      merges: merges.ranges,
      columns: columnsFromModel(worksheet),
      ...sheetOptionsFromModel(worksheet),
      // A modelled drawing wins; otherwise the reference the sheet arrived with is re-emitted. That
      // second case is a read-modify-write of a workbook whose pictures this reader keeps as opaque
      // parts: the drawing XML and the media survive on their own, and this record is the only thing
      // connecting the sheet to them. Omitting it produced a package that passed every structural check
      // and opened in Excel with no pictures.
      ...drawingReference(worksheet, drawing)
    });
    // Qualified with the sheet name here, because the part writer works on one sheet and has
    // no name to use.
    unsupported.push(...written.unsupported.map(entry => `${sheetName}!${entry}`));
    unsupported.push(...merges.unsupported.map(entry => `${sheetName}!${entry}`));
    // Features the sheet carries that no record here emits. Scanned rather than reported by the
    // record writers, because nothing in them touches these fields — an unwritten feature leaves no
    // trace in the code that does not write it.
    unsupported.push(...worksheetLosses(worksheet).map(entry => `${sheetName}: ${entry}`));
    unsupported.push(...drawingLosses.splice(0).map(entry => `${sheetName}: ${entry}`));
    return {
      path: `xl/worksheets/sheet${index + 1}.bin`,
      bytes: written.bytes,
      // Relationships this sheet declares to preserved parts — a drawing, a picture. Carried here
      // because the sheet's part path is decided here, and a `.rels` file has to sit beside it.
      opaqueRels: worksheet.opaqueRels ?? [],
      ...(drawing === undefined ? {} : { drawing })
    };
  });

  // Both are written after the worksheets, because the worksheets are what filled them in.
  const sharedStrings = strings.texts.length > 0 ? writeSharedStrings(strings) : undefined;
  // Always, as Excel does. Omitting it for a workbook that uses only the default format looked like
  // restraint and was not: every cell record carries a style index, and a package where those
  // indices point at a table that is not present is one Excel declines to open.
  const styles = writeStyles(formats, model.defaultFont);

  // Parts the reader preserved verbatim — the theme, media, drawings, a VBA project. Filtered to
  // the ones still reachable, so deleting a sheet that pointed at a drawing does not leave the
  // drawing behind with nothing referencing it.
  const opaqueParts = reachableOpaqueParts(model, sheetParts);
  // Extensions this writer declares itself. A preserved part that relied on a conflicting
  // `Default` for one of these needs an `Override` instead, or this writer's value silently
  // reclassifies it — `bin` matters here in a way it does not for XLSX, because the workbook part
  // is declared through it.
  const reservedExtensions = new Map<string, string>([
    // `bin` is this writer's own, and the comment above said so while the map left it out. A
    // preserved part named `*.bin` that relied on a different `Default` was therefore reclassified as
    // a binary workbook part without the promotion to an `Override` that exists to prevent exactly
    // that.
    ["bin", WORKBOOK_CONTENT_TYPE],
    ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
    ["xml", "application/xml"],
    // The image extensions are declared below as `Default`s too, so they belong here for the same
    // reason — and this is the set the XLSX writer already reserves.
    ...media.contentTypes
  ]);
  const opaqueDeclarations = opaqueContentTypeDeclarations(
    opaqueParts,
    model.opaqueContentTypeDefaults,
    reservedExtensions
  );

  const archive = new ZipArchive();
  archive.add(
    "[Content_Types].xml",
    contentTypes(
      sheetParts.map(part => part.path),
      sharedStrings !== undefined,
      styles !== undefined,
      opaqueDeclarations,
      // Image extensions get a `Default`, the way Excel declares them, and each drawing part an
      // `Override`. A part with neither is one the package does not describe, which Excel rejects.
      media.contentTypes,
      drawings.map(drawing => drawingPath(drawing.name)),
      themes.map(theme => theme.path)
    )
  );
  const rootRels = [
    { Id: "rId1", Type: OFFICE_DOCUMENT_REL, Target: "xl/workbook.bin" },
    {
      Id: "rId2",
      Type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
      Target: "docProps/core.xml"
    },
    {
      Id: "rId3",
      Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
      Target: "docProps/app.xml"
    }
  ];
  // A preserved part reached from the *package root* rather than from the workbook — `docProps/
  // custom.xml` is the common one — needs its relationship carried across as well. Only the workbook's
  // were, so `reachableOpaqueParts` kept such a part (it counts every inbound edge the model holds)
  // and then nothing pointed at it: an orphan, which is exactly the state the reachability filter
  // exists to avoid. The XLSX writer has always appended both; this is the same call with the root's
  // empty source name.
  appendOpaqueSourceRelationships(rootRels, opaqueParts, "");
  archive.add("_rels/.rels", relationships(rootRels));
  // Reused from the XLSX path rather than hand-written: the two documents are identical whichever
  // container they travel in, and a second serialiser would be a second thing to drift.
  archive.add("docProps/core.xml", renderXform(new CoreXform(), model));
  archive.add("docProps/app.xml", renderXform(new AppXform(), model));

  const workbookRels = sheetParts.map((part, index) => ({
    Id: `rId${index + 1}`,
    Type: WORKSHEET_REL,
    Target: `worksheets/sheet${index + 1}.bin`
  }));
  if (sharedStrings) {
    workbookRels.push({
      Id: `rId${workbookRels.length + 1}`,
      Type: SHARED_STRINGS_REL,
      Target: "sharedStrings.bin"
    });
  }
  for (const theme of themes) {
    workbookRels.push({
      Id: `rId${workbookRels.length + 1}`,
      Type: RelType.Theme,
      Target: theme.path.replace(/^xl\//, "")
    });
  }
  if (styles) {
    workbookRels.push({
      Id: `rId${workbookRels.length + 1}`,
      Type: STYLES_REL,
      Target: "styles.bin"
    });
  }
  // `workbook.bin.rels`, not `workbook.xml.rels`. OPC locates a part's relationships at
  // `<dir>/_rels/<filename>.rels`, so the `.xml` name meant the workbook part had no
  // relationships at all as far as the package was concerned — the sheets were unreachable
  // through the only mechanism that makes them reachable. Nothing caught it because this
  // library's own reader computed the sheet paths arithmetically instead of following them.
  // A preserved part reached from the workbook needs its relationship carried across too, or it
  // sits in the package unreferenced — which is one of the things Excel offers to repair.
  appendOpaqueSourceRelationships(workbookRels, opaqueParts, "xl/workbook.bin");
  archive.add("xl/_rels/workbook.bin.rels", relationships(workbookRels));

  const workbookPart = writeWorkbookPart(
    worksheets.map((worksheet, index) => ({
      name: worksheet.name ?? `Sheet${index + 1}`,
      ...(worksheet.state === undefined ? {} : { state: worksheet.state })
    })),
    // After the sheets, so the extern-sheet table already holds any span a formula appended.
    {
      date1904,
      definedNames,
      formulaContext,
      externSheets: formulaContext.externSheets,
      ...(model.calcProperties === undefined ? {} : { calcProperties: model.calcProperties })
    }
  );
  archive.add("xl/workbook.bin", workbookPart.bytes);
  unsupported.push(...workbookPart.unsupported);
  unsupported.push(...workbookLosses(model));
  // Images: the bytes, the drawing part that places them, and that part's own relationships. All
  // three are shared with the XLSX path — the media are opaque bytes, the drawing is XML rendered by
  // `DrawingXform`, and only the reference from the sheet is binary.
  for (const part of media.parts) {
    archive.add(part.path, part.bytes);
  }
  if (drawings.length > 0) {
    const { DrawingXform } = await import("@excel/xlsx/xform/drawing/drawing-xform");
    for (const drawing of drawings) {
      const xform = new DrawingXform();
      xform.prepare(drawing);
      const writer = new XmlWriter();
      xform.render(writer, drawing);
      archive.add(drawingPath(drawing.name), writer.xml);
      archive.add(drawingRelsPath(drawing.name), relationships(drawing.rels));
    }
  }

  // Indexed once. Every sheet relationship used to scan the whole opaque set, lower-casing each
  // candidate path again on every comparison — O(relationships × parts) for a question that is a set
  // membership test.
  const opaquePaths = new Set(opaqueParts.map(part => part.path.toLowerCase()));
  for (const part of sheetParts) {
    archive.add(part.path, part.bytes);
    // A sheet that reached a preserved part keeps the relationship that reached it. Without this the
    // part survives with nothing pointing at it, which Excel treats as damage rather than as a file
    // with an unused part in it.
    const sheetRels: { Id: string; Type: string; Target: string }[] =
      part.drawing === undefined
        ? []
        : [
            {
              Id: part.drawing.rId,
              Type: RelType.Drawing,
              Target: drawingRelTargetFromWorksheet(part.drawing.name)
            }
          ];
    const reachable = part.opaqueRels.filter(relationship => {
      const target = resolveRelationshipTarget(
        part.path,
        relationship.target,
        relationship.targetMode
      );
      return target !== undefined && opaquePaths.has(target.toLowerCase());
    });
    for (const relationship of reachable) {
      sheetRels.push({
        Id: relationship.id,
        Type: relationship.type,
        Target: relationship.target,
        ...(relationship.targetMode === undefined ? {} : { TargetMode: relationship.targetMode })
      });
    }
    if (sheetRels.length > 0) {
      archive.add(relationshipsPathFor(part.path), relationships(sheetRels));
    }
  }
  if (sharedStrings) {
    archive.add("xl/sharedStrings.bin", sharedStrings);
  }
  if (styles) {
    archive.add("xl/styles.bin", styles);
  }
  for (const theme of themes) {
    archive.add(theme.path, theme.xml);
  }

  for (const part of opaqueParts) {
    archive.add(part.path, part.data);
    // A preserved part's own relationships travel with it, re-emitted rather than copied, so a
    // relationship pointing at something that was dropped does not survive as a dangling one.
    if (part.relationships && part.relationships.length > 0) {
      archive.add(
        relationshipsPathFor(part.path),
        relationships(
          part.relationships.map(relationship => ({
            Id: relationship.id,
            Type: relationship.type,
            Target: relationship.target,
            ...(relationship.targetMode === undefined
              ? {}
              : { TargetMode: relationship.targetMode })
          }))
        )
      );
    }
  }

  return { bytes: await archive.bytes(), unsupported };
}

function relationships(entries: readonly { Id: string; Type: string; Target: string }[]): string {
  const writer = new XmlWriter();
  new RelationshipsXform().render(writer, [...entries]);
  return writer.xml;
}

function contentTypes(
  sheetPaths: readonly string[],
  hasSharedStrings: boolean,
  hasStyles: boolean,
  opaque: { overrides: Record<string, string>; defaults: Record<string, string> },
  imageTypes: ReadonlyMap<string, string>,
  drawingPaths: readonly string[],
  themePaths: readonly string[]
): string {
  const writer = new XmlWriter();
  writer.openXml({ version: "1.0", encoding: "UTF-8", standalone: "yes" });
  writer.openNode("Types", {
    xmlns: "http://schemas.openxmlformats.org/package/2006/content-types"
  });
  // `bin` as a Default, the way Excel declares it, with the workbook's own type. Every other `.bin`
  // part then carries an Override — which is what the worksheet entries below are.
  writer.leafNode("Default", { Extension: "bin", ContentType: WORKBOOK_CONTENT_TYPE });
  writer.leafNode("Default", {
    Extension: "rels",
    ContentType: "application/vnd.openxmlformats-package.relationships+xml"
  });
  writer.leafNode("Default", { Extension: "xml", ContentType: "application/xml" });
  for (const [extension, contentType] of imageTypes) {
    writer.leafNode("Default", { Extension: extension, ContentType: contentType });
  }
  for (const path of themePaths) {
    writer.leafNode("Override", {
      PartName: `/${path}`,
      ContentType: "application/vnd.openxmlformats-officedocument.theme+xml"
    });
  }
  for (const path of drawingPaths) {
    writer.leafNode("Override", {
      PartName: `/${path}`,
      ContentType: "application/vnd.openxmlformats-officedocument.drawing+xml"
    });
  }
  for (const path of sheetPaths) {
    writer.leafNode("Override", { PartName: `/${path}`, ContentType: WORKSHEET_CONTENT_TYPE });
  }
  if (hasSharedStrings) {
    writer.leafNode("Override", {
      PartName: "/xl/sharedStrings.bin",
      ContentType: SHARED_STRINGS_CONTENT_TYPE
    });
  }
  if (hasStyles) {
    writer.leafNode("Override", {
      PartName: "/xl/styles.bin",
      ContentType: STYLES_CONTENT_TYPE
    });
  }
  writer.leafNode("Override", {
    PartName: "/docProps/core.xml",
    ContentType: "application/vnd.openxmlformats-package.core-properties+xml"
  });
  writer.leafNode("Override", {
    PartName: "/docProps/app.xml",
    ContentType: "application/vnd.openxmlformats-officedocument.extended-properties+xml"
  });
  for (const [extension, contentType] of Object.entries(opaque.defaults)) {
    writer.leafNode("Default", { Extension: extension, ContentType: contentType });
  }
  for (const [path, contentType] of Object.entries(opaque.overrides)) {
    writer.leafNode("Override", { PartName: `/${path}`, ContentType: contentType });
  }
  writer.closeNode();
  return writer.xml;
}

/**
 * Preserved parts that something still points at.
 *
 * A part reachable only from a sheet that has since been deleted is dropped rather than written
 * back, because an unreferenced part is one of the things Excel offers to repair. The reachability
 * check is the same one `xlsx/` uses.
 */
function reachableOpaqueParts(
  model: WorkbookModel,
  sheetParts: readonly {
    readonly path: string;
    readonly opaqueRels: readonly OpaqueRelationship[];
  }[]
): readonly OpaquePart[] {
  const parts = model.opaqueParts ?? [];
  if (parts.length === 0) {
    return [];
  }
  // The relationships **this write will actually emit** — not every relationship the model remembers.
  // Passing the latter made the filter vacuous: a part reached only from a deleted worksheet counted
  // its own historical inbound edge as evidence that something still pointed at it, so it was written
  // and then nothing did. An orphan part is precisely what this filter exists to prevent, and it was
  // producing them.
  const emitted: OpaqueSourceRelationship[] = [];
  for (const part of parts) {
    for (const inbound of part.sourceRelationships ?? []) {
      // The root and the workbook are re-emitted wholesale by `appendOpaqueSourceRelationships`, so
      // their edges survive whatever happened to the sheets.
      if (inbound.source === "" || inbound.source === WORKBOOK_PART) {
        emitted.push(inbound);
      }
    }
  }
  // A surviving sheet's edges travel with the sheet rather than with its old path: the sheet may be
  // written at a different `sheetN.bin` than it was read from. The targets are relative and resolve
  // identically from any sheet path, which is why re-basing them onto the new one is sound.
  for (const part of sheetParts) {
    for (const relationship of part.opaqueRels) {
      emitted.push({ ...relationship, source: part.path });
    }
  }
  return resolveReachableOpaqueParts(parts, emitted).parts;
}

/**
 * Page setup and sheet defaults from a worksheet model.
 *
 * Only the fields whose `BrtPageSetup` / `BrtMargins` / `BrtWsFmtInfo` layouts the reference corpus
 * establishes are carried. `BrtPrintOptions` is not among them: two bytes, and the corpus reads
 * `0x0010` in most workbooks but `0x5950` and `0x5a30` in one — a field of about six flags should
 * not reach 0x5a30, so either the reading is wrong or those records are something else. A print
 * option guessed wrong flips a boolean nobody notices, so it is left out rather than approximated.
 */
function sheetOptionsFromModel(worksheet: WorkbookModel["worksheets"][number]): {
  readonly pageSetup?: ReadPageSetup & { readonly margins?: Partial<Margins> };
  readonly formatInfo?: SheetFormatInfo;
  readonly sheetProperties?: SheetProperties;
  readonly headerFooter?: Partial<HeaderFooter>;
} {
  const setup = worksheet.pageSetup;
  const properties = worksheet.properties;

  const headerFooter = worksheet.headerFooter;
  const pageSetup: ReadPageSetup & { margins?: Partial<Margins> } = {};
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

  const sheetProperties: SheetProperties = {
    ...(properties?.tabColor === undefined || Object.keys(properties.tabColor).length === 0
      ? {}
      : { tabColor: properties.tabColor }),
    ...(properties?.codeName === undefined ? {} : { codeName: properties.codeName })
  };

  const formatInfo: SheetFormatInfo = {
    ...(properties?.defaultRowHeight === undefined
      ? {}
      : { defaultRowHeight: properties.defaultRowHeight }),
    ...(properties?.defaultColWidth === undefined
      ? {}
      : { defaultColWidth: properties.defaultColWidth })
  };

  return {
    ...(Object.keys(pageSetup).length === 0 ? {} : { pageSetup }),
    ...(Object.keys(formatInfo).length === 0 ? {} : { formatInfo }),
    ...(Object.keys(sheetProperties).length === 0 ? {} : { sheetProperties }),
    ...(headerFooter === undefined ? {} : { headerFooter })
  };
}

/**
 * Render an XLSX xform to a string, for the two document-property parts XLSB shares with it.
 *
 * The xforms are typed against their own models, and the workbook model satisfies both structurally
 * — so the cast is at this boundary rather than spread through the call sites.
 */
function renderXform(
  xform: { render: (writer: XmlWriter, model: never) => void },
  model: WorkbookModel
): string {
  const writer = new XmlWriter();
  (xform.render as (writer: XmlWriter, model: WorkbookModel) => void)(writer, model);
  return writer.xml;
}

/**
 * The first candidate `format(n)` that `taken` rejects, starting at `from`.
 *
 * Shared by the drawing-part namer and the media namer because both are the same question — "what
 * would Excel call this, and is that name already occupied?" — and both answers have to hold against
 * parts this writer did not create.
 */
function unusedName(
  taken: (candidate: string) => boolean,
  format: (n: number) => string,
  from: number
): string {
  let n = from;
  while (taken(format(n))) {
    n++;
  }
  return format(n);
}

/**
 * Modelled themes, as parts to write.
 *
 * A theme reaches this writer one of two ways and they must not both fire. An XLSB read leaves it in
 * `opaqueParts` and it is written back verbatim; an XLSX read parses it into `model.themes`, and until
 * now nothing wrote that — so a converted workbook kept its `{ theme: n }` colours and lost the table
 * they resolve through. The reservation check is what keeps a preserved theme from being written twice
 * when a model somehow carries both.
 */
function themeParts(
  model: WorkbookModel,
  reservedPaths: Set<string>
): readonly { readonly path: string; readonly xml: string }[] {
  const themes = model.themes as Record<string, string> | undefined;
  if (themes === undefined) {
    return [];
  }
  const parts: { path: string; xml: string }[] = [];
  for (const [name, xml] of Object.entries(themes)) {
    if (typeof xml !== "string") {
      continue;
    }
    const path = themePath(name);
    if (reservedPaths.has(path.toLowerCase())) {
      continue;
    }
    reservedPaths.add(path.toLowerCase());
    parts.push({ path, xml });
  }
  return parts;
}

/**
 * The `BrtDrawing` a sheet should carry: the modelled drawing's id, or the one it was read with.
 *
 * Only one of the two can apply. A sheet with modelled images gets a freshly written drawing part and
 * therefore a fresh id; a sheet whose images this reader preserved as opaque parts keeps the id that
 * still points at them. A sheet with *both* is the case `drawingForWorksheet` refuses.
 */
function drawingReference(
  worksheet: WorkbookModel["worksheets"][number],
  drawing: DrawingPart | undefined
): { drawingRelationshipId?: string } {
  if (drawing !== undefined) {
    return { drawingRelationshipId: drawing.rId };
  }
  const preserved = worksheet.xlsbDrawingRelationshipId;
  return preserved === undefined ? {} : { drawingRelationshipId: preserved };
}

/** A drawing part and the sheet relationship that reaches it. */
interface DrawingPart {
  readonly name: string;
  readonly rId: string;
  // The shapes `drawing-utils` produces and `DrawingXform` consumes, named rather than widened to
  // `unknown[]`. The casts that widening required — `as unknown as Parameters<…>[0]` going in and
  // `as never` going out — meant a change to the XLSX drawing model could not fail to compile here; it
  // would fail at runtime, in a package, on a picture.
  anchors: DrawingAnchor[];
  rels: DrawingRel[];
}

/**
 * The drawing a worksheet needs for its images, or `undefined` when it has none.
 *
 * The anchor arithmetic and the relationship bookkeeping come from `buildDrawingAnchorsAndRels`,
 * which the XLSX path uses for the same job — a second implementation of "where on the sheet does
 * this picture sit" would be a second thing to keep in step, and the one with fewer users would be
 * the one that drifted.
 */
function drawingForWorksheet(
  worksheet: WorkbookModel["worksheets"][number],
  namedMedia: readonly MediaLike[],
  index: number,
  accumulated: DrawingPart[],
  reservedPaths: Set<string>,
  usable: ReadonlySet<number>,
  losses: string[]
): DrawingPart | undefined {
  const media = (worksheet.media ?? []).filter(
    medium => medium.type === "image" && usable.has(Number(medium.imageId))
  );
  if (media.length === 0) {
    return undefined;
  }
  // **A sheet has at most one drawing.** Every picture, chart and shape on it is an anchor inside that
  // one part, which is why `BrtDrawing` is a single id rather than a collection. So a sheet that already
  // carries a preserved drawing and has new modelled images cannot have both: the sheet gets one
  // `BrtDrawing`, and whichever drawing it does not name becomes unreachable — the preserved pictures
  // silently vanish.
  //
  // Merging would need the preserved drawing's XML parsed and its anchors rewritten, and this reader
  // deliberately does not model drawings. So the combination is refused and named instead. Under
  // `"ignore"` the *preserved* drawing wins: the caller asked to add a picture, not to delete the ones
  // already there.
  if (worksheet.xlsbDrawingRelationshipId !== undefined) {
    losses.push(
      `${media.length} new image(s) on a sheet that already has a preserved drawing, which this ` +
        `writer cannot merge into`
    );
    return undefined;
  }
  // A name no preserved part already occupies. `drawing${index + 1}` is what Excel would call it, but
  // a workbook *read from XLSB* keeps its original drawings as opaque parts — this reader does not
  // model them — so adding an image to a sheet that already had one produced a second
  // `xl/drawings/drawing1.xml` at the same path as the preserved one. One of the two then won,
  // depending on how the container treats a duplicate entry.
  const name = unusedName(
    candidate => reservedPaths.has(drawingPath(candidate).toLowerCase()),
    base => `drawing${base}`,
    index + 1
  );
  // An id nothing else in this sheet's `.rels` uses. `rId1` unconditionally was safe only while the
  // sheet had no other relationships; a preserved relationship carried through from a read is free
  // to be `rId1` itself, and two entries with one id is a malformed part.
  const takenIds = new Set((worksheet.opaqueRels ?? []).map(relationship => relationship.id));
  const rId = unusedName(
    candidate => takenIds.has(candidate),
    base => `rId${base}`,
    1
  );
  // Claimed immediately. Only the *preserved* paths were consulted before, so two sheets adding an image
  // to a package that already had `drawing1` both looked past it, both landed on `drawing2`, and the
  // archive received one path twice.
  reservedPaths.add(drawingPath(name).toLowerCase());
  const drawing: DrawingPart = { name, rId, anchors: [], rels: [] };
  const built = buildDrawingAnchorsAndRels(media as ImageMedium[], [], {
    getBookImage: id => namedMedia[Number(id)],
    nextRId: rels => `rId${rels.length + 1}`
  });
  drawing.anchors = built.anchors;
  drawing.rels = built.rels;
  accumulated.push(drawing);
  return drawing;
}

/**
 * Everything the package needs to know about its images, decided once.
 *
 * **Why one pass rather than three.** The part path, the content type and the relationship target
 * each used to derive the filename independently, and they disagreed: the archive wrote
 * `image1.png` for a medium with no `extension`, while the content-type scan skipped that medium
 * because it had none — so the part was written and never declared. Deriving all three from one
 * resolved list makes that class of mismatch unrepresentable.
 */
interface MediaPlan {
  /**
   * The media in model order, each with a name.
   *
   * A *copy*. `addWorkbookImage` deliberately leaves the name unset — a name is a fact about the
   * package, not about the image — so a writer has to assign one, and this writer used to do that by
   * assigning onto the caller's own media objects. That made `Workbook.toBuffer` mutate its input,
   * including on the path where it then rejected the workbook as unsupported.
   */
  readonly named: readonly MediaLike[];
  /** The parts to write, already resolved to bytes. */
  readonly parts: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  /** Content type per extension, for the `Default` declarations. */
  readonly contentTypes: ReadonlyMap<string, string>;
  /**
   * Media indices that reached the package — as a part, or as an external link.
   *
   * A drawing may only reference these. `ImageData` makes all four byte sources optional, so
   * `Image.add(workbook, { extension: "png" })` type-checks, and it used to produce a drawing
   * relationship pointing at `../media/imageN.png` with no such part written: a dangling reference,
   * which Excel offers to repair. Filtering the anchors is what makes the reference and the part
   * agree; `losses` is what stops the omission being silent.
   */
  readonly usable: ReadonlySet<number>;
  /** Media this writer could not embed, as `name: reason`. */
  readonly losses: readonly string[];
}

/**
 * Resolve every image to a name, a part and a content type.
 *
 * Async because a medium may name a file rather than carry its bytes. That form is part of the
 * public `ImageData`, and this writer previously ignored it: the drawing relationship was still
 * emitted, so the package came out with `../media/imageN.png` pointing at a part that was never
 * written — a dangling reference, which is one of the things Excel offers to repair. In a browser
 * `readFileBytes` throws, which is the same outcome the XLSX path produces for a filename it
 * cannot read, and a great deal better than a silently broken package.
 */
async function planMedia(
  model: WorkbookModel,
  reservedPaths: ReadonlySet<string>
): Promise<MediaPlan> {
  const named: MediaLike[] = [];
  const parts: { path: string; bytes: Uint8Array }[] = [];
  const contentTypes = new Map<string, string>();
  const usedPaths = new Set(reservedPaths);
  const usable = new Set<number>();
  const losses: string[] = [];

  const media = model.media ?? [];
  for (const [index, medium] of media.entries()) {
    if (medium.type !== "image") {
      named.push(medium as MediaLike);
      continue;
    }
    const extension =
      typeof medium.extension === "string" && medium.extension.length > 0
        ? medium.extension.toLowerCase()
        : "png";
    // The name the relationship target is built from, so the two cannot disagree — and one nothing else
    // in the package already occupies.
    //
    // An *explicit* name goes through the same check, which it did not before: two media both named
    // `logo` produced one `xl/media/logo.png` and two drawings pointing at it, so the second picture
    // silently became a copy of the first. A name is a request, and the package can only honour it once.
    const taken = (candidate: string): boolean =>
      usedPaths.has(mediaPath(`${candidate}.${extension}`).toLowerCase());
    const requested = medium.name;
    const name =
      requested !== undefined && !taken(requested)
        ? requested
        : unusedName(
            taken,
            base => `${requested ?? "image"}${base}`,
            requested === undefined ? index + 1 : 2
          );
    usedPaths.add(mediaPath(`${name}.${extension}`).toLowerCase());
    const entry: MediaLike = { ...(medium as MediaLike), name };
    named.push(entry);
    // An external image is referenced in place through `TargetMode="External"` and stores no bytes,
    // so it needs neither a part nor a content type.
    if (isExternalImage(entry)) {
      usable.add(index);
      continue;
    }
    const bytes = await mediaBytes(medium);
    if (bytes === undefined) {
      losses.push(`${name}: image with no bytes and no link`);
      continue;
    }
    usable.add(index);
    parts.push({ path: mediaPath(`${entry.name}.${extension}`), bytes });
    contentTypes.set(extension, imageContentType(extension));
  }

  return { named, parts, contentTypes, usable, losses };
}

/** An image's bytes, from whichever of the three embedded forms it carries. */
async function mediaBytes(medium: {
  buffer?: Uint8Array;
  base64?: string;
  filename?: string;
}): Promise<Uint8Array | undefined> {
  if (medium.buffer !== undefined) {
    return medium.buffer;
  }
  if (medium.base64 !== undefined) {
    // The `data:` prefix is optional in the model, so the payload is taken from the comma onwards.
    // Decoded through the shared helper rather than `Buffer`, which does not exist in a browser —
    // this writer is on the browser IO path, so a base64 image used to fail there with
    // `ReferenceError: Buffer is not defined` while the same workbook wrote fine under Node.
    return base64ToUint8Array(medium.base64.slice(medium.base64.indexOf(",") + 1));
  }
  if (medium.filename !== undefined) {
    return readFileBytes(medium.filename);
  }
  return undefined;
}

/**
 * Content type for an image extension.
 *
 * `image/${extension}` is right for the extensions `ImageData` documents (`png`, `gif`, and `jpeg`
 * — which is why `jpeg` needs no special case). `jpg` is the one people write anyway, and
 * `image/jpg` is not a registered type, so it is normalised rather than passed through.
 */
function imageContentType(extension: string): string {
  switch (extension) {
    case "svg":
      return "image/svg+xml";
    case "jpg":
      return "image/jpeg";
    default:
      return `image/${extension}`;
  }
}
