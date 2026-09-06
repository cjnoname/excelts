/**
 * Everything XLSB gained in one workbook, written and then read back.
 *
 * The point is not that these features exist — most work in XLSX too — but that they now survive **XLSB**,
 * and survive it *repeatedly*. Each was at some point either refused by the writer, or written and then
 * silently deleted by the next write because nothing read it back.
 *
 * So this example writes the workbook, reads it, writes it again, and reads *that*. A feature that only
 * survives one round trip is not preserved; it is coincidentally intact. Three generations is what
 * distinguishes "reader and writer agree" from "the file is right", and two of the defects behind this
 * example hid at exactly the second generation.
 *
 * Run: pnpm example --filter xlsb-everything
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Image,
  Pivot,
  Watermark,
  Workbook,
  Worksheet,
  type Worksheet as WorksheetNs
} from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-everything.xlsb");

/** A 1×1 transparent PNG, so the example needs no asset on disk. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

// =============================================================================
// Build
// =============================================================================

const workbook = Workbook.create();

// --- The source data a pivot table and a filter both read -------------------
const data = Workbook.addWorksheet(workbook, "Data");
Worksheet.addAoa(data, [
  ["Region", "Rep", "Units"],
  ["APAC", "Ann", 120],
  ["EMEA", "Bo", 80],
  ["APAC", "Cy", 45],
  ["EMEA", "Dee", 200],
  ["APAC", "Eli", 15]
]);

// --- Rows and columns: the seven features that left the loss list -----------
//
// Not one of these needed a new record. Three were lost to `BrtRowHdr`'s flag bytes being described as one
// `u16` — which put `fUnsynced` in `fExtraDsc` and made `iOutLevel`, `fCollapsed` and `fDyZero`
// unaddressable — and four to `BrtColInfo`'s flag word being written as `0x02` and nothing else.
const layout = Workbook.addWorksheet(workbook, "Layout");
Worksheet.addAoa(layout, [
  ["Group", "Detail", "Detail", "Value"],
  ["North", "Q1", "Q2", 10],
  ["North", "Q3", "Q4", 20],
  ["South", "Q1", "Q2", 30]
]);

const layoutModel = Worksheet.getModel(layout);
layoutModel.rows = (layoutModel.rows ?? []).map(row =>
  row.number === 3
    ? { ...row, hidden: true, outlineLevel: 1, collapsed: true }
    : row.number === 2
      ? { ...row, height: 24 }
      : row
);
// `isCustomWidth` is what separates an author's width from the default `setModel` fills in — without it a
// merely-hidden column would pin itself to that default forever.
(layoutModel as { cols?: unknown }).cols = [
  { min: 1, max: 1, width: 18, isCustomWidth: true },
  { min: 2, max: 3, outlineLevel: 1, hidden: true },
  { min: 4, max: 4, bestFit: true }
];
Worksheet.setModel(layout, layoutModel);

// --- Conditional formatting, including the format each rule applies ---------
//
// The rules survived a round trip before this; their *formatting* did not, because `dxfId` indexed a table
// nothing parsed. A rule then fired and displayed nothing, which Excel still lists in its dialog.
const rules = Workbook.addWorksheet(workbook, "Rules");
Worksheet.addAoa(rules, [["Score"], [95], [42], [7], ["n/a"]]);
Worksheet.addConditionalFormatting(rules, {
  ref: "A2:A5",
  rules: [
    {
      type: "cellIs",
      operator: "greaterThan",
      formulae: ["50"],
      priority: 1,
      stopIfTrue: true,
      style: {
        font: { bold: true, size: 12, color: { argb: "FF006100" } },
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFC6EFCE" } },
        border: { top: { style: "thin" }, bottom: { style: "double" } }
      }
    },
    {
      type: "cellIs",
      operator: "lessThan",
      formulae: ["10"],
      priority: 2,
      style: { font: { italic: true, strike: true, color: { argb: "FF9C0006" } } }
    },
    // Five model conditions fold onto one type distinguished by an operator, where the record has five
    // separate templates.
    {
      type: "containsText",
      operator: "containsBlanks",
      priority: 3,
      style: { font: { bold: true } }
    }
  ]
} as never);

// --- An auto filter with six of the seven criterion kinds -------------------
//
// Criteria live on the model as the raw XML the XLSX reader preserved, and are parsed into records here
// rather than modelled — which is what let this work without touching the XLSX path at all.
const filtered = Workbook.addWorksheet(workbook, "Filtered");
Worksheet.addAoa(filtered, [
  ["Region", "Units", "Rated", "When", "Flagged", "Iconed"],
  ["APAC", 120, 3, 45000, 1, 1],
  ["EMEA", 80, 5, 45100, 2, 2]
]);
const filterModel = Worksheet.getModel(filtered);
(filterModel as { autoFilter?: string }).autoFilter = "A1:F3";
(filterModel as { autoFilterCriteria?: { ref: string; xml: string } }).autoFilterCriteria = {
  ref: "A1:F3",
  xml:
    // Values, plus a date group item — siblings inside `<filters>`, walked in document order because
    // reordering them changes which rows show.
    '<filterColumn colId="0"><filters blank="1"><filter val="APAC"/>' +
    '<dateGroupItem year="2023" month="4" dateTimeGrouping="month"/></filters></filterColumn>' +
    // `and="1"` is AND — and the record spells AND as *zero*, so passing the attribute through inverts it.
    '<filterColumn colId="1"><customFilters and="1">' +
    '<customFilter operator="greaterThan" val="50"/>' +
    '<customFilter operator="lessThanOrEqual" val="500"/></customFilters></filterColumn>' +
    '<filterColumn colId="2"><top10 top="1" percent="0" val="10" filterVal="3"/></filterColumn>' +
    // The enumeration has a hole: `aboveAverage` is 1 and the date periods resume at 8.
    '<filterColumn colId="3"><dynamicFilter type="aboveAverage"/></filterColumn>' +
    // `cellColor` is absent-means-*true*, so only the false case is ever written back.
    '<filterColumn colId="4"><colorFilter dxfId="0"/></filterColumn>' +
    '<filterColumn colId="5"><iconFilter iconSet="3TrafficLights1" iconId="0"/></filterColumn>'
};
Worksheet.setModel(filtered, filterModel);

// --- A pivot table: four parts, five cross-part invariants ------------------
//
// It cannot be delivered in stages — the specification requires one cache definition part per
// `BrtBeginPivotCacheID` record in the workbook, so a package with some of these points at what it does not
// contain. Record order comes from MS-XLSB section 3.8, a fifty-seven step worked example.
const pivotSheet = Workbook.addWorksheet(workbook, "Pivot");
Pivot.add(pivotSheet, {
  sourceSheet: data,
  rows: ["Region"],
  columns: [],
  values: ["Units"],
  metric: "sum"
});

// --- Protection with a password, and an overlay watermark -------------------
//
// The password was called physically impossible here for a while: `protpwd` is a 16-bit verifier and the
// model holds a SHA-512 hash. Both true — and `BrtSheetProtectionIso` carries the hash itself, so nothing
// has to be reversed.
const secured = Workbook.addWorksheet(workbook, "Secured");
Worksheet.addAoa(secured, [["Locked down"], ["and watermarked"]]);
await Worksheet.protect(secured, "s3cret", { formatCells: true, sort: true });
await Workbook.protect(workbook, "b00kpass", { lockStructure: true });

// An *overlay* watermark is a picture in the sheet's own drawing. It used to be collected with the header
// pictures, so it came back as a page-header decoration with its opacity dropped — a different document
// rather than a lossy one.
Watermark.add(secured, {
  imageId: Image.add(workbook, { buffer: PNG, extension: "png" }),
  mode: "overlay",
  opacity: 0.25
});

// =============================================================================
// Write, and read back three times
// =============================================================================

/** What survived, read off a workbook. */
function census(book: Workbook.Handle): Record<string, unknown> {
  const sheetNamed = (name: string): WorksheetNs.Handle | undefined =>
    Workbook.getWorksheet(book, name);
  const layoutRows = Worksheet.getModel(sheetNamed("Layout")!).rows ?? [];
  const layoutCols =
    (Worksheet.getModel(sheetNamed("Layout")!) as { cols?: Record<string, unknown>[] }).cols ?? [];
  const ruleBlocks =
    (
      Worksheet.getModel(sheetNamed("Rules")!) as unknown as {
        conditionalFormattings?: { rules: { style?: unknown }[] }[];
      }
    ).conditionalFormattings ?? [];
  const filterCriteria = (
    Worksheet.getModel(sheetNamed("Filtered")!) as {
      autoFilterCriteria?: { xml: string };
    }
  ).autoFilterCriteria;
  const protection = Worksheet.getModel(sheetNamed("Secured")!).sheetProtection as
    | Record<string, unknown>
    | undefined;
  return {
    "hidden row": layoutRows.some(row => row.hidden),
    "grouped row": layoutRows.some(row => (row.outlineLevel ?? 0) > 0),
    "collapsed row": layoutRows.some(row => row.collapsed),
    "custom row height": layoutRows.some(row => row.height === 24),
    "hidden column": layoutCols.some(column => column.hidden === true),
    "grouped column": layoutCols.some(column => (Number(column.outlineLevel) || 0) > 0),
    "best-fit column": layoutCols.some(column => column.bestFit === true),
    "custom column width": layoutCols.some(column => column.isCustomWidth === true),
    "conditional rules": ruleBlocks[0]?.rules.length ?? 0,
    "conditional style": ruleBlocks[0]?.rules[0]?.style !== undefined,
    "filter criteria bytes": filterCriteria?.xml.length ?? 0,
    "sheet password": typeof protection?.hashValue === "string",
    "workbook password":
      typeof (Workbook.getModel(book).protection as { hashValue?: unknown } | undefined)
        ?.hashValue === "string"
  };
}

