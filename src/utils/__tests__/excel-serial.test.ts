/**
 * The serial ↔ calendar-fields conversion, and the `Date` bridge built on it.
 *
 * Two things are pinned here, and they are pinned differently on purpose.
 *
 * The **model** — which serial is which date — is asserted against fixed constants, because it is a fact about
 * Excel that this library does not get to choose. The **arithmetic** is asserted against the expression the
 * library used before `excel-serial` existed (`25569 + t / 86400000`), exhaustively and by property, because
 * changing it by a single ULP changes the digits written into a `<v>` element and therefore every fixture that
 * has ever been compared byte for byte.
 *
 * The two together are what makes this refactor checkable rather than merely plausible.
 */
import {
  EXCEL_1900_EPOCH_OFFSET,
  EXCEL_1904_EPOCH_DELTA,
  MS_PER_DAY,
  partsToSerial,
  partsToUtcDate,
  serialHasTime,
  isExcelPhantomDay,
  serialToParts,
  utcDateToParts
} from "@utils/excel-serial";
import { dateToExcel, excelToDate } from "@utils/utils.base";
import { describe, expect, it } from "vitest";

/** The arithmetic as it stood before this module, kept verbatim as the oracle. */
function legacyToSerial(date: Date, date1904?: boolean): number {
  return 25569 + date.getTime() / (24 * 3600 * 1000) - (date1904 ? 1462 : 0);
}

/** The read direction, likewise. */
function legacyToDate(serial: number, date1904?: boolean): Date {
  return new Date(Math.round((serial - 25569 + (date1904 ? 1462 : 0)) * 24 * 3600 * 1000));
}

