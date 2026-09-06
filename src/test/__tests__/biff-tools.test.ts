/**
 * The BIFF12 disassembler and fixture builder, tested against each other.
 *
 * These two are the tools every later test will trust, so they get the same
 * treatment `svg-geometry.test.ts` gives its extractor: pairs that must describe
 * *identically* and pairs that must describe *differently*. A describer that
 * collapses a real difference is worse than no describer, because it makes a
 * broken stream look correct.
 *
 * The direction that matters most here is the second one. This is a
 * disassembler, not a semantic view: it must not hide the difference between two
 * encodings of the same value, because choosing between those encodings is
 * exactly what a writer does and exactly what a reader has to survive.
 */

import { encodeBiffRecord, encodeBiffRecords } from "@excel/xlsb/binary";
import { requireRecordSpec } from "@excel/xlsb/spec/records";
import { describeBiffStream, hexdump } from "@test/biff-dump";
import {
  appendGarbage,
  biff,
  overstateLength,
  patchField,
  removeRecord,
  truncateAfter,
  truncateInside
} from "@test/biff-fixture";
import { describe, expect, it } from "vitest";

const SHEET = [
  ["BrtBeginSheet"],
  ["BrtWsDim", { ref: { firstRow: 0, lastRow: 2, firstColumn: 0, lastColumn: 3 } }],
  ["BrtBeginSheetData"],
  ["BrtRowHdr", { rw: 0, ixfe: 0, miyRw: 300, ascDsc: 0, flags: 0, phShow: 0 }],
  ["BrtCellIsst", { cell: { column: 0, styleIndex: 1 }, isst: 0 }],
  ["BrtEndSheetData"],
  ["BrtEndSheet"]
] as const;

