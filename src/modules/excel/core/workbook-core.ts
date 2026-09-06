import type { ChartExEntry } from "@excel/chart/model/chart-ex-types";
/**
 * workbook-core — the low-level Workbook container layer.
 *
 * Holds the plain-data `WorkbookData` record interface and the low-level
 * registry accessors (defined-names, chart/chartEx entries, images, sheet-name
 * validation, sheet removal) that the worksheet module reaches up into.
 *
 * Exists to break the worksheet ↔ workbook import cycle: worksheet needs these
 * workbook-level registries, and the heavy `workbook.browser` module needs to
 * create worksheets. Keeping the registries here — above worksheet, below the
 * heavy workbook module — yields a clean one-directional graph:
 *
 *     workbook.browser.ts  (addWorksheet / importSheet / chartsheet / model / IO)
 *        ↓
 *     workbook-core.ts  (WorkbookData + registry accessors)
 *        ↓
 *     worksheet.ts / worksheet-core.ts / cell / row / column
 *
 * No file below this one imports the heavy `workbook.browser`.
 */
import type { ChartEntry } from "@excel/chart/model/types";
import type { BuiltinCellStyle } from "@excel/core/builtin-cell-styles";
import { BUILTIN_CELL_STYLES } from "@excel/core/builtin-cell-styles";
import type { DefinedNamesData } from "@excel/core/defined-names";
import type { OpaqueDrop, OpaquePart } from "@excel/core/opaque-part";
import type { PivotTable } from "@excel/core/pivot-table";
import type {
  WorkbookMedia,
  WorkbookProtectionModel,
  ExternalLinkModel
} from "@excel/core/workbook.browser";
import type { Worksheet } from "@excel/core/worksheet";
import { getSheetName } from "@excel/core/worksheet-core";
import { ImageError, WorksheetNameError } from "@excel/errors";
import type {
  Font,
  ImageData,
  NamedStyle,
  WorkbookProperties,
  CalculationProperties,
  WorkbookView,
  ThreadedCommentPerson
} from "@excel/types";
import { RelType } from "@excel/xlsx/rel-type";
import type { RelationshipModel } from "@excel/xlsx/xform/core/relationship-xform";
import type { ChartsheetModel } from "@excel/xlsx/xform/sheet/chartsheet-xform";
import type { XLSX } from "@excel/xlsx/xlsx.browser";
import type { FormulaFunction as WorkbookFunctionDescriptor } from "@formula/integration/calculate-formulas";
export type { WorkbookFunctionDescriptor };

/**
 * A named cell style stored on the workbook: a {@link NamedStyle} plus its name.
 */
export interface NamedStyleEntry extends NamedStyle {
  name: string;
}

