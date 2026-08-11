import type { RangeData } from "@excel/core/range";
import { rangeAbsoluteShort, rangeCreate } from "@excel/core/range";
import type { DecodedAddress } from "@excel/types";
import { CellMatrix } from "@excel/utils/cell-matrix";
import type { DecodedRange } from "@excel/utils/col-cache";
import { colCache } from "@excel/utils/col-cache";
import { parse } from "@formula/syntax/parser";
import { tokenize } from "@formula/syntax/tokenizer";

/**
 * A formula-syntax oracle: returns `true` iff `text` parses as a formula
 * expression. Used to classify defined-name text (formula vs. opaque) when
 * loading XLSX. Consumers may inject a custom probe via
 * `createWorkbook({ formulaSyntaxProbe })` / `createDefinedNames(probe)`;
 * otherwise the built-in {@link defaultFormulaSyntaxProbe} (real
 * tokenizer + parser) is used — no install / registration step required.
 */
export type SyntaxProbe = (text: string) => boolean;

/**
 * Default formula-syntax probe, backed by the real tokenizer + parser.
 *
 * This is reached only from the XLSX-load classification path
 * (`definedNamesSetModel` → `classifyDefinedName`); a consumer who merely
 * creates a workbook never calls it, so the tokenizer/parser are tree-shaken
 * out of `Workbook.create`-only bundles (verified by scripts/treeshake-verify).
 */
export function defaultFormulaSyntaxProbe(text: string): boolean {
  try {
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      return false;
    }
    parse(tokens);
    return true;
  } catch {
    return false;
  }
}

const rangeRegexp = /[$](\w+)[$](\d+)(:[$](\w+)[$](\d+))?/;

// Cell type for defined names - extends Address with mark for exploration algorithm
interface DefinedNameCell {
  sheetName?: string;
  address: string;
  row: number;
  col: number;
  mark?: boolean;
}

// Location can be a single cell address or a range
type CellLocation = DecodedAddress | DecodedRange;

/** A defined name as persisted: its key plus the ranges it covers. */
export interface DefinedNameModel {
  name: string;
  ranges: string[];
  localSheetId?: number;
  /** Formula expression for formula-based defined names (e.g. "LAMBDA(x,y,x+y)") */
  formulaExpression?: string;
  /** Original XML text — preserved for opaque names round-trip */
  rawText?: string;
  /**
   * Classification determined by the semantic layer:
   * - "reference": pure cell/range union — stored in matrixMap
   * - "formula": parseable expression — stored in formulaMap
   * - "opaque": unrecognised content preserved for round-trip — stored in opaqueMap
   */
  kind?: "reference" | "formula" | "opaque";
  /**
   * `definedName/@hidden` — when `true`, emits `hidden="1"` on the
   * XML element. Used by chartEx `_xlchart.vN.M` defined names that
   * Excel creates automatically for every chartEx data reference;
   * these names are infrastructure, never intended for users, so
   * Excel hides them from the Name Manager UI.
   */
  hidden?: boolean;
}

/** Stored entry for an opaque (unrecognised) defined name. */
interface OpaqueEntry {
  rawText: string;
  localSheetId?: number;
}

// ============================================================================
// Range validation helpers (moved from defined-name-xform.ts)
// ============================================================================

// Regex to validate cell range format:
// - Cell: $A$1 or A1
// - Range: $A$1:$B$10 or A1:B10
// - Row range: $1:$2 (for print titles)
// - Column range: $A:$B (for print titles)
const cellRangeRegexp = /^[$]?[A-Za-z]{1,3}[$]?\d+(:[$]?[A-Za-z]{1,3}[$]?\d+)?$/;
const rowRangeRegexp = /^[$]?\d+:[$]?\d+$/;
const colRangeRegexp = /^[$]?[A-Za-z]{1,3}:[$]?[A-Za-z]{1,3}$/;

