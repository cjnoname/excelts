/**
 * Example: CSV Module — Row / Header / Dynamic-Typing Utilities
 *
 * Covers the lower-level helper functions exported from the Csv namespace that
 * the higher-level parse/format examples never exercise directly:
 * - RowHashArray helpers: Csv.isRowHashArray, Csv.rowHashArrayToValues,
 *   Csv.rowHashArrayToHeaders, Csv.rowHashArrayMapByHeaders
 * - Column / header helpers: Csv.processColumns, Csv.deduplicateHeaders,
 *   Csv.deduplicateHeadersWithRenames
 * - Standalone dynamic typing: Csv.applyDynamicTyping, Csv.applyDynamicTypingToRow
 * - Quoting wrappers / guard: Csv.quoted, Csv.unquoted, Csv.isFormattedValue
 *
 * These are demonstrated purely with console.log (input → output); they produce
 * no files.
 *
 * Usage: pnpm example --filter csv-utilities
 */
import { Csv } from "../index";

// =============================================================================
// 1. Csv.isRowHashArray — type guard for [key, value][] rows
// =============================================================================

console.log("=== 1. Csv.isRowHashArray ===");

const hashRow: [string, unknown][] = [
  ["name", "Alice"],
  ["age", 30],
  ["city", "NYC"]
];
const arrayRow = ["Alice", 30, "NYC"];
const objectRow = { name: "Alice", age: 30 };

console.log("isRowHashArray(hashRow):", Csv.isRowHashArray(hashRow)); // true
console.log("isRowHashArray(arrayRow):", Csv.isRowHashArray(arrayRow)); // false
console.log("isRowHashArray(objectRow):", Csv.isRowHashArray(objectRow)); // false
console.log("isRowHashArray([]):", Csv.isRowHashArray([])); // false (empty)

// =============================================================================
// 2. Csv.rowHashArrayToValues — extract values in order
// =============================================================================

console.log("\n=== 2. Csv.rowHashArrayToValues ===");
console.log("Values:", Csv.rowHashArrayToValues(hashRow)); // ["Alice", 30, "NYC"]

// =============================================================================
// 3. Csv.rowHashArrayToHeaders — extract keys in order
// =============================================================================

console.log("\n=== 3. Csv.rowHashArrayToHeaders ===");
console.log("Headers:", Csv.rowHashArrayToHeaders(hashRow)); // ["name", "age", "city"]

// =============================================================================
// 4. Csv.rowHashArrayMapByHeaders — reorder/pick values by header list
// =============================================================================

console.log("\n=== 4. Csv.rowHashArrayMapByHeaders ===");

// Reorder to a desired column order; missing keys become undefined.
const reordered = Csv.rowHashArrayMapByHeaders(hashRow, ["city", "name", "missing"]);
console.log("Mapped by [city, name, missing]:", reordered); // ["NYC", "Alice", undefined]

// =============================================================================
// 5. Csv.processColumns — normalize column config into keys + headers
// =============================================================================

console.log("\n=== 5. Csv.processColumns ===");

// Mix of plain string names and { key, header } objects.
const processed = Csv.processColumns([
  "name",
  { key: "age", header: "Age (years)" },
  { key: "city" } // header defaults to key
]);
console.log("processColumns result:", processed);
// { keys: ["name", "age", "city"], headers: ["name", "Age (years)", "city"] }

// Empty / undefined input returns null.
console.log("processColumns([]):", Csv.processColumns([])); // null
console.log("processColumns(undefined):", Csv.processColumns(undefined)); // null

// =============================================================================
// 6. Csv.deduplicateHeaders — append suffixes to duplicate names
// =============================================================================

console.log("\n=== 6. Csv.deduplicateHeaders ===");

const dupHeaders = ["id", "name", "name", "name", "id"];
console.log("Original:", dupHeaders);
console.log("Deduplicated:", Csv.deduplicateHeaders(dupHeaders));
// ["id", "name", "name_1", "name_2", "id_1"]

// Empty-string headers get placeholder names too.
console.log("With empties:", Csv.deduplicateHeaders(["a", "", "", "a"]));

// =============================================================================
// 7. Csv.deduplicateHeadersWithRenames — also report what got renamed
// =============================================================================

console.log("\n=== 7. Csv.deduplicateHeadersWithRenames ===");