export interface WorkbookData {
  category: string;
  company: string;
  created: Date;
  description: string;
  keywords: string;
  manager: string;
  modified: Date;
  subject: string;
  title: string;
  creator?: string;
  lastModifiedBy?: string;
  lastPrinted?: Date;
  language?: string;
  revision?: number;
  contentStatus?: string;
  /** Source file path remembered by Node `readFile`; absent for buffers/browser inputs. */
  sourceFilePath?: string;
  /**
   * Override ContentType for `/xl/workbook.xml` captured from the source file's
   * `[Content_Types].xml` (templates / macro-enabled workbooks differ from a
   * plain .xlsx). Undefined for a freshly created workbook.
   */
  workbookContentType?: string;
  properties: Partial<WorkbookProperties>;
  calcProperties: Partial<CalculationProperties>;
  views: WorkbookView[];
  media: WorkbookMedia[];
  pivotTables: PivotTable[];
  protection?: WorkbookProtectionModel;
  externalLinks: ExternalLinkModel[];
  _worksheets: Worksheet[];
  _definedNames: DefinedNamesData;
  _themes?: unknown;
  _defaultFont?: Partial<Font>;
  /**
   * Workbook-level named cell styles (OOXML `cellStyle`), keyed by style name.
   * The key is the style name verbatim (case-sensitive, per OOXML). Populated
   * by {@link defineCellStyle} and on read from an existing workbook's
   * `cellStyles`/`cellStyleXfs`.
   */
  _cellStyles?: Map<string, NamedStyleEntry>;
  _writerExternalLinkCache: Map<string, ExternalLinkModel>;
  _tableNames: Set<string>;
  _chartEntries: Record<number, ChartEntry>;
  _chartRels: Record<number, RelationshipModel[]>;
  _chartStyles: Record<number, Uint8Array>;
  _chartColors: Record<number, Uint8Array>;
  _chartExStyles: Record<number, Uint8Array>;
  _chartExColors: Record<number, Uint8Array>;
  _chartExEntries: Record<number, Uint8Array>;
  _chartExRels: Record<number, RelationshipModel[]>;
  _chartExStructuredEntries: Record<number, ChartExEntry>;
  _chartsheets: ChartsheetModel[];
  _persons: ThreadedCommentPerson[];
  _slicerParts: Record<string, Uint8Array>;
  _slicerCacheParts: Record<string, Uint8Array>;
  _timelineParts: Record<string, Uint8Array>;
  _timelineCacheParts: Record<string, Uint8Array>;
  /** Preserved unmodelled package parts — see `WorkbookModel.opaqueParts`. */
  _opaqueParts: OpaquePart[];
  /**
   * `BrtBeginPivotCacheID` bindings an XLSB read preserved.
   *
   * XLSB-only, and here rather than in the pivot model because the parts they name are carried through as
   * opaque bytes: the reader does not build a `PivotTable` from them, but `workbook.bin` is rebuilt on write
   * and would otherwise drop the record that announces each cache.
   */
  _xlsbPivotCaches?: readonly { readonly cacheId: number; readonly relationshipId: string }[];
  _opaqueContentTypeDefaults: Record<string, string>;
  /** Preserved parts not written back — see `WorkbookModel.opaqueDrops`. */
  _opaqueDrops: OpaqueDrop[];
  _xlsx?: XLSX;
  userFunctions?: Map<string, WorkbookFunctionDescriptor>;
}

/**
 * Validate a named cell style name. Shared by the standard workbook API and the
 * streaming writer so both reject the same inputs. Throws on an empty name or
 * the reserved built-in "Normal" style (builtinId 0), which is always emitted
 * implicitly as `cellStyleXfs[0]`.
 */
export function validateCellStyleName(name: string): void {
  if (typeof name !== "string" || name === "") {
    throw new WorksheetNameError("Named cell style name must be a non-empty string.");
  }
  if (name === "Normal") {
    throw new WorksheetNameError('The built-in "Normal" cell style cannot be redefined.');
  }
}

/**
 * Define (or replace) a workbook-level named cell style such as "Heading 1".
 * Cells reference it via `Style.styleName` (e.g. `Cell.applyCellStyle`).
 *
 * The reserved built-in "Normal" style (builtinId 0) cannot be redefined; it is
 * always emitted implicitly as `cellStyleXfs[0]`.
 */
export function defineCellStyle(wb: WorkbookData, name: string, style: NamedStyle): void {
  validateCellStyleName(name);
  if (!wb._cellStyles) {
    wb._cellStyles = new Map();
  }
  wb._cellStyles.set(name, { ...style, name });
}

/** Get a workbook-level named cell style by name, or `undefined` if absent. */
export function getCellStyle(wb: WorkbookData, name: string): NamedStyleEntry | undefined {
  return wb._cellStyles?.get(name);
}

/** List all workbook-level named cell styles in definition order. */
export function listCellStyles(wb: WorkbookData): NamedStyleEntry[] {
  return wb._cellStyles ? [...wb._cellStyles.values()] : [];
}

/** Remove a named cell style. Returns `true` if it existed. */
export function removeCellStyle(wb: WorkbookData, name: string): boolean {
  return wb._cellStyles ? wb._cellStyles.delete(name) : false;
}

/**
 * Define one of the built-in Excel cell-style presets (e.g. "Heading1") on the
 * workbook and return its OOXML style name (e.g. "Heading 1") for use with
 * `Cell.applyCellStyle`. Built-in presets carry the correct `builtinId`, which
 * accessibility software relies on to recognise the style's semantic role.
 */