describe("biff() fixture builder", () => {
  it("produces the framing the record table describes", () => {
    // One record, checked byte for byte, so the DSL is anchored to literal output
    // rather than only to the disassembler's reading of it.
    expect(biff([["BrtBeginSheet"]])).toEqual(Uint8Array.of(0x81, 0x01, 0x00));
    expect(
      biff([["BrtRowHdr", { rw: 1, ixfe: 0, miyRw: 0, ascDsc: 0, flags: 0, phShow: 0 }]])
      // 0x0D bytes of payload: `rw`, `ixfe`, `miyRw`, then the *three* flag bytes and `ccolspan`. Declaring
      // the first two flag bytes as one `u16` made it 0x0C and put `fUnsynced` in the wrong one.
    ).toEqual(Uint8Array.of(0x00, 0x0d, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  });

  it("is deterministic", () => {
    expect(biff(SHEET)).toEqual(biff(SHEET));
  });

  it("rejects a record name the table does not contain", () => {
    // A fixture must not be able to describe something the format does not have,
    // or a test can pass against an invented record.
    expect(() => biff([["BrtNotARecord"]])).toThrow(/unknown BIFF12 record name/);
  });

  it("rejects a field the record does not declare", () => {
    expect(() =>
      biff([["BrtRowHdr", { rw: 0, ixfe: 0, miyRw: 0, ascDsc: 0, flags: 0, nope: 1 }]])
    ).toThrow(/BrtRowHdr has no field nope/);
  });

  it("rejects a missing field rather than defaulting it", () => {
    // Defaulting would make a fixture quietly differ from what it appears to say.
    expect(() => biff([["BrtRowHdr", { rw: 0, ixfe: 0, miyRw: 0 }]])).toThrow(
      /BrtRowHdr\.ascDsc is missing/
    );
  });

  it("rejects a value of the wrong shape", () => {
    expect(() => biff([["BrtWsDim", { ref: 5 }]])).toThrow(/expects an object with firstRow/);
    expect(() =>
      biff([["BrtRowHdr", { rw: "x", ixfe: 0, miyRw: 0, ascDsc: 0, flags: 0, phShow: 0 }]])
    ).toThrow(/expects a number/);
  });

  it("requires bytes for a record whose layout is undeclared", () => {
    // `BrtShortRk`'s layout has not been established, so the table refuses to
    // pretend it knows the offsets.
    expect(() => biff([["BrtShortRk", { cell: { column: 0, styleIndex: 0 } }]])).toThrow(
      /no declared payload layout/
    );
    expect(biff([["BrtShortRk", Uint8Array.of(1, 2)]])).toEqual(
      Uint8Array.of(0x0d, 0x02, 0x01, 0x02)
    );
  });
});

describe("describeBiffStream — pairs that must describe identically", () => {
  it("ignores where a record sits in the buffer", () => {
    // The same record described from a subarray must read the same, or every test
    // built on a slice is unsound.
    const stream = biff(SHEET);
    const padded = new Uint8Array(stream.length + 8);
    padded.set(stream, 8);
    expect(describeBiffStream(padded.subarray(8))).toBe(describeBiffStream(stream));
  });

  it("ignores the varint width used for an id or a length", () => {
    // 0x81 needs two bytes; 0x01 needs one. Same record shape, same description.
    const oneByteId = encodeBiffRecord(0x01, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0));
    expect(describeBiffStream(oneByteId)).toBe("BrtCellBlank cell=col=0,style=0");
  });

  it("describes a value the same however the fixture spelled it", () => {
    const viaFields = biff([["BrtCellIsst", { cell: { column: 2, styleIndex: 3 }, isst: 7 }]]);
    const viaBytes = biff([["BrtCellIsst", Uint8Array.of(2, 0, 0, 0, 3, 0, 0, 0, 7, 0, 0, 0)]]);
    expect(describeBiffStream(viaBytes)).toBe(describeBiffStream(viaFields));
  });

  it("ignores style flag bits above the 24-bit style index", () => {
    // Those bits are not part of the index, so two cells differing only there are
    // the same cell as far as a style reference goes.
    const plain = biff([["BrtCellBlank", Uint8Array.of(0, 0, 0, 0, 1, 0, 0, 0)]]);
    const flagged = biff([["BrtCellBlank", Uint8Array.of(0, 0, 0, 0, 1, 0, 0, 0x80)]]);
    expect(describeBiffStream(flagged)).toBe(describeBiffStream(plain));
  });
});

describe("describeBiffStream — pairs that must describe differently", () => {
  it("distinguishes two encodings of the same number", () => {
    // This is the property that makes it a disassembler. `BrtCellRk` and
    // `BrtCellReal` both hold 42; a describer that reported "42" for each would hide
    // the writer's choice, which is precisely what a round-trip needs to preserve.
    const rk = biff([["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (42 << 2) | 2 }]]);
    const real = biff([["BrtCellReal", { cell: { column: 0, styleIndex: 0 }, value: 42 }]]);
    expect(describeBiffStream(rk)).not.toBe(describeBiffStream(real));
    expect(describeBiffStream(rk)).toContain("BrtCellRk");
    expect(describeBiffStream(real)).toContain("BrtCellReal");
  });

  it("distinguishes a changed field value", () => {
    const stream = biff(SHEET);
    expect(describeBiffStream(patchField(stream, "BrtRowHdr", "rw", 5))).not.toBe(
      describeBiffStream(stream)
    );
  });

  it("distinguishes a changed nesting depth", () => {
    // Indentation is the point: an unbalanced pair shifts the whole tail, so the
    // description of a broken stream cannot coincide with a valid one.
    const stream = biff(SHEET);
    const unbalanced = removeRecord(stream, "BrtEndSheetData");
    expect(describeBiffStream(unbalanced)).not.toBe(describeBiffStream(stream));
    expect(describeBiffStream(stream)).toContain("  BrtEndSheetData");
  });

  it("distinguishes a missing record from a present one", () => {
    const stream = biff(SHEET);
    expect(describeBiffStream(removeRecord(stream, "BrtWsDim"))).not.toBe(
      describeBiffStream(stream)
    );
  });

  it("distinguishes trailing bytes it did not decode", () => {
    const short = biff([["BrtCellBlank", Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0)]]);
    const long = biff([["BrtCellBlank", Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 9, 9)]]);
    expect(describeBiffStream(long)).not.toBe(describeBiffStream(short));
    expect(describeBiffStream(long)).toContain("+2 byte(s)");
  });
});

describe("describeBiffStream — honesty about what it decoded", () => {
  it("shows hex for a record whose layout is undeclared, not an invented reading", () => {
    expect(describeBiffStream(biff([["BrtShortRk", Uint8Array.of(0xde, 0xad)]]))).toBe(
      "BrtShortRk <de ad>"
    );
  });

  it("names an unknown identifier as unknown", () => {
    // 0x0700 is not in the table. A guess here would be the start of a wrong reader.
    expect(describeBiffStream(encodeBiffRecord(0x0700, Uint8Array.of(1)))).toBe(
      "??? id=0x0700 <01>"
    );
  });

  it("summarises a long payload instead of becoming the output", () => {
    const described = describeBiffStream(encodeBiffRecord(0x0700, new Uint8Array(40_000)));
    expect(described).toMatch(/… 40000 byte\(s\)>$/);
    expect(described.length).toBeLessThan(120);
  });

  it("reports a payload shorter than its declared layout without throwing", () => {
    // Describing broken input is part of the job — this is the tool used to find out
    // why input is broken.
    const shortPayload = encodeBiffRecord(requireRecordSpec("BrtRowHdr").id, Uint8Array.of(1, 0));
    expect(describeBiffStream(shortPayload)).toBe("BrtRowHdr rw=<truncated>");
  });

  it("still throws when the framing itself is unreadable", () => {
    // A bad field is describable; a bad length means the walker cannot find the next
    // record at all, and pretending otherwise would invent records.
    expect(() => describeBiffStream(truncateInside(biff(SHEET), "BrtWsDim"))).toThrow(
      /declares 16 byte\(s\)/
    );
  });
});

describe("corruption helpers", () => {
  it("truncateAfter keeps everything up to and including the record", () => {
    const cut = truncateAfter(biff(SHEET), "BrtRowHdr");
    expect(describeBiffStream(cut).split("\n").at(-1)).toContain("BrtRowHdr");
  });

  it("truncateInside makes the record overrun the part", () => {
    expect(() => describeBiffStream(truncateInside(biff(SHEET), "BrtRowHdr"))).toThrow(
      // 13 bytes now that `BrtRowHdr`'s three flag bytes are declared separately, so 12 remain.
      /declares 13 byte\(s\), but only 12 remain/
    );
  });

  it("overstateLength leaves the payload but lies about its size", () => {
    expect(() => describeBiffStream(overstateLength(biff(SHEET), "BrtWsDim", 9999))).toThrow(
      /declares 9999 byte\(s\)/
    );
  });

  it("appendGarbage produces trailing bytes that are not a record", () => {
    // 0x80 is a continuation byte with nothing after it: an unterminated varint.
    expect(() => describeBiffStream(appendGarbage(biff(SHEET), Uint8Array.of(0x80)))).toThrow(
      /truncated record id/
    );
  });

  it("removeRecord and patchField refuse to act on a record that is absent", () => {
    const stream = biff(SHEET);
    expect(() => removeRecord(stream, "BrtCellReal")).toThrow(/contains no BrtCellReal/);
    expect(() => patchField(stream, "BrtCellReal", "value", 1)).toThrow(/contains no BrtCellReal/);
  });

  it("patchField preserves the record's length", () => {
    const stream = biff(SHEET);
    expect(patchField(stream, "BrtRowHdr", "miyRw", 480)).toHaveLength(stream.length);
  });
});

describe("hexdump", () => {
  it("marks the line containing the offset", () => {
    const dump = hexdump(biff(SHEET), 20, 48);
    const marked = dump.split("\n").filter(line => line.endsWith("<--"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatch(/^00000010 /);
  });

  it("aligns to a 16-byte boundary and renders printable ASCII", () => {
    const stream = encodeBiffRecords([{ id: 0x06, payload: new TextEncoder().encode("HELLO") }]);
    const dump = hexdump(stream, 0, 16);
    expect(dump).toMatch(/^00000000 /);
    expect(dump).toContain("HELLO");
  });
});
