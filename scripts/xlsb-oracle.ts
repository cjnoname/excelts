/**
 * The XLSB oracle: a corpus of workbooks written twice, once by this library and once by Excel.
 *
 * **Why this exists.** Everything in `pnpm check` establishes that this library agrees with itself. None of it
 * establishes that Excel will open the result, and for XLSB those turned out to be very different properties:
 * a pivot table whose every record matched `[MS-XLSB]` field for field, whose lengths were right, whose
 * cross-part invariants held and which survived three read-write generations, was refused outright. Fourteen
 * separate defects were behind it, and the ones that mattered most were invisible from inside — a record that
 * must carry no payload, a flag bit two positions off, a layout the XML form is allowed to leave to Excel and
 * the binary form is not.
 *
 * The way each of those was finally found was the same: obtain a file Excel wrote for the same content and
 * read the difference. This script makes that repeatable.
 *
 * **The loop.**
 *
 * ```
 * pnpm oracle:generate          # writes tmp/xlsb-oracle/in/*.xlsx
 *                               # → open each in Excel, Save As "Excel Binary Workbook (*.xlsb)"
 *                               #   into tmp/xlsb-oracle/ref/, keeping the base name
 * pnpm oracle:diff              # rebuilds each workbook as XLSB and reports every difference
 * ```
 *
 * Both commands run under `node --import @oxc-node/core/register`, not plain `node`: this file imports the
 * library through the same tsconfig `paths` aliases the source uses, and Node's own type stripping does not
 * resolve those.
 *
 * The manual step is the point: Excel is the only oracle available, and it is not scriptable here. So this is
 * deliberately **not** wired into `pnpm check` — it is a tool for the person doing the work, and its output is
 * a list of leads, not a pass or a fail.
 *
 * **Read the output with the asymmetry in mind.** A difference is not automatically a defect. Excel records
 * the window geometry it happened to have, the user's name, a refresh timestamp, and an identifier or two it
 * chose freely; it also writes informational records this library has no reason to emit. Those are filtered
 * (see `BENIGN`), and the filter is a claim that can be wrong — when in doubt, look at the raw record.
 *
 * **This is a diagnostic, not a CI gate, and it exits 0 with differences on purpose.**
 *
 * The reference files are produced by a person opening each input in Excel and choosing "Save As", so they cannot exist
 * on a clean runner — `tmp/` is gitignored. And a difference is not a failure: every one needs a human to decide whether
 * it is a defect or one of Excel's freedoms, which is what `BENIGN` records. Wiring this into CI would either fail on the
 * missing references or fail on differences already judged benign.
 *
 * What *is* automated from the same evidence: `verify:xlsb-corpus` (semantic checks over real files, including a content
 * fingerprint held across containers) and `verify:libreoffice` (a third-party reader on every package this library
 * writes). Those run without a human in the loop; this does not.
 *
 * **Scope: record streams only.** `records()` walks the `.bin` parts and nothing else, so relationship targets and types,
 * `[Content_Types].xml`, and the drawing and chart XML are outside this comparison. That is a real limit and it is
 * covered elsewhere rather than here: `rewrite-structure.node.test.ts` asserts the package invariants (one declaration
 * per part, one relationship per declared sheet, no dangling `Override`), `verify:libreoffice` catches a package a third
 * party refuses, and the two duplicated-part defects that motivated those checks were found by LibreOffice — not by
 * this.
 *
 * What the loop cannot tell you:
 *
 * - Whether a feature this library writes *only* in XLSB is right, since there is no XLSX for Excel to
 *   convert. Every workbook below is therefore built through the same public API used for both formats.
 * - Anything about a record Excel merely copied from the XLSX it was given. Where this library's XLSX writer
 *   states something unconditionally — `customWidth="1"` on every `<col>`, say — Excel's XLSB repeats it, and
 *   the diff is then a mirror rather than an authority.
 * - Rule-for-rule detail in a case where some items were dropped. The alignment is a longest-common-subsequence
 *   over record names, so three missing conditional-formatting rules make the surrounding rules pair up with
 *   the wrong counterparts. Fix the omission first, then read the bytes.
 */

import fs from "node:fs";
import path from "node:path";

import { extractAll } from "@archive/unzip/extract";
import {
  Cell,
  Chart,
  Column,
  DataValidation,
  DefinedNames,
  Image,
  Pivot,
  Row,
  Sparkline,
  Table,
  Watermark,
  Workbook,
  Worksheet
} from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "tmp", "xlsb-oracle");
const IN = path.join(DIR, "in");
const REF = path.join(DIR, "ref");
const MINE = path.join(DIR, "mine");

/** A workbook built once and written to whichever format is asked for. */
interface Case {
  /** File stem, shared by the `.xlsx` sent to Excel and the `.xlsb` expected back. */
  readonly name: string;
  /** What it is for, printed beside the diff. */
  readonly covers: string;
  readonly build: () => Workbook.Handle;
  /** Anything that has to be awaited — password hashing, mostly. */
  readonly finish?: (workbook: Workbook.Handle) => Promise<void>;
  /**
   * Records Excel is expected to write and this library is not, **for this case only**.
   *
   * Scoped per case rather than added to {@link BENIGN}, because these record names carry real differences
   * elsewhere: suppressing `BrtCellIsst` globally to explain a refreshed pivot would hide every genuinely
   * missing string cell in the other fourteen cases. The entry has to say which case and why.
   */
  readonly excelAlsoWrites?: {
    readonly records: readonly string[];
    readonly why: string;
  };
}

/** Build a case's workbook, including whatever its `finish` has to await. */
async function assemble(item: Case): Promise<Workbook.Handle> {
  const workbook = item.build();
  await item.finish?.(workbook);
  return workbook;
}

/** A one-pixel PNG, for the cases that need an image without needing a picture. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

/** Three rows of something to hang features off. */
function sheetWithData(workbook: Workbook.Handle, name: string): Worksheet.Handle {
  const sheet = Workbook.addWorksheet(workbook, name);
  Worksheet.addAoa(sheet, [
    ["Region", "Units", "Sold"],
    ["APAC", 10, new Date(Date.UTC(2024, 0, 15))],
    ["EMEA", 20, new Date(Date.UTC(2024, 1, 20))],
    ["AMER", 30, new Date(Date.UTC(2024, 2, 25))]
  ]);
  return sheet;
}

