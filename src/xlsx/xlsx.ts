import fs from "fs";
import type { UnzipFile } from "fflate";
import { Unzip, UnzipInflate } from "fflate";
import { PassThrough } from "stream";
import { ZipWriter } from "../utils/zip-stream.js";
import { StreamBuf } from "../utils/stream-buf.js";
import { fileExists } from "../utils/utils.js";
import { XmlStream } from "../utils/xml-stream.js";
import { bufferToString } from "../utils/browser-buffer-decode.js";
import { StylesXform } from "./xform/style/styles-xform.js";
import { CoreXform } from "./xform/core/core-xform.js";
import { SharedStringsXform } from "./xform/strings/shared-strings-xform.js";
import { RelationshipsXform } from "./xform/core/relationships-xform.js";
import { ContentTypesXform } from "./xform/core/content-types-xform.js";
import { AppXform } from "./xform/core/app-xform.js";
import { WorkbookXform } from "./xform/book/workbook-xform.js";
import { WorkSheetXform } from "./xform/sheet/worksheet-xform.js";
import { DrawingXform } from "./xform/drawing/drawing-xform.js";
import { TableXform } from "./xform/table/table-xform.js";
import { PivotCacheRecordsXform } from "./xform/pivot-table/pivot-cache-records-xform.js";
import { PivotCacheDefinitionXform } from "./xform/pivot-table/pivot-cache-definition-xform.js";
import { PivotTableXform } from "./xform/pivot-table/pivot-table-xform.js";
import { CommentsXform } from "./xform/comment/comments-xform.js";
import { VmlNotesXform } from "./xform/comment/vml-notes-xform.js";
import { theme1Xml } from "./xml/theme1.js";
import { RelType } from "./rel-type.js";

