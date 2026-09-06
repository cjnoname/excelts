/**
 * BIFF12 record specification self-check.
 *
 * The record table in `src/modules/excel/xlsb/spec/records.ts` is the single source
 * of truth for the disassembler, the fixture builder and the validator. A mistake
 * in it therefore propagates to all three at once *and* to the check that is
 * supposed to catch structural problems — a mismatched `Begin`/`End` pair would
 * make the scope checker enforce the wrong thing while still passing.
 *
 * So the table is checked as data, before anything uses it. This is a pure scan
 * with no build step and no fixtures, which is why it belongs in `pnpm check`
 * rather than in the test suite.
 */

import {
  BIFF_RECORDS,
  FIXED_FIELD_WIDTHS,
  INFERRED_VALUES,
  MAX_RECORD_ID,
  OBSERVED_PAYLOAD_SIZES,
  RECORD_BY_ID,
  RECORD_BY_NAME
} from "@excel/xlsb/spec/records";

/**
 * Everything the record table must satisfy, as data rather than as a script.
 *
 * **Why this moved out of `scripts/`.** It was written as a `verify:*` gate because the other ten
 * are, and following that convention was a mistake: every one of those either inspects build output
 * (`treeshake`, `cjs`, `install`), scans the source tree as text (`layers`, `doc-links`), or needs a
 * different runtime (`install`). This one does none of those. It checks a table in this repository
 * against itself, which is exactly what a test does — and being a script meant it ran only in CI and
 * never in a watch loop.
 *
 * The *report* is still a script, because printing the undeclared layouts and the inferred values is
 * a communication job rather than an assertion. Both now read the same function, so they cannot
 * disagree about what "consistent" means.
 */
/**
 * Records whose field list describes only the start of the payload, and why.
 *
 * A short layout is this module's normal way of saying "this much is understood". Naming the records that do
 * it keeps the check above meaningful: without the list every short layout is permitted and a record that
 * silently *lost* its tail looks the same as one that never described it.
 *
 * Each entry is a claim that the undescribed bytes were looked at and left alone, not overlooked.
 */
const PARTIAL_LAYOUTS: ReadonlySet<string> = new Set([
  // 13 of 25. The tail is `ccolspan` and one `BrtColSpan`, which `write/rows.ts` builds directly — a
  // repeating structure the field vocabulary here has no way to express.
  "BrtRowHdr",
  // 4 of 68. Every corpus workbook holds exactly two of these, differing in the single byte `fls`. One
  // sample of a structure establishes its size and nothing else, so the remaining 64 bytes — the pattern's
  // foreground and background colours and a gradient — stay undeclared. See `xlsb/fill.ts`.
  "BrtFill",
  // 12 of 16. The four trailing bytes are the alignment and protection bits. `xlsb/alignment.ts` reads and
  // writes them; they are not declared here because the field vocabulary has no bitfield type and naming
  // them as a `u32` would describe eight fields as one.
  "BrtXF"
]);

