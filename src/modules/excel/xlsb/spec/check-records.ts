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
    if (record.scope === "begin" && counterpart.id <= record.id) {
      fail(`${record.name} (0x${record.id.toString(16)}) is not below its End`);
    }
  }

  // The naming convention is load-bearing: the table generates both halves of a
  // pair from one row, so a name that does not follow it means the generator was
  // bypassed and the two halves can drift.
  for (const record of BIFF_RECORDS) {
    if (record.scope === "begin" && !record.name.startsWith("BrtBegin")) {
      fail(`${record.name}: a begin delimiter should be named BrtBegin…`);
    }
    if (record.scope === "end" && !record.name.startsWith("BrtEnd")) {
      fail(`${record.name}: an end delimiter should be named BrtEnd…`);
    }
    if (record.scope && record.pairsWith) {
      const own = record.name.replace(/^Brt(Begin|End)/, "");
      const other = record.pairsWith.replace(/^Brt(Begin|End)/, "");
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
    if (/^Brt(Cell|Short|Fmla)[A-Z]/.test(record.name) && record.category !== "cell") {
      fail(`${record.name}: looks like a cell record but is not categorised as one`);
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
