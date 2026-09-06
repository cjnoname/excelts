import { encodeHeaderFooter } from "@excel/xlsb/header-footer";
import { describe, expect, it } from "vitest";

/**
 * `fDifferentOddEven` and `fDifferentFirst` follow the model, and `!== undefined` is not how you ask.
 *
 * The XLSX reader fills every unused header/footer slot with `null` rather than leaving it absent, so a test for
 * `evenHeader !== undefined` was true for a workbook that has only an odd header — and both flags were set on every
 * sheet with a header at all. Excel writes `0x000c` for those, with both clear.
 *
 * The flags are not decoration: with `fDifferentFirst` set and no first-page header to go with it, the odd-page header
 * prints on page one.
 */
const FLAGS = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint16(0, true);
const DIFFERENT_ODD_EVEN = 0x0001;
const DIFFERENT_FIRST = 0x0002;
/** `fScaleWithDoc | fAlignMargins`, which Excel sets on every reference sheet. */
const DEFAULT = 0x000c;

describe("BrtBeginHeaderFooter flags", () => {
  it("leaves both flags clear for an odd-only header, as the reader produces it", async () => {
    // The exact shape a read gives: nulls rather than absent keys.
    const flags = FLAGS(
      encodeHeaderFooter({
        oddHeader: "&LLeft&CMiddle&RRight",
        oddFooter: "&CPage &P of &N",
        evenHeader: null,
        evenFooter: null,
        firstHeader: null,
        firstFooter: null,
        differentFirst: false,
        differentOddEven: false
      } as never)
    );
    expect(flags).toBe(DEFAULT);
  });

  it("sets fDifferentOddEven when the model says so", async () => {
    const flags = FLAGS(
      encodeHeaderFooter({ oddHeader: "odd", evenHeader: "even", differentOddEven: true } as never)
    );
    expect(flags & DIFFERENT_ODD_EVEN).toBe(DIFFERENT_ODD_EVEN);
  });

  it("sets fDifferentFirst when the model says so", async () => {
    const flags = FLAGS(
      encodeHeaderFooter({ oddHeader: "odd", firstHeader: "first", differentFirst: true } as never)
    );
    expect(flags & DIFFERENT_FIRST).toBe(DIFFERENT_FIRST);
  });

  it("falls back to the strings for a model built by hand", async () => {
    // A caller who sets `evenHeader` without the boolean still means it — the booleans are the answer only where the
    // model states them.
    const flags = FLAGS(encodeHeaderFooter({ oddHeader: "odd", evenHeader: "even" } as never));
    expect(flags & DIFFERENT_ODD_EVEN).toBe(DIFFERENT_ODD_EVEN);
  });

  it("treats an empty string as absent", async () => {
    const flags = FLAGS(encodeHeaderFooter({ oddHeader: "odd", evenHeader: "" } as never));
    expect(flags).toBe(DEFAULT);
  });
});
