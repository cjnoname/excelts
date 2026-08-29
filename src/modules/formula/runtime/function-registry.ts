/**
 * Function Registry — Declarative function descriptors and native implementations.
 *
 * Each function is described by a `FunctionDescriptor` that carries metadata
 * about arity and the implementation itself. The evaluator uses this metadata
 * to validate arguments and invoke functions.
 *
 * Special forms (IF, LET, LAMBDA, etc.) are NOT registered here — they
 * are handled directly by the evaluator's special-form dispatch.
 */

import type { FunctionRuntimeContext } from "@formula/runtime/function-context";
import type { RuntimeValue, ScalarValue } from "@formula/runtime/values";
import {
  RVKind,
  BLANK,
  ERRORS,
  rvBoolean,
  rvNumber,
  rvString,
  toNumberRV,
  toStringRV,
  topLeft
} from "@formula/runtime/values";
import { stripFunctionPrefix } from "@formula/syntax/token-types";

// ============================================================================
// Function Descriptor
// ============================================================================

/**
 * A function descriptor with metadata and implementation.
 */
export interface FunctionDescriptor {
  /** Canonical uppercase name. */
  readonly name: string;
  /** Minimum number of arguments. */
  readonly minArity: number;
  /** Maximum number of arguments. Infinity for variadic. */
  readonly maxArity: number;
  readonly volatile?: boolean;
  /**
   * The function implementation.
   * Receives eagerly evaluated arguments as `RuntimeValue[]`.
   * Returns a `RuntimeValue`.
   */
  readonly invoke: (args: RuntimeValue[], context: FunctionRuntimeContext) => RuntimeValue;
}

// ============================================================================
// Registry
// ============================================================================

/**
 * The function registry.
 *
 * Maps uppercase canonical function names to their descriptors.
 * Also handles _XLFN. and _XLFN._XLWS. prefix variants.
 */
const registryMap = new Map<string, FunctionDescriptor>();

/**
 * Register a function descriptor. The descriptor is stored under its
 * canonical (unprefixed) name only — `_XLFN.` / `_XLFN._XLWS.` prefix
 * variants are resolved dynamically in `lookupFunction`. This keeps the
 * registry small and avoids triple-entry bookkeeping for 200+ functions.
 */
function registerFunction(desc: FunctionDescriptor): void {
  registryMap.set(desc.name, desc);
}

/**
 * Look up a function by uppercase name. Accepts `_XLFN.` and
 * `_XLFN._XLWS.` prefixed variants by stripping the prefix before lookup
 * (a no-op for plain names, so plain lookups also go through a single
 * Map.get call — avoiding the double-lookup pattern used previously).
 *
 * Fast-path: the overwhelming majority of lookups use plain names
 * (`SUM`, `IF`, `VLOOKUP`, …). Checking the prefix sentinel byte up
 * front lets those callers skip the `slice`/`startsWith` machinery in
 * `stripFunctionPrefix` entirely.
 */
export function lookupFunction(name: string): FunctionDescriptor | undefined {
  // Lazily assemble the native function table on first lookup. Initialization
  // is NOT a module-level side effect (which would conflict with the package's
  // `sideEffects: false` and force the whole function table into any bundle
  // that merely references `lookupFunction`). Instead it is driven by the
  // evaluator's first call — mirroring the chart renderer's "execute on call,
  // never at import" contract. The `initialized` guard makes repeat calls O(1).
  ensureRegistryInitialized();
  // Plain names don't start with `_` — skip the prefix-strip call.
  if (name.length === 0 || name.charCodeAt(0) !== 95 /* `_` */) {
    return registryMap.get(name);
  }
  return registryMap.get(stripFunctionPrefix(name));
}

/**
 * Every canonical function name the registry holds.
 *
 * The registry is the only authority on how many functions exist, and until this
 * existed there was no way to ask: `lookupFunction` answers about one name, and the
 * map is private. So the count lived in prose instead — sixteen occurrences across
 * ten files, including two in this file's own comments — and drifted, stating 433
 * while the table had grown to 448. A number a reader cannot derive is a number
 * nobody can maintain.
 *
 * Names are canonical and unprefixed; `_XLFN.` variants are resolved on lookup and
 * are not separate entries.
 *
 * Carries the same cost as `lookupFunction`: calling it assembles the table, so it
 * belongs to consumers that want the catalogue (documentation, tooling), not to a
 * syntax-only path that must stay free of it.
 */
export function listFunctionNames(): readonly string[] {
  ensureRegistryInitialized();
  return [...registryMap.keys()];
}

/**
 * Convenience: define and register an eager function.
 */
export function defineEager(
  name: string,
  minArity: number,
  maxArity: number,
  invoke: (args: RuntimeValue[], context: FunctionRuntimeContext) => RuntimeValue
): FunctionDescriptor {
  const desc: FunctionDescriptor = {
    name,
    minArity,
    maxArity,
    invoke
  };
  registerFunction(desc);
  return desc;
}

// ============================================================================
// Registry Initialization
// ============================================================================

/**
 * Initialize the registry with all native function implementations.
 *
 * Internal + lazy: invoked by `lookupFunction` on first use, never at module
 * load. This keeps `function-registry` free of top-level side effects so the
 * native function table is only pulled into bundles that actually evaluate
 * formulas (the `documonster/excel/formula` path), not syntax-only consumers.
 */
let initialized = false;

function ensureRegistryInitialized(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  // Register native functions first — metadata + implementation co-located.
  registerNativeInformationAndLogical();
  registerNativeTextFunctions();
  registerNativeDateFunctions();
  registerNativeEngineeringFunctions();
  registerNativeFinancialFunctions();
  registerNativeStatisticalFunctions();
  registerNativeMathFunctions();
  registerNativeConditionalFunctions();
  registerNativeLookupFunctions();
  registerNativeDynamicArrayFunctions();
  registerNativeDatabaseFunctions();
}

// ============================================================================
// Native Function Implementations
// ============================================================================

/**
 * Register native implementations for information and logical functions.
 * Metadata and implementation are co-located as the single source of truth.
 */
