/**
 * Dates as calendar values: the Temporal surface, the parts surface, and the timezone bug both exist to fix.
 *
 * **The bug this file is really about.** `Cell.setValue(sheet, "A1", new Date(2024, 0, 15))` — a locally
 * constructed `Date`, which is the form nearly every JavaScript programmer writes — stores a different serial in
 * every timezone, because a `Date` is an instant and the library reads it as a calendar value through its UTC
 * fields. In UTC+8 the cell becomes 2024-01-14 16:00. The convention is right and documented, but it is
 * unwritable in a type and so unguessable at the call site.
 *
 * That failure was invisible to this suite for a structural reason worth naming: every CI runner is UTC, and
 * `excel-date-serial.test.ts` fed only `Date.UTC(...)` inputs. A test that constructs its inputs the same way the
 * implementation reads them cannot detect a disagreement about which reading is meant. So the assertions below
 * run under {@link ZONES} — one east of UTC, one west, and one past the date line — and the ones that matter are
 * about *invariance*: the same call must produce the same cell everywhere.
 *
 * The Temporal blocks are skipped where the runtime has no `Temporal`, which is every supported version below
 * Node 26 and every Safari. The parts blocks are not skipped anywhere, which is the point of their existing.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook, Worksheet } from "@excel";
import type { ExcelDateTimeParts } from "@excel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Present on Node 26+, Chrome 144+, Firefox 139+, Bun 1.4+, Deno 2.7+ — and nowhere else this package supports. */
const temporal = (globalThis as { Temporal?: typeof globalThis.Temporal }).Temporal;
const withTemporal = temporal !== undefined;

/**
 * Offsets chosen so a bug shows up rather than cancels.
 *
 * UTC is the control and is the only one CI ever ran; `Asia/Shanghai` is far enough east that a UTC-midnight
 * value falls on the previous local day; `America/New_York` is the mirror image; `Pacific/Kiritimati` is +14 and
 * catches an off-by-one that +8 happens to survive.
 */
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

/** A fresh single-sheet workbook. */
function sheet(): ReturnType<typeof Workbook.addWorksheet> {
  return Workbook.addWorksheet(Workbook.create(), "S");
}

/** Write, serialise, read back — so an assertion is about the *file*, not about the in-memory model. */
async function roundTrip(
  build: (ws: ReturnType<typeof Workbook.addWorksheet>) => void
): Promise<ReturnType<typeof Workbook.addWorksheet>> {
  const workbook = Workbook.create();
  build(Workbook.addWorksheet(workbook, "S"));
  const bytes = await Workbook.toBuffer(workbook);
  const reopened = Workbook.create();
  await Workbook.read(reopened, bytes);
  return Workbook.getWorksheet(reopened, "S")!;
}

