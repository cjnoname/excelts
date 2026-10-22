/**
 * WorkbookReader - Browser Streaming Workbook Reader
 *
 * This module contains the full shared implementation for the streaming
 * workbook reader and a browser-compatible `WorkbookReader` that buffers
 * waiting worksheets in memory.
 *
 * Node.js uses `workbook-reader.ts`, which extends the same base implementation
 * with filesystem-specific features (filename input + temp-file buffering).
 */

import { FileTooLargeError } from "@archive/core/errors";
import { createParse } from "@archive/unzip/stream";
import type { ZipEntry } from "@archive/unzip/stream";
import { ExcelFileError, ExcelStreamStateError } from "@excel/errors";
import type { Hyperlink } from "@excel/stream/hyperlink-reader";
import { HyperlinkReader } from "@excel/stream/hyperlink-reader";
import { WorksheetReader } from "@excel/stream/worksheet-reader";
import type { WorksheetReaderWorkbook } from "@excel/stream/worksheet-reader";
import { XlsbWorksheetReader } from "@excel/stream/xlsb-worksheet-stream-reader";
import type {
  WorksheetState,
  Font,
  WorkbookProperties,
  RichText,
  CellRichTextValue
} from "@excel/types";
import { iterateStream } from "@excel/utils/iterate-stream";
import type { IterableStreamLike } from "@excel/utils/iterate-stream";
import {
  getWorksheetNoFromWorksheetPath,
  getWorksheetNoFromWorksheetRelsPath,
  normalizeZipPath,
  OOXML_PATHS,
  worksheetRelTarget
} from "@excel/utils/ooxml-paths";