function registerNativeInformationAndLogical(): void {
  const scalar = (args: RuntimeValue[]): ScalarValue => topLeft(args[0] ?? BLANK);

  // ── Information ──
  defineEager("ISNUMBER", 1, 1, args => rvBoolean(scalar(args).kind === RVKind.Number));
  defineEager("ISTEXT", 1, 1, args => rvBoolean(scalar(args).kind === RVKind.String));
  defineEager("ISBLANK", 1, 1, args => rvBoolean(scalar(args).kind === RVKind.Blank));
  defineEager("ISLOGICAL", 1, 1, args => rvBoolean(scalar(args).kind === RVKind.Boolean));
  defineEager("ISERROR", 1, 1, args => rvBoolean(scalar(args).kind === RVKind.Error));
  defineEager("ISERR", 1, 1, args => {
    const v = scalar(args);
    return rvBoolean(v.kind === RVKind.Error && v.code !== "#N/A");
  });
  defineEager("ISNA", 1, 1, args => {
    const v = scalar(args);
    return rvBoolean(v.kind === RVKind.Error && v.code === "#N/A");
  });
  defineEager("ISNONTEXT", 1, 1, args => rvBoolean(scalar(args).kind !== RVKind.String));
  defineEager("ISEVEN", 1, 1, args => {
    const v = scalar(args);
    if (v.kind === RVKind.Error) {
      return v;
    }
    // Excel coerces numeric strings and booleans for ISEVEN / ISODD
    // (e.g. `ISEVEN("3")` → FALSE, `ISODD(TRUE)` → TRUE). Only genuine
    // non-numeric text falls through to #VALUE!. Previously we rejected
    // every non-Number kind outright.
    const n = toNumberRV(v);
    if (n.kind === RVKind.Error) {
      return ERRORS.VALUE;
    }
    return rvBoolean(Math.floor(Math.abs(n.value)) % 2 === 0);
  });
  defineEager("ISODD", 1, 1, args => {
    const v = scalar(args);
    if (v.kind === RVKind.Error) {
      return v;
    }
    const n = toNumberRV(v);
    if (n.kind === RVKind.Error) {
      return ERRORS.VALUE;
    }
    return rvBoolean(Math.floor(Math.abs(n.value)) % 2 === 1);
  });
  defineEager("N", 1, 1, args => {
    const v = scalar(args);
    if (v.kind === RVKind.Number) {
      return v;
    }
    if (v.kind === RVKind.Boolean) {
      return rvNumber(v.value ? 1 : 0);
    }
    if (v.kind === RVKind.Error) {
      return v;
    }
    return rvNumber(0);
  });
  defineEager("TYPE", 1, 1, args => {
    // Check for array BEFORE topLeft extraction
    if (args[0]?.kind === RVKind.Array) {
      return rvNumber(64);
    }
    const v = scalar(args);
    switch (v.kind) {
      case RVKind.Number:
        return rvNumber(1);
      case RVKind.String:
        return rvNumber(2);
      case RVKind.Boolean:
        return rvNumber(4);
      case RVKind.Error:
        return rvNumber(16);
      default:
        return rvNumber(1);
    }
  });
  defineEager("ERROR.TYPE", 1, 1, args => {
    const v = scalar(args);
    if (v.kind !== RVKind.Error) {
      return ERRORS.NA;
    }
    const map: Record<string, number> = {
      "#NULL!": 1,
      "#DIV/0!": 2,
      "#VALUE!": 3,
      "#REF!": 4,
      "#NAME?": 5,
      "#NUM!": 6,
      "#N/A": 7
    };
    return map[v.code] !== undefined ? rvNumber(map[v.code]) : ERRORS.NA;
  });
  defineEager("NA", 0, 0, () => ERRORS.NA);
  // TRUE() and FALSE() — Excel accepts both the literal and the
  // zero-arg function form. The tokenizer routes `TRUE(` to a Function
  // token, so we need to register these so the call binds.
  defineEager("TRUE", 0, 0, () => rvBoolean(true));
  defineEager("FALSE", 0, 0, () => rvBoolean(false));

  // ── Stubs — limited implementations for functions that need runtime context ──
  // INFO returns a handful of environment-describing strings. We implement
  // the subset that's meaningful in a headless engine: `"release"` (engine
  // version — we use "16.0" to pretend to be a modern Excel), `"system"`
  // (the host OS string — the platform that loaded the workbook), and
  // `"numfile"` / `"origin"` (which require UI context and are always
  // `#N/A`).
  defineEager("INFO", 1, 1, args => {
    if (args.length === 0) {
      return ERRORS.NA;
    }
    // Implicit intersection — without topLeft, passing an array would
    // route through the default `.value = ""` branch and silently
    // surface #VALUE! instead of using the first cell.
    const t = topLeft(args[0]);
    if (t.kind === RVKind.Error) {
      return t;
    }
    const info = (t.kind === RVKind.String ? t.value : "").toLowerCase();
    switch (info) {
      case "release":
        return rvString("16.0");
      case "osversion":
        return rvString(
          `${typeof process !== "undefined" && process.platform ? process.platform : "browser"}`
        );
      case "system":
        // Excel reports "pcdos" or "mac"; we map Node's platform string so
        // tests that grep for these values behave consistently.
        if (typeof process !== "undefined" && process.platform) {
          return rvString(process.platform === "darwin" ? "mac" : "pcdos");
        }
        return rvString("pcdos");
      case "recalc":
        return rvString("Automatic");
      case "directory":
      case "numfile":
      case "origin":
        return ERRORS.NA;
      default:
        return ERRORS.VALUE;
    }
  });
  // CELL: the evaluator intercepts CELL before this point and handles the
  // supported info-type subset (address, row, col, contents, type, width,
  // filename). This fallback only fires if an argument arrangement bypasses
  // the interception — in which case #N/A matches Excel for unsupported info.
  defineEager("CELL", 1, 2, () => ERRORS.NA);
  // ISREF: the evaluator intercepts ISREF before this point and decides
  // based on the raw BoundExpr / runtime ReferenceValue. This fallback only
  // fires if an argument arrangement bypasses the interception — after
  // dereferencing the answer is always false.
  defineEager("ISREF", 1, 1, () => rvBoolean(false));
  // SHEET/SHEETS: would need full workbook context — returns 1 as default
  defineEager("SHEET", 0, 1, () => rvNumber(1));
  defineEager("SHEETS", 0, 1, () => rvNumber(1));
  // ISFORMULA / FORMULATEXT: need evaluator-level reference inspection.
  // The evaluator intercepts these when the argument is a CellRef/AreaRef;
  // these stubs only run when the argument has been dereferenced to a value,
  // in which case the answer is false / #N/A respectively.
  defineEager("ISFORMULA", 1, 1, () => rvBoolean(false));
  defineEager("FORMULATEXT", 1, 1, () => ERRORS.NA);
  // HYPERLINK: simplified semantics — return the friendly name if provided,
  // otherwise the URL. The link behavior is outside the calculation engine.
  defineEager("HYPERLINK", 1, 2, args => {
    const display = args.length > 1 ? topLeft(args[1]) : topLeft(args[0]);
    if (display.kind === RVKind.Error) {
      return display;
    }
    if (display.kind === RVKind.Blank) {
      // If friendly_name was an empty/blank cell, fall back to URL.
      const url = topLeft(args[0]);
      if (url.kind === RVKind.Error) {
        return url;
      }
      // Previously `String(url)` stringified a RuntimeValue object to
      // the literal `"[object Object]"`. Route through `toStringRV`
      // so numbers / booleans / blanks produce the expected text.
      return rvString(toStringRV(url));
    }
    if (display.kind === RVKind.String) {
      return display;
    }
    if (display.kind === RVKind.Number) {
      return rvString(String(display.value));
    }
    if (display.kind === RVKind.Boolean) {
      return rvString(display.value ? "TRUE" : "FALSE");
    }
    return rvString("");
  });

  // ── Logical ──
  defineEager("NOT", 1, 1, args => {
    const v = scalar(args);
    if (v.kind === RVKind.Error) {
      return v;
    }
    if (v.kind === RVKind.Boolean) {
      return rvBoolean(!v.value);
    }
    if (v.kind === RVKind.Number) {
      return rvBoolean(v.value === 0);
    }
    // Excel accepts "TRUE" / "FALSE" strings (case-insensitive) and
    // Blank cells (treated as FALSE). Previously any non-boolean,
    // non-numeric kind fell through to #VALUE!.
    if (v.kind === RVKind.Blank) {
      return rvBoolean(true);
    }
    if (v.kind === RVKind.String) {
      const upper = v.value.toUpperCase();
      if (upper === "TRUE") {
        return rvBoolean(false);
      }
      if (upper === "FALSE") {
        return rvBoolean(true);
      }
    }
    return ERRORS.VALUE;
  });

  defineEager("AND", 1, 255, args => boolAggregate(args, true, (cur, val) => cur && val));
  defineEager("OR", 1, 255, args => boolAggregate(args, false, (cur, val) => cur || val));
  defineEager("XOR", 1, 255, args => {
    let count = 0;
    let found = false;
    for (const arg of args) {
      const r = walkBoolArg(arg, v => {
        // `found` must only flip when `walkBoolArg` actually visits a
        // boolean-like cell. The previous code set it after every
        // argument (even BLANK/empty ranges), so `XOR(A1, B1)` on two
        // empty cells returned FALSE; Excel returns #VALUE!.
        found = true;
        if (v) {
          count++;
        }
      });
      if (r) {
        return r;
      }
    }
    return found ? rvBoolean(count % 2 === 1) : ERRORS.VALUE;
  });
}