const CASES: Case[] = [
  {
    name: "01-panes",
    covers: "BrtPane, BrtSel — frozen rows, frozen columns, frozen both, split",
    build: () => {
      const workbook = Workbook.create();
      const views: [string, Record<string, unknown>][] = [
        ["FrozenRow", { state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }],
        ["FrozenCol", { state: "frozen", xSplit: 1, ySplit: 0, topLeftCell: "B1" }],
        ["FrozenBoth", { state: "frozen", xSplit: 2, ySplit: 1, topLeftCell: "C2" }],
        ["Split", { state: "split", xSplit: 2000, ySplit: 1200, topLeftCell: "C4" }]
      ];
      for (const [name, view] of views) {
        const sheet = sheetWithData(workbook, name);
        const model = Worksheet.getModel(sheet);
        (model as { views?: unknown[] }).views = [view];
        Worksheet.setModel(sheet, model);
      }
      return workbook;
    }
  },
  {
    name: "02-rows-and-columns",
    covers: "BrtRowHdr and BrtColInfo flags — hidden, outline, collapsed, custom width and height",
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Flags");
      Row.setHeight(sheet, 2, 30);
      Row.setHidden(sheet, 3, true);
      Row.setOutlineLevel(sheet, 4, 1);
      Column.setWidth(sheet, 1, 24);
      Column.setHidden(sheet, 2, true);
      Column.setOutlineLevel(sheet, 3, 1);
      return workbook;
    }
  },
  {
    name: "03-conditional-formats",
    covers:
      "BrtBeginCFRule and BrtDXF — including the colour scale, data bar and icon set this writer refuses",
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Rules");
      const rules: Record<string, unknown>[] = [
        {
          ref: "B2:B4",
          rules: [
            {
              type: "cellIs",
              operator: "greaterThan",
              formulae: ["15"],
              priority: 1,
              style: { font: { bold: true } }
            }
          ]
        },
        {
          ref: "C2:C4",
          rules: [
            {
              type: "colorScale",
              priority: 2,
              cfvo: [{ type: "min" }, { type: "max" }],
              color: [{ argb: "FFF8696B" }, { argb: "FF63BE7B" }]
            }
          ]
        },
        {
          ref: "B2:B4",
          rules: [
            {
              type: "dataBar",
              priority: 3,
              cfvo: [{ type: "min" }, { type: "max" }],
              color: [{ argb: "FF638EC6" }]
            }
          ]
        },
        {
          ref: "B2:B4",
          rules: [
            {
              type: "iconSet",
              priority: 4,
              iconSet: "3TrafficLights1",
              cfvo: [
                { type: "percent", value: 0 },
                { type: "percent", value: 33 },
                { type: "percent", value: 67 }
              ]
            }
          ]
        },
        {
          ref: "A2:A4",
          rules: [{ type: "containsText", operator: "containsText", text: "AP", priority: 5 }]
        },
        { ref: "B2:B4", rules: [{ type: "top10", rank: 1, priority: 6 }] }
      ];
      for (const rule of rules) {
        Worksheet.addConditionalFormatting(sheet, rule as never);
      }
      return workbook;
    }
  },
  {
    name: "04-filters",
    covers: "BrtBeginAFilter and BrtBeginFilterColumn — value, custom, top-N and dynamic criteria",
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Filtered");
      const model = Worksheet.getModel(sheet) as Record<string, unknown>;
      model.autoFilter = "A1:C4";
      model.autoFilterCriteria = {
        ref: "A1:C4",
        xml:
          '<filterColumn colId="0"><filters><filter val="APAC"/><filter val="EMEA"/></filters></filterColumn>' +
          '<filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="10"/></customFilters></filterColumn>' +
          '<filterColumn colId="2"><dynamicFilter type="thisYear"/></filterColumn>'
      };
      Worksheet.setModel(sheet, model as never);
      return workbook;
    }
  },
  {
    name: "05-pivots",
    covers:
      "BrtBeginSXView and the pivot line enumeration — several row fields, a page field, several values",
    excelAlsoWrites: {
      records: [
        "BrtCellIsst",
        "BrtCellRk",
        "BrtCellBlank",
        "BrtBeginColInfos",
        "BrtColInfo",
        "BrtEndColInfos",
        // The rest of what a refresh drags in, which the first version of this list missed by naming only the cells.
        // The labels those cells hold have to be interned (`"Sum of Units"`, `"Grand Total"`, `"AMER Total"`), which
        // moves `BrtBeginSst`'s counts and adds the items; the formats they are shown in are new `BrtXF`s — two
        // genuinely different ones, `10 50 00 00` carrying the alignment Excel chose for a body cell; and a pivot
        // whose source is a range in the same workbook gets a self-reference in the externals table.
        "BrtSSTItem",
        "BrtXF",
        "BrtBeginExternals",
        "BrtSupSelf",
        "BrtExternSheet",
        "BrtEndExternals"
      ],
      // Every pivot cache here carries `refreshOnLoad="1"`, so Excel rebuilt all three pivots when it opened
      // the workbook and wrote the result out: the cells of the pivot bodies and the column widths it chose
      // for them. This library's XLSX output has the same three sheets empty, so the two containers agree —
      // what differs is that one of them has been *evaluated*. Computing a pivot body on write is not
      // something this writer does or should do; `refreshOnLoad` is how the file asks for it.
      why: "cells and column widths Excel materialised by refreshing the pivots, which refreshOnLoad asks for"
    },
    build: () => {
      const workbook = Workbook.create();
      const source = sheetWithData(workbook, "Data");
      // One row field: the shape already checked byte for byte against Excel.
      Pivot.add(Workbook.addWorksheet(workbook, "OneRow"), {
        sourceSheet: source,
        rows: ["Region"],
        columns: [],
        values: ["Units"],
        metric: "sum"
      } as never);
      // Two row fields: this library enumerates the plain cross product and Excel inserts subtotal lines, so
      // this is the case its layout is known to approximate.
      Pivot.add(Workbook.addWorksheet(workbook, "TwoRows"), {
        sourceSheet: source,
        rows: ["Region", "Sold"],
        columns: [],
        values: ["Units"],
        metric: "sum"
      } as never);
      // A column field, which moves the data field off the column axis.
      Pivot.add(Workbook.addWorksheet(workbook, "WithColumn"), {
        sourceSheet: source,
        rows: ["Region"],
        columns: ["Sold"],
        values: ["Units"],
        metric: "sum"
      } as never);
      return workbook;
    }
  },
  {
    name: "06-protection",
    covers: "BrtSheetProtectionIso and BrtBookProtectionIso — the record pair and where it goes",
    build: () => {
      const workbook = Workbook.create();
      sheetWithData(workbook, "Locked");
      return workbook;
    },
    // Both are async, so the passwords are applied here rather than in `build`.
    finish: async workbook => {
      await Worksheet.protect(Workbook.getWorksheet(workbook, "Locked")!, "sheetpass", {
        formatCells: true
      });
      await Workbook.protect(workbook, "bookpass", { lockStructure: true });
    }
  },
  {
    name: "07-page-setup",
    covers: "BrtPageSetup, BrtMargins, BrtPrintOptions, header and footer",
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Printed");
      const model = Worksheet.getModel(sheet) as Record<string, unknown>;
      model.headerFooter = { oddHeader: "&LLeft&CMiddle&RRight", oddFooter: "&CPage &P of &N" };
      model.pageSetup = {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        scale: 90,
        horizontalCentered: true
      };
      Worksheet.setModel(sheet, model as never);
      return workbook;
    }
  },
  {
    name: "08-merges-and-links",
    covers: "BrtMergeCell, comments and notes, and the shared string table",
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Mixed");
      Cell.setValue(sheet, "A6", "Merged heading");
      Worksheet.merge(sheet, "A6:C6");
      Cell.setComment(sheet, "B2", { texts: [{ text: "A note" }] } as never);
      Cell.setNote(sheet, "C2", "A note on C2" as never);
      return workbook;
    }
  },
  {
    name: "09-tables",
    covers: "BrtBeginList and the table columns — a ListObject with a header and a totals row",
    build: () => {
      const workbook = Workbook.create();
      // A table owns its own cells, so this sheet starts empty and the rows come from the table.
      const sheet = Workbook.addWorksheet(workbook, "Listed");
      Table.add(
        sheet as never,
        {
          name: "Sales",
          ref: "A1",
          headerRow: true,
          totalsRow: true,
          columns: [
            { name: "Region", filterButton: true },
            { name: "Units", totalsRowFunction: "sum" }
          ],
          rows: [
            ["APAC", 10],
            ["EMEA", 20],
            ["AMER", 30]
          ]
        } as never
      );
      return workbook;
    }
  },
  {
    name: "10-validation-and-names",
    covers:
      "BrtBeginDVals, BrtDVal, BrtName — data validation, defined names, print area and titles",
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Checked");
      // A list, a whole-number range, and a formula — the three shapes a `BrtDVal` takes.
      Cell.setValidation(sheet, "A2", {
        type: "list",
        allowBlank: true,
        formulae: ['"APAC,EMEA,AMER"'],
        showErrorMessage: true,
        errorTitle: "Pick one",
        error: "Not a region"
      } as never);
      Cell.setValidation(sheet, "B2", {
        type: "whole",
        operator: "between",
        formulae: [1, 100],
        showInputMessage: true,
        promptTitle: "Units",
        prompt: "1 to 100"
      } as never);
      Cell.setValidation(sheet, "C2", {
        type: "date",
        operator: "greaterThan",
        formulae: [new Date(Date.UTC(2024, 0, 1))]
      } as never);
      DefinedNames.add(Workbook.getDefinedNames(workbook) as never, "Checked!$B$2", "Threshold");
      const model = Worksheet.getModel(sheet) as Record<string, unknown>;
      model.printArea = "A1:C4";
      model.printTitlesRow = "1:1";
      Worksheet.setModel(sheet, model as never);
      return workbook;
    }
  },
  {
    name: "11-images-and-watermark",
    covers: "BrtDrawing and the drawing part — an anchored image and a header watermark",
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Pictured");
      const id = Image.add(workbook, { buffer: PNG, extension: "png" } as never);
      Image.place(sheet as never, id, { tl: { col: 4, row: 1 }, br: { col: 7, row: 6 } } as never);
      Watermark.add(sheet, { imageId: id, mode: "header" } as never);
      return workbook;
    }
  },
  {
    name: "12-charts",
    covers: "The chart part and BrtDrawing — a column chart over the sheet's own data",
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Charted");
      // Options and anchor are separate arguments; the anchor is the third.
      Chart.addColumn(
        sheet as never,
        {
          title: "Units by region",
          series: [{ name: "Units", categories: "Charted!$A$2:$A$4", values: "Charted!$B$2:$B$4" }]
        } as never,
        { tl: { col: 4, row: 1 }, br: { col: 11, row: 12 } } as never
      );
      return workbook;
    }
  },
  {
    name: "13-sparklines",
    covers:
      "BrtBeginSparklineGroup — a future-record collection, so every record carries an FRTHeader",
    // **Two groups, and the pair is the record of a defect Excel found.** Excel's first conversion of this case
    // produced an XLSB with no sparkline records at all, which looked like Excel rejecting the extension block.
    // It was not: opening the XLSX showed that Excel reads *both* groups — selecting either cell highlights the
    // source range — but painted only the one with a colour. A group with no `<x14:colorSeries>` loads and draws
    // nothing, and the writer now substitutes `accent1` so that cannot happen.
    //
    // The two are kept because they still differ in a way worth watching: E2 takes the substituted default and
    // E3 states its own, so a change that broke either the default or the override shows up here. That pair is
    // what caught the last defect: the stated colour was reaching the XLSB encoder under a field name it does
    // not read (`rgb` where it wants `argb`) and coming out as the automatic palette entry.
    //
    // **Four differences on this case are a known ordering artefact and are deliberately left visible.** Excel
    // emits the two groups in the opposite order to this writer — E3's first — while every cell keeps its own
    // colour, so the content agrees and only the sequence differs. Group order carries no meaning: each group
    // names its own cells. It is *not* in `BENIGN`, because suppressing it means suppressing
    // `BrtBeginSparklineGroup` bytes 10-12 and `BrtSparkline` bytes 16 and 20 — which are the series colour and
    // the sparkline's row. Hiding an ordering difference at the price of blinding the comparison to a wrong
    // colour or a wrong cell is a bad trade, and one sample of two groups is not enough to infer Excel's rule
    // and match it.
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Sparked");
      Sparkline.add(
        sheet as never,
        {
          type: "column",
          sparklines: [{ dataRef: "Sparked!B2:B4", cellRef: "E2" }]
        } as never
      );
      Sparkline.add(
        sheet as never,
        {
          type: "column",
          // `lineColor` is the public option; it maps to `<x14:colorSeries>`. Passing `colorSeries` directly
          // does nothing — `buildSparklineGroup` reads the simplified names.
          lineColor: "FF638EC6",
          sparklines: [{ dataRef: "Sparked!B2:B4", cellRef: "E3" }]
        } as never
      );
      return workbook;
    }
  },
  {
    name: "14-hyperlinks",
    covers: "BrtHLink and the sheet's explicit relationships",
    build: () => {
      const workbook = Workbook.create();
      const sheet = sheetWithData(workbook, "Linked");
      // A hyperlink lives on the cell, and `setValue` with `{ text, hyperlink }` is how it gets there — the
      // worksheet model has no link collection, and setting one on it (as this case first did) writes a
      // property nothing reads.
      Cell.setValue(sheet, "E2", {
        text: "One",
        hyperlink: "https://example.invalid/one"
      } as never);
      Cell.setValue(sheet, "E3", {
        text: "Two",
        hyperlink: "https://example.invalid/two"
      } as never);
      // An internal destination, which carries a location rather than a relationship.
      Cell.setValue(sheet, "E4", { text: "Inside", hyperlink: "#Linked!A1" } as never);
      return workbook;
    }
  },
  {
    name: "15-table-with-drawing",
    covers:
      "where BrtBeginListParts sits relative to BrtDrawing — the one ordering decided by inference",
    // **This case exists to answer a question, not to cover a feature.** `09-tables` established that
    // `BrtBeginListParts` comes after `BrtPageSetup` and immediately before `BrtEndSheet`, but that sheet has
    // no drawing, so its position relative to `BrtDrawing` and `BrtLegacyDrawing` is unobserved. This writer
    // places it after them. A sheet carrying a table, a picture and a comment puts all four records in one
    // stream, so Excel's own ordering settles it on the next Save-As.
    build: () => {
      const workbook = Workbook.create();
      const sheet = Workbook.addWorksheet(workbook, "Both");
      Table.add(
        sheet as never,
        {
          name: "Items",
          ref: "A1",
          headerRow: true,
          columns: [{ name: "Item" }, { name: "Qty" }],
          rows: [
            ["Bolt", 4],
            ["Nut", 7]
          ]
        } as never
      );
      Image.place(sheet as never, Image.add(workbook, { buffer: PNG, extension: "png" } as never), {
        tl: { col: 4, row: 1 },
        br: { col: 7, row: 6 }
      } as never);
      // A comment adds `BrtLegacyDrawing`, so the tail holds three part pointers plus the list.
      Cell.setComment(sheet, "A2", { texts: [{ text: "counted" }] } as never);
      return workbook;
    }
  }
];