export function useBuiltinCellStyle(wb: WorkbookData, id: BuiltinCellStyle): string {
  const { name, ...style } = BUILTIN_CELL_STYLES[id];
  defineCellStyle(wb, name, style);
  return name;
}

export function removeWorksheetEx(wb: WorkbookData, worksheet: Worksheet): void {
  // Release any workbook-wide table names this sheet held so the names can
  // be reused by future tables on other sheets without spurious "name
  // already exists" errors.
  const tables = worksheet.tables;
  if (tables) {
    for (const tableName of Object.keys(tables)) {
      wb._tableNames.delete(tableName.toLowerCase());
    }
  }
  wb._worksheets[worksheet.id] = undefined!;
}

export function getImage(wb: WorkbookData, id: number | string): WorkbookMedia | undefined {
  return wb.media[Number(id)];
}

/**
 * The next free `chartN` number, counting **preserved parts as taken**.
 *
 * A chart read from a package this library does not fully model arrives as an *opaque part* — `xl/charts/chart1.xml`
 * kept verbatim — and never enters `_chartEntries`. Numbering from that map alone therefore handed `1` straight back:
 * adding a chart to a workbook read from XLSB overwrote the chart it came with, so two charts left one behind and the
 * surviving drawing pointed at the wrong picture. The package writer's dedupe made it silent, because the newly
 * generated part is written before the preserved one and the preserved one is the copy that gets dropped.
 *
 * Reading the paths is the honest test: it asks what is actually in the package rather than what the model happens to
 * have recorded about it. `chartEx` shares the counter deliberately — `nextChartExNumber` reads the same space — so a
 * `chartEx1.xml` also reserves 1.
 */
/**
 * Chart numbers already taken by *preserved* parts.
 *
 * `chart1.xml` and `chartEx1.xml` are read together on purpose: both counters allocate into `xl/charts/`, so a name
 * taken by either form is taken for both.
 */
function preservedChartNumbers(wb: WorkbookData): readonly number[] {
  return wb._opaqueParts
    .map(part => /\/charts\/chart(?:Ex)?(\d+)\.xml$/i.exec(part.path)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number)
    .filter(number => Number.isFinite(number));
}

export function nextChartNumber(wb: WorkbookData): number {
  const existing = [...Object.keys(wb._chartEntries).map(Number), ...preservedChartNumbers(wb)];
  return existing.length > 0 ? Math.max(...existing) + 1 : 1;
}

export function addChartEntry(wb: WorkbookData, entry: ChartEntry): void {
  wb._chartEntries[entry.chartNumber] = entry;
}

export function setChartStyle(wb: WorkbookData, chartNumber: number, data: Uint8Array): void {
  wb._chartStyles[chartNumber] = data;
}

export function setChartColors(wb: WorkbookData, chartNumber: number, data: Uint8Array): void {
  wb._chartColors[chartNumber] = data;
}

export function getChartEntry(wb: WorkbookData, chartNumber: number): ChartEntry | undefined {
  return wb._chartEntries[chartNumber];
}

export function removeChartEntry(wb: WorkbookData, chartNumber: number): void {
  delete wb._chartEntries[chartNumber];
  delete wb._chartRels[chartNumber];
  delete wb._chartStyles[chartNumber];
  delete wb._chartColors[chartNumber];
}

export function nextChartExNumber(wb: WorkbookData): number {
  const rawKeys = Object.keys(wb._chartExEntries ?? {}).map(Number);
  const structKeys = Object.keys(wb._chartExStructuredEntries ?? {}).map(Number);
  // Preserved parts count as taken, for the reason given on `nextChartNumber`: a chart kept verbatim never enters the
  // entry maps, so numbering from them alone reissues a name that is already in the package.
  const combined = [...rawKeys, ...structKeys, ...preservedChartNumbers(wb)];
  return combined.length > 0 ? Math.max(...combined) + 1 : 1;
}

export function addChartExStructuredEntry(wb: WorkbookData, entry: ChartExEntry): void {
  if (!wb._chartExStructuredEntries) {
    wb._chartExStructuredEntries = {};
  }
  wb._chartExStructuredEntries[entry.chartExNumber] = entry;
}