/**
 * Helper: aggregate boolean args (for AND/OR).
 */
function boolAggregate(
  args: RuntimeValue[],
  init: boolean,
  combine: (cur: boolean, val: boolean) => boolean
): RuntimeValue {
  let result = init;
  let found = false;
  for (const arg of args) {
    const err = walkBoolArg(arg, v => {
      found = true;
      result = combine(result, v);
    });
    if (err) {
      return err;
    }
  }
  return found ? rvBoolean(result) : ERRORS.VALUE;
}

/**
 * Helper: walk a single argument for boolean aggregation.
 * Returns an error value if one is encountered, otherwise undefined.
 */
function walkBoolArg(arg: RuntimeValue, cb: (val: boolean) => void): RuntimeValue | undefined {
  if (arg.kind === RVKind.Error) {
    return arg;
  }
  if (arg.kind === RVKind.Array) {
    for (const row of arg.rows) {
      for (const cell of row) {
        if (cell.kind === RVKind.Error) {
          return cell;
        }
        if (cell.kind === RVKind.Boolean) {
          cb(cell.value);
        } else if (cell.kind === RVKind.Number) {
          cb(cell.value !== 0);
        }
      }
    }
    return undefined;
  }
  const v = topLeft(arg);
  if (v.kind === RVKind.Error) {
    return v;
  }
  if (v.kind === RVKind.Boolean) {
    cb(v.value);
  } else if (v.kind === RVKind.Number) {
    cb(v.value !== 0);
  } else if (v.kind === RVKind.String) {
    const upper = v.value.toUpperCase();
    if (upper === "TRUE") {
      cb(true);
    } else if (upper === "FALSE") {
      cb(false);
    } else {
      return ERRORS.VALUE;
    }
  } else if (v.kind !== RVKind.Blank) {
    return ERRORS.VALUE;
  }
  return undefined;
}

// ============================================================================
// Native Text Functions
// ============================================================================

import {
  fnCONCATENATE,
  fnCONCAT,
  fnTEXTJOIN,
  fnLEFT,
  fnRIGHT,
  fnMID,
  fnLEN,
  fnTRIM,
  fnLOWER,
  fnUPPER,
  fnPROPER,
  fnSUBSTITUTE,
  fnREPLACE,
  fnFIND,
  fnSEARCH,
  fnREPT,
  fnTEXT,
  fnVALUE,
  fnEXACT,
  fnCODE,
  fnCHAR,
  fnCLEAN,
  fnT,
  fnUNICHAR,
  fnUNICODE,
  fnBAHTTEXT,
  fnDOLLAR,
  fnFIXED,
  fnASC,
  fnDBCS,
  fnJIS,
  fnPHONETIC,
  fnNUMBERVALUE,
  fnTEXTBEFORE,
  fnTEXTAFTER,
  fnTEXTSPLIT,
  fnREGEXTEST,
  fnREGEXEXTRACT,
  fnREGEXREPLACE,
  fnVALUETOTEXT,
  fnARRAYTOTEXT,
  fnENCODEURL
} from "@formula/functions/text";

function registerNativeTextFunctions(): void {
  defineEager("CONCATENATE", 1, 255, fnCONCATENATE);
  defineEager("CONCAT", 1, 255, fnCONCAT);
  defineEager("TEXTJOIN", 3, 255, fnTEXTJOIN);
  defineEager("LEFT", 1, 2, fnLEFT);
  defineEager("LEFTB", 1, 2, fnLEFT);
  defineEager("RIGHT", 1, 2, fnRIGHT);
  defineEager("RIGHTB", 1, 2, fnRIGHT);
  defineEager("MID", 3, 3, fnMID);
  defineEager("MIDB", 3, 3, fnMID);
  defineEager("LEN", 1, 1, fnLEN);
  defineEager("LENB", 1, 1, fnLEN);
  defineEager("TRIM", 1, 1, fnTRIM);
  defineEager("LOWER", 1, 1, fnLOWER);
  defineEager("UPPER", 1, 1, fnUPPER);
  defineEager("PROPER", 1, 1, fnPROPER);
  defineEager("SUBSTITUTE", 3, 4, fnSUBSTITUTE);
  defineEager("REPLACE", 4, 4, fnREPLACE);
  // REPLACEB is REPLACE's double-byte alias. In non-DBCS locales Excel
  // treats them identically, so aliasing to the same implementation
  // matches behaviour without duplicating logic (matches the existing
  // LEFTB / RIGHTB / MIDB / LENB / FINDB / SEARCHB wiring below).
  defineEager("REPLACEB", 4, 4, fnREPLACE);
  defineEager("FIND", 2, 3, fnFIND);
  defineEager("FINDB", 2, 3, fnFIND);
  defineEager("SEARCH", 2, 3, fnSEARCH);
  defineEager("SEARCHB", 2, 3, fnSEARCH);
  defineEager("REPT", 2, 2, fnREPT);
  defineEager("TEXT", 2, 2, fnTEXT);
  defineEager("VALUE", 1, 1, fnVALUE);
  defineEager("EXACT", 2, 2, fnEXACT);
  defineEager("CODE", 1, 1, fnCODE);
  defineEager("CHAR", 1, 1, fnCHAR);
  defineEager("CLEAN", 1, 1, fnCLEAN);
  defineEager("T", 1, 1, fnT);
  defineEager("UNICHAR", 1, 1, fnUNICHAR);
  defineEager("UNICODE", 1, 1, fnUNICODE);
  defineEager("BAHTTEXT", 1, 1, fnBAHTTEXT);
  defineEager("DOLLAR", 1, 2, fnDOLLAR);
  defineEager("FIXED", 1, 3, fnFIXED);
  defineEager("ASC", 1, 1, fnASC);
  defineEager("DBCS", 1, 1, fnDBCS);
  defineEager("JIS", 1, 1, fnJIS);
  defineEager("PHONETIC", 1, 1, fnPHONETIC);
  defineEager("NUMBERVALUE", 1, 3, fnNUMBERVALUE);
  defineEager("TEXTBEFORE", 2, 6, fnTEXTBEFORE);
  defineEager("TEXTAFTER", 2, 6, fnTEXTAFTER);
  defineEager("TEXTSPLIT", 2, 6, fnTEXTSPLIT);
  defineEager("REGEXTEST", 2, 3, fnREGEXTEST);
  defineEager("REGEXEXTRACT", 2, 4, fnREGEXEXTRACT);
  defineEager("REGEXREPLACE", 3, 5, fnREGEXREPLACE);
  defineEager("VALUETOTEXT", 1, 2, fnVALUETOTEXT);
  defineEager("ARRAYTOTEXT", 1, 2, fnARRAYTOTEXT);
  defineEager("ENCODEURL", 1, 1, fnENCODEURL);
}