/**
 * Differences that say nothing about correctness.
 *
 * Every entry is a judgement, and a wrong one hides a defect — so each says *why* rather than just naming a
 * record. Keyed by record name; a byte offset list narrows it to particular fields.
 */
/**
 * Parts Excel writes that this library deliberately does not — **caches, and the reason is the same for both.**
 *
 * Neither is required: every one of the fifteen cases here, and every example a human has opened, loads in
 * Excel without them. What they have in common is that each is a *derived* artefact whose only failure mode is
 * being silently wrong, so writing one badly is worse than not writing it.
 *
 * This is not a filter for something unexplained. It is a recorded decision, and it is listed here so the diff
 * shows leads rather than twenty-two lines of settled policy.
 */
const EXCEL_ONLY_PARTS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /^xl\/worksheets\/binaryIndex\d+\.bin$/,
    // `BrtIndexBlock` + `BrtIndexRowBlock` + `BrtIndexPartEnd`, and the middle one carries `ibBaseOffset` — a
    // 64-bit *byte offset into the worksheet part* for the first cell of each 32-row block, plus a per-row
    // column bitmask and a sub-offset array. It is a random-access index: with it Excel can seek to a row
    // without parsing the sheet, and without it Excel parses the sheet, which is what it does for every file
    // this library has ever written.
    //
    // The offsets could be computed exactly — walk the emitted part and record where each cell record starts —
    // so this is not "unimplementable". It is declined because the cost of being wrong is asymmetric: an
    // offset one byte out points Excel into the middle of a record, and nothing here could detect that. The
    // benefit is read speed on large sheets; the risk is silent corruption.
    //
    // Excel's own `BrtIndexBlock` also carries `unused1 = 26` in all twenty-one instances, a field the
    // specification says is undefined and MUST be ignored — so byte-for-byte agreement is not even available
    // as a check.
    why: "a byte-offset index for fast row seeking; a wrong offset is silent corruption and gains only speed"
  },
  {
    pattern: /^xl\/calcChain\.bin$/,
    // The order Excel evaluated the formulas in. Excel rebuilds it, and this library says so rather than
    // guessing at it: `BrtCalcProp`'s `recalcID` is 0, which the specification defines as forcing a full
    // recalculation, and the XLSX writer now emits `<calcPr fullCalcOnLoad="1">` for the same reason. A
    // workbook that asks to be fully recalculated has no use for a chain describing an order it will not use.
    //
    // Writing one would mean computing a dependency order for formulas this library does not evaluate — a
    // guess about something Excel is about to discard.
    why: "the evaluation order Excel rebuilds; recalcID 0 and fullCalcOnLoad ask it to"
  }
];

