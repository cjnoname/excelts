import fs from "fs";
import { Zip, ZipPassThrough } from "fflate";
import { StreamBuf } from "../../utils/stream-buf.js";
import { RelType } from "../../xlsx/rel-type.js";
import { StylesXform } from "../../xlsx/xform/style/styles-xform.js";
import { SharedStrings } from "../../utils/shared-strings.js";
import { DefinedNames } from "../../doc/defined-names.js";
import { CoreXform } from "../../xlsx/xform/core/core-xform.js";
import { RelationshipsXform } from "../../xlsx/xform/core/relationships-xform.js";
import { ContentTypesXform } from "../../xlsx/xform/core/content-types-xform.js";
import { AppXform } from "../../xlsx/xform/core/app-xform.js";
import { WorkbookXform } from "../../xlsx/xform/book/workbook-xform.js";
import { SharedStringsXform } from "../../xlsx/xform/strings/shared-strings-xform.js";
import { WorksheetWriter } from "./worksheet-writer.js";
import { theme1Xml } from "../../xlsx/xml/theme1.js";
import type Stream from "stream";

interface WorkbookWriterOptions {
  created?: Date;
  modified?: Date;
  creator?: string;
  lastModifiedBy?: string;
  lastPrinted?: Date;
  useSharedStrings?: boolean;
  useStyles?: boolean;
  zip?: any;
  stream?: Stream;
  filename?: string;
}

class WorkbookWriter {
  created: Date;
  modified: Date;
  creator: string;
  lastModifiedBy: string;
  lastPrinted?: Date;
  useSharedStrings: boolean;
  sharedStrings: any;
  styles: any;
  _definedNames: any;
  _worksheets: any[];
  views: any[];
  zipOptions?: any;
  media: any[];
  commentRefs: any[];
  zip: any;
  stream: any;
  promise: Promise<any>;

  constructor(options: WorkbookWriterOptions = {}) {
    this.created = options.created || new Date();
    this.modified = options.modified || this.created;
    this.creator = options.creator || "ExcelTS";
    this.lastModifiedBy = options.lastModifiedBy || "ExcelTS";
    this.lastPrinted = options.lastPrinted;

    // using shared strings creates a smaller xlsx file but may use more memory
    this.useSharedStrings = options.useSharedStrings || false;
    this.sharedStrings = new SharedStrings();

    // style manager
    this.styles = options.useStyles ? new StylesXform(true) : new (StylesXform as any).Mock(true);

    // defined names
    this._definedNames = new DefinedNames();

    this._worksheets = [];
    this.views = [];

    this.zipOptions = options.zip;

    this.media = [];
    this.commentRefs = [];

    // Create fflate Zip instance
    this.zip = new Zip((err, data, final) => {
      if (err) {
        this.stream.emit("error", err);
      } else {
        this.stream.write(Buffer.from(data));
        if (final) {
          this.stream.end();
        }
      }
    });

    if (options.stream) {
      this.stream = options.stream;
    } else if (options.filename) {
      this.stream = fs.createWriteStream(options.filename);
    } else {
      this.stream = new StreamBuf();
    }

    // these bits can be added right now
    this.promise = Promise.all([this.addThemes(), this.addOfficeRels()]);
  }

  get definedNames(): any {
    return this._definedNames;
  }

  _openStream(path: string): any {
    const stream = new StreamBuf({ bufSize: 65536, batch: true });

    // Create a ZipPassThrough for this file
    const zipFile = new ZipPassThrough(path);
    this.zip.add(zipFile);

    // Don't pause the stream - we need data events to flow
    // The original implementation used archiver which consumed the stream internally
    // Now we need to manually pipe data to fflate

    // Pipe stream data to zipFile with cleanup
    const onData = (chunk: Buffer) => {
      zipFile.push(chunk);
    };

    stream.on("data", onData);

    // Use once for automatic cleanup and also clean up data listener
    stream.once("finish", () => {
      stream.removeListener("data", onData);
      zipFile.push(new Uint8Array(0), true); // Signal end
      stream.emit("zipped");
    });

    return stream;
  }