export function getChartExStructuredEntry(
  wb: WorkbookData,
  chartExNumber: number
): ChartExEntry | undefined {
  return wb._chartExStructuredEntries?.[chartExNumber];
}

export function validateSheetName(
  wb: WorkbookData,
  name: string,
  existing?: Worksheet | { name: string }
): string {
  if (typeof name !== "string") {
    throw new WorksheetNameError("The name has to be a string.");
  }
  if (name === "") {
    throw new WorksheetNameError("The name can't be empty.");
  }
  if (name === "History") {
    throw new WorksheetNameError('The name "History" is protected. Please use a different name.');
  }
  // Illegal characters per Excel's own naming rules: asterisk (*),
  // question mark (?), colon (:), forward slash (/), backslash (\),
  // left bracket ([), right bracket (]). The chartsheet regex used
  // to omit `\\`; unified here so both families enforce the same
  // char set.
  if (/[*?:/\\[\]]/.test(name)) {
    throw new WorksheetNameError(
      `Sheet name ${name} cannot include any of the following characters: * ? : \\ / [ ]`
    );
  }
  if (/(^')|('$)/.test(name)) {
    throw new WorksheetNameError(
      `The first or last character of sheet name cannot be a single quotation mark: ${name}`
    );
  }
  if (name.length > 31) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`Sheet name ${name} exceeds 31 chars. This will be truncated`);
    }
    name = name.substring(0, 31);
  }
  const nameLower = name.toLowerCase();
  const duplicateWorksheet = wb._worksheets.find(
    ws => ws && ws !== existing && ws._name.toLowerCase() === nameLower
  );
  const duplicateChartsheet = wb._chartsheets.find(
    cs => cs && cs !== existing && cs.name.toLowerCase() === nameLower
  );
  if (duplicateWorksheet || duplicateChartsheet) {
    throw new WorksheetNameError(`Sheet name already exists: ${name}`);
  }
  return name;
}

export function removeChartExStructuredEntry(wb: WorkbookData, chartExNumber: number): void {
  if (wb._chartExStructuredEntries) {
    delete wb._chartExStructuredEntries[chartExNumber];
  }
  delete wb._chartExEntries[chartExNumber];
  delete wb._chartExRels[chartExNumber];
  delete wb._chartExStyles[chartExNumber];
  delete wb._chartExColors[chartExNumber];
}

export function getDefinedNames(wb: WorkbookData): DefinedNamesData {
  return wb._definedNames;
}
export function addWorkbookImage(wb: WorkbookData, image: ImageData): number {
  const { svg, ...raster } = image;
  if (
    svg &&
    raster.link &&
    raster.buffer == null &&
    raster.base64 == null &&
    raster.filename == null
  ) {
    // An SVG companion needs an embedded raster fallback; a *linked* (external)
    // raster has no package part to attach the svgBlip extension to.
    throw new ImageError(
      "An SVG image requires an embedded raster fallback (buffer/base64/filename); it cannot be combined with an external link."
    );
  }
  const id = wb.media.length;
  const rasterMedia: WorkbookMedia = { ...raster, type: "image" };
  wb.media.push(rasterMedia);

  if (svg) {
    // Register the SVG as a second `type: "image"` media so it flows through
    // the existing media naming, content-types, and zip-writing paths. Link
    // it back to the raster blip so the drawing serializer can emit the
    // asvg:svgBlip extension.
    const svgId = wb.media.length;
    wb.media.push({ ...svg, type: "image", extension: "svg" });
    rasterMedia.svgMediaId = svgId;
  }

  return id;
}

/**
 * Look up a worksheet by index or name (or the first sheet when `id` is
 * omitted). Pure data accessor over `wb._worksheets` — kept in the core
 * layer so the chart module can resolve sheets for cache population without
 * forming a `workbook → chart → workbook` import cycle.
 */
export function getWorksheet(wb: WorkbookData, id?: number | string): Worksheet | undefined {
  if (id === undefined) {
    return wb._worksheets.find(Boolean);
  }
  if (typeof id === "number") {
    return wb._worksheets[id];
  }
  if (typeof id === "string") {
    const idLower = id.toLowerCase();
    return wb._worksheets.find(
      worksheet => worksheet && getSheetName(worksheet).toLowerCase() === idLower
    );
  }
  return undefined;
}