/** The binary package's fixed part paths — the `.bin` counterparts of `OOXML_PATHS`. */
/** A ZIP entry's bytes, joined. Used only for the three small binary parts every sheet depends on. */
async function collectXlsbBytes(entry: AsyncIterable<Uint8Array | string>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of entry as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * The binary package's fixed part paths — the `.bin` counterparts of `OOXML_PATHS`.
 *
 * **Compared case-insensitively, because `normalizeZipPath` does not lower-case.** It only strips a leading slash, so
 * a literal `case` in the switch matches one spelling of `sharedStrings.bin` and misses the other. A first version had
 * this table in lower case and the shared-string part was therefore never parsed: every string cell streamed as the
 * empty string, because the index resolved against an empty table. `xlsbPartKind` is the check the switch uses.
 */
const XLSB_PATHS = {
  workbook: "xl/workbook.bin",
  sharedStrings: "xl/sharedStrings.bin",
  styles: "xl/styles.bin"
} as const;

/** Which of the three prerequisite binary parts `path` is, if any. */
function xlsbPartKind(path: string): "workbook" | "sharedStrings" | "styles" | undefined {
  const lowered = path.toLowerCase();
  for (const [kind, known] of Object.entries(XLSB_PATHS)) {
    if (lowered === known.toLowerCase()) {
      return kind as "workbook" | "sharedStrings" | "styles";
    }
  }
  return undefined;
}

/**
 * A binary worksheet's number, or `undefined` when the path is not one.
 *
 * Separate from `getWorksheetNoFromWorksheetPath` because that one matches `.xml`; sharing it would mean a regex with
 * an alternation that reads as though either extension were equivalent, and they reach different decoders.
 */
function getXlsbWorksheetNo(path: string): number | undefined {
  const match = /^xl\/worksheets\/sheet(\d+)\.bin$/i.exec(path);
  return match === null ? undefined : parseInt(match[1]!, 10);
}
import type { SharedStringValue } from "@excel/utils/shared-strings";
import { WorkbookXform } from "@excel/xlsx/xform/book/workbook-xform";
import { MetadataXform } from "@excel/xlsx/xform/core/metadata-xform";
import { RelationshipsXform } from "@excel/xlsx/xform/core/relationships-xform";
import { parseXformStream } from "@excel/xlsx/xform/parse-xform";
import { StylesXform } from "@excel/xlsx/xform/style/styles-xform";
import { Readable, Transform } from "@stream";
import { EventEmitter } from "@utils/event-emitter";
import { assertLimitOption } from "@utils/limits";
import { decodeOoxmlEscape } from "@utils/utils";
import { SaxParser, saxStream } from "@xml/sax";
import type { SaxTag } from "@xml/types";

// ============================================================================
// Types
// ============================================================================

export interface InternalWorksheetOptions {
  worksheets?: "emit" | "ignore" | "prep";
  sharedStrings?: "cache" | "emit" | "ignore";
  hyperlinks?: "cache" | "emit" | "ignore";
  styles?: "cache" | "ignore";
  entries?: "emit" | "ignore";
}

/**
 * A single shared-string rich-text value. Alias of the canonical
 * `CellRichTextValue` so streaming and in-memory readers agree on one model.
 */
export type SharedStringRichText = CellRichTextValue;

export type { SharedStringValue };

export interface WorkbookRelationship {
  Id: string;
  Target: string;
  Type?: string;
}

export interface SheetMetadata {
  id: number;
  name: string;
  state?: WorksheetState;
  rId: string;
}

export interface WorkbookModel {
  sheets?: SheetMetadata[];
  properties?: Partial<WorkbookProperties>;
  views?: unknown[];
  definedNames?: unknown[];
}

export interface WorkbookPropertiesXform {
  model?: Partial<WorkbookProperties>;
}

export interface EntryPayload {
  type: "shared-strings" | "styles" | "workbook" | "worksheet" | "hyperlinks";
  id?: string;
}

export type ParseEventType = "shared-strings" | "worksheet" | "hyperlinks";

export interface SharedStringEvent {
  eventType: "shared-strings";
  value: { index: number; text: SharedStringValue };
}

export interface WorksheetReadyEvent<TWorksheetReader> {
  eventType: "worksheet";
  value: TWorksheetReader;
}

export interface HyperlinksEvent<THyperlinkReader> {
  eventType: "hyperlinks";
  value: THyperlinkReader;
}

export type ParseEvent<TWorksheetReader, THyperlinkReader> =
  | SharedStringEvent
  | WorksheetReadyEvent<TWorksheetReader>
  | HyperlinksEvent<THyperlinkReader>;

export interface WaitingWorksheetEntry {
  eventType: "waiting-worksheet";
  sheetNo: string;
  entry: ZipEntry;
}

/** What a streaming workbook reader accepts (all platforms). */
export type WorkbookReaderInput = Uint8Array | ArrayBuffer | Readable | ReadableStream<Uint8Array>;

/**
 * Structural view of the optional cross-platform statics/constructor on
 * `Readable`. The Node and browser variants expose slightly different surfaces
 * (browser supports a `{ stream }` constructor option; both expose `from`,
 * Node 18+ exposes `fromWeb`), so we probe them through this loose shape rather
 * than the concrete imported type.
 */
interface ReadableCrossPlatform {
  fromWeb?: (stream: ReadableStream<Uint8Array>) => Readable;
  from(source: Uint8Array[]): Readable;
  new (options: { stream: ReadableStream<Uint8Array> }): Readable;
}

export interface WorkbookReaderOptions {
  worksheets?: "emit" | "ignore";
  sharedStrings?: "cache" | "emit" | "ignore";
  /**
   * What to do with each worksheet's hyperlink relationships.
   *
   * `"ignore"` (the default) skips them. `"cache"` reads them, so a worksheet reader's `hyperlinks` can be resolved
   * through `getHyperlinkTarget`. `"emit"` raises a `hyperlinks` event carrying a `HyperlinkReader`: `read()` reads it
   * after the listeners have run, and iterating the workbook reads it for you. A caller of `parse()` must `read()` it
   * before asking for the next event, as with a worksheet.
   */
  hyperlinks?: "cache" | "emit" | "ignore";
  styles?: "cache" | "ignore";
  entries?: "emit" | "ignore";
  /**
   * Maximum total bytes to buffer for worksheets that arrive before
   * workbook metadata / shared strings are ready.
   * Prevents memory exhaustion from malicious XLSX files with
   * adversarial ZIP entry ordering.
   * @default 256MB (268435456)
   */
  maxBufferedWorksheetBytes?: number;
  /**
   * Largest part, in bytes, the reader holds in memory: the workbook, styles,
   * shared strings, metadata and relationship parts it caches. Worksheets are
   * streamed and not subject to it. A streamed ZIP may not declare sizes up
   * front, so the bytes are counted as they inflate and the read fails with
   * `FileTooLargeError` the moment a part exceeds it — the same per-part
   * bound the buffered reader applies.
   * @default 512 MiB (536870912)
   */
  maxEntrySize?: number;
}

/**
 * `entry`'s bytes, failing with `FileTooLargeError` as soon as more than
 * `limit` arrive — before a hostile part can be held in memory.
 */
function boundedPart(entry: ZipEntry, limit: number): Transform {
  let seen = 0;
  const bounded = new Transform({
    transform(
      chunk: Uint8Array | string,
      _encoding: unknown,
      callback: (err?: Error | null, data?: unknown) => void
    ) {
      seen += chunk.length;
      if (seen > limit) {
        callback(
          new FileTooLargeError(entry.path, `holds more than ${limit} bytes (maxEntrySize)`)
        );
        return;
      }
      callback(null, chunk);
    }
  });
  entry.on("error", (err: Error) => bounded.destroy(err));
  return entry.pipe(bounded);
}

/**
 * A part handed to a reader the caller drives.
 *
 * The caller is done with it when they ask for the next event, and its source is released then: a ZIP entry has to be
 * consumed before the archive can move to the next one, and a spooled sheet's file is deleted. Reading a part only
 * after moving past it never worked — the read stalled — so a reader whose part was released unread says so instead.
 */
export interface HandedOutPart {
  readonly chunks: AsyncIterable<Uint8Array | string>;
  /**
   * Called when the caller asks for the next event. Says what is left: nothing, the whole part (never started), or
   * the rest of it (left early with a `break`).
   */
  finish(): "nothing" | "all" | "rest";
  /** Read and discard whatever is left, through the same iterator the reader used. */
  drain(): Promise<void>;
}

export function handOut(source: AsyncIterable<Uint8Array | string>, what: string): HandedOutPart {
  let state: "unread" | "reading" | "done" | "left" | "skipped" = "unread";
  const iterator = source[Symbol.asyncIterator]();
  async function* chunks(): AsyncGenerator<Uint8Array | string> {
    if (state === "skipped") {
      throw new ExcelStreamStateError(
        `read ${what}`,
        "the workbook reader had already moved past it; read each part before asking for the next"
      );
    }
    state = "reading";
    try {
      // Not `yield* source`: a caller leaving early must not close the underlying iterator, because what it has not
      // read still has to be drained through it — see `drain`.
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        yield next.value;
      }
      state = "done";
    } finally {
      if (state !== "done") {
        state = "left";
      }
    }
  }
  return {
    chunks: chunks(),
    finish() {
      if (state === "unread") {
        state = "skipped";
        return "all";
      }
      return state === "left" ? "rest" : "nothing";
    },
    async drain() {
      while (!(await iterator.next()).done) {
        // discarded
      }
    }
  };
}

