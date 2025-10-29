import { Worksheet } from "./worksheet.js";
import { DefinedNames } from "./defined-names.js";
import { XLSX } from "../xlsx/xlsx.js";
import { CSV } from "../csv/csv.js";

interface WorksheetModel {
  id: number;
  name: string;
  state?: string;
  [key: string]: any;
}

interface WorkbookModel {
  creator?: string;
  lastModifiedBy?: string;
  lastPrinted?: Date;
  created: Date;
  modified: Date;
  properties: any;
  worksheets: WorksheetModel[];
  sheets?: WorksheetModel[];
  definedNames: any;
  views: any[];
  company: string;
  manager: string;
  title: string;
  subject: string;
  keywords: string;
  category: string;
  description: string;
  language?: string;
  revision?: number;
  contentStatus?: string;
  themes?: any;
  media: any[];
  pivotTables: any[];
  calcProperties: any;
}

interface AddWorksheetOptions {
  properties?: any;
  views?: any[];
  pageSetup?: any;
  headerFooter?: any;
  [key: string]: any;
}

// Workbook requirements
//  Load and Save from file and stream
//  Access/Add/Delete individual worksheets
//  Manage String table, Hyperlink table, etc.
//  Manage scaffolding for contained objects to write to/read from

class Workbook {
  declare public category: string;
  declare public company: string;
  declare public created: Date;
  declare public description: string;
  declare public keywords: string;
  declare public manager: string;
  declare public modified: Date;
  declare public properties: any;
  declare public calcProperties: any;
  declare public _worksheets: Worksheet[];
  declare public subject: string;
  declare public title: string;
  declare public views: any[];
  declare public media: any[];
  declare public pivotTables: any[];
  declare public _definedNames: DefinedNames;
  declare public creator?: string;
  declare public lastModifiedBy?: string;
  declare public lastPrinted?: Date;
  declare public language?: string;
  declare public revision?: number;
  declare public contentStatus?: string;
  declare public _themes?: any;
  declare public _xlsx?: XLSX;
  declare public _csv?: CSV;

  constructor() {
    this.category = "";
    this.company = "";
    this.created = new Date();
    this.description = "";
    this.keywords = "";
    this.manager = "";
    this.modified = this.created;
    this.properties = {};
    this.calcProperties = {};
    this._worksheets = [];
    this.subject = "";
    this.title = "";
    this.views = [];
    this.media = [];
    this.pivotTables = [];
    this._definedNames = new DefinedNames();
  }

  get xlsx(): XLSX {
    if (!this._xlsx) {
      this._xlsx = new XLSX(this);
    }
    return this._xlsx;
  }

  get csv(): CSV {
    if (!this._csv) {
      this._csv = new CSV(this);
    }
    return this._csv;
  }

  get nextId(): number {
    // find the next unique spot to add worksheet
    for (let i = 1; i < this._worksheets.length; i++) {
      if (!this._worksheets[i]) {
        return i;
      }
    }
    return this._worksheets.length || 1;
  }

  addWorksheet(name?: string, options?: AddWorksheetOptions): Worksheet {
    const id = this.nextId;

    const lastOrderNo = this._worksheets.reduce(
      (acc, ws) => ((ws && ws.orderNo) > acc ? ws.orderNo : acc),
      0
    );
    const worksheetOptions = Object.assign({}, options, {
      id,
      name,
      orderNo: lastOrderNo + 1,
      workbook: this
    });

    const worksheet = new Worksheet(worksheetOptions);

    this._worksheets[id] = worksheet;
    return worksheet;
  }

  removeWorksheetEx(worksheet: Worksheet): void {
    delete this._worksheets[worksheet.id];
  }

  removeWorksheet(id: number | string): void {
    const worksheet = this.getWorksheet(id);
    if (worksheet) {
      worksheet.destroy();
    }
  }

  getWorksheet(id?: number | string): Worksheet | undefined {
    if (id === undefined) {
      return this._worksheets.find(Boolean);
    }
    if (typeof id === "number") {
      return this._worksheets[id];
    }
    if (typeof id === "string") {
      return this._worksheets.find(worksheet => worksheet && worksheet.name === id);
    }
    return undefined;
  }

  get worksheets(): Worksheet[] {
    // return a clone of _worksheets
    return this._worksheets
      .slice(1)
      .sort((a, b) => a.orderNo - b.orderNo)
      .filter(Boolean);
  }

  eachSheet(iteratee: (sheet: Worksheet, id: number) => void): void {
    this.worksheets.forEach(sheet => {
      iteratee(sheet, sheet.id);
    });
  }

  get definedNames(): DefinedNames {
    return this._definedNames;
  }

  clearThemes(): void {
    // Note: themes are not an exposed feature, meddle at your peril!
    this._themes = undefined;
  }

  addImage(image: any): number {
    // TODO:  validation?
    const id = this.media.length;
    this.media.push(Object.assign({}, image, { type: "image" }));
    return id;
  }

  getImage(id: number): any {
    return this.media[id];
  }

  get model(): WorkbookModel {
    return {
      creator: this.creator || "Unknown",
      lastModifiedBy: this.lastModifiedBy || "Unknown",
      lastPrinted: this.lastPrinted,
      created: this.created,
      modified: this.modified,
      properties: this.properties,
      worksheets: this.worksheets.map(worksheet => worksheet.model),
      sheets: this.worksheets.map(ws => ws.model).filter(Boolean),
      definedNames: this._definedNames.model,
      views: this.views,
      company: this.company,
      manager: this.manager,
      title: this.title,
      subject: this.subject,
      keywords: this.keywords,
      category: this.category,
      description: this.description,
      language: this.language,
      revision: this.revision,
      contentStatus: this.contentStatus,
      themes: this._themes,
      media: this.media,
      pivotTables: this.pivotTables,
      calcProperties: this.calcProperties
    };
  }

  set model(value: WorkbookModel) {
    this.creator = value.creator;
    this.lastModifiedBy = value.lastModifiedBy;
    this.lastPrinted = value.lastPrinted;
    this.created = value.created;
    this.modified = value.modified;
    this.company = value.company;
    this.manager = value.manager;
    this.title = value.title;
    this.subject = value.subject;
    this.keywords = value.keywords;
    this.category = value.category;
    this.description = value.description;
    this.language = value.language;
    this.revision = value.revision;
    this.contentStatus = value.contentStatus;

    this.properties = value.properties;
    this.calcProperties = value.calcProperties;
    this._worksheets = [];
    value.worksheets.forEach(worksheetModel => {
      const { id, name, state } = worksheetModel;
      const orderNo = value.sheets && value.sheets.findIndex(ws => ws.id === id);
      const worksheet = (this._worksheets[id] = new Worksheet({
        id,
        name,
        orderNo: orderNo !== -1 ? orderNo : undefined,
        state,
        workbook: this
      }));
      worksheet.model = worksheetModel as any;
    });

    this._definedNames.model = value.definedNames;
    this.views = value.views;
    this._themes = value.themes;
    this.media = value.media || [];
    this.pivotTables = value.pivotTables || [];
  }
}

export { Workbook };