  _addFile(data: string | Buffer, name: string, base64?: boolean): void {
    // Helper method to add a file to the zip using fflate
    const zipFile = new ZipPassThrough(name);
    this.zip.add(zipFile);

    let buffer: Uint8Array;
    if (base64) {
      // Use Buffer.from for efficient base64 decoding
      const base64Data = typeof data === "string" ? data : data.toString();
      buffer = Buffer.from(base64Data, "base64");
    } else if (typeof data === "string") {
      buffer = Buffer.from(data, "utf8");
    } else {
      buffer = new Uint8Array(data);
    }

    zipFile.push(buffer, true); // true = final chunk
  }

  _commitWorksheets(): Promise<void> {
    const commitWorksheet = function (worksheet: any): Promise<void> {
      if (!worksheet.committed) {
        return new Promise(resolve => {
          // Use once to automatically clean up listener
          worksheet.stream.once("zipped", () => {
            resolve();
          });
          worksheet.commit();
        });
      }
      return Promise.resolve();
    };
    // if there are any uncommitted worksheets, commit them now and wait
    const promises = this._worksheets.map(commitWorksheet);
    if (promises.length) {
      return Promise.all(promises) as any;
    }
    return Promise.resolve();
  }

  async commit(): Promise<any> {
    // commit all worksheets, then add suplimentary files
    await this.promise;
    await this.addMedia();
    await this._commitWorksheets();
    await Promise.all([
      this.addContentTypes(),
      this.addApp(),
      this.addCore(),
      this.addSharedStrings(),
      this.addStyles(),
      this.addWorkbookRels()
    ]);
    await this.addWorkbook();
    return this._finalize();
  }

  get nextId(): number {
    // find the next unique spot to add worksheet
    let i;
    for (i = 1; i < this._worksheets.length; i++) {
      if (!this._worksheets[i]) {
        return i;
      }
    }
    return this._worksheets.length || 1;
  }

  addImage(image: any): number {
    const id = this.media.length;
    const medium = Object.assign({}, image, {
      type: "image",
      name: `image${id}.${image.extension}`
    });
    this.media.push(medium);
    return id;
  }

  getImage(id: number): any {
    return this.media[id];
  }

  addWorksheet(name?: string, options: any = {}): any {
    // it's possible to add a worksheet with different than default
    // shared string handling
    // in fact, it's even possible to switch it mid-sheet
    const useSharedStrings =
      options.useSharedStrings !== undefined ? options.useSharedStrings : this.useSharedStrings;

    if (options.tabColor) {
      console.trace("tabColor option has moved to { properties: tabColor: {...} }");
      options.properties = Object.assign(
        {
          tabColor: options.tabColor
        },
        options.properties
      );
    }

    const id = this.nextId;
    name = name || `sheet${id}`;

    const worksheet = new WorksheetWriter({
      id,
      name,
      workbook: this,
      useSharedStrings,
      properties: options.properties,
      state: options.state,
      pageSetup: options.pageSetup,
      views: options.views,
      autoFilter: options.autoFilter,
      headerFooter: options.headerFooter
    });

    this._worksheets[id] = worksheet;
    return worksheet;
  }

  getWorksheet(id?: string | number): any {
    if (id === undefined) {
      return this._worksheets.find(() => true);
    }
    if (typeof id === "number") {
      return this._worksheets[id];
    }
    if (typeof id === "string") {
      return this._worksheets.find((worksheet: any) => worksheet && worksheet.name === id);
    }
    return undefined;
  }

  addStyles(): Promise<void> {
    return new Promise(resolve => {
      this._addFile(this.styles.xml, "xl/styles.xml");
      resolve();
    });
  }

  addThemes(): Promise<void> {
    return new Promise(resolve => {
      this._addFile(theme1Xml, "xl/theme/theme1.xml");
      resolve();
    });
  }

  addOfficeRels(): Promise<void> {
    return new Promise(resolve => {
      const xform = new RelationshipsXform();
      const xml = xform.toXml([
        { Id: "rId1", Type: RelType.OfficeDocument, Target: "xl/workbook.xml" },
        { Id: "rId2", Type: RelType.CoreProperties, Target: "docProps/core.xml" },
        { Id: "rId3", Type: RelType.ExtenderProperties, Target: "docProps/app.xml" }
      ]);
      this._addFile(xml, "_rels/.rels");
      resolve();
    });
  }

