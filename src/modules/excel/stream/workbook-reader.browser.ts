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

import { createParse } from "@archive/unzip/stream";
import type { ZipEntry } from "@archive/unzip/stream";
import { ExcelFileError } from "@excel/errors";
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
import { StylesXform } from "@excel/xlsx/xform/style/styles-xform";
import { Readable } from "@stream";
import { EventEmitter } from "@utils/event-emitter";
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

  protected _cleanupWaitingWorksheets(_waitingWorksheets: TWaitingWorksheet[]): void {
    // Default: attempt best-effort cleanup if the stored object provides it.
    for (const ws of _waitingWorksheets as { cleanup?: () => void }[]) {
      if (ws && typeof ws.cleanup === "function") {
        ws.cleanup();
      }
    }
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
            this.emit(eventType, value);
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
    } catch (error) {
      this._cleanupWaitingWorksheets(waitingWorksheets);
      throw error;
    }
  }

  private _emitEntry(payload: EntryPayload): void {
    if (this.options.entries === "emit") {
      this.emit("entry", payload);
    }
  }

  private async _parseRels(entry: IterableStreamLike<Uint8Array | string>): Promise<void> {
    const xform = new RelationshipsXform();
    this.workbookRels = await xform.parseStream(iterateStream(entry));

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
    this.model = await workbook.parseStream(iterateStream(entry));
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
      await this.styles.parseStream(iterateStream(entry));
    }
  }

  private async _parseMetadata(entry: IterableStreamLike<Uint8Array | string>): Promise<void> {
    const xform = new MetadataXform();
    const result = await xform.parseStream(iterateStream(entry));
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

    for await (const entry of iterateStream(zip)) {
      let sheetNo;
      const normalizedPath = normalizeZipPath(entry.path);

      switch (normalizedPath) {
        case OOXML_PATHS.rootRels:
          break;
        case OOXML_PATHS.xlWorkbookRels:
          await this._parseRels(entry);
          break;
        case OOXML_PATHS.xlWorkbook:
          await this._parseWorkbook(entry);
          break;
        case OOXML_PATHS.xlSharedStrings:
          for await (const item of this._parseSharedStrings(entry)) {
            yield { eventType: "shared-strings", value: item };
          }
          break;
        case OOXML_PATHS.xlStyles:
          await this._parseStyles(entry);
          break;
        case OOXML_PATHS.xlMetadata:
          await this._parseMetadata(entry);
          break;
        // **The binary package's three prerequisite parts.**
        //
        // Handled beside their XML counterparts rather than in a separate reader, because the thing that differs is
        // how a part is decoded and not how the package is walked: the ZIP iteration, the relationship resolution and
        // the `waiting-worksheet` spooling that copes with shared strings arriving *after* a sheet are all the same
        // problem in both containers, and were already solved here for one of them.
        default:
          if (normalizedPath.toLowerCase() === "xl/_rels/workbook.bin.rels") {
            await this._parseRels(entry);
            continue;
          }

          switch (xlsbPartKind(normalizedPath)) {
            case "workbook":
              await this._parseXlsbWorkbook(entry);
              continue;
            case "sharedStrings":
              await this._parseXlsbSharedStrings(entry);
              continue;
            case "styles":
              await this._parseXlsbStyles(entry);
              continue;
            default:
              break;
          }

          sheetNo = getXlsbWorksheetNo(normalizedPath)?.toString();
          if (sheetNo) {
            // The same prerequisite test the XML branch makes, for the same reason: a cell record holds an index into
            // the shared-string table rather than a string, so a sheet that arrives first has to be spooled and come
            // back later. `_storeWaitingWorksheet` is shared.
            if (this._xlsbSharedStrings !== undefined && !!this._xlsbWorkbook) {
              yield* this._parseXlsbWorksheet(iterateStream(entry), sheetNo);
              continue;
            }
            yield { eventType: "waiting-worksheet", sheetNo, entry };
            continue;
          }

          sheetNo = getWorksheetNoFromWorksheetPath(normalizedPath)?.toString();
          if (sheetNo) {
            // Performance: only wait for sharedStrings when they are actually needed.
            // Also require workbook.xml to be parsed so worksheet name, id, and state
            // can be resolved from workbook metadata before the worksheet event fires.
            const hasPrerequisites =
              !!this.workbookRels &&
              !!this.model &&
              (this.options.sharedStrings !== "cache" || !!this.sharedStrings);
            if (hasPrerequisites) {
              yield* this._parseWorksheet(iterateStream(entry), sheetNo);
              continue;
            } else {
              yield { eventType: "waiting-worksheet", sheetNo, entry };
              continue;
            }
          }

          sheetNo = getWorksheetNoFromWorksheetRelsPath(normalizedPath)?.toString();
          if (sheetNo) {
            yield* this._parseHyperlinks(iterateStream(entry), sheetNo);
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
      const iterator = (async function* () {
        for (const chunk of ws.data) {
          yield chunk;
        }
      })();
      yield* ws.isXlsb
        ? this._parseXlsbWorksheet(iterator, ws.sheetNo)
        : this._parseWorksheet(iterator, ws.sheetNo);
    }
  }
}

export { WorkbookReader };