function isValidRange(range: string): boolean {
  // Skip array constants wrapped in {} - these are not valid cell ranges
  if (range.startsWith("{") || range.endsWith("}")) {
    return false;
  }

  // Extract the cell reference part (after the sheet name if present)
  const cellRef = range.split("!").pop() ?? "";

  // Must match one of the valid patterns
  if (
    !cellRangeRegexp.test(cellRef) &&
    !rowRangeRegexp.test(cellRef) &&
    !colRangeRegexp.test(cellRef)
  ) {
    return false;
  }

  try {
    const decoded = colCache.decodeEx(range);
    if (
      ("row" in decoded && typeof decoded.row === "number") ||
      ("top" in decoded && typeof decoded.top === "number") ||
      ("left" in decoded && typeof decoded.left === "number")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Extract valid cell/range references from a raw defined name text string.
 * Handles comma-separated ranges and quoted sheet names that may contain commas.
 */
function extractRanges(parsedText: string): string[] {
  const trimmed = parsedText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return [];
  }

  const ranges: string[] = [];
  let quotesOpened = false;
  let last = "";
  parsedText.split(",").forEach(item => {
    if (!item) {
      return;
    }
    const quotes = (item.match(/'/g) ?? []).length;

    if (!quotes) {
      if (quotesOpened) {
        last += `${item},`;
      } else if (isValidRange(item)) {
        ranges.push(item);
      }
      return;
    }
    const quotesEven = quotes % 2 === 0;

    if (!quotesOpened && quotesEven && isValidRange(item)) {
      ranges.push(item);
    } else if (quotesOpened && !quotesEven) {
      quotesOpened = false;
      if (isValidRange(last + item)) {
        ranges.push(last + item);
      }
      last = "";
    } else {
      quotesOpened = true;
      last += `${item},`;
    }
  });
  return ranges;
}

// ============================================================================
// Classifier — Stage 2 of the two-phase defined name design
// ============================================================================

/**
 * Check whether a string contains a '(' character outside of single-quoted
 * sheet name segments. Sheet names in cell references use single quotes:
 * e.g. `'Sheet (1)'!$A$1` — the '(' is inside quotes and does NOT indicate
 * a function call. A genuine formula like `OFFSET(Sheet1!$A$1,0,0,3,1)`
 * has '(' outside of any quotes.
 */
function hasUnquotedParen(s: string): boolean {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      inQuote = !inQuote;
    } else if (ch === "(" && !inQuote) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a raw defined name text into one of three categories:
 * 1. **reference** — pure cell/range union (goes into matrixMap)
 * 2. **formula** — parseable expression (goes into formulaMap)
 * 3. **opaque** — unrecognised content preserved for round-trip
 *
 * Classification order matters:
 * - If the text contains an unquoted `(`, it is likely a formula — try the
 *   formula parser first (this prevents `extractRanges` from misinterpreting
 *   function arguments as partial range references).
 * - Otherwise try to extract ranges (pure cell references).
 * - If neither works, fall back to opaque.
 *
 * **Probe semantics:** `probe` is the formula tokenizer+parser oracle. It
 * is the *only* authority for deciding whether a non-range, non-wrapper
 * string is a formula. When `probe` is `null`, any such string is classified
 * as **opaque** — we have no evidence it is a formula, and leaving it opaque
 * preserves round-trip bytes via `rawText`. (In practice `definedNamesSetModel`
 * always supplies at least the built-in `defaultFormulaSyntaxProbe`.)
 *
 * This function is pure: the classification of a given input depends
 * entirely on (rawText, ranges, probe) and no global state. Two calls
 * with the same arguments always produce the same result.
 */
function classifyDefinedName(
  rawText: string | undefined,
  ranges: string[],
  probe: SyntaxProbe | null
): { kind: "reference" | "formula" | "opaque"; ranges: string[]; formulaExpression?: string } {
  // If rawText is missing, fall back to existing ranges (programmatic API path)
  if (rawText === undefined) {
    if (ranges.length > 0) {
      return { kind: "reference", ranges };
    }
    return { kind: "opaque", ranges: [] };
  }

  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { kind: "opaque", ranges: [] };
  }

  // Opaque-looking wrappers — array constants, string literals, error
  // values — are preserved verbatim and never routed through formula
  // parsing. Detect them once, up front.
  const isArrayConst = trimmed.startsWith("{") && trimmed.endsWith("}");
  const isStringLit = trimmed.startsWith('"') && trimmed.endsWith('"');
  const isErrorVal = trimmed.startsWith("#");
  const isOpaqueWrapper = isArrayConst || isStringLit || isErrorVal;

  const hasParen = hasUnquotedParen(trimmed);

  // If the text contains an unquoted parenthesis (e.g. OFFSET(...),
  // LAMBDA(...)), it is either a formula or a malformed expression —
  // never a cell-range union. `extractRanges` is not safe to call on
  // such text because it splits on commas and can mis-identify
  // `OFFSET(Sheet1` as a partial range reference.
  //
  // With a probe: confirm the expression parses before classifying as
  // formula; if the probe rejects it, fall through to opaque.
  // Without a probe: we cannot confirm it parses, so preserve the text
  // verbatim as opaque. This is deliberately strict — the alternative
  // (silently promoting unverified text to `formula`) produced
  // classification results that depended on global install state.
  if (hasParen && !isOpaqueWrapper) {
    if (probe && probe(trimmed)) {
      return { kind: "formula", ranges: [trimmed], formulaExpression: trimmed };
    }
    return { kind: "opaque", ranges: [] };
  }

  // Try to extract cell/range references (handles comma-separated
  // multi-area names). Safe to call only after the paren check above,
  // because `extractRanges` splits on commas.
  const extracted = extractRanges(rawText);
  if (extracted.length > 0) {
    return { kind: "reference", ranges: extracted };
  }

  // Opaque wrappers that didn't pass as a formula above classify
  // straight to opaque — we preserve them verbatim without calculating.
  if (isOpaqueWrapper) {
    return { kind: "opaque", ranges: [] };
  }

  // No parens and not a range — could still be a parseable constant
  // expression or a reference to another defined name. Only classify as
  // formula if a probe can confirm it parses; otherwise stay opaque so
  // round-trip text is preserved without silently promoting unparseable
  // content to the formula bucket.
  if (probe && probe(trimmed)) {
    return { kind: "formula", ranges: [trimmed], formulaExpression: trimmed };
  }

  // Nothing worked — opaque
  return { kind: "opaque", ranges: [] };
}

// ============================================================================
// Internal Key — disambiguates same-name entries with different scopes
// ============================================================================

/**
 * Build the internal storage key for a defined name entry.
 * Workbook-scoped: just the bare name.
 * Sheet-scoped: `"name\0sheetId"` (null char separator avoids collisions).
 */
function storageKey(name: string, localSheetId?: number): string {
  return localSheetId !== undefined ? `${name}\0${localSheetId}` : name;
}

// ============================================================================
// DefinedNames class
// ============================================================================

// ============================================================================
// DefinedNames — de-classed domain model (data record + flat helpers)
// ============================================================================

/**
 * Plain-data defined-names registry (de-classed domain model). All former
 * methods are flat `definedNames*` helpers taking the record as first arg.
 */
export interface DefinedNamesData {
  matrixMap: Record<string, CellMatrix>;
  formulaMap: Record<string, string>;
  localSheetIdMap: Record<string, number>;
  hiddenMap: Record<string, boolean>;
  opaqueMap: Record<string, OpaqueEntry>;
  nameForKey: Record<string, string>;
  /** Optional per-instance formula-syntax probe (see createDefinedNames). */
  _explicitProbe: SyntaxProbe | null;
}

/** Create a defined-names registry, optionally with an explicit syntax probe. */
export function createDefinedNames(probe?: SyntaxProbe): DefinedNamesData {
  return {
    matrixMap: {},
    formulaMap: {},
    localSheetIdMap: {},
    hiddenMap: {},
    opaqueMap: {},
    nameForKey: {},
    _explicitProbe: probe ?? null
  };
}

export function definedNamesGetMatrix(dn: DefinedNamesData, name: string): CellMatrix {
  const matrix = dn.matrixMap[name] || (dn.matrixMap[name] = new CellMatrix());
  return matrix;
}

// add a name to a cell. locStr in the form SheetName!$col$row or SheetName!$c1$r1:$c2:$r2
export function definedNamesAdd(dn: DefinedNamesData, locStr: string, name: string): void {
  const location = colCache.decodeEx(locStr);
  if ("error" in location) {
    return; // Invalid reference, skip
  }
  // A name is either cell-reference or formula — clear any formula/opaque binding
  // (programmatic API always operates on workbook-scoped names)
  delete dn.formulaMap[name];
  delete dn.opaqueMap[name];
  dn.nameForKey[name] = name;
  definedNamesAddEx(dn, location, name);
}

/**
 * Register a hidden defined name that maps a chartEx `_xlchart.vN.M`
 * pointer to a worksheet range. Excel emits one of these for every
 * data reference in a chartEx chart:
 *
 *   <definedName name="_xlchart.v1.0" hidden="1">Sheet1!$A$1:$A$3</definedName>
 *
 * The chartEx then references `_xlchart.v1.0` from its `<cx:f>`
 * element instead of the worksheet range directly. Direct sheet
 * references in `<cx:f>` are rejected by Excel 2016+ with
 * "Removed Part: /xl/drawings/drawingN.xml (Drawing shape)" on
 * load, so chartEx data MUST go through this indirection.
 *
 * Same semantics as `add()` but also marks the name `hidden` so
 * it does not show up in Excel's Name Manager UI.
 *
 * @param locStr - Worksheet reference (e.g. `"Sheet1!$A$1:$A$3"`)
 * @param name   - Defined name to register (e.g. `"_xlchart.v1.0"`)
 */
export function definedNamesAddHidden(dn: DefinedNamesData, locStr: string, name: string): void {
  definedNamesAdd(dn, locStr, name);
  dn.hiddenMap[name] = true;
}

export function definedNamesAddEx(
  dn: DefinedNamesData,
  location: CellLocation,
  name: string
): void {
  const matrix = definedNamesGetMatrix(dn, name);
  if ("top" in location) {
    // It's a range (DecodedRange has top/left/bottom/right from Location)
    for (let col = location.left; col <= location.right; col++) {
      for (let row = location.top; row <= location.bottom; row++) {
        const address = {
          sheetName: location.sheetName,
          address: colCache.n2l(col) + row,
          row,
          col
        };

        matrix.addCellEx(address);
      }
    }
  } else {
    // It's a single cell address
    matrix.addCellEx(location);
  }
}

/**
 * Register a formula-based defined name.
 *
 * Unlike `add()` which binds a name to a cell/range reference, this binds
 * a name to an arbitrary formula expression that will be evaluated at
 * calculation time.
 *
 * @param name - The defined name (e.g. "MyArray")
 * @param expression - The formula expression (e.g. "{1,2;3,4}", "LAMBDA(x,y,x+y)")
 */
export function definedNamesAddFormula(
  dn: DefinedNamesData,
  name: string,
  expression: string
): void {
  // A name is either formula or cell-reference — clear any cell-reference/opaque binding
  // (programmatic API always operates on workbook-scoped names)
  delete dn.matrixMap[name];
  delete dn.opaqueMap[name];
  dn.nameForKey[name] = name;
  dn.formulaMap[name] = expression;
}

export function definedNamesRemove(dn: DefinedNamesData, locStr: string, name: string): void {
  const location = colCache.decodeEx(locStr);
  if ("error" in location) {
    return; // Invalid reference, skip
  }
  definedNamesRemoveEx(dn, location, name);
}

export function definedNamesRemoveEx(
  dn: DefinedNamesData,
  location: CellLocation,
  name: string
): void {
  const matrix = definedNamesGetMatrix(dn, name);
  if ("top" in location) {
    // Range - remove each cell
    for (let col = location.left; col <= location.right; col++) {
      for (let row = location.top; row <= location.bottom; row++) {
        matrix.removeCellEx({
          sheetName: location.sheetName,
          address: colCache.n2l(col) + row,
          row,
          col
        });
      }
    }
  } else {
    matrix.removeCellEx(location);
  }
}

export function definedNamesRemoveAllNames(dn: DefinedNamesData, location: CellLocation): void {
  Object.values(dn.matrixMap).forEach((matrix: CellMatrix) => {
    if ("top" in location) {
      // Range - remove each cell
      for (let col = location.left; col <= location.right; col++) {
        for (let row = location.top; row <= location.bottom; row++) {
          matrix.removeCellEx({
            sheetName: location.sheetName,
            address: colCache.n2l(col) + row,
            row,
            col
          });
        }
      }
    } else {
      matrix.removeCellEx(location);
    }
  });
}

export function definedNamesForEach(
  dn: DefinedNamesData,
  callback: (name: string, cell: DefinedNameCell) => void
): void {
  Object.entries(dn.matrixMap).forEach(([sKey, matrix]) => {
    const bareName = dn.nameForKey[sKey] ?? sKey;
    matrix.forEach((cell: DefinedNameCell) => {
      callback(bareName, cell);
    });
  });
}

// get all the names of a cell
export function definedNamesGetNames(dn: DefinedNamesData, addressStr: string): string[] {
  const location = colCache.decodeEx(addressStr);
  if ("error" in location || "top" in location) {
    return []; // Invalid reference or range not supported
  }
  return definedNamesGetNamesEx(dn, location);
}

export function definedNamesGetNamesEx(dn: DefinedNamesData, address: DecodedAddress): string[] {
  return Object.entries(dn.matrixMap)
    .map(([sKey, matrix]) => matrix.findCellEx(address, false) && (dn.nameForKey[sKey] ?? sKey))
    .filter((name): name is string => Boolean(name));
}

/**
 * Return all defined name entries in this collection, including scope info.
 * Each entry has the bare name and optional localSheetId.
 * Same bare name may appear multiple times with different scopes.
 */
export function definedNamesGetAllNames(
  dn: DefinedNamesData
): { name: string; localSheetId?: number }[] {
  return definedNamesGetAllEntries(dn).map(e =>
    e.localSheetId !== undefined ? { name: e.name, localSheetId: e.localSheetId } : { name: e.name }
  );
}

/**
 * Return all defined name entries with full details (name, ranges, scope).
 *
 * This is the primary enumeration API. Each entry is self-contained —
 * no second lookup is needed. Same bare name may appear multiple times
 * with different scopes.
 */
export function definedNamesGetAllEntries(dn: DefinedNamesData): DefinedNameModel[] {
  const result: DefinedNameModel[] = [];
  const seen = new Set<string>();
  for (const sKey of Object.keys(dn.matrixMap)) {
    if (seen.has(sKey)) {
      continue;
    }
    seen.add(sKey);
    const model = definedNamesGetRanges(dn, sKey);
    const localSheetId = dn.localSheetIdMap[sKey];
    result.push(localSheetId !== undefined ? { ...model, localSheetId } : model);
  }
  for (const sKey of Object.keys(dn.formulaMap)) {
    if (seen.has(sKey)) {
      continue;
    }
    seen.add(sKey);
    const model = definedNamesGetRanges(dn, sKey);
    const localSheetId = dn.localSheetIdMap[sKey];
    result.push(localSheetId !== undefined ? { ...model, localSheetId } : model);
  }
  for (const sKey of Object.keys(dn.opaqueMap)) {
    if (seen.has(sKey)) {
      continue;
    }
    seen.add(sKey);
    const bareName = dn.nameForKey[sKey] ?? sKey;
    const entry = dn.opaqueMap[sKey];
    result.push({
      name: bareName,
      ranges: [],
      rawText: entry.rawText,
      localSheetId: entry.localSheetId,
      kind: "opaque" as const
    });
  }
  return result;
}

export function _definedNamesExplore(
  dn: DefinedNamesData,
  matrix: CellMatrix,
  cell: DefinedNameCell
): RangeData {
  cell.mark = false;
  const sheetName = cell.sheetName!;

  const range = rangeCreate(cell.row, cell.col, cell.row, cell.col, sheetName);
  let x: number;
  let y: number;

  const getCell = (row: number, col: number): DefinedNameCell | undefined => {
    return matrix.findCellAt(sheetName, row, col) as DefinedNameCell | undefined;
  };

  function vGrow(yy: number, edge: "top" | "bottom"): boolean {
    const c = getCell(yy, cell.col);
    if (!c || !c.mark) {
      return false;
    }
    range[edge] = yy;
    c.mark = false;
    return true;
  }
  for (y = cell.row - 1; vGrow(y, "top"); y--) {
    /* advance */
  }
  for (y = cell.row + 1; vGrow(y, "bottom"); y++) {
    /* advance */
  }

  function hGrow(xx: number, edge: "left" | "right"): boolean {
    const cells: DefinedNameCell[] = [];
    for (y = range.top; y <= range.bottom; y++) {
      const c = getCell(y, xx);
      if (c && c.mark) {
        cells.push(c);
      } else {
        return false;
      }
    }
    range[edge] = xx;
    for (let i = 0; i < cells.length; i++) {
      cells[i].mark = false;
    }
    return true;
  }
  for (x = cell.col - 1; hGrow(x, "left"); x--) {
    /* advance */
  }
  for (x = cell.col + 1; hGrow(x, "right"); x++) {
    /* advance */
  }

  return range;
}

/**
 * Get ranges for a specific scoped entry.
 *
 * Unlike `getRanges(name)` which uses the bare name (and may hit the
 * wrong scope when the same name exists both globally and locally),
 * this method uses the internal `storageKey` to look up the exact entry.
 */
export function definedNamesGetRangesScoped(
  dn: DefinedNamesData,
  name: string,
  localSheetId?: number
): DefinedNameModel {
  const sKey = storageKey(name, localSheetId);
  return definedNamesGetRanges(dn, sKey);
}

export function definedNamesGetRanges(
  dn: DefinedNamesData,
  name: string,
  matrix?: CellMatrix
): DefinedNameModel {
  // `name` can be a bare name (backward compat) or a storageKey.
  // Try storageKey first, then bare name (workbook-scoped).
  const formula = dn.formulaMap[name];
  matrix = matrix || dn.matrixMap[name];
  const bareName = dn.nameForKey[name] ?? name;

  if (!matrix) {
    if (formula) {
      return { name: bareName, ranges: [formula], formulaExpression: formula };
    }
    return { name: bareName, ranges: [] };
  }

  // mark and sweep!
  matrix.forEach((cell: DefinedNameCell) => {
    cell.mark = true;
  });
  const ranges = matrix
    .map((cell: DefinedNameCell) => cell.mark && _definedNamesExplore(dn, matrix!, cell))
    .filter((range): range is RangeData => Boolean(range))
    .map((range: RangeData) => rangeAbsoluteShort(range));

  return {
    name: bareName,
    ranges
  };
}

export function definedNamesNormaliseMatrix(
  dn: DefinedNamesData,
  matrix: CellMatrix,
  sheetName: string
): void {
  // some of the cells might have shifted on specified sheet
  // need to reassign rows, cols
  matrix.forEachInSheet(
    sheetName,
    (cell: DefinedNameCell | undefined, row: number, col: number) => {
      if (cell) {
        if (cell.row !== row || cell.col !== col) {
          cell.row = row;
          cell.col = col;
          cell.address = colCache.n2l(col) + row;
        }
      }
    }
  );
}

export function definedNamesSpliceRows(
  dn: DefinedNamesData,
  sheetName: string,
  start: number,
  numDelete: number,
  numInsert: number
): void {
  Object.values(dn.matrixMap).forEach((matrix: CellMatrix) => {
    matrix.spliceRows(sheetName, start, numDelete, numInsert);
    definedNamesNormaliseMatrix(dn, matrix, sheetName);
  });
}

export function definedNamesSpliceColumns(
  dn: DefinedNamesData,
  sheetName: string,
  start: number,
  numDelete: number,
  numInsert: number
): void {
  Object.values(dn.matrixMap).forEach((matrix: CellMatrix) => {
    matrix.spliceColumns(sheetName, start, numDelete, numInsert);
    definedNamesNormaliseMatrix(dn, matrix, sheetName);
  });
}

export function definedNamesModel(dn: DefinedNamesData): DefinedNameModel[] {
  // Cell-reference based names from matrixMap
  const cellNames = Object.entries(dn.matrixMap)
    .map(([sKey, matrix]) => {
      const result = definedNamesGetRanges(dn, sKey, matrix);
      const localSheetId = dn.localSheetIdMap[sKey];
      const hidden = dn.hiddenMap[sKey];
      const out: DefinedNameModel = { ...result };
      if (localSheetId !== undefined) {
        out.localSheetId = localSheetId;
      }
      if (hidden) {
        out.hidden = true;
      }
      return out;
    })
    .filter((definedName: DefinedNameModel) => definedName.ranges.length);

  // Formula-based names from formulaMap (only include names not already in matrixMap)
  const formulaNames = Object.entries(dn.formulaMap)
    .filter(([sKey]) => !dn.matrixMap[sKey])
    .map(([sKey, expression]) => {
      const bareName = dn.nameForKey[sKey] ?? sKey;
      const result: DefinedNameModel = {
        name: bareName,
        ranges: [expression],
        formulaExpression: expression
      };
      const localSheetId = dn.localSheetIdMap[sKey];
      if (localSheetId !== undefined) {
        result.localSheetId = localSheetId;
      }
      if (dn.hiddenMap[sKey]) {
        result.hidden = true;
      }
      return result;
    });

  // Opaque names — rawText preserved for round-trip
  const opaqueNames: DefinedNameModel[] = Object.entries(dn.opaqueMap).map(([sKey, entry]) => {
    const bareName = dn.nameForKey[sKey] ?? sKey;
    const out: DefinedNameModel = {
      name: bareName,
      ranges: [],
      rawText: entry.rawText,
      localSheetId: entry.localSheetId,
      kind: "opaque" as const
    };
    if (dn.hiddenMap[sKey]) {
      out.hidden = true;
    }
    return out;
  });

  return [...cellNames, ...formulaNames, ...opaqueNames];
}

/**
 * Deserialise an array of `DefinedNameModel` entries (typically from XLSX parsing).
 *
 * Stage 2 of the two-phase design: each entry's `rawText` is classified
 * into reference / formula / opaque by `classifyDefinedName()`.  Entries
 * that arrive without `rawText` (programmatic API) fall back to inspecting
 * the existing `ranges` and `formulaExpression` fields for compatibility.
 */
export function definedNamesSetModel(dn: DefinedNamesData, value: DefinedNameModel[]): void {
  const matrixMap = (dn.matrixMap = {} as Record<string, CellMatrix>);
  const formulaMap = (dn.formulaMap = {} as Record<string, string>);
  const localSheetIdMap = (dn.localSheetIdMap = {} as Record<string, number>);
  const hiddenMap = (dn.hiddenMap = {} as Record<string, boolean>);
  const opaqueMap = (dn.opaqueMap = {} as Record<string, OpaqueEntry>);
  const nameForKeyMap = (dn.nameForKey = {} as Record<string, string>);

  // Resolve the probe: an explicit per-instance probe always wins; otherwise
  // use the built-in tokenizer+parser probe. No install step is involved — the
  // probe is reached directly here (only on the XLSX-load path).
  const probe = dn._explicitProbe ?? defaultFormulaSyntaxProbe;

  for (const definedName of value) {
    const sKey = storageKey(definedName.name, definedName.localSheetId);
    nameForKeyMap[sKey] = definedName.name;

    // Track localSheetId for all name kinds
    if (definedName.localSheetId !== undefined) {
      localSheetIdMap[sKey] = definedName.localSheetId;
    }
    if (definedName.hidden) {
      hiddenMap[sKey] = true;
    }

    // Programmatic API path: formulaExpression already set and no rawText
    if (definedName.formulaExpression && definedName.rawText === undefined) {
      formulaMap[sKey] = definedName.formulaExpression;
      continue;
    }

    // XLSX parse path (rawText present) or programmatic path with ranges only
    const classified = classifyDefinedName(definedName.rawText, definedName.ranges, probe);

    switch (classified.kind) {
      case "reference": {
        const matrix = (matrixMap[sKey] = new CellMatrix());
        for (const rangeStr of classified.ranges) {
          if (rangeRegexp.test(rangeStr.split("!").pop() ?? "")) {
            matrix.addCell(rangeStr);
          }
        }
        break;
      }
      case "formula":
        formulaMap[sKey] = classified.formulaExpression!;
        break;
      case "opaque":
        if (definedName.rawText) {
          opaqueMap[sKey] = {
            rawText: definedName.rawText,
            localSheetId: definedName.localSheetId
          };
        }
        break;
    }
  }
}