const BENIGN: ReadonlyMap<string, { readonly why: string; readonly offsets?: readonly number[] }> =
  new Map([
    [
      "BrtHLink",
      {
        why:
          "the relationship id is allocated freely, and Excel additionally repeats the cell's own text in the " +
          "display field — one internal link in the whole reference set does that, which is not enough to call it " +
          "a rule. The destination itself is compared: writing an internal link as an external relationship was a " +
          "real defect and is fixed."
      }
    ],
    [
      "BrtWsDim",
      {
        why:
          "a pivot sheet's extent is the range *after a refresh*, which is Excel's and is not in the file — Excel " +
          "writes rows 2..6 where the declared anchor is A3:B4. The anchor now reaches the record (it used to say " +
          "0..0, an empty sheet, which Excel never writes: 21 of 21 reference records state a real extent), and the " +
          "remaining gap is the refresh. This case builds its pivots without an anchor at all, so it understates " +
          "further than a real one would."
      }
    ],
    [
      "BrtDrawing",
      {
        why:
          "the relationship id, and both files are internally consistent. Excel's is `rId2` because its `rId1` is " +
          "`xl/worksheets/binaryIndexN.bin` — a private row-offset index it writes for all 21 worksheets and this " +
          "library writes for none. Deliberately not implemented: its offsets are not relative to the part (the " +
          "index claims 0x2d where the first `BrtRowHdr` sits at 0xb3), so the base is unknown, and 2 of the 23 real " +
          "XLSB files in the corpus carry no index at all and read correctly — it is an optional accelerator, not a " +
          "required part. Guessing at a performance index is how you produce a file that opens slowly *and* wrongly."
      }
    ],
    [
      "BrtBeginIconSet",
      {
        why:
          "Excel sets bits 3-5 beside the two this writer knows (`fIcon`/`fReverse`), and there is exactly one " +
          "`BrtBeginIconSet` in the whole reference set to learn them from. One sample has twice been enough to " +
          "infer a rule here and be wrong — see the array-formula flags — so it stays unexplained rather than copied."
      }
    ],
    [
      "BrtColor",
      {
        why:
          "the colour *kind* differs only where the model has no colour to state: a data bar with no colour of its " +
          "own. Excel writes `01 40 00 00 ff ff ff 00` there and `01 40 00 00 00 00 00 00` for an automatic font " +
          "colour in `date.xlsb` — both are Excel's, so the trailing RGB of an automatic colour is context-dependent " +
          "rather than a constant this writer can adopt. The colour-scale colours in the same file are byte-identical."
      }
    ],
    [
      "BrtBeginCustomFilters",
      {
        why:
          "`fAnd` on a filter with a *single* criterion, where AND and OR select the same rows. Excel writes 0 and " +
          "this writer derives 1 from the absent `and` attribute, which is the correct reading of a two-criterion " +
          "filter — and the whole reference set contains one custom filter, with one criterion, so there is nothing " +
          "here to distinguish 'Excel normalises the meaningless case' from 'Excel reads the default differently'. " +
          'The inversion itself (0 is AND in BIFF12, `and="1"` in XML) is verified and is not what differs.'
      }
    ],
    [
      "BrtDynamicFilter",
      {
        why:
          "the two `Xnum` bounds Excel computed *on the day it saved*: 46023 and 46388, which are 2026-01-01 and " +
          "2027-01-01 for a `thisYear` filter saved in 2026. A dynamic filter is recalculated on open — that is what " +
          "makes it dynamic — so this writer leaves both at 0 with `fApplied` clear, and a stale bound would be worse " +
          "than an absent one. The filter *type* is compared and matches."
      }
    ],
    // ── Records that carry nothing but a relationship id, all displaced by one absent part ──────────────────
    //
    // Excel's `rId1` on every worksheet is `xl/worksheets/binaryIndexN.bin`, a private row-offset index it writes for
    // all 21 reference worksheets and this library writes for none — so every other relationship on the sheet is
    // numbered one higher than its counterpart here. Both files are internally consistent: each id resolves, in its own
    // `.rels`, to the part the record is about.
    //
    // The index is deliberately not implemented: its offsets are not relative to the part (it claims 0x2d where the
    // first `BrtRowHdr` sits at 0xb3), so the base is unknown, and 2 of the 23 real XLSB files in the corpus carry no
    // index at all and read correctly. Guessing at a performance index produces a file that opens slowly *and* wrongly.
    ["BrtDrawing", { why: "relationship id, displaced by Excel's binaryIndex part taking rId1" }],
    [
      "BrtLegacyDrawing",
      { why: "relationship id, displaced by Excel's binaryIndex part taking rId1" }
    ],
    [
      "BrtLegacyDrawingHF",
      { why: "relationship id, displaced by Excel's binaryIndex part taking rId1" }
    ],
    ["BrtListPart", { why: "relationship id, displaced by Excel's binaryIndex part taking rId1" }],

    // ── A merged range's cells point at a format Excel duplicated ───────────────────────────────────────────
    [
      "BrtCellBlank",
      {
        why:
          "the style index on the cells of a merged range: Excel points them at a `BrtXF` it added, whose 16 bytes " +
          "are *identical* to the default it already had. A duplicate format is Excel's to make and describes the " +
          "same formatting — the merge itself is compared and matches."
      }
    ],
    ["BrtCellIsst", { why: "the style index, as for `BrtCellBlank`" }],
    [
      "BrtBeginCellXFs",
      {
        why:
          "the count of cell formats, higher in Excel's file because it adds a format identical to one it already " +
          "has — `xf2` in `08-merges-and-links` is byte-for-byte `xf0`. The formats themselves are compared."
      }
    ],

    // ── Single samples: a correlation over one instance is not a rule ───────────────────────────────────────
    [
      "BrtBeginIconSet",
      {
        why:
          "Excel sets bits 3-5 beside the two this writer knows, and there is exactly one `BrtBeginIconSet` in the " +
          "whole reference set to learn them from. One sample has already been enough to infer a rule here and be " +
          "wrong — see the array-formula flags — so it stays unexplained rather than copied."
      }
    ],
    [
      "BrtDVal",
      {
        why:
          "bit 7, which MS-XLSB documents as `unused` and MUST-ignore. Excel sets it on the one `list` validation in " +
          "the reference set and leaves it clear on the `whole` and `date` ones beside it. Writing a reserved bit on " +
          "that evidence is how a file starts depending on an undocumented meaning."
      }
    ],
    [
      "BrtBeginCustomFilters",
      {
        why:
          "`fAnd` on a filter with a *single* criterion, where AND and OR select the same rows. Nothing in the " +
          "reference set distinguishes 'Excel normalises the meaningless case' from 'Excel reads the default " +
          "differently'. The inversion itself (0 is AND in BIFF12) is verified and is not what differs."
      }
    ],
    [
      "BrtColor",
      {
        why:
          "the trailing RGB of an *automatic* colour, where the model has no colour to state. Excel writes " +
          "`01 40 00 00 ff ff ff 00` for a data bar and `01 40 00 00 00 00 00 00` for an automatic font colour in " +
          "`date.xlsb` — both are Excel's, so this is context-dependent rather than a constant to adopt. The " +
          "colour-scale colours in the same file are byte-identical."
      }
    ],

    // ── Values that are a function of when Excel saved, or of a secret ──────────────────────────────────────
    [
      "BrtDynamicFilter",
      {
        why:
          "the two `Xnum` bounds Excel computed on the day it saved — 45306+ for a `thisYear` filter. A dynamic " +
          "filter is recalculated on open, which is what makes it dynamic, so this writer leaves both 0 with " +
          "`fApplied` clear; a stale bound is worse than an absent one. The filter type matches."
      }
    ],
    [
      "BrtBookProtectionIso",
      {
        why:
          "the salt and the hash it produces. Everything around them matches byte for byte — 100,000 iterations, " +
          "`SHA-512`, a 16-byte salt — and a salt that reproduced Excel's would defeat its purpose."
      }
    ],
    ["BrtSheetProtectionIso", { why: "the salt and hash, as for `BrtBookProtectionIso`" }],

    // ── Ordering, where the file states the order some other way ────────────────────────────────────────────
    [
      "BrtBeginConditionalFormatting",
      {
        why:
          "the order of the `<conditionalFormatting>` blocks, which group rules by the range they apply to. Both " +
          "files hold the same six rules with the same priorities — the field that decides evaluation order — and " +
          "Excel emits the block containing `cellIs` first where this library emits it last."
      }
    ],
    [
      "BrtBeginCFRule",
      { why: "position, following the block order — see `BrtBeginConditionalFormatting`" }
    ],
    [
      "BrtBeginSparklineGroup",
      {
        why:
          "group order is reversed. This library writes groups in the order the source `<x14:sparklineGroups>` " +
          "lists them and Excel's save reverses the pair; each group keeps its own colour and anchor, so nothing is " +
          "mixed up. Matching would mean writing an order the source does not state."
      }
    ],
    ["BrtSparkline", { why: "follows its group — see `BrtBeginSparklineGroup`" }],

    // ── Two where matching Excel would cost something worth more ────────────────────────────────────────────
    [
      "BrtRowHdr",
      {
        why:
          "the column span, which Excel states sheet-wide and this writer states per row: `{0, 4}` on all four rows " +
          "of `14-hyperlinks` against `{0, 2}` on the first, which holds three cells. Matching it was tried and " +
          "reverted — a streaming writer has not seen the later rows when it emits a row header, so sheet-wide spans " +
          "make a streamed part differ from a buffered one, and holding those byte-identical is worth more than a " +
          "hint for sizing a buffer."
      }
    ],
    [
      "BrtFmlaNum",
      {
        why:
          "the cached result. Excel recalculated on open and saved the value; this case builds its formulas without " +
          "calling `calculateFormulas`, so the cache is 0 and the *expression* matches. Real output does carry " +
          "cached values — `examples/utils/write-both.ts` recalculates, which took `sales-dashboard` from 498 s to " +
          "32 s in LibreOffice."
      }
    ],
    [
      "BrtBeginSst",
      {
        why:
          "the string counts, higher in Excel's file because refreshing the pivots materialised their labels into " +
          "cells — 30 total and 11 unique against 6 and 6. Covered by `05-pivots`'s `excelAlsoWrites`."
      }
    ],
    // ── The externals block, on three cases where nothing here resolves an `ixti` ───────────────────────────
    //
    // Each was checked individually and the reasoning is recorded in `xlsb/write/workbook.ts`: `03`'s `containsText`
    // formula uses a `PtgRefN` (same-sheet offset), `05`'s pivot cache names its source sheet by name in
    // `BrtBeginPCDSRange`, and `12`'s chart series formulas live in an XML part with no `ixti` at all. So at least one
    // input to Excel's decision is not visible from the model, and this writer emits the table when something needs it
    // rather than reproducing a rule it has not worked out — the failure mode of being narrow is a dangling index, and
    // there is no index to dangle.
    //
    // **Not dead weight, despite carrying no *byte* difference.** `oracle:audit` measures each rule by re-running the
    // comparison with it switched off; removing this one takes the total from 1 to 607, because what it suppresses is
    // the *insertion* of a whole block and the realignment that follows. An audit that counted only same-position byte
    // differences called it zero, which is why the audit re-runs the real comparison instead.
    [
      "BrtBeginExternals",
      { why: "written only when an `ixti` resolves; see xlsb/write/workbook.ts" }
    ],
    ["BrtSupSelf", { why: "part of the externals block — see `BrtBeginExternals`" }],
    ["BrtExternSheet", { why: "part of the externals block — see `BrtBeginExternals`" }],
    ["BrtEndExternals", { why: "part of the externals block — see `BrtBeginExternals`" }],
    [
      "BrtXF",
      {
        why:
          "a cell format identical to one the file already has: Excel added a second `10 10 00 00` to " +
          "`08-merges-and-links` for the cells of a merged range to point at. A duplicate is Excel's to make."
      }
    ],
    ["BrtFileRecover", { why: "same payload, different position in the workbook stream" }],
    [
      "BrtEndCFRule",
      { why: "position, following the block order — see `BrtBeginConditionalFormatting`" }
    ],
    [
      "BrtEndConditionalFormatting",
      { why: "position, following the block order — see `BrtBeginConditionalFormatting`" }
    ],
    ["BrtACBegin", { why: "product-version stamp; informational" }],
    ["BrtACEnd", { why: "product-version stamp; informational" }],
    ["BrtFRTBegin", { why: "future-record extension block, the binary form of <extLst>" }],
    ["BrtFRTEnd", { why: "future-record extension block" }],
    ["BrtFileVersion", { why: "the build of Excel that wrote the file" }],
    ["BrtBookView", { why: "the window geometry Excel happened to have on screen" }],
    ["BrtWbProp", { why: "carries a theme/version stamp Excel sets and this library does not" }],
    ["BrtCalcProp", { why: "iteration settings Excel records from its own options" }],
    [
      "BrtBeginPivotCacheDef",
      { why: "holds the refreshing user's name and a refresh timestamp; both optional" }
    ],
    [
      "BrtBeginPivotCacheID",
      {
        why: "idSx is chosen freely, and both files are internally consistent",
        offsets: [0, 1, 2, 3]
      }
    ],
    ["BrtBeginSXView", { why: "idCache pairs with idSx above", offsets: [28, 29, 30, 31] }],
    [
      "BrtWsFmtInfo",
      {
        // `dxGCol` is the default column width in 1/256 of a standard digit, or `0xFFFFFFFF` meaning "not
        // stated — derive it from `cchDefColWidth`". This library writes the second form with
        // `cchDefColWidth = 8`, which is exactly what its XLSX output says by *omitting* `defaultColWidth`
        // and letting `baseColWidth` default to 8. Excel writes the resolved value instead: `d5 08` is 2261,
        // and `(8 x 6 + 5) / 6 x 256` truncates to 2261 — the OOXML formula for a base width of 8 with a
        // maximum digit width of six pixels.
        //
        // So the two files state the same width; Excel caches the resolution and this library does not.
        // Producing that number requires the pixel metrics of the default font on the machine doing the
        // writing, which is the environment-dependent fact `0xFFFFFFFF` exists to avoid asserting — and
        // Excel arrives at the same 8.83 from either of this library's containers. `cchDefColWidth` differs
        // for the same reason: the specification says it MUST be ignored when `dxGCol` is not `0xFFFFFFFF`,
        // so Excel's `10` is a value it never reads back.
        why: "Excel caches the resolved default column width; this library states the base width instead",
        offsets: [0, 1, 2, 3, 4, 5]
      }
    ],
    [
      "BrtRowHdr",
      {
        // `miyRw` is in twips — 1/20 point, confirmed by the record's own `MUST be <= 8192` against Excel's
        // 409.5pt maximum. A row this library writes at `ht="30"` (600 twips) comes back from Excel at 800,
        // and every other byte of the record, `fUnsynced` included, is identical. 800/600 is exactly 4/3, the
        // point-to-pixel ratio, which points at the display scaling of the machine that ran the conversion
        // rather than at anything in the file.
        //
        // Filtered rather than matched: a caller asking for 30 points must get 30 points, so following Excel
        // here would be following a machine.
        why: "row height comes back scaled by 4/3, which is the converting machine's DPI, not the file's",
        offsets: [8, 9]
      }
    ]
  ]);