/** Let the archive move past a ZIP part the caller did not read to the end. */
async function releasePart(
  entry: ZipEntry,
  part: HandedOutPart,
  viaStream: boolean
): Promise<void> {
  const left = part.finish();
  if (left === "all" && !viaStream) {
    // Untouched: the unzipper can skip its compressed bytes without inflating them, as for any part not asked for.
    entry.autodrain();
  } else if (left !== "nothing") {
    // Partly read, or behind a stream that already holds some of it: read the rest through the reader's own iterator,
    // the path a full read takes, rather than switching the entry to a skip half-way.
    await part.drain();
  }
}

/** Constructor type for WorksheetReader/HyperlinkReader */
export interface ReaderConstructor<TReader, TWorkbook> {
  new (params: {
    workbook: TWorkbook;
    id: number;
    iterator: AsyncIterable<never>;
    options: InternalWorksheetOptions;
  }): TReader;
}

// ============================================================================
// Base Class
// ============================================================================

export abstract class WorkbookReaderBase<
  TInput,
  TWorksheetReader extends EventEmitter & {
    id?: number | string;
    name?: string;
    state?: WorksheetState;
    sheetNo?: number;
  },
  THyperlinkReader extends EventEmitter & {
    hyperlinks?: Record<string, Hyperlink>;
    read?: () => Promise<void>;
  },
  TWaitingWorksheet = unknown
