/**
 * Index check: does every index point inside the collection it indexes?
 *
 * BIFF12 is built on indexes — a cell names its text by position in the shared-string
 * table and its formatting by position in the cell-format table. An index one past the
 * end is the classic off-by-one in a writer, and it is invisible in the file: the
 * record is well-framed, the scopes balance, and the number looks like every other
 * number. Excel rejects it.
 *
 * The counts come from the `Begin` record of each counted collection, which is why the
 * spec table declares those payloads: without `BrtBeginSst`'s unique-string count there
 * is nothing to compare an `isst` against.
 *
 * Which records carry a style reference, and where, is read from the layout rather than
 * from a list here — a cell holds it inside its `Cell`, a row header as `ixfe`, and a
 * checker should not have to know which record spells it which way.
 */

import type { FramedPart } from "@excel/utils/xlsb-validator/check-framing";
import type { XlsbReporter } from "@excel/utils/xlsb-validator/reporter";
import { decodeRecord, numberField, styleReference } from "@excel/xlsb/spec/decode";
import { recordSpec } from "@excel/xlsb/spec/records";

export interface CollectionCounts {
  /** Unique strings declared by `BrtBeginSst`, when the part was present. */
  readonly sharedStrings?: number;
  /** Cell formats declared by `BrtBeginCellXfs`. */
  readonly cellFormats?: number;
}

/** Read the declared counts out of the parts that own them. */
export function readCollectionCounts(
  parts: readonly FramedPart[],
  reporter: XlsbReporter
): CollectionCounts {
  let sharedStrings: number | undefined;
  let cellFormats: number | undefined;

  for (const framed of parts) {
    for (const record of framed.records) {
      const name = recordSpec(record.id)?.name;
      const at = { part: framed.part, offset: record.offset };

      if (name === "BrtBeginSst") {
        const decoded = decodeRecord(record, framed.part);
        const total = numberField(decoded, "cstTotal");
        const unique = numberField(decoded, "cstUnique");
        if (total === undefined || unique === undefined) {
          continue; // A short payload is the framing checker's business.
        }
        sharedStrings = unique;
        // The two counts are not required to be equal — total counts occurrences — but
        // unique can never exceed total, and a writer that swapped them makes every
        // later bounds check wrong in the permissive direction.
        if (unique > total) {
          reporter.error(
            "index-count-mismatch",
            `BrtBeginSst declares ${unique} unique string(s) out of ${total} total`,
            at
          );
        }
        const items = countRecords(framed, "BrtSSTItem");
        if (items !== unique) {
          reporter.error(
            "index-count-mismatch",
            `BrtBeginSst declares ${unique} unique string(s) but the part carries ${items}`,
            at
          );
        }
        continue;
      }

      if (name === "BrtBeginCellXfs") {
        const declared = numberField(decodeRecord(record, framed.part), "count");
        if (declared === undefined) {
          continue;
        }
        cellFormats = declared;
        // Styles carry two XF tables — cell formats and named-style formats — and both
        // use BrtXF, so the count can legitimately be lower than the total number of
        // BrtXF records. Only an *over*-declaration is a problem.
        const items = countRecords(framed, "BrtXF");
        if (declared > items) {
          reporter.error(
            "index-count-mismatch",
            `BrtBeginCellXfs declares ${declared} format(s) but the part carries ${items} ` +
              `BrtXF record(s) in total`,
            at
          );
        }
      }
    }
  }

  return { sharedStrings, cellFormats };
}

function countRecords(framed: FramedPart, name: string): number {
  let count = 0;
  for (const record of framed.records) {
    if (recordSpec(record.id)?.name === name) {
      count++;
    }
  }
  return count;
}

/** Check a worksheet's shared-string and style references against the counts. */
export function checkIndexes(
  framed: FramedPart,
  counts: CollectionCounts,
  reporter: XlsbReporter
): void {
  for (const record of framed.records) {
    if (reporter.capped) {
      return;
    }
    const decoded = decodeRecord(record, framed.part);
    if (!decoded) {
      continue;
    }
    const at = { part: framed.part, offset: record.offset };

    const style = styleReference(decoded);
    if (style !== undefined) {
      checkStyle(style, counts, reporter, decoded.spec.name, at);
    }

    const isst = numberField(decoded, "isst");
    if (isst !== undefined && counts.sharedStrings !== undefined && isst >= counts.sharedStrings) {
      reporter.error(
        "index-shared-string-out-of-range",
        `${decoded.spec.name} references shared string ${isst}, but only ` +
          `${counts.sharedStrings} exist`,
        at
      );
    }
  }
}

function checkStyle(
  styleIndex: number,
  counts: CollectionCounts,
  reporter: XlsbReporter,
  recordName: string,
  at: { part: string; offset: number }
): void {
  // Index 0 is always valid: it is the default format, present even when the styles
  // part declares nothing.
  if (styleIndex === 0 || counts.cellFormats === undefined) {
    return;
  }
  if (styleIndex >= counts.cellFormats) {
    reporter.error(
      "index-style-out-of-range",
      `${recordName} references cell format ${styleIndex}, but only ${counts.cellFormats} exist`,
      at
    );
  }
}