// ============================================================================
// Native Date Functions
// ============================================================================

import {
  fnTODAY,
  fnNOW,
  fnYEAR,
  fnMONTH,
  fnDAY,
  fnDATE,
  fnTIME,
  fnHOUR,
  fnMINUTE,
  fnSECOND,
  fnWEEKDAY,
  fnEOMONTH,
  fnEDATE,
  fnDATEDIF,
  fnDAYS,
  fnISOWEEKNUM,
  fnWEEKNUM,
  fnNETWORKDAYS,
  fnWORKDAY,
  fnYEARFRAC,
  fnDATEVALUE,
  fnTIMEVALUE,
  fnDAYS360,
  fnNETWORKDAYS_INTL,
  fnWORKDAY_INTL
} from "@formula/functions/date";

function registerNativeDateFunctions(): void {
  defineEager("TODAY", 0, 0, fnTODAY);
  defineEager("NOW", 0, 0, fnNOW);
  defineEager("YEAR", 1, 1, fnYEAR);
  defineEager("MONTH", 1, 1, fnMONTH);
  defineEager("DAY", 1, 1, fnDAY);
  defineEager("DATE", 3, 3, fnDATE);
  defineEager("TIME", 3, 3, fnTIME);
  defineEager("HOUR", 1, 1, fnHOUR);
  defineEager("MINUTE", 1, 1, fnMINUTE);
  defineEager("SECOND", 1, 1, fnSECOND);
  defineEager("WEEKDAY", 1, 2, fnWEEKDAY);
  defineEager("EOMONTH", 2, 2, fnEOMONTH);
  defineEager("EDATE", 2, 2, fnEDATE);
  defineEager("DATEDIF", 3, 3, fnDATEDIF);
  defineEager("DAYS", 2, 2, fnDAYS);
  defineEager("DAYS360", 2, 3, fnDAYS360);
  defineEager("ISOWEEKNUM", 1, 1, fnISOWEEKNUM);
  defineEager("WEEKNUM", 1, 2, fnWEEKNUM);
  defineEager("NETWORKDAYS", 2, 3, fnNETWORKDAYS);
  defineEager("NETWORKDAYS.INTL", 2, 4, fnNETWORKDAYS_INTL);
  defineEager("WORKDAY", 2, 3, fnWORKDAY);
  defineEager("WORKDAY.INTL", 2, 4, fnWORKDAY_INTL);
  defineEager("YEARFRAC", 2, 3, fnYEARFRAC);
  defineEager("DATEVALUE", 1, 1, fnDATEVALUE);
  defineEager("TIMEVALUE", 1, 1, fnTIMEVALUE);
}

// ============================================================================
// Native Engineering Functions
// ============================================================================

import {
  fnBIN2DEC,
  fnDEC2BIN,
  fnHEX2DEC,
  fnDEC2HEX,
  fnOCT2DEC,
  fnDEC2OCT,
  fnDELTA,
  fnGESTEP,
  fnCOMPLEX,
  fnIMREAL,
  fnIMAGINARY,
  fnIMABS,
  fnIMARGUMENT,
  fnIMCONJUGATE,
  fnIMSUM,
  fnIMSUB,
  fnIMPRODUCT,
  fnIMDIV,
  fnIMPOWER,
  fnIMSQRT,
  fnIMLN,
  fnIMLOG2,
  fnIMLOG10,
  fnIMEXP,
  fnIMSIN,
  fnIMCOS,
  fnIMTAN,
  fnIMCSC,
  fnIMSEC,
  fnIMCOT,
  fnIMSINH,
  fnIMCOSH,
  fnIMTANH,
  fnIMCSCH,
  fnIMSECH,
  fnIMCOTH,
  fnBIN2HEX,
  fnBIN2OCT,
  fnHEX2BIN,
  fnHEX2OCT,
  fnOCT2BIN,
  fnOCT2HEX,
  fnBESSELJ,
  fnBESSELI,
  fnBESSELK,
  fnBESSELY,
  fnBITAND,
  fnBITOR,
  fnBITXOR,
  fnBITLSHIFT,
  fnBITRSHIFT
} from "@formula/functions/engineering";

function registerNativeEngineeringFunctions(): void {
  defineEager("BIN2DEC", 1, 1, fnBIN2DEC);
  defineEager("DEC2BIN", 1, 2, fnDEC2BIN);
  defineEager("HEX2DEC", 1, 1, fnHEX2DEC);
  defineEager("DEC2HEX", 1, 2, fnDEC2HEX);
  defineEager("OCT2DEC", 1, 1, fnOCT2DEC);
  defineEager("DEC2OCT", 1, 2, fnDEC2OCT);
  defineEager("DELTA", 1, 2, fnDELTA);
  defineEager("GESTEP", 1, 2, fnGESTEP);
  defineEager("COMPLEX", 2, 3, fnCOMPLEX);
  defineEager("IMREAL", 1, 1, fnIMREAL);
  defineEager("IMAGINARY", 1, 1, fnIMAGINARY);
  defineEager("IMABS", 1, 1, fnIMABS);
  defineEager("IMARGUMENT", 1, 1, fnIMARGUMENT);
  defineEager("IMCONJUGATE", 1, 1, fnIMCONJUGATE);
  defineEager("IMSUM", 1, 255, fnIMSUM);
  defineEager("IMSUB", 2, 2, fnIMSUB);
  defineEager("IMPRODUCT", 1, 255, fnIMPRODUCT);
  defineEager("IMDIV", 2, 2, fnIMDIV);
  defineEager("IMPOWER", 2, 2, fnIMPOWER);
  defineEager("IMSQRT", 1, 1, fnIMSQRT);
  defineEager("IMLN", 1, 1, fnIMLN);
  defineEager("IMLOG2", 1, 1, fnIMLOG2);
  defineEager("IMLOG10", 1, 1, fnIMLOG10);
  defineEager("IMEXP", 1, 1, fnIMEXP);
  defineEager("IMSIN", 1, 1, fnIMSIN);
  defineEager("IMCOS", 1, 1, fnIMCOS);
  defineEager("IMTAN", 1, 1, fnIMTAN);
  defineEager("IMCSC", 1, 1, fnIMCSC);
  defineEager("IMSEC", 1, 1, fnIMSEC);
  defineEager("IMCOT", 1, 1, fnIMCOT);
  defineEager("IMSINH", 1, 1, fnIMSINH);
  defineEager("IMCOSH", 1, 1, fnIMCOSH);
  defineEager("IMTANH", 1, 1, fnIMTANH);
  defineEager("IMCSCH", 1, 1, fnIMCSCH);
  defineEager("IMSECH", 1, 1, fnIMSECH);
  defineEager("IMCOTH", 1, 1, fnIMCOTH);
  defineEager("BIN2HEX", 1, 2, fnBIN2HEX);
  defineEager("BIN2OCT", 1, 2, fnBIN2OCT);
  defineEager("HEX2BIN", 1, 2, fnHEX2BIN);
  defineEager("HEX2OCT", 1, 2, fnHEX2OCT);
  defineEager("OCT2BIN", 1, 2, fnOCT2BIN);
  defineEager("OCT2HEX", 1, 2, fnOCT2HEX);
  defineEager("BESSELJ", 2, 2, fnBESSELJ);
  defineEager("BESSELI", 2, 2, fnBESSELI);
  defineEager("BESSELK", 2, 2, fnBESSELK);
  defineEager("BESSELY", 2, 2, fnBESSELY);
  defineEager("BITAND", 2, 2, fnBITAND);
  defineEager("BITOR", 2, 2, fnBITOR);
  defineEager("BITXOR", 2, 2, fnBITXOR);
  defineEager("BITLSHIFT", 2, 2, fnBITLSHIFT);
  defineEager("BITRSHIFT", 2, 2, fnBITRSHIFT);
}

