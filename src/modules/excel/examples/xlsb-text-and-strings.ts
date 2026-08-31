/**
 * Text through XLSB: the shared-string table, Unicode, and the value shapes it cannot carry.
 *
 * Run: `pnpm example --filter xlsb-text-and-strings`
 *
 * Strings are interned. A workbook that repeats a label ten thousand times stores it once and
 * references it by index, which is what makes a large sheet of categorical data small — and it is
 * why `BrtCellIsst` carries four bytes where `BrtCellSt` carries the whole string.
 *
 * The interesting boundary is *rich text*: a run-formatted string has no `BrtCell*` this library can
 * write, so it is reported by address rather than flattened to its plain text. Flattening would look
 * like success and lose the formatting silently.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Column, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-text-and-strings.xlsb");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Text");
Column.setWidth(ws, 1, 26);
Column.setWidth(ws, 2, 44);

Worksheet.addRow(ws, ["What it is", "The text"]);
Cell.setStyle(ws, "A1", { font: { bold: true } });
Cell.setStyle(ws, "B1", { font: { bold: true } });

const samples: readonly [string, string][] = [
  ["plain ASCII", "Hello, World!"],
  ["accented Latin", "café crème brûlée — naïve"],
  ["Simplified Chinese", "文档怪物,二进制工作簿"],
  ["Japanese", "ドキュメントモンスター"],
  ["Korean", "문서 몬스터"],
  ["Cyrillic", "Документ Монстр"],
  ["Greek", "Έγγραφο Τέρας"],
  ["Arabic, right to left", "وحش الوثائق"],
  ["Hebrew, right to left", "מונסטר מסמכים"],
  ["emoji, a surrogate pair", "📊 spreadsheet 🧟 monster"],
  ["a combining accent", "e\u0301 is not the same as \u00e9"],
  ["XML metacharacters", '<tag> & "quoted" & \u0027apostrophe\u0027'],
  ["a tab and a newline", "before\tafter\nsecond line"],
  ["leading and trailing space", "   padded   "],
  ["a long string", "long ".repeat(60).trim()]
];

samples.forEach(([label, text], index) => {
  const row = index + 2;
  Cell.setValue(ws, `A${row}`, label);
  Cell.setValue(ws, `B${row}`, text);
});
Cell.setStyle(ws, "B15", { alignment: { wrapText: true } });
Cell.setStyle(ws, "B16", { alignment: { wrapText: true } });

// Repetition, to show the table doing its job: fifty cells, one stored string.
const repeated = Workbook.addWorksheet(wb, "Repeated");
Cell.setValue(repeated, "A1", "the same label fifty times");
for (let row = 2; row <= 51; row++) {
  Cell.setValue(repeated, `A${row}`, "North");
  Cell.setValue(repeated, `B${row}`, row - 1);
}

await Workbook.writeFile(wb, filename);
console.log(`wrote ${filename}`);

// How many distinct strings the table actually holds.
const entries = await extractAll(fs.readFileSync(filename));
const sst = entries.get("xl/sharedStrings.bin");
console.log(`sharedStrings.bin is ${sst?.data.length ?? 0} bytes for 50 repeats plus 15 samples`);

const reopened = Workbook.create();
await Workbook.readFile(reopened, filename);
const read = Workbook.getWorksheets(reopened)[0]!;
let exact = 0;
samples.forEach(([label, text], index) => {
  const got = Cell.getValue(read, `B${index + 2}`);
  if (got === text) {
    exact++;
  } else {
    console.log(`  ${label}: ${JSON.stringify(got)}`);
  }
});
console.log(`${exact}/${samples.length} strings survived byte for byte`);

// Rich text, which is reported rather than flattened.
const rich = Workbook.create();
const richSheet = Workbook.addWorksheet(rich, "Rich");
Cell.setValue(richSheet, "A1", {
  richText: [
    { text: "bold", font: { bold: true } },
    { text: " and " },
    { text: "italic", font: { italic: true } }
  ]
} as never);
try {
  await Workbook.toBuffer(rich, { format: "xlsb" });
  console.log("unexpected: nothing reported");
} catch (error) {
  console.log(`reported: ${(error as Error).message.split(". Pass")[0]}`);
}