describe("Cell.getDateParts / Cell.setDateParts", () => {
  it("round-trips a date, a time and a date-time through a real file", async () => {
    const ws = await roundTrip(s => {
      Cell.setDateParts(s, "A1", { year: 2024, month: 1, day: 15 });
      Cell.setDateParts(s, "A2", { hour: 9, minute: 30, second: 45, millisecond: 123 }, "time");
      Cell.setDateParts(s, "A3", {
        year: 2024,
        month: 1,
        day: 15,
        hour: 9,
        minute: 30,
        second: 45
      });
    });
    expect(Cell.getDateParts(ws, "A1")).toEqual({
      year: 2024,
      month: 1,
      day: 15,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0
    });
    expect(Cell.getDateParts(ws, "A2")).toMatchObject({
      hour: 9,
      minute: 30,
      second: 45,
      millisecond: 123
    });
    expect(Cell.getDateParts(ws, "A3")).toMatchObject({
      year: 2024,
      month: 1,
      day: 15,
      hour: 9,
      minute: 30,
      second: 45
    });
  });

  it("recovers the kind from the number format, which is the only place it is stored", async () => {
    const ws = await roundTrip(s => {
      Cell.setDateParts(s, "A1", { year: 2024, month: 1, day: 15 });
      Cell.setDateParts(s, "A2", { hour: 9, minute: 30 }, "time");
      Cell.setDateParts(s, "A3", { year: 2024, month: 1, day: 15, hour: 9 });
    });
    expect(Cell.getDateKind(ws, "A1")).toBe("date");
    expect(Cell.getDateKind(ws, "A2")).toBe("time");
    expect(Cell.getDateKind(ws, "A3")).toBe("dateTime");
  });

  it("reports undefined for a cell holding no date", () => {
    const ws = sheet();
    Cell.setValue(ws, "A1", 42);
    Cell.setValue(ws, "A2", "text");
    expect(Cell.getDateParts(ws, "A1")).toBeUndefined();
    expect(Cell.getDateKind(ws, "A2")).toBeUndefined();
    expect(Cell.getDateParts(ws, "B9")).toBeUndefined();
  });

  it("does not overrule a number format the caller set", () => {
    const ws = sheet();
    Cell.setNumFmt(ws, "A1", "dddd");
    Cell.setDateParts(ws, "A1", { year: 2024, month: 1, day: 15 });
    expect(Cell.getNumFmt(ws, "A1")).toBe("dddd");
  });

  it("takes the (row, col) form as well as an address", () => {
    // Both `Cell` addressing forms, on all four new functions. `setDateParts` carries an extra optional
    // argument after the value, so its overload resolution is the one that could plausibly mis-dispatch — a
    // `kind` read as a column, or the parts read as a row.
    const ws = sheet();
    Cell.setDateParts(ws, 1, 2, { year: 2024, month: 6, day: 1 });
    Cell.setDateParts(ws, 2, 2, { hour: 14, minute: 45 }, "time");
    expect(Cell.getDateParts(ws, 1, 2)).toMatchObject({ year: 2024, month: 6, day: 1 });
    expect(Cell.getDateParts(ws, 1, 2)).toEqual(Cell.getDateParts(ws, "B1"));
    expect(Cell.getDateKind(ws, 1, 2)).toBe("date");
    expect(Cell.getDateParts(ws, 2, 2)).toMatchObject({ hour: 14, minute: 45 });
    expect(Cell.getDateKind(ws, 2, 2)).toBe("time");
    if (withTemporal) {
      expect(String(Cell.getTemporal(ws, 2, 2))).toBe("14:45:00");
      expect(String(Cell.getTemporal(ws, 1, 2))).toBe(String(Cell.getTemporal(ws, "B1")));
    }
  });

  it.each(ZONES)("produces the same cell in %s", async zone => {
    process.env.TZ = zone;
    const ws = await roundTrip(s => {
      Cell.setDateParts(s, "A1", { year: 2024, month: 1, day: 15 });
      Cell.setDateParts(s, "A2", { hour: 9, minute: 30 }, "time");
    });
    // Invariance, not a value: the failure being guarded against is a *difference* between timezones.
    expect(Cell.getDateParts(ws, "A1")).toMatchObject({ year: 2024, month: 1, day: 15, hour: 0 });
    expect(Cell.getDateParts(ws, "A2")).toMatchObject({ hour: 9, minute: 30 });
  });

  it.each(ZONES)("reads a UTC-built Date identically in %s", async zone => {
    process.env.TZ = zone;
    const ws = await roundTrip(s => {
      Cell.setValue(s, "A1", new Date(Date.UTC(2024, 0, 15)));
    });
    // The documented correct way to pass a `Date`. It must not depend on where it is run — this is the
    // assertion the previous suite made, and it is kept because it is the one that still has to hold.
    expect(Cell.getDateParts(ws, "A1")).toMatchObject({ year: 2024, month: 1, day: 15 });
  });
});

