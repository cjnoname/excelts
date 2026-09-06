/**
 * Print areas and print titles as `_xlnm.*` defined names.
 *
 * **Neither is a container feature.** Excel stores a print area as a sheet-local defined name called
 * `_xlnm.Print_Area` and print titles as `_xlnm.Print_Titles`, in both XLSX and XLSB — so both readers
 * and both writers need the same translation between `pageSetup` and a defined name, and this module is
 * the one place it lives.
 *
 * It was extracted from the XLSX workbook xform, where the two directions sat inline among four hundred
 * lines of reconciliation. Nothing was rewritten: the details that make this easy to get wrong are the
 * ones already worked out there, and they are worth naming because a second implementation would get
 * each of them wrong independently.
 *
 * - **A comma inside a quoted sheet name does not delimit a range.** `'Q1, Forecast'!$A$1` is one range,
 *   so splitting on every comma produces two broken ones.
 * - **The public `printArea` field uses `&&` as its separator**, not a comma, for backwards
 *   compatibility — while the file format uses a comma. Both are accepted on the way in.
 * - **Print titles are told apart by shape, not by position.** `$1:$1` is a row title and `$A:$A` a
 *   column title, and a workbook may carry either, both, or them in either order; matching by index
 *   would mis-assign a sheet that only sets column titles.
 */

/** The `pageSetup` fields this module reads and writes. */
export interface PrintSetup {
  printArea?: string;
  printTitlesRow?: string;
  printTitlesColumn?: string;
}

/** A defined name in the shape both writers emit. */
export interface PrintDefinedName {
  readonly name: string;
  readonly ranges: readonly string[];
  readonly localSheetId: number;
}

/**
 * Split a print-area string on the commas that actually delimit ranges.
 *
 * A quoted sheet name may contain one, so the quote state has to be tracked rather than the string
 * split naively. `&&` is accepted alongside the comma because that is what the public field uses.
 */
export function splitPrintAreaInput(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === "'") {
      // A doubled quote inside a quoted name is an escaped quote, not the end of one.
      if (quoted && input[index + 1] === "'") {
        current += "''";
        index++;
        continue;
      }
      quoted = !quoted;
      current += character;
      continue;
    }
    if (!quoted && character === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    if (!quoted && character === "&" && input[index + 1] === "&") {
      parts.push(current);
      current = "";
      index++;
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(part => part !== "");
}

/**
 * Apply an `_xlnm.*` defined name to a sheet's `pageSetup`.
 *
 * Returns whether the name was one of the two — a caller keeps it as an ordinary defined name when not,
 * which is what stops `_xlnm.Print_Area` from appearing twice in a round trip.
 */
export function applyPrintName(
  setup: PrintSetup,
  name: string,
  ranges: readonly string[]
): boolean {
  if (ranges.length === 0) {
    return name === "_xlnm.Print_Area" || name === "_xlnm.Print_Titles";
  }
  if (name === "_xlnm.Print_Area") {
    // `&&` is the separator the public field has always used. The file's own separator is a comma, so
    // this is a translation rather than a passthrough.
    setup.printArea = ranges.join("&&");
    return true;
  }
  if (name !== "_xlnm.Print_Titles") {
    return false;
  }
  const joined = ranges.join(",");
  // The `$` markers are **optional** here. The XLSX reader could require them because it reads the
  // attribute text Excel wrote, which always carries them; a BIFF12 name arrives as a decoded token
  // stream, and this library's formula printer emits `Foo!1:1` rather than `Foo!$1:$1`. Requiring the
  // marker made every print title read out of an XLSB file match nothing and vanish silently — the
  // reference was correct, the pattern was too strict.
  const rows = /\$?(\d+):\$?(\d+)/.exec(joined);
  if (rows !== null) {
    setup.printTitlesRow = `${rows[1]}:${rows[2]}`;
  }
  // Anchored on a `:` between two column runs so that a sheet name's letters cannot be mistaken for one:
  // `Foo!A:A` must yield `A:A`, not `oo:A`.
  const columns = /(?:^|[!,])\$?([A-Z]+):\$?([A-Z]+)(?=$|,)/.exec(joined);
  if (columns !== null) {
    setup.printTitlesColumn = `${columns[1]}:${columns[2]}`;
  }
  return true;
}

/** Whether a defined name is one of the two this module owns. */
export function isPrintName(name: string): boolean {
  return name === "_xlnm.Print_Area" || name === "_xlnm.Print_Titles";
}
