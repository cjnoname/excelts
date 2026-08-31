/**
 * What survives a binary round trip, and what this library tells you it cannot express.
 *
 * Run: `pnpm example --filter xlsb-fidelity`
 *
 * Two behaviours are worth knowing before trusting a read-modify-write:
 *
 * 1. **Parts this library does not model are preserved verbatim.** The theme, images, drawings, a
 *    VBA project. Losing the theme is not cosmetic — a `{ theme: 1 }` colour resolves through it —
 *    and losing `vbaProject.bin` loses the macros.
 * 2. **Content it cannot express is reported, not approximated.** By default `toBuffer` throws and
 *    names the cells; `{ unsupported: "ignore" }` writes them as blanks instead. Neither option
 *    silently writes something that looks right and is not.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook, Worksheet } from "@excel/index";

// This example reads a fixture and writes only to memory, so it needs no output path — but it
// still accepts one, because the runner passes it and an example that ignored it silently would be
// the odd one out.
const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-fidelity.xlsb");

// ---------------------------------------------------------------------------
// Content this writer cannot express is named, cell by cell.
// ---------------------------------------------------------------------------

const withUnsupported = Workbook.create();
const sheet = Workbook.addWorksheet(withUnsupported, "Mixed");
Cell.setValue(sheet, "A1", "fine");
Cell.setValue(sheet, "A2", 42);
// A hyperlink. `BrtHLink` does not appear in any Excel-authored reference workbook, so its layout
// is not established and this writer does not guess one.
Cell.setValue(sheet, "A3", { text: "documonster", hyperlink: "https://example.invalid" });

try {
  await Workbook.toBuffer(withUnsupported, { format: "xlsb" });
  console.log("unexpected: no report");
} catch (error) {
  // The message names the sheet, the cell and the reason — not a count.
  console.log("reported:", (error as Error).message.split(". Pass")[0]);
}

// The same workbook, written anyway. The unsupported cell keeps its position and its formatting;
// only the content it could not carry is gone.
const lenient = await Workbook.toBuffer(withUnsupported, {
  format: "xlsb",
  unsupported: "ignore"
});
const reopened = Workbook.create();
await Workbook.read(reopened, lenient);
const readSheet = Workbook.getWorksheets(reopened)[0]!;
console.log("A2 survived:", Cell.getValue(readSheet, "A2"));
console.log("A3 is blank:", JSON.stringify(Cell.getValue(readSheet, "A3")));

// ---------------------------------------------------------------------------
// Parts this library does not model survive verbatim.
// ---------------------------------------------------------------------------

// Read from a fixture rather than from a file this library wrote, and the distinction matters: a
// workbook written here contains only parts it models, so a round trip of its own output would
// report "nothing lost" whether or not preservation worked at all. `themed.xlsb` carries a theme
// and an image, each reachable through a relationship — the shape Excel produces.
const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data/themed.xlsb");

const themed = Workbook.create();
await Workbook.readFile(themed, fixture);
console.log("read the fixture:", Worksheet.getName(Workbook.getWorksheets(themed)[0]!));

const rewritten = await Workbook.toBuffer(themed, { format: "xlsb" });
const before = await extractAll(fs.readFileSync(fixture));
const after = await extractAll(rewritten);

// Only the parts this library does not model. The workbook and the sheet are re-serialised from the
// model, so comparing those would be comparing this writer against itself.
const unmodelled = [...before.keys()].filter(part => /theme|media/.test(part)).sort();
for (const part of unmodelled) {
  const original = before.get(part)!.data;
  const survived = after.get(part)?.data;
  const identical =
    survived !== undefined &&
    survived.length === original.length &&
    original.every((byte, index) => byte === survived[index]);
  console.log(`  ${part}: ${identical ? "byte-identical" : survived ? "CHANGED" : "LOST"}`);
}

// And the relationships that make them reachable, without which they sit in the package
// unreferenced — one of the things Excel offers to repair.
const rels = new TextDecoder().decode(after.get("xl/_rels/workbook.bin.rels")!.data);
console.log("  theme still referenced:", rels.includes("theme/theme1.xml"));
console.log("  image still referenced:", rels.includes("media/logo.png"));

fs.writeFileSync(filename, rewritten);
console.log(`wrote ${filename}`);

// ---------------------------------------------------------------------------
// The 1904 date system, which is where a wrong answer looks most plausible.
// ---------------------------------------------------------------------------

// A workbook saved with the Mac epoch stores every date 1462 days lower. Read against the 1900
// epoch it comes out four years early — a date, not an error, so nothing downstream notices.
for (const date1904 of [false, true]) {
  const epoch = Workbook.create();
  epoch.properties = { ...epoch.properties, date1904 };
  const dates = Workbook.addWorksheet(epoch, "Dates");
  Cell.setValue(dates, "A1", new Date(Date.UTC(2024, 5, 1)));
  Cell.setStyle(dates, "A1", { numFmt: "yyyy-mm-dd" });

  const back = Workbook.create();
  await Workbook.read(back, await Workbook.toBuffer(epoch, { format: "xlsb" }));
  const value = Cell.getValue(Workbook.getWorksheets(back)[0]!, "A1");
  console.log(
    `date1904=${String(date1904).padEnd(5)} →`,
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
  );
}