describe("Cell.setValue with a Temporal Plain value", () => {
  it.skipIf(!withTemporal)(
    "stores each of the three kinds with a matching number format",
    async () => {
      const ws = await roundTrip(s => {
        Cell.setValue(s, "A1", temporal!.PlainDate.from("2024-01-15"));
        Cell.setValue(s, "A2", temporal!.PlainTime.from("09:30:45"));
        Cell.setValue(s, "A3", temporal!.PlainDateTime.from("2024-01-15T09:30:45"));
      });
      expect(Cell.getDateKind(ws, "A1")).toBe("date");
      expect(Cell.getDateKind(ws, "A2")).toBe("time");
      expect(Cell.getDateKind(ws, "A3")).toBe("dateTime");
      // The second thing `Date` could not express: without this a time-of-day renders as `12-30-1899`.
      expect(Cell.getDisplayText(ws, "A2")).toBe("09:30:45");
    }
  );

  it.skipIf(!withTemporal)("round-trips each kind back to its own type", async () => {
    const ws = await roundTrip(s => {
      Cell.setValue(s, "A1", temporal!.PlainDate.from("2024-01-15"));
      Cell.setValue(s, "A2", temporal!.PlainTime.from("09:30:45.123"));
      Cell.setValue(s, "A3", temporal!.PlainDateTime.from("2024-01-15T09:30:45"));
    });
    expect(String(Cell.getTemporal(ws, "A1"))).toBe("2024-01-15");
    expect(String(Cell.getTemporal(ws, "A2"))).toBe("09:30:45.123");
    expect(String(Cell.getTemporal(ws, "A3"))).toBe("2024-01-15T09:30:45");
  });

  it.skipIf(!withTemporal)("keeps `Cell.getValue` returning a Date", () => {
    // `CellValue` was deliberately not widened, so no consumer's exhaustive `switch` can break and nothing
    // downstream — the writers, the chart cache, the formula capture — has to learn a second representation.
    const ws = sheet();
    Cell.setValue(ws, "A1", temporal!.PlainDate.from("2024-01-15"));
    expect(Cell.getValue(ws, "A1")).toBeInstanceOf(Date);
    expect((Cell.getValue(ws, "A1") as Date).toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  it.skipIf(!withTemporal)(
    "re-anchors a non-ISO calendar rather than reading its fields",
    async () => {
      // `PlainDate.from({ …, calendar: "hebrew" })` reports year 5784 for what ISO calls 2024. An Excel serial
      // counts proleptic Gregorian days and has no calendar, so reading the fields directly would store a date
      // 3,760 years out.
      const hebrew = temporal!.PlainDate.from({ year: 5784, month: 5, day: 5, calendar: "hebrew" });
      const ws = await roundTrip(s => Cell.setValue(s, "A1", hebrew));
      expect(Cell.getDateParts(ws, "A1")).toMatchObject({ year: 2024, month: 1, day: 15 });
    }
  );

  it.skipIf(!withTemporal)("rounds sub-millisecond precision away", () => {
    // A float64 serial resolves to about a microsecond near the present, and Excel works in whole
    // milliseconds. Rounding rather than throwing, because a `PlainTime` off a clock has nanoseconds.
    const ws = sheet();
    Cell.setValue(ws, "A1", temporal!.PlainTime.from("09:30:45.1236"));
    expect(Cell.getDateParts(ws, "A1")).toMatchObject({ millisecond: 124 });
  });

  it.skipIf(!withTemporal)(
    "refuses a value that is an instant, naming the call that fixes it",
    () => {
      const ws = sheet();
      for (const value of [temporal!.Now.instant(), temporal!.Now.zonedDateTimeISO()]) {
        // Rejected rather than flattened against a guessed timezone — which is the exact ambiguity this whole
        // surface exists to remove, so re-introducing it here would be self-defeating.
        expect(() => Cell.setValue(ws, "A1", value as never)).toThrow(/toPlainDateTime/);
      }
      expect(() =>
        Cell.setValue(ws, "A1", temporal!.PlainYearMonth.from("2024-01") as never)
      ).toThrow(/toPlainDate/);
      expect(() => Cell.setValue(ws, "A1", temporal!.Duration.from({ days: 1 }) as never)).toThrow(
        /Duration/
      );
    }
  );

  it.each(ZONES)("stores the same serial in %s", async zone => {
    if (!withTemporal) {
      return;
    }
    process.env.TZ = zone;
    const ws = await roundTrip(s => Cell.setValue(s, "A1", temporal!.PlainDate.from("2024-01-15")));
    // The headline claim: a `PlainDate` cannot be misread, because it is not an instant and has nothing for a
    // timezone to act on.
    expect(Cell.getDateParts(ws, "A1")).toMatchObject({ year: 2024, month: 1, day: 15, hour: 0 });
  });
});

describe("Cell.getTemporal where Temporal is absent", () => {
  it.skipIf(withTemporal)("refuses by name and points at the parts API", () => {
    const ws = sheet();
    Cell.setValue(ws, "A1", new Date(Date.UTC(2024, 0, 15)));
    // A return type that silently changes with the runtime would be worse than a refusal, so this throws
    // rather than handing back a `Date`.
    expect(() => Cell.getTemporal(ws, "A1")).toThrow(/getDateParts/);
    // And the runtime-independent half keeps working, which is why it is the primitive.
    const parts: ExcelDateTimeParts | undefined = Cell.getDateParts(ws, "A1");
    expect(parts).toMatchObject({ year: 2024, month: 1, day: 15 });
  });
});

describe("the interaction with the rest of the sheet", () => {
  it("leaves a formula cell's cached date reachable through getDateParts", () => {
    const ws = sheet();
    Cell.setValue(ws, "A1", { formula: "TODAY()", result: new Date(Date.UTC(2024, 0, 15)) });
    expect(Cell.getDateParts(ws, "A1")).toMatchObject({ year: 2024, month: 1, day: 15 });
  });

  it("keeps a Temporal value out of the model that other readers see", async () => {
    if (!withTemporal) {
      return;
    }
    // Normalised at the door in `DateValue`, so `Worksheet.getValues` and every writer keep seeing a `Date`
    // and nothing had to learn a second representation.
    const ws = sheet();
    Cell.setValue(ws, "A1", temporal!.PlainDate.from("2024-01-15"));
    expect((Worksheet.getValues(ws) as unknown[][])[1]![1]).toBeInstanceOf(Date);
  });
});

describe("a time of day under the 1904 date system", () => {
  /** One time-only cell in a workbook of the requested epoch, as the serial actually written. */
  async function timeSerial(
    date1904: boolean,
    write: (ws: ReturnType<typeof Workbook.addWorksheet>) => void
  ): Promise<number> {
    const workbook = Workbook.create();
    (workbook as { properties?: Record<string, unknown> }).properties = {
      ...((workbook as { properties?: Record<string, unknown> }).properties ?? {}),
      date1904
    };
    write(Workbook.addWorksheet(workbook, "S"));
    const parts = await extractAll(await Workbook.toBuffer(workbook));
    const path = [...parts.keys()].find(name => name.endsWith("sheet1.xml"))!;
    const xml = new TextDecoder().decode(parts.get(path)!.data);
    return Number(/<c r="A1"[^>]*>\s*<v>([^<]+)<\/v>/.exec(xml)![1]);
  }

  it.each([false, true])(
    "writes a bare fraction of a day, not a negative serial, at date1904=%s",
    async date1904 => {
      // **A time of day is the remainder after serial 0, and serial 0 is a *different calendar date* in the two
      // systems** — 1899-12-30 against 1904-01-01. Anchoring every time at 1899-12-30 put `-1461.6` in a 1904
      // workbook, which Excel renders as `########`. It round-tripped through this library regardless: the
      // reader applied the same epoch and a time-only format takes the fraction anyway. Only the file was
      // wrong, so only an assertion on the file could see it.
      if (withTemporal) {
        expect(
          await timeSerial(date1904, ws =>
            Cell.setValue(ws, "A1", temporal!.PlainTime.from("09:30"))
          )
        ).toBeCloseTo(0.395833, 5);
      }
      expect(
        await timeSerial(date1904, ws =>
          Cell.setDateParts(ws, "A1", { hour: 9, minute: 30 }, "time")
        )
      ).toBeCloseTo(0.395833, 5);
    }
  );

  it.each([false, true])("still round-trips the time at date1904=%s", async date1904 => {
    const workbook = Workbook.create();
    (workbook as { properties?: Record<string, unknown> }).properties = {
      ...((workbook as { properties?: Record<string, unknown> }).properties ?? {}),
      date1904
    };
    Cell.setDateParts(Workbook.addWorksheet(workbook, "S"), "A1", { hour: 9, minute: 30 }, "time");
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook));
    const ws = Workbook.getWorksheet(reopened, "S")!;
    expect(Cell.getDateParts(ws, "A1")).toMatchObject({ hour: 9, minute: 30 });
    expect(Cell.getDateKind(ws, "A1")).toBe("time");
  });
});

describe("recognising a Temporal value", () => {
  it.skipIf(!withTemporal)("accepts a real one by brand", () => {
    const ws = sheet();
    Cell.setValue(ws, "A1", temporal!.PlainDate.from("2024-01-15"));
    expect(Cell.getDateKind(ws, "A1")).toBe("date");
  });

  it.each(["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"])(
    "does not mistake an object tagged %s for a Temporal value",
    tag => {
      // **`tag in ACCEPTED` walked the prototype chain.** Every one of these answered `true` on an object
      // literal, and the lookup then returned `Object.prototype.constructor` — a function — where a
      // `TemporalKind` was expected. The tables are `Map`s now, which have no inherited keys.
      const ws = sheet();
      Cell.setValue(ws, "A1", {
        [Symbol.toStringTag]: tag,
        year: 2024,
        month: 1,
        day: 15
      } as never);
      expect(Cell.getDateParts(ws, "A1")).toBeUndefined();
    }
  );

  it("still stores a bare tagged object as JSON, as it did before", () => {
    // The compatibility guarantee behind widening `CellValueInput`: recognition requires the *shape* as well
    // as the tag, so an existing value that merely carries a matching tag is not reinterpreted.
    const ws = sheet();
    Cell.setValue(ws, "A1", {
      [Symbol.toStringTag]: "Temporal.PlainDate",
      label: "not a date"
    } as never);
    expect(Cell.getDateParts(ws, "A1")).toBeUndefined();
  });

  it("does not throw when the tag getter throws", () => {
    // A value that cannot be interrogated is simply not a Temporal value. Before, the getter ran uncaught
    // inside `setValue` and turned a previously storable object into an exception.
    const hostile = Object.defineProperty({}, Symbol.toStringTag, {
      get() {
        throw new Error("hostile");
      }
    });
    const ws = sheet();
    expect(() => Cell.setValue(ws, "A1", hostile as never)).not.toThrow();
  });
});

describe("the kinds a number format can describe", () => {
  /** A cell holding a date, wearing the given format. */
  function formatted(numFmt: string): ReturnType<typeof Workbook.addWorksheet> {
    const ws = sheet();
    Cell.setValue(ws, "A1", new Date(Date.UTC(2024, 0, 15, 12)));
    Cell.setNumFmt(ws, "A1", numFmt);
    return ws;
  }

  it.each([
    { numFmt: "yyyy-mm-dd", kind: "date" },
    { numFmt: "hh:mm:ss", kind: "time" },
    { numFmt: "yyyy-mm-dd hh:mm", kind: "dateTime" },
    { numFmt: "mmm-yy", kind: "date" },
    // `[hh]` and friends, not just `[h]`. The single-character pattern let `[hh]:mm` through to the date
    // tests, where a bare `:mm` left after stripping the bracket read as a *month* — so an elapsed-time
    // format was reported as a date.
    { numFmt: "[h]:mm", kind: "duration" },
    { numFmt: "[hh]:mm", kind: "duration" },
    { numFmt: "[mm]:ss", kind: "duration" },
    // Only the first section describes a positive value; `";;;dd"` hides everything and is not a date.
    { numFmt: ";;;dd", kind: "unknown" },
    // A backslash escapes the next character, so this is a literal `d` and a number.
    { numFmt: "\\d0", kind: "unknown" },
    { numFmt: "0.00", kind: "unknown" },
    { numFmt: "General", kind: "unknown" }
  ])("reports $numFmt as $kind", ({ numFmt, kind }) => {
    expect(Cell.getDateKind(formatted(numFmt), "A1")).toBe(kind);
  });

  it("refuses to invent a civil value for an elapsed-time cell", () => {
    // Serial 1.5 under `[h]:mm:ss` means thirty-six hours. Reporting a `PlainDateTime` in 1899 for it was
    // worse than refusing, because it looked like an answer.
    const ws = formatted("[h]:mm:ss");
    expect(() => Cell.getTemporal(ws, "A1")).toThrow(/elapsed/);
    // The parts still work, and an explicit kind overrides the refusal.
    expect(Cell.getDateParts(ws, "A1")).toBeDefined();
    if (withTemporal) {
      expect(String(Cell.getTemporal(ws, "A1", "time"))).toBe("12:00:00");
    }
  });

  it.skipIf(!withTemporal)(
    "reads an unformatted date cell as a date-time, and says it is guessing",
    () => {
      const ws = sheet();
      Cell.setValue(ws, "A1", new Date(Date.UTC(2024, 0, 15, 12)));
      expect(Cell.getDateKind(ws, "A1")).toBe("unknown");
      expect(String(Cell.getTemporal(ws, "A1"))).toBe("2024-01-15T12:00:00");
      expect(String(Cell.getTemporal(ws, "A1", "date"))).toBe("2024-01-15");
    }
  );
});

describe("Cell.setDateParts validates instead of carrying", () => {
  it.each([
    { label: "no fields at all", parts: {}, message: /no fields given/ },
    {
      label: "a day past the month end",
      parts: { year: 2024, month: 2, day: 31 },
      message: /29 days/
    },
    {
      label: "month 13",
      parts: { year: 2024, month: 13, day: 1 },
      message: /month must be between/
    },
    { label: "day 0", parts: { year: 2024, month: 1, day: 0 }, message: /day must be between/ },
    {
      label: "hour 99",
      parts: { year: 2024, month: 1, day: 1, hour: 99 },
      message: /hour must be between/
    },
    { label: "NaN", parts: { year: Number.NaN, month: 1, day: 1 }, message: /must be an integer/ },
    { label: "a date with no year", parts: { month: 2, day: 1 }, message: /needs a year/ }
  ])("rejects $label", ({ parts, message }) => {
    // `partsToSerial` carries these, because `EDATE` and coupon stepping need it to. A public setter
    // inheriting that meant 2024-02-31 silently became March 2 and `NaN` wrote a workbook Excel cannot open.
    expect(() => Cell.setDateParts(sheet(), "A1", parts)).toThrow(message);
  });

  it("accepts a real leap day", () => {
    expect(() => Cell.setDateParts(sheet(), "A1", { year: 2024, month: 2, day: 29 })).not.toThrow();
    expect(Cell.getDateParts(sheet(), "A1")).toBeUndefined();
  });
});

describe("Excel's fictitious 1900-02-29", () => {
  it("is refused by the setter, rather than silently stored as March 1", () => {
    // Serial 60 exists in the file format, and `@utils/excel-serial` models it — but a cell's value is a
    // `Date`, and no `Date` names that day. Accepting it would store 1900-03-01, i.e. serial 61, and report
    // success. Refusing names the limit instead of hiding it.
    expect(() => Cell.setDateParts(sheet(), "A1", { year: 1900, month: 2, day: 29 })).toThrow(
      /fictitious leap day/
    );
  });

  it("is still read correctly by the formula engine, which works on serials", async () => {
    // The distinction the parts model exists to make. `MONTH`/`DAY` read `ExcelDateTimeParts` and never build
    // a `Date`, so they give Excel's own answers where the cell model cannot.
    const { fnDAY, fnMONTH, fnYEAR } = await import("@formula/functions/date");
    const serial = { kind: 1, value: 60 } as never;
    expect((fnYEAR([serial]) as { value: number }).value).toBe(1900);
    expect((fnMONTH([serial]) as { value: number }).value).toBe(2);
    expect((fnDAY([serial]) as { value: number }).value).toBe(29);
  });

  it("leaves its neighbours on Excel's own serials", () => {
    const ws = sheet();
    Cell.setDateParts(ws, "A1", { year: 1900, month: 2, day: 28 });
    Cell.setDateParts(ws, "A2", { year: 1900, month: 3, day: 1 });
    expect(Cell.getDateParts(ws, "A1")).toMatchObject({ year: 1900, month: 2, day: 28 });
    expect(Cell.getDateParts(ws, "A2")).toMatchObject({ year: 1900, month: 3, day: 1 });
  });
});

describe("sub-millisecond precision at the top of the day", () => {
  it.skipIf(!withTemporal)(
    "wraps a PlainTime rather than overflowing into the next day",
    async () => {
      // `23:59:59.999999999` rounds to 86,400,000 ms. Added straight onto the millisecond field it produced
      // `millisecond: 1000`, which is not a millisecond — and a `PlainTime` built from it carried into the
      // next day and was written as serial 1 instead of a fraction below 1.
      const ws = await roundTrip(s =>
        Cell.setValue(s, "A1", temporal!.PlainTime.from("23:59:59.999999999"))
      );
      expect(Cell.getDateParts(ws, "A1")).toMatchObject({
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0
      });
    }
  );

  it.skipIf(!withTemporal)(
    "carries the day for a PlainDateTime, where there is a day to carry",
    async () => {
      const ws = await roundTrip(s =>
        Cell.setValue(s, "A1", temporal!.PlainDateTime.from("2024-01-15T23:59:59.999999999"))
      );
      expect(Cell.getDateParts(ws, "A1")).toMatchObject({ year: 2024, month: 1, day: 16, hour: 0 });
    }
  );
});
