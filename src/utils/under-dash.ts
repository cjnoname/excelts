const { toString } = Object.prototype;
const escapeHtmlRegex = /["&<>]/;

export function isEqual(a: any, b: any): boolean {
  const aType = typeof a;
  const bType = typeof b;
  const aArray = Array.isArray(a);
  const bArray = Array.isArray(b);
  let keys: string[];

  if (aType !== bType) {
    return false;
  }
  switch (typeof a) {
    case "object":
      if (aArray || bArray) {
        if (aArray && bArray) {
          return (
            a.length === b.length &&
            a.every((aValue: any, index: number) => {
              const bValue = b[index];
              return isEqual(aValue, bValue);
            })
          );
        }
        return false;
      }

      if (a === null || b === null) {
        return a === b;
      }

      // Compare object keys and values
      keys = Object.keys(a);

      if (Object.keys(b).length !== keys.length) {
        return false;
      }

      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) {
          return false;
        }
      }

      return keys.every(key => {
        const aValue = a[key];
        const bValue = b[key];
        return isEqual(aValue, bValue);
      });

    default:
      return a === b;
  }
}

export function escapeHtml(html: string): string {
  const regexResult = escapeHtmlRegex.exec(html);
  if (!regexResult) {
    return html;
  }

  let result = "";
  let escape = "";
  let lastIndex = 0;
  let i = regexResult.index;
  for (; i < html.length; i++) {
    switch (html.charAt(i)) {
      case '"':
        escape = "&quot;";
        break;
      case "&":
        escape = "&amp;";
        break;
      case "<":
        escape = "&lt;";
        break;
      case ">":
        escape = "&gt;";
        break;
      default:
        continue;
    }
    if (lastIndex !== i) {
      result += html.substring(lastIndex, i);
    }
    lastIndex = i + 1;
    result += escape;
  }
  if (lastIndex !== i) {
    return result + html.substring(lastIndex, i);
  }
  return result;
}

export function isUndefined(val: any): val is undefined {
  return toString.call(val) === "[object Undefined]";
}

export function isObject(val: any): val is Record<string, any> {
  return toString.call(val) === "[object Object]";
}

export function deepMerge<T = any>(...args: any[]): T {
  const target: any = args[0] || {};
  const { length } = args;
  let src: any, clone: any, copyIsArray: boolean;

  function assignValue(val: any, key: string | number): void {
    src = target[key];
    copyIsArray = Array.isArray(val);
    if (isObject(val) || copyIsArray) {
      if (copyIsArray) {
        copyIsArray = false;
        clone = src && Array.isArray(src) ? src : [];
      } else {
        clone = src && isObject(src) ? src : {};
      }
      target[key] = deepMerge(clone, val);
    } else if (!isUndefined(val)) {
      target[key] = val;
    }
  }

  for (let i = 0; i < length; i++) {
    const arg = args[i];
    if (arg) {
      if (Array.isArray(arg)) {
        arg.forEach((val, index) => assignValue(val, index));
      } else {
        Object.entries(arg).forEach(([key, val]) => {
          // Prevent prototype pollution
          if (key === "__proto__" || key === "constructor" || key === "prototype") {
            return;
          }
          assignValue(val, key);
        });
      }
    }
  }
  return target;
}

export function cloneDeep(obj: any, preserveUndefined?: boolean): any {
  if (preserveUndefined === undefined) {
    preserveUndefined = true;
  }
  let clone: any;
  if (obj === null) {
    return null;
  }
  if (obj instanceof Date) {
    return obj;
  }
  if (obj instanceof Array) {
    clone = [];
    obj.forEach((value: any, index: number) => {
      if (value !== undefined) {
        clone[index] = cloneDeep(value, preserveUndefined);
      } else if (preserveUndefined) {
        clone[index] = undefined;
      }
    });
  } else if (typeof obj === "object") {
    clone = {};
    Object.keys(obj).forEach(name => {
      const value = obj[name];
      if (value !== undefined) {
        clone[name] = cloneDeep(value, preserveUndefined);
      } else if (preserveUndefined) {
        clone[name] = undefined;
      }
    });
  } else {
    return obj;
  }
  return clone;
}

export function get<T = any>(obj: any, path: string, defaultValue?: T): T {
  const keys = path.split(".");
  return keys.reduce((result, key) => result?.[key], obj) ?? defaultValue;
}
