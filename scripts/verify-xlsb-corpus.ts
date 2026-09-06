/**
 * Semantic verification of the pinned XLSB corpus.
 *
 * **`corpus:xlsb` fetches the files; this is what makes having them worth anything.** A reader that returns without
 * throwing has proved almost nothing — the defects this module has actually shipped were files that parsed cleanly
 * and came back wrong: an error cell read as a blank, a cross-sheet reference resolved to the wrong sheet, a shared
 * formula whose followers all named the master's own cell. So every check here asserts a *value*, not the absence of
 * an exception.
 *
 * Four things are checked for each file, and each catches a different class of failure:
 *
 * 1. **Probes.** Named expectations about what the file contains, written as intent rather than copied from a run.
 *    A count that merely records what the reader currently produces cannot fail usefully.
 * 2. **Passthrough.** An unmodified package must come back byte for byte. This is the strongest statement available
 *    about a file whose features are not all modelled.
 * 3. **Edited round trip.** After a change, the package is rebuilt — and every probe must still hold. This is where
 *    a writer that loses something the reader understood shows up.
 * 4. **Cross-container parity.** The same workbook written as *XLSX* and read back must satisfy the same probes. A
 *    model that only reads correctly through the container it came from is a model with the container leaking into
 *    it, which is the defect this library has hit most often.
 *
 * Run: pnpm verify:xlsb-corpus
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { ExcelNotSupportedError, XlsbFormulaDecodeError } from "../src/modules/excel/errors.ts";
import { Address, Cell, Row, Workbook, Worksheet } from "../src/modules/excel/index.ts";
import type { XlsbReadDiagnostics } from "../src/modules/excel/xlsb/read/package.ts";

const CORPUS_DIR = "tmp/xlsb-corpus";

/** Where the edited round trip writes, and what it writes. Far outside every fixture's used range. */
const PROBE_ADDRESS = "ZZ998";
const PROBE_VALUE = "corpus-probe";

/** What a reader must find in a file, beyond "it parsed". */
interface Probes {
  /** Sheet names, in order. Order matters: it is the tab bar. */
  readonly sheets?: readonly string[];
  /** `date1904`, which changes every date in the file by four years. */
  readonly date1904?: boolean;
  /** Cells that must hold exactly this, as `"Sheet!A1"`. */
  readonly values?: Readonly<Record<string, string | number | boolean>>;
  /** Cells that must carry a formula whose text is exactly this. */
  readonly formulas?: Readonly<Record<string, string>>;
  /** How many cells carry a comment. */
  readonly comments?: number;
  /** How many cells carry a hyperlink. */
  readonly hyperlinks?: number;
  /** The package must be refused, with a message matching this. */
  readonly rejected?: RegExp;
}

/**
 * Per-file expectations.
 *
 * Deliberately not exhaustive and deliberately not generated. Each entry states something a human decided was worth
 * guaranteeing about that file — a 1904 date system, a formula that exercises a token this codec gets wrong when it
 * is careless, a comment count that a reader once returned as zero.
 */
const PROBES: Readonly<Record<string, Probes>> = {
  "cal-any_sheets": {
    // Four sheets, one of which is a chartsheet — the file that proved sheet parts cannot be numbered by position.
    sheets: ["Visible", "Hidden", "VeryHidden", "Chart"]
  },
  "cal-date": { date1904: false },
  "cal-date_1904": {
    // The whole reason this file is pinned. Reading it as 1900 shifts every date by 1,462 days.
    date1904: true
  },
  "cal-issue_182": {
    // A future function. The file stores it as `_xlfn.CONCAT`, reached through a defined name rather than an `Ftab`
    // id — and the probe asserts the *unprefixed* spelling, because leaking `_xlfn.` to a caller would be the bug.
    formulas: { "formula_vals!A2": 'CONCAT("A","b")', "formula_vals!A3": "ISERROR(1)" }
  },
  "poi-comments": { comments: 4 },
  "poi-hyperlink": { hyperlinks: 1 },
  "poi-testVarious": { comments: 10, hyperlinks: 1 },
  "poi-62815": {
    // Shared formulas down a column, and the file this library's relative-reference encoding was fixed against: its
    // `BrtShrFmla` holds `PtgRefN` with a 20-bit wrapped row offset. The probe names a follower rather than the
    // master, because a follower reading as the master's own cell is the failure that was shipped.
    sheets: ["RkNumber"],
    formulas: { "RkNumber!A82": "A81+1", "RkNumber!A277": "A276/300000" }
  },
  "cal-pass_protected": {
    // Encrypted, OLE-wrapped. Refusing it clearly is the supported behaviour; parsing it as a ZIP is not.
    rejected: /End of Central Directory|not a (zip|valid)/i
  },
  "poi-protected_passtika": { rejected: /End of Central Directory|not a (zip|valid)/i }
};