/** All worksheets in tab order (excludes the reserved index-0 slot). See {@link getWorksheet}. */
export function getWorksheets(wb: WorkbookData): Worksheet[] {
  return wb._worksheets
    .slice(1)
    .sort((a, b) => a.orderNo - b.orderNo)
    .filter(Boolean);
}

/**
 * Copy a classic chart's style/colours/rels sidecars from `sourceChartNumber`
 * to `targetChartNumber` (optionally into a different `targetWorkbook`).
 *
 * Pure data operation over the workbook's sidecar records — lives in the core
 * layer so `chart`'s `copyTo`/`clone` handle ops can use it without a
 * `workbook → chart → workbook` import cycle.
 */
export function copyChartSidecars(
  wb: WorkbookData,
  sourceChartNumber: number,
  targetChartNumber: number,
  targetWorkbook: WorkbookData = wb
): void {
  const style = wb._chartStyles[sourceChartNumber];
  if (style) {
    setChartStyle(targetWorkbook, targetChartNumber, style.slice());
  }
  const colors = wb._chartColors[sourceChartNumber];
  if (colors) {
    setChartColors(targetWorkbook, targetChartNumber, colors.slice());
  }
  // Copy the full chart rels bag (`_chartRels`), not just the
  // style/colors pair. A classic chart can carry rels to embedded
  // images (pictureFill), external data links, and `<c:userShapes>`
  // drawing parts — without copying those the clone ends up with
  // dangling rIds. Deep-copy each rel so a later mutation on the
  // source doesn't leak into the clone.
  //
  // Rewrite style/colors Targets to the destination chart number —
  // verbatim copy would leave the rel pointing at the source's
  // `style{src}.xml`, while the writer emits `style{dst}.xml` and
  // produces a chart whose .rels references a non-existent file.
  //
  // For image rels on a cross-workbook copy (`targetWorkbook !==
  // wb`), re-register each referenced image in the destination
  // workbook and rewrite the Target to point at the new media
  // file. Without this, a pictureFill that round-tripped through
  // `importSheet` pointed at the source workbook's media array —
  // which the destination package doesn't ship, so Excel shows a
  // broken image icon.
  const srcRels = wb._chartRels[sourceChartNumber];
  if (Array.isArray(srcRels) && srcRels.length > 0) {
    const crossWorkbook = targetWorkbook !== wb;
    targetWorkbook._chartRels[targetChartNumber] = srcRels.map(rel => {
      if (typeof rel !== "object" || rel === null) {
        return rel;
      }
      const cloned = { ...rel } as { Type?: string; Target?: string; [k: string]: unknown };
      const target = typeof cloned.Target === "string" ? cloned.Target : undefined;
      if (target) {
        if (/^style\d+\.xml$/.test(target)) {
          cloned.Target = `style${targetChartNumber}.xml`;
        } else if (/^colors\d+\.xml$/.test(target)) {
          cloned.Target = `colors${targetChartNumber}.xml`;
        } else if (crossWorkbook && cloned.Type === RelType.Image) {
          const rewritten = _rewriteCrossWorkbookImageTarget(wb, target, targetWorkbook);
          if (rewritten !== undefined) {
            cloned.Target = rewritten;
          }
        }
      }
      return cloned;
    });
  }
}