function fsReadFileAsync(filename: string, options?: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fs.readFile(filename, options, (error, data) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
}

class XLSX {
  declare public workbook: any;

  constructor(workbook: any) {
    this.workbook = workbook;
  }

  // ===============================================================================
  // Workbook
  // =========================================================================
  // Read

  async readFile(filename: string, options?: any): Promise<any> {
    if (!(await fileExists(filename))) {
      throw new Error(`File not found: ${filename}`);
    }
    const stream = fs.createReadStream(filename);
    try {
      const workbook = await this.read(stream, options);
      stream.close();
      return workbook;
    } catch (error) {
      stream.close();
      throw error;
    }
  }

  parseRels(stream: any): Promise<any> {
    const xform = new RelationshipsXform();
    return xform.parseStream(stream);
  }

  parseWorkbook(stream: any): Promise<any> {
    const xform = new WorkbookXform();
    return xform.parseStream(stream);
  }

  parseSharedStrings(stream: any): Promise<any> {
    const xform = new SharedStringsXform();
    return xform.parseStream(stream);
  }

  reconcile(model: any, options?: any): void {
    const workbookXform = new WorkbookXform();
    const worksheetXform = new WorkSheetXform(options);
    const drawingXform = new DrawingXform();
    const tableXform = new TableXform();

    workbookXform.reconcile(model);

    // reconcile drawings with their rels
    const drawingOptions: any = {
      media: model.media,
      mediaIndex: model.mediaIndex
    };
    Object.keys(model.drawings).forEach(name => {
      const drawing = model.drawings[name];
      const drawingRel = model.drawingRels[name];
      if (drawingRel) {
        drawingOptions.rels = drawingRel.reduce((o: any, rel: any) => {
          o[rel.Id] = rel;
          return o;
        }, {});
        (drawing.anchors || []).forEach((anchor: any) => {
          const hyperlinks = anchor.picture && anchor.picture.hyperlinks;
          if (hyperlinks && drawingOptions.rels[hyperlinks.rId]) {
            hyperlinks.hyperlink = drawingOptions.rels[hyperlinks.rId].Target;
            delete hyperlinks.rId;
          }
        });
        drawingXform.reconcile(drawing, drawingOptions);
      }
    });

    // reconcile tables with the default styles
    const tableOptions = {
      styles: model.styles
    };
    Object.values(model.tables).forEach((table: any) => {
      tableXform.reconcile(table, tableOptions);
    });

    const sheetOptions = {
      styles: model.styles,
      sharedStrings: model.sharedStrings,
      media: model.media,
      mediaIndex: model.mediaIndex,
      date1904: model.properties && model.properties.date1904,
      drawings: model.drawings,
      comments: model.comments,
      tables: model.tables,
      vmlDrawings: model.vmlDrawings
    };
    model.worksheets.forEach((worksheet: any) => {
      worksheet.relationships = model.worksheetRels[worksheet.sheetNo];
      worksheetXform.reconcile(worksheet, sheetOptions);
    });

    // delete unnecessary parts
    delete model.worksheetHash;
    delete model.worksheetRels;
    delete model.globalRels;
    delete model.sharedStrings;
    delete model.workbookRels;
    delete model.sheetDefs;
    delete model.styles;
    delete model.mediaIndex;
    delete model.drawings;
    delete model.drawingRels;
    delete model.vmlDrawings;
  }

  async _processWorksheetEntry(
    stream: any,
    model: any,
    sheetNo: number,
    options: any,
    path: string
  ): Promise<void> {
    const xform = new WorkSheetXform(options);
    const worksheet = await xform.parseStream(stream);
    if (!worksheet) {
      throw new Error(`Failed to parse worksheet ${path}`);
    }
    worksheet.sheetNo = sheetNo;
    model.worksheetHash[path] = worksheet;
    model.worksheets.push(worksheet);
  }

  async _processCommentEntry(stream: any, model: any, name: string): Promise<void> {
    const xform = new CommentsXform();
    const comments = await xform.parseStream(stream);
    model.comments[`../${name}.xml`] = comments;
  }

  async _processTableEntry(stream: any, model: any, name: string): Promise<void> {
    const xform = new TableXform();
    const table = await xform.parseStream(stream);
    model.tables[`../tables/${name}.xml`] = table;
  }

  async _processWorksheetRelsEntry(stream: any, model: any, sheetNo: number): Promise<void> {
    const xform = new RelationshipsXform();
    const relationships = await xform.parseStream(stream);
    model.worksheetRels[sheetNo] = relationships;
  }

  async _processMediaEntry(stream: any, model: any, filename: string): Promise<void> {
    const lastDot = filename.lastIndexOf(".");
    // if we can't determine extension, ignore it
    if (lastDot >= 1) {
      const extension = filename.substr(lastDot + 1);
      const name = filename.substr(0, lastDot);
      await new Promise<void>((resolve, reject) => {
        const streamBuf = new StreamBuf();

        const cleanup = () => {
          stream.removeListener("error", onError);
          streamBuf.removeListener("error", onError);
          streamBuf.removeListener("finish", onFinish);
        };

        const onFinish = () => {
          cleanup();
          model.mediaIndex[filename] = model.media.length;
          model.mediaIndex[name] = model.media.length;
          const medium = {
            type: "image",
            name,
            extension,
            buffer: streamBuf.toBuffer()
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

  async _processDrawingEntry(entry: any, model: any, name: string): Promise<void> {
    const xform = new DrawingXform();
    const drawing = await xform.parseStream(entry);
    model.drawings[name] = drawing;
  }

  async _processDrawingRelsEntry(entry: any, model: any, name: string): Promise<void> {
    const xform = new RelationshipsXform();
    const relationships = await xform.parseStream(entry);
    model.drawingRels[name] = relationships;
  }

  async _processVmlDrawingEntry(entry: any, model: any, name: string): Promise<void> {
    const xform = new VmlNotesXform();
    const vmlDrawing = await xform.parseStream(entry);
    model.vmlDrawings[`../drawings/${name}.vml`] = vmlDrawing;
  }

  async _processThemeEntry(stream: any, model: any, name: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // TODO: stream entry into buffer and store the xml in the model.themes[]
      const streamBuf = new StreamBuf();

      const cleanup = () => {
        stream.removeListener("error", onError);
        streamBuf.removeListener("error", onError);
        streamBuf.removeListener("finish", onFinish);
      };

      const onFinish = () => {
        cleanup();
        model.themes[name] = streamBuf.read().toString();
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

  async read(stream: any, options?: any): Promise<any> {
    // Use streaming unzip with fflate
    const allFiles: Record<string, Uint8Array> = {};

    await new Promise<void>((resolve, reject) => {
      let filesProcessed = 0;
      let zipEnded = false;
      let filesStarted = 0;

      const cleanup = () => {
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
      };

      const checkCompletion = () => {
        if (zipEnded && filesProcessed === filesStarted) {
          cleanup();
          resolve();
        }
      };

      const unzipper = new Unzip((file: UnzipFile) => {
        filesStarted++;
        const fileChunks: Uint8Array[] = [];
        let totalLength = 0;

        file.ondata = (err, data, final) => {
          if (err) {
            cleanup();
            reject(err);
            return;
          }
          if (data) {
            fileChunks.push(data);
            totalLength += data.length;
          }
          if (final) {
            // Optimize for single chunk case
            if (fileChunks.length === 1) {
              allFiles[file.name] = fileChunks[0];
            } else if (fileChunks.length > 1) {
              const fullData = new Uint8Array(totalLength);
              let offset = 0;
              for (const chunk of fileChunks) {
                fullData.set(chunk, offset);
                offset += chunk.length;
              }
              allFiles[file.name] = fullData;
            } else {
              allFiles[file.name] = new Uint8Array(0);
            }
            filesProcessed++;
            fileChunks.length = 0;
            checkCompletion();
          }
        };
        file.start();
      });

      unzipper.register(UnzipInflate);

      const onData = (chunk: Buffer) => {
        unzipper.push(chunk);
      };

      const onEnd = () => {
        unzipper.push(new Uint8Array(0), true);
        zipEnded = true;
        checkCompletion();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      stream.on("data", onData);
      stream.on("end", onEnd);
      stream.on("error", onError);
    });

    return this.loadFromFiles(allFiles, options);
  }

  async load(data: any, options?: any): Promise<any> {
    let buffer: Buffer;

    // Validate input type
    if (
      !data ||
      (typeof data === "object" &&
        !Buffer.isBuffer(data) &&
        !(data instanceof Uint8Array) &&
        !(data instanceof ArrayBuffer))
    ) {
      throw new Error(
        "Can't read the data of 'the loaded zip file'. Is it in a supported JavaScript type (String, Blob, ArrayBuffer, etc) ?"
      );
    }

    if (options && options.base64) {
      buffer = Buffer.from(data.toString(), "base64");
    } else {
      buffer = data;
    }

    // Create a fake stream from buffer for consistency
    const PassThroughStream = PassThrough;
    const stream = new PassThroughStream();
    stream.end(buffer);

    return this.read(stream, options);
  }

  async loadFromFiles(zipData: Record<string, Uint8Array>, options?: any): Promise<any> {
    const model: any = {
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
      vmlDrawings: {}
    };

    // Convert fflate format to JSZip-like structure for compatibility
    const entries = Object.keys(zipData).map(name => ({
      name,
      dir: name.endsWith("/"),
      data: zipData[name]
    }));

    for (const entry of entries) {
      if (!entry.dir) {
        let entryName = entry.name;
        if (entryName[0] === "/") {
          entryName = entryName.substr(1);
        }
        let stream: any;
        if (
          entryName.match(/xl\/media\//) ||
          // themes are not parsed as stream
          entryName.match(/xl\/theme\/([a-zA-Z0-9]+)[.]xml/)
        ) {
          stream = new PassThrough();
          stream.end(Buffer.from(entry.data));
        } else {
          // use object mode to avoid buffer-string convention
          stream = new PassThrough({
            readableObjectMode: true,
            writableObjectMode: true
          });
          const content = bufferToString(Buffer.from(entry.data));
          stream.end(content);
        }

        let match: RegExpMatchArray | null;
        match = entryName.match(/xl\/worksheets\/sheet(\d+)[.]xml/);
        if (match) {
          const sheetNo = parseInt(match[1], 10);
          await this._processWorksheetEntry(stream, model, sheetNo, options, entryName);
        } else {
          switch (entryName) {
            case "_rels/.rels":
              model.globalRels = await this.parseRels(stream);
              break;
            case "xl/workbook.xml": {
              const workbook = await this.parseWorkbook(stream);
              model.sheets = workbook.sheets;
              model.definedNames = workbook.definedNames;
              model.views = workbook.views;
              model.properties = workbook.properties;
              model.calcProperties = workbook.calcProperties;
              break;
            }
            case "xl/sharedStrings.xml":
              model.sharedStrings = new SharedStringsXform();
              await model.sharedStrings.parseStream(stream);
              break;
            case "xl/_rels/workbook.xml.rels":
              model.workbookRels = await this.parseRels(stream);
              break;
            case "docProps/app.xml": {
              const appXform = new AppXform();
              const appProperties = await appXform.parseStream(stream);
              model.company = appProperties.company;
              model.manager = appProperties.manager;
              break;
            }
            case "docProps/core.xml": {
              const coreXform = new CoreXform();
              const coreProperties = await coreXform.parseStream(stream);
              Object.assign(model, coreProperties);
              break;
            }
            case "xl/styles.xml":
              model.styles = new StylesXform();
              await model.styles.parseStream(stream);
              break;
            default: {
              match = entryName.match(/xl\/worksheets\/_rels\/sheet(\d+)[.]xml[.]rels/);
              if (match) {
                const sheetNo = parseInt(match[1], 10);
                await this._processWorksheetRelsEntry(stream, model, sheetNo);
                break;
              }
              match = entryName.match(/xl\/media\/([a-zA-Z0-9]+[.][a-zA-Z0-9]{3,4})$/);
              if (match) {
                await this._processMediaEntry(stream, model, match[1]);
                break;
              }
              match = entryName.match(/xl\/drawings\/(drawing\d+)[.]xml/);
              if (match) {
                await this._processDrawingEntry(stream, model, match[1]);
                break;
              }
              match = entryName.match(/xl\/drawings\/_rels\/(drawing\d+)[.]xml[.]rels/);
              if (match) {
                await this._processDrawingRelsEntry(stream, model, match[1]);
                break;
              }
              match = entryName.match(/xl\/drawings\/(vmlDrawing\d+)[.]vml/);
              if (match) {
                await this._processVmlDrawingEntry(stream, model, match[1]);
                break;
              }
              match = entryName.match(/xl\/comments(\d+)[.]xml/);
              if (match) {
                await this._processCommentEntry(stream, model, `comments${match[1]}`);
                break;
              }
              match = entryName.match(/xl\/tables\/(table\d+)[.]xml/);
              if (match) {
                await this._processTableEntry(stream, model, match[1]);
                break;
              }
              match = entryName.match(/xl\/theme\/([a-zA-Z0-9]+)[.]xml/);
              if (match) {
                await this._processThemeEntry(stream, model, match[1]);
                break;
              }
            }
          }
        }
      }
    }

    this.reconcile(model, options);

    // apply model
    this.workbook.model = model;
    return this.workbook;
  }

  // =========================================================================
  // Write

  async addContentTypes(zip: any, model: any): Promise<void> {
    const xform = new ContentTypesXform();
    const xml = xform.toXml(model);
    zip.append(xml, { name: "[Content_Types].xml" });
  }

  async addApp(zip: any, model: any): Promise<void> {
    const xform = new AppXform();
    const xml = xform.toXml(model);
    zip.append(xml, { name: "docProps/app.xml" });
  }

  async addCore(zip: any, model: any): Promise<void> {
    const xform = new CoreXform();
    zip.append(xform.toXml(model), { name: "docProps/core.xml" });
  }

  async addThemes(zip: any, model: any): Promise<void> {
    const themes = model.themes || { theme1: theme1Xml };
    Object.keys(themes).forEach(name => {
      const xml = themes[name];
      const path = `xl/theme/${name}.xml`;
      zip.append(xml, { name: path });
    });
  }

  async addOfficeRels(zip: any, _model: any): Promise<void> {
    const xform = new RelationshipsXform();
    const xml = xform.toXml([
      { Id: "rId1", Type: XLSX.RelType.OfficeDocument, Target: "xl/workbook.xml" },
      { Id: "rId2", Type: XLSX.RelType.CoreProperties, Target: "docProps/core.xml" },
      { Id: "rId3", Type: XLSX.RelType.ExtenderProperties, Target: "docProps/app.xml" }
    ]);
    zip.append(xml, { name: "_rels/.rels" });
  }

  async addWorkbookRels(zip: any, model: any): Promise<void> {
    let count = 1;
    const relationships: any[] = [
      { Id: `rId${count++}`, Type: XLSX.RelType.Styles, Target: "styles.xml" },
      { Id: `rId${count++}`, Type: XLSX.RelType.Theme, Target: "theme/theme1.xml" }
    ];
    if (model.sharedStrings.count) {
      relationships.push({
        Id: `rId${count++}`,
        Type: XLSX.RelType.SharedStrings,
        Target: "sharedStrings.xml"
      });
    }
    if ((model.pivotTables || []).length) {
      const pivotTable = model.pivotTables[0];
      pivotTable.rId = `rId${count++}`;
      relationships.push({
        Id: pivotTable.rId,
        Type: XLSX.RelType.PivotCacheDefinition,
        Target: "pivotCache/pivotCacheDefinition1.xml"
      });
    }
    model.worksheets.forEach((worksheet: any) => {
      worksheet.rId = `rId${count++}`;
      relationships.push({
        Id: worksheet.rId,
        Type: XLSX.RelType.Worksheet,
        Target: `worksheets/sheet${worksheet.id}.xml`
      });
    });
    const xform = new RelationshipsXform();
    const xml = xform.toXml(relationships);
    zip.append(xml, { name: "xl/_rels/workbook.xml.rels" });
  }

  async addSharedStrings(zip: any, model: any): Promise<void> {
    if (model.sharedStrings && model.sharedStrings.count) {
      zip.append(model.sharedStrings.xml, { name: "xl/sharedStrings.xml" });
    }
  }

  async addStyles(zip: any, model: any): Promise<void> {
    const { xml } = model.styles;
    if (xml) {
      zip.append(xml, { name: "xl/styles.xml" });
    }
  }

  async addWorkbook(zip: any, model: any): Promise<void> {
    const xform = new WorkbookXform();
    zip.append(xform.toXml(model), { name: "xl/workbook.xml" });
  }

  async addWorksheets(zip: any, model: any): Promise<void> {
    // preparation phase
    const worksheetXform = new WorkSheetXform();
    const relationshipsXform = new RelationshipsXform();
    const commentsXform = new CommentsXform();
    const vmlNotesXform = new VmlNotesXform();

    // write sheets
    model.worksheets.forEach((worksheet: any) => {
      let xmlStream = new XmlStream();
      worksheetXform.render(xmlStream, worksheet);
      zip.append(xmlStream.xml, { name: `xl/worksheets/sheet${worksheet.id}.xml` });

      if (worksheet.rels && worksheet.rels.length) {
        xmlStream = new XmlStream();
        relationshipsXform.render(xmlStream, worksheet.rels);
        zip.append(xmlStream.xml, { name: `xl/worksheets/_rels/sheet${worksheet.id}.xml.rels` });
      }

      if (worksheet.comments.length > 0) {
        xmlStream = new XmlStream();
        commentsXform.render(xmlStream, worksheet);
        zip.append(xmlStream.xml, { name: `xl/comments${worksheet.id}.xml` });

        xmlStream = new XmlStream();
        vmlNotesXform.render(xmlStream, worksheet);
        zip.append(xmlStream.xml, { name: `xl/drawings/vmlDrawing${worksheet.id}.vml` });
      }
    });
  }

  async addMedia(zip: any, model: any): Promise<void> {
    await Promise.all(
      model.media.map(async (medium: any) => {
        if (medium.type === "image") {
          const filename = `xl/media/${medium.name}.${medium.extension}`;
          if (medium.filename) {
            const data = await fsReadFileAsync(medium.filename);
            return zip.append(data, { name: filename });
          }
          if (medium.buffer) {
            return zip.append(medium.buffer, { name: filename });
          }
          if (medium.base64) {
            const dataimg64 = medium.base64;
            const content = dataimg64.substring(dataimg64.indexOf(",") + 1);
            return zip.append(content, { name: filename, base64: true });
          }
        }
        throw new Error("Unsupported media");
      })
    );
  }

  addDrawings(zip: any, model: any): void {
    const drawingXform = new DrawingXform();
    const relsXform = new RelationshipsXform();

    model.worksheets.forEach((worksheet: any) => {
      const { drawing } = worksheet;
      if (drawing) {
        drawingXform.prepare(drawing);
        let xml = drawingXform.toXml(drawing);
        zip.append(xml, { name: `xl/drawings/${drawing.name}.xml` });

        xml = relsXform.toXml(drawing.rels);
        zip.append(xml, { name: `xl/drawings/_rels/${drawing.name}.xml.rels` });
      }
    });
  }

  addTables(zip: any, model: any): void {
    const tableXform = new TableXform();

    model.worksheets.forEach((worksheet: any) => {
      const { tables } = worksheet;
      tables.forEach((table: any) => {
        tableXform.prepare(table, {});
        const tableXml = tableXform.toXml(table);
        zip.append(tableXml, { name: `xl/tables/${table.target}` });
      });
    });
  }

  addPivotTables(zip: any, model: any): void {
    if (!model.pivotTables.length) {
      return;
    }

    const pivotTable = model.pivotTables[0];

    const pivotCacheRecordsXform = new PivotCacheRecordsXform();
    const pivotCacheDefinitionXform = new PivotCacheDefinitionXform();
    const pivotTableXform = new PivotTableXform();
    const relsXform = new RelationshipsXform();

    // pivot cache records
    let xml = pivotCacheRecordsXform.toXml(pivotTable);
    zip.append(xml, { name: "xl/pivotCache/pivotCacheRecords1.xml" });

    // pivot cache definition
    xml = pivotCacheDefinitionXform.toXml(pivotTable);
    zip.append(xml, { name: "xl/pivotCache/pivotCacheDefinition1.xml" });

    // pivot cache definition rels
    xml = relsXform.toXml([
      {
        Id: "rId1",
        Type: XLSX.RelType.PivotCacheRecords,
        Target: "pivotCacheRecords1.xml"
      }
    ]);
    zip.append(xml, { name: "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels" });

    // pivot table
    xml = pivotTableXform.toXml(pivotTable);
    zip.append(xml, { name: "xl/pivotTables/pivotTable1.xml" });

    xml = relsXform.toXml([
      {
        Id: "rId1",
        Type: XLSX.RelType.PivotCacheDefinition,
        Target: "../pivotCache/pivotCacheDefinition1.xml"
      }
    ]);
    zip.append(xml, { name: "xl/pivotTables/_rels/pivotTable1.xml.rels" });
  }

  _finalize(zip: any): Promise<XLSX> {
    return new Promise((resolve, reject) => {
      zip.on("finish", () => {
        resolve(this);
      });
      zip.on("error", reject);
      zip.finalize();
    });
  }

  prepareModel(model: any, options: any): void {
    // ensure following properties have sane values
    model.creator = model.creator || "ExcelTS";
    model.lastModifiedBy = model.lastModifiedBy || "ExcelTS";
    model.created = model.created || new Date();
    model.modified = model.modified || new Date();

    model.useSharedStrings =
      options.useSharedStrings !== undefined ? options.useSharedStrings : true;
    model.useStyles = options.useStyles !== undefined ? options.useStyles : true;

    // Manage the shared strings
    model.sharedStrings = new SharedStringsXform();

    // add a style manager to handle cell formats, fonts, etc.
    model.styles = model.useStyles ? new StylesXform(true) : new (StylesXform as any).Mock();

    // prepare all of the things before the render
    const workbookXform = new WorkbookXform();
    const worksheetXform = new WorkSheetXform();

    workbookXform.prepare(model);

    const worksheetOptions: any = {
      sharedStrings: model.sharedStrings,
      styles: model.styles,
      date1904: model.properties.date1904,
      drawingsCount: 0,
      media: model.media
    };
    worksheetOptions.drawings = model.drawings = [];
    worksheetOptions.commentRefs = model.commentRefs = [];
    let tableCount = 0;
    model.tables = [];
    model.worksheets.forEach((worksheet: any) => {
      // assign unique filenames to tables
      worksheet.tables.forEach((table: any) => {
        tableCount++;
        table.target = `table${tableCount}.xml`;
        table.id = tableCount;
        model.tables.push(table);
      });

      worksheetXform.prepare(worksheet, worksheetOptions);
    });

    // TODO: workbook drawing list
  }

  async write(stream: any, options?: any): Promise<XLSX> {
    options = options || {};
    const { model } = this.workbook;
    const zip = new ZipWriter(options.zip);
    zip.pipe(stream);

    this.prepareModel(model, options);

    // render
    await this.addContentTypes(zip, model);
    await this.addOfficeRels(zip, model);
    await this.addWorkbookRels(zip, model);
    await this.addWorksheets(zip, model);
    await this.addSharedStrings(zip, model); // always after worksheets
    this.addDrawings(zip, model);
    this.addTables(zip, model);
    this.addPivotTables(zip, model);
    await Promise.all([this.addThemes(zip, model), this.addStyles(zip, model)]);
    await this.addMedia(zip, model);
    await Promise.all([this.addApp(zip, model), this.addCore(zip, model)]);
    await this.addWorkbook(zip, model);
    return this._finalize(zip);
  }

  writeFile(filename: string, options?: any): Promise<void> {
    const stream = fs.createWriteStream(filename);

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        stream.removeListener("finish", onFinish);
        stream.removeListener("error", onError);
      };

      const onFinish = () => {
        cleanup();
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      stream.once("finish", onFinish);
      stream.on("error", onError);

      this.write(stream, options)
        .then(() => {
          stream.end();
        })
        .catch(err => {
          cleanup();
          reject(err);
        });
    });
  }

  async writeBuffer(options?: any): Promise<Buffer> {
    const stream = new StreamBuf();
    await this.write(stream, options);
    return stream.read();
  }

  static RelType = RelType;
}

export { XLSX };
