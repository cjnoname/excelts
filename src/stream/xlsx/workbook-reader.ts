import fs from "fs";
import { EventEmitter } from "events";
import { PassThrough, Readable } from "stream";
import os from "os";
import { join } from "path";
import { Parse } from "unzipper";
import { iterateStream } from "../../utils/iterate-stream.js";
import { parseSax } from "../../utils/parse-sax.js";
import { StylesXform } from "../../xlsx/xform/style/styles-xform.js";
import { WorkbookXform } from "../../xlsx/xform/book/workbook-xform.js";
import { RelationshipsXform } from "../../xlsx/xform/core/relationships-xform.js";
import { WorksheetReader } from "./worksheet-reader.js";
import { HyperlinkReader } from "./hyperlink-reader.js";

interface WorkbookReaderOptions {
  worksheets?: string;
  sharedStrings?: string;
  hyperlinks?: string;
  styles?: string;
  entries?: string;
}

interface WaitingWorksheet {
  sheetNo: string;
  path: string;
  tempFileCleanupCallback: () => void;
  writePromise: Promise<void>;
}

class WorkbookReader extends EventEmitter {
  input: any;
  options: WorkbookReaderOptions;
  styles: any;
  stream?: any;
  sharedStrings?: any[];
  workbookRels?: any[];
  properties?: any;
  model?: any;