const hex = (bytes: Uint8Array): string =>
  [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(" ");

/** Every `.bin` part of a package, as record name and payload. */
async function records(
  file: string
): Promise<Map<string, { name: string; payload: Uint8Array }[]>> {
  const parts = await extractAll(new Uint8Array(fs.readFileSync(file)));
  const out = new Map<string, { name: string; payload: Uint8Array }[]>();
  for (const [name, entry] of parts) {
    if (!name.endsWith(".bin")) {
      continue;
    }
    // The scope only picks which names a few overlapping identifiers resolve to; a worksheet is "s" and
    // everything else reads correctly as "w".
    const scope = name.includes("/worksheets/") || name.includes("/pivotTables/") ? "s" : "w";
    const list: { name: string; payload: Uint8Array }[] = [];
    try {
      for (const record of iterateInterpretableRecords(entry.data, scope)) {
        list.push({
          name: recordSpec(record.id)?.name ?? `?${record.id}`,
          payload: record.payload ?? new Uint8Array()
        });
      }
    } catch (cause) {
      // **A part this library cannot walk is itself the finding — including when it cannot walk either side.**
      //
      // This pushed an empty `<unreadable>`, so two parts that both failed to parse compared as identical and the run
      // reported nothing. The comment claimed the opposite. The message goes in the payload so the two sides differ
      // unless they failed the same way, and a marker name keeps it out of `BENIGN`'s reach.
      const detail = cause instanceof Error ? cause.message : String(cause);
      list.push({
        name: "<unreadable>",
        payload: new TextEncoder().encode(detail.slice(0, 120))
      });
    }
    out.set(name, list);
  }
  return out;
}

/**
 * Maps a reference pivot-cache part name to the equivalent part in this library's output.
 *
 * The equivalence is "reached from the pivot table on the same worksheet". Anything that cannot be resolved is left out,
 * so an unmatched part still compares by name and shows up rather than being silently skipped.
 */
async function pivotCachePairing(
  reference: string,
  ours: string
): Promise<ReadonlyMap<string, string>> {
  const byTable = async (file: string): Promise<Map<string, string>> => {
    const parts = await extractAll(new Uint8Array(fs.readFileSync(file)));
    const text = (name: string): string =>
      parts.has(name) ? new TextDecoder().decode(parts.get(name)!.data) : "";
    const out = new Map<string, string>();
    for (const relsPath of [...parts.keys()].filter(name =>
      /worksheets\/_rels\/sheet\d+\.bin\.rels$/.test(name)
    )) {
      const sheet = /sheet(\d+)\.bin\.rels$/.exec(relsPath)?.[1];
      for (const match of text(relsPath).matchAll(/pivotTable(\d+)\.bin/g)) {
        const cacheRels = `xl/pivotTables/_rels/pivotTable${match[1]}.bin.rels`;
        const cache = /pivotCacheDefinition(\d+)\.bin/.exec(text(cacheRels))?.[1];
        if (sheet !== undefined && cache !== undefined) {
          // Keyed by sheet and by the pivot's position on it, so two pivots on one sheet stay distinct.
          out.set(`${sheet}:${match[1]}`, cache);
        }
      }
    }
    return out;
  };
  const theirs = await byTable(reference);
  const mine = await byTable(ours);
  const pairing = new Map<string, string>();
  for (const [key, theirCache] of theirs) {
    const ourCache = mine.get(key);
    if (ourCache === undefined || ourCache === theirCache) {
      continue;
    }
    pairing.set(
      `xl/pivotCache/pivotCacheDefinition${theirCache}.bin`,
      `xl/pivotCache/pivotCacheDefinition${ourCache}.bin`
    );
    pairing.set(
      `xl/pivotCache/pivotCacheRecords${theirCache}.bin`,
      `xl/pivotCache/pivotCacheRecords${ourCache}.bin`
    );
  }
  return pairing;
}

/** Longest common subsequence over record names, so insertions show as insertions. */
function align(a: readonly string[], b: readonly string[]): [number | null, number | null][] {
  const table: Int32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Int32Array(b.length + 1)
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: [number | null, number | null][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      pairs.push([null, j]);
      j += 1;
    } else {
      pairs.push([i, null]);
      i += 1;
    }
  }
  return pairs;
}

