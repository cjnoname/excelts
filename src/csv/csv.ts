import fs from "fs";
import { StreamBuf } from "../utils/stream-buf.js";
import { format, parse } from "fast-csv";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import utc from "dayjs/plugin/utc.js";
import dayjs from "dayjs";
import { fileExists } from "../utils/utils.js";
import type { Workbook } from "../doc/workbook.js";
import type { Worksheet } from "../doc/worksheet.js";
import type { CellErrorValue } from "../types.js";

type HeaderArray = (string | undefined | null)[];
type HeaderTransformFunction = (headers: HeaderArray) => HeaderArray;

export interface FastCsvParserOptionsArgs {
  objectMode?: boolean;
  delimiter?: string;
  quote?: string | null;
  escape?: string;
  headers?: boolean | HeaderTransformFunction | HeaderArray;
  renameHeaders?: boolean;
  ignoreEmpty?: boolean;
  comment?: string;
  strictColumnHandling?: boolean;
  discardUnmappedColumns?: boolean;
  trim?: boolean;
  ltrim?: boolean;
  rtrim?: boolean;
  encoding?: string;
  maxRows?: number;
  skipLines?: number;
  skipRows?: number;
}

interface QuoteColumnMap {
  [s: string]: boolean;
}
type QuoteColumns = boolean | boolean[] | QuoteColumnMap;

interface RowMap {
  [key: string]: any;
}
type RowHashArray = [string, any][];
type RowArray = string[];
type Rows = RowArray | RowMap | RowHashArray;
type RowTransformCallback = (error?: Error | null, row?: Rows) => void;
interface RowTransformFunction {
  (row: Rows, callback: RowTransformCallback): void;
  (row: Rows): Rows;
}

export interface FastCsvFormatterOptionsArgs {
  objectMode?: boolean;
  delimiter?: string;
  rowDelimiter?: string;
  quote?: string | boolean;
  escape?: string;
  quoteColumns?: QuoteColumns;
  quoteHeaders?: QuoteColumns;
  headers?: null | boolean | string[];
  includeEndRowDelimiter?: boolean;
  writeBOM?: boolean;
  transform?: RowTransformFunction;
  alwaysWriteHeaders?: boolean;
}

export interface CsvReadOptions {
  dateFormats?: string[];
  map?(value: any, index: number): any;
  sheetName?: string;
  parserOptions?: Partial<FastCsvParserOptionsArgs>;
}

export interface CsvWriteOptions {
  dateFormat?: string;
  dateUTC?: boolean;
  sheetName?: string;
  sheetId?: number;
  encoding?: string;
  map?(value: any, index: number): any;
  includeEmptyRows?: boolean;
  formatterOptions?: Partial<FastCsvFormatterOptionsArgs>;
}

const SpecialValues: Record<string, boolean | CellErrorValue> = {
  true: true,
  false: false,
  "#N/A": { error: "#N/A" },
  "#REF!": { error: "#REF!" },
  "#NAME?": { error: "#NAME?" },
  "#DIV/0!": { error: "#DIV/0!" },
  "#NULL!": { error: "#NULL!" },
  "#VALUE!": { error: "#VALUE!" },
  "#NUM!": { error: "#NUM!" }
};

dayjs.extend(customParseFormat);
dayjs.extend(utc);

class CSV {
  declare public workbook: Workbook;
  declare public worksheet: Worksheet;

  constructor(workbook: Workbook) {
    this.workbook = workbook;
    this.worksheet = null;
  }

  async readFile(filename: string, options?: CsvReadOptions): Promise<Worksheet> {
    options = options || {};
    if (!(await fileExists(filename))) {
      throw new Error(`File not found: ${filename}`);
    }
    const stream = fs.createReadStream(filename);
    try {
      const worksheet = await this.read(stream, options);
      stream.close();
      return worksheet;
    } catch (error) {
      stream.close();
      throw error;
    }
  }