  constructor(input: any, options: WorkbookReaderOptions = {}) {
    super();

    this.input = input;

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

  _getStream(input: any): any {
    if (input instanceof Readable) {
      return input;
    }
    if (typeof input === "string") {
      return fs.createReadStream(input);
    }
    throw new Error(`Could not recognise input: ${input}`);
  }

  async read(input?: any, options?: WorkbookReaderOptions): Promise<void> {
    try {
      for await (const { eventType, value } of this.parse(input, options)) {
        switch (eventType) {
          case "shared-strings":
            this.emit(eventType, value);
            break;
          case "worksheet":
            this.emit(eventType, value);
            await value.read();
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

  async *[Symbol.asyncIterator](): AsyncIterableIterator<any> {
    for await (const { eventType, value } of this.parse()) {
      if (eventType === "worksheet") {
        yield value;
      }
    }
  }

  async *parse(
    input?: any,
    options?: WorkbookReaderOptions
  ): AsyncIterableIterator<{ eventType: string; value: any }> {
    if (options) {
      this.options = options;
    }
    const stream = (this.stream = this._getStream(input || this.input));
    const zip = Parse({ forceStream: true });

    // Handle pipe errors to prevent unhandled rejection
    stream.on("error", (err: Error) => {
      zip.emit("error", err);
    });
    stream.pipe(zip);

    // worksheets, deferred for parsing after shared strings reading
    const waitingWorkSheets: WaitingWorksheet[] = [];

    try {
      for await (const entry of iterateStream(zip)) {
        let match;
        let sheetNo;
        // Normalize path: remove leading slash if present
        const normalizedPath = entry.path.startsWith("/") ? entry.path.slice(1) : entry.path;
        switch (normalizedPath) {
          case "_rels/.rels":
            break;
          case "xl/_rels/workbook.xml.rels":
            await this._parseRels(entry);
            break;
          case "xl/workbook.xml":
            await this._parseWorkbook(entry);
            break;
          case "xl/sharedStrings.xml":
            for await (const item of this._parseSharedStrings(entry)) {
              yield { eventType: "shared-strings", value: item };
            }
            break;
          case "xl/styles.xml":
            await this._parseStyles(entry);
            break;
          default:
            if (normalizedPath.match(/xl\/worksheets\/sheet\d+[.]xml/)) {
              match = normalizedPath.match(/xl\/worksheets\/sheet(\d+)[.]xml/);
              sheetNo = match![1];
              if (this.sharedStrings && this.workbookRels) {
                yield* this._parseWorksheet(iterateStream(entry), sheetNo);
              } else {
                // Worksheet arrives before sharedStrings - write to temp file asynchronously
                const tmpDir = fs.mkdtempSync(join(os.tmpdir(), "excelts-"));
                const path = join(tmpDir, `sheet${sheetNo}.xml`);
                const tempFileCleanupCallback = () => {
                  fs.rm(tmpDir, { recursive: true, force: true }, () => {});
                };

                const writePromise = new Promise<void>((resolve, reject) => {
                  const tempStream = fs.createWriteStream(path);
                  tempStream.on("error", reject);
                  tempStream.on("finish", resolve);
                  entry.pipe(tempStream);
                });

                waitingWorkSheets.push({ sheetNo, path, tempFileCleanupCallback, writePromise });
                continue; // Skip autodrain for piped entries
              }
            } else if (normalizedPath.match(/xl\/worksheets\/_rels\/sheet\d+[.]xml.rels/)) {
              match = normalizedPath.match(/xl\/worksheets\/_rels\/sheet(\d+)[.]xml.rels/);
              sheetNo = match![1];
              yield* this._parseHyperlinks(iterateStream(entry), sheetNo);
            }
            break;
        }
        entry.autodrain();
      }

      for (const worksheet of waitingWorkSheets) {
        await worksheet.writePromise;
        let fileStream: any = fs.createReadStream(worksheet.path);
        try {
          // TODO: Remove once node v8 is deprecated
          // Detect and upgrade old fileStreams
          if (!fileStream[Symbol.asyncIterator]) {
            fileStream = fileStream.pipe(new PassThrough());
          }
          yield* this._parseWorksheet(fileStream, worksheet.sheetNo);
        } finally {
          // Ensure stream is closed before cleanup
          if (fileStream.close) {
            fileStream.close();
          }
          worksheet.tempFileCleanupCallback();
        }
      }
    } catch (error) {
      // Clean up any remaining temp files on error
      for (const { tempFileCleanupCallback } of waitingWorkSheets) {
        tempFileCleanupCallback();
      }
      throw error;
    }
  }

  _emitEntry(payload: any): void {
    if (this.options.entries === "emit") {
      this.emit("entry", payload);
    }
  }

  async _parseRels(entry: any): Promise<void> {
    const xform = new RelationshipsXform();
    this.workbookRels = await xform.parseStream(iterateStream(entry));
  }

  async _parseWorkbook(entry: any): Promise<void> {
    this._emitEntry({ type: "workbook" });

    const workbook = new WorkbookXform();
    this.model = await workbook.parseStream(iterateStream(entry));

    this.properties = workbook.map.workbookPr;
  }

  async *_parseSharedStrings(entry: any): AsyncIterableIterator<{ index: number; text: any }> {
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
    let richText: any[] = [];
    let index = 0;
    let font: any = null;
    let inRichText = false;
    for await (const events of parseSax(iterateStream(entry))) {
      for (const { eventType, value } of events) {
        if (eventType === "opentag") {
          const node = value;
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
                font.color.theme = node.attributes.theme;
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
              font.vertAlign = node.attributes.val;
              break;
          }
        } else if (eventType === "text") {
          text = text ? text + value : value;
        } else if (eventType === "closetag") {
          const node = value;
          switch (node.name) {
            case "r":
              if (inRichText) {
                richText.push({
                  font,
                  text
                });
                font = null;
                text = null;
              }
              break;
            case "si":
              if (this.options.sharedStrings === "cache") {
                this.sharedStrings!.push(richText.length ? { richText } : text || "");
              } else if (this.options.sharedStrings === "emit") {
                yield { index: index++, text: richText.length ? { richText } : text || "" };
              }

              richText = [];
              font = null;
              text = null;
              inRichText = false;
              break;
          }
        }
      }
    }
  }

  async _parseStyles(entry: any): Promise<void> {
    this._emitEntry({ type: "styles" });
    if (this.options.styles === "cache") {
      this.styles = new StylesXform();
      await this.styles.parseStream(iterateStream(entry));
    }
  }

  *_parseWorksheet(
    iterator: any,
    sheetNo: string
  ): IterableIterator<{ eventType: string; value: any }> {
    this._emitEntry({ type: "worksheet", id: sheetNo });
    const worksheetReader = new WorksheetReader({
      workbook: this,
      id: parseInt(sheetNo, 10),
      iterator,
      options: this.options
    });

    const matchingRel = (this.workbookRels || []).find(
      (rel: any) => rel.Target === `worksheets/sheet${sheetNo}.xml`
    );
    const matchingSheet =
      matchingRel &&
      this.model &&
      (this.model.sheets || []).find((sheet: any) => sheet.rId === matchingRel.Id);
    if (matchingSheet) {
      worksheetReader.id = matchingSheet.id;
      worksheetReader.name = matchingSheet.name;
      worksheetReader.state = matchingSheet.state;
    }
    if (this.options.worksheets === "emit") {
      yield { eventType: "worksheet", value: worksheetReader };
    }
  }

  *_parseHyperlinks(
    iterator: any,
    sheetNo: string
  ): IterableIterator<{ eventType: string; value: any }> {
    this._emitEntry({ type: "hyperlinks", id: sheetNo });
    const hyperlinksReader = new HyperlinkReader({
      workbook: this,
      id: parseInt(sheetNo, 10),
      iterator,
      options: this.options
    });
    if (this.options.hyperlinks === "emit") {
      yield { eventType: "hyperlinks", value: hyperlinksReader };
    }
  }
}

const WorkbookReaderOptions = {
  worksheets: ["emit", "ignore"],
  sharedStrings: ["cache", "emit", "ignore"],
  hyperlinks: ["cache", "emit", "ignore"],
  styles: ["cache", "ignore"],
  entries: ["emit", "ignore"]
} as const;

export { WorkbookReader, WorkbookReaderOptions };