// ============================================================================
// Native Financial Functions
// ============================================================================

import {
  fnPMT,
  fnFV,
  fnPV,
  fnNPV,
  fnIRR,
  fnNPER,
  fnRATE,
  fnSLN,
  fnSYD,
  fnVDB,
  fnFVSCHEDULE,
  fnPDURATION,
  fnRRI,
  fnDB,
  fnDDB,
  fnIPMT,
  fnPPMT,
  fnEFFECT,
  fnNOMINAL,
  fnXNPV,
  fnXIRR,
  fnMIRR,
  fnISPMT,
  fnCUMPRINC,
  fnCUMIPMT,
  fnDOLLARDE,
  fnDOLLARFR,
  fnDISC,
  fnPRICEDISC,
  fnYIELDDISC,
  fnRECEIVED,
  fnINTRATE,
  fnPRICE,
  fnYIELD,
  fnDURATION,
  fnMDURATION,
  fnACCRINT,
  fnACCRINTM,
  fnTBILLPRICE,
  fnTBILLYIELD,
  fnTBILLEQ,
  fnPRICEMAT,
  fnYIELDMAT,
  fnCOUPNCD,
  fnCOUPPCD,
  fnCOUPNUM,
  fnCOUPDAYSNC,
  fnCOUPDAYBS,
  fnCOUPDAYS
} from "@formula/functions/financial";

function registerNativeFinancialFunctions(): void {
  defineEager("PMT", 3, 5, fnPMT);
  defineEager("FV", 3, 5, fnFV);
  defineEager("PV", 3, 5, fnPV);
  defineEager("NPV", 2, 255, fnNPV);
  defineEager("IRR", 1, 2, fnIRR);
  defineEager("NPER", 3, 5, fnNPER);
  defineEager("RATE", 3, 6, fnRATE);
  defineEager("SLN", 3, 3, fnSLN);
  defineEager("SYD", 4, 4, fnSYD);
  defineEager("VDB", 5, 7, fnVDB);
  defineEager("FVSCHEDULE", 2, 2, fnFVSCHEDULE);
  defineEager("PDURATION", 3, 3, fnPDURATION);
  defineEager("RRI", 3, 3, fnRRI);
  defineEager("DB", 4, 5, fnDB);
  defineEager("DDB", 4, 5, fnDDB);
  defineEager("IPMT", 4, 6, fnIPMT);
  defineEager("PPMT", 4, 6, fnPPMT);
  defineEager("EFFECT", 2, 2, fnEFFECT);
  defineEager("NOMINAL", 2, 2, fnNOMINAL);
  defineEager("XNPV", 3, 3, fnXNPV);
  defineEager("XIRR", 2, 3, fnXIRR);
  defineEager("MIRR", 3, 3, fnMIRR);
  defineEager("ISPMT", 4, 4, fnISPMT);
  defineEager("CUMPRINC", 6, 6, fnCUMPRINC);
  defineEager("CUMIPMT", 6, 6, fnCUMIPMT);
  defineEager("DOLLARDE", 2, 2, fnDOLLARDE);
  defineEager("DOLLARFR", 2, 2, fnDOLLARFR);
  defineEager("DISC", 4, 5, fnDISC);
  defineEager("PRICEDISC", 4, 5, fnPRICEDISC);
  defineEager("YIELDDISC", 4, 5, fnYIELDDISC);
  defineEager("RECEIVED", 4, 5, fnRECEIVED);
  defineEager("INTRATE", 4, 5, fnINTRATE);
  defineEager("PRICE", 6, 7, fnPRICE);
  defineEager("YIELD", 6, 7, fnYIELD);
  defineEager("DURATION", 5, 6, fnDURATION);
  defineEager("MDURATION", 5, 6, fnMDURATION);
  defineEager("ACCRINT", 6, 8, fnACCRINT);
  defineEager("ACCRINTM", 4, 5, fnACCRINTM);
  defineEager("TBILLPRICE", 3, 3, fnTBILLPRICE);
  defineEager("TBILLYIELD", 3, 3, fnTBILLYIELD);
  defineEager("TBILLEQ", 3, 3, fnTBILLEQ);
  defineEager("PRICEMAT", 5, 6, fnPRICEMAT);
  defineEager("YIELDMAT", 5, 6, fnYIELDMAT);
  defineEager("COUPNCD", 3, 4, fnCOUPNCD);
  defineEager("COUPPCD", 3, 4, fnCOUPPCD);
  defineEager("COUPNUM", 3, 4, fnCOUPNUM);
  defineEager("COUPDAYSNC", 3, 4, fnCOUPDAYSNC);
  defineEager("COUPDAYBS", 3, 4, fnCOUPDAYBS);
  defineEager("COUPDAYS", 3, 4, fnCOUPDAYS);
}

// ============================================================================
// Native Statistical Functions
// ============================================================================

import {
  fnMEDIAN,
  fnLARGE,
  fnSMALL,
  fnRANK,
  fnSTDEV,
  fnSTDEVP,
  fnVAR,
  fnVARP,
  fnNORMSDIST,
  fnNORMDIST,
  fnNORMSINV,
  fnNORMINV,
  fnPERCENTILE,
  fnPERCENTILEEXC,
  fnQUARTILE,
  fnQUARTILEEXC,
  fnPERCENTRANK_INC,
  fnPERCENTRANK_EXC,
  fnPROB,
  fnMODE,
  fnCORREL,
  fnSLOPE,
  fnINTERCEPT,
  fnRSQ,
  fnSTEYX,
  fnFORECAST,
  fnGEOMEAN,
  fnHARMEAN,
  fnTRIMMEAN,
  fnDEVSQ,
  fnAVEDEV,
  fnCONFIDENCENORM,
  fnCONFIDENCE_T,
  fnCOVARIANCE_P,
  fnCOVARIANCE_S,
  fnRANK_AVG,
  fnMODE_MULT,
  fnFISHER,
  fnFISHERINV,
  fnAVERAGEA,
  fnMAXA,
  fnMINA,
  fnPOISSON_DIST,
  fnBINOM_DIST,
  fnBINOM_DIST_RANGE,
  fnBINOM_INV,
  fnCHISQ_INV_RT,
  fnZ_TEST,
  fnT_TEST,
  fnF_TEST,
  fnCHISQ_TEST,
  fnHYPGEOM_DIST,
  fnNEGBINOM_DIST,
  fnCHISQ_DIST,
  fnCHISQ_INV,
  fnCHISQ_DIST_RT,
  fnF_DIST,
  fnF_INV,
  fnF_DIST_RT,
  fnF_INV_RT,
  fnSKEW,
  fnSKEW_P,
  fnKURT,
  fnT_DIST,
  fnT_INV,
  fnT_DIST_2T,
  fnT_DIST_RT,
  fnT_INV_2T,
  fnBETA_DIST,
  fnBETA_INV,
  fnGAMMA,
  fnGAMMALN,
  fnGAMMA_DIST,
  fnGAMMA_INV,
  fnEXPON_DIST,
  fnWEIBULL_DIST,
  fnLOGNORM_DIST,
  fnLOGNORM_INV,
  fnPHI,
  fnGAUSS,
  fnERF,
  fnERFC,
  fnSTANDARDIZE,
  fnFREQUENCY,
  fnGROWTH,
  fnTREND,
  fnLINEST,
  fnLOGEST
} from "@formula/functions/statistical";

