/**
 * Protection through XLSB: the workbook's, the sheet's, and where the records have to sit.
 *
 * `BrtBookProtectionIso` and `BrtBookProtection` must come **immediately after `BrtWbProp`**, before the book
 * views. Written after `BrtCalcProp` — a position that looks just as reasonable — the workbook does not open at
 * all. Sheet protection has the same kind of constraint one level down: it precedes the merge collection.
 *
 * The hash values differ on every write, and that is correct: ISO protection draws a fresh random salt each
 * time, so two saves of the same workbook are never byte-identical here.
 *
 * Run: pnpm example --filter xlsb-protection
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { sampleSheet } from "@excel/examples/utils/features";
import { Workbook, Worksheet } from "@excel/index";

const workbook = Workbook.create();
const sheet = sampleSheet(workbook);

await Workbook.protect(workbook, "book-secret", { lockStructure: true } as never);
await Worksheet.protect(sheet, "sheet-secret", {
  selectLockedCells: true,
  formatCells: false,
  insertRows: false
} as never);

const { results, dropped } = await writeBoth(workbook, "xlsb-protection");

report("sheet protection", results, reloaded => {
  const target = Workbook.getWorksheet(reloaded, "Data");
  const model = Worksheet.getModel(target!) as unknown as {
    sheetProtection?: {
      readonly sheet?: boolean;
      readonly algorithmName?: string;
      readonly formatCells?: boolean;
    };
  };
  const protection = model.sheetProtection;
  return protection === undefined
    ? "none survived"
    : `on=${protection.sheet !== false} algorithm=${protection.algorithmName ?? "—"} formatCells=${protection.formatCells === true}`;
});

report("workbook protection", results, reloaded => {
  // The key is `protection`, not `workbookProtection` — the latter reads plausibly and is not there, so an
  // example probing it reports "none survived" for protection that is perfectly intact.
  const model = Workbook.getModel(reloaded) as unknown as {
    protection?: { readonly lockStructure?: boolean; readonly algorithmName?: string };
  };
  const protection = model.protection;
  return protection === undefined
    ? "none survived"
    : `lockStructure=${protection.lockStructure ?? "—"} algorithm=${protection.algorithmName ?? "—"}`;
});

// **Awaited, so outside `report`.** `Worksheet.verifyPassword` is asynchronous — the hash is computed through
// WebCrypto — and a synchronous probe prints `[object Promise]` for both answers, which looks like a result.
console.log("\nverifies the right password and rejects a wrong one");
for (const written of results) {
  const target = Workbook.getWorksheet(written.reloaded, "Data");
  const right = await Worksheet.verifyPassword(target!, "sheet-secret");
  const wrong = await Worksheet.verifyPassword(target!, "not-it");
  // The password itself is never recoverable, only verifiable. Rejecting a wrong one is what proves the hash
  // and its salt both survived rather than being defaulted to something that accepts anything.
  console.log(`  ${written.format.padEnd(5)} right=${right} wrong=${wrong}`);
}

reportDropped(dropped);
reportFiles(results);