function _rewriteCrossWorkbookImageTarget(
  wb: WorkbookData,
  target: string,
  targetWorkbook: WorkbookData
): string | undefined {
  const match = /\/media\/image(\d+)\.([a-zA-Z0-9]+)$/.exec(target);
  if (!match) {
    return undefined;
  }
  const sourceMediaIndex = parseInt(match[1], 10) - 1;
  if (!Number.isFinite(sourceMediaIndex) || sourceMediaIndex < 0) {
    return undefined;
  }
  const medium = getImage(wb, sourceMediaIndex) as
    | { extension?: string; buffer?: Uint8Array; base64?: string }
    | undefined;
  if (!medium) {
    return undefined;
  }
  const ext = medium.extension as "png" | "jpeg" | "gif" | undefined;
  if (ext !== "png" && ext !== "jpeg" && ext !== "gif") {
    return undefined;
  }
  const payload: { extension: "png" | "jpeg" | "gif"; buffer?: Uint8Array; base64?: string } = {
    extension: ext
  };
  // `instanceof Uint8Array` is realm-sensitive: buffers that crossed
  // a Worker / iframe / `structuredClone` boundary carry a different
  // `Uint8Array` prototype and fail the operator even though they
  // are byte-granular typed arrays. Duck-type via `ArrayBuffer.isView`
  // + `BYTES_PER_ELEMENT === 1` so cross-workbook copies from a
  // worker-loaded Workbook preserve the image bytes; otherwise the
  // copy path silently falls through to `return undefined`, dropping
  // every image from the chart. Matches `chart-images.ts`'s handling
  // of the same realm-crossing issue.
  const buf = medium.buffer as ArrayBufferView | undefined;
  if (
    buf &&
    ArrayBuffer.isView(buf) &&
    (buf as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1
  ) {
    payload.buffer =
      buf instanceof Uint8Array
        ? buf.slice()
        : new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } else if (typeof medium.base64 === "string") {
    payload.base64 = medium.base64;
  } else {
    return undefined;
  }
  const newId = addWorkbookImage(targetWorkbook, payload);
  return `../media/image${newId + 1}.${ext}`;
}

/**
 * Copy a ChartEx chart's styleEx/colorsEx/rels sidecars. See
 * {@link copyChartSidecars} for the layering rationale.
 */
export function copyChartExSidecars(
  wb: WorkbookData,
  sourceChartExNumber: number,
  targetChartExNumber: number,
  targetWorkbook: WorkbookData = wb
): void {
  const rels = wb._chartExRels[sourceChartExNumber];
  if (rels && rels.length > 0) {
    // Rewrite `Target` for rels that point at numbered sidecars
    // (styleEx / colorsEx / userShapes). Those files get different
    // on-disk numbers on the clone — copying the rel verbatim
    // leaves it pointing at the source's sidecar, so saving the
    // package produces a chartEx whose .rels references
    // `styleEx{src}.xml` while the writer emits `styleEx{dst}.xml`.
    // Strip the number from the source Target and re-stamp it with
    // the target's number.
    //
    // For image rels on a cross-workbook copy (`targetWorkbook !==
    // wb`), re-register each referenced image in the destination
    // workbook and rewrite the Target — same logic as classic chart
    // sidecars. Without this, a ChartEx with embedded images (e.g.
    // pictureFill or custom geometry) would reference media that
    // doesn't exist in the destination package.
    const crossWorkbook = targetWorkbook !== wb;
    targetWorkbook._chartExRels[targetChartExNumber] = rels.map(r => {
      if (typeof r !== "object" || r === null) {
        return r;
      }
      const cloned = { ...r };
      const target: string | undefined =
        typeof cloned.Target === "string" ? cloned.Target : undefined;
      if (target) {
        const styleExMatch = /^styleEx\d+\.xml$/.exec(target);
        if (styleExMatch) {
          cloned.Target = `styleEx${targetChartExNumber}.xml`;
        } else if (/^colorsEx\d+\.xml$/.exec(target)) {
          cloned.Target = `colorsEx${targetChartExNumber}.xml`;
        } else if (crossWorkbook && cloned.Type === RelType.Image) {
          const rewritten = _rewriteCrossWorkbookImageTarget(wb, target, targetWorkbook);
          if (rewritten !== undefined) {
            cloned.Target = rewritten;
          }
        }
      }
      return cloned;
    });
  }
  // ChartEx style / colors sidecars (matching `_chartStyles` /
  // `_chartColors` for classic charts). Previously only `_chartExRels`
  // was copied — a cloned chartEx lost its authored chartExStyle and
  // chartExColors bytes, so the saved package re-derived them from
  // defaults and the clone looked different from the source.
  const exStyle = wb._chartExStyles[sourceChartExNumber];
  if (exStyle) {
    targetWorkbook._chartExStyles[targetChartExNumber] = exStyle.slice();
  }
  const exColors = wb._chartExColors[sourceChartExNumber];
  if (exColors) {
    targetWorkbook._chartExColors[targetChartExNumber] = exColors.slice();
  }
}