const withRenames = Csv.deduplicateHeadersWithRenames(["sku", "qty", "sku", "qty"]);
console.log("headers:", withRenames.headers); // ["sku", "qty", "sku_1", "qty_1"]
console.log("renamedHeaders:", withRenames.renamedHeaders);
// { sku_1: "sku", qty_1: "qty" } — maps new name → original name

// Unique headers report no renames (null).
const noRenames = Csv.deduplicateHeadersWithRenames(["a", "b", "c"]);
console.log("renamedHeaders (all unique):", noRenames.renamedHeaders); // null

// =============================================================================
// 8. Csv.applyDynamicTyping — convert a single field value
// =============================================================================

console.log("\n=== 8. Csv.applyDynamicTyping (single value) ===");

// columnConfig === true → default conversion (numbers, booleans, null)
console.log("'42' →", Csv.applyDynamicTyping("42", true)); // 42 (number)
console.log("'3.14' →", Csv.applyDynamicTyping("3.14", true)); // 3.14 (number)
console.log("'true' →", Csv.applyDynamicTyping("true", true)); // true (boolean)
console.log("'null' →", Csv.applyDynamicTyping("null", true)); // null
console.log("'007' →", Csv.applyDynamicTyping("007", true)); // "007" (leading zero preserved)

// columnConfig === false → leave the string untouched
console.log("'42' (config=false) →", Csv.applyDynamicTyping("42", false)); // "42" (string)

// columnConfig === custom function → use the supplied converter
const upper = Csv.applyDynamicTyping("hello", v => v.toUpperCase());
console.log("custom converter →", upper); // "HELLO"

// =============================================================================
// 9. Csv.applyDynamicTypingToRow — convert an object row in place
// =============================================================================

console.log("\n=== 9. Csv.applyDynamicTypingToRow (object row) ===");

// Global typing: every field gets the default conversion.
const rowAll = Csv.applyDynamicTypingToRow(
  { id: "1", score: "98.5", active: "true", code: "007" },
  true
);
console.log("Typed (global true):", rowAll);
// { id: 1, score: 98.5, active: true, code: "007" }

// Per-column typing: only listed columns are converted.
const rowSelective = Csv.applyDynamicTypingToRow(
  { id: "1", score: "98.5", label: "42" },
  { score: true } // id and label stay strings
);
console.log("Typed (per-column):", rowSelective);
// { id: "1", score: 98.5, label: "42" }

// With castDate: ISO date strings become Date objects on listed columns.
const rowDates = Csv.applyDynamicTypingToRow({ joined: "2024-03-01", note: "2024-03-01" }, true, [
  "joined"
]);
console.log("joined is Date:", rowDates.joined instanceof Date); // true
console.log("note stays string:", rowDates.note); // 2024-03-01 (string)

// =============================================================================
// 10. Csv.quoted / Csv.unquoted / Csv.isFormattedValue
// =============================================================================

console.log("\n=== 10. quoted / unquoted / isFormattedValue ===");

const forceQuoted = Csv.quoted("00123");
const forceUnquoted = Csv.unquoted('="00123"');

console.log("quoted('00123'):", forceQuoted); // { value: "00123", quote: true, ... }
console.log("unquoted('=\"00123\"'):", forceUnquoted); // { value: '="00123"', quote: false, ... }

console.log("isFormattedValue(quoted):", Csv.isFormattedValue(forceQuoted)); // true
console.log("isFormattedValue(unquoted):", Csv.isFormattedValue(forceUnquoted)); // true
console.log("isFormattedValue('plain'):", Csv.isFormattedValue("plain")); // false
console.log("isFormattedValue({}):", Csv.isFormattedValue({})); // false

// Practical use: a typeTransform that forces quoting for a code column and
// emits a raw (unquoted) Excel formula for an id column.
const formatted = Csv.format(
  [
    { id: "7", code: "00123", note: "ok" },
    { id: "8", code: "00456", note: "fine" }
  ],
  {
    headers: true,
    columns: ["id", "code", "note"],
    typeTransform: {
      string: (value, ctx) => {
        if (ctx.column === "code") {
          return Csv.quoted(value); // always wrap in quotes
        }
        if (ctx.column === "id") {
          return Csv.unquoted(`="${value}"`); // raw Excel text formula
        }
        return value;
      }
    }
  }
);
console.log("Formatted with quoted/unquoted transforms:\n" + formatted);

console.log("\n=== CSV Utilities Examples Complete ===");
