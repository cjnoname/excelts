/**
 * Comparing one workbook through two containers.
 *
 * **Why this is shared rather than written twice.** The same comparison runs in two places for two
 * different reasons: a test over the committed fixtures, which is always available and therefore runs
 * in a watch loop, and a script over the sixty-two workbooks the examples produce, which is far broader
 * and only exists after a full example run. Two copies of the logic would be two chances to disagree
 * about what counts as a difference — and the copy with fewer readers would be the one that drifted.
 *
 * The comparison is the point of both. A single-format round trip only shows that a writer and a
 * reader agree with each other; putting one model through two containers asks whether they agree with
 * *each other*, and a disagreement is then a fact about one of them rather than a matter of opinion.
 *
 * ## Two mistakes this encodes, both of which cost a false reading first
 *
 * **Differences are keyed by cell, never by line.** A line-by-line diff of two workbook descriptions
 * is worse than useless: one cell missing on one side shifts every line after it, so a single real
 * difference reports as hundreds and the signal is buried in its own consequences. The first version
 * of this reported eleven failures where there were four.
 *
 * **A merge's covered cells are one consequence, not many.** The XLSX model duplicates a merged value
 * across the cells it covers, so content dropped from the master shows up at every one of them. A
 * heading in a four-column banner reports as four differences unless the merge is understood.
 */
import { Workbook, Worksheet } from "@excel/index";
import { encodeCol } from "@excel/utils/address";

/** One line of a workbook description, keyed by its qualified cell address. */
function byAddress(description: string): Map<string, string> {
  const cells = new Map<string, string>();
  for (const line of description.split("\n")) {
    const address = /^([^ ]+!\S+) /.exec(line)?.[1];
    if (address !== undefined) {
      cells.set(address, line);
    }
  }
  return cells;
}

/** Addresses whose description differs between the two readings, in either direction. */
export function differingAddresses(left: string, right: string): string[] {
  const a = byAddress(left);
  const b = byAddress(right);
  const differing: string[] = [];
  for (const [address, line] of a) {
    if (b.get(address) !== line) {
      differing.push(address);
    }
  }
  for (const address of b.keys()) {
    if (!a.has(address)) {
      differing.push(address);
    }
  }
  return differing;
}

/** The `Sheet1!A1` out of a report entry like `Sheet1!A1: hyperlink`. */
export function reportedAddress(entry: string): string | undefined {
  return /^(.+![A-Z]+\d+):/.exec(entry)?.[1];
}

/**
 * Every address a writer's report accounts for, including the cells a reported merge covers.
 *
 * A cell the writer named is accounted for however it reads back — most often as absent, because a
 * blank has nothing to describe.
 */
export function accountedFor(
  workbook: ReturnType<typeof Workbook.create>,
  reported: readonly string[]
): Set<string> {
  const accounted = new Set(
    reported.map(reportedAddress).filter((entry): entry is string => entry !== undefined)
  );
  for (const worksheet of Workbook.getWorksheets(workbook)) {
    const sheet = Worksheet.getName(worksheet);
    for (const region of Worksheet.mergedRegions(worksheet)) {
      // `mergedRegions` is one-based; `encodeCol` is zero-based.
      const master = `${sheet}!${encodeCol(region.left - 1)}${region.top}`;
      if (!accounted.has(master)) {
        continue;
      }
      for (let row = region.top; row <= region.bottom; row++) {
        for (let column = region.left; column <= region.right; column++) {
          accounted.add(`${sheet}!${encodeCol(column - 1)}${row}`);
        }
      }
    }
  }
  return accounted;
}

/**
 * Differences that are understood without the writer having reported the cell.
 *
 * Returned as a *named cause* rather than filtered away, because a known difference nobody can see is
 * indistinguishable from an unknown one — which is the failure this whole comparison exists to catch.
 */
export function knownCause(address: string, left: string, right: string): string | undefined {
  const before = lineFor(address, left);
  const after = lineFor(address, right);
  if (before === undefined || after === undefined) {
    return undefined;
  }
  // A formula the source carried no cached value for. `BrtFmlaNum` needs a double, so a zero goes there
  // and a spreadsheet recalculates on load — but a *reader* sees the zero, which is a value the source
  // did not have.
  if (/= other undefined$/.test(before) && /= number 0$/.test(after)) {
    return "a formula with no cached result reads back as zero";
  }
  return undefined;
}

function lineFor(address: string, description: string): string | undefined {
  return description.split("\n").find(line => line.startsWith(`${address} `));
}
