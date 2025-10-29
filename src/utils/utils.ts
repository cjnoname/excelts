import fs from "fs";

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function nop(): void {}

export function promiseImmediate<T>(value: T): Promise<T> {
  return new Promise(resolve => {
    if ((global as any).setImmediate) {
      setImmediate(() => {
        resolve(value);
      });
    } else {
      // poorman's setImmediate - must wait at least 1ms
      setTimeout(() => {
        resolve(value);
      }, 1);
    }
  });
}

// useful stuff
export const inherits = function <
  T extends new (...args: any[]) => any,
  S extends new (...args: any[]) => any
>(cls: T, superCtor: S, statics?: any, prototype?: any): void {
  (cls as any).super_ = superCtor;

  if (!prototype) {
    prototype = statics;
    statics = null;
  }

  if (statics) {
    Object.keys(statics).forEach(i => {
      Object.defineProperty(cls, i, Object.getOwnPropertyDescriptor(statics, i)!);
    });
  }

  const properties: PropertyDescriptorMap = {
    constructor: {
      value: cls,
      enumerable: false,
      writable: false,
      configurable: true
    }
  };
  if (prototype) {
    Object.keys(prototype).forEach(i => {
      properties[i] = Object.getOwnPropertyDescriptor(prototype, i)!;
    });
  }

  cls.prototype = Object.create(superCtor.prototype, properties);
};

interface PathInfo {
  path: string;
  name: string;
}

export function dateToExcel(d: Date, date1904?: boolean): number {
  return 25569 + d.getTime() / (24 * 3600 * 1000) - (date1904 ? 1462 : 0);
}

export function excelToDate(v: number, date1904?: boolean): Date {
  const millisecondSinceEpoch = Math.round((v - 25569 + (date1904 ? 1462 : 0)) * 24 * 3600 * 1000);
  return new Date(millisecondSinceEpoch);
}

export function parsePath(filepath: string): PathInfo {
  const last = filepath.lastIndexOf("/");
  return {
    path: filepath.substring(0, last),
    name: filepath.substring(last + 1)
  };
}

export function getRelsPath(filepath: string): string {
  const path = parsePath(filepath);
  return `${path.path}/_rels/${path.name}.rels`;
}

// oxlint-disable-next-line no-control-regex -- Control characters are intentionally matched for XML encoding
const xmlDecodeRegex = /[<>&'"\x7F\x00-\x08\x0B-\x0C\x0E-\x1F]/;

export function xmlEncode(text: string): string {
  const regexResult = xmlDecodeRegex.exec(text);
  if (!regexResult) {
    return text;
  }

  let result = "";
  let escape = "";
  let lastIndex = 0;
  let i = regexResult.index;
  for (; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    switch (charCode) {
      case 34: // "
        escape = "&quot;";
        break;
      case 38: // &
        escape = "&amp;";
        break;
      case 39: // '
        escape = "&apos;";
        break;
      case 60: // <
        escape = "&lt;";
        break;
      case 62: // >
        escape = "&gt;";
        break;
      case 127:
        escape = "";
        break;
      default: {
        if (charCode <= 31 && (charCode <= 8 || (charCode >= 11 && charCode !== 13))) {
          escape = "";
          break;
        }
        continue;
      }
    }
    if (lastIndex !== i) {
      result += text.substring(lastIndex, i);
    }
    lastIndex = i + 1;
    if (escape) {
      result += escape;
    }
  }
  if (lastIndex !== i) {
    return result + text.substring(lastIndex, i);
  }
  return result;
}

export function xmlDecode(text: string): string {
  return text.replace(/&([a-z]*);/g, c => {
    switch (c) {
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&amp;":
        return "&";
      case "&apos;":
        return "'";
      case "&quot;":
        return '"';
      default:
        return c;
    }
  });
}

export function validInt(value: string | number): number {
  const i = parseInt(value as string, 10);
  return !Number.isNaN(i) ? i : 0;
}

export function isDateFmt(fmt: string | null | undefined): boolean {
  if (!fmt) {
    return false;
  }

  // must remove all chars inside quotes and []
  fmt = fmt.replace(/\[[^\]]*]/g, "");
  fmt = fmt.replace(/"[^"]*"/g, "");
  // then check for date formatting chars
  const result = fmt.match(/[ymdhMsb]+/) !== null;
  return result;
}

export function fileExists(path: string): Promise<boolean> {
  return new Promise(resolve => {
    fs.access(path, fs.constants.F_OK, err => {
      resolve(!err);
    });
  });
}

export function toIsoDateString(dt: Date): string {
  return dt.toISOString().substr(0, 10);
}

export function parseBoolean(value: any): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function* range(start: number, stop: number, step: number = 1): Generator<number> {
  const compareOrder = step > 0 ? (a: number, b: number) => a < b : (a: number, b: number) => a > b;
  for (let value = start; compareOrder(value, stop); value += step) {
    yield value;
  }
}

export function toSortedArray(values: Iterable<any>): any[] {
  const result = Array.from(values);

  // Note: per default, `Array.prototype.sort()` converts values
  // to strings when comparing. Here, if we have numbers, we use
  // numeric sort.
  if (result.every(item => Number.isFinite(item))) {
    const compareNumbers = (a: number, b: number) => a - b;
    return result.sort(compareNumbers);
  }

  return result.sort();
}

export function objectFromProps<T = any>(
  props: string[],
  value: T | null = null
): Record<string, T | null> {
  return props.reduce((result: Record<string, T | null>, property: string) => {
    result[property] = value;
    return result;
  }, {});
}

// Legacy export for backward compatibility
/** @deprecated Import functions directly instead of using the utils object */
export const utils = {
  nop,
  promiseImmediate,
  inherits,
  dateToExcel,
  excelToDate,
  parsePath,
  getRelsPath,
  xmlEncode,
  xmlDecode,
  validInt,
  isDateFmt,
  fs: {
    exists: fileExists
  },
  toIsoDateString,
  parseBoolean,
  range,
  toSortedArray,
  objectFromProps
};