function registerNativeStatisticalFunctions(): void {
  defineEager("MEDIAN", 1, 255, fnMEDIAN);
  defineEager("LARGE", 2, 2, fnLARGE);
  defineEager("SMALL", 2, 2, fnSMALL);
  defineEager("RANK", 2, 3, fnRANK);
  defineEager("RANK.EQ", 2, 3, fnRANK);
  defineEager("STDEV", 1, 255, fnSTDEV);
  defineEager("STDEV.S", 1, 255, fnSTDEV);
  defineEager("STDEVP", 1, 255, fnSTDEVP);
  defineEager("STDEV.P", 1, 255, fnSTDEVP);
  defineEager("VAR", 1, 255, fnVAR);
  defineEager("VAR.S", 1, 255, fnVAR);
  defineEager("VARP", 1, 255, fnVARP);
  defineEager("VAR.P", 1, 255, fnVARP);
  defineEager("NORM.S.DIST", 2, 2, fnNORMSDIST);
  defineEager("NORMSDIST", 1, 2, fnNORMSDIST);
  defineEager("NORM.DIST", 4, 4, fnNORMDIST);
  defineEager("NORMDIST", 4, 4, fnNORMDIST);
  defineEager("NORM.S.INV", 1, 1, fnNORMSINV);
  defineEager("NORMSINV", 1, 1, fnNORMSINV);
  defineEager("NORM.INV", 3, 3, fnNORMINV);
  defineEager("NORMINV", 3, 3, fnNORMINV);
  defineEager("PERCENTILE", 2, 2, fnPERCENTILE);
  defineEager("PERCENTILE.INC", 2, 2, fnPERCENTILE);
  defineEager("PERCENTILE.EXC", 2, 2, fnPERCENTILEEXC);
  defineEager("QUARTILE", 2, 2, fnQUARTILE);
  defineEager("QUARTILE.INC", 2, 2, fnQUARTILE);
  defineEager("QUARTILE.EXC", 2, 2, fnQUARTILEEXC);
  defineEager("PERCENTRANK", 2, 3, fnPERCENTRANK_INC);
  defineEager("PERCENTRANK.INC", 2, 3, fnPERCENTRANK_INC);
  defineEager("PERCENTRANK.EXC", 2, 3, fnPERCENTRANK_EXC);
  defineEager("PROB", 3, 4, fnPROB);
  defineEager("MODE", 1, 255, fnMODE);
  defineEager("MODE.SNGL", 1, 255, fnMODE);
  defineEager("CORREL", 2, 2, fnCORREL);
  defineEager("SLOPE", 2, 2, fnSLOPE);
  defineEager("INTERCEPT", 2, 2, fnINTERCEPT);
  defineEager("RSQ", 2, 2, fnRSQ);
  defineEager("STEYX", 2, 2, fnSTEYX);
  defineEager("FORECAST", 3, 3, fnFORECAST);
  defineEager("FORECAST.LINEAR", 3, 3, fnFORECAST);
  defineEager("GEOMEAN", 1, 255, fnGEOMEAN);
  defineEager("HARMEAN", 1, 255, fnHARMEAN);
  defineEager("TRIMMEAN", 2, 2, fnTRIMMEAN);
  defineEager("DEVSQ", 1, 255, fnDEVSQ);
  defineEager("AVEDEV", 1, 255, fnAVEDEV);
  defineEager("CONFIDENCE.NORM", 3, 3, fnCONFIDENCENORM);
  defineEager("CONFIDENCE.T", 3, 3, fnCONFIDENCE_T);
  defineEager("COVARIANCE.P", 2, 2, fnCOVARIANCE_P);
  defineEager("COVARIANCE.S", 2, 2, fnCOVARIANCE_S);
  defineEager("RANK.AVG", 2, 3, fnRANK_AVG);
  defineEager("MODE.MULT", 1, 255, fnMODE_MULT);
  defineEager("CONFIDENCE", 3, 3, fnCONFIDENCENORM);
  defineEager("FISHER", 1, 1, fnFISHER);
  defineEager("FISHERINV", 1, 1, fnFISHERINV);
  defineEager("AVERAGEA", 1, 255, fnAVERAGEA);
  defineEager("MAXA", 1, 255, fnMAXA);
  defineEager("MINA", 1, 255, fnMINA);
  defineEager("POISSON.DIST", 3, 3, fnPOISSON_DIST);
  defineEager("BINOM.DIST", 4, 4, fnBINOM_DIST);
  defineEager("BINOMDIST", 4, 4, fnBINOM_DIST);
  defineEager("BINOM.DIST.RANGE", 3, 4, fnBINOM_DIST_RANGE);
  defineEager("BINOM.INV", 3, 3, fnBINOM_INV);
  defineEager("HYPGEOM.DIST", 5, 5, fnHYPGEOM_DIST);
  defineEager("NEGBINOM.DIST", 4, 4, fnNEGBINOM_DIST);
  defineEager("CHISQ.DIST", 3, 3, fnCHISQ_DIST);
  defineEager("CHISQ.INV", 2, 2, fnCHISQ_INV);
  defineEager("CHISQ.INV.RT", 2, 2, fnCHISQ_INV_RT);
  defineEager("Z.TEST", 2, 3, fnZ_TEST);
  defineEager("ZTEST", 2, 3, fnZ_TEST);
  defineEager("T.TEST", 4, 4, fnT_TEST);
  defineEager("TTEST", 4, 4, fnT_TEST);
  defineEager("F.TEST", 2, 2, fnF_TEST);
  defineEager("FTEST", 2, 2, fnF_TEST);
  defineEager("CHISQ.TEST", 2, 2, fnCHISQ_TEST);
  defineEager("CHITEST", 2, 2, fnCHISQ_TEST);
  defineEager("CHISQ.DIST.RT", 2, 2, fnCHISQ_DIST_RT);
  defineEager("F.DIST", 4, 4, fnF_DIST);
  defineEager("F.INV", 3, 3, fnF_INV);
  defineEager("F.DIST.RT", 3, 3, fnF_DIST_RT);
  defineEager("F.INV.RT", 3, 3, fnF_INV_RT);
  defineEager("SKEW", 1, 255, fnSKEW);
  defineEager("SKEW.P", 1, 255, fnSKEW_P);
  defineEager("KURT", 1, 255, fnKURT);
  defineEager("T.DIST", 3, 3, fnT_DIST);
  defineEager("T.INV", 2, 2, fnT_INV);
  defineEager("T.DIST.2T", 2, 2, fnT_DIST_2T);
  defineEager("T.DIST.RT", 2, 2, fnT_DIST_RT);
  defineEager("T.INV.2T", 2, 2, fnT_INV_2T);
  defineEager("BETA.DIST", 4, 6, fnBETA_DIST);
  defineEager("BETA.INV", 3, 5, fnBETA_INV);
  defineEager("GAMMA", 1, 1, fnGAMMA);
  defineEager("GAMMALN", 1, 1, fnGAMMALN);
  defineEager("GAMMALN.PRECISE", 1, 1, fnGAMMALN);
  defineEager("GAMMA.DIST", 4, 4, fnGAMMA_DIST);
  defineEager("GAMMA.INV", 3, 3, fnGAMMA_INV);
  defineEager("EXPON.DIST", 3, 3, fnEXPON_DIST);
  defineEager("WEIBULL.DIST", 4, 4, fnWEIBULL_DIST);
  defineEager("LOGNORM.DIST", 4, 4, fnLOGNORM_DIST);
  defineEager("LOGNORM.INV", 3, 3, fnLOGNORM_INV);
  defineEager("PHI", 1, 1, fnPHI);
  defineEager("GAUSS", 1, 1, fnGAUSS);
  defineEager("ERF", 1, 2, fnERF);
  defineEager("ERF.PRECISE", 1, 2, fnERF);
  defineEager("ERFC", 1, 1, fnERFC);
  defineEager("ERFC.PRECISE", 1, 1, fnERFC);
  defineEager("STANDARDIZE", 3, 3, fnSTANDARDIZE);
  defineEager("FREQUENCY", 2, 2, fnFREQUENCY);
  defineEager("GROWTH", 1, 4, fnGROWTH);
  defineEager("TREND", 1, 4, fnTREND);
  defineEager("LINEST", 1, 4, fnLINEST);
  defineEager("LOGEST", 1, 4, fnLOGEST);
}

