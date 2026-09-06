/**
 * Number format codes: the built-in table, and the escapes that decide whether a code matches it.
 *
 * **Three defects stacked here, and the third cost a workbook its whole styles part.**
 *
 * 1. The built-in table was missing ids **41–44**, the accounting formats.
 * 2. The XLSX reader stripped every `\x` escape out of a `formatCode` on the way in, while the writer wrote the
 *    code back unchanged — a one-way loss that also changed what the code *means* (`\-` is a literal minus).
 * 3. Together those meant a workbook using an accounting format had it re-registered as a **custom** id 164+,
 *    and Excel answered `Removed Records: Style from /xl/styles.bin part (Styles)`: it discarded every named
 *    style in the file.
 *
 * The chain is what made this hard to see. Nothing was wrong with any *style*; the styles were discarded because
 * the formats they referenced had been turned into something Excel would not accept. So these tests assert the
 * two mechanical facts — the table's contents and the reader's fidelity — rather than the symptom.
 */
import { defaultNumFormats } from "@excel/xlsx/defaultnumformats";
import { NumFmtXform } from "@excel/xlsx/xform/style/numfmt-xform";
import { describe, expect, it } from "vitest";

/** The four accounting formats, exactly as Excel writes them — read out of a template Excel produced. */
const ACCOUNTING = {
  41: '_ * #,##0_ ;_ * \\-#,##0_ ;_ * "-"_ ;_ @_ ',
  42: '_ "￥"* #,##0_ ;_ "￥"* \\-#,##0_ ;_ "￥"* "-"_ ;_ @_ ',
  43: '_ * #,##0.00_ ;_ * \\-#,##0.00_ ;_ * "-"??_ ;_ @_ ',
  44: '_ "￥"* #,##0.00_ ;_ "￥"* \\-#,##0.00_ ;_ "￥"* "-"??_ ;_ @_ '
} as const;

describe("the built-in number format table", () => {
  it.each(Object.entries(ACCOUNTING))("carries id %s", (id, code) => {
    expect(defaultNumFormats[Number(id)]?.f).toBe(code);
  });

  it.each(Object.entries(ACCOUNTING))("resolves the code for id %s back to it", (id, code) => {
    // The lookup is by the *escaped* code, because that is what a file contains. A reader that unescapes first
    // will miss every one of these.
    expect(NumFmtXform.getDefaultFmtId(code)).toBe(Number(id));
  });

  it("does not resolve the same code with its escapes stripped", () => {
    // The negative half, and the one that names the defect: this is what the reader used to hand the lookup.
    const stripped = ACCOUNTING[41].replace(/\\(.)/g, "$1");
    expect(stripped).not.toBe(ACCOUNTING[41]);
    expect(NumFmtXform.getDefaultFmtId(stripped)).toBeUndefined();
  });
});

describe("a format code read out of a file", () => {
  it("keeps its backslash escapes", () => {
    const xform = new NumFmtXform();
    xform.parseOpen({
      name: "numFmt",
      attributes: { numFmtId: "41", formatCode: ACCOUNTING[41] }
    } as never);
    // Verbatim. A backslash escapes the character after it and is part of the code's meaning — unescaping
    // changes what the format *does*, not merely how it is spelled.
    expect((xform.model as { formatCode: string }).formatCode).toBe(ACCOUNTING[41]);
  });
});