> extends EventEmitter {
  input: TInput;
  options: {
    worksheets: "emit" | "ignore";
    sharedStrings: "cache" | "emit" | "ignore";
    hyperlinks: "cache" | "emit" | "ignore";
    styles: "cache" | "ignore";
    entries: "emit" | "ignore";
  };
  styles: StylesXform;
  stream?: Readable;
  sharedStrings?: SharedStringValue[];
  workbookRels?: WorkbookRelationship[];
  properties?: WorkbookPropertiesXform;
  model?: WorkbookModel;

  /** Whether xl/metadata.xml contains XLDAPR dynamic array metadata */
  hasDynamicArrayMetadata = false;
  /** Precise set of cm values (1-indexed) that map to XLDAPR metadataType */
  dynamicArrayCmIndices?: Set<number>;

  /** Maximum bytes to buffer for worksheets waiting on prerequisites. Default: 256 MB. */
  protected _maxBufferedBytes: number;
  protected _maxEntrySize: number;
  /** Running total of bytes buffered for waiting worksheets. */
  protected _totalBufferedBytes = 0;

  protected _hyperlinkReadersBySheetNo?: Record<string, THyperlinkReader>;

  protected _workbookRelIdByTarget?: Record<string, string>;
  /** The binary workbook part, once read. Its presence is a prerequisite for decoding a binary sheet. */
  protected _xlsbWorkbook?: {
    readonly sheets?: readonly { name: string; state?: string; relId?: string }[];
    readonly date1904?: boolean;
  };
  /** The binary shared-string table. `undefined` means "not seen yet", which is what defers a sheet. */
  protected _xlsbSharedStrings?: readonly string[];
  /** Number formats by style index, from `styles.bin`. */
  protected _xlsbNumberFormats?: readonly (string | undefined)[];
  protected _sheetByRelId?: Record<string, SheetMetadata>;

  getHyperlinkReader(sheetNo: number | string): THyperlinkReader | undefined {
    return this._hyperlinkReadersBySheetNo?.[String(sheetNo)];
  }

  getHyperlink(sheetNo: number | string, rId: string): Hyperlink | undefined {
    return this.getHyperlinkReader(sheetNo)?.hyperlinks?.[rId];
  }

  getHyperlinkTarget(sheetNo: number | string, rId: string): string | undefined {
    return this.getHyperlink(sheetNo, rId)?.target;
  }

  // Reader classes passed by subclass
  protected WorksheetReaderClass: ReaderConstructor<TWorksheetReader, WorksheetReaderWorkbook>;
  protected HyperlinkReaderClass: ReaderConstructor<THyperlinkReader, WorksheetReaderWorkbook>;

  constructor(
    input: TInput,
    options: WorkbookReaderOptions,
    WorksheetReaderClass: ReaderConstructor<TWorksheetReader, WorksheetReaderWorkbook>,
    HyperlinkReaderClass: ReaderConstructor<THyperlinkReader, WorksheetReaderWorkbook>
  ) {
    super();
    this.input = input;
    this.WorksheetReaderClass = WorksheetReaderClass;
    this.HyperlinkReaderClass = HyperlinkReaderClass;
    this._maxBufferedBytes = options.maxBufferedWorksheetBytes ?? 256 * 1024 * 1024;
    assertLimitOption("maxEntrySize", options.maxEntrySize);
    this._maxEntrySize = options.maxEntrySize ?? 512 * 1024 * 1024;

    this.options = {
      worksheets: "emit",
      sharedStrings: "cache",
      hyperlinks: "ignore",
      styles: "ignore",
      entries: "ignore",
      ...options
    };

    this.styles = new StylesXform();
    this.styles.init();
  }

  // Default implementation for the cross-platform input types
  protected _getStream(input: TInput): Readable {
    if (input instanceof Readable) {
      return input;
    }

    // Accept Web ReadableStream (browser fetch() body, Node 18+ fetch(), etc.)
    if (
      input &&
      typeof input === "object" &&
      typeof (input as unknown as ReadableStream<Uint8Array>).getReader === "function"
    ) {
      // Cross-platform feature detection: the imported `Readable` may resolve to
      // either the Node or browser variant, whose static/constructor surfaces
      // differ. Probe the optional members through a structural view.
      const ReadableCtor = Readable as unknown as ReadableCrossPlatform;
      const fromWeb = ReadableCtor.fromWeb;
      if (typeof fromWeb === "function") {
        return fromWeb(input as unknown as ReadableStream<Uint8Array>);
      }

      // Browser wrapper supports `{ stream }` constructor option.
      // Node's Readable does not, so this is best-effort.
      try {
        return new ReadableCtor({
          stream: input as unknown as ReadableStream<Uint8Array>
        });
      } catch {
        throw new ExcelFileError("<ReadableStream>", "read", "Could not recognise input");
      }
    }

    let data: unknown = input;
    if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    }
    if (data instanceof Uint8Array) {
      // Cross-platform: both Node's Readable and our browser Readable implement `.from()`.
      return (Readable as unknown as ReadableCrossPlatform).from([data]);
    }
    throw new ExcelFileError(String(input), "read", "Could not recognise input");
  }

  // Subclass implements storage strategy
  abstract _storeWaitingWorksheet(sheetNo: string, entry: ZipEntry): Promise<TWaitingWorksheet>;
  abstract _processWaitingWorksheets(
    waitingWorksheets: TWaitingWorksheet[]
  ): AsyncIterableIterator<WorksheetReadyEvent<TWorksheetReader>>;

  /** Release every stored worksheet that provides a `cleanup`, and wait until each is gone. */
  protected async _cleanupWaitingWorksheets(waitingWorksheets: TWaitingWorksheet[]): Promise<void> {
    await Promise.all(
      (waitingWorksheets as { cleanup?: () => Promise<void> }[]).map(async ws => {
        await ws?.cleanup?.();
      })
    );
  }

  // Unified implementations using passed-in classes
  private _createWorksheetReader(params: {
    id: number;
    iterator: AsyncIterable<unknown>;
    options: InternalWorksheetOptions;
  }): TWorksheetReader {
    return new this.WorksheetReaderClass({
      workbook: this,
      id: params.id,
      iterator: params.iterator as AsyncIterable<never>,
      options: params.options
    });
  }

  private _createHyperlinkReader(params: {
    id: number;
    iterator: AsyncIterable<unknown>;
    options: InternalWorksheetOptions;
  }): THyperlinkReader {
    return new this.HyperlinkReaderClass({
      workbook: this,
      id: params.id,
      iterator: params.iterator as AsyncIterable<never>,
      options: params.options
    });
  }

  async read(input?: TInput, options?: WorkbookReaderOptions): Promise<void> {
    try {
      for await (const { eventType, value } of this.parse(input, options)) {
        switch (eventType) {
          case "shared-strings":
            this.emit(eventType, value);
            break;
          case "worksheet":
            this.emit(eventType, value);
            await (value as TWorksheetReader & { read(): Promise<void> }).read();
            break;
          case "hyperlinks":
            // Read here as a worksheet is: the archive cannot move past the part until it has been consumed.
            this.emit(eventType, value);
            await (value as THyperlinkReader & { read(): Promise<void> }).read();
            break;
        }
      }
      this.emit("end");
      this.emit("finished");
    } catch (error) {
      this.emit("error", error);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<TWorksheetReader> {
    for await (const { eventType, value } of this.parse()) {
      if (eventType === "worksheet") {
        yield value as TWorksheetReader;
      } else if (eventType === "hyperlinks") {
        // This iterator yields worksheets only, so nothing else can consume the part, and the archive cannot move
        // past it until something does.
        await (value as THyperlinkReader & { read(): Promise<void> }).read();
      }
    }
  }

  async *parse(
    input?: TInput,
    options?: WorkbookReaderOptions
  ): AsyncIterableIterator<ParseEvent<TWorksheetReader, THyperlinkReader>> {
    if (options) {
      this.options = options as typeof this.options;
    }
    const stream = (this.stream = this._getStream(input || this.input));
    const waitingWorksheets: TWaitingWorksheet[] = [];

    try {
      for await (const event of this._parseEntries(stream)) {
        if (event.eventType === "waiting-worksheet") {
          const stored = await this._storeWaitingWorksheet(event.sheetNo, event.entry);
          waitingWorksheets.push(stored);
        } else {
          yield event as ParseEvent<TWorksheetReader, THyperlinkReader>;
        }
      }
      yield* this._processWaitingWorksheets(waitingWorksheets);
    } finally {
      // On every way out — the end, an error, or a consumer leaving early,
      // which returns the generator and runs no `catch` — so a sheet stored
      // but never replayed does not leave its spool behind.
      await this._cleanupWaitingWorksheets(waitingWorksheets);
    }
  }

  private _emitEntry(payload: EntryPayload): void {
    if (this.options.entries === "emit") {
      this.emit("entry", payload);
    }
  }

  private async _parseRels(entry: IterableStreamLike<Uint8Array | string>): Promise<void> {
    const xform = new RelationshipsXform();
    this.workbookRels = await parseXformStream(xform, iterateStream(entry));

    // Build fast lookup for worksheet relationship ids.
    this._workbookRelIdByTarget = Object.create(null) as Record<string, string>;
    for (const rel of this.workbookRels ?? []) {
      if (rel?.Target && rel?.Id) {
        this._workbookRelIdByTarget[rel.Target] = rel.Id;
      }
    }
  }

  private async _parseWorkbook(entry: IterableStreamLike<Uint8Array | string>): Promise<void> {
    this._emitEntry({ type: "workbook" });
    const workbook = new WorkbookXform();
    this.model = await parseXformStream(workbook, iterateStream(entry));
    this.properties = workbook.map?.workbookPr as WorkbookPropertiesXform;

    // Build fast lookup for sheet metadata by relationship id.
    this._sheetByRelId = Object.create(null) as Record<string, SheetMetadata>;
    for (const sheet of this.model?.sheets ?? []) {
      this._sheetByRelId[sheet.rId] = sheet;
    }
  }

  private async *_parseSharedStrings(
    entry: IterableStreamLike<Uint8Array | string>
  ): AsyncIterableIterator<{ index: number; text: SharedStringValue }> {
    this._emitEntry({ type: "shared-strings" });
    switch (this.options.sharedStrings) {
      case "cache":
        this.sharedStrings = [];
        break;
      case "emit":
        break;
      default:
        return;
    }

    let text: string | null = null;
    let richText: RichText[] = [];
    let index = 0;
    let font: Partial<Font> | null = null;
    let inRichText = false;

    // For "cache" mode, use direct SAX callbacks (no event objects, no async generator overhead)
    if (this.options.sharedStrings === "cache") {
      const sharedStrings = this.sharedStrings!;
      const parser = new SaxParser({ position: false, invalidCharHandling: "skip" });

      parser.on("opentag", (node: SaxTag) => {
        switch (node.name) {
          case "b":
            font = font || {};
            font.bold = true;
            break;
          case "charset":
            font = font || {};
            font.charset = parseInt(node.attributes.charset, 10);
            break;
          case "color":
            font = font || {};
            font.color = {};
            if (node.attributes.rgb) {
              font.color.argb = node.attributes.rgb;
            }
            if (node.attributes.val) {
              font.color.argb = node.attributes.val;
            }
            if (node.attributes.theme) {
              font.color.theme = parseInt(node.attributes.theme, 10);
            }
            break;
          case "family":
            font = font || {};
            font.family = parseInt(node.attributes.val, 10);
            break;
          case "i":
            font = font || {};
            font.italic = true;
            break;
          case "outline":
            font = font || {};
            font.outline = true;
            break;
          case "rFont":
            font = font || {};
            font.name = node.attributes.val;
            break;
          case "r":
            inRichText = true;
            break;
          case "si":
            font = null;
            richText = [];
            text = null;
            inRichText = false;
            break;
          case "sz":
            font = font || {};
            font.size = parseInt(node.attributes.val, 10);
            break;
          case "strike":
            font = font || {};
            font.strike = true;
            break;
          case "t":
            text = null;
            break;
          case "u":
            font = font || {};
            font.underline = true;
            break;
          case "vertAlign":
            font = font || {};
            font.vertAlign = node.attributes.val as "superscript" | "subscript";
            break;
        }
      });

      parser.on("text", (value: string) => {
        text = text ? text + value : value;
      });

      parser.on("closetag", (tag: SaxTag) => {
        switch (tag.name) {
          case "t":
            if (text != null && text.includes("_x")) {
              text = decodeOoxmlEscape(text);
            }
            break;
          case "r":
            if (inRichText) {
              richText.push(font ? { text: text ?? "", font } : { text: text ?? "" });
              font = null;
              text = null;
            }
            break;
          case "si":
            sharedStrings.push(richText.length ? { richText } : (text ?? ""));
            richText = [];
            font = null;
            text = null;
            inRichText = false;
            break;
        }
      });

      await saxStream(parser, iterateStream(entry));
      return;
    }

    // "emit" mode — must yield, so use direct SAX with per-chunk yield
    const emitParser = new SaxParser({ invalidCharHandling: "skip" });
    const emitDecoder = new TextDecoder("utf-8", { fatal: true });
    let pendingEmits: Array<{ index: number; text: SharedStringValue }> = [];

    emitParser.on("opentag", (node: SaxTag) => {
      switch (node.name) {
        case "b":
          font = font || {};
          font.bold = true;
          break;
        case "charset":
          font = font || {};
          font.charset = parseInt(node.attributes.charset, 10);
          break;
        case "color":
          font = font || {};
          font.color = {};
          if (node.attributes.rgb) {
            font.color.argb = node.attributes.rgb;
          }
          if (node.attributes.val) {
            font.color.argb = node.attributes.val;
          }
          if (node.attributes.theme) {
            font.color.theme = parseInt(node.attributes.theme, 10);
          }
          break;
        case "family":
          font = font || {};
          font.family = parseInt(node.attributes.val, 10);
          break;
        case "i":
          font = font || {};
          font.italic = true;
          break;
        case "outline":
          font = font || {};
          font.outline = true;
          break;
        case "rFont":
          font = font || {};
          font.name = node.attributes.val;
          break;
        case "r":
          inRichText = true;
          break;
        case "si":
          font = null;
          richText = [];
          text = null;
          inRichText = false;
          break;
        case "sz":
          font = font || {};
          font.size = parseInt(node.attributes.val, 10);
          break;
        case "strike":
          font = font || {};
          font.strike = true;
          break;
        case "t":
          text = null;
          break;
        case "u":
          font = font || {};
          font.underline = true;
          break;
        case "vertAlign":
          font = font || {};
          font.vertAlign = node.attributes.val as "superscript" | "subscript";
          break;
      }
    });

    emitParser.on("text", (value: string) => {
      text = text ? text + value : value;
    });

    emitParser.on("closetag", (tag: SaxTag) => {
      switch (tag.name) {
        case "t":
          if (text != null && text.includes("_x")) {
            text = decodeOoxmlEscape(text);
          }
          break;
        case "r":
          if (inRichText) {
            richText.push(font ? { text: text ?? "", font } : { text: text ?? "" });
            font = null;
            text = null;
          }
          break;
        case "si":
          pendingEmits.push({
            index: index++,
            text: richText.length ? { richText } : (text ?? "")
          });
          richText = [];
          font = null;
          text = null;
          inRichText = false;
          break;
      }
    });

    for await (const chunk of iterateStream(entry)) {
      const chunkStr =
        typeof chunk === "string"
          ? chunk
          : emitDecoder.decode(chunk as Uint8Array, { stream: true });
      emitParser.write(chunkStr);
      if (pendingEmits.length > 0) {
        for (const item of pendingEmits) {
          yield item;
        }
        pendingEmits = [];
      }
    }

    // Flush trailing bytes (catches truncated UTF-8)
    const emitTrailing = emitDecoder.decode();
    if (emitTrailing) {
      emitParser.write(emitTrailing);
    }

    emitParser.close();
    if (pendingEmits.length > 0) {
      for (const item of pendingEmits) {
        yield item;
      }
    }
  }

  private async _parseStyles(entry: IterableStreamLike<Uint8Array | string>): Promise<void> {
    this._emitEntry({ type: "styles" });
    if (this.options.styles === "cache") {
      this.styles = new StylesXform();
      await parseXformStream(this.styles, iterateStream(entry));
    }
  }

  private async _parseMetadata(entry: IterableStreamLike<Uint8Array | string>): Promise<void> {
    const xform = new MetadataXform();
    const result = await parseXformStream(xform, iterateStream(entry));
    if (result) {
      this.hasDynamicArrayMetadata = !!result.hasDynamicArrays;
      this.dynamicArrayCmIndices = result.dynamicArrayCmIndices;
    }
  }

  /**
   * The binary workbook part: sheet names, ids, states and `date1904`.
   *
   * Read whole rather than streamed, and that is not a compromise — `workbook.bin` is the package's table of contents.
   * It is kilobytes for a workbook of any size, and every sheet after it needs all of it.
   */
  protected async _parseXlsbWorkbook(
    entry: IterableStreamLike<Uint8Array | string>
  ): Promise<void> {
    this._emitEntry({ type: "workbook" });
    const { readWorkbookPart } = await import("@excel/xlsb/read/parts");
    this._xlsbWorkbook = readWorkbookPart(
      await collectXlsbBytes(iterateStream(entry)),
      XLSB_PATHS.workbook
    ) as never;
  }

  /**
   * The shared-string table.
   *
   * Held in full, because a `BrtCellIsst` is an index into it and a cell cannot be resolved without the entry it
   * names. This is the one thing a streamed binary read is not bounded by, and it is bounded by *distinct strings*
   * rather than by cells — the same position the XML streaming reader is in.
   */
  protected async _parseXlsbSharedStrings(
    entry: IterableStreamLike<Uint8Array | string>
  ): Promise<void> {
    const { readSharedStrings } = await import("@excel/xlsb/read/parts");
    this._xlsbSharedStrings = readSharedStrings(
      await collectXlsbBytes(iterateStream(entry)),
      XLSB_PATHS.sharedStrings
    ).texts;
  }

  /** The style table, for the number formats that turn a serial into a date. */
  protected async _parseXlsbStyles(entry: IterableStreamLike<Uint8Array | string>): Promise<void> {
    // Load-bearing, despite rolldown reporting `INEFFECTIVE_DYNAMIC_IMPORT`: the streaming *writer*
    // imports this module statically (its `StreamedXlsbWorksheet` is built in a synchronous
    // constructor, so it has no choice), which is why the module cannot move into a chunk of its
    // own. It is still absent from a reader-only bundle — measured on
    // `console.log(Stream.WorkbookReader)` — and that is the consumer this protects.
    const { readStyles } = await import("@excel/xlsb/styles");
    const table = readStyles(await collectXlsbBytes(iterateStream(entry)), XLSB_PATHS.styles);
    this._xlsbNumberFormats = (
      table as unknown as { numberFormats?: readonly (string | undefined)[] }
    ).numberFormats;
  }

  /**
   * A binary worksheet, as row events.
   *
   * Mirrors `_parseWorksheet` deliberately closely — the same emit, the same `sheetNo` preservation, the same event
   * shape — because a caller must not be able to tell which branch produced the reader it is handed.
   */
  protected *_parseXlsbWorksheet(
    iterator: AsyncIterable<unknown>,
    sheetNo: string
  ): IterableIterator<WorksheetReadyEvent<TWorksheetReader>> {
    this._emitEntry({ type: "worksheet", id: sheetNo });
    const sheetNoNumber = parseInt(sheetNo, 10);
    const reader = new XlsbWorksheetReader({
      workbook: this as never,
      id: sheetNoNumber,
      iterator: iterator as AsyncIterable<never>,
      options: this.options as InternalWorksheetOptions
    });
    reader.xlsbContext = {
      sharedStrings: this._xlsbSharedStrings ?? [],
      ...(this._xlsbNumberFormats === undefined ? {} : { numberFormats: this._xlsbNumberFormats }),
      ...(this._xlsbWorkbook?.date1904 === undefined
        ? {}
        : { date1904: this._xlsbWorkbook.date1904 }),
      part: `xl/worksheets/sheet${sheetNo}.bin`
    };
    (reader as { sheetNo?: number }).sheetNo = sheetNoNumber;
    // **By relationship, not by position.** `sheets[n - 1]` looks right and is wrong: a package numbers its worksheet
    // parts independently of the bundle, so a workbook with a chartsheet among its sheets has a hole in the worksheet
    // numbering and every sheet after it takes the previous one's name. The buffered reader carries the same warning
    // for the same file — `any_sheets.xlsb` is where it was found.
    const relId = this._workbookRelIdByTarget?.[`worksheets/sheet${sheetNo}.bin`];
    const declared =
      relId === undefined
        ? undefined
        : this._xlsbWorkbook?.sheets?.find(sheet => sheet.relId === relId);
    if (declared !== undefined) {
      reader.name = declared.name;
      if (declared.state !== undefined) {
        reader.state = declared.state as never;
      }
    }
    yield { eventType: "worksheet", value: reader as unknown as TWorksheetReader };
  }

  protected *_parseWorksheet(
    iterator: AsyncIterable<unknown>,
    sheetNo: string
  ): IterableIterator<WorksheetReadyEvent<TWorksheetReader>> {
    this._emitEntry({ type: "worksheet", id: sheetNo });
    const sheetNoNumber = parseInt(sheetNo, 10);
    const worksheetReader = this._createWorksheetReader({
      id: sheetNoNumber,
      iterator,
      options: this.options as InternalWorksheetOptions
    });

    // Preserve original sheet index from the zip path. `worksheetReader.id` may be remapped
    // later using workbook metadata.
    (worksheetReader as { sheetNo?: number }).sheetNo = sheetNoNumber;

    const relId = this._workbookRelIdByTarget?.[worksheetRelTarget(sheetNo)];
    const matchingSheet = relId ? this._sheetByRelId?.[relId] : undefined;
    if (matchingSheet) {
      worksheetReader.id = matchingSheet.id;
      worksheetReader.name = matchingSheet.name;
      worksheetReader.state = matchingSheet.state;
    }
    if (this.options.worksheets === "emit") {
      yield { eventType: "worksheet", value: worksheetReader };
    }
  }

  protected async *_parseHyperlinks(
    iterator: AsyncIterable<unknown>,
    sheetNo: string
  ): AsyncIterableIterator<HyperlinksEvent<THyperlinkReader>> {
    this._emitEntry({ type: "hyperlinks", id: sheetNo });
    const hyperlinksReader = this._createHyperlinkReader({
      id: parseInt(sheetNo, 10),
      iterator,
      options: this.options as InternalWorksheetOptions
    });

    if (this.options.hyperlinks === "cache") {
      if (!this._hyperlinkReadersBySheetNo) {
        this._hyperlinkReadersBySheetNo = Object.create(null) as Record<string, THyperlinkReader>;
      }
      this._hyperlinkReadersBySheetNo[sheetNo] = hyperlinksReader;

      const readFn = hyperlinksReader.read;
      if (typeof readFn === "function") {
        await readFn.call(hyperlinksReader);
      }
      return;
    }

    if (this.options.hyperlinks === "emit") {
      yield { eventType: "hyperlinks", value: hyperlinksReader };
    }
  }

  protected async *_parseEntries(
    stream: Readable
  ): AsyncIterableIterator<ParseEvent<TWorksheetReader, THyperlinkReader> | WaitingWorksheetEntry> {
    const zip = createParse({ forceStream: true });
    // Bidirectional error propagation, guarded against re-entry: each side
    // marks itself "settled" before forwarding so the partner's destroy/emit
    // doesn't bounce the error back into an infinite loop.
    let propagating = false;
    stream.on("error", (err: Error) => {
      if (propagating) {
        return;
      }
      propagating = true;
      zip.emit("error", err);
    });
    zip.on("error", (err: Error) => {
      if (propagating) {
        return;
      }
      propagating = true;
      try {
        if (typeof stream.destroy === "function") {
          stream.destroy(err);
        }
      } catch {
        // Best-effort cleanup; original error already on `zip`.
      }
    });
    stream.pipe(zip);

    const emitWorksheets = this.options.worksheets === "emit";
    for await (const entry of iterateStream(zip)) {
      let sheetNo;
      const normalizedPath = normalizeZipPath(entry.path);

      switch (normalizedPath) {
        case OOXML_PATHS.rootRels:
          break;
        case OOXML_PATHS.xlWorkbookRels:
          await this._parseRels(boundedPart(entry, this._maxEntrySize));
          break;
        case OOXML_PATHS.xlWorkbook:
          await this._parseWorkbook(boundedPart(entry, this._maxEntrySize));
          break;
        case OOXML_PATHS.xlSharedStrings:
          for await (const item of this._parseSharedStrings(
            boundedPart(entry, this._maxEntrySize)
          )) {
            yield { eventType: "shared-strings", value: item };
          }
          break;
        case OOXML_PATHS.xlStyles:
          await this._parseStyles(boundedPart(entry, this._maxEntrySize));
          break;
        case OOXML_PATHS.xlMetadata:
          await this._parseMetadata(boundedPart(entry, this._maxEntrySize));
          break;
        // **The binary package's three prerequisite parts.**
        //
        // Handled beside their XML counterparts rather than in a separate reader, because the thing that differs is
        // how a part is decoded and not how the package is walked: the ZIP iteration, the relationship resolution and
        // the `waiting-worksheet` spooling that copes with shared strings arriving *after* a sheet are all the same
        // problem in both containers, and were already solved here for one of them.
        default:
          if (normalizedPath.toLowerCase() === "xl/_rels/workbook.bin.rels") {
            await this._parseRels(boundedPart(entry, this._maxEntrySize));
            continue;
          }

          switch (xlsbPartKind(normalizedPath)) {
            case "workbook":
              await this._parseXlsbWorkbook(boundedPart(entry, this._maxEntrySize));
              continue;
            case "sharedStrings":
              await this._parseXlsbSharedStrings(boundedPart(entry, this._maxEntrySize));
              continue;
            case "styles":
              await this._parseXlsbStyles(boundedPart(entry, this._maxEntrySize));
              continue;
            default:
              break;
          }

          // A part the caller has not asked for is not opened at all: it falls through to `autodrain`. One that is handed
          // out is drained once the caller moves past it — see `handOut`.
          sheetNo = emitWorksheets ? getXlsbWorksheetNo(normalizedPath)?.toString() : undefined;
          if (sheetNo) {
            // The same prerequisite test the XML branch makes, for the same reason: a cell record holds an index into
            // the shared-string table rather than a string, so a sheet that arrives first has to be spooled and come
            // back later. `_storeWaitingWorksheet` is shared.
            if (this._xlsbSharedStrings !== undefined && !!this._xlsbWorkbook) {
              const part = handOut(iterateStream(entry), `worksheet ${sheetNo}`);
              yield* this._parseXlsbWorksheet(part.chunks, sheetNo);
              await releasePart(entry, part, false);
              continue;
            }
            yield { eventType: "waiting-worksheet", sheetNo, entry };
            continue;
          }

          sheetNo = emitWorksheets
            ? getWorksheetNoFromWorksheetPath(normalizedPath)?.toString()
            : undefined;
          if (sheetNo) {
            // Performance: only wait for sharedStrings when they are actually needed.
            // Also require workbook.xml to be parsed so worksheet name, id, and state
            // can be resolved from workbook metadata before the worksheet event fires.
            const hasPrerequisites =
              !!this.workbookRels &&
              !!this.model &&
              (this.options.sharedStrings !== "cache" || !!this.sharedStrings);
            if (hasPrerequisites) {
              const part = handOut(iterateStream(entry), `worksheet ${sheetNo}`);
              yield* this._parseWorksheet(part.chunks, sheetNo);
              await releasePart(entry, part, false);
              continue;
            } else {
              yield { eventType: "waiting-worksheet", sheetNo, entry };
              continue;
            }
          }

          sheetNo = getWorksheetNoFromWorksheetRelsPath(normalizedPath)?.toString();
          if (
            sheetNo &&
            (this.options.hyperlinks === "cache" || this.options.hyperlinks === "emit")
          ) {
            const source = boundedPart(entry, this._maxEntrySize);
            const part = handOut(iterateStream(source), `the hyperlinks of sheet ${sheetNo}`);
            yield* this._parseHyperlinks(part.chunks, sheetNo);
            await releasePart(entry, part, true);
            continue;
          }
          break;
      }
      entry.autodrain();
    }
  }
}

export const WorkbookReaderOptionsSchema = {
  worksheets: ["emit", "ignore"],
  sharedStrings: ["cache", "emit", "ignore"],
  hyperlinks: ["cache", "emit", "ignore"],
  styles: ["cache", "ignore"],
  entries: ["emit", "ignore"]
} as const;

// ============================================================================
// Browser-compatible WorkbookReader (buffers waiting worksheets in memory)
// ============================================================================

interface WaitingWorksheet {
  sheetNo: string;
  data: Uint8Array[];
  /**
   * Whether the spooled bytes are BIFF12 rather than XML.
   *
   * **The Node variant recorded this and the browser one did not.** A worksheet is spooled when the ZIP delivers it
   * before the workbook or shared strings it depends on, and the browser's replay called `_parseWorksheet`
   * unconditionally — so a legally-ordered XLSB whose sheet comes first had its BIFF12 records handed to an XML parser.
   * The Node path dispatches on exactly this field, which is why the two behaved differently on the same file.
   */
  isXlsb: boolean;
}

class WorkbookReader extends WorkbookReaderBase<
  WorkbookReaderInput,
  WorksheetReader,
  HyperlinkReader,
  WaitingWorksheet
> {
  constructor(input: WorkbookReaderInput, options: WorkbookReaderOptions = {}) {
    super(input, options, WorksheetReader, HyperlinkReader);
  }

  async _storeWaitingWorksheet(sheetNo: string, entry: ZipEntry): Promise<WaitingWorksheet> {
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();
    for await (const chunk of iterateStream(entry)) {
      let bytes: Uint8Array;
      if (chunk instanceof Uint8Array) {
        bytes = chunk;
      } else if (typeof chunk === "string") {
        bytes = encoder.encode(chunk);
      } else {
        continue;
      }
      this._totalBufferedBytes += bytes.length;
      if (this._totalBufferedBytes > this._maxBufferedBytes) {
        throw new ExcelFileError(
          "<ReadableStream>",
          "read",
          `Buffered worksheet data exceeds limit of ${this._maxBufferedBytes} bytes. ` +
            "The XLSX file may be malicious (adversarial ZIP entry ordering) or too large " +
            "for streaming. Increase maxBufferedWorksheetBytes if this is expected."
        );
      }
      chunks.push(bytes);
    }
    // `.bin` is the container's own marker, and it is the same test the Node variant applies.
    return { sheetNo, data: chunks, isXlsb: /\.bin$/i.test(entry.path) };
  }

  async *_processWaitingWorksheets(
    waitingWorksheets: WaitingWorksheet[]
  ): AsyncIterableIterator<WorksheetReadyEvent<WorksheetReader>> {
    for (const ws of waitingWorksheets) {
      const part = handOut(
        (async function* () {
          yield* ws.data;
        })(),
        `worksheet ${ws.sheetNo}`
      );
      yield* ws.isXlsb
        ? this._parseXlsbWorksheet(part.chunks, ws.sheetNo)
        : this._parseWorksheet(part.chunks, ws.sheetNo);
      // Released as the Node variant's spool file is, so a sheet read out of order fails the same way on both.
      part.finish();
      ws.data.length = 0;
    }
  }
}

export { WorkbookReader };