// ============================================================================
// Native Math Functions
// ============================================================================

import {
  fnSUM,
  fnAVERAGE,
  fnMIN,
  fnMAX,
  fnCOUNT,
  fnCOUNTA,
  fnCOUNTBLANK,
  fnPRODUCT,
  fnSUMPRODUCT,
  fnABS,
  fnCEILING,
  fnCEILING_MATH,
  fnCEILING_PRECISE,
  fnFLOOR,
  fnFLOOR_MATH,
  fnFLOOR_PRECISE,
  fnINT,
  fnMOD,
  fnPOWER,
  fnROUND,
  fnROUNDDOWN,
  fnROUNDUP,
  fnSQRT,
  fnSQRTPI,
  fnLN,
  fnLOG,
  fnLOG10,
  fnEXP,
  fnPI,
  fnRAND,
  fnRANDBETWEEN,
  fnSIGN,
  fnTRUNC,
  fnSUMSQ,
  fnGCD,
  fnLCM,
  fnEVEN,
  fnODD,
  fnMROUND,
  fnQUOTIENT,
  fnBASE,
  fnDECIMAL,
  fnROMAN,
  fnARABIC,
  fnDEGREES,
  fnRADIANS,
  fnSUMX2MY2,
  fnSUMX2PY2,
  fnSUMXMY2,
  fnMULTINOMIAL,
  fnFACT as fnMathFACT,
  fnFACTDOUBLE as fnMathFACTDOUBLE,
  fnCOMBIN as fnMathCOMBIN,
  fnCOMBINA as fnMathCOMBINA,
  fnPERMUT as fnMathPERMUT,
  fnSIN,
  fnCOS,
  fnTAN,
  fnASIN,
  fnACOS,
  fnATAN,
  fnATAN2,
  fnSINH,
  fnCOSH,
  fnTANH,
  fnASINH,
  fnACOSH,
  fnATANH,
  fnSEC,
  fnCSC,
  fnCOT,
  fnSECH,
  fnCSCH,
  fnCOTH,
  fnACOT,
  fnACOTH,
  fnMMULT,
  fnMDETERM,
  fnMINVERSE,
  fnMUNIT,
  fnSERIESSUM
} from "@formula/functions/math";

function registerNativeMathFunctions(): void {
  defineEager("SUM", 1, 255, fnSUM);
  defineEager("AVERAGE", 1, 255, fnAVERAGE);
  defineEager("MIN", 1, 255, fnMIN);
  defineEager("MAX", 1, 255, fnMAX);
  defineEager("COUNT", 1, 255, fnCOUNT);
  defineEager("COUNTA", 1, 255, fnCOUNTA);
  defineEager("COUNTBLANK", 1, 1, fnCOUNTBLANK);
  defineEager("PRODUCT", 1, 255, fnPRODUCT);
  defineEager("SUMPRODUCT", 1, 255, fnSUMPRODUCT);
  defineEager("MMULT", 2, 2, fnMMULT);
  defineEager("MDETERM", 1, 1, fnMDETERM);
  defineEager("MINVERSE", 1, 1, fnMINVERSE);
  defineEager("MUNIT", 1, 1, fnMUNIT);
  defineEager("SERIESSUM", 4, 4, fnSERIESSUM);
  defineEager("ABS", 1, 1, fnABS);
  defineEager("CEILING", 2, 2, fnCEILING);
  defineEager("CEILING.MATH", 1, 3, fnCEILING_MATH);
  defineEager("CEILING.PRECISE", 1, 2, fnCEILING_PRECISE);
  defineEager("ISO.CEILING", 1, 2, fnCEILING_PRECISE);
  defineEager("FLOOR", 2, 2, fnFLOOR);
  defineEager("FLOOR.MATH", 1, 3, fnFLOOR_MATH);
  defineEager("FLOOR.PRECISE", 1, 2, fnFLOOR_PRECISE);
  defineEager("INT", 1, 1, fnINT);
  defineEager("MOD", 2, 2, fnMOD);
  defineEager("POWER", 2, 2, fnPOWER);
  defineEager("ROUND", 2, 2, fnROUND);
  defineEager("ROUNDDOWN", 2, 2, fnROUNDDOWN);
  defineEager("ROUNDUP", 2, 2, fnROUNDUP);
  defineEager("SQRT", 1, 1, fnSQRT);
  defineEager("SQRTPI", 1, 1, fnSQRTPI);
  defineEager("LN", 1, 1, fnLN);
  defineEager("LOG", 1, 2, fnLOG);
  defineEager("LOG10", 1, 1, fnLOG10);
  defineEager("EXP", 1, 1, fnEXP);
  defineEager("PI", 0, 0, fnPI);
  defineEager("RAND", 0, 0, fnRAND);
  defineEager("RANDBETWEEN", 2, 2, fnRANDBETWEEN);
  defineEager("SIGN", 1, 1, fnSIGN);
  defineEager("TRUNC", 1, 2, fnTRUNC);
  defineEager("SUMSQ", 1, 255, fnSUMSQ);
  defineEager("GCD", 1, 255, fnGCD);
  defineEager("LCM", 1, 255, fnLCM);
  defineEager("EVEN", 1, 1, fnEVEN);
  defineEager("ODD", 1, 1, fnODD);
  defineEager("MROUND", 2, 2, fnMROUND);
  defineEager("QUOTIENT", 2, 2, fnQUOTIENT);
  defineEager("BASE", 2, 3, fnBASE);
  defineEager("DECIMAL", 2, 2, fnDECIMAL);
  defineEager("ROMAN", 1, 2, fnROMAN);
  defineEager("ARABIC", 1, 1, fnARABIC);
  defineEager("DEGREES", 1, 1, fnDEGREES);
  defineEager("RADIANS", 1, 1, fnRADIANS);
  defineEager("SUMX2MY2", 2, 2, fnSUMX2MY2);
  defineEager("SUMX2PY2", 2, 2, fnSUMX2PY2);
  defineEager("SUMXMY2", 2, 2, fnSUMXMY2);
  defineEager("MULTINOMIAL", 1, 255, fnMULTINOMIAL);
  defineEager("FACT", 1, 1, fnMathFACT);
  defineEager("FACTDOUBLE", 1, 1, fnMathFACTDOUBLE);
  defineEager("COMBIN", 2, 2, fnMathCOMBIN);
  defineEager("COMBINA", 2, 2, fnMathCOMBINA);
  defineEager("PERMUT", 2, 2, fnMathPERMUT);
  defineEager("SIN", 1, 1, fnSIN);
  defineEager("COS", 1, 1, fnCOS);
  defineEager("TAN", 1, 1, fnTAN);
  defineEager("ASIN", 1, 1, fnASIN);
  defineEager("ACOS", 1, 1, fnACOS);
  defineEager("ATAN", 1, 1, fnATAN);
  defineEager("ATAN2", 2, 2, fnATAN2);
  defineEager("SINH", 1, 1, fnSINH);
  defineEager("COSH", 1, 1, fnCOSH);
  defineEager("TANH", 1, 1, fnTANH);
  defineEager("ASINH", 1, 1, fnASINH);
  defineEager("ACOSH", 1, 1, fnACOSH);
  defineEager("ATANH", 1, 1, fnATANH);
  defineEager("SEC", 1, 1, fnSEC);
  defineEager("CSC", 1, 1, fnCSC);
  defineEager("COT", 1, 1, fnCOT);
  defineEager("SECH", 1, 1, fnSECH);
  defineEager("CSCH", 1, 1, fnCSCH);
  defineEager("COTH", 1, 1, fnCOTH);
  defineEager("ACOT", 1, 1, fnACOT);
  defineEager("ACOTH", 1, 1, fnACOTH);
}