async function generate(): Promise<void> {
  fs.mkdirSync(IN, { recursive: true });
  fs.mkdirSync(REF, { recursive: true });
  let rewritten = 0;
  for (const item of CASES) {
    const file = path.join(IN, `${item.name}.xlsx`);
    const bytes = await Workbook.toBuffer(await assemble(item), { format: "xlsx" });
    // **Only written when the case actually changed.** The staleness check in `diff` compares modification
    // times, and rewriting an unchanged input would age every reference on every run — turning a check that
    // catches a real problem into noise that hides it. A signature is used rather than the bytes because two
    // runs are never byte-identical: `docProps/core.xml` carries a timestamp.
    const signature = await structuralSignature(bytes);
    const stamp = path.join(IN, `${item.name}.sig`);
    const unchanged = fs.existsSync(file) && readIfPresent(stamp) === signature;
    if (!unchanged) {
      fs.writeFileSync(file, bytes);
      fs.writeFileSync(stamp, signature);
      rewritten += 1;
    }
    console.log(`  ${item.name}.xlsx`.padEnd(34) + (unchanged ? "unchanged — " : "") + item.covers);
  }
  console.log(
    `\n${rewritten} of ${CASES.length} workbooks rewritten in ${path.relative(ROOT, IN)}` +
      ` (the rest were already current)\n\n` +
      `In Excel, open each and Save As → Excel Binary Workbook (*.xlsb) into\n` +
      `  ${path.relative(ROOT, REF)}/\n` +
      `keeping the same base name. Then run: pnpm oracle:diff\n\n` +
      `Partial is useful — the diff reports on whatever is present.`
  );
}

