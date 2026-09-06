/**
 * Probe files, one feature each, for finding out what Excel actually refuses.
 *
 * **Why this exists.** `xlsb-everything.xlsb` does not open in Excel, and every check in this repository
 * says it is fine: the records balance, the lengths match Excel's own, the relationships resolve, and the
 * workbook survives three read-write generations. That combination is the whole lesson — internal
 * consistency and Excel's acceptance are different properties, and nothing here has ever tested the second.
 *
 * So this bisects by hand instead. Each file below carries exactly one feature on top of a baseline that is
 * as close to nothing as a workbook can be. Opening them in order says which feature is at fault, and
 * `00-baseline` says whether the problem is in the shared machinery rather than any feature at all.
 *
 * Run: pnpm example --filter xlsb-probe
 * Then open every file in tmp/excel-examples/xlsb-probe/ and report which ones fail.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Image, Pivot, Watermark, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples/xlsb-probe"
);
// Only the files this script owns are removed. It used to wipe the directory, which deleted the hand-patched
// byte-level variants sitting beside them — the ones a person had been asked to open. Those now live in
// `tmp/xlsb-variants/`, and this no longer reaches outside its own output.
fs.mkdirSync(outDir, { recursive: true });
for (const entry of fs.readdirSync(outDir)) {
  if (entry.endsWith(".xlsb")) {
    fs.rmSync(path.join(outDir, entry));
  }
}

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

/** A workbook with one sheet and three cells, and nothing else. */
function baseline(): { workbook: Workbook.Handle; sheet: Worksheet.Handle } {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "S");
  Worksheet.addAoa(sheet, [
    ["Region", "Units"],
    ["APAC", 10],
    ["EMEA", 20]
  ]);
  return { workbook, sheet };
}

const probes: {
  name: string;
  build: (parts: ReturnType<typeof baseline>) => void | Promise<void>;
}[] = [
  { name: "00-baseline", build: () => {} },

  {
    name: "01-frozen-pane",
    build: ({ sheet }) => {
      // The one defect Excel already named: it repaired the *view* of `xlsb-losses.xlsb`. The active pane
      // was `bottomRight` on a sheet with only rows frozen, where no right-hand pane exists, and the
      // selection named a third pane again. Both now follow the split. This file checks that.
      const model = Worksheet.getModel(sheet);
      model.views = [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }] as never;
      Worksheet.setModel(sheet, model);
    }
  },

  {
    name: "02-row-and-column-flags",
    build: ({ sheet }) => {
      const model = Worksheet.getModel(sheet);
      model.rows = (model.rows ?? []).map(row =>
        row.number === 2 ? { ...row, hidden: true, outlineLevel: 1, collapsed: true } : row
      );
      (model as { cols?: unknown }).cols = [
        { min: 1, max: 1, width: 18, isCustomWidth: true },
        { min: 2, max: 2, hidden: true, outlineLevel: 1 }
      ];
      Worksheet.setModel(sheet, model);
    }
  },

  {
    name: "03-conditional-format",
    build: ({ sheet }) => {
      Worksheet.addConditionalFormatting(sheet, {
        ref: "B2:B3",
        rules: [
          {
            type: "cellIs",
            operator: "greaterThan",
            formulae: ["15"],
            priority: 1,
            style: {
              font: { bold: true },
              fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFC6EFCE" } }
            }
          }
        ]
      } as never);
    }
  },

  {
    name: "04-autofilter-range-only",
    build: ({ sheet }) => {
      const model = Worksheet.getModel(sheet);
      (model as { autoFilter?: string }).autoFilter = "A1:B3";
      Worksheet.setModel(sheet, model);
    }
  },

  {
    name: "05-autofilter-criteria",
    build: ({ sheet }) => {
      const model = Worksheet.getModel(sheet);
      (model as { autoFilter?: string }).autoFilter = "A1:B3";
      (model as { autoFilterCriteria?: { ref: string; xml: string } }).autoFilterCriteria = {
        ref: "A1:B3",
        xml: '<filterColumn colId="0"><filters><filter val="APAC"/></filters></filterColumn>'
      };
      Worksheet.setModel(sheet, model);
    }
  },

  {
    name: "06-sheet-password",
    build: async ({ sheet }) => {
      await Worksheet.protect(sheet, "s3cret", { formatCells: true });
    }
  },

  {
    name: "07-workbook-password",
    build: async ({ workbook }) => {
      await Workbook.protect(workbook, "b00kpass", { lockStructure: true });
    }
  },

  {
    name: "08-watermark-overlay",
    build: ({ workbook, sheet }) => {
      Watermark.add(sheet, {
        imageId: Image.add(workbook, { buffer: PNG, extension: "png" }),
        mode: "overlay",
        opacity: 0.25
      });
    }
  },

  {
    name: "09-pivot-table",
    build: ({ workbook, sheet }) => {
      // The largest new surface by far — four parts and roughly twenty record layouts, none of which any
      // corpus workbook exercises. If one file here fails, this is the one to expect.
      Pivot.add(Workbook.addWorksheet(workbook, "P"), {
        sourceSheet: sheet,
        rows: ["Region"],
        columns: [],
        values: ["Units"],
        metric: "sum"
      });
    }
  }
];

const written: string[] = [];
for (const probe of probes) {
  const parts = baseline();
  await probe.build(parts);
  const file = path.join(outDir, `${probe.name}.xlsb`);
  fs.writeFileSync(file, await Workbook.toBuffer(parts.workbook, { format: "xlsb" }));
  written.push(`${probe.name}.xlsb  ${(fs.statSync(file).size / 1024).toFixed(1)} KiB`);
}

console.log(`Wrote ${written.length} probe files to ${outDir}\n`);
for (const line of written) {
  console.log(`  ${line}`);
}
console.log(
  "\nOpen each in Excel. `00-baseline` failing would mean the problem is in the shared machinery;\n" +
    "anything else failing names the feature. Every check in this repository passes on all of them,\n" +
    "which is exactly why they have to be opened rather than validated."
);