  read(stream: any, options?: CsvReadOptions): Promise<Worksheet> {
    options = options || {};

    return new Promise((resolve, reject) => {
      const worksheet = this.workbook.addWorksheet(options.sheetName);

      const dateFormats = options.dateFormats || [
        "YYYY-MM-DD[T]HH:mm:ssZ",
        "YYYY-MM-DD[T]HH:mm:ss",
        "MM-DD-YYYY",
        "YYYY-MM-DD"
      ];
      const map =
        options.map ||
        function (datum: any): any {
          if (datum === "") {
            return null;
          }
          const datumNumber = Number(datum);
          if (!Number.isNaN(datumNumber) && datumNumber !== Infinity) {
            return datumNumber;
          }
          const dt = dateFormats.reduce((matchingDate, currentDateFormat) => {
            if (matchingDate) {
              return matchingDate;
            }
            const dayjsObj = dayjs(datum, currentDateFormat, true);
            if (dayjsObj.isValid()) {
              return dayjsObj;
            }
            return null;
          }, null);
          if (dt) {
            return new Date(dt.valueOf());
          }
          const special = SpecialValues[datum];
          if (special !== undefined) {
            return special;
          }
          return datum;
        };

      const onData = (data: any[]) => {
        worksheet.addRow(data.map(map));
      };

      const onEnd = () => {
        csvStream.emit("worksheet", worksheet);
      };

      const cleanup = () => {
        csvStream.removeListener("data", onData);
        csvStream.removeListener("end", onEnd);
        csvStream.removeListener("worksheet", onWorksheet);
        csvStream.removeListener("error", onError);
      };

      const onWorksheet = (ws: Worksheet) => {
        cleanup();
        resolve(ws);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const csvStream = parse(options.parserOptions).on("data", onData).on("end", onEnd);

      csvStream.once("worksheet", onWorksheet).on("error", onError);

      stream.pipe(csvStream);
    });
  }

  write(stream: any, options?: CsvWriteOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      options = options || {};
      // const encoding = options.encoding || 'utf8';
      // const separator = options.separator || ',';
      // const quoteChar = options.quoteChar || '\'';

      const worksheet = this.workbook.getWorksheet(options.sheetName || options.sheetId);

      const csvStream = format(options.formatterOptions);

      const cleanup = () => {
        stream.removeListener("finish", onFinish);
        csvStream.removeListener("error", onError);
      };

      const onFinish = () => {
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      stream.once("finish", onFinish);
      csvStream.on("error", onError);
      csvStream.pipe(stream);

      const { dateFormat, dateUTC } = options;
      const map =
        options.map ||
        (value => {
          if (value) {
            if (value.text || value.hyperlink) {
              return value.hyperlink || value.text || "";
            }
            if (value.formula || value.result) {
              return value.result || "";
            }
            if (value instanceof Date) {
              if (dateFormat) {
                return dateUTC
                  ? dayjs.utc(value).format(dateFormat)
                  : dayjs(value).format(dateFormat);
              }
              return dateUTC ? dayjs.utc(value).format() : dayjs(value).format();
            }
            if (value.error) {
              return value.error;
            }
            if (typeof value === "object") {
              return JSON.stringify(value);
            }
          }
          return value;
        });

      const includeEmptyRows = options.includeEmptyRows === undefined || options.includeEmptyRows;
      let lastRow = 1;
      if (worksheet) {
        worksheet.eachRow((row: any, rowNumber: number) => {
          if (includeEmptyRows) {
            while (lastRow++ < rowNumber - 1) {
              csvStream.write([]);
            }
          }
          const { values } = row;
          values.shift();
          csvStream.write(values.map(map));
          lastRow = rowNumber;
        });
      }
      csvStream.end();
    });
  }

  writeFile(filename: string, options?: CsvWriteOptions): Promise<void> {
    options = options || {};

    const streamOptions = {
      encoding: (options.encoding || "utf8") as BufferEncoding
    };
    const stream = fs.createWriteStream(filename, streamOptions);

    return this.write(stream, options);
  }

  async writeBuffer(options?: CsvWriteOptions): Promise<Buffer> {
    const stream = new StreamBuf();
    await this.write(stream, options);
    return stream.read();
  }
}

export { CSV };