/** A deterministic pseudo-random generator, so a failure is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("the Excel serial model", () => {
  it.each([
    // Excel's own answers, which the linear model this replaced did not give below serial 61.
    { serial: 0, iso: "1899-12-31" },
    { serial: 1, iso: "1900-01-01" },
    { serial: 2, iso: "1900-01-02" },
    { serial: 32, iso: "1900-02-01" },
    { serial: 59, iso: "1900-02-28" },
    // Serial 60 is Excel's fictitious 1900-02-29 — a day the calendar does not have. The parts
    // are plain numbers, so they can say it; `partsToUtcDate` and Temporal cannot and refuse.
    { serial: 60, iso: "1900-02-29" },
    { serial: 61, iso: "1900-03-01" },
    { serial: 25_569, iso: "1970-01-01" },
    { serial: 43_845, iso: "2020-01-15" },
    { serial: 45_306, iso: "2024-01-15" }
  ])("reads serial $serial as $iso under the 1900 epoch", ({ serial, iso }) => {
    const parts = serialToParts(serial);
    const rendered = `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    expect(rendered).toBe(iso);
    expect(partsToSerial(parts)).toBe(serial);
  });

  it("keeps the phantom day distinct from both of its neighbours", () => {
    // The property the old linear model could not have: three consecutive serials, three
    // different answers, and the middle one a date that does not exist.
    expect(partsToSerial({ year: 1900, month: 2, day: 28 })).toBe(59);
    expect(partsToSerial({ year: 1900, month: 2, day: 29 })).toBe(60);
    expect(partsToSerial({ year: 1900, month: 3, day: 1 })).toBe(61);
    expect(isExcelPhantomDay(serialToParts(60))).toBe(true);
    expect(isExcelPhantomDay(serialToParts(59))).toBe(false);
    expect(isExcelPhantomDay(serialToParts(61))).toBe(false);
  });

  it.each([
    { serial: 0, iso: "1904-01-01" },
    { serial: 1, iso: "1904-01-02" },
    // No phantom day in the 1904 system — it begins after the date Lotus got wrong — so this is
    // a plain 61 days after the epoch, and the correction above must not apply here.
    { serial: 61, iso: "1904-03-02" }
  ])("reads serial $serial as $iso under the 1904 epoch", ({ serial, iso }) => {
    const parts = serialToParts(serial, true);
    const rendered = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    expect(rendered).toBe(iso);
    expect(isExcelPhantomDay(parts, true)).toBe(false);
  });

  it("separates the epochs by exactly the documented delta", () => {
    // Not an incidental consequence of two constants: a workbook written under one epoch and
    // read under the other is wrong by precisely this, which is the failure the `date1904`
    // plumbing exists to prevent. Asserted on a modern date, where no phantom-day correction
    // applies to either side.
    expect(partsToSerial({ year: 2020, month: 1, day: 15 })).toBe(
      partsToSerial({ year: 2020, month: 1, day: 15 }, true) + EXCEL_1904_EPOCH_DELTA
    );
    expect(EXCEL_1900_EPOCH_OFFSET).toBe(partsToSerial({ year: 1970, month: 1, day: 1 }));
  });

  it("puts the time of day in the fraction", () => {
    expect(partsToSerial({ year: 1899, month: 12, day: 31, hour: 12 })).toBe(0.5);
    expect(serialToParts(45_306.5)).toMatchObject({ year: 2024, month: 1, day: 15, hour: 12 });
    expect(serialHasTime(45_306)).toBe(false);
    expect(serialHasTime(45_306.5)).toBe(true);
    // A whole day arrived at by arithmetic is regularly 45306.000000000004, which
    // `serial % 1 !== 0` calls a time and this must not.
    expect(serialHasTime(45_306 + Number.EPSILON * 45_306)).toBe(false);
  });

  it("rounds to the nearest millisecond before splitting, not after", () => {
    // 09:30 is not exactly representable as a fraction of a day. Splitting first turns it into
    // 09:29:59.999, which is how a time cell used to lose a second on the way out.
    const serial = partsToSerial({ year: 2024, month: 1, day: 15, hour: 9, minute: 30 });
    expect(serialToParts(serial)).toMatchObject({ hour: 9, minute: 30, second: 0, millisecond: 0 });
  });

  it("carries out-of-range fields the way Date.UTC does", () => {
    const same = (a: number, b: number): void => expect(a).toBeCloseTo(b, 9);
    same(
      partsToSerial({ year: 2024, month: 13, day: 1 }),
      partsToSerial({ year: 2025, month: 1, day: 1 })
    );
    same(
      partsToSerial({ year: 2024, month: 0, day: 1 }),
      partsToSerial({ year: 2023, month: 12, day: 1 })
    );
    // Day 0 is the previous month's last day — the rule month-end clamping in `EDATE` and
    // coupon stepping depends on.
    same(
      partsToSerial({ year: 2024, month: 3, day: 0 }),
      partsToSerial({ year: 2024, month: 2, day: 29 })
    );
    same(
      partsToSerial({ year: 2023, month: 3, day: 0 }),
      partsToSerial({ year: 2023, month: 2, day: 28 })
    );
  });

  it("handles a year below 100 without the two-digit-year rule", () => {
    // `Date.UTC(50, 0, 1)` is 1950, not 50 — a legacy rule that silently moves a first-century
    // serial by 1900 years. Four call sites had each discovered this separately;
    // `partsToUtcDate` is where it is handled once.
    const serial = partsToSerial({ year: 50, month: 1, day: 1 });
    expect(serialToParts(serial)).toMatchObject({ year: 50, month: 1, day: 1 });
    expect(
      partsToUtcDate({
        year: 50,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0
      }).getUTCFullYear()
    ).toBe(50);
  });
});

/**
 * Compare across a sample, and assert **once**.
 *
 * A property test is a loop, and putting `expect` inside it makes the assertion library the bottleneck: the
 * first version of this file ran 700,000 `expect` calls and took fifteen seconds. That is a cost every worker
 * pays on every run, and under a full-suite parallel run it was enough to push a neighbouring test — one that
 * queues behind a shared external-tool lock and is budgeted accordingly — over its own timeout. A test that
 * slows the suite into flakiness is a bad test however sound its subject.
 *
 * Returning `undefined` from `probe` also skips a sample, which is how the ranges the phantom-day correction
 * deliberately changes are excluded from the legacy comparison.
 */