export function checkRecordTable(): string[] {
  const problems: string[] = [];

  function fail(message: string): void {
    problems.push(message);
  }

  // --- Identifiers -------------------------------------------------------------

  const seenIds = new Map<number, string>();
  for (const record of BIFF_RECORDS) {
    if (!Number.isInteger(record.id) || record.id < 0 || record.id >= MAX_RECORD_ID) {
      fail(`${record.name}: id ${record.id} is not an integer in [0, ${MAX_RECORD_ID})`);
    }
    const existing = seenIds.get(record.id);
    if (existing) {
      fail(`id 0x${record.id.toString(16)} is claimed by both ${existing} and ${record.name}`);
    }
    seenIds.set(record.id, record.name);
  }

  // --- Names -------------------------------------------------------------------

  const seenNames = new Map<string, number>();
  for (const record of BIFF_RECORDS) {
    if (!/^Brt[A-Za-z0-9]+$/.test(record.name)) {
      fail(`${record.name}: not a plausible [MS-XLSB] record name`);
    }
    const existing = seenNames.get(record.name);
    if (existing !== undefined) {
      fail(
        `name ${record.name} is claimed by both 0x${existing.toString(16)} and ` +
          `0x${record.id.toString(16)}`
      );
    }
    seenNames.set(record.name, record.id);
  }

  // --- Lookup tables agree with the list ---------------------------------------

  if (RECORD_BY_ID.size !== BIFF_RECORDS.length) {
    fail(`RECORD_BY_ID has ${RECORD_BY_ID.size} entries for ${BIFF_RECORDS.length} records`);
  }
  if (RECORD_BY_NAME.size !== BIFF_RECORDS.length) {
    fail(`RECORD_BY_NAME has ${RECORD_BY_NAME.size} entries for ${BIFF_RECORDS.length} records`);
  }

  // --- Ordering ----------------------------------------------------------------

  for (let i = 1; i < BIFF_RECORDS.length; i++) {
    if (BIFF_RECORDS[i]!.id <= BIFF_RECORDS[i - 1]!.id) {
      fail(
        `BIFF_RECORDS is not sorted by id: ${BIFF_RECORDS[i - 1]!.name} then ${BIFF_RECORDS[i]!.name}`
      );
    }
  }

  // --- Scope pairs -------------------------------------------------------------

  /**
   * The pairs whose `End` identifier is **lower** than its `Begin`.
   *
   * `[MS-XLSB]` numbers almost every delimiter pair with `End = Begin + 1`, and the check below treats a
   * departure from that as a sign the table was mistyped — which it usually is. Two pivot pairs are genuinely
   * decreasing, so they are named here rather than the check being dropped: removing it would stop catching
   * the transposition it exists for, and this work has already produced one (`BrtBeginSXVI` was first entered
   * under `BrtBeginSXDI`'s identifiers, which this same verification caught).
   *
   * A name in this set is still checked for everything else: that the counterpart exists, has the opposite
   * role, and names it back.
   */
  const DECREASING_PAIRS: ReadonlySet<string> = new Set(["BrtBeginSXVI", "BrtBeginSXLocation"]);

  // Every delimiter must name a counterpart that exists, has the opposite role, and
  // names it back. A one-directional pair is the failure that would silently break
  // the scope checker.
  for (const record of BIFF_RECORDS) {
    if (!record.scope) {
      if (record.pairsWith) {
        fail(`${record.name}: declares pairsWith but no scope`);
      }
      continue;
    }
    if (!record.pairsWith) {
      fail(`${record.name}: is a ${record.scope} delimiter with no counterpart`);
      continue;
    }
    const counterpart = RECORD_BY_NAME.get(record.pairsWith);
    if (!counterpart) {
      fail(`${record.name}: counterpart ${record.pairsWith} is not in the table`);
      continue;
    }
    const expected = record.scope === "begin" ? "end" : "begin";
    if (counterpart.scope !== expected) {
      fail(`${record.name}: counterpart ${counterpart.name} should be a ${expected} delimiter`);
    }
    if (counterpart.pairsWith !== record.name) {
      fail(
        `${record.name} pairs with ${counterpart.name}, but ${counterpart.name} pairs with ` +
          `${counterpart.pairsWith}`
      );
    }
    if (
      record.scope === "begin" &&
      counterpart.id <= record.id &&
      !DECREASING_PAIRS.has(record.name)
    ) {
      fail(`${record.name} (0x${record.id.toString(16)}) is not below its End`);
    }
  }

  // A pair's two names must differ **only** by `Begin` versus `End`, wherever that word sits.
  //
  // This used to demand a `BrtBegin…` prefix, which four real records do not have: `BrtFRTBegin`,
  // `BrtFRTEnd`, `BrtACBegin` and `BrtACEnd` put the word last. The prefix rule was inherited from a
  // table that derived both names from one suffix, and enforcing it made the check an assertion about
  // this file's former shortcut rather than about the format — it would have rejected the specification's
  // own names. Comparing the two halves with the word removed is the invariant that actually matters,
  // and it is the one that catches a pair pointing at different scopes.
  for (const record of BIFF_RECORDS) {
    if (record.scope !== undefined && !/Begin|End/.test(record.name)) {
      fail(`${record.name}: a scope delimiter must say Begin or End in its name`);
    }
    if (record.scope === "begin" && /End/.test(record.name)) {
      fail(`${record.name}: categorised as a begin delimiter but named End`);
    }
    if (record.scope === "end" && /Begin/.test(record.name)) {
      fail(`${record.name}: categorised as an end delimiter but named Begin`);
    }
    if (record.scope && record.pairsWith) {
      const own = record.name.replace(/Begin|End/, "");
      const other = record.pairsWith.replace(/Begin|End/, "");
      if (own !== other) {
        fail(`${record.name} and ${record.pairsWith} describe different scopes`);
      }
    }
  }

  // --- Field layouts -----------------------------------------------------------

  for (const record of BIFF_RECORDS) {
    if (!record.fields) {
      continue;
    }
    if (record.fields.length === 0) {
      fail(`${record.name}: declares an empty field list; omit it instead`);
    }
    const names = new Set<string>();
    for (const field of record.fields) {
      if (names.has(field.name)) {
        fail(`${record.name}: duplicate field name ${field.name}`);
      }
      names.add(field.name);
      if (!/^[a-z][A-Za-z0-9]*$/.test(field.name)) {
        fail(`${record.name}.${field.name}: field names are lowerCamelCase`);
      }
    }
    // Variable-length fields may appear anywhere and any number of times: the decoder
    // reads sequentially, so it always knows where one ends. The constraint that a
    // field must have a fixed-width prefix in front of it belongs to *skipping* to a
    // field without decoding what precedes it, which only the fixture builder's
    // `patchField` does — and it reports that itself, at the one call site that cares.
    //
    // An earlier version of this rule required a variable-length field to be last,
    // which reads as caution and is simply wrong about the format: `BrtBundleSh`
    // carries a nullable relationship id followed by a sheet name, and a table that
    // cannot describe it is not a description of BIFF12.
    void FIXED_FIELD_WIDTHS;
  }

  // --- Categories --------------------------------------------------------------

  // The category is what the checkers use instead of their own hand-written lists of
  // record names, so a record in the wrong category silently changes what gets checked.
  // These rules tie it back to the layout, which is independently readable against the
  // specification.
  for (const record of BIFF_RECORDS) {
    if (record.category === "cell") {
      if (record.scope) {
        fail(`${record.name}: a scope delimiter cannot also be a cell record`);
      }
      // A declared cell layout must actually begin with the Cell struct, or
      // `styleReference` and the coordinate check read the wrong bytes.
      if (record.fields && record.fields[0]?.type !== "cell") {
        fail(`${record.name}: category "cell" but its layout does not start with a cell field`);
      }
      if (!/^Brt(Cell|Short|Fmla)/.test(record.name)) {
        fail(`${record.name}: category "cell" but the name does not look like a cell record`);
      }
    }
    if (record.category === "row") {
      // The index check finds a row's style reference by the field name `ixfe`.
      if (record.fields && !record.fields.some(field => field.name === "ixfe")) {
        fail(`${record.name}: category "row" but its layout declares no ixfe field`);
      }
    }
  }

  // Every record whose name marks it as a cell must be categorised, or the ordering
  // check stops applying to it the moment one is added to the table without the tag.
  for (const record of BIFF_RECORDS) {
    // `BrtCellIgnoreEC` is the exception the pattern cannot see: it is an entry in the ignored-error
    // collection, not a cell value, and it is named for the cell it refers *to*. Excluding it by name is
    // honest about the rule being a name-shaped proxy for a thing names do not quite determine.
    if (
      /^Brt(Cell|Short|Fmla)[A-Z]/.test(record.name) &&
      record.category !== "cell" &&
      record.name !== "BrtCellIgnoreEC"
    ) {
      fail(`${record.name}: looks like a cell record but is not categorised as one`);
    }
  }

  // **A declared layout must not overrun the record, and must account for it unless it says why not.**
  //
  // Two tables describe the same bytes — the field list, and `OBSERVED_PAYLOAD_SIZES`, which holds lengths
  // read off real Excel output — and nothing compared them. The comparison is one-directional on purpose:
  //
  // - Declaring **more** than the record holds is always wrong. `decodeRecord` would read past the payload,
  //   and a writer built from the table would emit a record Excel cannot parse.
  // - Declaring **less** is a legitimate position this module takes often: a field is named once it is
  //   understood, and the rest of the record is left undescribed rather than guessed at. `BrtBorder` is the
  //   extreme case — 51 bytes, one corpus sample, no fields declared at all.
  //
  // So a short layout is allowed only for a record named in {@link PARTIAL_LAYOUTS}, which is the list of
  // records whose trailing bytes are deliberately undescribed. Adding a field to one of those and forgetting
  // to remove it from the list is harmless; the reverse — a record quietly losing its tail — is what this
  // catches.
  //
  // It found `BrtWsFmtInfo` declaring 10 bytes against an observed 12, omitting `iOutLevelRw` and
  // `iOutLevelCol`; the writer and reader handle those with their own arithmetic, so only the tooling built
  // on this table was wrong — and that is the tooling the rest of these checks run on. It also found
  // `BrtBeginColInfos` declaring a four-byte count where Excel writes an empty payload.
  //
  // It would **not** have caught `BrtRowHdr`, and no length check could have. That record declared 12 of 25
  // bytes before and after the fix, and the writer emitted the full 25 in both cases — `u16` plus a byte is
  // three bytes and so is a byte three times. The defect was the *bit positions inside* those bytes, which is
  // why `check-framing.ts` — which compares each written record against Excel's own length, and does catch a
  // record that is genuinely the wrong size — passed it too. A wrong layout of the right length is only
  // visible against the specification, which is what `__tests__/row-header.test.ts` asserts.
  for (const record of BIFF_RECORDS) {
    const observed = OBSERVED_PAYLOAD_SIZES.get(record.name);
    if (record.fields === undefined || observed === undefined) {
      continue;
    }
    let declared = 0;
    let variable = false;
    for (const field of record.fields) {
      const width = FIXED_FIELD_WIDTHS[field.type];
      if (width === undefined) {
        // A variable-width field makes the total depend on content, so an observed size is one sample
        // rather than a constraint and there is nothing to compare.
        variable = true;
        break;
      }
      declared += width;
    }
    if (variable) {
      // **A record with a variable-width field must not be in the length table at all.** An entry there is
      // read as "every Excel-authored one is exactly this", and the validator raises an *error* on a
      // mismatch — so a record whose length legitimately follows its content makes that check reject valid
      // files. `BrtDrawing` was listed at 12 bytes, which is what `"rId2"` encodes to; a sheet with ten
      // relationships produces `rId10`, and the validator rejected a package this library had just written.
      fail(
        `${record.name}: has a variable-width field, so it cannot have a fixed observed size — remove it ` +
          `from OBSERVED_PAYLOAD_SIZES`
      );
      continue;
    }
    if (declared > observed) {
      fail(
        `${record.name}: fields describe ${declared} byte(s) but the record is only ${observed}`
      );
    } else if (declared < observed && !PARTIAL_LAYOUTS.has(record.name)) {
      fail(
        `${record.name}: fields describe ${declared} of ${observed} byte(s); declare the rest or add it ` +
          `to PARTIAL_LAYOUTS with the reason`
      );
    }
  }

  // The counts the report prints are derived in `summariseRecordTable` rather than here, so this
  // function returns problems and nothing else — a checker that also computed a summary would have two
  // reasons to be called and one of them would eventually go unread.
  return problems;
}

/** The counts the report prints, derived here so the two cannot drift. */
export function summariseRecordTable(): {
  readonly total: number;
  readonly scopePairs: number;
  readonly cells: number;
  readonly withLayout: number;
  readonly undeclaredCells: readonly string[];
  readonly inferred: readonly string[];
} {
  return {
    total: BIFF_RECORDS.length,
    scopePairs: BIFF_RECORDS.filter(record => record.scope === "begin").length,
    cells: BIFF_RECORDS.filter(record => record.category === "cell").length,
    withLayout: BIFF_RECORDS.filter(record => record.fields).length,
    undeclaredCells: BIFF_RECORDS.filter(
      record => record.category === "cell" && !record.fields
    ).map(record => record.name),
    inferred: Object.entries(INFERRED_VALUES).map(([name, value]) => `${name}=${value}`)
  };
}