const before = census(workbook);
let bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
fs.writeFileSync(filename, bytes);

const generations: Record<string, unknown>[] = [];
for (let generation = 0; generation < 3; generation += 1) {
  const reopened = Workbook.create();
  await Workbook.read(reopened, bytes);
  generations.push(census(reopened));
  bytes = await Workbook.toBuffer(reopened, { format: "xlsb" });
}

// =============================================================================
// Report
// =============================================================================

console.log(`Wrote ${filename} (${(fs.statSync(filename).size / 1024).toFixed(1)} KiB)\n`);

const keys = Object.keys(before);
const width = Math.max(...keys.map(key => key.length));
console.log(`${"feature".padEnd(width)}   written   gen 1   gen 2   gen 3`);
console.log("-".repeat(width + 34));
let drifted = 0;
for (const key of keys) {
  const cells = [before[key], ...generations.map(g => g[key])].map(value =>
    String(value).padStart(6)
  );
  const stable = generations.every(g => String(g[key]) === String(before[key]));
  if (!stable) {
    drifted += 1;
  }
  console.log(`${key.padEnd(width)}  ${cells.join("  ")}   ${stable ? "" : "  <-- drifted"}`);
}

console.log(
  `\n${drifted === 0 ? "Every feature survived three generations." : `${drifted} feature(s) drifted.`}`
);
// The writer refuses by default when it must drop something, so reaching here at all means nothing on this
// workbook was reported as lost — no `unsupported: "ignore"` anywhere above.
console.log(
  "No losses were reported: every write above used the default, which refuses rather than drops."
);
