/**
 * XLSX - Abstract base class for XLSX operations
 *
 * Contains all platform-agnostic logic shared between Node.js and Browser versions:
 * - reconcile: Reconcile model after parsing
 * - _process*Entry: Process individual ZIP entries
 * - add*: Add content to ZIP during writing
 * - prepareModel: Prepare model for writing
 * - loadFromFiles: Load from pre-extracted ZIP data
 */

import { ZipParser } from "@archive/unzip/zip-parser";
import type { ZipTimestampMode } from "@archive/zip-spec/timestamps";
import { StreamingZip, ZipDeflateFile } from "@archive/zip/stream";
import type {
  ChartExData,
  ChartExEntry,
  ChartExModel,
  ChartExNumericDimension,
  ChartExSeries,
  ChartExStringDimension
} from "@excel/chart/model/chart-ex-types";
import type {
  AxisBase,
  Bevel,
  ChartColor,
  ChartEntry,
  ChartFill,
  ChartLayout,
  ChartMarker,
  ChartRichText,
  ChartTextProperties,
  DataLabelEntry,
  DataPoint,
  EffectList,
  NumberCache,
  NumberReference,
  Scene3D,
  SeriesBase,
  Shadow,
  ShapeProperties,
  ShapeProperties3D,
  StringCache,
  StringReference,
  Trendline,
  TrendlineLabel
} from "@excel/chart/model/types";
import { parseChartEx } from "@excel/chart/serialize/chart-ex-parser";
import {
  renderChartEx,
  renderChartExLegendXml,
  rewriteChartExDataRefsToDefinedNames
} from "@excel/chart/serialize/chart-ex-serialize";
// Chart serialisation / deserialisation imports the chart implementation
// statically. The chart modules depend only on the `*-core` data layer, so
// there is no import cycle, and a consumer that never reads/writes a workbook
// containing charts gets this code tree-shaken out by the bundler.
import { buildChartColors, buildChartStyle } from "@excel/chart/serialize/chart-sidecar";
import { themeIndexToName } from "@excel/chart/shared/chart-utils";
import { definedNamesAddHidden, definedNamesModel } from "@excel/core/defined-names";
import type {
  PivotTable,
  PivotTableSubtotal,
  ParsedCacheDefinition
} from "@excel/core/pivot-table";
import type { Workbook, ExternalLinkModel, NamedStyleEntry } from "@excel/core/workbook.browser";
import {
  _collectExternalLinksForWrite,
  _recordAutoExternalLink,
  getWorkbookModel,
  setWorkbookModel
} from "@excel/core/workbook.browser";
import type { XlsxEmitterLike, XlsxWritable } from "@excel/core/xlsx-io-types";
import {
  ExcelStreamStateError,
  ExcelFileError,
  ImageError,
  ExcelNotSupportedError,
  XlsxParseError,
  TableError,
  ChartOptionsError
} from "@excel/errors";
import type { ThreadedCommentPerson } from "@excel/types";
import { filterDrawingAnchors, isExternalImage } from "@excel/utils/drawing-utils";
import { rewriteExternalRefs } from "@excel/utils/external-link-formula";
import {
  commentsPath,
  chartsheetPath,
  chartsheetRelsPath,
  getChartsheetNoFromPath,
  getChartsheetNoFromRelsPath,
  ctrlPropPath,
  drawingPath,
  drawingRelsPath,
  externalLinkPath,
  externalLinkRelsPath,
  externalLinkRelTargetFromWorkbook,
  OOXML_REL_TARGETS,
  pivotCacheDefinitionRelTargetFromWorkbook,
  pivotTablePathFromName,
  isCommentsPath,
  chartPath,
  chartRelsPath,
  chartStylePath,
  chartColorsPath,
  chartExStylePath,
  chartExColorsPath,
  chartStyleRelTarget,
  chartExStyleRelTarget,
  chartExPath,
  chartExRelsPath,
  getChartExNumberFromPath,
  getChartExNumberFromRelsPath,
  chartColorsRelTarget,
  chartExColorsRelTarget,
  chartRelTargetFromDrawing,
  chartExRelTargetFromDrawing,
  chartUserShapesPath,
  chartUserShapesRelTarget,
  getChartNumberFromPath,
  getChartNumberFromRelsPath,
  getChartStyleNumberFromPath,
  getChartColorsNumberFromPath,
  getChartExStyleNumberFromPath,
  getChartExColorsNumberFromPath,
  getDrawingNameFromPath,
  getChartUserShapesNameFromPath,
  getDrawingNameFromRelsPath,
  getExternalLinkIndexFromPath,
  getExternalLinkIndexFromRelsPath,
  getMediaFilenameFromPath,
  mediaPath,
  getPivotCacheDefinitionNameFromPath,
  getPivotCacheDefinitionNameFromRelsPath,
  getPivotCacheRecordsNameFromPath,
  getPivotTableNameFromPath,
  getPivotTableNameFromRelsPath,
  pivotCacheDefinitionPath,
  pivotCacheDefinitionRelsPath,
  pivotCacheDefinitionRelTargetFromPivotTable,
  pivotCacheRecordsPath,
  pivotCacheRecordsRelTarget,
  pivotTablePath,
  pivotTableRelsPath,
  getTableNameFromPath,
  tablePath,
  themePath,
  getThemeNameFromPath,
  getVmlDrawingNameFromPath,
  getVmlDrawingHFNameFromPath,
  getVmlDrawingHFNameFromRelsPath,
  getWorksheetNoFromWorksheetPath,
  getWorksheetNoFromWorksheetRelsPath,
  isBinaryEntryPath,
  normalizeZipPath,
  OOXML_PATHS,
  resolveRelTarget,
  vmlDrawingPath,
  vmlDrawingHFPath,
  vmlDrawingHFRelsPath,
  worksheetPath,
  worksheetRelsPath,
  worksheetRelTarget
} from "@excel/utils/ooxml-paths";
import { StreamBuf } from "@excel/utils/stream-buf";
import type {
  OpaqueDrop,
  OpaquePart,
  OpaqueRelationship,
  OpaqueSourceRelationship
} from "@excel/xlsx/opaque-parts";
import {
  appendOpaqueSourceRelationships,
  collectOpaqueParts,
  isRelationshipsPart,
  opaqueContentTypeDeclarations,
  groupOpaqueRelationshipsBySource,
  ownerOfRelationshipsPart,
  relationshipsPathFor,
  resolveReachableOpaqueParts,
  resolveRelationshipTarget
} from "@excel/xlsx/opaque-parts";
import { RelType } from "@excel/xlsx/rel-type";
import type { ParsedExternalLink } from "@excel/xlsx/xform/book/external-link-xform";
import { ExternalLinkXform } from "@excel/xlsx/xform/book/external-link-xform";
import { WorkbookXform } from "@excel/xlsx/xform/book/workbook-xform";
import { ChartSpaceXform } from "@excel/xlsx/xform/chart/chart-space-xform";
import {
  parsePersonList,
  parseThreadedComments,
  renderPersonList,
  renderThreadedComments
} from "@excel/xlsx/xform/comment/threaded-comments-xform";
import { AppXform } from "@excel/xlsx/xform/core/app-xform";
import { ContentTypesXform } from "@excel/xlsx/xform/core/content-types-xform";
import { CoreXform } from "@excel/xlsx/xform/core/core-xform";
import { FeaturePropertyBagXform } from "@excel/xlsx/xform/core/feature-property-bag-xform";
import { MetadataXform } from "@excel/xlsx/xform/core/metadata-xform";
import type { RelationshipModel } from "@excel/xlsx/xform/core/relationship-xform";
import { RelationshipsXform } from "@excel/xlsx/xform/core/relationships-xform";
import type { ParsedPivotTableModel } from "@excel/xlsx/xform/pivot-table/pivot-table-xform";
import { WorkSheetXform } from "@excel/xlsx/xform/sheet/worksheet-xform";
import { SharedStringsXform } from "@excel/xlsx/xform/strings/shared-strings-xform";
import { StylesXform } from "@excel/xlsx/xform/style/styles-xform";
import { theme1Xml } from "@excel/xlsx/xml/theme1";
import type { IEventEmitter } from "@stream";
import { PassThrough } from "@stream";
import { concatUint8Arrays } from "@utils/binary";
import { bufferToString, base64ToUint8Array } from "@utils/utils";
import { uuidV4 } from "@utils/uuid";
import { xmlEncode, xmlEncodeAttr } from "@xml/encode";
import { XmlStreamWriter } from "@xml/stream-writer";
import type { XmlSink } from "@xml/types";
import { XmlWriter } from "@xml/writer";

type StreamListener = Parameters<IEventEmitter["on"]>[1];

/**
 * Event-emitter basics shared by every stream shape here. Aliased to the public
 * IO contract so the serializer and `Workbook.writeStream` cannot drift apart.
 */
type EmitterLike = XlsxEmitterLike;

export interface IParseStream extends EmitterLike {
  pipe(dest: any): any;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
}

/**
 * An in-memory buffered stream. Extends {@link XlsxWritable} with `read()` and
 * optional `toBuffer()` for callers that use the stream as a sink and then
 * harvest the accumulated bytes (e.g. `writeBuffer()`'s internal buffer).
 */
export interface IStreamBuf extends XlsxWritable {
  read(): Uint8Array | null;
  toBuffer?(): Uint8Array | null;
}

export interface IZipWriter extends EmitterLike {
  append(data: string | Uint8Array, options: { name: string; base64?: boolean }): void;
  /**
   * Create a streaming entry: write chunks incrementally, then call end().
   * The entry's compressed output is tracked internally, so a later
   * `waitForDrain()` observes it even when compression is asynchronous.
   */
  createEntry(name: string): { write(chunk: string): void; end(): void };
  pipe(stream: XlsxWritable): void;
  finalize(): void;
  /** Wait for downstream backpressure to clear. Resolves immediately if no backpressure. */
  waitForDrain(): Promise<void>;
}

class StreamingZipWriterAdapter implements IZipWriter {
  private static textEncoder = new TextEncoder();

  private readonly zip: StreamingZip;
  private readonly events: Map<string, Set<StreamListener>> = new Map();
  private pipedStream: Pick<XlsxWritable, "write" | "end"> | null = null;
  private level: number;
  private modTime: Date | undefined;
  private timestamps: ZipTimestampMode | undefined;
  private finalized = false;

  // Backpressure tracking
  private _needsDrain = false;
  private _drainResolvers: Array<() => void> = [];
  // Count of in-flight async write() calls whose backpressure result is unknown.
  // waitForDrain() must wait for this to reach 0 before checking _needsDrain.
  private _pendingWrites = 0;
  private _pendingWriteResolvers: Array<() => void> = [];
  private _drainGeneration = 0;
  private _sinkTerminated = false;
  private _sinkError: Error | null = null;
  // Compressed output that has been requested but has not reached the sink yet.
  // Browser deflate is asynchronous, so an entry's bytes are handed to
  // `pipedStream.write()` after the call that produced them has returned.
  // `waitForDrain()` joins these first, otherwise it would sample `_needsDrain`
  // before the sink ever saw the data and read a stale "no backpressure".
  private readonly _pendingOutput = new Set<Promise<void>>();

  // Buffer errors that occur before _finalize registers its error listener,
  // so async compression errors during writeToZip() are never silently lost.
  private _earlyError: Error | null = null;

  constructor(options?: ZipWriterOptions) {
    this.level = options?.level ?? 6;
    this.modTime = options?.modTime;
    this.timestamps = options?.timestamps;
    this.zip = new StreamingZip((err: Error | null, data: Uint8Array, final: boolean) => {
      if (err) {
        this._emit("error", err);
        return;
      }

      if (data && data.length > 0) {
        this._emit("data", data);
        if (this.pipedStream) {
          this._checkBackpressure(this.pipedStream.write(data));
        }
      }

      if (final) {
        if (this.pipedStream) {
          this.pipedStream.end();
        }
        this._emit("finish");
      }
    });
  }

  private _emit(event: string, ...args: any[]): void {
    // Buffer error events that fire before any listener is registered,
    // so _finalize() can surface them even if it registers late.
    if (event === "error") {
      const callbacks = this.events.get(event);
      if (!callbacks || callbacks.size === 0) {
        this._earlyError = args[0] instanceof Error ? args[0] : new Error(String(args[0]));
        return;
      }
    }
    const callbacks = this.events.get(event);
    if (!callbacks) {
      return;
    }
    for (const cb of callbacks) {
      cb(...args);
    }
  }

  /**
   * Handle backpressure from pipedStream.write().
   * Accepts both sync (boolean) and async (Promise<boolean>) return values.
   */
  private _checkBackpressure(ok: boolean | void | Promise<boolean>): void {
    if (ok && typeof (ok as PromiseLike<boolean>).then === "function") {
      this._pendingWrites++;
      const generation = this._drainGeneration;
      Promise.resolve(ok)
        .then(
          result => {
            if (!result && generation === this._drainGeneration) {
              this._needsDrain = true;
            }
          },
          () => {} // write errors surface via the stream's error event
        )
        .finally(() => {
          this._pendingWrites--;
          if (this._pendingWrites === 0) {
            const resolvers = this._pendingWriteResolvers.splice(0);
            for (const resolve of resolvers) {
              resolve();
            }
          }
        });
      return;
    }
    if (ok === false) {
      this._needsDrain = true;
    }
  }

  on(event: string, callback: StreamListener): this {
    const callbacks = this.events.get(event) || new Set<StreamListener>();
    callbacks.add(callback);
    this.events.set(event, callbacks);

    // If an error was buffered before any listener was registered, deliver it now.
    if (event === "error" && this._earlyError) {
      const err = this._earlyError;
      this._earlyError = null;
      callback(err);
    }

    return this;
  }