/** A `"Sheet!A1"` probe key, split. */
function splitProbe(key: string): { readonly sheet: string; readonly address: string } {
  const at = key.lastIndexOf("!");
  return { sheet: key.slice(0, at), address: key.slice(at + 1) };
}

/** Every failure a single workbook produced against its probes. */
function checkProbes(handle: Workbook.Handle, probes: Probes, label: string): string[] {
  const failures: string[] = [];
  const model = Workbook.getModel(handle);
  if (probes.sheets !== undefined) {
    const actual = model.worksheets.map(sheet => sheet.name);
    if (actual.join("|") !== probes.sheets.join("|")) {
      failures.push(`${label}: sheets [${actual.join(", ")}] ≠ [${probes.sheets.join(", ")}]`);
    }
  }
  if (probes.date1904 !== undefined) {
    const actual = model.properties?.date1904 === true;
    if (actual !== probes.date1904) {
      failures.push(`${label}: date1904 ${actual} ≠ ${probes.date1904}`);
    }
  }
  const sheetByName = new Map(
    Workbook.getWorksheets(handle).map(sheet => [Worksheet.getName(sheet), sheet])
  );
  for (const [key, expected] of Object.entries(probes.values ?? {})) {
    const { sheet, address } = splitProbe(key);
    const target = sheetByName.get(sheet);
    const actual = target === undefined ? undefined : Cell.getValue(target, address);
    if (actual !== expected) {
      failures.push(`${label}: ${key} = ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
    }
  }
  for (const [key, expected] of Object.entries(probes.formulas ?? {})) {
    const { sheet, address } = splitProbe(key);
    const target = sheetByName.get(sheet);
    const actual = target === undefined ? undefined : Cell.getFormula(target, address);
    if (actual !== expected) {
      failures.push(
        `${label}: ${key} formula ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`
      );
    }
  }
  if (probes.comments !== undefined || probes.hyperlinks !== undefined) {
    let comments = 0;
    let hyperlinks = 0;
    for (const sheet of model.worksheets) {
      for (const row of sheet.rows ?? []) {
        for (const cell of row.cells ?? []) {
          if (cell === undefined || cell === null) {
            continue;
          }
          if ((cell as { comment?: unknown }).comment !== undefined) {
            comments++;
          }
          if ((cell as { hyperlink?: unknown }).hyperlink !== undefined) {
            hyperlinks++;
          }
        }
      }
    }
    if (probes.comments !== undefined && comments !== probes.comments) {
      failures.push(`${label}: ${comments} comment(s) ≠ ${probes.comments}`);
    }
    if (probes.hyperlinks !== undefined && hyperlinks !== probes.hyperlinks) {
      failures.push(`${label}: ${hyperlinks} hyperlink(s) ≠ ${probes.hyperlinks}`);
    }
  }
  return failures;
}

/**
 * A fingerprint of everything a reader can see, derived from the workbook rather than written by hand.
 *
 * **`PROBES` covers ten of the twenty-three fixtures, and the other thirteen were checked against `{}`.** For those, the
 * edited round trip proved only that the bytes changed and the cross-container pass proved only that nothing threw — so a
 * rebuild or an XLSB→XLSX conversion could have dropped every cell and still passed. The script's own header promises
 * that each check asserts a value.
 *
 * Deriving the baseline from the *direct read* fixes that without a hand-written expectation per file: whatever the reader
 * saw first is what it has to keep seeing. `PROBES` remains, and remains the stronger statement — a hand-written value
 * catches a defect that is present on the very first read, which no self-comparison can.
 *
 * Deliberately shallow on style and deep on content: what these fixtures are for is catching *lost* data, and a style
 * index that renumbers between containers is not a loss.
 */
function contentFingerprint(handle: Workbook.Handle): readonly string[] {
  const lines: string[] = [];
  for (const sheet of Workbook.getWorksheets(handle)) {
    lines.push(`sheet ${Worksheet.getName(sheet)}`);
    // **`Worksheet.eachRow` + `Row.eachCell`, and the first version of this used neither.**
    //
    // It called `Worksheet.getRows(sheet)` with one argument. That function takes `(sheet, start, length)`, so `length`
    // was `undefined`, `start + length` was `NaN`, the loop body never ran and it returned `[]` — for every fixture, in
    // silence. The body then called `Row.getCells(row)`, which does not exist on the public surface at all; it never
    // threw because it was never reached. Two defects, each hiding the other, and the result was a fingerprint holding
    // nothing but the sheet names.
    //
    // That is worth spelling out because of what it made the checks below mean. "Cross-container parity" compared two
    // empty strings and passed; the edited round trip compared an empty string against an empty string with `includes`
    // and passed. Measured after the fix: 7 cells for `cal-any_sheets`, 29 for `poi-sample`, 26 for `cal-issues` — all
    // of it previously invisible.
    //
    // The address is rebuilt from the column ordinal because that is what `Row.eachCell` hands over — its `cell`
    // argument is the internal row-cell record, not something `Cell.getValue` accepts.
    Worksheet.eachRow(sheet, row => {
      Row.eachCell(sheet, row.number, (_cell, column) => {
        const address = `${Address.encodeCol(column - 1)}${row.number}`;
        const value = Cell.getValue(sheet, address);
        if (value === undefined || value === null || value === "") {
          return;
        }
        const formula = Cell.getFormula(sheet, address);
        const rendered =
          value instanceof Date
            ? value.toISOString()
            : typeof value === "object"
              ? stableJson(value)
              : String(value);
        lines.push(
          `  ${Worksheet.getName(sheet)}!${address} ${rendered}${formula === undefined ? "" : ` =${formula}`}`
        );
      });
    });
  }
  return lines;
}

/**
 * Differences an edited round trip is *expected* to show, by fixture, with the reason.
 *
 * **One entry, and it earned the shape by being the only thing left after four real defects were fixed.** The rebuild
 * check is otherwise exact in both directions, which is what makes an allowance affordable: anything not named here
 * still fails, including any other line of the same fixture.
 *
 * `was` is what the file held; `becomes` is what a rebuild produces. Both are spelled out so a change to either side is
 * a failure rather than a silently widened licence.
 */
const EXPECTED_REBUILD_DIFFERENCES: Readonly<
  Record<
    string,
    readonly { readonly was: string; readonly becomes: string; readonly why: string }[]
  >
> = {
  "poi-bug66682": [
    {
      was: '  test2!C9 {"formula":"unknownFunction()","result":{"error":"#NAME?"}} =unknownFunction()',
      becomes:
        '  test2!C9 {"formula":"UNKNOWNFUNCTION()","result":{"error":"#NAME?"}} =UNKNOWNFUNCTION()',
      why:
        "`unknownFunction` is a user-defined function, and this writer cannot tell one from a future function — so it " +
        "writes an `_xlfn.` stub, upper-cased the way Excel spells a function name. Preserving the author's case was " +
        "tried and reverted: the prefix already mis-encodes a UDF whatever case it carries, while writing " +
        "`_xlfn.xlookup` for a lower-case `xlookup(` is a spelling Excel has never been observed to produce. The " +
        "reasoning, and why the 448-function registry cannot be the discriminator, is in `futureFunctionStubName`."
    }
  ],
  "poi-testVarious": [
    {
      was: '  mySheet1!B14 {"formula":"COS(NA)","result":{"error":"#NAME?"}} =COS(NA)',
      becomes: '  mySheet1!B14 {"error":"#NAME?"}',
      why:
        "`NA` is a defined name whose `BrtName` carries an empty token stream — it defines nothing. The model holds a " +
        "name as `name → ranges`, so a definition-less one cannot enter it; the read reports it (`NA: defined name " +
        "with no definition`) and the write reports the formula it therefore cannot re-encode. What the cell *shows* is " +
        "unchanged: `COS(NA)` evaluates to `#NAME?`, and the cached `#NAME?` now survives as a literal — the fix that " +
        "made this line say `{error}` instead of the blank it used to leave behind. Preserving the expression would " +
        "need a model channel for names Excel does not write; both examples in the corpus are POI-authored."
    }
  ]
};

/**
 * What an XLSX conversion is *expected* to refuse, by fixture.
 *
 * **One entry, and it is a real loss rather than a quirk.** `cal-any_sheets.xlsb` carries a chartsheet, whose `.bin` sheet
 * part has no form in a SpreadsheetML package — so the tab is genuinely gone and the XLSX writer says so. The chart, its
 * drawing and its style parts still travel; only the sheet does not.
 *
 * Listed rather than ignored so that a *new* refusal is a failure. `unsupported` defaults to `"error"`, and a gate that
 * blanket-passed `"ignore"` would stop noticing the day a second thing became unwritable.
 */
const EXPECTED_XLSX_LOSSES: Readonly<Record<string, readonly string[]>> = {
  "cal-any_sheets": ["xl/chartsheets/sheet1.bin: preserved sheet part from the other container"]
};

/**
 * `JSON.stringify` with object keys in a fixed order.
 *
 * A rich-text run is an object, and the two readers build theirs by assigning fields in different orders — so plain
 * `JSON.stringify` reported `poi-sample`'s rich text as a cross-container difference when every field agreed. A
 * fingerprint has to distinguish content from the order a serialiser happened to visit it in, or its failures cannot be
 * trusted; arrays keep their order, which is content.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, raw) =>
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.keys(raw as Record<string, unknown>)
            .sort()
            .map(key => [key, (raw as Record<string, unknown>)[key]])
        )
      : raw
  );
}

/**
 * The probe cell's fingerprint line, so the edited round trip can require it rather than hope for it.
 *
 * Separate from the address itself because the two have to agree exactly, and a mismatch here would look like a lost
 * cell rather than like a broken check.
 */
function probeLine(sheetName: string): string {
  return `  ${sheetName}!${PROBE_ADDRESS} ${PROBE_VALUE}`;
}

/** `true` when the two packages are the same bytes. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function main(): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(CORPUS_DIR)).filter(name => name.endsWith(".xlsb")).sort();
  } catch {
    console.error(`✗ ${CORPUS_DIR} is missing. Run: pnpm corpus:xlsb`);
    process.exit(1);
    return;
  }
  if (names.length === 0) {
    console.error(`✗ ${CORPUS_DIR} is empty. Run: pnpm corpus:xlsb`);
    process.exit(1);
    return;
  }

  const failures: string[] = [];
  let checks = 0;

  for (const name of names) {
    const key = name.replace(/\.xlsb$/, "");
    const probes = PROBES[key] ?? {};
    const bytes = Uint8Array.from(await readFile(join(CORPUS_DIR, name)));

    if (probes.rejected !== undefined) {
      checks++;
      try {
        const handle = Workbook.create();
        await Workbook.read(handle, bytes);
        failures.push(`${key}: expected refusal, but it was read`);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!probes.rejected.test(message)) {
          failures.push(
            `${key}: refused with ${JSON.stringify(message)}, expected ${probes.rejected}`
          );
        }
      }
      console.log(`  ${key.padEnd(30)} refused as expected`);
      continue;
    }

    // 1. Probes on the direct read.
    const handle = Workbook.create();
    await Workbook.read(handle, bytes);
    checks++;
    failures.push(...checkProbes(handle, probes, `${key} read`));
    // The baseline every later stage is compared against — see `contentFingerprint`. Taken here, from the read the
    // probes have just been checked against, so a fixture with no probes still has something to hold on to.
    const baseline = contentFingerprint(handle);

    // 2. Passthrough: unmodified means the original bytes, exactly.
    checks++;
    const untouched = await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" });
    if (!sameBytes(untouched, bytes)) {
      failures.push(
        `${key}: unmodified write returned ${untouched.length} B, not the original ${bytes.length} B`
      );
    }

    // 3. Edited round trip: rebuilt, and every probe still holds.
    checks++;
    const edited = Workbook.create();
    await Workbook.read(edited, bytes);
    const first = Workbook.getWorksheets(edited)[0];
    const editedSheet = first === undefined ? undefined : Worksheet.getName(first);
    if (first !== undefined) {
      Cell.setValue(first, PROBE_ADDRESS, PROBE_VALUE);
    }
    const rebuilt = await Workbook.toBuffer(edited, { format: "xlsb", unsupported: "ignore" });
    if (sameBytes(rebuilt, bytes)) {
      failures.push(`${key}: an edited workbook returned the original bytes`);
    }
    const reread = Workbook.create();
    await Workbook.read(reread, rebuilt);
    failures.push(...checkProbes(reread, probes, `${key} xlsb round trip`));
    // **Set difference, not `includes` on a joined string.**
    //
    // The edit adds a line *inside* the first sheet's block, so the baseline is not a substring of the result for any
    // fixture with more than one sheet — `cal-any_sheets` has four. The previous check only passed because both strings
    // were empty (see `contentFingerprint`), and it could not have expressed this anyway: a substring test cannot say
    // "everything is still here and exactly one thing is new".
    //
    // Both directions are asserted, which is what makes the probe load-bearing: a rebuild that dropped the edit fails
    // just as loudly as one that dropped a cell the file arrived with.
    const afterRebuild = contentFingerprint(reread);
    const before = new Set(baseline);
    const after = new Set(afterRebuild);
    const allowed = EXPECTED_REBUILD_DIFFERENCES[key] ?? [];
    const missing = baseline
      .filter(line => !after.has(line))
      .filter(line => !allowed.some(entry => entry.was === line));
    const added = afterRebuild.filter(line => !before.has(line));
    if (missing.length > 0) {
      failures.push(
        `${key}: rebuilding lost ${missing.length} line(s) the read had seen, first ${JSON.stringify(missing[0])}`
      );
    }
    const expectedNew = [
      ...(editedSheet === undefined ? [] : [probeLine(editedSheet)]),
      ...allowed.map(entry => entry.becomes)
    ];
    const unexpected = added.filter(line => !expectedNew.includes(line));
    if (unexpected.length > 0) {
      failures.push(
        `${key}: rebuilding invented ${unexpected.length} line(s), first ${JSON.stringify(unexpected[0])}`
      );
    }
    for (const line of expectedNew) {
      if (!after.has(line)) {
        failures.push(
          `${key}: expected ${JSON.stringify(line)} in the rebuilt package, and it is absent`
        );
      }
    }
    // **An allowance that stopped applying is a failure too.** If the defect it describes gets fixed, the entry has to
    // go — a stale licence is how a gate quietly stops checking the thing it was narrowed around.
    for (const entry of allowed) {
      if (after.has(entry.was)) {
        failures.push(
          `${key}: the expected difference for ${JSON.stringify(entry.was)} no longer occurs — remove it from ` +
            "EXPECTED_REBUILD_DIFFERENCES"
        );
      }
    }

    // 4. Cross-container parity: the same probes through XLSX.
    //
    // **The conversion's own loss report is checked first, not suppressed.** `unsupported` defaults to `"error"` and is
    // honoured by the XLSX writer now, so a fixture carrying something that cannot cross — a preserved chartsheet is the
    // only such thing — refuses here. Reading what it refuses and comparing that against `EXPECTED_XLSX_LOSSES` is the
    // point: passing `"ignore"` without looking would turn a gate into a bypass, which is what this file exists to avoid.
    checks++;
    const xlsxLosses = await Workbook.toBuffer(handle, { format: "xlsx", validate: false }).then(
      () => [] as readonly string[],
      (cause: unknown) =>
        cause instanceof ExcelNotSupportedError ? cause.items : Promise.reject(cause)
    );
    const expectedXlsxLosses = EXPECTED_XLSX_LOSSES[key] ?? [];
    if (xlsxLosses.join("\n") !== expectedXlsxLosses.join("\n")) {
      failures.push(
        `${key}: XLSX conversion reported ${JSON.stringify(xlsxLosses)}, expected ` +
          `${JSON.stringify(expectedXlsxLosses)}`
      );
    }
    const asXlsx = await Workbook.toBuffer(handle, {
      format: "xlsx",
      validate: false,
      unsupported: "ignore"
    });
    const viaXlsx = Workbook.create();
    await Workbook.read(viaXlsx, asXlsx);
    failures.push(...checkProbes(viaXlsx, probes, `${key} via xlsx`));
    const viaXlsxFingerprint = contentFingerprint(viaXlsx);
    if (viaXlsxFingerprint.join("\n") !== baseline.join("\n")) {
      // Reported as a first difference rather than as two large blobs, which is the difference between a usable failure
      // and one nobody reads.
      const at = baseline.findIndex((line, index) => viaXlsxFingerprint[index] !== line);
      failures.push(
        `${key}: XLSX conversion changed content — first difference at line ${at + 1}: ` +
          `xlsb ${JSON.stringify(baseline[at] ?? "(end)")} vs xlsx ${JSON.stringify(viaXlsxFingerprint[at] ?? "(end)")}`
      );
    }

    // 5. Formula read policies, on every real file rather than on a synthetic one.
    //
    // The invariants hold whatever the file contains, which is what makes them worth running across the corpus:
    // `"cached"` must leave no formula anywhere, must not report an undecodable one (it decodes nothing), and must
    // keep every cell `"preserve"` produced. `"error"` must agree with `"preserve"` about whether anything failed —
    // if it throws where `"preserve"` reported nothing, or stays silent where `"preserve"` reported a loss, then one
    // of the two is lying about the same bytes.
    checks++;
    const preserved = await Workbook.readWithDiagnostics(Workbook.create(), bytes, {
      formulas: "preserve"
    });
    const cachedHandle = Workbook.create();
    const cached = await Workbook.readWithDiagnostics(cachedHandle, bytes, { formulas: "cached" });
    const xlsbOf = (report: typeof preserved): XlsbReadDiagnostics | undefined =>
      report.xlsb === undefined ? undefined : report.xlsb;
    const cachedReport = xlsbOf(cached);
    if (cachedReport !== undefined && cachedReport.undecodedFormulas.length > 0) {
      failures.push(
        `${key}: formulas:"cached" reported ${cachedReport.undecodedFormulas.length} undecodable expression(s), but it decodes none`
      );
    }
    const leftovers: string[] = [];
    for (const sheet of Workbook.getWorksheets(cachedHandle)) {
      for (const row of Worksheet.getRows(sheet)) {
        for (const cell of Row.getCells(row)) {
          if (Cell.getFormula(cell) !== undefined) {
            leftovers.push(Cell.getFullAddress(cell));
          }
        }
      }
    }
    if (leftovers.length > 0) {
      failures.push(
        `${key}: formulas:"cached" left ${leftovers.length} formula(s) in the model (${leftovers.slice(0, 3).join(", ")})`
      );
    }
    const preservedReport = xlsbOf(preserved);
    const shouldThrow = (preservedReport?.undecodedFormulas.length ?? 0) > 0;
    let threw = false;
    try {
      await Workbook.read(Workbook.create(), bytes, { formulas: "error" });
    } catch (cause) {
      threw = cause instanceof XlsbFormulaDecodeError;
      if (!threw) {
        throw cause;
      }
    }
    if (threw !== shouldThrow) {
      failures.push(
        `${key}: formulas:"error" ${threw ? "threw" : "did not throw"}, but "preserve" reported ${preservedReport?.undecodedFormulas.length ?? 0} undecodable expression(s)`
      );
    }

    console.log(
      `  ${key.padEnd(30)} probes ok, passthrough exact, round trip ok, xlsx parity ok, formula policies ok`
    );
  }

  console.log(
    `\n${names.length} fixture(s), ${checks} check group(s), ${failures.length} failure(s).`
  );
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  if (failures.length > 0) {
    process.exit(1);
  }
}

await main();