/**
 * A hash of everything in a generated workbook except what changes on every run.
 *
 * `docProps/core.xml` holds created/modified timestamps, so two generations of an identical case differ in
 * bytes. Excluding it makes "did this case change?" answerable.
 */
async function structuralSignature(bytes: Uint8Array): Promise<string> {
  const parts = await extractAll(bytes);
  const pieces: string[] = [];
  for (const name of [...parts.keys()].sort()) {
    if (name === "docProps/core.xml") {
      continue;
    }
    // **The password salts are excluded too, and they are not a defect.** ISO password protection draws a
    // fresh random salt on every write — that is the point of a salt — so a case using it differs in bytes
    // every run without differing in what it tests. Left in, two cases would report themselves changed forever
    // and their references would look permanently stale, which is the noise this signature exists to avoid.
    const text = new TextDecoder("utf-8", { fatal: false })
      .decode(parts.get(name)!.data)
      .replace(/((?:workbook)?(?:hash|salt)Value)="[^"]*"/gi, '$1="<salted>"')
      // …and the GUID a conditional-formatting extension gets on its *first* write, for the same reason. It
      // appears twice — as `<x14:id>` on the plain rule and as `id=` on its `x14:cfRule` counterpart, which is
      // what links the two — so both spellings are normalised. Verified to be minted once and then reused: a
      // read-modify-write keeps the GUID it read, so this is fresh-generation randomness rather than an
      // idempotency defect.
      .replace(/\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}/gi, "{minted}");
    pieces.push(`${name}:${text.length}`);
    pieces.push(text);
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pieces.join("\u0000"))
  );
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function readIfPresent(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

/**
 * The one `BENIGN` entry currently switched off, for `audit`.
 *
 * Module-level rather than a parameter because `diff` is deep and the alternative is threading an option through every
 * function between here and the comparison.
 */
let SUPPRESSED_RULE: string | undefined;
/** A whole set switched off at once — see the group pass in `audit`. */
let SUPPRESSED_GROUP: ReadonlySet<string> | undefined;

/**
 * Whether a record name is currently filtered.
 *
 * One place, because `audit` has to be able to switch a rule off everywhere it is consulted — and the byte-difference
 * branch and the two insertion branches consulted `BENIGN` separately. An audit that reached only one of them reported
 * the externals block as weightless.
 */
function isBenign(name: string): boolean {
  if (SUPPRESSED_RULE === name || SUPPRESSED_GROUP?.has(name) === true) {
    return false;
  }
  return BENIGN.has(name);
}

/**
 * Reports what each `BENIGN` entry actually hides.
 *
 * The header of this file says a *missing* difference can mean the filter is too eager, and until this existed there was
 * no way to check that claim. An entry that suppresses nothing is either obsolete or was never reached; an entry hiding
 * far more than its `why` accounts for is where a real difference can sit behind a true statement about a different
 * record.
 *
 * **Each rule is switched off and the whole comparison re-run.** A cheaper audit that counted same-position byte
 * differences was tried first and got two answers badly wrong: it reported `BrtWsFmtInfo` correctly at 21 but called
 * `BrtBeginExternals` *zero*, because what that rule suppresses is the insertion of a four-record block and the
 * realignment that follows — deleting it on that advice took the total from 1 difference to 607.
 */
async function audit(): Promise<void> {
  const baseline = await diff(true);
  console.log(`baseline (all rules on): ${baseline}\n`);
  const rows: { name: string; hides: number }[] = [];
  for (const name of BENIGN.keys()) {
    SUPPRESSED_RULE = name;
    rows.push({ name, hides: (await diff(true)) - baseline });
  }
  SUPPRESSED_RULE = undefined;
  // **Groups, because a rule can read as weightless while its neighbours carry it.**
  //
  // The externals block is four records that appear and disappear together. Switch off any one of them and the other
  // three still absorb the realignment, so each measures zero individually — while removing all four takes the total
  // from 1 to 607. Reporting the group is the only way that fact is visible from this output.
  const groups: readonly (readonly string[])[] = [
    ["BrtBeginExternals", "BrtSupSelf", "BrtExternSheet", "BrtEndExternals"],
    ["BrtACBegin", "BrtACEnd"],
    ["BrtFRTBegin", "BrtFRTEnd"],
    [
      "BrtBeginConditionalFormatting",
      "BrtBeginCFRule",
      "BrtEndCFRule",
      "BrtEndConditionalFormatting"
    ],
    ["BrtBeginSparklineGroup", "BrtSparkline"]
  ];
  const groupRows: { label: string; hides: number }[] = [];
  for (const group of groups) {
    SUPPRESSED_GROUP = new Set(group);
    groupRows.push({ label: group.join(" + "), hides: (await diff(true)) - baseline });
  }
  SUPPRESSED_GROUP = undefined;
  rows.sort((left, right) => right.hides - left.hides || left.name.localeCompare(right.name));
  for (const row of rows) {
    console.log(
      `  ${row.name.padEnd(32)} ${String(row.hides).padStart(4)}` +
        (row.hides === 0 ? "   ← suppresses nothing" : "")
    );
  }
  console.log("\nAs groups, for rules that only ever appear together:");
  for (const row of groupRows) {
    console.log(`  ${row.label.padEnd(64)} ${String(row.hides).padStart(4)}`);
  }
  const dead = rows.filter(row => row.hides === 0).length;
  console.log(
    `\n${rows.length} rules, ${rows.length - dead} carrying weight, ${dead} suppressing nothing.\n` +
      "A rule suppressing nothing is obsolete or unreached; either is worth knowing. Before removing one, check it\n" +
      "against a full `diff` — this measure counts a rule's own suppressions, not the realignment it prevents."
  );
}

async function diff(quiet = false): Promise<number> {
  // `audit` re-runs the whole comparison once per rule, so it needs the count without the report.
  const say = (...args: unknown[]): void => {
    if (!quiet) {
      console.log(...(args as [unknown]));
    }
  };
  if (!fs.existsSync(REF)) {
    say(`No ${path.relative(ROOT, REF)}/ yet. Run pnpm oracle:generate first.`);
    return;
  }
  fs.mkdirSync(MINE, { recursive: true });
  // **What is in `ref/` that should not be.** Two failure modes cost real time before this said anything: a
  // case saved in the wrong format leaves an `.xlsx` here and the comparison silently proceeds on whatever
  // `.xlsb` happens to exist, and a workbook still open in Excel leaves a `~$` lock file whose presence means
  // the save may not be flushed. Neither is fatal, so both are reported rather than thrown.
  const expected = new Set(CASES.map(item => `${item.name}.xlsb`));
  const strays = fs.readdirSync(REF).filter(name => !name.startsWith(".") && !expected.has(name));
  if (strays.length > 0) {
    say(`\n  ⚠ unexpected files in ${path.relative(ROOT, REF)}/:`);
    for (const name of strays) {
      const why = name.startsWith("~$")
        ? "Excel lock file — that workbook is still open, so its save may be incomplete"
        : name.endsWith(".xlsx")
          ? "saved as XLSX; this case needs Save As → Excel Binary Workbook (*.xlsb)"
          : "not one of the cases";
      say(`      ${name} — ${why}`);
    }
  }
  let compared = 0;
  let findings = 0;

  for (const item of CASES) {
    const reference = path.join(REF, `${item.name}.xlsb`);
    if (!fs.existsSync(reference)) {
      continue;
    }
    // **A reference older than the input it was made from is not a reference.** `oracle:generate` rewrites
    // `in/`, so a case whose builder has changed since the last Save-As is being compared against Excel's
    // reading of a *different* workbook — and the diff looks authoritative while saying nothing about the
    // current one. This cost two rounds of wrong conclusions about sparklines: the stale reference had none,
    // which read as Excel rejecting them, and the real cause was that the case had gained a group since.
    //
    // Reported per case and counted as a finding rather than skipped, because a silently-skipped case is how
    // the whole comparison quietly shrinks to nothing.
    const input = path.join(IN, `${item.name}.xlsx`);
    if (fs.existsSync(input) && fs.statSync(reference).mtimeMs < fs.statSync(input).mtimeMs) {
      say(`\n${"═".repeat(96)}\n${item.name} — ${item.covers}`);
      say(
        `\n  ✗ STALE: ref/${item.name}.xlsb predates in/${item.name}.xlsx.` +
          `\n    Excel saw an older version of this case, so any difference below is unattributable.` +
          `\n    Re-open in/${item.name}.xlsx in Excel and save it over ref/${item.name}.xlsb.`
      );
      findings += 1;
      continue;
    }
    compared += 1;
    const ours = path.join(MINE, `${item.name}.xlsb`);
    // `unsupported: "ignore"` rather than the default refusal. A feature this writer declines is exactly the
    // one worth seeing Excel's bytes for, and a thrown error would stop the whole comparison to say something
    // already known. What was dropped is reported instead.
    // **There is no `onUnsupported` callback.** This passed one and cast the options to `never` to get past the
    // compiler, so `dropped` was always empty and every case reported a clean write — including the ones
    // silently losing array formulas. The writer reports by *refusing*: `unsupported: "error"` throws an error
    // carrying `items`. So ask for the refusal, read it, then write again with `"ignore"`.
    const workbook = await assemble(item);
    let dropped: readonly string[] = [];
    try {
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "error" });
    } catch (cause) {
      const items = (cause as { items?: readonly string[] }).items;
      if (items === undefined) {
        throw cause;
      }
      dropped = items;
    }
    fs.writeFileSync(
      ours,
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );

    const theirs = await records(reference);
    const mine = await records(ours);
    say(`\n${"═".repeat(96)}\n${item.name} — ${item.covers}`);
    if (dropped.length > 0) {
      say(
        `\n  this writer dropped ${dropped.length}: ${dropped.slice(0, 6).join("; ")}` +
          `\n  → Excel's records for those are below, under "Excel only"`
      );
    }

    // **Pivot caches are paired by the table that points at them, not by their number.**
    //
    // Both files hold `pivotCacheDefinition1..3.bin`, and the numbers mean different things: Excel's
    // `pivotCacheDefinition3.bin` serves the sheet this library's `pivotCacheDefinition1.bin` serves. Comparing them by
    // filename therefore diffs one pivot's cache against another's, and every such difference is an artefact.
    //
    // This is not a small correction. It reported six `BrtPCRRecord` differences that read as a real defect — Excel
    // storing an inline date where this library stored an index, and the reverse three records later — and it produced
    // an explanation for them ("Excel materialises shared items for an unused date column") that was fitted to the
    // mispairing and wrong. Paired correctly, all three caches' record parts are **byte-identical**.
    const cacheMap = await pivotCachePairing(reference, ours);
    const partsToCompare = new Set([...theirs.keys(), ...mine.keys()]);
    for (const part of partsToCompare) {
      const a = theirs.get(part);
      const b = mine.get(cacheMap.get(part) ?? part);
      if (a === undefined) {
        say(`\n  ${part}\n    only this library writes this part`);
        findings += 1;
        continue;
      }
      if (b === undefined) {
        if (EXCEL_ONLY_PARTS.some(rule => rule.pattern.test(part))) {
          continue;
        }
        say(`\n  ${part}\n    Excel writes this part and this library does not`);
        findings += 1;
        continue;
      }
      const lines: string[] = [];
      for (const [left, right] of align(
        a.map(record => record.name),
        b.map(record => record.name)
      )) {
        if (left !== null && right !== null) {
          const one = a[left]!;
          const two = b[right]!;
          const rule = isBenign(one.name) ? BENIGN.get(one.name) : undefined;
          if (one.payload.length !== two.payload.length) {
            if (rule !== undefined && rule.offsets === undefined) {
              continue;
            }
            lines.push(
              `    ~ ${one.name.padEnd(30)} length Excel=${one.payload.length} ours=${two.payload.length}` +
                `\n        Excel ${hex(one.payload)}\n        ours  ${hex(two.payload)}`
            );
            continue;
          }
          const differing: number[] = [];
          for (let at = 0; at < one.payload.length; at += 1) {
            if (one.payload[at] !== two.payload[at]) {
              differing.push(at);
            }
          }
          if (differing.length === 0) {
            continue;
          }
          if (rule !== undefined) {
            const unexplained = differing.filter(at => !(rule.offsets ?? []).includes(at));
            if (rule.offsets === undefined || unexplained.length === 0) {
              continue;
            }
          }
          lines.push(
            `    ~ ${one.name.padEnd(30)} bytes ${differing.join(",")}` +
              `\n        Excel ${hex(one.payload)}\n        ours  ${hex(two.payload)}`
          );
        } else if (right !== null) {
          const record = b[right]!;
          if (isBenign(record.name)) {
            continue;
          }
          lines.push(`    + ${record.name.padEnd(30)} ours only (${record.payload.length}B)`);
        } else {
          const record = a[left!]!;
          if (isBenign(record.name)) {
            continue;
          }
          if (item.excelAlsoWrites?.records.includes(record.name) === true) {
            continue;
          }
          lines.push(
            `    - ${record.name.padEnd(30)} Excel only (${record.payload.length}B) ${hex(record.payload)}`
          );
        }
      }
      if (lines.length > 0) {
        say(`\n  ${part}`);
        say(lines.join("\n"));
        findings += lines.length;
      }
    }
  }

  if (compared === 0) {
    say(`Nothing to compare: ${path.relative(ROOT, REF)}/ holds no .xlsb matching a known case.`);
    return findings;
  }
  say(
    `\n${"═".repeat(96)}\n${compared} of ${CASES.length} cases compared, ` +
      `${findings} difference${findings === 1 ? "" : "s"} after filtering.\n` +
      `A difference is a lead, not a verdict — and a *missing* difference can mean the filter is too eager.`
  );
  return findings;
}

const mode = process.argv[2];
if (mode === "generate") {
  await generate();
} else if (mode === "diff") {
  await diff();
} else if (mode === "audit") {
  await audit();
} else {
  console.log("usage: node scripts/xlsb-oracle.ts generate | diff | audit");
  process.exit(1);
}