  once(event: string, callback: StreamListener): this {
    const wrapped: StreamListener = (...args: any[]) => {
      this.off(event, wrapped);
      callback(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, callback: StreamListener): this {
    const callbacks = this.events.get(event);
    if (!callbacks) {
      return this;
    }
    callbacks.delete(callback);
    if (callbacks.size === 0) {
      this.events.delete(event);
    }
    return this;
  }

  pipe(stream: XlsxWritable): void {
    this.pipedStream = stream;
    // Listen for drain events to resolve backpressure waiters
    if (stream && typeof stream.on === "function") {
      stream.on("drain", () => {
        this._drainGeneration++;
        this._needsDrain = false;
        const resolvers = this._drainResolvers.splice(0);
        for (const resolve of resolvers) {
          resolve();
        }
      });
      // Forward sink errors to the zip pipeline. Without this, a user sink
      // that errors mid-write (write failure, EPIPE, abort, etc) would leave
      // `_finalize()` hanging forever — `writeToZip` keeps writing into a
      // dead sink, but `_finalize`'s 'finish'/'error' listeners on the zip
      // adapter never fire because nothing tells the adapter the sink died.
      stream.on("error", (err: Error) => {
        this._sinkTerminated = true;
        this._sinkError = err;
        this._emit("error", err);
        // Wake any backpressure waiters so writeToZip's `await zip.waitForDrain()`
        // returns instead of hanging forever for a 'drain' that will never come.
        this._needsDrain = false;
        const resolvers = this._drainResolvers.splice(0);
        for (const resolve of resolvers) {
          resolve();
        }
        const asyncResolvers = this._pendingWriteResolvers.splice(0);
        for (const resolve of asyncResolvers) {
          resolve();
        }
      });
      stream.on("close", () => {
        if (this.finalized || this._sinkTerminated) {
          return;
        }
        this._sinkTerminated = true;
        this._sinkError = new ExcelStreamStateError(
          "write",
          "destination closed before XLSX serialization finished"
        );
        this._emit("error", this._sinkError);
        this._needsDrain = false;
        const resolvers = this._drainResolvers.splice(0);
        for (const resolve of resolvers) {
          resolve();
        }
        const asyncResolvers = this._pendingWriteResolvers.splice(0);
        for (const resolve of asyncResolvers) {
          resolve();
        }
      });
    }
  }

  /**
   * Track one entry's compressed output until it has been handed to the sink.
   * Only settlement matters here: compression failures travel through the
   * `'error'` channel (`StreamingZip` reports them via the adapter callback),
   * and swallowing the rejection keeps them from surfacing twice.
   */
  private _trackOutput(output: Promise<void>): void {
    const settled = output.then(
      () => {},
      () => {}
    );
    this._pendingOutput.add(settled);
    void settled.then(() => {
      this._pendingOutput.delete(settled);
    });
  }

  /**
   * Wait for the downstream writable to drain if it signaled backpressure.
   * If any write() calls are still in-flight (returned a Promise that hasn't
   * settled), waits for all of them first so the backpressure signal isn't missed.
   */
  async waitForDrain(): Promise<void> {
    // Let every byte produced so far reach the sink before asking whether it
    // wants us to pause; see `_pendingOutput`.
    if (this._pendingOutput.size > 0) {
      await Promise.all([...this._pendingOutput]);
    }
    // Wait for all in-flight async writes to settle so _needsDrain is up to date.
    if (this._pendingWrites > 0) {
      await new Promise<void>(resolve => {
        this._pendingWriteResolvers.push(resolve);
      });
    }
    if (this._sinkError) {
      throw this._sinkError;
    }
    if (!this._needsDrain || !this.pipedStream) {
      return;
    }
    return new Promise<void>(resolve => {
      this._drainResolvers.push(resolve);
    });
  }

  append(data: any, options: { name: string; base64?: boolean }): void {
    if (this.finalized) {
      throw new ExcelStreamStateError("append", "stream already finalized");
    }

    let buffer: Uint8Array;
    if (options.base64) {
      buffer = base64ToUint8Array(typeof data === "string" ? data : String(data));
    } else if (typeof data === "string") {
      buffer = StreamingZipWriterAdapter.textEncoder.encode(data);
    } else if (data instanceof Uint8Array) {
      buffer = data;
    } else if (ArrayBuffer.isView(data)) {
      buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      buffer = new Uint8Array(data);
    } else {
      buffer = data;
    }

    const file = new ZipDeflateFile(options.name, {
      level: this.level,
      modTime: this.modTime,
      timestamps: this.timestamps
    });
    this.zip.add(file);

    this._trackOutput(file.push(buffer, true));
  }

  createEntry(name: string): { write(chunk: string): void; end(): void } {
    if (this.finalized) {
      throw new ExcelStreamStateError("createEntry", "stream already finalized");
    }
    const file = new ZipDeflateFile(name, {
      level: this.level,
      modTime: this.modTime,
      timestamps: this.timestamps
    });
    this.zip.add(file);
    const encoder = StreamingZipWriterAdapter.textEncoder;
    return {
      write(chunk: string): void {
        file.push(encoder.encode(chunk));
      },
      end: (): void => {
        this._trackOutput(file.push(new Uint8Array(0), true));
      }
    };
  }

  finalize(): void {
    if (this.finalized) {
      return;
    }
    this.finalized = true;
    this.zip.end();
  }
}

// =============================================================================
// Minimal shared types (keep internal model flexible)
// =============================================================================

/**
 * Options for reading (loading) an XLSX workbook.
 *
 * The option set is closed. It used to carry an `[key: string]: unknown` index
 * signature "for forward compatibility", which in practice meant a misspelled or
 * unsupported option type-checked and was then silently ignored — the failure
 * mode a typed options bag exists to prevent. A new option is a new declared
 * field here.
 */
export interface XlsxReadOptions {
  /**
   * When the input to `load()` is a string, interpret it as a base64-encoded
   * zip archive instead of a binary buffer. Defaults to `false`.
   */
  base64?: boolean;
  /**
   * Maximum number of rows to parse from each worksheet. Rows beyond this
   * limit are silently skipped. Useful for previewing very large sheets
   * without loading everything into memory.
   */
  maxRows?: number;
  /**
   * Maximum number of columns to parse from each worksheet. Columns beyond
   * this limit are silently skipped. Useful for previewing very wide sheets.
   */
  maxCols?: number;
  /**
   * List of worksheet XML node names to skip while parsing (e.g.
   * `"dataValidations"`, `"conditionalFormatting"`). Use for workbooks that
   * contain corrupted or unsupported elements you want to ignore.
   */
  ignoreNodes?: string[];
}

export interface ZipWriterOptions {
  level?: number;
  /** ZIP entry modification time (optional). If omitted, defaults to current time. */
  modTime?: Date;
  /** Timestamp writing strategy for ZIP entry metadata (optional). */
  timestamps?: ZipTimestampMode;
}

export type XlsxTemplateMode = "preserve" | "strict";

/**
 * Options for writing an XLSX workbook.
 *
 * The option set is closed — see {@link XlsxReadOptions} for why. This matters
 * more here than on the read side: a write option that is accepted and dropped
 * produces a file that differs from what the caller asked for, with nothing
 * anywhere reporting it.
 */
export interface XlsxWriteOptions {
  /** ZIP archive options (compression level, timestamps, ...). */
  zip?: ZipWriterOptions;
  /**
   * Use a shared-string table for cell text values. Defaults to `true`.
   * Set to `false` to write string values inline (larger file, but streams
   * better for very large sheets).
   */
  useSharedStrings?: boolean;
  /**
   * Emit style definitions (fonts, fills, borders, number formats, …).
   * Defaults to `true`. Set to `false` to skip style blocks for maximum
   * compatibility with minimal readers.
   */
  useStyles?: boolean;
  /**
   * Template fidelity strategy for loaded workbooks. The default `"preserve"`
   * byte-preserves clean chart parts and may structurally re-render edited parts
   * when no safe raw XML patch is available. `"strict"` fails the write instead
   * of re-rendering any edited loaded chart/chartEx part that cannot be patched
   * in-place, preventing silent loss of unknown template XML.
   *
   * When a strict write fails, the thrown error enumerates the unrecognised
   * `c15:`/`cx14:` extension paths the parser observed, so authors can decide
   * between relaxing the mode or reshaping the mutation into a patch-friendly
   * path. To inspect those paths *before* writing (for example to decide
   * whether to opt into strict mode at all), use {@link Chart.unknownElements}
   * on each chart of interest.
   */
  templateMode?: XlsxTemplateMode;
  /**
   * Convenience alias for `templateMode: "strict"`. Strict mode refuses to
   * silently drop vendor-extension XML (`c15:…`, `cx14:…`) that the
   * structured parser does not understand. Use this when round-tripping
   * Excel-authored template files where preserving exotic extension
   * elements matters more than the ability to re-render modified charts.
   */
  strictTemplateMode?: boolean;
  /**
   * Run the OOXML self-check on the produced bytes and `console.warn`
   * every detected problem. Only {@link XLSX.writeBuffer} honours this
   * flag — `write(stream)` / `writeFile` cannot post-validate because
   * their output is streamed to the caller.
   *
   * Default resolution:
   *   - In Node.js with `NODE_ENV !== "production"` and NOT running
   *     under vitest (`process.env.VITEST !== "true"`): `true`.
   *   - In production, in the browser, or under vitest: `false`.
   *
   * The vitest carve-out exists because running validation on every
   * `writeBuffer` call inflates fixture `beforeAll` hooks that build
   * hundreds of workbooks by ~50 seconds on typical hardware. Tests
   * that want validation use {@link expectValidXlsx} directly.
   *
   * Pass `true` to force validation (even in production or under
   * vitest), or `false` to suppress it (even in development). The
   * self-check never throws: a failed validation becomes a warning so
   * writers that intentionally produce non-conformant xlsx for
   * testing keep working.
   *
   * @see OoxmlValidationReport
   */
  validate?: boolean;
}

export type XlsxOptions = XlsxReadOptions & XlsxWriteOptions;

export interface WorkbookMediaLike {
  type: string;
  extension: string;
  name?: string;
  filename?: string;
  buffer?: Uint8Array;
  base64?: string;
  /** External link target — when set, the image is referenced, not embedded. */
  link?: string;
}

export interface MediaModel {
  media: WorkbookMediaLike[];
}

interface ZipEntryLike {
  name: string;
  // Mirrors the `type` field on streaming ZipEntry. Symlink detection in
  // streaming parsers is best-effort; for XLSX (which contains no symlinks)
  // this is effectively "Directory" | "File" at runtime.
  type: "Directory" | "File" | "Symlink";
  stream: IParseStream;
  drain: () => Promise<void>;
}

/**
 * Extract the trailing integer from a workbook-rels Target like
 * `"externalLinks/externalLink12.xml"` (a path relative to `xl/`). Mirror
 * of {@link getExternalLinkIndexFromPath} which takes the full
 * `xl/externalLinks/…` form. Used during reconcile to bridge the
 * workbook.xml.rels entry to the parsed externalLinkN.xml part.
 */
function externalLinkIndexFromRelTarget(target: string): number | undefined {
  const match = /(?:^|\/)externalLink(\d+)[.]xml$/.exec(target);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Add `sheetName` to an ExternalLinkModel's `sheetNames` list if it isn't
 * already present. Ordering is preserved — the first-seen sheet wins
 * position 0, which matches what Excel does when writing externalLinks
 * itself.
 */
function upsertSheet(link: { sheetNames: string[] }, sheetName: string): void {
  if (!sheetName) {
    return;
  }
  if (!link.sheetNames.includes(sheetName)) {
    link.sheetNames.push(sheetName);
  }
}

/**
 * Scratch state used during `_normaliseExternalLinks`. `links` is the
 * write-scoped ExternalLinkModel array (user-declared + auto-discovered)
 * the writer will consume; `byTarget` indexes it by lower-cased target
 * for O(1) lookup during formula rewriting; `workbook` is used to
 * persist auto-discoveries to the Workbook's private cache so subsequent
 * writes stay consistent without mutating `wb.externalLinks`.
 */
interface NormaliseScratch {
  links: ExternalLinkModel[];
  byTarget: Map<string, ExternalLinkModel>;
  workbook: Workbook;
}

/**
 * Shape of a parsed externalLinkN.xml.rels entry. Kept broad so any
 * relationship type passes through verbatim — the writer only cares about
 * the ExternalLinkPath entry, but we preserve the rest for round-trip.
 */
type ExternalLinkRelsEntry = {
  Id: string;
  Type: string;
  Target: string;
  TargetMode?: string;
};

function snapshotChartModel(model: unknown): string | undefined {
  try {
    return JSON.stringify(model);
  } catch {
    return undefined;
  }
}

/**
 * Extract leading XML comments that appear immediately before a target
 * element's open tag in an OOXML chart part. We use this to preserve
 * vendor / annotation comments (e.g. style provenance markers) when the
 * chart writer falls back to a structured rebuild — `BaseXform.parseStreamDirect`
 * does not surface `comment` events, so the structured model has no
 * memory of them.
 *
 * Returns the substring of comment nodes (whitespace stripped, joined
 * by no separator). Empty string when no comment precedes the open tag.
 */
/**
 * Build the chartsheet-drawing XML that wraps a single classic or
 * ChartEx chart occupying the entire chartsheet canvas.
 *
 * Chartsheets have no cell grid — `sheetData` is empty and there are
 * no `<cols>` / `<row>` sizing entries for Excel to lay an anchor
 * against. A cell-based `<xdr:twoCellAnchor from="A1" to="R31"/>`
 * (what the generic `DrawingXform` emits) therefore resolves to a
 * 0×0 bounding box on a chartsheet, and Excel renders a blank
 * white canvas with no chart inside. Using `<xdr:absoluteAnchor>`
 * with concrete EMU coordinates is how Excel itself writes
 * chartsheet drawings — the anchor's `pos`/`ext` pair gives the
 * engine something real to lay the graphic against, while the
 * inner `<xdr:graphicFrame>/<xdr:xfrm>` repeats the extent so the
 * graphic is sized to fill the anchor.
 *
 * ChartEx drawings additionally need an `<mc:AlternateContent>`
 * wrapper around the `<xdr:graphicFrame>` — the `cx` namespace is
 * a Microsoft extension that legacy-Excel loaders don't understand,
 * so the Fallback branch emits a placeholder shape (the same
 * "This chart isn't available in your version of Excel" message
 * Office uses).
 */
function renderChartsheetDrawingXml(options: {
  chartRId: string;
  chartName: string;
  isChartEx: boolean;
  extCx: number;
  extCy: number;
}): string {
  const { chartRId, chartName, isChartEx, extCx, extCy } = options;
  const escName = xmlEncodeAttr(chartName);
  const escRId = xmlEncodeAttr(chartRId);
  const cNvPrExtLst = isChartEx
    ? `<a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{${uuidV4().toUpperCase()}}"/></a:ext></a:extLst>`
    : "";
  const graphicFrame =
    `<xdr:graphicFrame macro="">` +
    `<xdr:nvGraphicFramePr>` +
    (cNvPrExtLst
      ? `<xdr:cNvPr id="1" name="${escName}">${cNvPrExtLst}</xdr:cNvPr>`
      : `<xdr:cNvPr id="1" name="${escName}"/>`) +
    `<xdr:cNvGraphicFramePr/>` +
    `</xdr:nvGraphicFramePr>` +
    `<xdr:xfrm>` +
    `<a:off x="0" y="0"/>` +
    `<a:ext cx="${extCx}" cy="${extCy}"/>` +
    `</xdr:xfrm>` +
    `<a:graphic>` +
    (isChartEx
      ? `<a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex">` +
        `<cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${escRId}"/>` +
        `</a:graphicData>`
      : `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
        `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${escRId}"/>` +
        `</a:graphicData>`) +
    `</a:graphic>` +
    `</xdr:graphicFrame>`;

  const fallbackShape =
    `<xdr:sp macro="" textlink="">` +
    `<xdr:nvSpPr>` +
    `<xdr:cNvPr id="0" name=""/>` +
    `<xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr>` +
    `</xdr:nvSpPr>` +
    `<xdr:spPr>` +
    `<a:xfrm>` +
    `<a:off x="0" y="0"/>` +
    `<a:ext cx="${extCx}" cy="${extCy}"/>` +
    `</a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:prstClr val="white"/></a:solidFill>` +
    `<a:ln w="1"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln>` +
    `</xdr:spPr>` +
    `<xdr:txBody>` +
    `<a:bodyPr vertOverflow="clip" horzOverflow="clip"/>` +
    `<a:lstStyle/>` +
    `<a:p><a:r><a:rPr lang="en-US" sz="1100"/>` +
    `<a:t>This chart isn&apos;t available in your version of Excel.\n\n` +
    `Editing this shape or saving this workbook into a different file format will permanently break the chart.</a:t>` +
    `</a:r></a:p>` +
    `</xdr:txBody>` +
    `</xdr:sp>`;

  const anchorBody = isChartEx
    ? `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
      `<mc:Choice xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" Requires="cx1">` +
      graphicFrame +
      `</mc:Choice>` +
      `<mc:Fallback>` +
      fallbackShape +
      `</mc:Fallback>` +
      `</mc:AlternateContent>`
    : graphicFrame;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<xdr:absoluteAnchor>` +
    `<xdr:pos x="0" y="0"/>` +
    `<xdr:ext cx="${extCx}" cy="${extCy}"/>` +
    anchorBody +
    `<xdr:clientData/>` +
    `</xdr:absoluteAnchor>` +
    `</xdr:wsDr>`
  );
}

function extractLeadingComments(originalXml: string, openTagRegex: RegExp): string {
  const m = openTagRegex.exec(originalXml);
  if (!m) {
    return "";
  }
  const before = originalXml.slice(0, m.index);
  // Walk backwards collecting consecutive `<!--…-->` blocks (with
  // optional whitespace between them and the open tag).
  const comments: string[] = [];
  let cursor = before.length;
  while (cursor > 0) {
    // Skip trailing whitespace
    let head = cursor;
    while (head > 0 && /\s/.test(before.charAt(head - 1))) {
      head--;
    }
    // Look for `-->` ending right at `head`
    if (head < 3 || before.slice(head - 3, head) !== "-->") {
      break;
    }
    // Find the matching `<!--` start
    const start = before.lastIndexOf("<!--", head - 3);
    if (start < 0) {
      break;
    }
    comments.unshift(before.slice(start, head));
    cursor = start;
  }
  return comments.join("");
}

/**
 * Render a chart part (classic) to bytes via `XmlWriter`, then splice
 * preserved leading comments from the original raw XML in front of the
 * `<c:chart>` open tag. If the original has no leading comments or no
 * `rawData` is available, returns the unmodified rendered bytes.
 */
function renderChartWithLeadingComments(
  entry: ChartEntry,
  xform: { render(xmlStream: XmlSink, model?: unknown): void }
): Uint8Array {
  const writer = new XmlWriter();
  xform.render(writer, entry.model);
  let xml = writer.toString();
  if (entry.rawData) {
    const originalXml = new TextDecoder().decode(entry.rawData);
    const comments = extractLeadingComments(originalXml, /<c:chart(?:\s|>)/);
    if (comments) {
      xml = xml.replace(/<c:chart(\s|>)/, `${comments}<c:chart$1`);
    }
  }
  return new TextEncoder().encode(xml);
}

/**
 * Splice preserved leading comments from a ChartEx raw XML buffer into
 * a freshly-rendered structural rebuild output.
 */
function spliceChartExLeadingComments(
  renderedXml: string,
  originalRawXml: string | undefined
): string {
  if (!originalRawXml) {
    return renderedXml;
  }
  const comments = extractLeadingComments(originalRawXml, /<cx:chart(?:\s|>)/);
  if (!comments) {
    return renderedXml;
  }
  return renderedXml.replace(/<cx:chart(\s|>)/, `${comments}<cx:chart$1`);
}

function shouldPassthroughChartEntry(
  entry: ChartEntry
): entry is ChartEntry & { rawData: Uint8Array } {
  if (!entry.rawData || entry.dirty) {
    return false;
  }
  if (entry.modelSnapshot === undefined) {
    return true;
  }
  return snapshotChartModel(entry.model) === entry.modelSnapshot;
}

function shouldPassthroughChartExEntry(
  entry: ChartExEntry
): entry is ChartExEntry & { rawData: Uint8Array } {
  if (!entry.rawData || entry.dirty) {
    return false;
  }
  if (entry.modelSnapshot === undefined) {
    return true;
  }
  return snapshotChartModel(entry.model) === entry.modelSnapshot;
}

function stripChartExRawXml(model: ChartExModel): ChartExModel {
  return { ...model, rawXml: undefined };
}

function isStrictTemplateMode(options?: XlsxWriteOptions): boolean {
  return options?.templateMode === "strict" || options?.strictTemplateMode === true;
}

/**
 * Decide whether `writeBuffer` should run the OOXML self-check after
 * producing bytes. Resolves the `validate` option against the current
 * environment:
 *
 *   - Explicit `true` / `false` → honoured as-is.
 *   - `undefined` (default)     → `true` in non-production Node.js
 *                                 when NOT running under vitest. We
 *                                 detect vitest via `process.env.VITEST`
 *                                 to avoid adding multi-second
 *                                 validation overhead to fixture
 *                                 `beforeAll` hooks that produce
 *                                 hundreds of workbooks (the chartEx
 *                                 preset corpus alone builds ~100
 *                                 fixtures per run — at ~450 ms each
 *                                 that is a 45 s penalty on every full
 *                                 suite execution). Vitest tests that
 *                                 need validation call
 *                                 `expectValidXlsx()` explicitly.
 *                                 `false` in production and in the
 *                                 browser where `process` is absent.
 *
 * Kept as a module-level helper so the resolution rule is testable in
 * isolation and so subclasses can override by passing an explicit
 * `validate` flag rather than re-implementing the default logic.
 */
function shouldAutoValidate(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  // In the browser `process` is undefined; skip the overhead there.
  if (typeof process === "undefined" || !process.env) {
    return false;
  }
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  // Vitest sets VITEST=true automatically in its worker processes.
  // Skip the auto-check there; tests opt-in via `expectValidXlsx`.
  if (process.env.VITEST === "true") {
    return false;
  }
  return true;
}

/**
 * Run `validateXlsxBuffer` on writer output and emit a consolidated
 * `console.warn` for every detected problem. Never throws: a validator
 * exception is degraded to a warning so writers that intentionally
 * produce non-conformant xlsx (e.g. for negative-path tests) keep
 * working. The message includes the actionable opt-out so downstream
 * consumers know how to silence it without grepping docs.
 */
async function runWriteBufferSelfCheck(bytes: Uint8Array): Promise<void> {
  try {
    // Dynamic import: the OOXML validator (~66 KB) is a development-only
    // self-check that never runs in production (see `shouldAutoValidate`).
    // Loading it lazily keeps it out of consumer bundles entirely.
    const { validateXlsxBuffer } = await import("@excel/utils/ooxml-validator");
    const report = await validateXlsxBuffer(bytes, { maxProblems: 20 });
    if (report.ok) {
      return;
    }
    const summary = report.problems
      .map((p, i) => `  ${i + 1}. [${p.kind}] ${p.file ?? "<package>"}: ${p.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.warn(
      `[documonster] writeBuffer() produced xlsx with ${report.problems.length} OOXML issue(s):\n` +
        `${summary}\n` +
        `Pass \`{ validate: false }\` to silence this self-check, or set NODE_ENV=production.`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[documonster] writeBuffer() self-check threw unexpectedly and was skipped: ${String(err)}`
    );
  }
}

function hasChartEntryChanged(entry: ChartEntry): boolean {
  if (!entry.rawData) {
    return false;
  }
  if (entry.dirty) {
    return true;
  }
  if (entry.modelSnapshot === undefined) {
    return false;
  }
  return snapshotChartModel(entry.model) !== entry.modelSnapshot;
}

function hasChartExEntryChanged(entry: ChartExEntry): boolean {
  if (!entry.rawData) {
    return false;
  }
  if (entry.dirty) {
    return true;
  }
  if (entry.modelSnapshot === undefined) {
    return false;
  }
  return snapshotChartModel(entry.model) !== entry.modelSnapshot;
}

function shouldRequireChartRawPatch(entry: ChartEntry, strictTemplateMode: boolean): boolean {
  return !!entry.requireRawPatch || (strictTemplateMode && hasChartEntryChanged(entry));
}

function shouldRequireChartExRawPatch(entry: ChartExEntry, strictTemplateMode: boolean): boolean {
  return !!entry.requireRawPatch || (strictTemplateMode && hasChartExEntryChanged(entry));
}

/**
 * Assemble the error message thrown when a loaded chartEx part cannot be
 * raw-patched but the caller required it (either `requireRawPatch` on the
 * entry or `strictTemplateMode` at the writer). Surfaces any unknown XML
 * elements the parser noticed so the author can decide whether to relax
 * the requirement or adjust the mutation shape.
 */
function buildChartExStrictFailureMessage(entryName: string, model: ChartExEntry["model"]): string {
  const base =
    `ChartEx ${entryName} requires raw XML patching ` +
    `(requireRawPatch/strict template mode), but the mutation cannot be safely applied as a raw XML patch.`;
  const unknown = (model as { unknownElements?: Array<{ path: string }> })?.unknownElements;
  return appendUnknownElementsSummary(base, unknown);
}

/**
 * Classic-chart counterpart of {@link buildChartExStrictFailureMessage}.
 * Pulls `unknownElements` off the {@link ChartModel} so the same
 * "you are about to silently drop these vendor extensions" warning is
 * surfaced when strict template mode refuses a re-render.
 */
function buildChartStrictFailureMessage(entryName: string, model: ChartEntry["model"]): string {
  const base =
    `Chart ${entryName} requires raw XML patching ` +
    `(requireRawPatch/strict template mode), but the mutation cannot be safely applied as a raw XML patch.`;
  const unknown = (model as { unknownElements?: Array<{ path: string }> })?.unknownElements;
  return appendUnknownElementsSummary(base, unknown);
}

function appendUnknownElementsSummary(
  base: string,
  unknown: Array<{ path: string }> | undefined
): string {
  if (!unknown || unknown.length === 0) {
    return base;
  }
  // De-duplicate by path; real files often repeat the same extension element
  // across multiple series/axes and noise doesn't help diagnosis.
  const uniquePaths = Array.from(new Set(unknown.map(entry => entry.path))).slice(0, 8);
  const extra =
    unknown.length > uniquePaths.length
      ? ` (showing ${uniquePaths.length} of ${unknown.length})`
      : "";
  return (
    `${base} The loaded part contains unstructured XML at: ${uniquePaths.join(", ")}${extra}. ` +
    `Rebuilding the part would discard these extensions; adjust the mutation to a ` +
    `patch-friendly shape or relax strictTemplateMode.`
  );
}

function tryPatchChartExRawXml(entry: ChartExEntry, forceRawPatch = false): Uint8Array | undefined {
  if (
    !entry.rawData ||
    (!entry.preferRawPatch && !forceRawPatch) ||
    !hasChartExEntryChanged(entry)
  ) {
    return undefined;
  }
  const patchPlan = getChartExRawPatchPlan(entry);
  if (patchPlan === undefined) {
    return undefined;
  }
  const raw = new TextDecoder().decode(entry.rawData);
  const chartRange = findXmlBlock(raw, "cx:chartSpace");
  if (!chartRange) {
    return undefined;
  }
  const chartBlock = raw.slice(chartRange.start, chartRange.end);
  const patchedChartBlock = patchRawChartExChartBlock(chartBlock, entry.model, patchPlan);
  if (patchedChartBlock === undefined) {
    return undefined;
  }
  const patched = raw.slice(0, chartRange.start) + patchedChartBlock + raw.slice(chartRange.end);

  return patched !== raw ? new TextEncoder().encode(patched) : undefined;
}

type RawPatchListPlan<T> = true | T[] | false;

interface ChartExSeriesRawPatchPlan {
  hidden: boolean;
  ownerIdx: boolean;
  tx: boolean;
  dataRefs: boolean;
  layoutPr: boolean;
  axisId: boolean;
  dataLabels: boolean;
  spPr: boolean;
  dataPoints: boolean;
}

interface ChartExAxisRawPatchPlan {
  hidden: boolean;
  majorTickMark: boolean;
  minorTickMark: boolean;
  numFmt: boolean;
  title: boolean;
  valScaling: boolean;
  catScaling: boolean;
  spPr: boolean;
  txPr: boolean;
}

interface ChartExRawPatchPlan {
  data: boolean;
  title: boolean;
  legend: boolean;
  autoTitleDeleted: boolean;
  /** `<cx:chartSpace/cx:spPr>` — chart-frame shape properties. Renamed
   *  from the legacy `chartSpPr` after `ChartExChart.spPr` was removed
   *  (it was a schema violation — see the parser migration path). */
  chartSpaceSpPr: boolean;
  plotAreaSpPr: boolean;
  plotSurface: boolean;
  series: RawPatchListPlan<ChartExSeriesRawPatchPlan>;
  axes: RawPatchListPlan<ChartExAxisRawPatchPlan>;
}

interface ChartSeriesRawPatchPlan {
  tx: boolean;
  spPr: boolean;
  marker: boolean;
  dataPoints: boolean;
  trendlines: boolean;
  errorBars: boolean;
  cat: boolean;
  val: boolean;
  xVal: boolean;
  yVal: boolean;
  bubbleSize: boolean;
  dataLabels: boolean;
}

interface ChartAxisRawPatchPlan {
  scaling: boolean;
  delete: boolean;
  title: boolean;
  numFmt: boolean;
  majorGridlines: boolean;
  minorGridlines: boolean;
  majorTickMark: boolean;
  minorTickMark: boolean;
  tickLblPos: boolean;
  spPr: boolean;
  txPr: boolean;
  crosses: boolean;
  crossesAt: boolean;
  auto: boolean;
  lblAlgn: boolean;
  lblOffset: boolean;
  tickLblSkip: boolean;
  tickMarkSkip: boolean;
  noMultiLvlLbl: boolean;
  crossBetween: boolean;
  majorUnit: boolean;
  minorUnit: boolean;
  baseTimeUnit: boolean;
  majorTimeUnit: boolean;
  minorTimeUnit: boolean;
}

function getChartExRawPatchPlan(entry: ChartExEntry): ChartExRawPatchPlan | undefined {
  if (entry.modelSnapshot === undefined) {
    return {
      title: true,
      data: true,
      legend: true,
      autoTitleDeleted: true,
      chartSpaceSpPr: true,
      plotAreaSpPr: true,
      plotSurface: true,
      series: true,
      axes: true
    };
  }
  let previous: any;
  try {
    previous = JSON.parse(entry.modelSnapshot);
  } catch {
    return undefined;
  }
  const current = entry.model;
  if (!sameJson(stripPatchableChartExFields(previous), stripPatchableChartExFields(current))) {
    return undefined;
  }
  const prevChart = previous.chartSpace?.chart;
  const curChart = current.chartSpace?.chart;
  const series = buildChartExSeriesRawPatchPlan(previous, current);
  const axes = buildChartExAxisRawPatchPlan(
    prevChart?.plotArea?.axis ?? [],
    curChart?.plotArea?.axis ?? []
  );
  const plan = {
    data: !sameJson(previous.chartSpace?.chartData, current.chartSpace?.chartData),
    title: !sameJson(prevChart?.title, curChart?.title),
    legend: !sameJson(prevChart?.legend, curChart?.legend),
    autoTitleDeleted: !sameJson(prevChart?.autoTitleDeleted, curChart?.autoTitleDeleted),
    // Chart-frame styling lives on `CT_ChartSpace/spPr` in Chart2014,
    // not on `CT_Chart`. Diff the correct slot; the `ChartExChart.spPr`
    // field has been removed from the type.
    chartSpaceSpPr: !sameJson(previous.chartSpace?.spPr, current.chartSpace?.spPr),
    plotAreaSpPr: !sameJson(prevChart?.plotArea?.spPr, curChart?.plotArea?.spPr),
    plotSurface: !sameJson(
      prevChart?.plotArea?.plotAreaRegion?.plotSurface,
      curChart?.plotArea?.plotAreaRegion?.plotSurface
    ),
    series,
    axes
  };
  return plan.data ||
    plan.title ||
    plan.legend ||
    plan.autoTitleDeleted ||
    plan.chartSpaceSpPr ||
    plan.plotAreaSpPr ||
    plan.plotSurface ||
    hasRawPatchListChanges(plan.series) ||
    hasRawPatchListChanges(plan.axes)
    ? plan
    : undefined;
}

function buildChartExSeriesRawPatchPlan(previous: any, current: any): ChartExSeriesRawPatchPlan[] {
  const previousSeries = extractChartExSeries(previous);
  const currentSeries = extractChartExSeries(current);
  return currentSeries.map((series, index) => {
    const prev = previousSeries[index] ?? {};
    return {
      hidden: !sameJson(prev.hidden, series.hidden),
      ownerIdx: !sameJson(prev.ownerIdx, series.ownerIdx),
      tx: !sameJson(prev.tx, series.tx),
      dataRefs: !sameJson(prev.dataRefs, series.dataRefs),
      layoutPr: !sameJson(prev.layoutPr, series.layoutPr),
      axisId: !sameJson(prev.axisId, series.axisId),
      dataLabels: !sameJson(prev.dataLabels, series.dataLabels),
      spPr: !sameJson(prev.spPr, series.spPr),
      dataPoints: !sameJson(prev.dataPt, series.dataPt)
    };
  });
}

function buildChartExAxisRawPatchPlan(
  previousAxes: any[],
  currentAxes: any[]
): ChartExAxisRawPatchPlan[] {
  const previousById = new Map(previousAxes.map(axis => [axis.axisId, axis]));
  return currentAxes.map(axis => {
    const prev = previousById.get(axis.axisId) ?? {};
    return {
      hidden: !sameJson(prev.hidden, axis.hidden),
      majorTickMark: !sameJson(prev.majorTickMark, axis.majorTickMark),
      minorTickMark: !sameJson(prev.minorTickMark, axis.minorTickMark),
      numFmt: !sameJson(prev.numFmt, axis.numFmt),
      title: !sameJson(prev.title, axis.title),
      valScaling: !sameJson(prev.valScaling, axis.valScaling),
      catScaling: !sameJson(prev.catScaling, axis.catScaling),
      spPr: !sameJson(prev.spPr, axis.spPr),
      txPr: !sameJson(prev.txPr, axis.txPr)
    };
  });
}

function stripPatchableChartExFields(model: any): any {
  const clone = structuredClone(model);
  clone.rawXml = undefined;
  // Vendor / extension metadata the parser recorded but the raw patcher
  // does not rewrite. Letting them differ in the diff keeps
  // `getChartExRawPatchPlan` from giving up on fast-path patches for
  // loaded templates that carry c14/c15/c16 extensions. The patcher
  // never touches these bytes, so the raw XML already preserves them
  // verbatim.
  clone.unknownElements = undefined;
  if (clone.chartSpace) {
    clone.chartSpace.chartData = undefined;
    clone.chartSpace.clrMapOvr = undefined;
    clone.chartSpace.extLst = undefined;
  }
  if (clone.chartSpace?.chart) {
    clone.chartSpace.chart.title = undefined;
    clone.chartSpace.chart.legend = undefined;
    clone.chartSpace.chart.autoTitleDeleted = undefined;
    // NOTE: `chart.spPr` was previously cleared here, but the field
    // has been removed from `ChartExChart` (see the migration in
    // chart-ex-parser); the writer now emits chart-frame styling from
    // `chartSpace.spPr` only.
    if (clone.chartSpace.chart.plotArea) {
      clone.chartSpace.chart.plotArea.spPr = undefined;
      clone.chartSpace.chart.plotArea.axis = undefined;
      if (clone.chartSpace.chart.plotArea.plotAreaRegion) {
        clone.chartSpace.chart.plotArea.plotAreaRegion.layout = undefined;
        clone.chartSpace.chart.plotArea.plotAreaRegion.plotSurface = undefined;
        clone.chartSpace.chart.plotArea.plotAreaRegion.series = (
          clone.chartSpace.chart.plotArea.plotAreaRegion.series ?? []
        ).map(stripPatchableChartExSeriesFields);
      }
      if (clone.chartSpace.chart.plotArea.series) {
        clone.chartSpace.chart.plotArea.series = clone.chartSpace.chart.plotArea.series.map(
          stripPatchableChartExSeriesFields
        );
      }
    }
  }
  return clone;
}

function stripPatchableChartExSeriesFields(series: any): any {
  return {
    ...series,
    hidden: undefined,
    ownerIdx: undefined,
    tx: undefined,
    spPr: undefined,
    dataRefs: undefined,
    layoutPr: undefined,
    axisId: undefined,
    dataLabels: undefined,
    dataPt: undefined
  };
}

function extractChartExSeries(model: any): any[] {
  const plotArea = model.chartSpace?.chart?.plotArea;
  return plotArea?.plotAreaRegion?.series ?? plotArea?.series ?? [];
}

function patchRawChartExChartBlock(
  block: string,
  model: any,
  patchPlan: ChartExRawPatchPlan
): string | undefined {
  let patched = block;
  const chart = model.chartSpace?.chart;
  if (!chart) {
    return undefined;
  }
  if (patchPlan.data) {
    const dataRange = findXmlBlock(patched, "cx:chartData");
    if (!dataRange) {
      return undefined;
    }
    const dataXml = buildRawChartExDataXml(model.chartSpace?.chartData);
    patched = patched.slice(0, dataRange.start) + dataXml + patched.slice(dataRange.end);
  }
  if (patchPlan.title) {
    const titleText = chart.title?.text?.paragraphs?.[0]?.runs?.[0]?.text;
    patched =
      titleText !== undefined
        ? replaceOrInsertBeforeGeneric(
            patched,
            "cx:title",
            buildRawChartExTitleXml(titleText),
            ["cx:autoTitleDeleted", "cx:plotArea", "cx:legend", "cx:spPr"],
            "cx:chart"
          )
        : removeXmlBlock(patched, "cx:title");
  }
  if (patchPlan.autoTitleDeleted) {
    patched =
      chart.autoTitleDeleted !== undefined
        ? replaceOrInsertBeforeGeneric(
            patched,
            "cx:autoTitleDeleted",
            `<cx:autoTitleDeleted val="${chart.autoTitleDeleted ? "1" : "0"}"/>`,
            ["cx:plotArea", "cx:legend", "cx:spPr"],
            "cx:chart"
          )
        : removeXmlBlock(patched, "cx:autoTitleDeleted");
  }
  if (patchPlan.legend) {
    patched =
      chart.legend !== undefined
        ? replaceOrInsertBeforeGeneric(
            patched,
            "cx:legend",
            buildRawChartExLegendXml(chart.legend),
            ["cx:spPr"],
            "cx:chart"
          )
        : removeXmlBlock(patched, "cx:legend");
  }
  if (patchPlan.chartSpaceSpPr) {
    // Target `<cx:chartSpace>` (the root element) rather than
    // `<cx:chart>`. Chart-frame styling belongs on the chartSpace
    // parent per Chart2014; previous versions of this patcher
    // incorrectly wrote it inside `<cx:chart>`, producing output
    // strict validators reject. The siblings list is CT_ChartSpace's
    // child order after `cx:chart`: `cx:spPr, cx:txPr, cx:externalData,
    // cx:printSettings, cx:extLst`.
    patched = patchGenericChild(
      patched,
      "cx:spPr",
      buildRawShapePropertiesXml(model.chartSpace?.spPr, "cx"),
      ["cx:txPr", "cx:externalData", "cx:printSettings", "cx:extLst"],
      "cx:chartSpace"
    );
  }
  if (patchPlan.plotAreaSpPr || patchPlan.plotSurface) {
    const plotRange = findXmlBlock(patched, "cx:plotArea");
    if (!plotRange) {
      return undefined;
    }
    let plotBlock = patched.slice(plotRange.start, plotRange.end);
    const plotArea = chart.plotArea;
    if (patchPlan.plotAreaSpPr) {
      // `CT_PlotArea` sequence: `plotAreaRegion?` → `axis*` → `spPr?` →
      // `extLst?`. `spPr` is the next-to-last child, so its only
      // follower is `extLst`.
      plotBlock = patchGenericChild(
        plotBlock,
        "cx:spPr",
        buildRawShapePropertiesXml(plotArea?.spPr, "cx"),
        ["cx:extLst"],
        "cx:plotArea"
      );
    }
    if (patchPlan.plotSurface) {
      // `CT_PlotAreaRegion` (Chart2014): `plotSurface?` → `series*` →
      // `extLst?`. The `spPr` is a child of `<cx:plotSurface>`, NOT a
      // direct child of `<cx:plotAreaRegion>`. Previously the raw
      // patcher wrote a bare `<cx:spPr>` under `<cx:plotAreaRegion>`
      // (schema violation) and also had a separate
      // `plotAreaRegionLayout` patch that emitted `<cx:layout>`
      // there (also invalid — layout only lives on `<cx:plotArea>` /
      // `<cx:title>` via the manualLayout extension).
      //
      // The correct form is:
      //   <cx:plotAreaRegion>
      //     <cx:plotSurface>
      //       <cx:spPr>…</cx:spPr>
      //     </cx:plotSurface>
      //     <cx:series/>
      //     …
      //   </cx:plotAreaRegion>
      const regionRange = findXmlBlock(plotBlock, "cx:plotAreaRegion");
      if (!regionRange) {
        return undefined;
      }
      let regionBlock = plotBlock.slice(regionRange.start, regionRange.end);
      const region = plotArea?.plotAreaRegion;
      const surfaceSpPrXml = buildRawShapePropertiesXml(region?.plotSurface, "cx");
      const plotSurfaceXml = surfaceSpPrXml
        ? `<cx:plotSurface>${surfaceSpPrXml}</cx:plotSurface>`
        : undefined;
      regionBlock = patchGenericChild(
        regionBlock,
        "cx:plotSurface",
        plotSurfaceXml,
        ["cx:series", "cx:extLst"],
        "cx:plotAreaRegion"
      );
      plotBlock =
        plotBlock.slice(0, regionRange.start) + regionBlock + plotBlock.slice(regionRange.end);
    }
    patched = patched.slice(0, plotRange.start) + plotBlock + patched.slice(plotRange.end);
  }
  if (hasRawPatchListChanges(patchPlan.series)) {
    const next = patchRawChartExSeries(patched, chart, patchPlan);
    if (next === undefined) {
      return undefined;
    }
    patched = next;
  }
  if (hasRawPatchListChanges(patchPlan.axes)) {
    const next = patchRawChartExAxes(patched, chart, patchPlan.axes);
    if (next === undefined) {
      return undefined;
    }
    patched = next;
  }
  return patched;
}

function tryPatchChartRawXml(entry: ChartEntry, forceRawPatch = false): Uint8Array | undefined {
  if (!entry.rawData || (!entry.preferRawPatch && !forceRawPatch) || !hasChartEntryChanged(entry)) {
    return undefined;
  }
  const patchPlan = getChartRawPatchPlan(entry);
  if (patchPlan === undefined) {
    return undefined;
  }
  const raw = new TextDecoder().decode(entry.rawData);
  let patched = raw;
  if (patchPlan.title) {
    const titleText = entry.model.chart?.title?.text?.paragraphs?.[0]?.runs?.[0]?.text;
    const hasTitle = /<c:title>[\s\S]*?<\/c:title>/.test(patched);
    if (titleText !== undefined && hasTitle) {
      patched = patched.replace(/<c:title>[\s\S]*?<\/c:title>/, buildRawChartTitleXml(titleText));
    } else if (titleText === undefined && hasTitle) {
      patched = patched.replace(/<c:title>[\s\S]*?<\/c:title>/, "");
    }
  }
  if (patchPlan.legend) {
    const legend = entry.model.chart?.legend;
    if (legend === undefined) {
      patched = patched.replace(/<c:legend>[\s\S]*?<\/c:legend>/, "");
    } else if (/<c:legend>[\s\S]*?<\/c:legend>/.test(patched)) {
      patched = patched.replace(
        /<c:legend>[\s\S]*?<\/c:legend>/,
        buildRawChartLegendXml(legend.legendPos ?? "b")
      );
    }
  }
  if (hasRawPatchListChanges(patchPlan.series)) {
    const next = patchRawSeries(patched, entry.model, patchPlan.series);
    if (next === undefined) {
      return undefined;
    }
    patched = next;
  }
  if (patchPlan.groupDataLabels) {
    const next = patchRawChartGroupDataLabels(patched, entry.model);
    if (next === undefined) {
      return undefined;
    }
    patched = next;
  }
  if (patchPlan.groupSimpleFields) {
    const next = patchRawChartGroupSimpleFields(patched, entry.model);
    if (next === undefined) {
      return undefined;
    }
    patched = next;
  }
  if (patchPlan.plotAreaLayout) {
    const next = patchRawPlotAreaLayout(patched, entry.model);
    if (next === undefined) {
      return undefined;
    }
    patched = next;
  }
  if (hasRawPatchListChanges(patchPlan.axes)) {
    const next = patchRawAxes(patched, entry.model, patchPlan.axes);
    if (next === undefined) {
      return undefined;
    }
    patched = next;
  }
  return patched !== raw ? new TextEncoder().encode(patched) : undefined;
}

interface ChartRawPatchPlan {
  title: boolean;
  legend: boolean;
  series: RawPatchListPlan<ChartSeriesRawPatchPlan>;
  axes: RawPatchListPlan<ChartAxisRawPatchPlan>;
  groupDataLabels: boolean;
  /**
   * Any chart-type group's simple leaf field (`gapWidth`, `overlap`,
   * `varyColors`, `firstSliceAng`, `holeSize`, `gapDepth`,
   * `radarStyle`, `scatterStyle`, `ofPieType`, `smooth`, and friends —
   * see {@link SIMPLE_GROUP_FIELD_TAGS}) has changed. When true,
   * `tryPatchChartRawXml` rewrites those leaves in place via
   * `patchRawChartGroupSimpleFields` instead of falling through to a
   * structural rebuild.
   */
  groupSimpleFields: boolean;
  plotAreaLayout: boolean;
}

function getChartRawPatchPlan(entry: ChartEntry): ChartRawPatchPlan | undefined {
  if (entry.modelSnapshot === undefined) {
    return {
      title: true,
      legend: true,
      series: true,
      axes: true,
      groupDataLabels: true,
      groupSimpleFields: true,
      plotAreaLayout: true
    };
  }
  let previous: any;
  try {
    previous = JSON.parse(entry.modelSnapshot);
  } catch {
    return undefined;
  }
  const current = entry.model;
  const prevChart = previous.chart;
  const curChart = current.chart;
  const plan: ChartRawPatchPlan = {
    title: false,
    legend: false,
    series: buildChartSeriesRawPatchPlan(previous, current),
    axes: buildChartAxisRawPatchPlan(
      prevChart?.plotArea?.axes ?? [],
      curChart?.plotArea?.axes ?? []
    ),
    groupDataLabels: false,
    groupSimpleFields: false,
    plotAreaLayout: false
  };
  const curWithoutPatchable = stripPatchableChartFields(current);
  const prevWithoutPatchable = stripPatchableChartFields(previous);
  if (!sameJson(curWithoutPatchable, prevWithoutPatchable)) {
    return undefined;
  }
  plan.title = plan.title || !sameJson(prevChart?.title, curChart?.title);
  plan.legend = plan.legend || !sameJson(prevChart?.legend, curChart?.legend);
  plan.groupDataLabels = !sameJson(
    extractPatchableGroupDataLabels(previous),
    extractPatchableGroupDataLabels(current)
  );
  plan.groupSimpleFields = !sameJson(
    extractSimpleGroupFields(previous),
    extractSimpleGroupFields(current)
  );
  plan.plotAreaLayout = !sameJson(prevChart?.plotArea?.layout, curChart?.plotArea?.layout);
  return plan.title ||
    plan.legend ||
    hasRawPatchListChanges(plan.series) ||
    hasRawPatchListChanges(plan.axes) ||
    plan.groupDataLabels ||
    plan.groupSimpleFields ||
    plan.plotAreaLayout
    ? plan
    : undefined;
}

function stripPatchableChartFields(model: any): any {
  const clone = structuredClone(model);
  // Top-level fields that tryPatchChartRawXml does not rewrite. Allowing
  // them to differ between `previous` and `current` means a caller can
  // load a template that carries c14/c15/c16 extension XML, edit a
  // title or legend, and still take the fast raw-patch path — without
  // this the extLst JSON shape shifts (e.g. empty string `""` vs
  // `undefined` after a round-trip) and the plan gets rejected.
  //
  // We deliberately do NOT strip `pivotOptions`: it is structurally
  // parsed, and the raw patcher has no branch to replay a mutation
  // into the XML. Keeping it out of the whitelist forces a rebuild so
  // the user's change is honoured.
  clone.extLst = undefined;
  clone.unknownElements = undefined;
  clone.extraNamespaces = undefined;
  clone.alternateContentStyle = undefined;
  clone.clrMapOvr = undefined;
  clone.protection = undefined;
  if (clone.chart) {
    clone.chart.title = undefined;
    clone.chart.legend = undefined;
    clone.chart.extLst = undefined;
    if (clone.chart.plotArea) {
      clone.chart.plotArea.axes = (clone.chart.plotArea.axes ?? []).map(stripPatchableAxisFields);
      clone.chart.plotArea.layout = undefined;
      clone.chart.plotArea.extLst = undefined;
      for (const group of clone.chart.plotArea.chartTypes ?? []) {
        group.dataLabels = undefined;
        group.extLst = undefined;
        // Simple leaf fields the `patchRawChartGroupSimpleFields`
        // branch rewrites in place (see `SIMPLE_GROUP_FIELD_TAGS`).
        // Stripping them from the baseline diff is what makes the
        // "edit `overlap` then write" path take the fast raw-patch
        // route instead of a full structural rebuild. Every field
        // listed here must have a matching entry in
        // `SIMPLE_GROUP_FIELD_TAGS` — the two are kept symmetric.
        for (const field of SIMPLE_GROUP_FIELD_NAMES) {
          group[field] = undefined;
        }
        group.series = (group.series ?? []).map((series: any) => ({
          ...series,
          tx: undefined,
          spPr: undefined,
          marker: undefined,
          dataPoints: undefined,
          trendlines: undefined,
          errorBars: undefined,
          cat: undefined,
          val: undefined,
          xVal: undefined,
          yVal: undefined,
          bubbleSize: undefined,
          dataLabels: undefined,
          extLst: undefined
        }));
      }
    }
  }
  return clone;
}

function stripPatchableAxisFields(axis: any): any {
  return {
    ...axis,
    scaling: undefined,
    delete: undefined,
    majorGridlines: undefined,
    minorGridlines: undefined,
    title: undefined,
    numFmt: undefined,
    majorTickMark: undefined,
    minorTickMark: undefined,
    tickLblPos: undefined,
    spPr: undefined,
    txPr: undefined,
    crosses: undefined,
    crossesAt: undefined,
    auto: undefined,
    lblAlgn: undefined,
    lblOffset: undefined,
    tickLblSkip: undefined,
    tickMarkSkip: undefined,
    noMultiLvlLbl: undefined,
    crossBetween: undefined,
    majorUnit: undefined,
    minorUnit: undefined,
    baseTimeUnit: undefined,
    majorTimeUnit: undefined,
    minorTimeUnit: undefined,
    // `c:extLst` on an axis is always raw XML passthrough in the
    // structural parser; freezing it out of the diff lets template
    // edits (scaling / gridlines / title) take the fast raw-patch
    // path when the template happens to carry c15:axisTitleExtLst or
    // similar vendor ext markers.
    extLst: undefined
  };
}

function extractPatchableGroupDataLabels(model: any): any {
  return (model.chart?.plotArea?.chartTypes ?? []).map((group: any) => group.dataLabels);
}

function buildChartSeriesRawPatchPlan(previous: any, current: any): ChartSeriesRawPatchPlan[] {
  const previousSeries = flattenChartSeries(previous);
  return flattenChartSeries(current).map((series, index) => {
    const prev = previousSeries[index] ?? {};
    return {
      tx: !sameJson(prev.tx, series.tx),
      spPr: !sameJson(prev.spPr, series.spPr),
      marker: !sameJson(prev.marker, series.marker),
      dataPoints: !sameJson(prev.dataPoints, series.dataPoints),
      trendlines: !sameJson(prev.trendlines, series.trendlines),
      errorBars: !sameJson(prev.errorBars, series.errorBars),
      cat: !sameJson(prev.cat, series.cat),
      val: !sameJson(prev.val, series.val),
      xVal: !sameJson(prev.xVal, series.xVal),
      yVal: !sameJson(prev.yVal, series.yVal),
      bubbleSize: !sameJson(prev.bubbleSize, series.bubbleSize),
      dataLabels: !sameJson(prev.dataLabels, series.dataLabels)
    };
  });
}

function buildChartAxisRawPatchPlan(
  previousAxes: any[],
  currentAxes: any[]
): ChartAxisRawPatchPlan[] {
  const previousById = new Map(previousAxes.map(axis => [axis.axId, axis]));
  return currentAxes.map(axis => {
    const prev = previousById.get(axis.axId) ?? {};
    return {
      scaling: !sameJson(prev.scaling, axis.scaling),
      delete: !sameJson(prev.delete, axis.delete),
      title: !sameJson(prev.title, axis.title),
      numFmt: !sameJson(prev.numFmt, axis.numFmt),
      majorGridlines: !sameJson(prev.majorGridlines, axis.majorGridlines),
      minorGridlines: !sameJson(prev.minorGridlines, axis.minorGridlines),
      majorTickMark: !sameJson(prev.majorTickMark, axis.majorTickMark),
      minorTickMark: !sameJson(prev.minorTickMark, axis.minorTickMark),
      tickLblPos: !sameJson(prev.tickLblPos, axis.tickLblPos),
      spPr: !sameJson(prev.spPr, axis.spPr),
      txPr: !sameJson(prev.txPr, axis.txPr),
      crosses: !sameJson(prev.crosses, axis.crosses),
      crossesAt: !sameJson(prev.crossesAt, axis.crossesAt),
      auto: !sameJson(prev.auto, axis.auto),
      lblAlgn: !sameJson(prev.lblAlgn, axis.lblAlgn),
      lblOffset: !sameJson(prev.lblOffset, axis.lblOffset),
      tickLblSkip: !sameJson(prev.tickLblSkip, axis.tickLblSkip),
      tickMarkSkip: !sameJson(prev.tickMarkSkip, axis.tickMarkSkip),
      noMultiLvlLbl: !sameJson(prev.noMultiLvlLbl, axis.noMultiLvlLbl),
      crossBetween: !sameJson(prev.crossBetween, axis.crossBetween),
      majorUnit: !sameJson(prev.majorUnit, axis.majorUnit),
      minorUnit: !sameJson(prev.minorUnit, axis.minorUnit),
      baseTimeUnit: !sameJson(prev.baseTimeUnit, axis.baseTimeUnit),
      majorTimeUnit: !sameJson(prev.majorTimeUnit, axis.majorTimeUnit),
      minorTimeUnit: !sameJson(prev.minorTimeUnit, axis.minorTimeUnit)
    };
  });
}

function flattenChartSeries(model: any): any[] {
  return (model.chart?.plotArea?.chartTypes ?? []).flatMap((group: any) =>
    (group.series ?? []).map((series: any) => ({
      tx: series.tx,
      spPr: series.spPr,
      marker: series.marker,
      dataPoints: series.dataPoints,
      trendlines: series.trendlines,
      errorBars: series.errorBars,
      cat: series.cat,
      val: series.val,
      xVal: series.xVal,
      yVal: series.yVal,
      bubbleSize: series.bubbleSize,
      dataLabels: series.dataLabels
    }))
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasRawPatchListChanges<T extends object>(plan: RawPatchListPlan<T>): boolean {
  return (
    plan === true || (Array.isArray(plan) && plan.some(item => Object.values(item).some(Boolean)))
  );
}

function getRawPatchListItem<T extends object>(
  plan: RawPatchListPlan<T>,
  index: number
): T | true | false {
  return plan === true ? true : Array.isArray(plan) ? (plan[index] ?? false) : false;
}

function rawPatchFlag<T extends object>(plan: T | true | false, key: keyof T): boolean {
  if (plan === true) {
    return true;
  }
  if (plan === false) {
    return false;
  }
  return Boolean(plan[key]);
}

function buildRawChartTitleXml(text: string): string {
  // Full text escape (strips C0 control characters beyond `\t\n\r`,
  // encodes the five reserved entities) so injected titles can't break
  // out of the `<a:t>` element. Matches the `escapeXml` helper used
  // elsewhere in this module.
  const escaped = escapeXml(text);
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escaped}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

function buildRawChartLegendXml(pos: string): string {
  // Escape the attribute value — `pos` is typed as `LegendPosition`
  // (a 5-member enum) but the raw-patch path can't enforce that
  // statically, so a malicious or buggy caller could inject XML via
  // the attribute. Narrow to the enum set so truly unexpected values
  // fall back to the schema default `"b"` instead of being echoed
  // through verbatim.
  const safe = pos === "b" || pos === "l" || pos === "r" || pos === "t" || pos === "tr" ? pos : "b";
  return `<c:legend><c:legendPos val="${safe}"/><c:overlay val="0"/></c:legend>`;
}

function buildRawChartExTitleXml(text: string): string {
  return `<cx:title><cx:tx><cx:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></cx:rich></cx:tx><cx:overlay val="0"/></cx:title>`;
}

function buildRawChartExLegendXml(
  legend: NonNullable<ChartExModel["chartSpace"]["chart"]["legend"]>
): string {
  // Delegate to the structured ChartEx writer so the raw-patch path
  // produces a byte-identical serialisation. Previously this function
  // hand-rolled a self-closing `<cx:legend pos="…" overlay="…"/>`,
  // silently dropping `align`, `legendEntry*`, `spPr`, `txPr`, and
  // `extLst` on every styled-legend round-trip. Sharing the writer
  // guarantees parity with the non-raw path.
  // Indentation differs from the structured writer's formatted output —
  // the raw patcher inserts into an inline stream, so strip the
  // leading indent that `renderChartExLegendXml` prefixes each line
  // with. The result is semantically identical; just flattened.
  return renderChartExLegendXml(legend)
    .split("\n")
    .map(line => line.replace(/^\s*/, ""))
    .join("");
}

function buildRawChartExDataXml(chartData: ChartExData | undefined): string {
  const parts = ["<cx:chartData>"];
  // `cx:externalData` is a child of `cx:chartSpace` per Chart2014's
  // `CT_ChartSpace`, NOT of `cx:chartData`. Emitted at the chartSpace
  // level by the structured writer; nothing for us to do here.
  for (const entry of chartData?.data ?? []) {
    parts.push(`<cx:data id="${entry.id}">`);
    if (entry.strDim) {
      parts.push(buildRawChartExStringDimensionXml(entry.strDim));
    }
    if (entry.numDim) {
      parts.push(buildRawChartExNumericDimensionXml(entry.numDim));
    }
    parts.push("</cx:data>");
  }
  parts.push("</cx:chartData>");
  return parts.join("");
}

function buildRawChartExStringDimensionXml(dim: ChartExStringDimension): string {
  const parts = [`<cx:strDim type="${escapeAttr(dim.type)}">`];
  if (dim.formula) {
    parts.push(`<cx:f>${escapeXml(dim.formula)}</cx:f>`);
  }
  for (const level of dim.levels ?? []) {
    const ptCount = level.ptCount ?? level.points?.length ?? 0;
    if (!level.points?.length) {
      parts.push(`<cx:lvl ptCount="${ptCount}"/>`);
    } else {
      parts.push(`<cx:lvl ptCount="${ptCount}">`);
      for (const point of level.points) {
        parts.push(`<cx:pt idx="${point.index}">${escapeXml(String(point.value))}</cx:pt>`);
      }
      parts.push("</cx:lvl>");
    }
  }
  parts.push("</cx:strDim>");
  return parts.join("");
}

function buildRawChartExNumericDimensionXml(dim: ChartExNumericDimension): string {
  const parts = [`<cx:numDim type="${escapeAttr(dim.type)}">`];
  if (dim.formula) {
    parts.push(`<cx:f>${escapeXml(dim.formula)}</cx:f>`);
  }
  for (const level of dim.levels ?? []) {
    const ptCount = level.ptCount ?? level.points?.length ?? 0;
    const fmt = level.formatCode ? ` formatCode="${escapeAttr(level.formatCode)}"` : "";
    if (!level.points?.length) {
      parts.push(`<cx:lvl ptCount="${ptCount}"${fmt}/>`);
    } else {
      parts.push(`<cx:lvl ptCount="${ptCount}"${fmt}>`);
      for (const point of level.points) {
        parts.push(`<cx:pt idx="${point.index}">${escapeXml(String(point.value))}</cx:pt>`);
      }
      parts.push("</cx:lvl>");
    }
  }
  parts.push("</cx:numDim>");
  return parts.join("");
}

function patchRawSeries(
  raw: string,
  model: any,
  patchPlan: RawPatchListPlan<ChartSeriesRawPatchPlan>
): string | undefined {
  // Track the owning chart-type group for each series so doughnut
  // series can suppress `c:dLblPos` when writing `<c:dLbls>` — Excel
  // rejects that element on doughnut charts (see
  // `_renderDoughnutChart` in `chart-space-xform.ts`).
  const seriesEntries: Array<{ series: any; chartType: string | undefined }> = [];
  for (const group of model.chart?.plotArea?.chartTypes ?? []) {
    for (const series of group.series ?? []) {
      seriesEntries.push({ series, chartType: group.type });
    }
  }
  let index = 0;
  return replaceXmlBlocks(raw, "c:ser", block => {
    const entry = seriesEntries[index++];
    const seriesPlan = getRawPatchListItem(patchPlan, index - 1);
    return entry && seriesPlan
      ? patchRawSeriesBlock(block, entry.series, seriesPlan, entry.chartType)
      : block;
  });
}

function patchRawSeriesBlock(
  block: string,
  series: any,
  patchPlan: ChartSeriesRawPatchPlan | true,
  chartType?: string
): string | undefined {
  let patched = block;
  if (rawPatchFlag(patchPlan, "tx") && series.tx) {
    const txXml = buildRawSeriesTxXml(series.tx);
    patched = replaceOrInsertBefore(patched, "c:tx", txXml, [
      "c:spPr",
      "c:cat",
      "c:xVal",
      "c:val",
      "c:yVal",
      "c:bubbleSize"
    ]);
  }
  if (rawPatchFlag(patchPlan, "spPr")) {
    patched = patchGenericChild(
      patched,
      "c:spPr",
      buildRawShapePropertiesXml(series.spPr, "c"),
      [
        "c:marker",
        "c:invertIfNegative",
        "c:pictureOptions",
        "c:dPt",
        "c:dLbls",
        "c:trendline",
        "c:errBars",
        "c:cat",
        "c:xVal",
        "c:val",
        "c:yVal",
        "c:bubbleSize",
        "c:smooth",
        "c:shape",
        "c:extLst"
      ],
      "c:ser"
    );
  }
  if (rawPatchFlag(patchPlan, "marker")) {
    patched = patchGenericChild(
      patched,
      "c:marker",
      buildRawMarkerXml(series.marker),
      [
        "c:dPt",
        "c:dLbls",
        "c:trendline",
        "c:errBars",
        "c:cat",
        "c:xVal",
        "c:val",
        "c:yVal",
        "c:bubbleSize",
        "c:smooth",
        "c:extLst"
      ],
      "c:ser"
    );
  }
  for (const [tag, source] of [
    ["c:cat", series.cat],
    ["c:val", series.val],
    ["c:xVal", series.xVal],
    ["c:yVal", series.yVal],
    ["c:bubbleSize", series.bubbleSize]
  ] as Array<[string, any]>) {
    if (rawPatchFlag(patchPlan, chartSeriesPatchKeyForDataTag(tag))) {
      if (!source) {
        patched = removeXmlBlock(patched, tag);
        continue;
      }
      const dataXml = buildRawDataSourceXml(tag, source);
      if (!dataXml) {
        return undefined;
      }
      patched = replaceOrInsertBefore(patched, tag, dataXml, ["c:smooth", "c:shape", "c:extLst"]);
    }
  }
  if (rawPatchFlag(patchPlan, "dataPoints")) {
    const dataPointsXml = buildRawDataPointsXml(series.dataPoints);
    patched = patchRepeatingChildren(
      patched,
      "c:dPt",
      dataPointsXml,
      [
        "c:dLbls",
        "c:trendline",
        "c:errBars",
        "c:cat",
        "c:xVal",
        "c:val",
        "c:yVal",
        "c:bubbleSize",
        "c:smooth",
        "c:shape",
        "c:extLst"
      ],
      "c:ser"
    );
  }
  if (rawPatchFlag(patchPlan, "trendlines")) {
    const trendlinesXml = buildRawTrendlinesXml(series.trendlines);
    patched = patchRepeatingChildren(
      patched,
      "c:trendline",
      trendlinesXml,
      [
        "c:errBars",
        "c:cat",
        "c:xVal",
        "c:val",
        "c:yVal",
        "c:bubbleSize",
        "c:smooth",
        "c:shape",
        "c:extLst"
      ],
      "c:ser"
    );
  }
  if (rawPatchFlag(patchPlan, "errorBars")) {
    const errorBarsXml = buildRawErrorBarsXml(series.errorBars);
    patched = patchRepeatingChildren(
      patched,
      "c:errBars",
      errorBarsXml,
      ["c:cat", "c:xVal", "c:val", "c:yVal", "c:bubbleSize", "c:smooth", "c:shape", "c:extLst"],
      "c:ser"
    );
  }
  if (rawPatchFlag(patchPlan, "dataLabels")) {
    if (series.dataLabels) {
      patched = replaceOrInsertBefore(
        patched,
        "c:dLbls",
        buildRawDataLabelsXml(series.dataLabels, { suppressDLblPos: chartType === "doughnut" }),
        [
          "c:trendline",
          "c:errBars",
          "c:cat",
          "c:xVal",
          "c:val",
          "c:yVal",
          "c:bubbleSize",
          "c:smooth",
          "c:shape",
          "c:extLst"
        ]
      );
    } else {
      patched = patched.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/, "");
    }
  }
  return patched;
}

function chartSeriesPatchKeyForDataTag(tag: string): keyof ChartSeriesRawPatchPlan {
  switch (tag) {
    case "c:cat":
      return "cat";
    case "c:val":
      return "val";
    case "c:xVal":
      return "xVal";
    case "c:yVal":
      return "yVal";
    default:
      return "bubbleSize";
  }
}

/**
 * Ordered child tag list for each `ChartTypeGroup` block in a classic
 * chartN.xml, used by `replaceOrRemoveSimpleGroupField` to place a new
 * leaf in the correct schema position. The ordering mirrors the
 * `_renderXxxChart` functions in `chart-space-xform.ts` and is the
 * "schema order" ECMA-376 requires — inserting `c:gapWidth` before
 * `c:barDir` would produce XML Excel refuses to open.
 *
 * Tags not listed (e.g. `c:dLbls`, `c:ser`, `c:extLst`) are inserted
 * by existing dedicated patchers. Anything in this map is a single
 * `<c:… val="…"/>` leaf with no child elements.
 */
const CLASSIC_GROUP_CHILD_ORDER: readonly string[] = [
  "c:barDir",
  "c:grouping",
  "c:varyColors",
  "c:ofPieType",
  "c:radarStyle",
  "c:scatterStyle",
  "c:wireframe",
  "c:ser",
  "c:dLbls",
  "c:marker",
  "c:smooth",
  "c:dropLines",
  "c:hiLowLines",
  "c:upDownBars",
  "c:bubbleScale",
  "c:showNegBubbles",
  "c:sizeRepresents",
  "c:gapWidth",
  "c:overlap",
  "c:serLines",
  "c:shape",
  "c:firstSliceAng",
  "c:holeSize",
  "c:gapDepth",
  "c:splitType",
  "c:splitPos",
  "c:custSplit",
  "c:secondPieSize",
  "c:axId",
  "c:extLst"
];

/**
 * The subset of {@link CLASSIC_GROUP_CHILD_ORDER} that
 * `patchRawChartGroupSimpleFields` can rewrite in place. The field
 * name on the left is the `ChartTypeGroup` model key; the right-hand
 * value is the OOXML element name (sans `val=` attribute, which this
 * patcher always uses). Boolean model fields are serialised as
 * `"1"` / `"0"` to match the ECMA-376 convention.
 *
 * Kept in sync with `SIMPLE_GROUP_FIELD_NAMES` (used by
 * `stripPatchableChartFields`) — every entry in this map must also be
 * stripped from the baseline diff, otherwise a plain
 * "previous === current after strip" check would see the mutated
 * leaf and refuse the raw-patch plan.
 */
const SIMPLE_GROUP_FIELD_TAGS: Record<string, string> = {
  barDir: "c:barDir",
  grouping: "c:grouping",
  varyColors: "c:varyColors",
  gapWidth: "c:gapWidth",
  overlap: "c:overlap",
  firstSliceAng: "c:firstSliceAng",
  holeSize: "c:holeSize",
  gapDepth: "c:gapDepth",
  scatterStyle: "c:scatterStyle",
  radarStyle: "c:radarStyle",
  ofPieType: "c:ofPieType",
  splitType: "c:splitType",
  splitPos: "c:splitPos",
  secondPieSize: "c:secondPieSize",
  bubbleScale: "c:bubbleScale",
  showNegBubbles: "c:showNegBubbles",
  sizeRepresents: "c:sizeRepresents",
  shape: "c:shape",
  smooth: "c:smooth",
  wireframe: "c:wireframe"
};

const SIMPLE_GROUP_FIELD_NAMES: readonly string[] = Object.keys(SIMPLE_GROUP_FIELD_TAGS);

/**
 * Extract the simple-field projection of every chart-type group in a
 * `ChartModel` for diffing. Produces a stable array of plain objects
 * (one per group) keyed by field name so
 * `sameJson(extractSimpleGroupFields(prev), extractSimpleGroupFields(curr))`
 * answers "did any group simple field change?".
 */
function extractSimpleGroupFields(model: any): Array<Record<string, unknown>> {
  const groups = model.chart?.plotArea?.chartTypes ?? [];
  return groups.map((group: any) => {
    const out: Record<string, unknown> = { type: group.type };
    for (const key of SIMPLE_GROUP_FIELD_NAMES) {
      if (group[key] !== undefined) {
        out[key] = group[key];
      }
    }
    return out;
  });
}

/**
 * Raw-XML patcher for the simple leaf fields of every chart-type
 * group: `gapWidth`, `overlap`, `varyColors`, `firstSliceAng`,
 * `holeSize`, `gapDepth`, `radarStyle`, `scatterStyle`, `ofPieType`,
 * `smooth`, and the other `val="…"` leaves listed in
 * {@link SIMPLE_GROUP_FIELD_TAGS}. Called by `tryPatchChartRawXml`
 * when `plan.groupSimpleFields` is true so these common user edits
 * (tightening bar overlap, rotating a pie, lowering bubble scale)
 * keep the fast raw-patch path instead of rebuilding the chart XML
 * structurally and losing any vendor extensions along the way.
 *
 * Returns `undefined` when a group block cannot be located or its
 * type lacks a known tag — signalling to the caller that it should
 * fall back to a structural rebuild.
 */
function patchRawChartGroupSimpleFields(raw: string, model: any): string | undefined {
  let patched = raw;
  for (const group of model.chart?.plotArea?.chartTypes ?? []) {
    const tag = chartGroupTagName(group);
    if (!tag) {
      return undefined;
    }
    const range = findXmlBlock(patched, tag);
    if (!range) {
      return undefined;
    }
    const block = patched.slice(range.start, range.end);
    // Series blocks can themselves contain elements with the same
    // tag names (e.g. a custom series dLbls might ship with a stale
    // `c:smooth`); mask them out while we rewrite the group-level
    // leaves so our regex replacements don't accidentally target a
    // series-internal element.
    const { xml: withoutSeries, seriesBlocks } = preserveSeriesBlocks(block, xml => xml);
    let current = withoutSeries;
    for (const fieldName of SIMPLE_GROUP_FIELD_NAMES) {
      const xmlTag = SIMPLE_GROUP_FIELD_TAGS[fieldName];
      const value = (group as Record<string, unknown>)[fieldName];
      current = replaceOrRemoveSimpleGroupField(current, xmlTag, value);
    }
    const restored = restoreSeriesBlocks(current, seriesBlocks);
    patched = patched.slice(0, range.start) + restored + patched.slice(range.end);
  }
  return patched;
}

/**
 * Replace, insert, or remove a `<c:xxx val="…"/>` leaf inside a
 * chart-type group block while keeping the block's child order
 * schema-valid (see {@link CLASSIC_GROUP_CHILD_ORDER}).
 *
 * - `value === undefined` → element is removed if present, left
 *   untouched otherwise.
 * - `value !== undefined` → element is rewritten in place when it
 *   already exists, or inserted before the first schema-later
 *   sibling when it does not.
 *
 * Booleans are serialised as `"1"` / `"0"`; numbers use their string
 * representation; strings pass through with attribute escaping. The
 * schema only expects these three primitive shapes for simple leaves.
 */
function replaceOrRemoveSimpleGroupField(block: string, tag: string, value: unknown): string {
  const leafRegex = new RegExp(`<${escapeRegExp(tag)}(?:\\s+[^/>]*)?/>`, "g");
  if (value === undefined) {
    // Strip the existing leaf if present, no-op otherwise.
    return block.replace(leafRegex, "");
  }
  const serialised = serialiseSimpleGroupFieldValue(value);
  const replacement = `<${tag} val="${serialised}"/>`;
  if (leafRegex.test(block)) {
    return block.replace(leafRegex, replacement);
  }
  // Insert in schema order: find the first sibling that comes after
  // our tag in CLASSIC_GROUP_CHILD_ORDER and that exists in the
  // current block.
  const tagIndex = CLASSIC_GROUP_CHILD_ORDER.indexOf(tag);
  if (tagIndex < 0) {
    return block; // unknown tag — do not risk corrupting the XML
  }
  const laterSiblings = CLASSIC_GROUP_CHILD_ORDER.slice(tagIndex + 1);
  for (const sibling of laterSiblings) {
    const siblingIdx = block.indexOf(`<${sibling}`);
    if (siblingIdx >= 0) {
      return block.slice(0, siblingIdx) + replacement + block.slice(siblingIdx);
    }
  }
  // No later sibling found — insert before the closing `</…Chart>`.
  const closeMatch = /<\/c:\w+Chart>\s*$/.exec(block);
  if (closeMatch) {
    const insertAt = closeMatch.index;
    return block.slice(0, insertAt) + replacement + block.slice(insertAt);
  }
  return block;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serialiseSimpleGroupFieldValue(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "number") {
    // Guard against `NaN` / `Infinity` leaking into the attribute —
    // `String(NaN) === "NaN"` produces XML Excel rejects. Callers
    // that pass an invalid numeric should get an empty string
    // instead; the caller removes the leaf on absence, so an empty
    // serialise is equivalent to "don't emit this field".
    return Number.isFinite(value) ? String(value) : "";
  }
  // Strings go through the canonical attribute encoder. Previously
  // this helper hand-rolled a minimal `& " <` escape chain, which
  // let newlines / tabs / illegal XML chars / lone surrogates
  // through verbatim — the raw patcher then produced attribute
  // values that (a) normalized to a single space on parse (XML 1.0
  // §3.3.3), losing newlines, or (b) contained chars no parser
  // accepts. `xmlEncodeAttr` strips the illegal ones and encodes
  // CR/LF/Tab as numeric character references so round-trip preserves
  // whitespace.
  return xmlEncodeAttr(String(value));
}

function patchRawChartGroupDataLabels(raw: string, model: any): string | undefined {
  let patched = raw;
  for (const group of model.chart?.plotArea?.chartTypes ?? []) {
    const tag = chartGroupTagName(group);
    if (!tag) {
      return undefined;
    }
    const range = findXmlBlock(patched, tag);
    if (!range) {
      return undefined;
    }
    const block = patched.slice(range.start, range.end);
    const replacement = patchRawChartGroupDataLabelsBlock(block, group);
    patched = patched.slice(0, range.start) + replacement + patched.slice(range.end);
  }
  return patched;
}

function patchRawPlotAreaLayout(raw: string, model: any): string | undefined {
  const plotArea = model.chart?.plotArea;
  const range = findXmlBlock(raw, "c:plotArea");
  if (!range || !plotArea) {
    return undefined;
  }
  const block = raw.slice(range.start, range.end);
  const layoutXml = plotArea.layout ? buildRawLayoutXml(plotArea.layout) : "";
  const patched = layoutXml
    ? replaceOrInsertBeforeGeneric(
        block,
        "c:layout",
        layoutXml,
        [
          "c:areaChart",
          "c:area3DChart",
          "c:barChart",
          "c:bar3DChart",
          "c:lineChart",
          "c:line3DChart",
          "c:pieChart",
          "c:pie3DChart",
          "c:doughnutChart",
          "c:scatterChart",
          "c:bubbleChart",
          "c:radarChart",
          "c:stockChart",
          "c:surfaceChart",
          "c:surface3DChart",
          "c:ofPieChart",
          "c:catAx",
          "c:valAx",
          "c:serAx",
          "c:dateAx",
          "c:spPr"
        ],
        "c:plotArea"
      )
    : removeXmlBlock(block, "c:layout");
  return raw.slice(0, range.start) + patched + raw.slice(range.end);
}

function buildRawLayoutXml(layout: ChartLayout | undefined, namespace: "c" | "cx" = "c"): string {
  if (!layout?.manualLayout) {
    return `<${namespace}:layout/>`;
  }
  const ml = layout.manualLayout;
  const parts = [`<${namespace}:layout><${namespace}:manualLayout>`];
  for (const [name, value] of [
    ["layoutTarget", ml.layoutTarget],
    ["xMode", ml.xMode],
    ["yMode", ml.yMode],
    ["wMode", ml.wMode],
    ["hMode", ml.hMode],
    ["x", ml.x],
    ["y", ml.y],
    ["w", ml.w],
    ["h", ml.h]
  ] as const) {
    if (value !== undefined) {
      parts.push(`<${namespace}:${name} val="${escapeAttr(String(value))}"/>`);
    }
  }
  parts.push(`</${namespace}:manualLayout></${namespace}:layout>`);
  return parts.join("");
}

function patchRawChartGroupDataLabelsBlock(block: string, group: any): string {
  const withoutSeriesBlocks = preserveSeriesBlocks(block, xml => xml);
  if (group.dataLabels) {
    return restoreSeriesBlocks(
      replaceOrInsertBefore(
        withoutSeriesBlocks.xml,
        "c:dLbls",
        buildRawDataLabelsXml(group.dataLabels, {
          suppressDLblPos: group.type === "doughnut"
        }),
        [
          "c:gapWidth",
          "c:overlap",
          "c:serLines",
          "c:axId",
          "c:firstSliceAng",
          "c:holeSize",
          "c:extLst"
        ]
      ),
      withoutSeriesBlocks.seriesBlocks
    );
  }
  const stripped = withoutSeriesBlocks.xml.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/, "");
  return restoreSeriesBlocks(stripped, withoutSeriesBlocks.seriesBlocks);
}

function chartGroupTagName(group: any): string | undefined {
  const tagByType: Record<string, string> = {
    bar: "c:barChart",
    bar3D: "c:bar3DChart",
    line: "c:lineChart",
    line3D: "c:line3DChart",
    pie: "c:pieChart",
    pie3D: "c:pie3DChart",
    doughnut: "c:doughnutChart",
    area: "c:areaChart",
    area3D: "c:area3DChart",
    scatter: "c:scatterChart",
    bubble: "c:bubbleChart",
    radar: "c:radarChart",
    stock: "c:stockChart",
    surface: "c:surfaceChart",
    surface3D: "c:surface3DChart",
    ofPie: "c:ofPieChart"
  };
  return tagByType[group.type];
}

function preserveSeriesBlocks(
  block: string,
  transform: (xml: string) => string
): { xml: string; seriesBlocks: string[] } {
  const seriesBlocks: string[] = [];
  let cursor = 0;
  let xml = "";
  while (cursor < block.length) {
    const range = findXmlBlock(block, "c:ser", cursor);
    if (!range) {
      xml += block.slice(cursor);
      break;
    }
    xml += block.slice(cursor, range.start);
    const placeholder = `__DOCUMONSTER_SER_${seriesBlocks.length}__`;
    seriesBlocks.push(transform(block.slice(range.start, range.end)));
    xml += placeholder;
    cursor = range.end;
  }
  return { xml, seriesBlocks };
}

function restoreSeriesBlocks(block: string, seriesBlocks: string[]): string {
  return seriesBlocks.reduce(
    (xml, seriesBlock, i) => xml.replace(`__DOCUMONSTER_SER_${i}__`, seriesBlock),
    block
  );
}

function buildRawDataLabelsXml(dataLabels: any, opts?: { suppressDLblPos?: boolean }): string {
  const parts = ["<c:dLbls>"];
  if (Array.isArray(dataLabels.entries)) {
    for (const entry of dataLabels.entries) {
      parts.push(buildRawDataLabelEntryXml(entry, opts));
    }
  }
  // ECMA-376 `CT_DLbls` (§21.2.2.49) child order (confirmed against
  // Microsoft OpenXML `DataLabels.ChildElementInfo`):
  //   dLbl*, delete | (numFmt, spPr, txPr, dLblPos, showLegendKey,
  //     showVal, showCatName, showSerName, showPercent,
  //     showBubbleSize, separator, showLeaderLines, leaderLines),
  //   extLst?.
  // The earlier raw-builder placed every `show*` flag BEFORE
  // `dLblPos` / `spPr` / `txPr` and `separator` AFTER
  // `showLeaderLines` — two schema violations that Excel silently
  // tolerates but LibreOffice strict mode refuses.
  if (dataLabels.numFmt?.formatCode) {
    const sourceLinked =
      dataLabels.numFmt.sourceLinked === undefined
        ? "1"
        : dataLabels.numFmt.sourceLinked
          ? "1"
          : "0";
    parts.push(
      `<c:numFmt formatCode="${escapeAttr(dataLabels.numFmt.formatCode)}" sourceLinked="${sourceLinked}"/>`
    );
  }
  if (dataLabels.spPr) {
    parts.push(buildRawShapePropertiesXml(dataLabels.spPr, "c") ?? "");
  }
  if (dataLabels.txPr) {
    parts.push(buildRawTextPropertiesXml(dataLabels.txPr, "c") ?? "");
  }
  // Doughnut charts must not emit `c:dLblPos` — Excel rejects the
  // element on open. See `_renderDoughnutChart` in
  // `chart-space-xform.ts` for the full rationale and bisect.
  if (dataLabels.position !== undefined && !opts?.suppressDLblPos) {
    parts.push(`<c:dLblPos val="${escapeAttr(String(dataLabels.position))}"/>`);
  }
  const flags = [
    ["showLegendKey", dataLabels.showLegendKey],
    ["showVal", dataLabels.showVal],
    ["showCatName", dataLabels.showCatName],
    ["showSerName", dataLabels.showSerName],
    ["showPercent", dataLabels.showPercent],
    ["showBubbleSize", dataLabels.showBubbleSize]
  ] as const;
  for (const [name, value] of flags) {
    if (value !== undefined) {
      parts.push(`<c:${name} val="${value ? "1" : "0"}"/>`);
    }
  }
  if (dataLabels.separator !== undefined) {
    parts.push(`<c:separator>${escapeXml(String(dataLabels.separator))}</c:separator>`);
  }
  if (dataLabels.showLeaderLines !== undefined) {
    parts.push(`<c:showLeaderLines val="${dataLabels.showLeaderLines ? "1" : "0"}"/>`);
  }
  if (dataLabels.extLst) {
    parts.push(dataLabels.extLst);
  }
  parts.push("</c:dLbls>");
  return parts.join("");
}

function buildRawDataLabelEntryXml(
  entry: DataLabelEntry,
  opts?: { suppressDLblPos?: boolean }
): string {
  // ECMA-376 `CT_DLbl` (§21.2.2.47) is a `choice(delete | …)` — the
  // two branches are mutually exclusive. Emitting `delete` alongside
  // any of the display-flag children (layout / tx / numFmt /
  // dLblPos / show* / separator) violates the schema; Excel's
  // tolerance varies by build (some strip the label wholesale).
  const parts = ["<c:dLbl>", `<c:idx val="${entry.index ?? 0}"/>`];
  if (entry.delete) {
    parts.push(`<c:delete val="1"/>`);
    if (entry.extLst) {
      parts.push(entry.extLst);
    }
    parts.push("</c:dLbl>");
    return parts.join("");
  }
  if (entry.layout) {
    parts.push(buildRawLayoutXml(entry.layout));
  }
  if (entry.rawTx) {
    parts.push(entry.rawTx);
  } else if (entry.text?.paragraphs?.[0]?.runs?.[0]?.text !== undefined) {
    parts.push(
      `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(String(entry.text.paragraphs[0].runs[0].text))}</a:t></a:r></a:p></c:rich></c:tx>`
    );
  }
  if (entry.numFmt?.formatCode) {
    parts.push(
      `<c:numFmt formatCode="${escapeAttr(entry.numFmt.formatCode)}" sourceLinked="${entry.numFmt.sourceLinked ? "1" : "0"}"/>`
    );
  }
  if (entry.spPr) {
    parts.push(buildRawShapePropertiesXml(entry.spPr, "c") ?? "");
  }
  if (entry.txPr) {
    parts.push(buildRawTextPropertiesXml(entry.txPr, "c") ?? "");
  }
  if (entry.position !== undefined && !opts?.suppressDLblPos) {
    parts.push(`<c:dLblPos val="${escapeAttr(String(entry.position))}"/>`);
  }
  for (const [name, value] of [
    ["showLegendKey", entry.showLegendKey],
    ["showVal", entry.showVal],
    ["showCatName", entry.showCatName],
    ["showSerName", entry.showSerName],
    ["showPercent", entry.showPercent],
    ["showBubbleSize", entry.showBubbleSize]
  ] as const) {
    if (value !== undefined) {
      parts.push(`<c:${name} val="${value ? "1" : "0"}"/>`);
    }
  }
  if (entry.separator !== undefined) {
    parts.push(`<c:separator>${escapeXml(String(entry.separator))}</c:separator>`);
  }
  if (entry.extLst) {
    parts.push(entry.extLst);
  }
  parts.push("</c:dLbl>");
  return parts.join("");
}

function patchRawAxes(
  raw: string,
  model: any,
  patchPlan: RawPatchListPlan<ChartAxisRawPatchPlan>
): string | undefined {
  let patched = raw;
  for (const [index, axis] of (model.chart?.plotArea?.axes ?? []).entries()) {
    const axisPlan = getRawPatchListItem(patchPlan, index);
    if (!axisPlan) {
      continue;
    }
    const tag =
      axis.axisType === "cat"
        ? "c:catAx"
        : axis.axisType === "val"
          ? "c:valAx"
          : axis.axisType === "date"
            ? "c:dateAx"
            : "c:serAx";
    const block = findAxisBlock(patched, tag, axis.axId);
    if (!block) {
      return undefined;
    }
    const axisXml = patchRawAxisBlock(block.xml, axis, axisPlan);
    if (!axisXml) {
      return undefined;
    }
    patched = patched.slice(0, block.start) + axisXml + patched.slice(block.end);
  }
  return patched;
}

function patchRawAxisBlock(
  block: string,
  axis: any,
  patchPlan: ChartAxisRawPatchPlan | true
): string | undefined {
  let patched = block;
  const axisTag = axisTagName(axis);
  if (rawPatchFlag(patchPlan, "scaling")) {
    patched = patchGenericChild(
      patched,
      "c:scaling",
      buildRawScalingXml(axis.scaling),
      ["c:delete", "c:axPos"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "delete")) {
    patched = patchBooleanLeaf(patched, "c:delete", axis.delete, ["c:axPos"], axisTag);
  }
  if (rawPatchFlag(patchPlan, "title")) {
    if (axis.title) {
      const titleText = axis.title.text?.paragraphs?.[0]?.runs?.[0]?.text;
      if (titleText !== undefined) {
        patched = replaceOrInsertBefore(patched, "c:title", buildRawChartTitleXml(titleText), [
          "c:numFmt",
          "c:majorGridlines",
          "c:minorGridlines",
          "c:majorUnit",
          "c:minorUnit",
          "c:majorTickMark",
          "c:minorTickMark",
          "c:tickLblPos"
        ]);
      }
    } else {
      patched = patched.replace(/<c:title>[\s\S]*?<\/c:title>/, "");
    }
  }
  if (rawPatchFlag(patchPlan, "numFmt")) {
    patched = patchGenericChild(
      patched,
      "c:numFmt",
      buildRawNumFmtXml(axis.numFmt),
      [
        "c:majorGridlines",
        "c:minorGridlines",
        "c:majorUnit",
        "c:minorUnit",
        "c:majorTickMark",
        "c:minorTickMark",
        "c:tickLblPos",
        "c:spPr",
        "c:txPr",
        "c:crossAx"
      ],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "majorGridlines")) {
    patched = patchGridlines(
      patched,
      "c:majorGridlines",
      axis.majorGridlines,
      [
        "c:minorGridlines",
        "c:title",
        "c:numFmt",
        "c:majorUnit",
        "c:minorUnit",
        "c:majorTickMark",
        "c:minorTickMark",
        "c:tickLblPos",
        "c:spPr",
        "c:txPr",
        "c:crossAx"
      ],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "minorGridlines")) {
    patched = patchGridlines(
      patched,
      "c:minorGridlines",
      axis.minorGridlines,
      [
        "c:title",
        "c:numFmt",
        "c:majorUnit",
        "c:minorUnit",
        "c:majorTickMark",
        "c:minorTickMark",
        "c:tickLblPos",
        "c:spPr",
        "c:txPr",
        "c:crossAx"
      ],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "majorTickMark")) {
    patched = patchValueLeaf(
      patched,
      "c:majorTickMark",
      axis.majorTickMark,
      ["c:minorTickMark", "c:tickLblPos", "c:spPr", "c:txPr", "c:crossAx"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "minorTickMark")) {
    patched = patchValueLeaf(
      patched,
      "c:minorTickMark",
      axis.minorTickMark,
      ["c:tickLblPos", "c:spPr", "c:txPr", "c:crossAx"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "tickLblPos")) {
    patched = patchValueLeaf(
      patched,
      "c:tickLblPos",
      axis.tickLblPos,
      ["c:spPr", "c:txPr", "c:crossAx"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "spPr")) {
    patched = patchGenericChild(
      patched,
      "c:spPr",
      buildRawShapePropertiesXml(axis.spPr, "c"),
      ["c:txPr", "c:crossAx"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "txPr")) {
    patched = patchGenericChild(
      patched,
      "c:txPr",
      buildRawTextPropertiesXml(axis.txPr, "c"),
      ["c:crossAx"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "crosses")) {
    patched = patchValueLeaf(
      patched,
      "c:crosses",
      axis.crosses,
      [
        "c:crossesAt",
        "c:auto",
        "c:lblAlgn",
        "c:lblOffset",
        "c:tickLblSkip",
        "c:tickMarkSkip",
        "c:noMultiLvlLbl",
        "c:crossBetween",
        "c:majorUnit",
        "c:minorUnit",
        "c:baseTimeUnit",
        "c:majorTimeUnit",
        "c:minorTimeUnit",
        "c:dispUnits",
        "c:extLst"
      ],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "crossesAt")) {
    patched = patchValueLeaf(
      patched,
      "c:crossesAt",
      axis.crossesAt,
      [
        "c:auto",
        "c:lblAlgn",
        "c:lblOffset",
        "c:tickLblSkip",
        "c:tickMarkSkip",
        "c:noMultiLvlLbl",
        "c:crossBetween",
        "c:majorUnit",
        "c:minorUnit",
        "c:baseTimeUnit",
        "c:majorTimeUnit",
        "c:minorTimeUnit",
        "c:dispUnits",
        "c:extLst"
      ],
      axisTag
    );
  }
  patched = patchAxisTypeSpecificLeaves(patched, axis, patchPlan);
  return patched;
}

function axisTagName(axis: any): string {
  return axis.axisType === "cat"
    ? "c:catAx"
    : axis.axisType === "val"
      ? "c:valAx"
      : axis.axisType === "date"
        ? "c:dateAx"
        : "c:serAx";
}

function patchAxisTypeSpecificLeaves(
  block: string,
  axis: any,
  patchPlan: ChartAxisRawPatchPlan | true
): string {
  const axisTag = axisTagName(axis);
  let patched = block;
  if (rawPatchFlag(patchPlan, "auto")) {
    patched = patchBooleanLeaf(
      patched,
      "c:auto",
      axis.auto,
      [
        "c:lblAlgn",
        "c:lblOffset",
        "c:tickLblSkip",
        "c:tickMarkSkip",
        "c:noMultiLvlLbl",
        "c:extLst"
      ],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "lblAlgn")) {
    patched = patchValueLeaf(
      patched,
      "c:lblAlgn",
      axis.lblAlgn,
      ["c:lblOffset", "c:tickLblSkip", "c:tickMarkSkip", "c:noMultiLvlLbl", "c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "lblOffset")) {
    patched = patchValueLeaf(
      patched,
      "c:lblOffset",
      axis.lblOffset,
      ["c:tickLblSkip", "c:tickMarkSkip", "c:noMultiLvlLbl", "c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "tickLblSkip")) {
    patched = patchValueLeaf(
      patched,
      "c:tickLblSkip",
      axis.tickLblSkip,
      ["c:tickMarkSkip", "c:noMultiLvlLbl", "c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "tickMarkSkip")) {
    patched = patchValueLeaf(
      patched,
      "c:tickMarkSkip",
      axis.tickMarkSkip,
      ["c:noMultiLvlLbl", "c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "noMultiLvlLbl")) {
    patched = patchBooleanLeaf(
      patched,
      "c:noMultiLvlLbl",
      axis.noMultiLvlLbl,
      ["c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "crossBetween")) {
    patched = patchValueLeaf(
      patched,
      "c:crossBetween",
      axis.crossBetween,
      ["c:majorUnit", "c:minorUnit", "c:dispUnits", "c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "majorUnit")) {
    patched = patchValueLeaf(
      patched,
      "c:majorUnit",
      axis.majorUnit,
      ["c:minorUnit", "c:dispUnits", "c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "minorUnit")) {
    patched = patchValueLeaf(
      patched,
      "c:minorUnit",
      axis.minorUnit,
      ["c:dispUnits", "c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "baseTimeUnit")) {
    patched = patchValueLeaf(
      patched,
      "c:baseTimeUnit",
      axis.baseTimeUnit,
      ["c:majorUnit", "c:majorTimeUnit", "c:minorUnit", "c:minorTimeUnit", "c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "majorTimeUnit")) {
    patched = patchValueLeaf(
      patched,
      "c:majorTimeUnit",
      axis.majorTimeUnit,
      ["c:minorUnit", "c:minorTimeUnit", "c:extLst"],
      axisTag
    );
  }
  if (rawPatchFlag(patchPlan, "minorTimeUnit")) {
    patched = patchValueLeaf(patched, "c:minorTimeUnit", axis.minorTimeUnit, ["c:extLst"], axisTag);
  }
  return patched;
}

function buildRawScalingXml(scaling: NonNullable<AxisBase["scaling"]> | undefined): string {
  if (!scaling) {
    return "";
  }
  const parts = ["<c:scaling>"];
  // ECMA-376 `CT_Scaling` sequence is `logBase?, orientation?,
  // max?, min?, extLst?`. Emitting children in any other order
  // triggers a "Repaired Records" dialog when Excel opens the
  // file and causes LibreOffice strict-mode to reject it outright.
  if (scaling.logBase !== undefined && Number.isFinite(scaling.logBase) && scaling.logBase > 0) {
    // `CT_LogBase` requires the value be `>= 2` per ECMA-376
    // §21.2.3.21; `> 0` is the looser guard we use at parse time.
    // Leave range clamping to the builder.
    parts.push(`<c:logBase val="${scaling.logBase}"/>`);
  }
  if (scaling.orientation !== undefined) {
    parts.push(`<c:orientation val="${escapeAttr(scaling.orientation)}"/>`);
  }
  // Numeric scaling attributes MUST be finite on the wire; the OOXML
  // grammar requires `xsd:double` / `xsd:unsignedInt`, and writing
  // `val="NaN"` or `val="Infinity"` produces a file Excel refuses to
  // open. `String(NaN) === "NaN"`, so the prior direct interpolation
  // silently passed garbage through. Guard each slot and skip
  // non-finite values — the schema treats absence as "auto", which
  // is closer to the author's intent than an invalid literal.
  if (scaling.max !== undefined && Number.isFinite(scaling.max)) {
    parts.push(`<c:max val="${scaling.max}"/>`);
  }
  if (scaling.min !== undefined && Number.isFinite(scaling.min)) {
    parts.push(`<c:min val="${scaling.min}"/>`);
  }
  parts.push("</c:scaling>");
  return parts.join("");
}

function buildRawNumFmtXml(
  numFmt: { formatCode?: string; sourceLinked?: boolean } | undefined
): string {
  if (!numFmt?.formatCode) {
    return "";
  }
  const sourceLinked = numFmt.sourceLinked === undefined ? "1" : numFmt.sourceLinked ? "1" : "0";
  return `<c:numFmt formatCode="${escapeAttr(numFmt.formatCode)}" sourceLinked="${sourceLinked}"/>`;
}

function patchGridlines(
  block: string,
  tag: string,
  spPr: ShapeProperties | undefined,
  beforeTags: string[],
  parentTag: string
): string {
  const xml = spPr ? `<${tag}>${buildRawShapePropertiesXml(spPr, "c") ?? ""}</${tag}>` : "";
  return patchGenericChild(block, tag, xml, beforeTags, parentTag);
}

function patchValueLeaf(
  block: string,
  tag: string,
  value: unknown,
  beforeTags: string[],
  parentTag: string
): string {
  const xml = value === undefined ? "" : `<${tag} val="${escapeAttr(String(value))}"/>`;
  return patchGenericChild(block, tag, xml, beforeTags, parentTag);
}

function patchBooleanLeaf(
  block: string,
  tag: string,
  value: boolean | undefined,
  beforeTags: string[],
  parentTag: string
): string {
  const xml = value === undefined ? "" : `<${tag} val="${value ? "1" : "0"}"/>`;
  return patchGenericChild(block, tag, xml, beforeTags, parentTag);
}

function buildRawSeriesTxXml(tx: NonNullable<SeriesBase["tx"]>): string {
  if (tx.strRef?.formula) {
    return `<c:tx>${buildRawStrRefXml(tx.strRef)}</c:tx>`;
  }
  return `<c:tx><c:v>${escapeXml(String(tx.value ?? ""))}</c:v></c:tx>`;
}

function buildRawMarkerXml(marker: ChartMarker | undefined): string {
  if (!marker) {
    return "";
  }
  const parts = ["<c:marker>"];
  if (marker.symbol) {
    parts.push(`<c:symbol val="${escapeAttr(String(marker.symbol))}"/>`);
  }
  if (marker.size !== undefined) {
    parts.push(`<c:size val="${marker.size}"/>`);
  }
  if (marker.spPr) {
    parts.push(buildRawShapePropertiesXml(marker.spPr, "c") ?? "");
  }
  if (marker.extLst) {
    parts.push(marker.extLst);
  }
  parts.push("</c:marker>");
  return parts.join("");
}

function buildRawDataPointsXml(dataPoints: DataPoint[] | undefined): string {
  if (!Array.isArray(dataPoints) || dataPoints.length === 0) {
    return "";
  }
  return dataPoints.map(buildRawDataPointXml).join("");
}

function buildRawDataPointXml(point: DataPoint): string {
  const parts = ["<c:dPt>", `<c:idx val="${point.index ?? 0}"/>`];
  if (point.invertIfNegative !== undefined) {
    parts.push(`<c:invertIfNegative val="${point.invertIfNegative ? "1" : "0"}"/>`);
  }
  if (point.marker) {
    parts.push(buildRawMarkerXml(point.marker));
  }
  if (point.bubble3D !== undefined) {
    parts.push(`<c:bubble3D val="${point.bubble3D ? "1" : "0"}"/>`);
  }
  if (point.explosion !== undefined) {
    parts.push(`<c:explosion val="${point.explosion}"/>`);
  }
  if (point.spPr) {
    parts.push(buildRawShapePropertiesXml(point.spPr, "c") ?? "");
  }
  if (point.extLst) {
    parts.push(point.extLst);
  }
  parts.push("</c:dPt>");
  return parts.join("");
}

function buildRawTrendlinesXml(trendlines: Trendline[] | undefined): string {
  if (!Array.isArray(trendlines) || trendlines.length === 0) {
    return "";
  }
  return trendlines.map(buildRawTrendlineXml).join("");
}

function buildRawTrendlineXml(trendline: Trendline): string {
  const parts = ["<c:trendline>"];
  if (trendline.name) {
    parts.push(`<c:name>${escapeXml(String(trendline.name))}</c:name>`);
  }
  if (trendline.spPr) {
    parts.push(buildRawShapePropertiesXml(trendline.spPr, "c") ?? "");
  }
  parts.push(`<c:trendlineType val="${escapeAttr(String(trendline.type ?? "linear"))}"/>`);
  for (const tag of ["order", "period", "forward", "backward", "intercept"] as const) {
    if (trendline[tag] !== undefined) {
      parts.push(`<c:${tag} val="${trendline[tag]}"/>`);
    }
  }
  if (trendline.displayRSqr !== undefined) {
    parts.push(`<c:dispRSqr val="${trendline.displayRSqr ? "1" : "0"}"/>`);
  }
  if (trendline.displayEq !== undefined) {
    parts.push(`<c:dispEq val="${trendline.displayEq ? "1" : "0"}"/>`);
  }
  if (trendline.trendlineLbl) {
    parts.push(buildRawTrendlineLabelXml(trendline.trendlineLbl));
  }
  if (trendline.extLst) {
    parts.push(trendline.extLst);
  }
  parts.push("</c:trendline>");
  return parts.join("");
}

function buildRawTrendlineLabelXml(label: TrendlineLabel): string {
  const parts = ["<c:trendlineLbl>"];
  if (label.layout) {
    parts.push(buildRawLayoutXml(label.layout));
  }
  if (label.rawTx) {
    parts.push(label.rawTx);
  } else if (label.text?.paragraphs?.[0]?.runs?.[0]?.text !== undefined) {
    parts.push(
      `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(String(label.text.paragraphs[0].runs[0].text))}</a:t></a:r></a:p></c:rich></c:tx>`
    );
  }
  if (label.numFmt?.formatCode) {
    parts.push(
      `<c:numFmt formatCode="${escapeAttr(label.numFmt.formatCode)}" sourceLinked="${label.numFmt.sourceLinked ? "1" : "0"}"/>`
    );
  }
  if (label.spPr) {
    parts.push(buildRawShapePropertiesXml(label.spPr, "c") ?? "");
  }
  if (label.txPr) {
    parts.push(buildRawTextPropertiesXml(label.txPr, "c") ?? "");
  }
  if (label.extLst) {
    parts.push(label.extLst);
  }
  parts.push("</c:trendlineLbl>");
  return parts.join("");
}

function buildRawErrorBarsXml(errorBars: any): string {
  const bars = Array.isArray(errorBars) ? errorBars : errorBars ? [errorBars] : [];
  return bars.map(buildRawErrorBarXml).join("");
}

function buildRawErrorBarXml(errorBar: any): string {
  const parts = ["<c:errBars>"];
  if (errorBar.errDir) {
    parts.push(`<c:errDir val="${escapeAttr(String(errorBar.errDir))}"/>`);
  }
  parts.push(`<c:errBarType val="${escapeAttr(String(errorBar.barDir ?? "both"))}"/>`);
  parts.push(`<c:errValType val="${escapeAttr(String(errorBar.errValType ?? "fixedVal"))}"/>`);
  if (errorBar.noEndCap !== undefined) {
    parts.push(`<c:noEndCap val="${errorBar.noEndCap ? "1" : "0"}"/>`);
  }
  if (errorBar.val !== undefined) {
    parts.push(`<c:val val="${errorBar.val}"/>`);
  }
  if (errorBar.plus) {
    parts.push(buildRawDataSourceXml("c:plus", errorBar.plus) ?? "");
  }
  if (errorBar.minus) {
    parts.push(buildRawDataSourceXml("c:minus", errorBar.minus) ?? "");
  }
  if (errorBar.spPr) {
    parts.push(buildRawShapePropertiesXml(errorBar.spPr, "c") ?? "");
  }
  if (errorBar.extLst) {
    parts.push(errorBar.extLst);
  }
  parts.push("</c:errBars>");
  return parts.join("");
}

function buildRawDataSourceXml(tag: string, source: any): string | undefined {
  if (source.strRef) {
    return `<${tag}>${buildRawStrRefXml(source.strRef)}</${tag}>`;
  }
  if (source.numRef) {
    return `<${tag}>${buildRawNumRefXml(source.numRef)}</${tag}>`;
  }
  return undefined;
}

function buildRawNumRefXml(ref: NumberReference): string {
  return `<c:numRef><c:f>${escapeXml(ref.formula)}</c:f>${buildRawNumCacheXml(ref.cache)}</c:numRef>`;
}

function buildRawStrRefXml(ref: StringReference): string {
  return `<c:strRef><c:f>${escapeXml(ref.formula)}</c:f>${buildRawStrCacheXml(ref.cache)}</c:strRef>`;
}

function buildRawNumCacheXml(cache: NumberCache | undefined): string {
  if (!cache) {
    return "";
  }
  const parts = ["<c:numCache>"];
  if (cache.formatCode) {
    parts.push(`<c:formatCode>${escapeXml(cache.formatCode)}</c:formatCode>`);
  }
  if (cache.pointCount !== undefined) {
    parts.push(`<c:ptCount val="${cache.pointCount}"/>`);
  }
  for (const point of cache.points ?? []) {
    if (point.value !== null && point.value !== undefined) {
      parts.push(`<c:pt idx="${point.index}"><c:v>${escapeXml(String(point.value))}</c:v></c:pt>`);
    }
  }
  parts.push("</c:numCache>");
  return parts.join("");
}

function buildRawStrCacheXml(cache: StringCache | undefined): string {
  if (!cache) {
    return "";
  }
  const parts = ["<c:strCache>"];
  if (cache.pointCount !== undefined) {
    parts.push(`<c:ptCount val="${cache.pointCount}"/>`);
  }
  for (const point of cache.points ?? []) {
    parts.push(`<c:pt idx="${point.index}"><c:v>${escapeXml(String(point.value))}</c:v></c:pt>`);
  }
  parts.push("</c:strCache>");
  return parts.join("");
}

function buildRawShapePropertiesXml(
  spPr: ShapeProperties | undefined,
  namespace: "c" | "cx"
): string | undefined {
  if (!spPr) {
    return "";
  }
  if (spPr._rawXml) {
    return normalizeRawNamespace(spPr._rawXml, "spPr", namespace);
  }
  const writer = new XmlWriter();
  const chartNamespace = namespace;
  writer.openNode(`${chartNamespace}:spPr`);
  if (spPr.fill?.noFill) {
    writer.leafNode("a:noFill");
  } else if (spPr.fill?.solid) {
    writer.openNode("a:solidFill");
    writeRawColor(writer, spPr.fill.solid);
    writer.closeNode();
  } else if (spPr.fill?.gradient) {
    writeRawGradientFill(writer, spPr.fill.gradient);
  } else if (spPr.fill?.pattern) {
    const pattern = spPr.fill.pattern;
    writer.openNode("a:pattFill", { prst: pattern.preset });
    if (pattern.foreground) {
      writer.openNode("a:fgClr");
      writeRawColor(writer, pattern.foreground);
      writer.closeNode();
    }
    if (pattern.background) {
      writer.openNode("a:bgClr");
      writeRawColor(writer, pattern.background);
      writer.closeNode();
    }
    writer.closeNode();
  }
  if (spPr.line) {
    const attrs: Record<string, string> = {};
    if (spPr.line.width) {
      attrs.w = String(spPr.line.width);
    }
    if (spPr.line.cap) {
      attrs.cap = spPr.line.cap;
    }
    if (spPr.line.compound) {
      attrs.cmpd = spPr.line.compound;
    }
    writer.openNode("a:ln", attrs);
    if (spPr.line.noFill) {
      writer.leafNode("a:noFill");
    } else if (spPr.line.color) {
      writer.openNode("a:solidFill");
      writeRawColor(writer, spPr.line.color);
      writer.closeNode();
    }
    if (spPr.line.dash) {
      writer.leafNode("a:prstDash", { val: spPr.line.dash });
    }
    if (spPr.line.join === "round") {
      writer.leafNode("a:round");
    } else if (spPr.line.join === "bevel") {
      writer.leafNode("a:bevel");
    } else if (spPr.line.join === "miter") {
      writer.leafNode("a:miter");
    }
    writer.closeNode();
  }
  if (spPr.effectList) {
    writeRawEffectList(writer, spPr.effectList);
  }
  if (spPr.scene3d) {
    writeRawScene3D(writer, spPr.scene3d);
  }
  if (spPr.sp3d) {
    writeRawSp3D(writer, spPr.sp3d);
  }
  writer.closeNode();
  return writer.toString();
}

function buildRawTextPropertiesXml(
  txPr: ChartTextProperties | string | undefined,
  namespace: "c" | "cx"
): string | undefined {
  if (!txPr) {
    return "";
  }
  if (typeof txPr === "string") {
    return normalizeRawNamespace(txPr, "txPr", namespace);
  }
  if (txPr._rawXml) {
    return normalizeRawNamespace(txPr._rawXml, "txPr", namespace);
  }
  const writer = new XmlWriter();
  writer.openNode(`${namespace}:txPr`);
  writer.leafNode(
    "a:bodyPr",
    txPr.rotation !== undefined ? { rot: String(txPr.rotation) } : undefined
  );
  writer.leafNode("a:lstStyle");
  writer.openNode("a:p");
  writer.openNode("a:pPr");
  writeRawRunProperties(writer, txPr, "a:defRPr");
  writer.closeNode();
  writer.leafNode("a:endParaRPr");
  writer.closeNode();
  writer.closeNode();
  return writer.toString();
}

function normalizeRawNamespace(rawXml: string, localName: string, namespace: "c" | "cx"): string {
  return rawXml
    .replace(new RegExp(`^<(?:c|cx):${localName}`), `<${namespace}:${localName}`)
    .replace(new RegExp(`</(?:c|cx):${localName}>$`), `</${namespace}:${localName}>`);
}

function writeRawRunProperties(writer: XmlWriter, props: ChartTextProperties, tag: string): void {
  const attrs: Record<string, string> = {};
  if (props.size !== undefined) {
    attrs.sz = String(props.size);
  }
  if (props.bold !== undefined) {
    attrs.b = props.bold ? "1" : "0";
  }
  if (props.italic !== undefined) {
    attrs.i = props.italic ? "1" : "0";
  }
  if (props.underline !== undefined) {
    attrs.u =
      typeof props.underline === "boolean" ? (props.underline ? "sng" : "none") : props.underline;
  }
  if (props.strike) {
    attrs.strike = props.strike;
  }
  if (props.rotation !== undefined) {
    attrs.rot = String(props.rotation);
  }
  if (props.baseline !== undefined) {
    attrs.baseline = String(props.baseline);
  }
  if (props.kern !== undefined) {
    attrs.kern = String(props.kern);
  }
  if (props.spacing !== undefined) {
    attrs.spc = String(props.spacing);
  }
  if (props.cap) {
    attrs.cap = props.cap;
  }
  if (props.lang) {
    attrs.lang = props.lang;
  }
  const hasChildren = !!(
    props.color ||
    props.fontFamily ||
    props.eastAsianFamily ||
    props.complexScriptFamily
  );
  if (!hasChildren) {
    writer.leafNode(tag, attrs);
    return;
  }
  writer.openNode(tag, attrs);
  if (props.color) {
    writer.openNode("a:solidFill");
    writeRawColor(writer, props.color);
    writer.closeNode();
  }
  if (props.fontFamily) {
    writer.leafNode("a:latin", { typeface: props.fontFamily });
  }
  if (props.eastAsianFamily) {
    writer.leafNode("a:ea", { typeface: props.eastAsianFamily });
  }
  if (props.complexScriptFamily) {
    writer.leafNode("a:cs", { typeface: props.complexScriptFamily });
  }
  writer.closeNode();
}

function writeRawColor(writer: XmlWriter, color: ChartColor): void {
  const modifiers = buildRawColorModifiersXml(color);
  const writeColorNode = (tag: string, val: string) => {
    if (!modifiers) {
      writer.leafNode(tag, { val });
      return;
    }
    writer.openNode(tag, { val });
    writer.writeRaw(modifiers);
    writer.closeNode();
  };
  if (color.srgb) {
    writeColorNode("a:srgbClr", color.srgb);
  } else if (color.theme !== undefined) {
    const themeNames = [
      "dk1",
      "lt1",
      "dk2",
      "lt2",
      "accent1",
      "accent2",
      "accent3",
      "accent4",
      "accent5",
      "accent6",
      "hlink",
      "folHlink"
    ];
    writeColorNode("a:schemeClr", themeNames[color.theme] ?? "dk1");
  } else if (color.schemeName) {
    // Unknown scheme colour tokens (e.g. `phClr`, vendor extensions)
    // round-trip as `<a:schemeClr>` — keeping the element identity
    // intact. Previously these fell through to `<a:sysClr>` via the
    // parser, silently changing the DrawingML colour kind.
    writeColorNode("a:schemeClr", color.schemeName);
  } else if (color.sysClr) {
    writeColorNode("a:sysClr", color.sysClr);
  } else if (color.prstClr) {
    writeColorNode("a:prstClr", color.prstClr);
  }
}

function writeRawGradientFill(
  writer: XmlWriter,
  gradient: NonNullable<ChartFill["gradient"]>
): void {
  if (!Array.isArray(gradient.stops) || gradient.stops.length < 2) {
    return;
  }
  writer.openNode("a:gradFill");
  writer.openNode("a:gsLst");
  for (const stop of gradient.stops) {
    // OOXML `<a:gs pos>` is hundredths of a percent (0–100000). See
    // the matching fixes in `chart-space-xform.ts` and
    // `chart-ex-renderer.ts`; the previous `×1000` multiplier was
    // 100× too small and produced gradients in Excel at wildly
    // wrong positions.
    const encoded = Math.max(0, Math.min(100000, Math.round(stop.position * 100000)));
    writer.openNode("a:gs", { pos: String(encoded) });
    writeRawColor(writer, stop.color);
    writer.closeNode();
  }
  writer.closeNode();
  if (gradient.type === "circle" || gradient.type === "rect" || gradient.type === "shape") {
    // Preserve parsed `fillToRect` focal rectangle when present;
    // default to Excel's centred form (all components at 50%).
    // `CT_FillToRectangle` sides are `ST_Percentage`, which permits
    // negative values (focal point outside the shape). Don't clamp
    // to `[0, 100000]` — negative focal points were being lost on
    // round-trip before this fix.
    const rect = gradient.fillToRect;
    const pct = (v: number | undefined, def: number): number => {
      if (v === undefined) {
        return def;
      }
      return Math.round(v * 100000);
    };
    writer.openNode("a:path", { path: gradient.type });
    writer.leafNode("a:fillToRect", {
      l: String(pct(rect?.left, 50000)),
      t: String(pct(rect?.top, 50000)),
      r: String(pct(rect?.right, 50000)),
      b: String(pct(rect?.bottom, 50000))
    });
    writer.closeNode();
  } else {
    // Emit `scaled` only when the author explicitly set it; mirrors
    // the structured ChartEx renderer (chart-ex-renderer.ts line
    // 4782) so both paths produce the same bytes. Previously this
    // raw writer unconditionally stamped `scaled="1"`, which
    // overwrote a parsed `scaled="0"` on round-trip — a visible
    // drift for gradients with the shape-independent orientation
    // mode. The OOXML default is `false` per `CT_LinearShadeProperties`,
    // so omitting it when absent is lossless.
    const linAttrs: Record<string, string> = {
      ang: String(Math.round((gradient.angle ?? 0) * 60000))
    };
    if (gradient.scaled !== undefined) {
      linAttrs.scaled = gradient.scaled ? "1" : "0";
    }
    writer.leafNode("a:lin", linAttrs);
  }
  writer.closeNode();
}

function writeRawEffectList(writer: XmlWriter, effects: EffectList): void {
  writer.openNode("a:effectLst");
  if (effects.blur) {
    const attrs: Record<string, string> = {};
    if (effects.blur.radius !== undefined) {
      attrs.rad = String(effects.blur.radius);
    }
    if (effects.blur.grow !== undefined) {
      attrs.grow = effects.blur.grow ? "1" : "0";
    }
    writer.leafNode("a:blur", attrs);
  }
  if (effects.outerShadow) {
    writeRawShadow(writer, "a:outerShdw", effects.outerShadow);
  }
  if (effects.innerShadow) {
    writeRawShadow(writer, "a:innerShdw", effects.innerShadow);
  }
  if (effects.presetShadow) {
    const ps = effects.presetShadow;
    const attrs: Record<string, string> = { prst: ps.preset };
    if (ps.distance !== undefined) {
      attrs.dist = String(ps.distance);
    }
    if (ps.direction !== undefined) {
      attrs.dir = String(ps.direction);
    }
    writer.openNode("a:prstShdw", attrs);
    if (ps.color) {
      writeRawColor(writer, ps.color);
    }
    writer.closeNode();
  }
  if (effects.glow) {
    writer.openNode("a:glow", { rad: String(effects.glow.radius) });
    writeRawColor(writer, effects.glow.color);
    writer.closeNode();
  }
  if (effects.softEdge) {
    writer.leafNode("a:softEdge", { rad: String(effects.softEdge.radius) });
  }
  if (effects.reflection) {
    const reflection = effects.reflection;
    const attrs: Record<string, string> = {};
    for (const [key, value] of [
      ["blurRad", reflection.blurRadius],
      ["stA", reflection.startOpacity],
      ["stPos", reflection.startPosition],
      ["endA", reflection.endOpacity],
      ["endPos", reflection.endPosition],
      ["dist", reflection.distance],
      ["dir", reflection.direction],
      ["fadeDir", reflection.fadeDirection],
      ["sx", reflection.scaleHorizontal],
      ["sy", reflection.scaleVertical],
      ["kx", reflection.skewHorizontal],
      ["ky", reflection.skewVertical],
      ["algn", reflection.alignment],
      ["rotWithShape", reflection.rotateWithShape]
    ] as const) {
      if (value !== undefined) {
        attrs[key] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
      }
    }
    writer.leafNode("a:reflection", attrs);
  }
  writer.closeNode();
}

function writeRawShadow(writer: XmlWriter, tag: string, shadow: Shadow): void {
  const attrs: Record<string, string> = {};
  for (const [key, value] of [
    ["blurRad", shadow.blurRadius],
    ["dist", shadow.distance],
    ["dir", shadow.direction],
    ["algn", shadow.alignment],
    ["rotWithShape", shadow.rotateWithShape],
    ["sx", shadow.scaleHorizontal],
    ["sy", shadow.scaleVertical],
    ["kx", shadow.skewHorizontal],
    ["ky", shadow.skewVertical]
  ] as const) {
    if (value !== undefined) {
      attrs[key] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    }
  }
  writer.openNode(tag, attrs);
  writeRawColor(writer, shadow.color);
  writer.closeNode();
}

function writeRawScene3D(writer: XmlWriter, scene: Scene3D): void {
  writer.openNode("a:scene3d");
  if (scene.camera) {
    const camera = scene.camera;
    const attrs: Record<string, string> = { prst: camera.preset };
    if (camera.fov !== undefined) {
      attrs.fov = String(camera.fov);
    }
    if (camera.zoom !== undefined) {
      attrs.zoom = String(camera.zoom);
    }
    if (camera.rotation) {
      writer.openNode("a:camera", attrs);
      writer.leafNode("a:rot", {
        lat: String(camera.rotation.lat),
        lon: String(camera.rotation.lon),
        rev: String(camera.rotation.rev)
      });
      writer.closeNode();
    } else {
      writer.leafNode("a:camera", attrs);
    }
  }
  if (scene.lightRig) {
    const lightRig = scene.lightRig;
    const attrs: Record<string, string> = { rig: lightRig.rig, dir: lightRig.direction };
    if (lightRig.rotation) {
      writer.openNode("a:lightRig", attrs);
      writer.leafNode("a:rot", {
        lat: String(lightRig.rotation.lat),
        lon: String(lightRig.rotation.lon),
        rev: String(lightRig.rotation.rev)
      });
      writer.closeNode();
    } else {
      writer.leafNode("a:lightRig", attrs);
    }
  }
  writer.closeNode();
}

function writeRawSp3D(writer: XmlWriter, sp3d: ShapeProperties3D): void {
  const attrs: Record<string, string> = {};
  if (sp3d.z !== undefined) {
    attrs.z = String(sp3d.z);
  }
  if (sp3d.extrusionHeight !== undefined) {
    attrs.extrusionH = String(sp3d.extrusionHeight);
  }
  if (sp3d.contourWidth !== undefined) {
    attrs.contourW = String(sp3d.contourWidth);
  }
  if (sp3d.material) {
    attrs.prstMaterial = sp3d.material;
  }
  const hasChildren = !!(
    sp3d.bevelTop ||
    sp3d.bevelBottom ||
    sp3d.extrusionColor ||
    sp3d.contourColor
  );
  if (!hasChildren) {
    writer.leafNode("a:sp3d", attrs);
    return;
  }
  writer.openNode("a:sp3d", attrs);
  if (sp3d.bevelTop) {
    writeRawBevel(writer, "a:bevelT", sp3d.bevelTop);
  }
  if (sp3d.bevelBottom) {
    writeRawBevel(writer, "a:bevelB", sp3d.bevelBottom);
  }
  if (sp3d.extrusionColor) {
    writer.openNode("a:extrusionClr");
    writeRawColor(writer, sp3d.extrusionColor);
    writer.closeNode();
  }
  if (sp3d.contourColor) {
    writer.openNode("a:contourClr");
    writeRawColor(writer, sp3d.contourColor);
    writer.closeNode();
  }
  writer.closeNode();
}

function writeRawBevel(writer: XmlWriter, tag: string, bevel: Bevel): void {
  const attrs: Record<string, string> = {};
  if (bevel.width !== undefined) {
    attrs.w = String(bevel.width);
  }
  if (bevel.height !== undefined) {
    attrs.h = String(bevel.height);
  }
  if (bevel.preset) {
    attrs.prst = bevel.preset;
  }
  writer.leafNode(tag, attrs);
}

function buildRawColorModifiersXml(color: ChartColor): string {
  // Each modifier must serialise as `<a:* val="N"/>` where `N` is a
  // valid `xsd:int`. Previously the raw patcher interpolated model
  // values directly, so `NaN` / `Infinity` / unrounded floats leaked
  // into the attribute and Excel's strict reader rejected the file
  // with "invalid attribute value for xs:int". The structured renderer
  // (`renderColorModifiers` in chart-ex-renderer.ts) guards with
  // `Number.isFinite` + `Math.round` — mirror that here so both write
  // paths produce identical bytes, then share the helper.
  const parts: string[] = [];
  const emitInt = (tag: string, value: number | undefined): void => {
    if (value === undefined || !Number.isFinite(value)) {
      return;
    }
    parts.push(`<a:${tag} val="${Math.round(value)}"/>`);
  };
  emitInt("alpha", color.alpha);
  // `tint` on the public `ChartColor` is a 0..1 fraction; convert to
  // the DrawingML 0..100000 per-thousand integer here. DrawingML also
  // permits NEGATIVE tint (shade toward black) per
  // `CT_PositiveFixedPercentage` — the structured path preserves the
  // sign, so we do too.
  if (color.tint !== undefined && Number.isFinite(color.tint)) {
    parts.push(`<a:tint val="${Math.round(color.tint * 100000)}"/>`);
  }
  emitInt("shade", color.shade);
  emitInt("satMod", color.satMod);
  emitInt("lumMod", color.lumMod);
  emitInt("lumOff", color.lumOff);
  return parts.join("");
}

function patchRawChartExSeries(
  raw: string,
  chart: any,
  patchPlan: ChartExRawPatchPlan
): string | undefined {
  const seriesModels = extractChartExSeries({ chartSpace: { chart } });
  let index = 0;
  return replaceXmlBlocks(raw, "cx:series", block => {
    const series = seriesModels[index++];
    const seriesPlan = getRawPatchListItem(patchPlan.series, index - 1);
    return series && seriesPlan ? patchRawChartExSeriesBlock(block, series, seriesPlan) : block;
  });
}

function patchRawChartExSeriesBlock(
  block: string,
  series: any,
  patchPlan: ChartExSeriesRawPatchPlan | true
): string {
  // Child sequence per Chart2014 `CT_Series`:
  //
  //   tx? → spPr? → txPr? → valueColors? → valueColorPositions? →
  //   dataPt* → dataLabels? → dataId* → layoutPr? → axisId* → extLst?
  //
  // The sibling arrays below describe the elements that must come
  // AFTER the element being inserted so `replaceOrInsertBeforeGeneric`
  // can splice into the right position. Previous versions used
  // sibling lists that put `dataId` before `dataLabels` / `dataPt` —
  // reversing the schema order and producing files strict validators
  // reject. Use the real schema order so raw-patch output matches
  // what `renderSeries` produces for the same model.
  const afterTx = [
    "cx:spPr",
    "cx:txPr",
    "cx:valueColors",
    "cx:valueColorPositions",
    "cx:dataPt",
    "cx:dataLabels",
    "cx:dataId",
    "cx:layoutPr",
    "cx:axisId",
    "cx:extLst"
  ];
  const afterSpPr = [
    "cx:txPr",
    "cx:valueColors",
    "cx:valueColorPositions",
    "cx:dataPt",
    "cx:dataLabels",
    "cx:dataId",
    "cx:layoutPr",
    "cx:axisId",
    "cx:extLst"
  ];
  const afterDataPt = ["cx:dataLabels", "cx:dataId", "cx:layoutPr", "cx:axisId", "cx:extLst"];
  const afterDataLabels = ["cx:dataId", "cx:layoutPr", "cx:axisId", "cx:extLst"];
  const afterDataId = ["cx:layoutPr", "cx:axisId", "cx:extLst"];
  const afterLayoutPr = ["cx:axisId", "cx:extLst"];
  const afterAxisId = ["cx:extLst"];
  let patched = block;
  if (rawPatchFlag(patchPlan, "hidden")) {
    patched = patchOpeningTagBooleanAttribute(patched, "cx:series", "hidden", series.hidden);
  }
  if (rawPatchFlag(patchPlan, "ownerIdx")) {
    patched = patchOpeningTagIntegerAttribute(patched, "cx:series", "ownerIdx", series.ownerIdx);
  }
  if (rawPatchFlag(patchPlan, "tx")) {
    patched = patchGenericChild(
      patched,
      "cx:tx",
      buildRawChartExSeriesTxXml(series.tx),
      afterTx,
      "cx:series"
    );
  }
  if (rawPatchFlag(patchPlan, "spPr")) {
    patched = patchGenericChild(
      patched,
      "cx:spPr",
      buildRawShapePropertiesXml(series.spPr, "cx"),
      afterSpPr,
      "cx:series"
    );
  }
  if (rawPatchFlag(patchPlan, "dataPoints")) {
    const dataPointXml = (series.dataPt ?? [])
      .map((point: any) => {
        const spPrXml = buildRawShapePropertiesXml(point.spPr, "cx") ?? "";
        return `<cx:dataPt idx="${point.idx}">${spPrXml}</cx:dataPt>`;
      })
      .join("");
    patched = patchRepeatingChildren(patched, "cx:dataPt", dataPointXml, afterDataPt, "cx:series");
  }
  if (rawPatchFlag(patchPlan, "dataLabels")) {
    patched = patchGenericChild(
      patched,
      "cx:dataLabels",
      buildRawChartExDataLabelsXml(series.dataLabels),
      afterDataLabels,
      "cx:series"
    );
  }
  if (rawPatchFlag(patchPlan, "dataRefs")) {
    const dataRefsXml = (series.dataRefs ?? [])
      .map((ref: any) =>
        ref.dataId !== undefined
          ? `<cx:dataId val="${ref.dataId}"/>`
          : ref.axisId !== undefined
            ? `<cx:axisId val="${ref.axisId}"/>`
            : ""
      )
      .join("");
    patched = patchRepeatingChildren(patched, "cx:dataId", dataRefsXml, afterDataId, "cx:series");
  }
  if (rawPatchFlag(patchPlan, "layoutPr")) {
    patched = patchGenericChild(
      patched,
      "cx:layoutPr",
      buildRawChartExLayoutPropertiesXml(series.layoutId, series.layoutPr),
      afterLayoutPr,
      "cx:series"
    );
  }
  if (rawPatchFlag(patchPlan, "axisId")) {
    const axisIdsXml = (series.axisId ?? [])
      .map((id: number) => `<cx:axisId val="${id}"/>`)
      .join("");
    patched = patchRepeatingChildren(patched, "cx:axisId", axisIdsXml, afterAxisId, "cx:series");
  }
  return patched;
}

function buildRawChartExSeriesTxXml(tx: NonNullable<ChartExSeries["tx"]> | undefined): string {
  if (!tx) {
    return "";
  }
  if (tx.rich) {
    // Round-trip parity with the structured writer — ChartEx series
    // names authored as rich text (per-run formatting, bold / colour
    // / font-family overrides) used to be silently dropped by the raw
    // patcher: only `tx.value` and `tx.strRef` were handled, so a
    // mutation that preserved `tx.rich` on the model would re-emit
    // `<cx:tx/>` without a `<cx:rich>` child, collapsing the label to
    // an unstyled placeholder. Emit a minimal `<cx:tx><cx:rich>…`
    // subtree carrying the paragraph / run structure. The rPr helper
    // is a pragmatic subset (size / bold / italic / color) — features
    // beyond that flight through the structured path, which is the
    // default when `preferRawPatch` isn't opt-in.
    return `<cx:tx>${buildRawChartExRichTextXml(tx.rich)}</cx:tx>`;
  }
  if (tx.value !== undefined) {
    return `<cx:tx><cx:txData><cx:v>${escapeXml(String(tx.value))}</cx:v></cx:txData></cx:tx>`;
  }
  if (tx.strRef !== undefined) {
    // `tx.strRef` is declared as `string | { formula: string; cached?: string }`
    // on `ChartExSeries.tx`. The previous writer coerced via
    // `String(tx.strRef)`, which produced the literal `"[object Object]"`
    // for the structured form — silently corrupting the formula on every
    // series that carried a `{ formula, cached }` pair through the raw
    // patch path.
    let formula: string;
    let cached: string | undefined;
    if (typeof tx.strRef === "string") {
      formula = tx.strRef;
    } else if (
      tx.strRef &&
      typeof tx.strRef === "object" &&
      typeof tx.strRef.formula === "string"
    ) {
      formula = tx.strRef.formula;
      cached = typeof tx.strRef.cached === "string" ? tx.strRef.cached : undefined;
    } else {
      // Degenerate shape (unknown form) — drop the element rather than
      // emit `<cx:f>[object Object]</cx:f>` and corrupt the formula.
      return "";
    }
    const cachedEl = cached !== undefined ? `<cx:v>${escapeXml(cached)}</cx:v>` : "";
    return `<cx:tx><cx:txData><cx:f>${escapeXml(formula)}</cx:f>${cachedEl}</cx:txData></cx:tx>`;
  }
  return "";
}

/**
 * Minimal `<cx:rich>` emitter used by the ChartEx raw patcher when a
 * series `tx` carries a `rich` paragraph tree. Mirrors the structured
 * renderer's output shape (`renderRichText` in `chart-ex-renderer`)
 * for the attributes the raw patch path needs — size / bold / italic
 * and the text colour — so round-trip parity is preserved for the
 * common "bold label" case. Features outside this subset (mixed font
 * families, east-Asian runs, paragraph properties) flow through the
 * structured writer, which the mutation helper invokes by default;
 * `preferRawPatch` callers who need the full set should stay on
 * structural rebuilds.
 */
function buildRawChartExRichTextXml(rich: ChartRichText | undefined): string {
  if (!rich || !Array.isArray(rich.paragraphs)) {
    return "";
  }
  const parts: string[] = ["<cx:rich>", "<a:bodyPr/>", "<a:lstStyle/>"];
  for (const p of rich.paragraphs) {
    parts.push("<a:p>");
    for (const run of p.runs ?? []) {
      const rPr = buildRawChartExRunPropertiesXml(run.properties);
      // Preserve significant whitespace — matches the structured
      // writer's `xml:space="preserve"` rule (see `needsXmlSpacePreserve`).
      const text = typeof run.text === "string" ? run.text : "";
      const needsPreserve = /^\s|\s$|[\t\n\r]/.test(text);
      const tAttrs = needsPreserve ? ' xml:space="preserve"' : "";
      parts.push(`<a:r>${rPr}<a:t${tAttrs}>${escapeXml(text)}</a:t></a:r>`);
    }
    parts.push('<a:endParaRPr lang="en-US"/>');
    parts.push("</a:p>");
  }
  parts.push("</cx:rich>");
  return parts.join("");
}

function buildRawChartExRunPropertiesXml(props: ChartTextProperties | undefined): string {
  if (!props || typeof props !== "object") {
    return "";
  }
  const attrs: string[] = [];
  if (typeof props.size === "number" && Number.isFinite(props.size)) {
    attrs.push(`sz="${props.size}"`);
  }
  if (props.bold !== undefined) {
    attrs.push(`b="${props.bold ? 1 : 0}"`);
  }
  if (props.italic !== undefined) {
    attrs.push(`i="${props.italic ? 1 : 0}"`);
  }
  // Inline colour child only — the full `<a:solidFill>` emitter is
  // intentionally out of scope for the raw patcher (structural
  // rebuild handles anything beyond srgbClr / theme).
  const color = props.color;
  let colorChild = "";
  if (color && typeof color === "object") {
    if (typeof color.srgb === "string") {
      colorChild = `<a:solidFill><a:srgbClr val="${escapeAttr(color.srgb)}"/></a:solidFill>`;
    } else if (typeof color.theme === "number") {
      // `color.theme` is a 0-based index into the workbook's theme
      // palette — 0..3 are bg/lt1/dk2/lt2, 4..9 are accent1..accent6,
      // 10..11 are hlink / folHlink. The previous implementation
      // emitted `accent${color.theme}`, which produced nonsense
      // (`accent4` for `theme=4` instead of `accent1`; `accent0` for
      // `theme=0` which is not even a valid DrawingML scheme slot).
      // Route through the canonical helper shared with the
      // structural emitters so the mapping stays in one place.
      colorChild = `<a:solidFill><a:schemeClr val="${escapeAttr(themeIndexToName(color.theme))}"/></a:solidFill>`;
    }
  }
  if (attrs.length === 0 && !colorChild) {
    return "";
  }
  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  return colorChild ? `<a:rPr${attrStr}>${colorChild}</a:rPr>` : `<a:rPr${attrStr}/>`;
}

function buildRawChartExLayoutPropertiesXml(layoutId: string, layoutPr: any): string {
  if (!layoutPr) {
    return "";
  }
  if (layoutPr._rawXml && !hasStructuredChartExLayoutProperties(layoutPr)) {
    return layoutPr._rawXml;
  }
  const parts = ["<cx:layoutPr>"];
  if (layoutPr.parentLabelLayout && (layoutId === "sunburst" || layoutId === "treemap")) {
    parts.push(`<cx:parentLabelLayout val="${escapeAttr(layoutPr.parentLabelLayout)}"/>`);
  }
  if (layoutPr.subtotals && layoutId === "waterfall") {
    parts.push("<cx:subtotals>");
    for (const subtotal of layoutPr.subtotals) {
      parts.push(`<cx:subtotal idx="${subtotal.idx}"/>`);
    }
    parts.push("</cx:subtotals>");
  }
  if (layoutId === "waterfall" && layoutPr.connectorLines !== undefined) {
    parts.push(`<cx:connectorLines val="${layoutPr.connectorLines ? "1" : "0"}"/>`);
  }
  if (layoutPr.binning) {
    const binning = layoutPr.binning;
    const attrs = [
      binning.intervalClosed === "l" || binning.intervalClosed === "r"
        ? `intervalClosed="${escapeAttr(binning.intervalClosed)}"`
        : undefined,
      binning.underflow !== undefined && Number.isFinite(binning.underflow)
        ? `underflow="${binning.underflow}"`
        : undefined,
      binning.overflow !== undefined && Number.isFinite(binning.overflow)
        ? `overflow="${binning.overflow}"`
        : undefined
    ].filter((attr): attr is string => !!attr);
    parts.push(`<cx:binning${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>`);
    // CT_Binning schema order: choice(auto|categories|manual)
    // followed by optional binSize and binCount. Previously the raw
    // patcher emitted `<cx:auto/>` then `<cx:binSize/>` then
    // `<cx:binCount/>` then `<cx:categories/>` / `<cx:manual/>` — but
    // `categories`/`manual` are mutually exclusive with `auto`, and
    // emitting them after binSize/binCount puts them out of the
    // schema sequence. The parser's priority chain at
    // `chart-ex-parser.ts:parseLayoutProperties` resolves
    // auto > categories > manual, so the stray trailing elements
    // never round-tripped back anyway. Mirror the structured
    // renderer's order: one discriminator first, then the numeric
    // children.
    if (binning.binType === "auto") {
      parts.push("<cx:auto/>");
    } else if (binning.binType === "categories") {
      parts.push("<cx:categories/>");
    } else if (binning.binType === "manual") {
      parts.push("<cx:manual/>");
    }
    if (binning.binSize !== undefined && Number.isFinite(binning.binSize)) {
      parts.push(`<cx:binSize val="${binning.binSize}"/>`);
    }
    if (binning.binCount !== undefined && Number.isFinite(binning.binCount)) {
      parts.push(`<cx:binCount val="${binning.binCount}"/>`);
    }
    parts.push("</cx:binning>");
  }
  // `paretoLine` is only a valid child when the enclosing layout is a
  // pareto (clusteredColumn with pareto overlay, or the standalone
  // `paretoLine` layoutId). Emit the explicit boolean — including
  // `false` — so round-trip of user-suppressed pareto overlays
  // matches the structured writer. Previously `if (layoutPr.paretoLine)`
  // silently dropped the `false` case, re-enabling the line on save.
  if (
    layoutPr.paretoLine !== undefined &&
    (layoutId === "clusteredColumn" || layoutId === "paretoLine")
  ) {
    parts.push(`<cx:paretoLine val="${layoutPr.paretoLine ? "1" : "0"}"/>`);
  }
  if (layoutId === "boxWhisker") {
    for (const [name, value] of [
      ["quartileMethod", layoutPr.quartileMethod],
      ["showMeanLine", layoutPr.showMeanLine],
      ["showMeanMarker", layoutPr.showMeanMarker],
      ["showInnerPoints", layoutPr.showInnerPoints],
      ["showOutlierPoints", layoutPr.showOutlierPoints]
    ] as const) {
      if (value !== undefined) {
        parts.push(
          `<cx:${name} val="${typeof value === "boolean" ? (value ? "1" : "0") : escapeAttr(String(value))}"/>`
        );
      }
    }
  }
  if (layoutId === "regionMap") {
    for (const [name, value] of [
      ["projection", layoutPr.projection],
      ["regionLabels", layoutPr.regionLabels],
      ["geoMappingLevel", layoutPr.geoMappingLevel]
    ] as const) {
      if (value !== undefined) {
        parts.push(`<cx:${name} val="${escapeAttr(String(value))}"/>`);
      }
    }
  }
  if (layoutPr.extLst) {
    parts.push(layoutPr.extLst);
  }
  parts.push("</cx:layoutPr>");
  return parts.join("");
}

function hasStructuredChartExLayoutProperties(layoutPr: any): boolean {
  // `increaseSpPr` / `decreaseSpPr` / `totalSpPr` are **preview-only**
  // fields consumed by the SVG/PDF renderer to colour waterfall bars;
  // Chart2014 has no schema slot for them (per-point styling lives on
  // `<cx:dataPt>` instead). Do NOT treat setting one as a "structured
  // mutation" — doing so would force the raw patcher onto the
  // structured rebuild path and discard `_rawXml`, silently dropping
  // every other property the raw bytes carried. The structured
  // renderer (`hasStructuredLayoutProperties` in chart-ex-renderer.ts)
  // uses the same exclusion list; keeping the two helpers in sync
  // prevents asymmetric behaviour between raw-patch and rebuild.
  return [
    layoutPr.parentLabelLayout,
    layoutPr.subtotals,
    layoutPr.connectorLines,
    layoutPr.binning,
    layoutPr.paretoLine,
    layoutPr.quartileMethod,
    layoutPr.showMeanLine,
    layoutPr.showMeanMarker,
    layoutPr.showInnerPoints,
    layoutPr.showOutlierPoints,
    layoutPr.projection,
    layoutPr.regionLabels,
    layoutPr.geoMappingLevel
  ].some(value => value !== undefined);
}

function buildRawChartExDataLabelsXml(dataLabels: any): string {
  if (!dataLabels) {
    return "";
  }
  const parts = ["<cx:dataLabels>"];
  if (dataLabels.visibility) {
    const attrs = [
      dataLabels.visibility.seriesName !== undefined
        ? `seriesName="${dataLabels.visibility.seriesName ? "1" : "0"}"`
        : undefined,
      dataLabels.visibility.categoryName !== undefined
        ? `categoryName="${dataLabels.visibility.categoryName ? "1" : "0"}"`
        : undefined,
      dataLabels.visibility.value !== undefined
        ? `value="${dataLabels.visibility.value ? "1" : "0"}"`
        : undefined,
      dataLabels.visibility.numFmt !== undefined
        ? `numFmt="${dataLabels.visibility.numFmt ? "1" : "0"}"`
        : undefined
    ].filter((attr): attr is string => !!attr);
    parts.push(`<cx:visibility ${attrs.join(" ")}/>`);
  }
  if (dataLabels.position) {
    parts.push(`<cx:dataLabel pos="${escapeAttr(dataLabels.position)}"/>`);
  }
  if (dataLabels.separator) {
    parts.push(`<cx:separator>${escapeXml(String(dataLabels.separator))}</cx:separator>`);
  }
  if (dataLabels.numFmt) {
    parts.push(`<cx:numFmt formatCode="${escapeAttr(String(dataLabels.numFmt))}"/>`);
  }
  if (dataLabels.spPr) {
    parts.push(buildRawShapePropertiesXml(dataLabels.spPr, "cx") ?? "");
  }
  if (dataLabels.txPr) {
    parts.push(buildRawTextPropertiesXml(dataLabels.txPr, "cx") ?? "");
  }
  parts.push("</cx:dataLabels>");
  return parts.join("");
}

function patchRawChartExAxes(
  raw: string,
  chart: any,
  patchPlan: RawPatchListPlan<ChartExAxisRawPatchPlan>
): string | undefined {
  let patched = raw;
  for (const [index, axis] of (chart.plotArea?.axis ?? []).entries()) {
    const axisPlan = getRawPatchListItem(patchPlan, index);
    if (!axisPlan) {
      continue;
    }
    const range = findChartExAxisBlock(patched, axis.axisId);
    if (!range) {
      return undefined;
    }
    const axisXml = patchRawChartExAxisBlock(range.xml, axis, axisPlan);
    patched = patched.slice(0, range.start) + axisXml + patched.slice(range.end);
  }
  return patched;
}

function patchRawChartExAxisBlock(
  block: string,
  axis: any,
  patchPlan: ChartExAxisRawPatchPlan | true
): string {
  // `CT_Axis` child sequence (Chart2014):
  //
  //   (catScaling | valScaling) → title → units →
  //   majorTickMarks → minorTickMarks →
  //   majorGridlines → minorGridlines →
  //   numFmt → txPr → spPr → extLst
  //
  // (The structured renderer emits `txPr` before `spPr` to match
  // Excel's real output; some schema mirrors put spPr first, but
  // Excel itself serialises txPr first and readers accept both. The
  // raw patcher mirrors the structured renderer so both paths land
  // byte-identical XML for the same model.)
  //
  // Sibling lists describe every element that must come AFTER the
  // element being inserted. Older versions of the patcher used
  // sibling arrays that put `majorTickMarks` before
  // `title`/`valScaling`/`catScaling`, inverting the schema — strict
  // validators rejected the output and Excel's own reader silently
  // dropped whichever element landed out of position.
  const afterScaling = [
    "cx:title",
    "cx:units",
    "cx:majorTickMarks",
    "cx:majorTickMark",
    "cx:minorTickMarks",
    "cx:minorTickMark",
    "cx:majorGridlines",
    "cx:minorGridlines",
    "cx:numFmt",
    "cx:txPr",
    "cx:spPr",
    "cx:extLst"
  ];
  const afterTitle = [
    "cx:units",
    "cx:majorTickMarks",
    "cx:majorTickMark",
    "cx:minorTickMarks",
    "cx:minorTickMark",
    "cx:majorGridlines",
    "cx:minorGridlines",
    "cx:numFmt",
    "cx:txPr",
    "cx:spPr",
    "cx:extLst"
  ];
  const afterMajorTicks = [
    "cx:minorTickMarks",
    "cx:minorTickMark",
    "cx:majorGridlines",
    "cx:minorGridlines",
    "cx:numFmt",
    "cx:txPr",
    "cx:spPr",
    "cx:extLst"
  ];
  const afterMinorTicks = [
    "cx:majorGridlines",
    "cx:minorGridlines",
    "cx:numFmt",
    "cx:txPr",
    "cx:spPr",
    "cx:extLst"
  ];
  const afterNumFmt = ["cx:txPr", "cx:spPr", "cx:extLst"];
  const afterTxPr = ["cx:spPr", "cx:extLst"];
  const afterSpPr = ["cx:extLst"];
  let patched = block;
  if (rawPatchFlag(patchPlan, "hidden")) {
    // `CT_Axis/@hidden` is an **attribute** on the opening `<cx:axis>`
    // tag per ECMA-376 Chart2014, not a child element. Previously
    // this raw-patch path emitted `<cx:hidden val="1"/>` as a child,
    // which strict validators reject. Replay the mutation as an
    // attribute tweak on the opening tag. When `axis.hidden` is
    // `undefined` the attribute is removed entirely; explicit `false`
    // lands `hidden="0"` so files that carried an affirmative
    // visibility marker round-trip byte-identically.
    patched = patchXmlAttribute(patched, "cx:axis", "hidden", axis.hidden);
    // Clean up any stale child `<cx:hidden/>` bytes left over from
    // legacy output that predated the attribute rewrite — the parser
    // accepts both forms (see `chart-ex-parser.ts:parseAxis`), so
    // round-tripping an older file must eliminate the legacy form.
    patched = removeXmlBlock(patched, "cx:hidden");
  }
  if (rawPatchFlag(patchPlan, "valScaling")) {
    patched = patchGenericChild(
      patched,
      "cx:valScaling",
      buildRawChartExScalingXml("valScaling", axis.valScaling),
      afterScaling,
      "cx:axis"
    );
  }
  if (rawPatchFlag(patchPlan, "catScaling")) {
    patched = patchGenericChild(
      patched,
      "cx:catScaling",
      buildRawChartExScalingXml("catScaling", axis.catScaling),
      afterScaling,
      "cx:axis"
    );
  }
  if (rawPatchFlag(patchPlan, "title")) {
    if (axis.title) {
      const text = axis.title.text?.paragraphs?.[0]?.runs?.[0]?.text;
      if (text !== undefined) {
        patched = patchGenericChild(
          patched,
          "cx:title",
          buildRawChartExTitleXml(text),
          afterTitle,
          "cx:axis"
        );
      }
    } else {
      patched = removeXmlBlock(patched, "cx:title");
    }
  }
  if (rawPatchFlag(patchPlan, "majorTickMark")) {
    // `cx:majorTickMark` in the Chart2014 schema is the **plural**
    // `majorTickMarks`. Earlier versions of this library emitted the
    // classic-chart singular form; the raw patcher now always lands
    // the plural, and strips any stale singular leftover so repeated
    // patches don't duplicate the element.
    patched = removeXmlBlock(patched, "cx:majorTickMark");
    patched = patchValueLeaf(
      patched,
      "cx:majorTickMarks",
      axis.majorTickMark,
      afterMajorTicks,
      "cx:axis"
    );
  }
  if (rawPatchFlag(patchPlan, "minorTickMark")) {
    // Plural form — see `majorTickMark` note above.
    patched = removeXmlBlock(patched, "cx:minorTickMark");
    patched = patchValueLeaf(
      patched,
      "cx:minorTickMarks",
      axis.minorTickMark,
      afterMinorTicks,
      "cx:axis"
    );
  }
  if (rawPatchFlag(patchPlan, "numFmt")) {
    patched = patchGenericChild(
      patched,
      "cx:numFmt",
      buildRawChartExNumFmtXml(axis.numFmt),
      afterNumFmt,
      "cx:axis"
    );
  }
  if (rawPatchFlag(patchPlan, "txPr")) {
    patched = patchGenericChild(
      patched,
      "cx:txPr",
      buildRawTextPropertiesXml(axis.txPr, "cx"),
      afterTxPr,
      "cx:axis"
    );
  }
  if (rawPatchFlag(patchPlan, "spPr")) {
    patched = patchGenericChild(
      patched,
      "cx:spPr",
      buildRawShapePropertiesXml(axis.spPr, "cx"),
      afterSpPr,
      "cx:axis"
    );
  }
  return patched;
}

function buildRawChartExNumFmtXml(numFmt: any): string {
  if (!numFmt?.formatCode) {
    return "";
  }
  const attrs = [`formatCode="${escapeAttr(numFmt.formatCode)}"`];
  if (numFmt.sourceLinked !== undefined) {
    attrs.push(`sourceLinked="${numFmt.sourceLinked ? "1" : "0"}"`);
  }
  return `<cx:numFmt ${attrs.join(" ")}/>`;
}

function buildRawChartExScalingXml(tag: "valScaling" | "catScaling", scaling: any): string {
  if (!scaling) {
    return "";
  }
  const attrs = Object.entries(scaling)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}="${escapeAttr(String(value))}"`);
  return `<cx:${tag}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}/>`;
}

function findChartExAxisBlock(
  raw: string,
  axisId: number
): { start: number; end: number; xml: string } | undefined {
  let cursor = 0;
  while (cursor < raw.length) {
    const range = findXmlBlock(raw, "cx:axis", cursor);
    if (!range) {
      return undefined;
    }
    const xml = raw.slice(range.start, range.end);
    if (new RegExp(`<cx:axis\\s+[^>]*id=["']${axisId}["']`).test(xml)) {
      return { ...range, xml };
    }
    cursor = range.end;
  }
  return undefined;
}

function replaceOrInsertBefore(
  block: string,
  tag: string,
  replacement: string,
  beforeTags: string[]
): string {
  const range = findXmlBlock(block, tag);
  if (range) {
    return block.slice(0, range.start) + replacement + block.slice(range.end);
  }
  const insertAt = beforeTags
    .map(t => block.indexOf(`<${t}`))
    .filter(i => i >= 0)
    .sort((a, b) => a - b)[0];
  if (insertAt !== undefined) {
    return block.slice(0, insertAt) + replacement + block.slice(insertAt);
  }
  const close =
    block.lastIndexOf("</c:ser>") >= 0
      ? block.lastIndexOf("</c:ser>")
      : block.lastIndexOf("</c:catAx>");
  return close >= 0 ? block.slice(0, close) + replacement + block.slice(close) : block;
}

function replaceOrInsertBeforeGeneric(
  block: string,
  tag: string,
  replacement: string,
  beforeTags: string[],
  parentTag: string
): string {
  const range = findXmlBlock(block, tag);
  if (range) {
    return block.slice(0, range.start) + replacement + block.slice(range.end);
  }
  const insertAt = beforeTags
    .map(t => block.indexOf(`<${t}`))
    .filter(i => i >= 0)
    .sort((a, b) => a - b)[0];
  if (insertAt !== undefined) {
    return block.slice(0, insertAt) + replacement + block.slice(insertAt);
  }
  const close = block.lastIndexOf(`</${parentTag}>`);
  return close >= 0 ? block.slice(0, close) + replacement + block.slice(close) : block;
}

function patchGenericChild(
  block: string,
  tag: string,
  replacement: string | undefined,
  beforeTags: string[],
  parentTag: string
): string {
  if (replacement === undefined || replacement === "") {
    return removeXmlBlock(block, tag);
  }
  return replaceOrInsertBeforeGeneric(block, tag, replacement, beforeTags, parentTag);
}

function patchOpeningTagBooleanAttribute(
  block: string,
  tag: string,
  attr: string,
  value: boolean | undefined
): string {
  const openEnd = block.indexOf(">");
  if (openEnd < 0 || !block.startsWith(`<${tag}`)) {
    return block;
  }
  const head = block
    .slice(0, openEnd + 1)
    .replace(new RegExp(`\\s${attr}=("[^"]*"|'[^']*')`, "g"), "");
  if (value === undefined) {
    return head + block.slice(openEnd + 1);
  }
  // Emit an explicit `val="0"` / `val="1"` for both boolean states so
  // the raw patch path matches the structured renderer (which emits
  // `hidden="0"` on `<cx:series>` when the author set `hidden:
  // false`). Previously the `false` case dropped the attribute
  // entirely — technically equivalent to the schema default, but
  // asymmetric with the structured writer: files round-tripping
  // through raw-patch lost an explicitly-false marker that the
  // structural path preserved.
  const selfClosing = head.endsWith("/>");
  const insertion = ` ${attr}="${value ? "1" : "0"}"`;
  const rewritten = selfClosing
    ? head.replace(/\/>$/, `${insertion}/>`)
    : head.replace(/>$/, `${insertion}>`);
  return rewritten + block.slice(openEnd + 1);
}

/**
 * Replace (or remove) a numeric attribute on the opening tag of `block`.
 * Used to patch ChartEx series attributes such as `ownerIdx` that live on
 * `<cx:series …>` rather than as structured children. Matches the element
 * only when the block begins with `<{tag}` so nested tags with the same
 * attribute name are left alone. Preserves the `/` on self-closing tags.
 */
function patchOpeningTagIntegerAttribute(
  block: string,
  tag: string,
  attr: string,
  value: number | undefined
): string {
  const openEnd = block.indexOf(">");
  if (openEnd < 0 || !block.startsWith(`<${tag}`)) {
    return block;
  }
  const head = block.slice(0, openEnd + 1);
  const selfClosing = head.endsWith("/>");
  const strippedHead = head.replace(new RegExp(`\\s${attr}=("[^"]*"|'[^']*')`, "g"), "");
  if (value === undefined || !Number.isFinite(value)) {
    return strippedHead + block.slice(openEnd + 1);
  }
  const insertion = ` ${attr}="${value}"`;
  const rewritten = selfClosing
    ? strippedHead.replace(/\/>$/, `${insertion}/>`)
    : strippedHead.replace(/>$/, `${insertion}>`);
  return rewritten + block.slice(openEnd + 1);
}

function patchRepeatingChildren(
  block: string,
  tag: string,
  replacement: string,
  beforeTags: string[],
  parentTag: string
): string {
  const stripped = removeXmlBlocks(block, tag);
  if (!replacement) {
    return stripped;
  }
  return replaceOrInsertBeforeGeneric(stripped, tag, replacement, beforeTags, parentTag);
}

function removeXmlBlock(block: string, tag: string): string {
  const range = findXmlBlock(block, tag);
  return range ? block.slice(0, range.start) + block.slice(range.end) : block;
}

/**
 * Patch a single attribute on the opening tag of `elementTag` inside
 * the supplied `block`. Intended for raw-XML patching where the
 * attribute, not a child element, carries the field — e.g.
 * `CT_Axis/@hidden` in the Chart2014 schema.
 *
 *   - `value === undefined` removes the attribute (if present).
 *   - `value === true | false` lands `attr="1"` / `attr="0"` — the
 *     OOXML `xsd:boolean` lexical form.
 *   - `value: string` lands literally (escaped).
 *
 * The function only mutates the **first** matching opening tag; it
 * does not recurse into nested elements of the same name (axes in a
 * combo-chart plotArea are iterated by the caller, each block already
 * narrowed to a single `<cx:axis …>` opening). Returns the block
 * unchanged when `elementTag` can't be found — callers rely on the
 * identity comparison `patched !== block` to detect successful writes.
 */
function patchXmlAttribute(
  block: string,
  elementTag: string,
  attrName: string,
  value: boolean | string | undefined
): string {
  // Match the opening tag, allowing leading whitespace in attributes
  // and both self-closing and regular element forms. Escape the full
  // element name for regex safety (covers all special regex characters).
  const escapedTag = elementTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagRe = new RegExp(`<${escapedTag}\\b([^>]*)(/?)>`);
  const match = tagRe.exec(block);
  if (!match) {
    return block;
  }
  const [fullMatch, attrSegment, selfClose] = match;
  const attrRe = new RegExp(`\\s${attrName}="[^"]*"`);
  const stripped = attrSegment.replace(attrRe, "");
  const serialised =
    value === undefined
      ? ""
      : typeof value === "boolean"
        ? ` ${attrName}="${value ? "1" : "0"}"`
        : ` ${attrName}="${escapeAttr(value)}"`;
  const rebuilt = `<${elementTag}${stripped}${serialised}${selfClose}>`;
  if (rebuilt === fullMatch) {
    return block;
  }
  return block.slice(0, match.index) + rebuilt + block.slice(match.index + fullMatch.length);
}

function removeXmlBlocks(block: string, tag: string): string {
  let patched = block;
  let range = findXmlBlock(patched, tag);
  while (range) {
    patched = patched.slice(0, range.start) + patched.slice(range.end);
    range = findXmlBlock(patched, tag, range.start);
  }
  return patched;
}

function replaceXmlBlocks(
  raw: string,
  tag: string,
  replace: (block: string) => string | undefined
): string | undefined {
  let cursor = 0;
  let output = "";
  while (cursor < raw.length) {
    const range = findXmlBlock(raw, tag, cursor);
    if (!range) {
      output += raw.slice(cursor);
      return output;
    }
    output += raw.slice(cursor, range.start);
    const replacement = replace(raw.slice(range.start, range.end));
    if (replacement === undefined) {
      return undefined;
    }
    output += replacement;
    cursor = range.end;
  }
  return output;
}

function findAxisBlock(
  raw: string,
  tag: string,
  axId: number
): { start: number; end: number; xml: string } | undefined {
  let cursor = 0;
  while (cursor < raw.length) {
    const range = findXmlBlock(raw, tag, cursor);
    if (!range) {
      return undefined;
    }
    const xml = raw.slice(range.start, range.end);
    if (new RegExp(`<c:axId\\s+val=["']${axId}["']\\s*/>`).test(xml)) {
      return { ...range, xml };
    }
    cursor = range.end;
  }
  return undefined;
}

/**
 * Locate the `<tag …>…</tag>` (or self-closing `<tag …/>`) block in
 * `raw` starting at or after `offset`. Returns `{ start, end }` on hit,
 * `undefined` on miss.
 *
 * Two correctness concerns this implementation guards against:
 *   1. **Prefix collision** — `indexOf("<tag")` matches `<tag2>` or
 *      `<tagX>` as well as the literal `<tag>` / `<tag `/`<tag/`. We
 *      require the character immediately after the tag name to be one
 *      of `>`, `/`, or whitespace so `<c:chart>` can't match
 *      `<c:chartSpace>` and `<c:ax>` can't match `<c:axId>`.
 *   2. **Nested same-name elements** — `<c:extLst><c:ext>…<c:extLst>
 *      …</c:extLst></c:ext></c:extLst>` used to match the inner
 *      close. Walk open/close tokens with a depth counter to find the
 *      matching end.
 *
 * Limitations: the scanner treats XML tokens lexically and will fail
 * on same-name occurrences inside CDATA or XML comments. ChartEx XML
 * does not use either, so this remains a safe shortcut.
 */
function findXmlBlock(
  raw: string,
  tag: string,
  offset = 0
): { start: number; end: number } | undefined {
  const openToken = `<${tag}`;
  const closeToken = `</${tag}>`;

  let pos = offset;
  let start = -1;
  // First, find the first legitimate open tag — one whose next char is
  // `>`, `/`, or whitespace. Prefix collisions (`<tag2>`) are silently
  // skipped.
  while (pos < raw.length) {
    const candidate = raw.indexOf(openToken, pos);
    if (candidate < 0) {
      return undefined;
    }
    const nextChar = raw[candidate + openToken.length];
    if (nextChar === ">" || nextChar === "/" || /\s/.test(nextChar ?? "")) {
      start = candidate;
      break;
    }
    pos = candidate + openToken.length;
  }
  if (start < 0) {
    return undefined;
  }

  // Find the end of the open tag. `>` inside a quoted attribute would
  // confuse this, but Chart XML attributes never contain `>`.
  const openEnd = raw.indexOf(">", start);
  if (openEnd < 0) {
    return undefined;
  }
  if (raw[openEnd - 1] === "/") {
    return { start, end: openEnd + 1 };
  }

  // Walk forward balancing opens and closes for this same tag name.
  // A nested `<tag>` inside the element bumps the depth; `</tag>`
  // decrements. When depth hits zero we've found the matching close.
  let depth = 1;
  let scan = openEnd + 1;
  while (scan < raw.length && depth > 0) {
    const nextOpen = (() => {
      let p = scan;
      while (p < raw.length) {
        const c = raw.indexOf(openToken, p);
        if (c < 0) {
          return -1;
        }
        const next = raw[c + openToken.length];
        if (next === ">" || next === "/" || /\s/.test(next ?? "")) {
          return c;
        }
        p = c + openToken.length;
      }
      return -1;
    })();
    const nextClose = raw.indexOf(closeToken, scan);
    if (nextClose < 0) {
      return undefined;
    }
    if (nextOpen >= 0 && nextOpen < nextClose) {
      // Another open of the same tag — but only count it if it's a
      // real element (not self-closing, which shouldn't change depth).
      const oeNext = raw.indexOf(">", nextOpen);
      if (oeNext < 0) {
        return undefined;
      }
      if (raw[oeNext - 1] !== "/") {
        depth++;
      }
      scan = oeNext + 1;
    } else {
      depth--;
      if (depth === 0) {
        return { start, end: nextClose + closeToken.length };
      }
      scan = nextClose + closeToken.length;
    }
  }
  return undefined;
}

function escapeXml(value: string): string {
  // Route through the canonical XML encoder so every raw-patch / XML
  // builder call site benefits from the same strict sanitisation:
  //
  //   - strips XML 1.0-forbidden control characters (`#x0`-`#x1F`
  //     except `\t \n \r`, `#x7F` DEL, `#xFFFE`, `#xFFFF`);
  //   - strips lone surrogate halves (previously `U+D800`-`U+DFFF`
  //     outside a valid pair could leak into attribute / text
  //     content and corrupt the output encoding);
  //   - escapes all five XML structural entities (`< > & " '`).
  //
  // The previous local implementation only handled `& < >` plus a
  // partial control-char strip. That was enough for the reserved-
  // trio case but left `"` untouched in attribute values (callers
  // compensated with a manual `.replace(/"/g, "&quot;")`), and
  // lone surrogates survived — producing bytes no XML parser can
  // reopen.
  //
  // Element-text call sites used to emit `"` / `'` verbatim; the
  // new encoder produces `&quot;` / `&apos;`. Both are valid XML
  // and round-trip identically through any parser, but byte-level
  // diffs against the old output will show the extra entities.
  return xmlEncode(value);
}

function escapeAttr(value: string): string {
  // Attribute values need the extra step of escaping `\t \n \r` as
  // numeric character references; without it, XML 1.0 §3.3.3
  // attribute-value normalisation replaces them with a single
  // literal space at parse time, silently losing any embedded
  // newline / tab in (e.g.) a chart title.
  return xmlEncodeAttr(value);
}

/**
 * XLSX class - handles Excel file operations
 * Works in both Node.js and Browser environments
 *
 * Generic over the concrete `Workbook` type so a Node subclass that extends
 * `XLSX<NodeWorkbook>` automatically narrows `load()` / `read()` /
 * `loadFromFiles()` / etc. to return the Node `Workbook` (which exposes
 * `xlsx.readFile` / `xlsx.writeFile`). Without this, those methods are
 * inherited unchanged and surface the browser `Workbook` type to Node
 * consumers.
 *
 * The default type parameter keeps the public XLSX surface unchanged for
 * external callers (`new XLSX(workbook)` is still typed as `XLSX<Workbook>`).
 */
class XLSX<TWorkbook extends Workbook = Workbook> {
  declare public workbook: TWorkbook;

  static RelType = RelType;

  constructor(workbook: TWorkbook) {
    this.workbook = workbook;
  }

  // ===========================================================================
  // Stream creation - cross-platform implementation using modules/stream
  // ===========================================================================

  /**
   * Create a stream from binary data (for media/themes)
   */
  protected createBinaryStream(data: Uint8Array): IParseStream {
    const stream = new PassThrough();
    stream.end(data);
    return stream;
  }

  /**
   * Create a stream from string content (for XML parsing)
   */
  protected createTextStream(content: string): IParseStream {
    const stream = new PassThrough();
    stream.end(content);
    return stream;
  }

  // ===========================================================================
  // Shared implementations - used by all platforms
  // ===========================================================================

  /**
   * Create a StreamBuf instance for buffering data
   */
  protected createStreamBuf(): IStreamBuf {
    return new StreamBuf();
  }

  /**
   * Convert buffer/Uint8Array to string
   */
  protected bufferToString(data: string | ArrayBuffer | Uint8Array): string {
    return bufferToString(data);
  }

  /**
   * Create a ZIP writer adapter.
   * Can be overridden by subclasses for platform-specific implementations.
   */
  protected createZipWriter(options?: XlsxWriteOptions["zip"]): IZipWriter {
    return new StreamingZipWriterAdapter(options);
  }

  /**
   * Write all workbook content to a ZIP writer
   * Shared by both Node.js write() and browser writeBuffer()
   */
  protected async writeToZip(zip: IZipWriter, options?: XlsxWriteOptions): Promise<void> {
    const model = getWorkbookModel(this.workbook);
    this.prepareModel(model, options);
    this.prepareChartsheets(model);
    this.prepareChartExSidecars(model);

    await this.addContentTypes(zip, model);
    await this.addOfficeRels(zip, model);
    await this.addWorkbookRels(zip, model);
    // Write workbook.xml before worksheets so that streaming readers can
    // resolve worksheet names/ids/state from workbook metadata before
    // processing worksheet entries.
    await this.addWorkbook(zip, model);
    await this.addWorksheets(zip, model);
    await this.addSharedStrings(zip, model);
    await this.addDrawings(zip, model);
    await this.addChartsheets(zip, model);
    const strictTemplateMode = isStrictTemplateMode(options);
    await this.addCharts(zip, model, strictTemplateMode);
    await this.addChartExEntries(zip, model, strictTemplateMode);
    await this.addTables(zip, model);
    await this.addPivotTables(zip, model);
    await this.addExternalLinks(zip, model);
    await this.addThemes(zip, model);
    await this.addStyles(zip, model);
    await this.addFeaturePropertyBag(zip, model);
    await this.addMetadata(zip, model);
    await this.addMedia(zip, model);
    await this.addApp(zip, model);
    await this.addCore(zip, model);
    await this.addPersons(zip, model);
    await this.addSlicerAndTimelineParts(zip, model);
    await this.addOpaqueParts(zip, model);
  }

  /**
   * Emit the raw slicer/timeline parts captured on load. Pure
   * byte-copy — documonster does not modify these parts. The partner
   * Content-Types and rels are covered separately (content types in
   * `addContentTypes`, sheet/workbook rels by the corresponding
   * xforms consuming the existing `xl/_rels/*.rels` captured on
   * load).
   */
  async addSlicerAndTimelineParts(zip: IZipWriter, model: any): Promise<void> {
    for (const source of [
      model.slicerParts,
      model.slicerCacheParts,
      model.timelineParts,
      model.timelineCacheParts
    ] as Array<Record<string, Uint8Array> | undefined>) {
      if (!source) {
        continue;
      }
      for (const [path, bytes] of Object.entries(source)) {
        await this._appendToZip(zip, bytes, { name: path });
      }
    }
  }

  /**
   * Write the workbook-level `xl/persons/person.xml` part when the
   * model carries Office 365 threaded-comment authors. No-op when the
   * persons list is empty so legacy files without threaded comments
   * stay byte-identical.
   */
  async addPersons(zip: IZipWriter, model: any): Promise<void> {
    const persons = model.persons as ThreadedCommentPerson[] | undefined;
    if (!persons || persons.length === 0) {
      return;
    }
    await this._appendToZip(zip, renderPersonList(persons), { name: "xl/persons/person.xml" });
  }

  // ===========================================================================
  // Stream/Buffer operations - shared by all platforms
  // ===========================================================================

  /**
   * Read workbook from a stream
   */
  async read(stream: IParseStream, options?: XlsxReadOptions): Promise<TWorkbook> {
    // Collect all stream data into a single buffer
    const chunks: Uint8Array[] = [];

    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Uint8Array) => {
        chunks.push(chunk);
      };

      const onEnd = () => {
        stream.off("data", onData);
        stream.off("end", onEnd);
        stream.off("error", onError);
        resolve();
      };

      const onError = (err: Error) => {
        stream.off("data", onData);
        stream.off("end", onEnd);
        stream.off("error", onError);
        reject(err);
      };

      stream.on("data", onData);
      stream.on("end", onEnd);
      stream.on("error", onError);
    });

    return this.loadBuffer(concatUint8Arrays(chunks), options);
  }

  /**
   * Write workbook to a stream.
   *
   * The returned promise resolves only after the sink has accepted the whole
   * package. This writer **respects downstream backpressure**: when
   * `stream.write()` returns `false` it waits for the sink's `'drain'` event at
   * the next zip-entry boundary before producing more bytes. A sink that errors,
   * or that closes before the package is complete, rejects the promise instead
   * of parking on a `'drain'` that can never arrive.
   *
   * ⚠️ The sink must already be consumed (or be a real terminal sink such as
   * `fs.createWriteStream`, an HTTP response, or an upload body) *before* this
   * call — an unconsumed intermediate stream deadlocks once its buffers fill.
   * `Workbook.writeStream` documents that contract with worked examples, and
   * `Workbook.toStream` removes it altogether by inverting the flow.
   */
  async write(stream: XlsxWritable, options?: XlsxWriteOptions): Promise<this> {
    options = options || {};

    options.zip = options.zip || {};
    options.zip.modTime ??= this.workbook.modified ?? this.workbook.created;

    const zip = this.createZipWriter(options.zip);
    zip.pipe(stream);
    await this.writeToZip(zip, options);
    return this._finalize(zip);
  }

  /**
   * Load a workbook from binary data.
   *
   * Accepted inputs:
   *  - `Uint8Array` (and `Buffer`, which is a Uint8Array at runtime)
   *  - `ArrayBuffer` / `SharedArrayBuffer`
   *  - Any `ArrayBufferView` (DataView, Int8Array, Float32Array, …) — the
   *    underlying bytes are reinterpreted as a zip archive
   *  - `string` — treated as base64-encoded data when `options.base64 === true`;
   *    raw binary cannot be round-tripped through a JS string and is rejected
   *    to prevent silent corruption.
   */
  async load(
    data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
    options?: XlsxReadOptions
  ): Promise<TWorkbook> {
    if (data === null || data === undefined) {
      throw new ExcelFileError(
        "<input>",
        "read",
        "Can't read the data of 'the loaded zip file'. Is it in a supported JavaScript type (String, Blob, ArrayBuffer, etc) ?"
      );
    }

    let buffer: Uint8Array;

    if (typeof data === "string") {
      // Strings must be base64-encoded — binary zip bytes cannot be round-tripped
      // through a JS string without corruption. Require the explicit opt-in.
      if (!options?.base64) {
        throw new ExcelFileError(
          "<input>",
          "read",
          "Can't read the data of 'the loaded zip file'. Is it in a supported JavaScript type (String, Blob, ArrayBuffer, etc) ? " +
            "String input requires options.base64 === true (base64-encoded zip archive)."
        );
      }
      buffer = base64ToUint8Array(data);
    } else if (data instanceof Uint8Array) {
      // Covers Buffer (Node) and any typed-array view whose element size is 1.
      buffer = data;
    } else if (data instanceof ArrayBuffer) {
      buffer = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      // DataView, Int8Array, Float32Array, … — view onto an underlying buffer.
      buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      throw new ExcelFileError(
        "<input>",
        "read",
        "Can't read the data of 'the loaded zip file'. Is it in a supported JavaScript type (String, Blob, ArrayBuffer, etc) ?"
      );
    }

    return this.loadBuffer(buffer, options);
  }

  /**
   * Internal: Load from Uint8Array buffer
   */
  protected async loadBuffer(buffer: Uint8Array, options?: XlsxReadOptions): Promise<TWorkbook> {
    const parser = new ZipParser(buffer);
    const filesMap = await parser.extractAll();

    // Convert Map to Record for loadFromFiles
    const allFiles: Record<string, Uint8Array> = {};
    for (const [path, content] of filesMap) {
      allFiles[path] = content;
    }

    return this.loadFromFiles(allFiles, options);
  }

  /**
   * Internal: Load workbook from an async stream of ZIP entries.
   *
   * This is the foundation for TRUE streaming reads on platforms that have a
   * streaming ZIP parser (e.g. Node.js `modules/archive` Parse).
   */
  /**
   * Create an empty model for parsing XLSX files.
   * Shared by loadFromZipEntries and loadFromFiles.
   */
  private createEmptyModel(): any {
    return {
      worksheets: [],
      worksheetHash: {},
      worksheetRels: [],
      themes: {},
      media: [],
      mediaIndex: {},
      drawings: {},
      drawingRels: {},
      comments: {},
      tables: {},
      vmlDrawings: {},
      vmlDrawingHF: {},
      vmlDrawingHFRels: {},
      pivotTables: {},
      pivotTableRels: {},
      pivotCacheDefinitions: {},
      pivotCacheRecords: {},
      // Parsed chart entries keyed by chart number
      chartEntries: {} as Record<number, any>,
      // Parsed chart rels keyed by chart number
      chartRels: {} as Record<number, any>,
      // Raw chart style bytes keyed by style number
      chartStyles: {} as Record<number, Uint8Array>,
      // Raw chart colors bytes keyed by colors number
      chartColors: {} as Record<number, Uint8Array>,
      chartExStyles: {} as Record<number, Uint8Array>,
      chartExColors: {} as Record<number, Uint8Array>,
      // Raw chartEx entries (Office 2016+ extended charts) keyed by chartEx number
      chartExEntries: {} as Record<number, Uint8Array>,
      // Parsed chartEx rels keyed by chartEx number
      chartExRels: {} as Record<number, any[]>,
      // Structured chartEx entries (built via addChartEx) keyed by chartEx number
      chartExStructuredEntries: {} as Record<number, ChartExEntry>,
      // External workbook links — parsed from xl/externalLinks/externalLinkN.xml
      // during _processDefaultEntry, then reconciled into a dense
      // ExternalLinkModel[] by reconcile() using workbookRels + <externalReferences>.
      externalLinksByIndex: {} as Record<number, ParsedExternalLink>,
      // Raw rels from each externalLinkN.rels file, keyed by index.
      // Contains the actual Target path (e.g. "测试.xlsx", "file:///...")
      // and TargetMode ("External" / "Internal").
      externalLinkRelsByIndex: {} as Record<number, ExternalLinkRelsEntry[]>,
      // Chartsheets keyed by sheet number
      chartsheets: {} as Record<number, any>,
      chartsheetRels: {} as Record<number, any[]>,
      // Staging for opaque (unmodelled) parts. A ZIP imposes no entry order, so
      // bytes, content types and relationships are gathered independently while
      // walking the package and joined in reconcile() once all three are known.
      opaqueUnknownEntries: new Map<string, Uint8Array>(),
      opaqueContentTypeOverrides: new Map<string, string>(),
      opaqueContentTypeDefaults: {} as Record<string, string>,
      opaqueRelationshipsBySource: new Map<string, OpaqueRelationship[]>(),
      opaqueParts: [] as OpaquePart[],
      opaqueDrops: [] as OpaqueDrop[]
    };
  }

  /**
   * Collect all data from a stream into a single Uint8Array.
   * Reusable helper for passthrough and drawing processing.
   */
  protected async collectStreamData(stream: IParseStream): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: string | Uint8Array | ArrayBuffer) => {
        if (typeof chunk === "string") {
          chunks.push(new TextEncoder().encode(chunk));
        } else if (chunk instanceof Uint8Array) {
          chunks.push(chunk);
        } else {
          chunks.push(new Uint8Array(chunk));
        }
      });
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    return concatUint8Arrays(chunks);
  }

  /**
   * Process a known OOXML entry (workbook, styles, shared strings, etc.)
   * Returns true if handled, false if should be passed to _processDefaultEntry
   */
  protected async _processKnownEntry(
    stream: IParseStream,
    model: any,
    entryName: string,
    options?: XlsxOptions
  ): Promise<boolean> {
    const sheetNo = getWorksheetNoFromWorksheetPath(entryName);
    if (sheetNo !== undefined) {
      await this._processWorksheetEntry(stream, model, sheetNo, options, entryName);
      return true;
    }

    const chartsheetNo = getChartsheetNoFromPath(entryName);
    if (chartsheetNo !== undefined) {
      await this._processChartsheetEntry(stream, model, chartsheetNo);
      return true;
    }

    switch (entryName) {
      case OOXML_PATHS.rootRels:
        model.globalRels = await this.parseRels(stream, model, "");
        return true;
      case OOXML_PATHS.xlWorkbook: {
        const workbook = await this.parseWorkbook(stream);
        model.sheets = workbook.sheets;
        model.definedNames = workbook.definedNames;
        model.views = workbook.views;
        model.properties = workbook.properties;
        model.protection = workbook.protection;
        model.calcProperties = workbook.calcProperties;
        model.pivotCaches = workbook.pivotCaches;
        // Pass-through the ordered list of <externalReference> rIds. These
        // get resolved into a dense externalLinks[] during reconcile().
        model.externalReferences = workbook.externalReferences;
        return true;
      }
      case OOXML_PATHS.xlSharedStrings:
        model.sharedStrings = new SharedStringsXform();
        await model.sharedStrings.parseStream(stream);
        return true;
      case OOXML_PATHS.xlWorkbookRels:
        model.workbookRels = await this.parseRels(stream, model, OOXML_PATHS.xlWorkbook);
        return true;
      case OOXML_PATHS.contentTypes: {
        // Capture the Override ContentType for /xl/workbook.xml. Templates
        // (.xltx/.xltm) and macro-enabled workbooks (.xlsm) declare a
        // different value than a plain .xlsx; losing it makes Excel refuse
        // the file because the declared content-type no longer matches the
        // (preserved) extension. Parsed structurally via ContentTypesXform
        // rather than by hand so attribute order/quoting variance is a
        // non-issue.
        const parsed = await new ContentTypesXform().parseStream(stream);
        if (parsed?.workbookContentType) {
          model.workbookContentType = parsed.workbookContentType;
        }
        for (const [partPath, contentType] of Object.entries(parsed?.overrides ?? {})) {
          model.opaqueContentTypeOverrides.set(partPath, contentType);
        }
        for (const [extension, contentType] of Object.entries(parsed?.defaults ?? {})) {
          model.opaqueContentTypeDefaults[extension] = contentType;
        }
        return true;
      }
      case OOXML_PATHS.docPropsApp: {
        const appXform = new AppXform();
        const appProperties = await appXform.parseStream(stream);
        if (appProperties) {
          model.company = appProperties.company;
          model.manager = appProperties.manager;
        }
        return true;
      }
      case OOXML_PATHS.docPropsCore: {
        const coreXform = new CoreXform();
        const coreProperties = await coreXform.parseStream(stream);
        Object.assign(model, coreProperties);
        return true;
      }
      case OOXML_PATHS.xlStyles:
        model.styles = new StylesXform();
        await model.styles.parseStream(stream);
        return true;
      case OOXML_PATHS.xlMetadata: {
        const metadataXform = new MetadataXform();
        const metadataResult = await metadataXform.parseStream(stream);
        if (metadataResult) {
          model.metadata = metadataResult;
        }
        return true;
      }
      case "xl/persons/person.xml": {
        // Office 365 threaded-comment person directory. Parsed here so
        // reconcile can attach the list to the workbook. Silently
        // ignored when malformed — threaded comments degrade to
        // "unknown author" rather than breaking the whole load.
        const data = await this.collectStreamData(stream);
        const raw = new TextDecoder().decode(data);
        model.persons = parsePersonList(raw);
        return true;
      }
      default: {
        // Catch threaded-comment per-sheet parts (the path contains a
        // variable sheet index so they can't be matched in the switch).
        const threadedMatch = /^xl\/threadedComments\/threadedComment(\d+)\.xml$/.exec(entryName);
        if (threadedMatch) {
          const sheetIndex = parseInt(threadedMatch[1], 10);
          const data = await this.collectStreamData(stream);
          const raw = new TextDecoder().decode(data);
          model.threadedCommentsByIndex ??= {} as Record<
            number,
            Array<{ ref: string; comment: unknown }>
          >;
          model.threadedCommentsByIndex[sheetIndex] = parseThreadedComments(raw);
          return true;
        }
        // Raw-passthrough capture for slicers and timelines — two
        // coordinated Office dashboard features documonster does not
        // structurally model but must not destroy on round-trip.
        // Each family has two part types (the control itself + its
        // cache); both are captured into maps on the workbook model
        // so the writer can emit them verbatim later.
        if (/^xl\/slicers\/slicer\d+\.xml$/.test(entryName)) {
          model.slicerParts ??= {} as Record<string, Uint8Array>;
          model.slicerParts[entryName] = await this.collectStreamData(stream);
          return true;
        }
        if (/^xl\/slicerCaches\/slicerCache\d+\.xml$/.test(entryName)) {
          model.slicerCacheParts ??= {} as Record<string, Uint8Array>;
          model.slicerCacheParts[entryName] = await this.collectStreamData(stream);
          return true;
        }
        if (/^xl\/timelines\/timeline\d+\.xml$/.test(entryName)) {
          model.timelineParts ??= {} as Record<string, Uint8Array>;
          model.timelineParts[entryName] = await this.collectStreamData(stream);
          return true;
        }
        if (/^xl\/timelineCaches\/timelineCache\d+\.xml$/.test(entryName)) {
          model.timelineCacheParts ??= {} as Record<string, Uint8Array>;
          model.timelineCacheParts[entryName] = await this.collectStreamData(stream);
          return true;
        }
        return false;
      }
    }
  }

  /**
   * Refuse a binary workbook that reached the XML reader.
   *
   * A `.xlsb` read as XLSX produces an *empty* workbook rather than an error: none of the parts this
   * reader knows are present, so nothing loads and nothing complains. `read()` guards against it by
   * sniffing the bytes before choosing a loader, but that guard is bypassed whenever the format was not
   * inferred from them — `readFile` on a misnamed `.xlsx`, or any caller passing `format: "xlsx"`
   * explicitly. Both loaders below therefore ask this, because they are the two places that have seen
   * the part names.
   */
  protected assertNotBinaryWorkbook(sawBinaryWorkbook: boolean, sawXmlWorkbook: boolean): void {
    if (!sawBinaryWorkbook || sawXmlWorkbook) {
      return;
    }
    throw new ExcelFileError(
      "<input>",
      "read",
      `the package contains xl/workbook.bin and no ${OOXML_PATHS.xlWorkbook}, so it is XLSB and not ` +
        `XLSX. Reading it here would return an empty workbook rather than fail. Omit the format to ` +
        `detect it, or pass format: "xlsb".`
    );
  }

  protected async loadFromZipEntries(
    entries: AsyncIterable<ZipEntryLike>,
    options?: XlsxOptions
  ): Promise<TWorkbook> {
    const model: any = this.createEmptyModel();
    let sawBinaryWorkbook = false;
    let sawXmlWorkbook = false;

    for await (const entry of entries) {
      let drained = false;
      const drainEntry = async () => {
        if (drained) {
          return;
        }
        drained = true;
        await entry.drain();
      };

      if (entry.type === "Directory") {
        await drainEntry();
        continue;
      }

      const entryName = normalizeZipPath(entry.name);
      sawBinaryWorkbook ||= entryName === "xl/workbook.bin";
      sawXmlWorkbook ||= entryName === OOXML_PATHS.xlWorkbook;
      const stream = entry.stream;

      try {
        const handled = await this._processKnownEntry(stream, model, entryName, options);
        if (!handled) {
          const defaultHandled = await this._processDefaultEntry(stream, model, entryName);
          if (!defaultHandled) {
            // Important for true streaming parsers: always consume unknown entries
            await drainEntry();
          }
        }
      } finally {
        // Make sure we don't leave the entry stream partially consumed.
        // This is critical for true streaming parsers which may otherwise abort
        // the underlying entry stream (showing up as AbortError/ABORT_ERR).
        try {
          await drainEntry();
        } catch {
          // ignore drain errors; the primary parse error (if any) is more useful
        }
      }
    }

    this.assertNotBinaryWorkbook(sawBinaryWorkbook, sawXmlWorkbook);
    await this.reconcile(model, options);
    setWorkbookModel(this.workbook, model);
    return this.workbook;
  }

  /**
   * Write workbook to buffer
   */
  async writeBuffer(options?: XlsxWriteOptions): Promise<Uint8Array> {
    options = options || {};

    options.zip = options.zip || {};
    options.zip.modTime ??= this.workbook.modified ?? this.workbook.created;

    const zip = this.createZipWriter(options.zip);
    const stream = this.createStreamBuf();
    zip.pipe(stream);
    await this.writeToZip(zip, options);
    await this._finalize(zip);
    const bytes = stream.read() || new Uint8Array(0);

    // Optional OOXML self-check. Enabled by default in non-production
    // Node.js environments; disabled in the browser and in production.
    // See `XlsxWriteOptions.validate` for the resolution rules.
    if (shouldAutoValidate(options.validate)) {
      await runWriteBufferSelfCheck(bytes);
    }

    return bytes;
  }

  // ===========================================================================
  // Media handling - base implementation (buffer/base64 only)
  // ===========================================================================

  /**
   * Add media files to ZIP
   * Supports buffer, base64, and filename (if readFileAsync is provided)
   */
  async addMedia(zip: IZipWriter, model: MediaModel): Promise<void> {
    // Keep filename reads concurrent as before, but append the resolved data in
    // model order. ZIP output itself is strictly sequential, and only a
    // sequential append makes each completion promise mean that entry's bytes
    // have reached the sink before backpressure is inspected.
    const resolved = await Promise.all(
      (model.media as WorkbookMediaLike[]).map(async medium => {
        if (medium.type !== "image") {
          throw new ImageError("Unsupported media");
        }

        // External (linked) images carry only a `link` target — no bytes are
        // written into the package; the relationship (TargetMode="External")
        // references the image in place.
        if (isExternalImage(medium)) {
          return null;
        }

        // Preserve legacy behavior: `${undefined}` becomes "undefined" in template strings
        const mediaName = medium.name ?? "undefined";
        const name = mediaPath(`${mediaName}.${medium.extension}`);

        if (medium.filename) {
          if (this.readFileAsync) {
            return { data: await this.readFileAsync(medium.filename), options: { name } };
          }
          throw new ExcelNotSupportedError(
            "Loading images from filename",
            "not supported in this environment"
          );
        }

        if (medium.buffer) {
          return { data: medium.buffer, options: { name } };
        }

        if (medium.base64) {
          return {
            data: medium.base64.substring(medium.base64.indexOf(",") + 1),
            options: { name, base64: true }
          };
        }

        throw new ImageError("Unsupported media");
      })
    );

    for (const media of resolved) {
      if (media) {
        await this._appendToZip(zip, media.data, media.options);
      }
    }
  }

  /**
   * Optional file reader - can be overridden by subclasses (e.g., Node.js version)
   */
  protected readFileAsync?: (filename: string) => Promise<Uint8Array>;

  // ===========================================================================
  // Parse helpers - shared by all platforms
  // ===========================================================================

  /**
   * Parse a `.rels` part and register its edges for opaque reachability.
   *
   * `source` is required rather than optional on purpose. Whether a preserved
   * part is still reachable depends on every relationship in the package, not
   * just the ones this writer regenerates, so a `.rels` file parsed without being
   * registered here silently makes an unreachable part look like a part that
   * never had an inbound edge — which is the one case that must be emitted. Making
   * the parameter mandatory means a new `.rels` handler cannot omit it.
   *
   * @param source Part whose relationships these are; `""` for the package root.
   */
  async parseRels(stream: IParseStream, model: any, source: string): Promise<any> {
    const xform = new RelationshipsXform();
    const relationships = await xform.parseStream(stream);
    this._recordOpaqueRelationships(model, source, relationships);
    return relationships;
  }

  parseWorkbook(stream: IParseStream): Promise<any> {
    const xform = new WorkbookXform();
    return xform.parseStream(stream);
  }

  parseSharedStrings(stream: IParseStream): Promise<any> {
    const xform = new SharedStringsXform();
    return xform.parseStream(stream);
  }

  // ===========================================================================
  // Reconcile - shared by all platforms
  // ===========================================================================

  async reconcile(model: any, options?: XlsxOptions): Promise<void> {
    // Join the opaque staging maps first: everything else in reconcile works on
    // modelled state, and the preserved parts must be settled before the model
    // is handed to the workbook.
    const opaque = collectOpaqueParts({
      unknownEntries: model.opaqueUnknownEntries,
      contentTypeOverrides: model.opaqueContentTypeOverrides,
      relationshipsBySource: model.opaqueRelationshipsBySource
    });
    model.opaqueParts = opaque.parts;
    model.opaqueDrops = opaque.drops;
    // Distribute sheet-sourced inbound relationships onto the sheets that
    // declared them, so they move with the sheet rather than with its position.
    const inboundBySource = groupOpaqueRelationshipsBySource(opaque.parts);
    for (const worksheet of model.worksheets) {
      const rels = inboundBySource.get(worksheetPath(worksheet.sheetNo));
      if (rels) {
        worksheet.opaqueRels = rels;
      }
    }
    // The staging maps hold every unrecognised entry's bytes. They are load-time
    // scratch, and the assembled parts now own that memory, so release them
    // rather than carry a second reference to the whole set into the workbook.
    delete model.opaqueUnknownEntries;
    delete model.opaqueContentTypeOverrides;
    delete model.opaqueRelationshipsBySource;

    const workbookXform = new WorkbookXform();
    const worksheetXform = new WorkSheetXform(options);

    workbookXform.reconcile(model);

    // reconcile drawings with their rels — DrawingXform (~34 KB) is loaded
    // lazily so workbooks without drawings never pull it into the bundle.
    const drawingNames = Object.keys(model.drawings);
    if (drawingNames.length > 0) {
      const { DrawingXform } = await import("@excel/xlsx/xform/drawing/drawing-xform");
      const drawingXform = new DrawingXform();
      const drawingOptions: any = {
        media: model.media,
        mediaIndex: model.mediaIndex
      };
      drawingNames.forEach(name => {
        const drawing = model.drawings[name];
        const drawingRel = model.drawingRels[name];
        if (drawingRel) {
          drawingOptions.rels = drawingRel.reduce((o: any, rel: any) => {
            o[rel.Id] = rel;
            return o;
          }, {});
          (drawing.anchors ?? []).forEach((anchor: any) => {
            const hyperlinks = anchor.picture && anchor.picture.hyperlinks;
            if (hyperlinks && drawingOptions.rels[hyperlinks.rId]) {
              hyperlinks.hyperlink = drawingOptions.rels[hyperlinks.rId].Target;
              delete hyperlinks.rId;
            }
          });
          drawingXform.reconcile(drawing, drawingOptions);
        }
      });
    }

    // Reconcile chart references in drawing anchors
    Object.keys(model.drawings).forEach(name => {
      const drawing = model.drawings[name];
      const drawingRel = model.drawingRels[name];
      if (!drawingRel) {
        return;
      }
      const relMap: Record<string, any> = {};
      for (const rel of drawingRel) {
        relMap[rel.Id] = rel;
      }
      for (const anchor of drawing.anchors ?? []) {
        if (anchor.graphicFrame?.rId) {
          const rel = relMap[anchor.graphicFrame.rId];
          if (rel?.Target) {
            // Extract chart number from target like "../charts/chart1.xml"
            const match = /chart(\d+)\.xml/.exec(rel.Target);
            if (match) {
              anchor.chartNumber = parseInt(match[1], 10);
            }
            // Extract chartEx number from target like "../charts/chartEx1.xml"
            const matchEx = /chartEx(\d+)\.xml/.exec(rel.Target);
            if (matchEx) {
              anchor.chartExNumber = parseInt(matchEx[1], 10);
            }
          }
        }
      }
    });

    // reconcile tables with the default styles — TableXform (~14 KB) loaded
    // lazily so table-free workbooks don't pull it in.
    const tables = Object.values(model.tables);
    if (tables.length > 0) {
      const { TableXform } = await import("@excel/xlsx/xform/table/table-xform");
      const tableXform = new TableXform();
      const tableOptions = {
        styles: model.styles
      };
      tables.forEach((table: any) => {
        tableXform.reconcile(table, tableOptions);
      });
    }

    // Reconcile pivot tables
    this._reconcilePivotTables(model);

    const sheetOptions = {
      styles: model.styles,
      sharedStrings: model.sharedStrings,
      media: model.media,
      mediaIndex: model.mediaIndex,
      date1904: model.properties?.date1904,
      drawings: model.drawings,
      drawingRels: model.drawingRels,
      comments: model.comments,
      tables: model.tables,
      vmlDrawings: model.vmlDrawings,
      vmlDrawingHF: model.vmlDrawingHF,
      vmlDrawingHFRels: model.vmlDrawingHFRels,
      pivotTables: model.pivotTablesIndexed,
      hasDynamicArrayMetadata: !!model.metadata?.hasDynamicArrays,
      dynamicArrayCmIndices: model.metadata?.dynamicArrayCmIndices as Set<number> | undefined
    };
    model.worksheets.forEach((worksheet: any) => {
      worksheet.relationships = model.worksheetRels[worksheet.sheetNo];
      worksheetXform.reconcile(worksheet, sheetOptions);
      // Attach any threaded comments that arrived in a separate
      // `xl/threadedComments/threadedComment{N}.xml` part. The sheet
      // index in that path maps to `worksheet.sheetNo`, not
      // `worksheet.id` — Excel uses the package-relative file number,
      // same as classic `xl/comments{N}.xml`.
      const threaded = model.threadedCommentsByIndex?.[worksheet.sheetNo];
      if (threaded) {
        worksheet.threadedComments = threaded;
      }
    });

    // Reconcile chartsheets — link their drawing references and
    // preserve every relationship so the writer can round-trip
    // every r:id referenced by raw-captured children (legacyDrawing,
    // picture, legacyDrawingHF, drawingHF, etc.). Previously only
    // the drawing rel was hooked up and everything else was
    // silently discarded on save, leaving any raw-captured child
    // with a dangling r:id pointing at a now-missing part.
    const chartsheetsList = model.chartsheetsList || [];
    for (const cs of chartsheetsList) {
      const csRels = model.chartsheetRels[cs.sheetNo];
      if (csRels) {
        // Keep the full rels list attached to the model so
        // `addChartsheets` can re-emit it. Copy so downstream
        // mutations don't leak back into `model.chartsheetRels`.
        cs.relationships = [...csRels];
      }
      if (cs.drawing && csRels) {
        const drawingRel = csRels.find((r: any) => r.Id === cs.drawing.rId);
        if (drawingRel) {
          const match = drawingRel.Target.match(/\/drawings\/([a-zA-Z0-9]+)[.][a-zA-Z]{3,4}$/);
          if (match) {
            cs.drawingName = match[1];
            // Resolve drawing → chart number from drawing rels
            const drawingRelArr = model.drawingRels[cs.drawingName];
            if (drawingRelArr) {
              for (const dr of drawingRelArr) {
                const chartMatch = /chart(\d+)\.xml/.exec(dr.Target);
                if (chartMatch) {
                  cs.chartNumber = parseInt(chartMatch[1], 10);
                  break;
                }
                const chartExMatch = /chartEx(\d+)\.xml/.exec(dr.Target);
                if (chartExMatch) {
                  cs.chartExNumber = parseInt(chartExMatch[1], 10);
                  break;
                }
              }
            }
          }
        }
      }
      if (cs.legacyDrawingHF && csRels) {
        const vmlRel = csRels.find((r: any) => r.Id === cs.legacyDrawingHF.rId);
        const match = vmlRel?.Target && /(vmlDrawingHF\d+)[.]vml$/.exec(vmlRel.Target);
        const name = match?.[1];
        const images = name && model.vmlDrawingHF?.[name];
        const imageRels = name && model.vmlDrawingHFRels?.[name];
        if (images && imageRels) {
          const relMap = Object.fromEntries(imageRels.map((rel: any) => [rel.Id, rel]));
          cs.headerImages = images.flatMap((image: any) => {
            const target = relMap[image.imageRelId]?.Target?.split("/media/")[1];
            const imageId = target && model.mediaIndex?.[target];
            return imageId !== undefined && /^(?:LH|CH|RH|LF|CF|RF)$/.test(image.position ?? "")
              ? [
                  {
                    imageId,
                    width: image.width,
                    height: image.height,
                    position: image.position
                  }
                ]
              : [];
          });
        }
        if (!cs.headerImages?.length) {
          // The source relationship cannot be reproduced safely (missing VML
          // rels/media or malformed positions). Drop both ends instead of
          // emitting a chartsheet relationship to a non-existent part.
          cs.relationships = cs.relationships?.filter(
            (rel: any) => rel.Id !== cs.legacyDrawingHF.rId
          );
          cs.legacyDrawingHF = undefined;
        }
      }
    }
    model.chartsheets = chartsheetsList;

    // Reconcile external workbook links before workbookRels / externalReferences
    // are dropped. Joins 3 sources:
    //   1. model.externalReferences  — ordered list of { rId } from workbook.xml
    //   2. model.workbookRels        — maps rId → target path (inside xl/)
    //   3. model.externalLinksByIndex — parsed externalLinkN.xml parts
    //   4. model.externalLinkRelsByIndex — parsed externalLinkN.xml.rels parts
    this._reconcileExternalLinks(model);

    // Preserve parsed chart data through to the workbook model.
    // chartEntries, chartRels, chartStyles, chartColors are kept as-is.

    // Reconcile chart user-shapes drawing parts onto their owning
    // ChartEntry. Each chart rels file may reference an overlay drawing
    // via `RelType.ChartUserShapes`; we copy those bytes from
    // `model.drawingRaw` (populated by `_processDrawingEntry`) onto the
    // chart entry so writers can emit them back, and so the Chart API
    // can expose them via `Chart.userShapesXml`. Regular worksheet
    // drawings are untouched — this reconcile only moves bytes for
    // chart-overlay parts.
    this._reconcileChartUserShapes(model);

    // delete unnecessary parts
    delete model.worksheetHash;
    delete model.worksheetRels;
    delete model.globalRels;
    delete model.sharedStrings;
    delete model.workbookRels;
    delete model.sheetDefs;
    // Preserve default font before deleting styles
    model.defaultFont = model.styles?.defaultFont;
    // Preserve named cell styles (OOXML cellStyles) for round-trip fidelity
    if (model.styles?.getNamedStyles) {
      const namedStyles = model.styles.getNamedStyles();
      if (namedStyles && namedStyles.length) {
        model.cellStyles = namedStyles;
      }
    }
    delete model.styles;
    delete model.mediaIndex;
    delete model.drawings;
    delete model.drawingRels;
    delete model.drawingRaw;
    delete model.vmlDrawings;
    delete model.pivotTableRels;
    delete model.metadata;
    // Internal-only scratch fields consumed by _reconcileExternalLinks.
    delete model.externalReferences;
    delete model.externalLinksByIndex;
    delete model.externalLinkRelsByIndex;
    delete model.chartsheetRels;
    delete model.chartsheetsList;
  }

  /**
   * Copy the raw bytes of each chart's user-shapes drawing part onto
   * the owning `ChartEntry.userShapesXml` so the writer can emit them
   * back verbatim (and so {@link Chart.userShapesXml} can surface them
   * to user code). Runs after all ZIP entries have been processed
   * because chart rels and drawing bytes stream in independent order.
   *
   * Skips charts that have no `ChartUserShapes` rel. The bytes stay
   * keyed by drawing name (e.g. `drawing3`) inside `model.drawingRaw`
   * since a workbook may have many user-shape drawings across
   * different charts; we look up each chart's target through its
   * rels file.
   */
  protected _reconcileChartUserShapes(model: any): void {
    const chartRelsMap = model.chartRels as Record<string, any[]> | undefined;
    const drawingRaw = model.drawingRaw as Record<string, Uint8Array> | undefined;
    const chartEntries = model.chartEntries as Record<string, ChartEntry> | undefined;
    if (!chartRelsMap || !drawingRaw || !chartEntries) {
      return;
    }
    for (const [chartNum, rels] of Object.entries(chartRelsMap)) {
      if (!Array.isArray(rels)) {
        continue;
      }
      const entry = chartEntries[chartNum];
      if (!entry) {
        continue;
      }
      const userShapesRel = rels.find(
        rel => rel && typeof rel === "object" && rel.Type === RelType.ChartUserShapes
      );
      if (!userShapesRel?.Target) {
        continue;
      }
      // Target like `../drawings/drawing3.xml` or `../drawings/chartUserShape2.xml`.
      const match = /drawings\/([^/]+)\.xml$/i.exec(String(userShapesRel.Target));
      if (!match) {
        continue;
      }
      const drawingName = match[1];
      const bytes = drawingRaw[drawingName];
      if (bytes) {
        entry.userShapesXml = bytes;
        // Make sure the chart model carries the r:id so subsequent reads
        // via Chart.userShapesXml can round-trip without extra setup.
        entry.model.userShapesRelId ??= userShapesRel.Id;
      }
    }
  }

  /**
   * Join the three on-disk sources that together describe external workbook
   * references into a single dense `model.externalLinks: ExternalLinkModel[]`.
   *
   * Sources:
   *   - `<externalReferences>` list in workbook.xml (declaration order)
   *   - `xl/_rels/workbook.xml.rels` (rId → internal path)
   *   - `xl/externalLinks/externalLink{N}.xml` (sheet names, cached values)
   *   - `xl/externalLinks/_rels/externalLink{N}.xml.rels` (target, TargetMode)
   *
   * The 1-based index of each resulting ExternalLinkModel matches the `[N]`
   * used in formula strings — this is the single source of truth formula
   * code should rely on.
   */
  protected _reconcileExternalLinks(model: any): void {
    const refs = model.externalReferences as Array<{ rId: string }> | undefined;
    if (!refs || refs.length === 0) {
      // Even when workbook.xml has no <externalReferences>, we may still
      // have parsed externalLink parts (e.g. orphaned files); those are
      // dropped silently rather than generating synthesised indices.
      if (!model.externalLinks) {
        model.externalLinks = [];
      }
      return;
    }

    const rels = (model.workbookRels ?? []) as Array<{
      Id: string;
      Type: string;
      Target: string;
    }>;
    const relById = new Map<string, { Target: string }>();
    for (const rel of rels) {
      if (rel.Type === RelType.ExternalLink) {
        relById.set(rel.Id, rel);
      }
    }

    const externalLinks: ExternalLinkModel[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const rel = relById.get(ref.rId);
      if (!rel) {
        // Broken reference — <externalReference> points at an rId that is
        // not of type ExternalLink. We skip silently; the formula engine
        // will see the now-missing index and fall back to #REF! as before.
        continue;
      }

      // The rel Target is a path inside xl/ like "externalLinks/externalLink1.xml".
      // Extract the trailing index to look up the parsed part.
      const partIndex = externalLinkIndexFromRelTarget(rel.Target);
      if (partIndex === undefined) {
        continue;
      }

      const parsed = model.externalLinksByIndex[partIndex] as ParsedExternalLink | undefined;
      const partRels = (model.externalLinkRelsByIndex[partIndex] ?? []) as ExternalLinkRelsEntry[];

      // Locate the externalLinkPath rel (should be unique within a part).
      const pathRel =
        partRels.find(r => r.Type === RelType.ExternalLinkPath) ??
        partRels.find(r => r.TargetMode === "External");

      externalLinks.push({
        index: i + 1,
        rId: ref.rId,
        target: pathRel?.Target ?? "",
        targetMode: (pathRel?.TargetMode as "External" | "Internal" | undefined) ?? "External",
        sheetNames: parsed?.sheetNames ?? [],
        cachedValues: parsed?.cachedValues ?? {}
      });
    }

    model.externalLinks = externalLinks;
  }

  /**
   * Write-time pass that brings the workbook model into a shape the writer
   * can serialise cleanly. Two concerns:
   *
   *   1. Build the final external-link list for this write, combining
   *      user-declared links (`wb.externalLinks`) with auto-discovered
   *      ones from previous writes (cached on the Workbook). The result
   *      is assigned to `model.externalLinks` and consumed by the writer;
   *      `wb.externalLinks` is **not** modified.
   *
   *   2. Scan every formula cell for `[Book]Sheet!` prefixes. Filename-form
   *      references that don't match an existing link trigger
   *      `_recordAutoExternalLink()` on the Workbook, which adds the target
   *      to the private writer cache (so subsequent writes are fixed-point
   *      stable) but leaves `wb.externalLinks` untouched.
   *
   *   3. Rewrite every external-ref formula so it uses the numeric `[N]`
   *      form, the canonical OOXML storage form. This mutation lands on
   *      the cell's model object — matching the library's existing
   *      write-time pattern for `ssId`, `styleId`, `si`, and `cm`.
   *      Subsequent writes see the `[N]` form directly and resolve it
   *      against `model.externalLinks`, giving idempotent output.
   */
  protected _normaliseExternalLinks(model: any): void {
    // Start from user-declared links, honouring their declaration order.
    const links = _collectExternalLinksForWrite(this.workbook);

    // Fast lookup: case-insensitive target → link object in `links`.
    const byTarget = new Map<string, ExternalLinkModel>();
    for (const link of links) {
      if (link.target) {
        byTarget.set(link.target.toLowerCase(), link);
      }
    }

    const scratch: NormaliseScratch = { links, byTarget, workbook: this.workbook };
    for (const worksheet of model.worksheets ?? []) {
      for (const row of worksheet.rows ?? []) {
        for (const cell of row.cells ?? []) {
          if (typeof cell?.formula === "string" && cell.formula.length > 0) {
            cell.formula = this._normaliseFormulaExternalRefs(cell.formula, scratch);
          }
          if (typeof cell?.sharedFormula === "string" && cell.sharedFormula.length > 0) {
            // Shared-formula clones typically carry the master's *address*
            // here, not a formula body — they won't match the ref regex.
            // Masters carry the formula on `.formula` (handled above).
            // We rewrite defensively in case a caller stored an actual
            // formula string here.
            cell.sharedFormula = this._normaliseFormulaExternalRefs(cell.sharedFormula, scratch);
          }
        }
      }
    }

    model.externalLinks = links;
  }

  /**
   * Rewrite a single formula so every external-ref prefix uses the numeric
   * `[N]` form. When an unknown filename-form reference is found we record
   * it on the workbook's private writer cache (so the next write can still
   * resolve it) and append a local link to `scratch.links` so subsequent
   * refs in the same formula see the freshly-assigned index.
   */
  private _normaliseFormulaExternalRefs(formula: string, scratch: NormaliseScratch): string {
    // rewriteExternalRefs internally calls findExternalRefs and returns
    // the original string unchanged when there are no matches — no need
    // for a separate guard scan here.
    return rewriteExternalRefs(formula, ref => {
      // Numeric ref: accept if it resolves, otherwise preserve verbatim so
      // Excel surfaces `#REF!` at load time — same as the old behaviour
      // for truly broken references.
      if (ref.numeric) {
        if (ref.index !== null && ref.index >= 1 && ref.index <= scratch.links.length) {
          upsertSheet(scratch.links[ref.index - 1], ref.sheet);
          return ref.index;
        }
        return null;
      }

      // Filename form — look up or auto-register.
      const key = ref.workbook.toLowerCase();
      let link = scratch.byTarget.get(key);
      if (!link) {
        const index = _recordAutoExternalLink(scratch.workbook, ref.workbook, ref.sheet);
        link = {
          index,
          target: ref.workbook,
          targetMode: "External",
          sheetNames: ref.sheet ? [ref.sheet] : [],
          cachedValues: {}
        };
        // Keep the local writer list dense: insert at its future position.
        // `_recordAutoExternalLink` guarantees `index` is user.length + cache.size
        // at the time of insertion, which equals `scratch.links.length + 1`
        // whenever we walk formulas sequentially.
        scratch.links.push(link);
        scratch.byTarget.set(key, link);
      } else {
        upsertSheet(link, ref.sheet);
        // Keep the workbook cache's sheetNames in sync so subsequent
        // writes see the accumulated set.
        if (ref.sheet) {
          _recordAutoExternalLink(scratch.workbook, ref.workbook, ref.sheet);
        }
      }
      return link.index;
    });
  }

  /**
   * Reconcile pivot tables by linking them to worksheets and their cache data.
   */
  protected _reconcilePivotTables(model: any): void {
    const rawPivotTables = (model.pivotTables || {}) as Record<string, ParsedPivotTableModel>;
    if (typeof rawPivotTables !== "object" || Object.keys(rawPivotTables).length === 0) {
      model.pivotTables = [];
      model.pivotTablesIndexed = {};
      return;
    }

    const definitionToCacheId = this._buildDefinitionToCacheIdMap(model);

    const cacheMap = new Map<
      number,
      {
        definition: ParsedCacheDefinition;
        records: any;
        definitionName: string;
      }
    >();

    Object.entries(model.pivotCacheDefinitions || {}).forEach(
      ([name, definition]: [string, any]) => {
        const cacheId = definitionToCacheId.get(name);
        if (cacheId !== undefined) {
          const recordsName = name.replace("Definition", "Records");
          cacheMap.set(cacheId, {
            definition,
            records: model.pivotCacheRecords?.[recordsName],
            definitionName: name
          });
        }
      }
    );

    const loadedPivotTables: PivotTable[] = [];
    const pivotTablesIndexed: Record<string, PivotTable> = {};

    Object.entries(rawPivotTables).forEach(([pivotName, pt]) => {
      const tableNumber = this._extractTableNumber(pivotName);
      const cacheData = cacheMap.get(pt.cacheId);

      const defaultMetric = this._determineMetric(pt.dataFields);
      const completePivotTable: PivotTable = {
        ...pt,
        name: pt.name ?? `PivotTable${tableNumber}`,
        tableNumber,
        cacheId: String(pt.cacheId),
        cacheDefinition: cacheData?.definition,
        cacheRecords: cacheData?.records,
        cacheFields: cacheData?.definition?.cacheFields ?? [],
        rows: pt.rowFields.filter(f => f >= 0),
        columns: pt.colFields.filter(f => f >= 0 && f !== -2),
        values: pt.dataFields.map(df => df.fld),
        pages: pt.pageFields.map(pf => pf.fld),
        metric: defaultMetric,
        valueMetrics: this._determineValueMetrics(pt.dataFields, defaultMetric),
        applyWidthHeightFormats: pt.applyWidthHeightFormats === "1" ? "1" : "0"
      };

      loadedPivotTables.push(completePivotTable);
      // Key by absolute zip path so reconcile can match any rel target layout.
      pivotTablesIndexed[pivotTablePathFromName(pivotName)] = completePivotTable;
    });

    loadedPivotTables.sort((a, b) => a.tableNumber - b.tableNumber);
    model.pivotTables = loadedPivotTables;
    model.pivotTablesIndexed = pivotTablesIndexed;
  }

  protected _extractTableNumber(name: string): number {
    const match = name.match(/pivotTable(\d+)/);
    return match ? parseInt(match[1], 10) : 1;
  }

  protected _buildCacheIdMap(model: any): Map<string, number> {
    const rIdToCacheId = new Map<string, number>();
    const pivotCaches = model.pivotCaches ?? [];
    for (const cache of pivotCaches) {
      if (cache.cacheId && cache.rId) {
        rIdToCacheId.set(cache.rId, parseInt(cache.cacheId, 10));
      }
    }
    return rIdToCacheId;
  }

  protected _buildDefinitionToCacheIdMap(model: any): Map<string, number> {
    const definitionToCacheId = new Map<string, number>();
    const rIdToCacheId = this._buildCacheIdMap(model);
    const workbookRels = model.workbookRels ?? [];

    for (const rel of workbookRels) {
      if (rel.Type === XLSX.RelType.PivotCacheDefinition && rel.Target) {
        const match = rel.Target.match(/pivotCacheDefinition(\d+)\.xml/);
        if (match) {
          const defName = `pivotCacheDefinition${match[1]}`;
          const cacheId = rIdToCacheId.get(rel.Id);
          if (cacheId !== undefined) {
            definitionToCacheId.set(defName, cacheId);
          }
        }
      }
    }

    return definitionToCacheId;
  }

  protected _determineMetric(dataFields: Array<{ subtotal?: string }>): PivotTableSubtotal {
    if (dataFields.length > 0 && dataFields[0].subtotal) {
      return dataFields[0].subtotal as PivotTableSubtotal;
    }
    return "sum";
  }

  protected _determineValueMetrics(
    dataFields: Array<{ subtotal?: string }>,
    defaultMetric: PivotTableSubtotal
  ): PivotTableSubtotal[] {
    return dataFields.map(df => (df.subtotal as PivotTableSubtotal) || defaultMetric);
  }

  // ===========================================================================
  // Process Entry methods - shared by all platforms
  // ===========================================================================

  async _processWorksheetEntry(
    stream: IParseStream,
    model: any,
    sheetNo: number,
    options: XlsxOptions | undefined,
    path: string
  ): Promise<void> {
    const xform = new WorkSheetXform(options);
    const worksheet = await xform.parseStream(stream);
    if (!worksheet) {
      throw new XlsxParseError(path, "Failed to parse worksheet");
    }
    worksheet.sheetNo = sheetNo;
    model.worksheetHash[path] = worksheet;
    model.worksheets.push(worksheet);
  }

  async _processChartsheetEntry(stream: IParseStream, model: any, sheetNo: number): Promise<void> {
    const { ChartsheetXform } = await import("@excel/xlsx/xform/sheet/chartsheet-xform");
    const xform = new ChartsheetXform();
    const chartsheet = await xform.parseStream(stream);
    if (chartsheet) {
      chartsheet.sheetNo = sheetNo;
      model.chartsheets[sheetNo] = chartsheet;
    }
  }

  async _processCommentEntry(stream: IParseStream, model: any, zipPath: string): Promise<void> {
    const { CommentsXform } = await import("@excel/xlsx/xform/comment/comments-xform");
    const xform = new CommentsXform();
    const comments = await xform.parseStream(stream);
    // Key by absolute zip path so reconcile can match any rel target layout.
    model.comments[zipPath] = comments;
  }

  async _processTableEntry(stream: IParseStream, model: any, zipPath: string): Promise<void> {
    const { TableXform } = await import("@excel/xlsx/xform/table/table-xform");
    const xform = new TableXform();
    const table = await xform.parseStream(stream);
    // Key by absolute zip path so reconcile can match any rel target layout.
    model.tables[zipPath] = table;
  }

  async _processWorksheetRelsEntry(
    stream: IParseStream,
    model: any,
    sheetNo: number
  ): Promise<void> {
    // A sheet is where Excel looks for printer settings, so a relationship from
    // here may be the only thing that reaches a preserved part.
    model.worksheetRels[sheetNo] = await this.parseRels(stream, model, worksheetPath(sheetNo));
  }

  async _processMediaEntry(stream: IParseStream, model: any, filename: string): Promise<void> {
    const lastDot = filename.lastIndexOf(".");
    if (lastDot >= 1) {
      const extension = filename.substr(lastDot + 1);
      const name = filename.substr(0, lastDot);
      await new Promise<void>((resolve, reject) => {
        const streamBuf = this.createStreamBuf();

        const cleanup = () => {
          stream.off("error", onError);
          streamBuf.off("error", onError);
          streamBuf.off("finish", onFinish);
        };

        const onFinish = () => {
          cleanup();
          model.mediaIndex[filename] = model.media.length;
          model.mediaIndex[name] = model.media.length;
          const medium = {
            type: "image",
            name,
            extension,
            buffer: streamBuf.read()
          };
          model.media.push(medium);
          resolve();
        };

        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };

        streamBuf.once("finish", onFinish);
        stream.on("error", onError);
        streamBuf.on("error", onError);
        stream.pipe(streamBuf);
      });
    }
  }

  /**
   * Process a drawing XML entry.
   *
   * @param stream - Stream to read from (used in loadFromZipEntries path)
   * @param model - Model to populate
   * @param name - Drawing name (e.g., "drawing1")
   * @param rawData - Pre-read raw data (used in loadFromFiles path to avoid re-reading stream)
   */
  async _processDrawingEntry(
    stream: IParseStream,
    model: any,
    name: string,
    rawData?: Uint8Array
  ): Promise<void> {
    // Use provided rawData if available (loadFromFiles path), otherwise collect from stream.
    // In loadFromFiles, the stream is created from already-decoded text, and collecting from
    // it may not work correctly due to PassThrough stream timing issues.
    const data = rawData ?? (await this.collectStreamData(stream));

    // Parse the drawing for normal processing (images, etc.)
    const { DrawingXform } = await import("@excel/xlsx/xform/drawing/drawing-xform");
    const xform = new DrawingXform();
    const xmlString = this.bufferToString(data);
    const drawing = await xform.parseStream(this.createTextStream(xmlString));
    model.drawings[name] = drawing;
    // Also stash the original bytes — chart user-shape drawings use a
    // distinct schema (`c:relSizeAnchor` / `c:userShapes` instead of
    // `xdr:twoCellAnchor`) and are post-reconciled onto their owning
    // ChartEntry so the bytes can be written back verbatim. Regular
    // worksheet drawings don't read this map.
    if (!model.drawingRaw) {
      model.drawingRaw = {} as Record<string, Uint8Array>;
    }
    (model.drawingRaw as Record<string, Uint8Array>)[name] = data;
  }

  /**
   * Stash raw bytes of a chart-overlay drawing part. `c:userShapes`
   * parts live under `xl/drawings/chartUserShape{N}.xml` in files we
   * write ourselves and can use arbitrary names in foreign files (the
   * rel target is the only authoritative reference). The bytes are
   * keyed by the stem so `_reconcileChartUserShapes` can match them
   * against each chart's `ChartUserShapes` rel Target.
   */
  async _processChartUserShapesEntry(
    _stream: IParseStream,
    model: any,
    name: string,
    rawData?: Uint8Array
  ): Promise<void> {
    const data = rawData ?? (await this.collectStreamData(_stream));
    if (!model.drawingRaw) {
      model.drawingRaw = {} as Record<string, Uint8Array>;
    }
    (model.drawingRaw as Record<string, Uint8Array>)[name] = data;
  }

  async _processDrawingRelsEntry(entry: any, model: any, name: string): Promise<void> {
    model.drawingRels[name] = await this.parseRels(entry, model, drawingPath(name));
  }

  async _processVmlDrawingEntry(entry: any, model: any, zipPath: string): Promise<void> {
    const { VmlDrawingXform } = await import("@excel/xlsx/xform/drawing/vml-drawing-xform");
    const xform = new VmlDrawingXform();
    const vmlDrawing = await xform.parseStream(entry);
    // Key by absolute zip path so reconcile can match any rel target layout.
    model.vmlDrawings[zipPath] = vmlDrawing;
  }

  async _processVmlDrawingHFEntry(entry: any, model: any, _name: string): Promise<void> {
    const { VmlDrawingXform } = await import("@excel/xlsx/xform/drawing/vml-drawing-xform");
    const xform = new VmlDrawingXform();
    const vmlDrawing = await xform.parseStream(entry);
    // Store every positioned header/footer image shape (LH/CH/RH/LF/CF/RF)
    // for reconciliation against the VML part's own image relationships.
    const headerImages =
      vmlDrawing?.headerImages ?? (vmlDrawing?.headerImage ? [vmlDrawing.headerImage] : undefined);
    if (headerImages?.length) {
      model.vmlDrawingHF ??= {};
      model.vmlDrawingHF[_name] = headerImages;
    }
  }

  async _processVmlDrawingHFRelsEntry(entry: any, model: any, name: string): Promise<void> {
    model.vmlDrawingHFRels ??= {};
    model.vmlDrawingHFRels[name] = await this.parseRels(entry, model, `xl/drawings/${name}.vml`);
  }

  async _processThemeEntry(stream: IParseStream, model: any, name: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const streamBuf = this.createStreamBuf();

      const cleanup = () => {
        stream.off("error", onError);
        streamBuf.off("error", onError);
        streamBuf.off("finish", onFinish);
      };

      const onFinish = () => {
        cleanup();
        const data = streamBuf.read();
        model.themes[name] = data
          ? typeof data === "string"
            ? data
            : this.bufferToString(data)
          : "";
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      streamBuf.once("finish", onFinish);
      stream.on("error", onError);
      streamBuf.on("error", onError);
      stream.pipe(streamBuf);
    });
  }

  async _processPivotTableEntry(stream: IParseStream, model: any, name: string): Promise<void> {
    const { PivotTableXform } = await import("@excel/xlsx/xform/pivot-table/pivot-table-xform");
    const xform = new PivotTableXform();
    const pivotTable = await xform.parseStream(stream);
    if (pivotTable) {
      model.pivotTables[name] = pivotTable;
    }
  }

  async _processPivotTableRelsEntry(stream: IParseStream, model: any, name: string): Promise<void> {
    model.pivotTableRels[name] = await this.parseRels(stream, model, `xl/pivotTables/${name}.xml`);
  }

  async _processPivotCacheDefinitionEntry(
    stream: IParseStream,
    model: any,
    name: string
  ): Promise<void> {
    const { PivotCacheDefinitionXform } =
      await import("@excel/xlsx/xform/pivot-table/pivot-cache-definition-xform");
    const xform = new PivotCacheDefinitionXform();
    const cacheDefinition = await xform.parseStream(stream);
    if (cacheDefinition) {
      model.pivotCacheDefinitions[name] = cacheDefinition;
    }
  }

  async _processPivotCacheRecordsEntry(
    stream: IParseStream,
    model: any,
    name: string
  ): Promise<void> {
    const { PivotCacheRecordsXform } =
      await import("@excel/xlsx/xform/pivot-table/pivot-cache-records-xform");
    const xform = new PivotCacheRecordsXform();
    const cacheRecords = await xform.parseStream(stream);
    if (cacheRecords) {
      model.pivotCacheRecords[name] = cacheRecords;
    }
  }

  /**
   * Parse `xl/externalLinks/externalLink{N}.xml` into the intermediate
   * ParsedExternalLink shape. Reconciliation (joining with the rels file
   * and the workbook's `<externalReferences>` list) happens later in
   * {@link reconcile}.
   */
  async _processExternalLinkEntry(stream: IParseStream, model: any, index: number): Promise<void> {
    const xform = new ExternalLinkXform();
    const parsed = await xform.parseStream(stream);
    if (parsed) {
      model.externalLinksByIndex[index] = parsed;
    }
  }

  /**
   * Parse `xl/externalLinks/_rels/externalLink{N}.xml.rels`. The Target /
   * TargetMode carried here is what Excel uses to locate the actual external
   * file at open time, so we must preserve it verbatim (including relative
   * paths like `"测试.xlsx"`).
   */
  async _processExternalLinkRelsEntry(
    stream: IParseStream,
    model: any,
    index: number
  ): Promise<void> {
    const relationships = await this.parseRels(
      stream,
      model,
      `xl/externalLinks/externalLink${index}.xml`
    );
    model.externalLinkRelsByIndex[index] = relationships ?? [];
  }

  async _processChartEntry(
    stream: IParseStream,
    model: any,
    chartNumber: number,
    rawData?: Uint8Array
  ): Promise<void> {
    const data = rawData ?? (await this.collectStreamData(stream));

    // Parse into model for high-level API access
    const xform = new ChartSpaceXform();
    const xmlString = this.bufferToString(data);
    const chart = await xform.parseStream(this.createTextStream(xmlString));
    if (chart) {
      model.chartEntries[chartNumber] = {
        chartNumber,
        model: chart,
        rawData: data,
        modelSnapshot: snapshotChartModel(chart)
      };
    }
  }

  async _processChartRelsEntry(
    stream: IParseStream,
    model: any,
    chartNumber: number
  ): Promise<void> {
    model.chartRels[chartNumber] = await this.parseRels(
      stream,
      model,
      `xl/charts/chart${chartNumber}.xml`
    );
  }

  async _processChartStyleEntry(
    stream: IParseStream,
    model: any,
    styleNumber: number
  ): Promise<void> {
    const data = await this.collectStreamData(stream);
    model.chartStyles[styleNumber] = data;
  }

  async _processChartColorsEntry(
    stream: IParseStream,
    model: any,
    colorsNumber: number
  ): Promise<void> {
    const data = await this.collectStreamData(stream);
    model.chartColors[colorsNumber] = data;
  }

  // ===========================================================================
  // loadFromFiles - shared logic for loading from pre-extracted ZIP data
  // ===========================================================================

  async loadFromFiles(
    zipData: Record<string, Uint8Array>,
    options?: XlsxReadOptions
  ): Promise<TWorkbook> {
    this.workbook.sourceFilePath = undefined;
    const model: any = this.createEmptyModel();

    const entries = Object.keys(zipData).map(name => ({
      name,
      dir: name.endsWith("/"),
      data: zipData[name]
    }));

    this.assertNotBinaryWorkbook(
      entries.some(entry => normalizeZipPath(entry.name) === "xl/workbook.bin"),
      entries.some(entry => normalizeZipPath(entry.name) === OOXML_PATHS.xlWorkbook)
    );

    for (const entry of entries) {
      if (!entry.dir) {
        const entryName = normalizeZipPath(entry.name);

        // Create appropriate stream based on entry type
        const isBinaryEntry = isBinaryEntryPath(entryName);
        const stream = isBinaryEntry
          ? this.createBinaryStream(entry.data)
          : this.createTextStream(this.bufferToString(entry.data));

        const handled = await this._processKnownEntry(stream, model, entryName, options);
        if (!handled) {
          await this._processDefaultEntry(stream, model, entryName, entry.data);
        }
      }
    }

    await this.reconcile(model, options);
    setWorkbookModel(this.workbook, model);
    return this.workbook;
  }

  /**
   * Process default entries (drawings, comments, tables, etc.)
   * @param rawData Optional raw entry data for passthrough preservation (used by loadFromFiles)
   */
  protected async _processDefaultEntry(
    stream: IParseStream,
    model: any,
    entryName: string,
    rawData?: Uint8Array
  ): Promise<boolean> {
    const sheetNo = getWorksheetNoFromWorksheetRelsPath(entryName);
    if (sheetNo !== undefined) {
      await this._processWorksheetRelsEntry(stream, model, sheetNo);
      return true;
    }

    const chartsheetRelsNo = getChartsheetNoFromRelsPath(entryName);
    if (chartsheetRelsNo !== undefined) {
      model.chartsheetRels[chartsheetRelsNo] = await this.parseRels(
        stream,
        model,
        chartsheetPath(chartsheetRelsNo)
      );
      return true;
    }

    const mediaFilename = getMediaFilenameFromPath(entryName);
    if (mediaFilename) {
      await this._processMediaEntry(stream, model, mediaFilename);
      return true;
    }

    const drawingName = getDrawingNameFromPath(entryName);
    if (drawingName) {
      await this._processDrawingEntry(stream, model, drawingName, rawData);
      return true;
    }

    const chartUserShapesName = getChartUserShapesNameFromPath(entryName);
    if (chartUserShapesName) {
      await this._processChartUserShapesEntry(stream, model, chartUserShapesName, rawData);
      return true;
    }

    const drawingRelsName = getDrawingNameFromRelsPath(entryName);
    if (drawingRelsName) {
      await this._processDrawingRelsEntry(stream, model, drawingRelsName);
      return true;
    }

    const vmlDrawingName = getVmlDrawingNameFromPath(entryName);
    if (vmlDrawingName) {
      await this._processVmlDrawingEntry(stream, model, entryName);
      return true;
    }

    // VML header/footer drawings (watermark in header mode).
    // Parse to extract header image info for round-trip preservation.
    const vmlHFName = getVmlDrawingHFNameFromPath(entryName);
    if (vmlHFName) {
      await this._processVmlDrawingHFEntry(stream, model, vmlHFName);
      return true;
    }

    // The VML part's own rels map each shape's `o:relid` to a media target.
    const vmlHFRelsName = getVmlDrawingHFNameFromRelsPath(entryName);
    if (vmlHFRelsName) {
      await this._processVmlDrawingHFRelsEntry(stream, model, vmlHFRelsName);
      return true;
    }

    if (isCommentsPath(entryName)) {
      await this._processCommentEntry(stream, model, entryName);
      return true;
    }

    const tableName = getTableNameFromPath(entryName);
    if (tableName) {
      await this._processTableEntry(stream, model, entryName);
      return true;
    }

    const themeName = getThemeNameFromPath(entryName);
    if (themeName) {
      await this._processThemeEntry(stream, model, themeName);
      return true;
    }

    // Pivot table files
    const pivotTableName = getPivotTableNameFromPath(entryName);
    if (pivotTableName) {
      await this._processPivotTableEntry(stream, model, pivotTableName);
      return true;
    }

    const pivotTableRelsName = getPivotTableNameFromRelsPath(entryName);
    if (pivotTableRelsName) {
      await this._processPivotTableRelsEntry(stream, model, pivotTableRelsName);
      return true;
    }

    // Pivot cache files
    const pivotCacheDefinitionName = getPivotCacheDefinitionNameFromPath(entryName);
    if (pivotCacheDefinitionName) {
      await this._processPivotCacheDefinitionEntry(stream, model, pivotCacheDefinitionName);
      return true;
    }

    // R9-B8: Skip parsing pivotCacheDefinition .rels files — they are never used
    // during reconciliation and were just deleted at cleanup. The cache definition's
    // r:id attribute (preserved in ParsedCacheDefinition.rId) is sufficient.
    const pivotCacheDefinitionRelsName = getPivotCacheDefinitionNameFromRelsPath(entryName);
    if (pivotCacheDefinitionRelsName) {
      return true;
    }

    const pivotCacheRecordsName = getPivotCacheRecordsNameFromPath(entryName);
    if (pivotCacheRecordsName) {
      await this._processPivotCacheRecordsEntry(stream, model, pivotCacheRecordsName);
      return true;
    }

    // External workbook links: xl/externalLinks/externalLinkN.xml and its
    // sibling _rels file. Both parts are required to reconstruct the
    // ExternalLinkModel (the .xml carries sheet names + cached values; the
    // .rels carries the target path and TargetMode).
    const externalLinkIndex = getExternalLinkIndexFromPath(entryName);
    if (externalLinkIndex !== undefined) {
      await this._processExternalLinkEntry(stream, model, externalLinkIndex);
      return true;
    }

    const externalLinkRelsIndex = getExternalLinkIndexFromRelsPath(entryName);
    if (externalLinkRelsIndex !== undefined) {
      await this._processExternalLinkRelsEntry(stream, model, externalLinkRelsIndex);
      return true;
    }

    // Chart files — parse natively before the passthrough catch-all
    const chartNumber = getChartNumberFromPath(entryName);
    if (chartNumber !== undefined) {
      await this._processChartEntry(stream, model, chartNumber, rawData);
      return true;
    }

    const chartRelsNumber = getChartNumberFromRelsPath(entryName);
    if (chartRelsNumber !== undefined) {
      await this._processChartRelsEntry(stream, model, chartRelsNumber);
      return true;
    }

    const chartStyleNumber = getChartStyleNumberFromPath(entryName);
    if (chartStyleNumber !== undefined) {
      if (rawData) {
        model.chartStyles[chartStyleNumber] = rawData;
      } else {
        await this._processChartStyleEntry(stream, model, chartStyleNumber);
      }
      return true;
    }

    const chartColorsNumber = getChartColorsNumberFromPath(entryName);
    if (chartColorsNumber !== undefined) {
      if (rawData) {
        model.chartColors[chartColorsNumber] = rawData;
      } else {
        await this._processChartColorsEntry(stream, model, chartColorsNumber);
      }
      return true;
    }

    const chartExStyleNumber = getChartExStyleNumberFromPath(entryName);
    if (chartExStyleNumber !== undefined) {
      model.chartExStyles[chartExStyleNumber] = rawData ?? (await this.collectStreamData(stream));
      return true;
    }

    const chartExColorsNumber = getChartExColorsNumberFromPath(entryName);
    if (chartExColorsNumber !== undefined) {
      model.chartExColors[chartExColorsNumber] = rawData ?? (await this.collectStreamData(stream));
      return true;
    }

    // ChartEx files (Office 2016+ extended charts) — raw bytes plus best-effort structured model
    const chartExNumber = getChartExNumberFromPath(entryName);
    if (chartExNumber !== undefined) {
      const data = rawData ?? (await this.collectStreamData(stream));
      const rawXml = this.bufferToString(data);
      model.chartExEntries[chartExNumber] = data;
      try {
        const parsed = parseChartEx(rawXml);
        model.chartExStructuredEntries[chartExNumber] = {
          chartExNumber,
          model: parsed,
          rawData: data,
          modelSnapshot: snapshotChartModel(parsed)
        };
      } catch {
        // Keep legacy-safe passthrough if a third-party chartEx part is not parseable.
      }
      return true;
    }

    const chartExRelsNumber = getChartExNumberFromRelsPath(entryName);
    if (chartExRelsNumber !== undefined) {
      model.chartExRels[chartExRelsNumber] = await this.parseRels(
        stream,
        model,
        `xl/charts/chartEx${chartExRelsNumber}.xml`
      );
      return true;
    }

    // Raw-passthrough catch-all for Office 2010+ slicer/timeline
    // dashboard controls and their associated rels. documonster does not
    // model these structurally yet; capturing the bytes here prevents
    // silent data loss on round-trip when a dashboard workbook comes
    // through. Same idea covers the two-level rels files produced by
    // Excel (the `_rels` subfolder sits next to each part).
    if (
      /^xl\/slicers\/slicer\d+\.xml$/.test(entryName) ||
      /^xl\/slicerCaches\/slicerCache\d+\.xml$/.test(entryName) ||
      /^xl\/timelines\/timeline\d+\.xml$/.test(entryName) ||
      /^xl\/timelineCaches\/timelineCache\d+\.xml$/.test(entryName) ||
      /^xl\/slicers\/_rels\/slicer\d+\.xml\.rels$/.test(entryName) ||
      /^xl\/slicerCaches\/_rels\/slicerCache\d+\.xml\.rels$/.test(entryName) ||
      /^xl\/timelines\/_rels\/timeline\d+\.xml\.rels$/.test(entryName) ||
      /^xl\/timelineCaches\/_rels\/timelineCache\d+\.xml\.rels$/.test(entryName)
    ) {
      const targetMap =
        entryName.startsWith("xl/slicers/") && !entryName.includes("/_rels/")
          ? (model.slicerParts ??= {} as Record<string, Uint8Array>)
          : entryName.startsWith("xl/slicerCaches/") && !entryName.includes("/_rels/")
            ? (model.slicerCacheParts ??= {} as Record<string, Uint8Array>)
            : entryName.startsWith("xl/timelines/") && !entryName.includes("/_rels/")
              ? (model.timelineParts ??= {} as Record<string, Uint8Array>)
              : entryName.startsWith("xl/timelineCaches/") && !entryName.includes("/_rels/")
                ? (model.timelineCacheParts ??= {} as Record<string, Uint8Array>)
                : entryName.startsWith("xl/slicers/_rels/")
                  ? (model.slicerParts ??= {} as Record<string, Uint8Array>)
                  : entryName.startsWith("xl/slicerCaches/_rels/")
                    ? (model.slicerCacheParts ??= {} as Record<string, Uint8Array>)
                    : entryName.startsWith("xl/timelines/_rels/")
                      ? (model.timelineParts ??= {} as Record<string, Uint8Array>)
                      : (model.timelineCacheParts ??= {} as Record<string, Uint8Array>);
      targetMap[entryName] = rawData ?? (await this.collectStreamData(stream));
      return true;
    }

    // Nothing above recognised this entry. Keep it rather than drain it: an
    // unrecognised part is far more likely to be someone's data (a VBA project,
    // custom properties, a data connection) than something this writer is
    // entitled to delete. `collectOpaqueParts` applies the drop policy later,
    // once the whole package has been seen.
    if (isRelationshipsPart(entryName)) {
      const owner = ownerOfRelationshipsPart(entryName);
      if (owner !== undefined) {
        await this.parseRels(stream, model, owner);
      }
      // Handled as relationships, not as bytes: a preserved part's `.rels` is
      // re-emitted from its parsed `relationships` so that a relationship
      // pointing at something we dropped does not survive as a dangling
      // reference. Returning true stops the caller draining it as unknown.
      return true;
    }

    model.opaqueUnknownEntries.set(entryName, rawData ?? (await this.collectStreamData(stream)));
    return true;
  }

  /**
   * Record a parsed `.rels` file against the part that declares it.
   *
   * Both the modelled rels (root, workbook) and an opaque part's own rels land
   * here, because resolving "what pointed at this preserved part" needs every
   * relationship in the package, not just the unrecognised ones.
   */
  protected _recordOpaqueRelationships(
    model: any,
    source: string,
    rels: readonly RelationshipModel[] | undefined
  ): void {
    if (!rels || rels.length === 0) {
      return;
    }
    // `Id`/`Type`/`Target` are optional on `RelationshipModel` because it is the
    // raw attribute bag the SAX parser produced, so a malformed `.rels` can be
    // missing any of them. Such an entry is skipped rather than defaulted: an
    // edge with no target cannot make anything reachable, and inventing one would
    // put a broken relationship into the output.
    const recorded: OpaqueRelationship[] = [];
    for (const rel of rels) {
      if (rel.Id === undefined || rel.Type === undefined || rel.Target === undefined) {
        continue;
      }
      recorded.push({
        id: rel.Id,
        type: rel.Type,
        target: rel.Target,
        targetMode: rel.TargetMode
      });
    }
    if (recorded.length > 0) {
      model.opaqueRelationshipsBySource.set(source, recorded);
    }
  }

  // ===========================================================================
  // Write methods - shared by all platforms
  // ===========================================================================

  /**
   * Helper: render an xform directly to a streaming zip entry.
   * Avoids buffering the entire XML string in memory.
   * Awaits backpressure drain after each entry to respect downstream flow control.
   */
  private async _renderToZip(
    zip: IZipWriter,
    path: string,
    xform: { render(xmlStream: any, model?: any): void },
    model?: any
  ): Promise<void> {
    const entry = zip.createEntry(path);
    const stream = new XmlStreamWriter(entry);
    xform.render(stream, model);
    entry.end();
    // Respect downstream backpressure between entries
    await zip.waitForDrain();
  }

  /**
   * Write one already-materialised part, then give the sink a chance to push
   * back. Every part goes through here (or `_renderToZip`) so peak buffering
   * stays near a single entry instead of growing with the package: a forgotten
   * checkpoint would not corrupt anything, it would just let that part's bytes
   * queue up unthrottled.
   */
  private async _appendToZip(
    zip: IZipWriter,
    data: string | Uint8Array,
    options: { name: string; base64?: boolean }
  ): Promise<void> {
    zip.append(data, options);
    await zip.waitForDrain();
  }

  async addContentTypes(zip: IZipWriter, model: any): Promise<void> {
    // Extensions this writer declares itself. A preserved part that relied on a
    // conflicting Default for one of these needs an Override instead, or the
    // writer's value silently reclassifies it.
    const reserved = new Map<string, string>([
      ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
      ["xml", "application/xml"]
    ]);
    for (const medium of model.media ?? []) {
      if (medium?.type === "image" && typeof medium.extension === "string") {
        const extension = medium.extension.toLowerCase();
        reserved.set(extension, extension === "svg" ? "image/svg+xml" : `image/${extension}`);
      }
    }

    const declarations = opaqueContentTypeDeclarations(
      model.opaqueParts,
      model.opaqueContentTypeDefaults,
      reserved
    );
    await this._renderToZip(zip, OOXML_PATHS.contentTypes, new ContentTypesXform(), {
      ...model,
      opaqueContentTypes: declarations.overrides,
      opaqueContentTypeDefaults: declarations.defaults
    });
  }

  async addApp(zip: IZipWriter, model: any): Promise<void> {
    await this._renderToZip(zip, OOXML_PATHS.docPropsApp, new AppXform(), model);
  }

  async addCore(zip: IZipWriter, model: any): Promise<void> {
    await this._renderToZip(zip, OOXML_PATHS.docPropsCore, new CoreXform(), model);
  }

  async addThemes(zip: IZipWriter, model: any): Promise<void> {
    const themes = model.themes || { theme1: theme1Xml };
    for (const name of Object.keys(themes)) {
      const xml = themes[name];
      await this._appendToZip(zip, xml, { name: themePath(name) });
    }
  }

  async addOfficeRels(zip: IZipWriter, model: any): Promise<void> {
    const relationships: any[] = [
      { Id: "rId1", Type: XLSX.RelType.OfficeDocument, Target: OOXML_PATHS.xlWorkbook },
      { Id: "rId2", Type: XLSX.RelType.CoreProperties, Target: OOXML_PATHS.docPropsCore },
      { Id: "rId3", Type: XLSX.RelType.ExtenderProperties, Target: OOXML_PATHS.docPropsApp }
    ];
    appendOpaqueSourceRelationships(relationships, model.opaqueParts, "");
    await this._renderToZip(zip, OOXML_PATHS.rootRels, new RelationshipsXform(), relationships);
  }

  /**
   * Write the preserved parts and each one's own `.rels`.
   *
   * The relationships that point *at* these parts are not written here — they
   * belong to `[Content_Types].xml` and to the `.rels` of the modelled parts
   * that declared them, which are regenerated elsewhere and pick the preserved
   * entries up through `appendOpaqueSourceRelationships`.
   */
  /**
   * Drop preserved parts this write would leave unreachable, before anything is
   * emitted.
   *
   * Runs at the head of `prepareModel` because four writers consume the result —
   * the content types, the root rels, the workbook rels and the parts themselves —
   * and a part dropped after one of them had already declared it would leave the
   * package inconsistent in a different way than the one being fixed.
   */
  protected _resolveOpaqueReachability(model: any): void {
    const parts: OpaquePart[] = model.opaqueParts ?? [];
    if (parts.length === 0) {
      return;
    }

    // The edges this write will actually emit: the root and workbook rels are
    // rebuilt with the preserved entries appended, and each sheet re-emits its
    // own. Sheet-sourced targets are resolved against a canonical worksheet path
    // because every sheet lives in `xl/worksheets/`, so a relative target
    // resolves identically whichever file index the sheet ends up with — which
    // is also why deleting a sheet is what removes its edges, not renumbering.
    const emitted: OpaqueSourceRelationship[] = [];
    for (const part of parts) {
      for (const inbound of part.sourceRelationships ?? []) {
        if (inbound.source === "" || inbound.source === OOXML_PATHS.xlWorkbook) {
          emitted.push(inbound);
        }
      }
    }
    const canonicalSheet = worksheetPath(1);
    for (const worksheet of model.worksheets ?? []) {
      for (const relationship of worksheet.opaqueRels ?? []) {
        emitted.push({ ...relationship, source: canonicalSheet });
      }
    }

    const resolved = resolveReachableOpaqueParts(parts, emitted);
    if (resolved.drops.length === 0) {
      return;
    }

    model.opaqueParts = resolved.parts;
    model.opaqueDrops = [...(model.opaqueDrops ?? []), ...resolved.drops];

    // A sheet must not keep pointing at a part that is no longer written.
    const kept = new Set(resolved.parts.map(part => part.path.toLowerCase()));
    for (const worksheet of model.worksheets ?? []) {
      if (!worksheet.opaqueRels) {
        continue;
      }
      const surviving = worksheet.opaqueRels.filter((relationship: OpaqueRelationship) => {
        const target = resolveRelationshipTarget(
          canonicalSheet,
          relationship.target,
          relationship.targetMode
        );
        return !target || kept.has(target.toLowerCase());
      });
      worksheet.opaqueRels = surviving.length > 0 ? surviving : undefined;
    }
  }

  async addOpaqueParts(zip: IZipWriter, model: any): Promise<void> {
    const parts: OpaquePart[] = model.opaqueParts ?? [];
    for (const part of parts) {
      await this._appendToZip(zip, part.data, { name: part.path });
      if (part.relationships && part.relationships.length > 0) {
        await this._renderToZip(
          zip,
          relationshipsPathFor(part.path),
          new RelationshipsXform(),
          part.relationships.map(rel => ({
            Id: rel.id,
            Type: rel.type,
            Target: rel.target,
            ...(rel.targetMode ? { TargetMode: rel.targetMode } : {})
          }))
        );
      }
    }
  }

  async addWorkbookRels(zip: IZipWriter, model: any): Promise<void> {
    let count = 1;
    const relationships: any[] = [
      { Id: `rId${count++}`, Type: XLSX.RelType.Styles, Target: OOXML_REL_TARGETS.workbookStyles },
      { Id: `rId${count++}`, Type: XLSX.RelType.Theme, Target: OOXML_REL_TARGETS.workbookTheme1 }
    ];
    if (model.sharedStrings.count) {
      relationships.push({
        Id: `rId${count++}`,
        Type: XLSX.RelType.SharedStrings,
        Target: OOXML_REL_TARGETS.workbookSharedStrings
      });
    }

    // Add FeaturePropertyBag relationship if checkboxes are used
    if (model.hasCheckboxes) {
      relationships.push({
        Id: `rId${count++}`,
        Type: XLSX.RelType.FeaturePropertyBag,
        Target: OOXML_REL_TARGETS.workbookFeaturePropertyBag
      });
    }
    // Add metadata relationship for dynamic array formulas
    if (model.hasDynamicArrayFormulas) {
      relationships.push({
        Id: `rId${count++}`,
        Type: XLSX.RelType.SheetMetadata,
        Target: OOXML_REL_TARGETS.workbookMetadata
      });
    }
    // Office 365 threaded comments need a workbook-level person
    // directory. The rel Target is `persons/person.xml` (relative to
    // the xl/ workbook home, matching how Excel writes it).
    if (model.hasPersons) {
      relationships.push({
        Id: `rId${count++}`,
        Type: XLSX.RelType.Person,
        Target: "persons/person.xml"
      });
    }
    // R9-B6: Deduplicate pivot cache relationships by cacheId. When multiple pivot
    // tables share the same cache, only one workbook relationship should be created.
    // Also assigns rId to each pivot table (R9-B7: typed on PivotTable interface).
    const seenCacheIds = new Map<string, string>(); // cacheId → rId
    (model.pivotTables ?? []).forEach((pivotTable: PivotTable) => {
      const existing = seenCacheIds.get(pivotTable.cacheId);
      if (existing) {
        // Shared cache: reuse the rId from the first pivot table with this cacheId
        pivotTable.rId = existing;
      } else {
        pivotTable.rId = `rId${count++}`;
        seenCacheIds.set(pivotTable.cacheId, pivotTable.rId);
        relationships.push({
          Id: pivotTable.rId,
          Type: XLSX.RelType.PivotCacheDefinition,
          Target: pivotCacheDefinitionRelTargetFromWorkbook(pivotTable.tableNumber)
        });
      }
    });
    model.worksheets.forEach((worksheet: any) => {
      worksheet.rId = `rId${count++}`;
      // fileIndex is assigned once in prepareModel() — use it directly
      relationships.push({
        Id: worksheet.rId,
        Type: XLSX.RelType.Worksheet,
        Target: worksheetRelTarget(worksheet.fileIndex)
      });
    });

    // Add chartsheet relationships
    (model.chartsheets || []).forEach((cs: any) => {
      cs.rId = `rId${count++}`;
      relationships.push({
        Id: cs.rId,
        Type: RelType.Chartsheet,
        Target: `chartsheets/sheet${cs.sheetNo}.xml`
      });
    });

    // External workbook link rels are written AFTER worksheets on purpose:
    // Excel tolerates either order, but stable ordering (worksheets then
    // externalLinks) keeps the emitted workbook.xml.rels diff-friendly for
    // round-trip tests. Each external link becomes a regular Relationship
    // entry targeting `externalLinks/externalLinkN.xml` inside `xl/`; the
    // actual external file path is pointed at by the nested
    // externalLinkN.xml.rels part written by addExternalLinks().
    //
    // The list items here are the deep-copies produced by
    // `_normaliseExternalLinks` — assigning `link.rId` is safe and does not
    // leak into the user's Workbook.externalLinks.
    const externalLinks = (model.externalLinks ?? []) as ExternalLinkModel[];
    for (const link of externalLinks) {
      link.rId = `rId${count++}`;
      relationships.push({
        Id: link.rId,
        Type: XLSX.RelType.ExternalLink,
        Target: externalLinkRelTargetFromWorkbook(link.index)
      });
    }

    appendOpaqueSourceRelationships(relationships, model.opaqueParts, OOXML_PATHS.xlWorkbook);

    const xform = new RelationshipsXform();
    await this._renderToZip(zip, OOXML_PATHS.xlWorkbookRels, xform, relationships);
  }

  async addFeaturePropertyBag(zip: IZipWriter, model: any): Promise<void> {
    if (!model.hasCheckboxes) {
      return;
    }
    await this._renderToZip(
      zip,
      OOXML_PATHS.xlFeaturePropertyBag,
      new FeaturePropertyBagXform(),
      {}
    );
  }

  async addMetadata(zip: IZipWriter, model: any): Promise<void> {
    if (!model.hasDynamicArrayFormulas) {
      return;
    }
    await this._renderToZip(zip, OOXML_PATHS.xlMetadata, new MetadataXform(), {
      dynamicArrayCount: model.dynamicArrayCount
    });
  }

  async addSharedStrings(zip: IZipWriter, model: any): Promise<void> {
    if (model.sharedStrings && model.sharedStrings.count) {
      await this._renderToZip(
        zip,
        OOXML_PATHS.xlSharedStrings,
        model.sharedStrings,
        model.sharedStrings.model
      );
    }
  }

  async addStyles(zip: IZipWriter, model: any): Promise<void> {
    if (model.styles) {
      await this._renderToZip(zip, OOXML_PATHS.xlStyles, model.styles, model.styles.model);
    }
  }

  async addWorkbook(zip: IZipWriter, model: any): Promise<void> {
    await this._renderToZip(zip, OOXML_PATHS.xlWorkbook, new WorkbookXform(), model);
  }

  async addWorksheets(zip: IZipWriter, model: any): Promise<void> {
    const worksheetXform = new WorkSheetXform();
    const relationshipsXform = new RelationshipsXform();

    // Lazily load the optional comment / VML / form-control xforms only when
    // some worksheet actually needs them, so comment/control-free workbooks
    // never pull these (~12 KB + VML) into the bundle.
    const needsComments = model.worksheets.some((ws: any) => ws.comments.length > 0);
    const needsVml = model.worksheets.some(
      (ws: any) =>
        ws.comments.length > 0 || (ws.formControls && ws.formControls.length > 0) || ws.headerImage
    );
    const needsCtrlProp = model.worksheets.some(
      (ws: any) => ws.formControls && ws.formControls.length > 0
    );

    const commentsXform = needsComments
      ? new (await import("@excel/xlsx/xform/comment/comments-xform")).CommentsXform()
      : null;
    const vmlDrawingXform = needsVml
      ? new (await import("@excel/xlsx/xform/drawing/vml-drawing-xform")).VmlDrawingXform()
      : null;
    const ctrlPropXform = needsCtrlProp
      ? new (await import("@excel/xlsx/xform/drawing/ctrl-prop-xform")).CtrlPropXform()
      : null;

    for (const worksheet of model.worksheets) {
      const { fileIndex } = worksheet;

      // Worksheet XML: stream directly to the zip entry (avoids holding the
      // entire XML in memory) and use the shared completion/backpressure path.
      await this._renderToZip(zip, worksheetPath(fileIndex), worksheetXform, worksheet);

      if (worksheet.rels && worksheet.rels.length) {
        await this._renderToZip(
          zip,
          worksheetRelsPath(fileIndex),
          relationshipsXform,
          worksheet.rels
        );
      }

      // Generate comments XML (separate from VML)
      if (worksheet.comments.length > 0) {
        await this._renderToZip(zip, commentsPath(fileIndex), commentsXform!, worksheet);
      }

      // Office 365 threaded comments sit in their own part tree
      // alongside classic VML comments. Written straight from the
      // structured model without going through an xform instance —
      // the payload is small and the shape maps 1:1 onto the output.
      if (worksheet.threadedComments && worksheet.threadedComments.length > 0) {
        const xml = renderThreadedComments(worksheet.threadedComments);
        await this._appendToZip(zip, xml, {
          name: `xl/threadedComments/threadedComment${fileIndex}.xml`
        });
      }

      // Generate unified VML drawing (contains both notes and form controls)
      const hasComments = worksheet.comments.length > 0;
      const hasFormControls = worksheet.formControls && worksheet.formControls.length > 0;

      if (hasComments || hasFormControls) {
        await this._renderToZip(zip, vmlDrawingPath(fileIndex), vmlDrawingXform!, {
          comments: hasComments ? worksheet.comments : [],
          formControls: hasFormControls ? worksheet.formControls : []
        });
      }

      // Generate VML drawing for header/footer images (watermark in header mode)
      if (worksheet.headerImages?.length || worksheet.headerImage) {
        const headerImages = worksheet.headerImages ?? [worksheet.headerImage];

        // Write the VML file for the header image
        await this._renderToZip(zip, vmlDrawingHFPath(fileIndex), vmlDrawingXform!, {
          comments: [],
          formControls: [],
          headerImages: headerImages.map(hdrImage => ({
            imageRelId: hdrImage.imageRelId,
            width: hdrImage.headerWidth,
            height: hdrImage.headerHeight,
            position: hdrImage.position
          }))
        });

        // Write the VML rels file referencing the image
        await this._renderToZip(
          zip,
          vmlDrawingHFRelsPath(fileIndex),
          relationshipsXform,
          headerImages.map(hdrImage => {
            const bookImage = hdrImage.bookImage;
            const imageFileName =
              bookImage.name &&
              bookImage.extension &&
              bookImage.name.endsWith(`.${bookImage.extension}`)
                ? bookImage.name
                : `${bookImage.name}.${bookImage.extension}`;
            return {
              Id: hdrImage.imageRelId,
              Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
              Target: `../media/${imageFileName}`
            };
          })
        );
      }

      // Generate ctrlProp files for form controls
      if (hasFormControls) {
        for (const control of worksheet.formControls) {
          await this._renderToZip(zip, ctrlPropPath(control.ctrlPropId), ctrlPropXform!, control);
        }
      }
    }
  }

  async addChartsheets(zip: IZipWriter, model: any): Promise<void> {
    if (!model.chartsheets || model.chartsheets.length === 0) {
      return;
    }
    const { ChartsheetXform } = await import("@excel/xlsx/xform/sheet/chartsheet-xform");
    const { VmlDrawingXform } = await import("@excel/xlsx/xform/drawing/vml-drawing-xform");
    const chartsheetXform = new ChartsheetXform();
    const relsXform = new RelationshipsXform();
    const vmlDrawingXform = new VmlDrawingXform();
    // Track VML drawing zip paths we re-emit for chartsheets so we
    // don't accidentally write the same VML part twice when a single
    // VML file is referenced by multiple chartsheets. Writing a ZIP
    // entry twice produces a package with duplicate central-directory
    // entries — most consumers tolerate it (reading the last), but
    // validators flag it and `unzip -l` shows the duplication.
    const emittedVmlPaths = new Set<string>();

    for (const cs of model.chartsheets || []) {
      await this._renderToZip(zip, chartsheetPath(cs.sheetNo), chartsheetXform, cs);

      // Chartsheet rels. A chartsheet may carry rels beyond the
      // drawing reference — `legacyDrawing`, `legacyDrawingHF`,
      // `drawingHF`, `picture`, etc. — and those rels are referenced
      // by `r:id` attributes inside the raw-captured `rawChildren`
      // blocks. If we only emit the drawing rel (the previous
      // implementation), every other r:id goes dangling at save,
      // corrupting the package.
      //
      // Strategy:
      //   1. Start with the preserved `relationships` list from load
      //      (missing for newly-created chartsheets).
      //   2. Overlay / insert the current drawing rel — the drawing
      //      target may have been rewritten (e.g. chartsheet renamed
      //      or its drawing renumbered) so we replace any prior
      //      entry with the same Id.
      const baseRels: any[] = Array.isArray(cs.relationships) ? [...cs.relationships] : [];
      if (cs.drawing) {
        const drawingRel = {
          Id: cs.drawing.rId,
          Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
          Target: `../drawings/${cs.drawingName}.xml`
        };
        const existingIdx = baseRels.findIndex((r: any) => r?.Id === cs.drawing.rId);
        if (existingIdx >= 0) {
          baseRels[existingIdx] = drawingRel;
        } else {
          baseRels.push(drawingRel);
        }
      }
      if (baseRels.length > 0) {
        await this._renderToZip(zip, chartsheetRelsPath(cs.sheetNo), relsXform, baseRels);
      }

      // Re-emit any VML drawing parts this chartsheet's rels reference.
      // The worksheet loop only emits VML for worksheets that own
      // comments / form controls / header images; a chartsheet that
      // carries its own `<legacyDrawing r:id="…"/>` would preserve its
      // rel target on write but leave the VML body missing from the
      // package — a dangling relationship. Walk the chartsheet's rels,
      // resolve each VML target against the chartsheet path, and emit
      // the parsed body captured at load time.
      if (model.vmlDrawings || model.vmlDrawingHF || cs.headerImages?.length) {
        const baseDir = `xl/chartsheets/`;
        for (const rel of baseRels) {
          if (rel?.Type !== RelType.VmlDrawing || !rel.Target) {
            continue;
          }
          const vmlPath = resolveRelTarget(baseDir, rel.Target);
          if (emittedVmlPaths.has(vmlPath)) {
            continue;
          }
          const vmlName = /\/(vmlDrawingHF\d+)[.]vml$/.exec(vmlPath)?.[1];
          const validHeaderImages = vmlName
            ? (cs.headerImages ?? []).flatMap((image: any) => {
                const medium = model.media?.[image.imageId];
                return medium ? [{ image, medium }] : [];
              })
            : [];
          const parsedHeaderImages = vmlName ? model.vmlDrawingHF?.[vmlName] : undefined;
          const headerImages =
            parsedHeaderImages ??
            validHeaderImages.map(({ image }: any, index: number) => ({
              imageRelId: `rId${index + 1}`,
              width: image.width,
              height: image.height,
              position: image.position
            }));
          const vmlModel =
            model.vmlDrawings?.[vmlPath] ?? (headerImages ? { headerImages } : undefined);
          if (!vmlModel) {
            continue;
          }
          emittedVmlPaths.add(vmlPath);
          await this._renderToZip(zip, vmlPath, vmlDrawingXform, vmlModel);
          const headerImageRels =
            (vmlName && model.vmlDrawingHFRels?.[vmlName]) ??
            validHeaderImages.map(({ medium }: any, index: number) => {
              const filename = medium.name?.endsWith(`.${medium.extension}`)
                ? medium.name
                : `${medium.name}.${medium.extension}`;
              return {
                Id: `rId${index + 1}`,
                Type: RelType.Image,
                Target: `../media/${filename}`
              };
            });
          if (vmlName && headerImageRels?.length) {
            const relsPath = vmlPath.replace(/\/([^/]+)[.]vml$/, "/_rels/$1.vml.rels");
            await this._renderToZip(zip, relsPath, relsXform, headerImageRels);
          }
          // `prepareChartsheets` already flipped `model.hasChartsheetVml`
          // before content-types was written, so no further signalling
          // is needed here.
        }
      }
    }
  }

  async addDrawings(zip: IZipWriter, model: any): Promise<void> {
    // Skip entirely (and avoid loading DrawingXform ~34 KB) when no worksheet
    // has a drawing. Chartsheets emit their drawing XML verbatim (without
    // DrawingXform), so account for them separately.
    const hasWorksheetDrawing = model.worksheets.some((ws: any) => ws.drawing);
    const hasChartsheetDrawing = (model.chartsheets ?? []).some(
      (cs: any) => cs.drawingName && (cs.chartNumber || cs.chartExNumber)
    );
    if (!hasWorksheetDrawing && !hasChartsheetDrawing) {
      return;
    }
    const relsXform = new RelationshipsXform();

    if (hasWorksheetDrawing) {
      const { DrawingXform } = await import("@excel/xlsx/xform/drawing/drawing-xform");
      const drawingXform = new DrawingXform();

      for (const worksheet of model.worksheets) {
        const { drawing } = worksheet;
        if (drawing) {
          const filteredAnchors = filterDrawingAnchors(drawing.anchors ?? []);
          const drawingForWrite = drawing.anchors
            ? { ...drawing, anchors: filteredAnchors }
            : drawing;
          drawingXform.prepare(drawingForWrite);
          await this._renderToZip(zip, drawingPath(drawing.name), drawingXform, drawingForWrite);

          await this._renderToZip(zip, drawingRelsPath(drawing.name), relsXform, drawing.rels);
        }
      }
    }

    // Chartsheet drawings — each chartsheet references a drawing
    // containing a single chart that fills the entire sheet. Unlike
    // worksheet-embedded charts (where a `<xdr:twoCellAnchor>` with
    // `<xdr:from>/<xdr:to>` cell references pins the chart to a
    // rectangle of cells, whose dimensions Excel computes from the
    // sheet's column widths and row heights), a chartsheet has no
    // cell grid — its `sheetData` is empty. A cell-based anchor on
    // a chartsheet therefore resolves to a 0×0 rectangle and Excel
    // renders an empty white canvas instead of the chart.
    //
    // Excel's own output for chartsheet drawings uses
    // `<xdr:absoluteAnchor>` with concrete EMU `pos`/`ext` values
    // (≈ 10.84″ × 6.67″ — standard A4 landscape minus default
    // margins), AND repeats the same `<a:ext>` on the inner
    // `<xdr:graphicFrame>/<xdr:xfrm>` so both the anchor-level and
    // frame-level sizes are non-zero. Omitting either produces the
    // blank-canvas rendering bug users see. We emit the same byte
    // layout here verbatim rather than route through `DrawingXform`,
    // which is tuned for the worksheet twoCellAnchor case.
    const CHARTSHEET_EMU_CX = 9906000; // ≈ 10.84 inches
    const CHARTSHEET_EMU_CY = 6096000; // ≈  6.67 inches
    for (const cs of model.chartsheets || []) {
      if (cs.drawingName && (cs.chartNumber || cs.chartExNumber)) {
        const chartRId = "rId1";
        const isChartEx = !cs.chartNumber && !!cs.chartExNumber;
        const chartName = isChartEx ? `Chart ${cs.chartExNumber}` : `Chart ${cs.chartNumber}`;
        const drawingXml = renderChartsheetDrawingXml({
          chartRId,
          chartName,
          isChartEx,
          extCx: CHARTSHEET_EMU_CX,
          extCy: CHARTSHEET_EMU_CY
        });
        const drawingRels = [
          {
            Id: chartRId,
            Type: isChartEx ? RelType.ChartEx : RelType.Chart,
            Target: isChartEx
              ? chartExRelTargetFromDrawing(cs.chartExNumber)
              : chartRelTargetFromDrawing(cs.chartNumber)
          }
        ];
        await this._appendToZip(zip, drawingXml, { name: drawingPath(cs.drawingName) });
        await this._renderToZip(zip, drawingRelsPath(cs.drawingName), relsXform, drawingRels);
      }
    }
  }

  async addCharts(zip: IZipWriter, model: any, strictTemplateMode = false): Promise<void> {
    const relsXform = new RelationshipsXform();

    for (const [n, chartEntry] of Object.entries(model.chartEntries || {}) as Array<
      [string, ChartEntry]
    >) {
      if (shouldPassthroughChartEntry(chartEntry)) {
        await this._appendToZip(zip, chartEntry.rawData, { name: chartPath(n) });
      } else {
        const requireRawPatch = shouldRequireChartRawPatch(chartEntry, strictTemplateMode);
        const patched = tryPatchChartRawXml(chartEntry, requireRawPatch);
        if (patched) {
          await this._appendToZip(zip, patched, { name: chartPath(n) });
        } else {
          if (requireRawPatch) {
            throw new ChartOptionsError(buildChartStrictFailureMessage(n, chartEntry.model));
          }
          // Render via buffered path so we can splice preserved leading
          // XML comments (e.g. vendor provenance markers) from the
          // original raw bytes back in front of `<c:chart>`. The SAX-
          // backed xform parser drops `comment` events so the
          // structured model has no memory of them.
          const buffered = renderChartWithLeadingComments(chartEntry, new ChartSpaceXform());
          await this._appendToZip(zip, buffered, { name: chartPath(n) });
        }
      }

      // Write chart style (raw bytes)
      if (model.chartStyles?.[n]) {
        await this._appendToZip(zip, model.chartStyles[n], { name: chartStylePath(n) });
      }

      // Write chart colors (raw bytes)
      if (model.chartColors?.[n]) {
        await this._appendToZip(zip, model.chartColors[n], { name: chartColorsPath(n) });
      }

      // Build chart rels
      const rels: any[] = [];

      // Collect original rels first (excluding style/colors which we regenerate)
      // We keep their original Ids to avoid breaking r:id references inside chart XML
      const originalRels = model.chartRels?.[n];
      const usedIds = new Set<string>();
      if (Array.isArray(originalRels)) {
        for (const rel of originalRels) {
          if (rel.Type !== RelType.ChartStyle && rel.Type !== RelType.ChartColors) {
            rels.push(rel);
            usedIds.add(rel.Id);
          }
        }
      }

      // Fold in rels allocated during chart registration — notably the
      // image relationships added by `resolvePendingChartImages` for
      // `pictureFill.image`. The chart XML already embeds the `r:id`
      // assigned during registration, so we must preserve those ids
      // verbatim (don't rewrite) and only skip duplicates that were
      // already round-tripped through `originalRels`.
      const entryRels = (chartEntry as { rels?: any[] }).rels;
      if (Array.isArray(entryRels)) {
        for (const rel of entryRels) {
          if (!rel?.Id || usedIds.has(rel.Id)) {
            continue;
          }
          rels.push(rel);
          usedIds.add(rel.Id);
        }
      }

      // Allocate new rIds for style/colors that don't conflict with existing ones
      let rIdCount = 1;
      const nextRId = (): string => {
        let id = `rId${rIdCount++}`;
        while (usedIds.has(id)) {
          id = `rId${rIdCount++}`;
        }
        usedIds.add(id);
        return id;
      };

      // Add style rel if style exists
      if (model.chartStyles?.[n]) {
        rels.push({
          Id: nextRId(),
          Type: RelType.ChartStyle,
          Target: chartStyleRelTarget(n)
        });
      }

      // Add colors rel if colors exist
      if (model.chartColors?.[n]) {
        rels.push({
          Id: nextRId(),
          Type: RelType.ChartColors,
          Target: chartColorsRelTarget(n)
        });
      }

      // Write c:userShapes overlay drawing part — preserves annotation
      // shapes attached to the chart. Bytes can come from a loaded file
      // (captured onto `chartEntry.userShapesXml` by
      // `_reconcileChartUserShapes`) or from a programmatic call to
      // `Chart.setUserShapesXml`. We always emit the bytes at a canonical
      // path (`xl/drawings/chartUserShape{n}.xml`) and rewrite the rel
      // Target accordingly so the chart XML's existing `r:id` still
      // resolves.
      if (chartEntry.userShapesXml) {
        await this._appendToZip(zip, chartEntry.userShapesXml, {
          name: chartUserShapesPath(n)
        });
        const targetPath = chartUserShapesRelTarget(n);
        const existingRel = rels.find(r => r?.Type === RelType.ChartUserShapes);
        if (existingRel) {
          existingRel.Target = targetPath;
        } else {
          // No existing rel — allocate one, preferring the r:id the model
          // already embeds in `<c:userShapes r:id="…"/>` so the chart XML
          // doesn't need a rewrite.
          const relId = chartEntry.model.userShapesRelId ?? nextRId();
          usedIds.add(relId);
          rels.push({ Id: relId, Type: RelType.ChartUserShapes, Target: targetPath });
        }
      }

      // Write chart rels if any
      if (rels.length > 0) {
        await this._renderToZip(zip, chartRelsPath(n), relsXform, rels);
      }
    }
  }

  async addChartExEntries(zip: IZipWriter, model: any, strictTemplateMode = false): Promise<void> {
    const relsXform = new RelationshipsXform();

    const rawEntries = model.chartExEntries || {};
    const structured = (model.chartExStructuredEntries ?? {}) as Record<string, ChartExEntry>;
    const written = new Set<string>();

    // 1. Loaded chartEx entries — byte-preserve while clean, render structured XML once edited.
    for (const [n, rawBytes] of Object.entries(rawEntries)) {
      const structuredEntry = structured[n];
      if (structuredEntry && !shouldPassthroughChartExEntry(structuredEntry)) {
        const requireRawPatch = shouldRequireChartExRawPatch(structuredEntry, strictTemplateMode);
        const patched = tryPatchChartExRawXml(structuredEntry, requireRawPatch);
        if (patched) {
          await this._appendToZip(zip, patched, { name: chartExPath(n) });
        } else {
          if (requireRawPatch) {
            throw new ChartOptionsError(buildChartExStrictFailureMessage(n, structuredEntry.model));
          }
          const renderedXml = renderChartEx(stripChartExRawXml(structuredEntry.model));
          // Splice preserved leading XML comments from original raw
          // bytes back in front of `<cx:chart>`. The chartEx parser
          // calls `parseXml(...)` without `{ comments: true }` so the
          // structured model has no memory of them.
          const originalRawXml = rawBytes
            ? new TextDecoder().decode(rawBytes as Uint8Array)
            : structuredEntry.model.rawXml;
          const finalXml = spliceChartExLeadingComments(renderedXml, originalRawXml);
          await this._appendToZip(zip, finalXml, {
            name: chartExPath(n)
          });
        }
      } else {
        await this._appendToZip(zip, rawBytes as Uint8Array, { name: chartExPath(n) });
      }
      written.add(n);

      // Write chartEx rels if present
      const rels = model.chartExRels?.[n];
      const chartExRels = this._buildChartExRels(n, rels, model);
      if (chartExRels.length > 0) {
        await this._renderToZip(zip, chartExRelsPath(n), relsXform, chartExRels);
      }
      await this._appendChartExSidecars(zip, model, n, structuredEntry);
    }

    // 2. Structured chartEx entries — built programmatically via addChartEx()
    for (const [n, entry] of Object.entries(structured) as Array<[string, ChartExEntry]>) {
      if (written.has(n)) {
        continue;
      }
      // Data-ref → `_xlchart.vN.M` defined-name rewrite has already
      // run in `prepareChartExSidecars` so the model's formulas now
      // point at hidden names and the cached `<cx:lvl>` levels have
      // been cleared. Force structural rebuild to pick up the
      // mutated model (any stale `rawXml` from earlier mutations
      // would mask the rewrite).
      const xml = renderChartEx(entry.model, { forceStructural: true });
      await this._appendToZip(zip, xml, { name: chartExPath(n) });
      await this._appendChartExSidecars(zip, model, n, entry);
      const chartExRels = this._buildChartExRels(n, entry.rels, model, entry);
      if (chartExRels.length > 0) {
        await this._renderToZip(zip, chartExRelsPath(n), relsXform, chartExRels);
      }
    }
  }

  private async _appendChartExSidecars(
    zip: IZipWriter,
    model: any,
    n: string,
    entry?: ChartExEntry
  ): Promise<void> {
    if (entry?.model.style) {
      await this._appendToZip(zip, new TextEncoder().encode(buildChartStyle(entry.model.style)), {
        name: chartExStylePath(n)
      });
    } else if (model.chartExStyles?.[n]) {
      await this._appendToZip(zip, model.chartExStyles[n], { name: chartExStylePath(n) });
    }
    if (entry?.model.colors) {
      await this._appendToZip(zip, new TextEncoder().encode(buildChartColors(entry.model.colors)), {
        name: chartExColorsPath(n)
      });
    } else if (model.chartExColors?.[n]) {
      await this._appendToZip(zip, model.chartExColors[n], { name: chartExColorsPath(n) });
    }
  }

  private _buildChartExRels(
    n: string,
    existing: any[] | undefined,
    model: any,
    entry?: ChartExEntry
  ): any[] {
    const rels = Array.isArray(existing) ? [...existing] : [];
    const usedIds = new Set(rels.map(rel => rel.Id));
    const nextRId = (): string => {
      let i = 1;
      while (usedIds.has(`rId${i}`)) {
        i++;
      }
      const id = `rId${i}`;
      usedIds.add(id);
      return id;
    };
    const hasStyle = !!(model.chartExStyles?.[n] || entry?.model.style);
    const hasColors = !!(model.chartExColors?.[n] || entry?.model.colors);
    if (hasStyle && !rels.some(rel => rel.Type === RelType.ChartStyle)) {
      rels.push({ Id: nextRId(), Type: RelType.ChartStyle, Target: chartExStyleRelTarget(n) });
    }
    if (hasColors && !rels.some(rel => rel.Type === RelType.ChartColors)) {
      rels.push({ Id: nextRId(), Type: RelType.ChartColors, Target: chartExColorsRelTarget(n) });
    }
    return rels;
  }

  async addTables(zip: IZipWriter, model: any): Promise<void> {
    // Skip (and avoid loading TableXform ~14 KB) when no worksheet has tables.
    const hasTable = model.worksheets.some((ws: any) => ws.tables && ws.tables.length > 0);
    if (!hasTable) {
      return;
    }
    const { TableXform } = await import("@excel/xlsx/xform/table/table-xform");
    const tableXform = new TableXform();

    for (const worksheet of model.worksheets) {
      for (const table of worksheet.tables) {
        tableXform.prepare(table, {});
        await this._renderToZip(zip, tablePath(table.target), tableXform, table);
      }
    }
  }

  /**
   * Write every external workbook reference into the archive. For each
   * {@link ExternalLinkModel} in `model.externalLinks` we emit two files:
   *
   *   xl/externalLinks/externalLink{index}.xml          — sheet names + cache
   *   xl/externalLinks/_rels/externalLink{index}.xml.rels — target path
   *
   * The target-path rel carries `TargetMode="External"` with a **bare
   * relative** `Target` whenever the user supplied one. This is the single
   * line that makes Office / WPS resolve the referenced workbook relative
   * to the current file's directory (not the `%USERPROFILE%\Documents`
   * fallback) — the root of the relative-path external-link behaviour.
   */
  async addExternalLinks(zip: IZipWriter, model: any): Promise<void> {
    const externalLinks = (model.externalLinks ?? []) as ExternalLinkModel[];
    if (externalLinks.length === 0) {
      return;
    }

    const externalLinkXform = new ExternalLinkXform();
    const relsXform = new RelationshipsXform();

    for (const link of externalLinks) {
      await this._renderToZip(zip, externalLinkPath(link.index), externalLinkXform, link);

      // Always rId1 — the externalLink part only ever has a single rel.
      // `TargetMode="External"` is what flags Office to look the file up
      // at workbook-open time rather than embed it.
      await this._renderToZip(zip, externalLinkRelsPath(link.index), relsXform, [
        {
          Id: "rId1",
          Type: XLSX.RelType.ExternalLinkPath,
          Target: link.target,
          TargetMode: link.targetMode ?? "External"
        }
      ]);
    }
  }

  async addPivotTables(zip: IZipWriter, model: any): Promise<void> {
    if (!model.pivotTables.length) {
      return;
    }

    // Dynamic import: pivot serialisation (~44 KB across the three xforms) is
    // only reachable when the workbook actually contains pivot tables, so it
    // stays out of bundles whose consumers never use pivots.
    const [{ PivotCacheRecordsXform }, { PivotCacheDefinitionXform }, { PivotTableXform }] =
      await Promise.all([
        import("@excel/xlsx/xform/pivot-table/pivot-cache-records-xform"),
        import("@excel/xlsx/xform/pivot-table/pivot-cache-definition-xform"),
        import("@excel/xlsx/xform/pivot-table/pivot-table-xform")
      ]);

    const pivotCacheRecordsXform = new PivotCacheRecordsXform();
    const pivotCacheDefinitionXform = new PivotCacheDefinitionXform();
    const pivotTableXform = new PivotTableXform();
    const relsXform = new RelationshipsXform();

    // R9-B6: Track which cacheIds have already been written to avoid duplicating
    // shared caches. Maps cacheId → tableNumber used for the cache file names.
    const writtenCaches = new Map<string, number>();

    for (const pivotTable of model.pivotTables as PivotTable[]) {
      const n = pivotTable.tableNumber;
      const isLoaded = pivotTable.isLoaded;
      const cacheId = pivotTable.cacheId;

      // R9-B6: Only write cache definition/records/rels once per unique cacheId.
      const cacheAlreadyWritten = writtenCaches.has(cacheId);
      if (!cacheAlreadyWritten) {
        writtenCaches.set(cacheId, n);

        if (isLoaded) {
          if (pivotTable.cacheDefinition) {
            await this._renderToZip(
              zip,
              pivotCacheDefinitionPath(n),
              pivotCacheDefinitionXform,
              pivotTable.cacheDefinition
            );
          }
          if (pivotTable.cacheRecords) {
            await this._renderToZip(
              zip,
              pivotCacheRecordsPath(n),
              pivotCacheRecordsXform,
              pivotTable.cacheRecords
            );
          }
        } else {
          await this._renderToZip(
            zip,
            pivotCacheRecordsPath(n),
            pivotCacheRecordsXform,
            pivotTable
          );
          await this._renderToZip(
            zip,
            pivotCacheDefinitionPath(n),
            pivotCacheDefinitionXform,
            pivotTable
          );
        }

        // R9-B4: Only write cache definition rels when cache records exist.
        const hasCacheRecords = isLoaded ? !!pivotTable.cacheRecords : true;
        if (hasCacheRecords) {
          const cacheRecordsRId =
            (isLoaded ? pivotTable.cacheDefinition?.rId : undefined) ?? "rId1";
          await this._renderToZip(zip, pivotCacheDefinitionRelsPath(n), relsXform, [
            {
              Id: cacheRecordsRId,
              Type: XLSX.RelType.PivotCacheRecords,
              Target: pivotCacheRecordsRelTarget(n)
            }
          ]);
        }
      }

      // Pivot table XML is always written (each pivot table has its own file).
      await this._renderToZip(zip, pivotTablePath(n), pivotTableXform, pivotTable);

      // Pivot table rels point to the cache definition file.
      const cacheTableNumber = writtenCaches.get(cacheId)!;
      await this._renderToZip(zip, pivotTableRelsPath(n), relsXform, [
        {
          Id: "rId1",
          Type: XLSX.RelType.PivotCacheDefinition,
          Target: pivotCacheDefinitionRelTargetFromPivotTable(cacheTableNumber)
        }
      ]);
    }
  }

  _finalize(zip: IZipWriter): Promise<this> {
    return new Promise((resolve, reject) => {
      zip.on("finish", () => {
        resolve(this);
      });
      zip.on("error", reject);
      zip.finalize();
    });
  }

  prepareModel(model: any, options: any): void {
    this._resolveOpaqueReachability(model);
    model.creator = model.creator ?? "Documonster";
    model.lastModifiedBy = model.lastModifiedBy ?? "Documonster";
    model.created = model.created ?? new Date();
    model.modified = model.modified ?? new Date();

    model.useSharedStrings =
      options.useSharedStrings !== undefined ? options.useSharedStrings : true;
    model.useStyles = options.useStyles !== undefined ? options.useStyles : true;

    model.sharedStrings = new SharedStringsXform();

    // Preserve default font from parsed styles if available
    const oldDefaultFont = model.defaultFont;
    model.styles = model.useStyles ? new StylesXform(true) : new StylesXform.Mock();
    if (oldDefaultFont && model.styles.setDefaultFont) {
      model.styles.setDefaultFont(oldDefaultFont);
    }
    // Register workbook-level named cell styles so cells referencing them by
    // name resolve to the correct cellStyleXfs index during style building.
    if (model.cellStyles && model.styles.registerNamedStyles) {
      const namedStyleMap = new Map(
        (model.cellStyles as NamedStyleEntry[]).map(cs => [cs.name, cs])
      );
      model.styles.registerNamedStyles(namedStyleMap);
    }

    const workbookXform = new WorkbookXform();
    const worksheetXform = new WorkSheetXform();

    workbookXform.prepare(model);

    // Normalise external-workbook references before any formula rendering.
    // Two jobs:
    //   1. Scan every formula cell and make sure each referenced workbook
    //      has a matching ExternalLinkModel in `model.externalLinks`, with
    //      a stable 1-based index.
    //   2. Rewrite formula strings from `[filename.xlsx]Sheet!A1` to
    //      `[N]Sheet!A1`, which is the canonical on-disk form Excel
    //      expects inside `<f>` elements.
    //
    // Done once up-front (not per cell) so the index assignment is
    // deterministic and every cell sees the final externalLinks list.
    this._normaliseExternalLinks(model);

    const worksheetOptions: any = {
      sharedStrings: model.sharedStrings,
      styles: model.styles,
      date1904: model.properties?.date1904,
      drawingsCount: 0,
      media: model.media
    };
    // Seed the drawing-name allocator past any drawing name a worksheet already
    // carries verbatim from load (`drawingN`). WorkSheetXform.prepare() only
    // auto-names a drawing when its `name` is empty, using `drawing${++count}`.
    // If one sheet keeps a round-tripped "drawing1" while another needs a fresh
    // name, a count starting at 0 would hand out "drawing1" again — a duplicate
    // `/xl/drawings/drawing1.xml` Override (invalid per OPC). Starting the count
    // above the highest existing numeric drawing name avoids the collision
    // regardless of how the mix arose (e.g. Workbook.importSheet).
    let maxExistingDrawingNo = 0;
    for (const ws of model.worksheets as any[]) {
      const m = /^drawing(\d+)$/.exec(ws?.drawing?.name ?? "");
      if (m) {
        maxExistingDrawingNo = Math.max(maxExistingDrawingNo, Number(m[1]));
      }
    }
    for (const cs of model.chartsheets ?? []) {
      const m = /^drawing(\d+)$/.exec(cs?.drawingName ?? "");
      if (m) {
        maxExistingDrawingNo = Math.max(maxExistingDrawingNo, Number(m[1]));
      }
    }
    worksheetOptions.drawingsCount = maxExistingDrawingNo;
    worksheetOptions.drawings = model.drawings = [];
    worksheetOptions.commentRefs = model.commentRefs = [];
    worksheetOptions.formControlRefs = model.formControlRefs = [];
    // Collect the list of worksheets that carry Office 365 threaded
    // comments so the Content Types override list can include them
    // and the ZIP writer knows which per-sheet parts to emit. Sheets
    // with zero threaded comments are skipped entirely — Excel treats
    // a missing part as "no threaded comments on this sheet".
    model.threadedCommentSheetIds = [] as Array<number | string>;
    model.hasPersons = (model.persons?.length ?? 0) > 0;
    // Raw-passthrough parts captured on load. The Content-Types
    // override list and the content-types writer need these path
    // lists so the emitted bytes are registered in the package.
    model.slicerPartPaths = Object.keys(model.slicerParts ?? {}).filter(
      p => !p.includes("/_rels/")
    );
    model.slicerCachePartPaths = Object.keys(model.slicerCacheParts ?? {}).filter(
      p => !p.includes("/_rels/")
    );
    model.timelinePartPaths = Object.keys(model.timelineParts ?? {}).filter(
      p => !p.includes("/_rels/")
    );
    model.timelineCachePartPaths = Object.keys(model.timelineCacheParts ?? {}).filter(
      p => !p.includes("/_rels/")
    );
    model.hasHeaderWatermark = false;
    let tableCount = 0;
    model.tables = [];
    const tableNameMap = new Map<string, string>(); // name (lowercase) → worksheet name
    model.worksheets.forEach((worksheet: any, index: number) => {
      // Assign fileIndex early so that worksheet-xform.prepare() can use it
      // for comment/VML relationship targets and content type names.
      // This ensures consistency with addWorksheets() which writes ZIP entries
      // using the same fileIndex.
      worksheet.fileIndex = index + 1;

      worksheet.tables.forEach((table: any) => {
        // OOXML requires table names to be unique across the entire workbook
        // (case-insensitive). Detect duplicates early to produce a clear error
        // instead of generating a corrupt file that Excel must repair.
        const nameKey = table.name.toLowerCase();
        const existingSheet = tableNameMap.get(nameKey);
        if (existingSheet !== undefined) {
          throw new TableError(
            `Duplicate table name "${table.name}": already used in worksheet "${existingSheet}". ` +
              `Table names must be unique across the entire workbook (case-insensitive).`
          );
        }
        tableNameMap.set(nameKey, worksheet.name);

        tableCount++;
        table.target = `table${tableCount}.xml`;
        table.id = tableCount;
        model.tables.push(table);
      });

      worksheetXform.prepare(worksheet, worksheetOptions);
      // Register sheets that carry threaded comments so the Content
      // Types override list and the zip emission loop find them.
      if (worksheet.threadedComments && worksheet.threadedComments.length > 0) {
        (model.threadedCommentSheetIds as Array<number | string>).push(worksheet.fileIndex);
      }
    });

    // ContentTypesXform expects this flag
    model.hasCheckboxes = model.styles.hasCheckboxes;

    // Scan all worksheets for dynamic array formulas.
    // cm=1 is assigned later by cell-xform.prepare() during worksheet rendering.
    let dynamicArrayCount = 0;
    model.worksheets.forEach((worksheet: any) => {
      (worksheet.rows ?? []).forEach((row: any) => {
        (row.cells ?? []).forEach((cell: any) => {
          if (cell.isDynamicArray) {
            dynamicArrayCount++;
          }
        });
      });
    });
    model.hasDynamicArrayFormulas = dynamicArrayCount > 0;
    model.dynamicArrayCount = dynamicArrayCount;

    // Propagate header watermark flag from worksheet prepare options
    if (worksheetOptions.hasHeaderWatermark) {
      model.hasHeaderWatermark = true;
    }
  }

  prepareChartExSidecars(model: any): void {
    const structured = (model.chartExStructuredEntries ?? {}) as Record<string, ChartExEntry>;
    for (const [n, entry] of Object.entries(structured)) {
      // Excel 2016+ requires chartEx `<cx:f>` to reference hidden
      // `_xlchart.vN.M` defined names, NOT direct worksheet ranges.
      // Walk the model and rewrite data refs BEFORE workbook.xml is
      // serialised so the newly-registered defined names end up in
      // `<definedNames>`. See `rewriteChartExDataRefsToDefinedNames`
      // for the full rationale.
      const chartExIndex = parseInt(n, 10);
      if (Number.isFinite(chartExIndex) && model.definedNamesInstance) {
        const dn = model.definedNamesInstance;
        rewriteChartExDataRefsToDefinedNames(entry.model, chartExIndex, (name, ref) => {
          definedNamesAddHidden(dn, ref, name);
        });
        // Re-materialise the array snapshot so addWorkbook picks up the
        // new hidden `_xlchart.*` names. `definedNames` in the write
        // model is the serialised form (array); the rewrite added
        // entries to the live defined-names record on the workbook.
        model.definedNames = definedNamesModel(dn);
      }
      if (entry.model.style && !model.chartExStyles?.[n]) {
        model.chartExStyles ??= {};
        model.chartExStyles[n] = new TextEncoder().encode(buildChartStyle(entry.model.style));
      }
      if (entry.model.colors && !model.chartExColors?.[n]) {
        model.chartExColors ??= {};
        model.chartExColors[n] = new TextEncoder().encode(buildChartColors(entry.model.colors));
      }
    }
  }

  prepareChartsheets(model: any): void {
    if (!model.chartsheets || model.chartsheets.length === 0) {
      return;
    }

    const usedDrawingNumbers = new Set<number>();
    for (const drawing of model.drawings ?? []) {
      const match = /^drawing(\d+)$/.exec(drawing.name ?? "");
      if (match) {
        usedDrawingNumbers.add(parseInt(match[1], 10));
      }
    }
    for (const cs of model.chartsheets) {
      const existingMatch = /^drawing(\d+)$/.exec(cs.drawingName ?? "");
      if (existingMatch) {
        usedDrawingNumbers.add(parseInt(existingMatch[1], 10));
      }
    }

    const nextDrawingName = (): string => {
      let n = 1;
      while (usedDrawingNumbers.has(n)) {
        n++;
      }
      usedDrawingNumbers.add(n);
      return `drawing${n}`;
    };

    for (const cs of model.chartsheets) {
      if (!cs.drawingName) {
        cs.drawingName = nextDrawingName();
      }
      if (!cs.drawing) {
        cs.drawing = { rId: "rId1" };
      }
      if (!model.drawings.some((drawing: any) => drawing.name === cs.drawingName)) {
        model.drawings.push({ name: cs.drawingName });
      }
    }

    // Signal the content-types writer that the `Default Extension="vml"`
    // declaration is required when ANY chartsheet carries a VML
    // relationship (e.g. `<legacyDrawing r:id="…"/>` referencing a
    // preserved `xl/drawings/vmlDrawing*.vml` part). Previously the
    // flag was only set inside `addChartsheets`, which runs AFTER
    // `addContentTypes` — so a chartsheet-only VML dependency silently
    // shipped without its content-type declaration, and Excel refused
    // to open the resulting package. Compute it here, during `prepare`,
    // before any part is written.
    model.hasChartsheetVml = model.chartsheets.some(
      (cs: any) =>
        cs.headerImages?.length > 0 ||
        cs.relationships?.some(
          (rel: any) =>
            rel?.Type === RelType.VmlDrawing &&
            typeof rel.Target === "string" &&
            model.vmlDrawings?.[resolveRelTarget("xl/chartsheets/", rel.Target)] !== undefined
        )
    );
  }
}

export { XLSX };
