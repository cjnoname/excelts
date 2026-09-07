/**
 * A timezone-carrying ISO string, read as the instant it names.
 *
 * **`2020-01-15T00:00:00.000Z` used to parse to 2020-01-14T16:00Z in UTC+8.** An explicit `Z` was read as local
 * time, which is not a rounding difference — it is a different day for everyone east of UTC.
 *
 * Two independent causes, both of them the same mistake in different clothes:
 *
 * 1. **The fixed-width parsers did not check their width.** They were written to be selected by length first —
 *    every one carries its width in a comment — so `parseISO` verified only that positions 4 and 7 held dashes.
 *    Any caller reaching them another way got a silent prefix match. `createIsoDateParser` flattened the length
 *    table into an ordered list, so the ten-character date parser saw the twenty-four-character string first;
 *    `createDateParser` tries the caller's formats in order, so the nineteen-character datetime parser
 *    swallowed the prefix and dropped the `Z`. Both then built with `new Date(y, m - 1, d, …)` — local.
 * 2. **The Excel CSV bridge's default read formats omitted the form its own writer emits.** Nothing noticed,
 *    because cause 1 meant a too-permissive parser matched it anyway.
 *
 * The assertions are therefore of two kinds: one that the parsers are now self-guarding whatever route reaches
 * them, and one that the bridge round-trips its own output. And they run under {@link ZONES}, because at offset
 * zero the wrong answer and the right answer are identical — which is why a UTC-only CI never saw this.
 */
import { Cell, Workbook, Worksheet } from "@excel";
import { readCsv, writeCsvBuffer } from "@excel/bridge/csv.node";
import { createDateParser, createIsoDateParser } from "@utils/datetime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** One east of UTC, one west, one past the date line. UTC is the control that cannot fail. */
const ZONES = ["UTC", "Asia/Shanghai", "America/New_York", "Pacific/Kiritimati"] as const;

let originalTz: string | undefined;

beforeEach(() => {
  originalTz = process.env.TZ;
});

afterEach(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

describe.each(ZONES)("in %s", zone => {
  beforeEach(() => {
    process.env.TZ = zone;
  });

  it.each([
    { text: "2020-01-15T09:30:00Z", iso: "2020-01-15T09:30:00.000Z" },
    { text: "2020-01-15T00:00:00.000Z", iso: "2020-01-15T00:00:00.000Z" },
    { text: "2020-01-15T09:30:00+02:00", iso: "2020-01-15T07:30:00.000Z" },
    { text: "2020-01-15T09:30:00.000+02:00", iso: "2020-01-15T07:30:00.000Z" }
  ])("reads $text as the instant it names", ({ text, iso }) => {
    // Auto-detection, which used to try the ten-character parser first.
    expect(createIsoDateParser().parse(text)?.toISOString()).toBe(iso);
    // And the named-format route, which used to let a shorter parser swallow the prefix. Every format is
    // offered, in the order the bridge offers them, so a wrong one winning is exactly what would fail here.
    expect(
      createDateParser([
        "YYYY-MM-DD[T]HH:mm:ssZ",
        "YYYY-MM-DD[T]HH:mm:ss",
        "YYYY-MM-DD",
        "YYYY-MM-DD[T]HH:mm:ss.SSSZ"
      ])
        .parse(text)
        ?.toISOString()
    ).toBe(iso);
  });

  it("does not let a fixed-width parser match a longer string", () => {
    // The precondition, asserted directly: a parser offered only its own format must refuse anything wider.
    expect(createDateParser(["YYYY-MM-DD"]).parse("2020-01-15T00:00:00.000Z")).toBeNull();
    expect(
      createDateParser(["YYYY-MM-DD[T]HH:mm:ss"]).parse("2020-01-15T00:00:00.000Z")
    ).toBeNull();
  });

  it("round-trips a date cell through the Excel CSV bridge", async () => {
    const workbook = Workbook.create();
    Worksheet.addRow(Workbook.addWorksheet(workbook, "S"), [new Date(Date.UTC(2020, 0, 15))]);
    const csv = await writeCsvBuffer(workbook);
    const reopened = Workbook.create();
    await readCsv(reopened, csv);
    // Invariance is the assertion: the defect was a *difference* between timezones.
    expect(Cell.getDateParts(Workbook.getWorksheet(reopened, 1)!, "A1")).toMatchObject({
      year: 2020,
      month: 1,
      day: 15,
      hour: 0
    });
  });

  it("round-trips a date cell written as the calendar value", async () => {
    // `dateUTC: true` makes the file identical on every machine. It is not the default because a named
    // `dateFormat` carries no timezone marker and is read back as local — see `createDefaultWriteMapper`.
    const workbook = Workbook.create();
    Worksheet.addRow(Workbook.addWorksheet(workbook, "S"), [new Date(Date.UTC(2020, 0, 15))]);
    const csv = await writeCsvBuffer(workbook, { dateUTC: true });
    expect(new TextDecoder().decode(csv).trim()).toBe("2020-01-15T00:00:00.000Z");
    const reopened = Workbook.create();
    await readCsv(reopened, csv);
    expect(Cell.getDateParts(Workbook.getWorksheet(reopened, 1)!, "A1")).toMatchObject({
      year: 2020,
      month: 1,
      day: 15,
      hour: 0
    });
  });
});
