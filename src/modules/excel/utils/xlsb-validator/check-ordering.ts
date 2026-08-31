/**
 * Ordering check: does each part have the root scope its name implies, and do the
 * records that must precede a scope actually do so?
 *
 * Narrow on purpose. The full record grammar of a `.bin` part is large, and encoding
 * all of it here would be a second implementation of the format with no reader to
 * keep it honest. What is checked is the small set of orderings whose violation
 * Excel rejects outright, and which a writer can plausibly get wrong:
 *
 *  * a part must be wrapped in the scope its role requires — a worksheet in
 *    `BrtBeginSheet`, the shared strings in `BrtBeginSst`;
 *  * `BrtWsDim` declares the sheet's used range and must come before the cell data
 *    it describes;
 *  * a cell record has to be inside `BrtBeginSheetData`, and a row's cells after a
 *    `BrtRowHdr` — a cell emitted outside either has no row to belong to.
 */

import type { FramedPart } from "@excel/utils/xlsb-validator/check-framing";
import type { XlsbReporter } from "@excel/utils/xlsb-validator/reporter";
import {
  CELL_RECORD_NAMES,
  ROW_RECORD_NAMES,
  XLSB_PART_ROLES,
  type XlsbPartRole
} from "@excel/utils/xlsb-validator/roles";
import { recordSpec } from "@excel/xlsb/spec/records";

export function checkOrdering(
  framed: FramedPart,
  role: XlsbPartRole,
  reporter: XlsbReporter
): void {
  const expectations = XLSB_PART_ROLES[role];
  const names = framed.records.map(record => recordSpec(record.id)?.name);

  if (expectations.rootScope) {
    const first = names.find(name => name !== undefined);
    if (first !== expectations.rootScope) {
      reporter.error(
        "scope-missing-root",
        `a ${role} part must open with ${expectations.rootScope}, not ${first ?? "an unknown record"}`,
        { part: framed.part, offset: framed.records[0]?.offset ?? 0 }
      );
    }
  }

  // Absence, which every other check here is blind to. A part can be perfectly framed, correctly
  // scoped and consistently ordered while missing a record Excel writes into every file — and the
  // result is coherent and unopenable, which is the worst combination for a validator to pass.
  //
  // A **warning**, not an error, and the distinction is load-bearing in both directions. A file
  // without these is still readable, and this validator is pointed at input as well as output: two
  // workbooks in the reference corpus are hand-reduced bug reports rather than Excel's own output,
  // and refusing them would be refusing files this library reads correctly. What the warning says is
  // narrower and true — Excel writes these into every file it produces, so a package lacking them
  // has no evidence of being openable.
  for (const required of expectations.requiredRecords ?? []) {
    if (!names.includes(required)) {
      reporter.warning(
        "record-missing-required",
        `a ${role} part has no ${required}; every Excel-authored workbook has one, so a package without it has no evidence of being openable`,
        { part: framed.part, offset: 0 }
      );
    }
  }

  for (const [before, after] of expectations.precedes ?? []) {
    const beforeIndex = names.indexOf(before);
    const afterIndex = names.indexOf(after);
    if (beforeIndex !== -1 && afterIndex !== -1 && beforeIndex > afterIndex) {
      reporter.error("ordering-out-of-place", `${before} must appear before ${after}`, {
        part: framed.part,
        offset: framed.records[beforeIndex]!.offset
      });
    }
  }

  if (!expectations.cellsInSheetData) {
    return;
  }

  let inSheetData = false;
  let sawRowHeader = false;
  for (const record of framed.records) {
    if (reporter.capped) {
      return;
    }
    const name = recordSpec(record.id)?.name;
    if (name === "BrtBeginSheetData") {
      inSheetData = true;
      sawRowHeader = false;
      continue;
    }
    if (name === "BrtEndSheetData") {
      inSheetData = false;
      continue;
    }
    if (name !== undefined && ROW_RECORD_NAMES.has(name)) {
      if (!inSheetData) {
        reporter.error("ordering-outside-scope", `${name} appears outside BrtBeginSheetData`, {
          part: framed.part,
          offset: record.offset
        });
      }
      sawRowHeader = true;
      continue;
    }
    if (name && CELL_RECORD_NAMES.has(name)) {
      if (!inSheetData) {
        reporter.error("ordering-outside-scope", `${name} appears outside BrtBeginSheetData`, {
          part: framed.part,
          offset: record.offset
        });
      } else if (!sawRowHeader) {
        reporter.error(
          "ordering-outside-scope",
          `${name} appears before any BrtRowHdr, so it belongs to no row`,
          { part: framed.part, offset: record.offset }
        );
      }
    }
  }
}