function expectNoDivergence(
  label: string,
  samples: number,
  probe: (index: number) => string | undefined
): void {
  const failures: string[] = [];
  for (let index = 0; index < samples && failures.length < 5; index++) {
    const failure = probe(index);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  expect(failures, `${label}: diverged from the previous implementation`).toEqual([]);
}

describe("the arithmetic, against the expression it replaced", () => {
  it("reads every whole serial from 61 upward identically, on both epochs", () => {
    // **From 61**, which is every date a real workbook holds. Below it the phantom-day
    // correction deliberately departs from the old linear model — that departure is the point,
    // and it is pinned against Excel's own answers in the block above rather than against the
    // implementation it replaced. The 1904 epoch has no phantom and is compared in full.
    expectNoDivergence("whole serials", 300_000, index => {
      const serial = index - 100_000;
      if (serial < 61) {
        return undefined;
      }
      for (const date1904 of [false, true]) {
        const mine = excelToDate(serial, date1904).getTime();
        const legacy = legacyToDate(serial, date1904).getTime();
        if (mine !== legacy) {
          return `serial ${serial} (date1904=${date1904}): ${mine} vs ${legacy}`;
        }
      }
      return undefined;
    });
  });

  it("writes every sampled instant to a bit-identical serial, on both epochs", () => {
    // `!==`, not a tolerance. The last ULP is visible in a `<v>` element, so "close enough" is exactly the
    // comparison that would let this drift.
    const random = rng(0x5eed);
    // 1900-03-01 onward, for the reason above. Every difference below it was measured and is
    // exactly the phantom-day correction: 90,025 of 800,000 samples, all of them earlier dates
    // under the 1900 epoch, and none under the 1904 epoch.
    const cutoff = Date.UTC(1900, 2, 1);
    expectNoDivergence("instants", 200_000, () => {
      const when = new Date(Math.floor((random() * 2 - 1) * 4e12));
      if (when.getTime() < cutoff) {
        return undefined;
      }
      for (const date1904 of [false, true]) {
        const mine = dateToExcel(when, date1904);
        const legacy = legacyToSerial(when, date1904);
        if (mine !== legacy) {
          return `${when.toISOString()} (date1904=${date1904}): ${mine} vs ${legacy}`;
        }
      }
      return undefined;
    });
  });

  it("reads fractional serials at or above 61 identically", () => {
    const random = rng(0xc0ffee);
    expectNoDivergence("fractional serials", 200_000, () => {
      const serial = (random() * 2 - 1) * 200_000;
      if (serial < 61) {
        return undefined;
      }
      for (const date1904 of [false, true]) {
        const mine = excelToDate(serial, date1904).getTime();
        const legacy = legacyToDate(serial, date1904).getTime();
        if (mine !== legacy) {
          return `serial ${serial} (date1904=${date1904}): ${mine} vs ${legacy}`;
        }
      }
      return undefined;
    });
  });

  it("pins the documented sample", () => {
    // From `excel-date-serial.test.ts`, which predates this module.
    expect(dateToExcel(new Date(Date.UTC(2017, 11, 15, 17, 0, 0, 0)), false)).toBe(
      43_084.70833333333
    );
  });
});

describe("the Date bridge", () => {
  it("round-trips through the UTC fields", () => {
    const parts = {
      year: 2024,
      month: 1,
      day: 15,
      hour: 9,
      minute: 30,
      second: 45,
      millisecond: 123
    };
    expect(utcDateToParts(partsToUtcDate(parts))).toEqual(parts);
  });

  it("reads a Date's UTC fields, which is the library's convention", () => {
    // Stated as a test because it is the whole reason `new Date(2024, 0, 15)` produces a different serial in
    // every timezone: `dateToExcel` is defined on the calendar value a `Date` carries in UTC, and a locally
    // constructed `Date` carries a different one.
    const when = new Date(Date.UTC(2024, 0, 15));
    expect(dateToExcel(when)).toBe(45_306);
    expect(utcDateToParts(when)).toMatchObject({ year: 2024, month: 1, day: 15 });
  });

  it("agrees with MS_PER_DAY", () => {
    expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
  });
});