  addContentTypes(): Promise<void> {
    return new Promise(resolve => {
      const model = {
        worksheets: this._worksheets.filter(Boolean),
        sharedStrings: this.sharedStrings,
        commentRefs: this.commentRefs,
        media: this.media
      };
      const xform = new ContentTypesXform();
      const xml = xform.toXml(model);
      this._addFile(xml, "[Content_Types].xml");
      resolve();
    });
  }

  addMedia(): Promise<any> {
    return Promise.all(
      this.media.map(async medium => {
        if (medium.type === "image") {
          const filename = `xl/media/${medium.name}`;
          if (medium.filename) {
            const data = await new Promise<Buffer>((resolve, reject) => {
              fs.readFile(medium.filename, (err, data) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(data);
                }
              });
            });
            this._addFile(data, filename);
            return;
          }
          if (medium.buffer) {
            this._addFile(medium.buffer, filename);
            return Promise.resolve();
          }
          if (medium.base64) {
            const dataimg64 = medium.base64;
            const content = dataimg64.substring(dataimg64.indexOf(",") + 1);
            this._addFile(content, filename, true);
            return Promise.resolve();
          }
        }
        throw new Error("Unsupported media");
      })
    );
  }

  addApp(): Promise<void> {
    return new Promise(resolve => {
      const model = {
        worksheets: this._worksheets.filter(Boolean)
      };
      const xform = new AppXform();
      const xml = xform.toXml(model);
      this._addFile(xml, "docProps/app.xml");
      resolve();
    });
  }

  addCore(): Promise<void> {
    return new Promise(resolve => {
      const coreXform = new CoreXform();
      const xml = coreXform.toXml(this);
      this._addFile(xml, "docProps/core.xml");
      resolve();
    });
  }

  addSharedStrings(): Promise<void> {
    if (this.sharedStrings.count) {
      return new Promise(resolve => {
        const sharedStringsXform = new SharedStringsXform();
        const xml = sharedStringsXform.toXml(this.sharedStrings);
        this._addFile(xml, "xl/sharedStrings.xml");
        resolve();
      });
    }
    return Promise.resolve();
  }

  addWorkbookRels(): Promise<void> {
    let count = 1;
    const relationships = [
      { Id: `rId${count++}`, Type: RelType.Styles, Target: "styles.xml" },
      { Id: `rId${count++}`, Type: RelType.Theme, Target: "theme/theme1.xml" }
    ];
    if (this.sharedStrings.count) {
      relationships.push({
        Id: `rId${count++}`,
        Type: RelType.SharedStrings,
        Target: "sharedStrings.xml"
      });
    }
    this._worksheets.forEach(worksheet => {
      if (worksheet) {
        worksheet.rId = `rId${count++}`;
        relationships.push({
          Id: worksheet.rId,
          Type: RelType.Worksheet,
          Target: `worksheets/sheet${worksheet.id}.xml`
        });
      }
    });
    return new Promise(resolve => {
      const xform = new RelationshipsXform();
      const xml = xform.toXml(relationships);
      this._addFile(xml, "xl/_rels/workbook.xml.rels");
      resolve();
    });
  }

  addWorkbook(): Promise<void> {
    const model = {
      worksheets: this._worksheets.filter(Boolean),
      definedNames: this._definedNames.model,
      views: this.views,
      properties: {},
      calcProperties: {}
    };

    return new Promise(resolve => {
      const xform = new WorkbookXform();
      xform.prepare(model);
      this._addFile(xform.toXml(model), "xl/workbook.xml");
      resolve();
    });
  }

  _finalize(): Promise<any> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.stream.removeListener("finish", onFinish);
        reject(err);
      };

      const onFinish = () => {
        this.stream.removeListener("error", onError);
        resolve(this);
      };

      this.stream.once("error", onError);
      this.stream.once("finish", onFinish);

      // fflate Zip doesn't have 'error' event or 'finalize' method
      // Just end the zip by calling end()
      this.zip.end();
    });
  }
}

export { WorkbookWriter };
