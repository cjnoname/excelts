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
        default:
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
    return { sheetNo, data: chunks };
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
      yield* this._parseWorksheet(iterator, ws.sheetNo);
    }
  }
}

export { WorkbookReader };