// ============================================================================
// Native Conditional Functions
// ============================================================================

import {
  fnSUMIF,
  fnSUMIFS,
  fnCOUNTIF,
  fnCOUNTIFS,
  fnAVERAGEIF,
  fnAVERAGEIFS,
  fnMAXIFS,
  fnMINIFS
} from "@formula/functions/conditional";

function registerNativeConditionalFunctions(): void {
  defineEager("SUMIF", 2, 3, fnSUMIF);
  defineEager("SUMIFS", 3, 255, fnSUMIFS);
  defineEager("COUNTIF", 2, 2, fnCOUNTIF);
  defineEager("COUNTIFS", 2, 255, fnCOUNTIFS);
  defineEager("AVERAGEIF", 2, 3, fnAVERAGEIF);
  defineEager("AVERAGEIFS", 3, 255, fnAVERAGEIFS);
  defineEager("MAXIFS", 3, 255, fnMAXIFS);
  defineEager("MINIFS", 3, 255, fnMINIFS);
}

// ============================================================================
// Native Lookup Functions
// ============================================================================

import {
  fnROW,
  fnCOLUMN,
  fnROWS,
  fnCOLUMNS,
  fnINDEX,
  fnMATCH,
  fnVLOOKUP,
  fnHLOOKUP,
  fnXLOOKUP,
  fnXMATCH,
  fnADDRESS,
  fnLOOKUP,
  fnTRANSPOSE,
  fnAREAS
} from "@formula/functions/lookup";

function registerNativeLookupFunctions(): void {
  defineEager("ROW", 0, 1, fnROW);
  defineEager("COLUMN", 0, 1, fnCOLUMN);
  defineEager("ROWS", 1, 1, fnROWS);
  defineEager("COLUMNS", 1, 1, fnCOLUMNS);
  defineEager("INDEX", 2, 4, fnINDEX);
  defineEager("MATCH", 2, 3, fnMATCH);
  defineEager("VLOOKUP", 3, 4, fnVLOOKUP);
  defineEager("HLOOKUP", 3, 4, fnHLOOKUP);
  defineEager("XLOOKUP", 3, 6, fnXLOOKUP);
  defineEager("XMATCH", 2, 4, fnXMATCH);
  defineEager("ADDRESS", 2, 5, fnADDRESS);
  defineEager("LOOKUP", 2, 3, fnLOOKUP);
  defineEager("TRANSPOSE", 1, 1, fnTRANSPOSE);
  defineEager("AREAS", 1, 1, fnAREAS);
}

// ============================================================================
// Native Dynamic Array Functions
// ============================================================================

import {
  fnFILTER,
  fnSORT,
  fnUNIQUE,
  fnSORTBY,
  fnSEQUENCE,
  fnRANDARRAY as fnRA,
  fnTOCOL,
  fnTOROW,
  fnCHOOSEROWS,
  fnCHOOSECOLS,
  fnVSTACK,
  fnHSTACK,
  fnTAKE,
  fnDROP,
  fnWRAPROWS,
  fnWRAPCOLS,
  fnEXPAND,
  fnSUBTOTAL,
  fnAGGREGATE
} from "@formula/functions/dynamic-array";

function registerNativeDynamicArrayFunctions(): void {
  defineEager("FILTER", 2, 3, fnFILTER);
  defineEager("SORT", 1, 4, fnSORT);
  defineEager("UNIQUE", 1, 3, fnUNIQUE);
  defineEager("SORTBY", 2, 255, fnSORTBY);
  defineEager("SEQUENCE", 1, 4, fnSEQUENCE);
  defineEager("RANDARRAY", 0, 5, fnRA);
  defineEager("TOCOL", 1, 3, fnTOCOL);
  defineEager("TOROW", 1, 3, fnTOROW);
  defineEager("CHOOSEROWS", 2, 255, fnCHOOSEROWS);
  defineEager("CHOOSECOLS", 2, 255, fnCHOOSECOLS);
  defineEager("VSTACK", 1, 255, fnVSTACK);
  defineEager("HSTACK", 1, 255, fnHSTACK);
  defineEager("WRAPROWS", 2, 3, fnWRAPROWS);
  defineEager("WRAPCOLS", 2, 3, fnWRAPCOLS);
  defineEager("EXPAND", 2, 4, fnEXPAND);
  defineEager("TAKE", 2, 3, fnTAKE);
  defineEager("DROP", 2, 3, fnDROP);
  defineEager("SUBTOTAL", 2, 255, fnSUBTOTAL);
  defineEager("AGGREGATE", 3, 255, fnAGGREGATE);
}

// ============================================================================
// Native Database Functions
// ============================================================================

import {
  fnDSUM,
  fnDAVERAGE,
  fnDCOUNT,
  fnDCOUNTA,
  fnDMAX,
  fnDMIN,
  fnDPRODUCT,
  fnDGET,
  fnDSTDEV,
  fnDSTDEVP,
  fnDVAR,
  fnDVARP
} from "@formula/functions/database";

function registerNativeDatabaseFunctions(): void {
  defineEager("DSUM", 3, 3, fnDSUM);
  defineEager("DAVERAGE", 3, 3, fnDAVERAGE);
  defineEager("DCOUNT", 3, 3, fnDCOUNT);
  defineEager("DCOUNTA", 3, 3, fnDCOUNTA);
  defineEager("DMAX", 3, 3, fnDMAX);
  defineEager("DMIN", 3, 3, fnDMIN);
  defineEager("DPRODUCT", 3, 3, fnDPRODUCT);
  defineEager("DGET", 3, 3, fnDGET);
  defineEager("DSTDEV", 3, 3, fnDSTDEV);
  defineEager("DSTDEVP", 3, 3, fnDSTDEVP);
  defineEager("DVAR", 3, 3, fnDVAR);
  defineEager("DVARP", 3, 3, fnDVARP);
}
