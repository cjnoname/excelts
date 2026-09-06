/**
 * AutoFilter criteria — the records nested inside `BrtBeginAFilter`.
 *
 * The record *order* here is not derived from the corpus, because no corpus workbook has a filter at all:
 * MS-XLSB section 3.4 is a byte-level worked example of this exact sequence, which is the authority pivot
 * tables lack. Each payload layout comes from its own record page, and the sizes are asserted against those
 * pages rather than against what this encoder happens to produce.
 */

import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { Workbook } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { filterCriteriaRecords } from "@excel/xlsb/filter-criteria";
import { recordSpec } from "@excel/xlsb/spec/records";
import { worksheetLosses } from "@excel/xlsb/write/losses";
import { describe, expect, it } from "vitest";

/** The `[name, payloadLength]` pairs a fragment produces, for asserting shape and nesting at once. */
function shapeOf(xml: string): [string, number][] {
  return filterCriteriaRecords(xml).records.map(([name, payload]) => [name, payload?.length ?? 0]);
}

/** A `DataView` over one record's payload, found by name. */
function payloadOf(xml: string, name: string): DataView {
  const found = filterCriteriaRecords(xml).records.find(([recordName]) => recordName === name);
  const payload = found?.[1];
  if (payload === undefined) {
    throw new Error(`no ${name} record was produced`);
  }
  return new DataView(payload.buffer, payload.byteOffset, payload.length);
}

describe("filterCriteriaRecords", () => {
  it("nests each criterion inside its own filter column, in the order MS-XLSB 3.4 gives", () => {
    // The whole sequence, checked as a sequence. A criterion emitted *after* `BrtEndFilterColumn` would be
    // at worksheet scope, belonging to nothing — and every individual record would still be well formed.
    expect(
      shapeOf(
        `<filterColumn colId="0"><filters><filter val="apple"/></filters></filterColumn>` +
          `<filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThan" val="5"/></customFilters></filterColumn>` +
          `<filterColumn colId="2"><top10 top="1" val="3" filterVal="7"/></filterColumn>`
      )
    ).toEqual([
      // `dwCol` + a flag word.
      ["BrtBeginFilterColumn", 6],
      // `fBlank` + four unused bytes.
      ["BrtBeginFilters", 8],
      // An `XLWideString`: a four-byte count then UTF-16, so "apple" is 4 + 10.
      ["BrtFilter", 14],
      ["BrtEndFilters", 0],
      ["BrtEndFilterColumn", 0],
      ["BrtBeginFilterColumn", 6],
      // `fAnd`.
      ["BrtBeginCustomFilters", 4],
      // `vts` + `grbitSgn` + the eight-byte union, with no trailing string for a numeric comparison.
      ["BrtCustomFilter", 10],
      ["BrtEndCustomFilters", 0],
      ["BrtEndFilterColumn", 0],
      ["BrtBeginFilterColumn", 6],
      // A flag byte, then `xNumValue` and `xNumFilter`.
      ["BrtTop10Filter", 17],
      ["BrtEndFilterColumn", 0]
    ]);
  });

  it("inverts fAnd, because the record and the XML disagree about which value means AND", () => {
    // MS-XLSB: 0x00000000 is AND and 0x00000001 is OR. The XML spells AND as `and="1"`. Writing the
    // attribute straight through swaps the two on every two-criterion filter — a filter that shows the
    // wrong rows rather than a file that fails to open, which is why it needs an assertion rather than a
    // reader.
    const and = `<filterColumn colId="0"><customFilters and="1"><customFilter val="1"/></customFilters></filterColumn>`;
    const or = `<filterColumn colId="0"><customFilters><customFilter val="1"/></customFilters></filterColumn>`;
    expect(payloadOf(and, "BrtBeginCustomFilters").getUint32(0, true)).toBe(0);
    expect(payloadOf(or, "BrtBeginCustomFilters").getUint32(0, true)).toBe(1);
  });

  it("maps each comparison operator through the record's own table", () => {
    // Neither alphabetical nor the XML's order: `equal` is 2 while `lessThan` is 1, and `notEqual` is 5
    // while `greaterThanOrEqual` is 6.
    const operatorOf = (name: string): number =>
      payloadOf(
        `<filterColumn colId="0"><customFilters><customFilter operator="${name}" val="1"/></customFilters></filterColumn>`,
        "BrtCustomFilter"
      ).getUint8(1);
    expect(operatorOf("lessThan")).toBe(0x01);
    expect(operatorOf("equal")).toBe(0x02);
    expect(operatorOf("lessThanOrEqual")).toBe(0x03);
    expect(operatorOf("greaterThan")).toBe(0x04);
    expect(operatorOf("notEqual")).toBe(0x05);
    expect(operatorOf("greaterThanOrEqual")).toBe(0x06);
  });

  it("defaults a missing operator to equal, as the schema does", () => {
    expect(
      payloadOf(
        `<filterColumn colId="0"><customFilters><customFilter val="1"/></customFilters></filterColumn>`,
        "BrtCustomFilter"
      ).getUint8(1)
    ).toBe(0x02);
  });

  it("picks vts from the value, and keeps the union even for a string", () => {
    // The XML does not say which type a comparison is; the value does. And the union is eight bytes
    // whatever the type — for a string it is "unused" rather than absent, so the string that follows would
    // start eight bytes early without it. That is why the string case is 10 + the string rather than 2 + it.
    const numeric = `<filterColumn colId="0"><customFilters><customFilter operator="greaterThan" val="5"/></customFilters></filterColumn>`;
    const text = `<filterColumn colId="0"><customFilters><customFilter val="x*"/></customFilters></filterColumn>`;
    expect(payloadOf(numeric, "BrtCustomFilter").getUint8(0)).toBe(0x04);
    expect(payloadOf(numeric, "BrtCustomFilter").getFloat64(2, true)).toBe(5);
    expect(payloadOf(numeric, "BrtCustomFilter").byteLength).toBe(10);
    expect(payloadOf(text, "BrtCustomFilter").getUint8(0)).toBe(0x06);
    // 2 + 8 union + 4 count + 2×2 for "x*".
    expect(payloadOf(text, "BrtCustomFilter").byteLength).toBe(18);
    expect(payloadOf(text, "BrtCustomFilter").getUint32(10, true)).toBe(2);
  });

  it("reads the two filter-column attributes with their opposite defaults", () => {
    // `hiddenButton` is absent-means-false, but `showButton` is absent-means-**true**. Reading the second as
    // a plain flag sets `fNoBtn` on every column and hides every dropdown button in the sheet — a filter
    // that is in the file and cannot be reached from the interface.
    const flagsFor = (attributes: string): number =>
      payloadOf(
        `<filterColumn colId="3"${attributes}><filters><filter val="a"/></filters></filterColumn>`,
        "BrtBeginFilterColumn"
      ).getUint16(4, true);
    expect(flagsFor("")).toBe(0);
    expect(flagsFor(' showButton="0"')).toBe(0x02);
    expect(flagsFor(' hiddenButton="1"')).toBe(0x01);
    // And `dwCol` is the column index the attribute gives, not the position in the list.
    expect(
      payloadOf(
        `<filterColumn colId="3"><filters><filter val="a"/></filters></filterColumn>`,
        "BrtBeginFilterColumn"
      ).getUint32(0, true)
    ).toBe(3);
  });

  it("carries top10 as three flag bits and two numbers", () => {
    const top10 = (attributes: string): DataView =>
      payloadOf(`<filterColumn colId="0"><top10 ${attributes}/></filterColumn>`, "BrtTop10Filter");
    // fTop | fPercent | fApplied.
    expect(top10('top="1" val="3" filterVal="7"').getUint8(0)).toBe(0x01 | 0x04);
    expect(top10('top="0" percent="1" val="10"').getUint8(0)).toBe(0x02);
    expect(top10('top="1" val="3" filterVal="7"').getFloat64(1, true)).toBe(3);
    expect(top10('top="1" val="3" filterVal="7"').getFloat64(9, true)).toBe(7);
  });

  it("does not claim fApplied without a threshold to compare against", () => {
    // `fApplied` says `xNumFilter` is a real value from the range. Claiming it while writing 0 tells Excel
    // to compare against zero instead of recalculating.
    const payload = payloadOf(
      `<filterColumn colId="0"><top10 val="3"/></filterColumn>`,
      "BrtTop10Filter"
    );
    expect(payload.getUint8(0) & 0x04).toBe(0);
    expect(payload.getFloat64(9, true)).toBe(0);
  });

  it("carries the blank flag rather than an empty filter value", () => {
    // A `BrtFilter` string must be at least one character, so an empty `val` is not writable — and it is
    // not what emptiness means anyway: that is `<filters blank="1">`.
    expect(
      payloadOf(
        `<filterColumn colId="0"><filters blank="1"><filter val="a"/></filters></filterColumn>`,
        "BrtBeginFilters"
      ).getUint32(0, true)
    ).toBe(1);
    expect(
      shapeOf(
        `<filterColumn colId="0"><filters blank="1"><filter val=""/></filters></filterColumn>`
      )
    ).toEqual([
      ["BrtBeginFilterColumn", 6],
      ["BrtBeginFilters", 8],
      ["BrtEndFilters", 0],
      ["BrtEndFilterColumn", 0]
    ]);
  });

  it("names the kinds it cannot express, and writes nothing for them", () => {
    // Every criterion the XLSX reader preserves has a record now, so the fixture has to be something the
    // *schema* allows inside a filter column and this encoder has no record for — an `extLst` extension.
    const mixed =
      `<filterColumn colId="0"><filters><filter val="a"/></filters></filterColumn>` +
      `<filterColumn colId="1"><extLst><ext uri="{x}"/></extLst></filterColumn>`;
    const result = filterCriteriaRecords(mixed);
    expect(result.unsupported).toEqual(["extLst"]);
    // The column whose only child was declined is skipped entirely. A `BrtBeginFilterColumn` with nothing
    // inside is legal, and writing one would claim the filter came across.
    expect(result.records.filter(([name]) => name === "BrtBeginFilterColumn")).toHaveLength(1);
  });

  it("survives a fragment it cannot parse without emitting half a filter", () => {
    // The preserved fragment has no single root, so it is wrapped before parsing. If that fails the answer
    // is no records at all — a partially written collection would be a malformed part.
    const result = filterCriteriaRecords('<filterColumn colId="0"><filters>');
    expect(result.records).toEqual([]);
    expect(result.unsupported).toEqual(["filterColumn"]);
  });

  it("matches on the local name, so a prefixed fragment is not silently empty", () => {
    // Whether the preserved XML carries the spreadsheetml prefix depends on how the source file declared
    // its namespaces.
    expect(
      shapeOf(
        `<x:filterColumn xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" colId="0"><x:filters><x:filter val="a"/></x:filters></x:filterColumn>`
      )
    ).toEqual([
      ["BrtBeginFilterColumn", 6],
      ["BrtBeginFilters", 8],
      // 4 for the count, 2 for the single character.
      ["BrtFilter", 6],
      ["BrtEndFilters", 0],
      ["BrtEndFilterColumn", 0]
    ]);
  });
});

describe("end to end, from a real XLSX read", () => {
  /** A one-sheet XLSX carrying `autoFilter` with the given criteria XML. */
  async function xlsxWithCriteria(criteria: string): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const archive = new ZipArchive();
    const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    archive.add(
      "[Content_Types].xml",
      encoder.encode(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
      )
    );
    archive.add(
      "_rels/.rels",
      encoder.encode(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
      )
    );
    archive.add(
      "xl/workbook.xml",
      encoder.encode(
        `<?xml version="1.0"?><workbook xmlns="${main}" xmlns:r="${rel}"><sheets>` +
          `<sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
      )
    );
    archive.add(
      "xl/_rels/workbook.xml.rels",
      encoder.encode(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
      )
    );
    archive.add(
      "xl/worksheets/sheet1.xml",
      encoder.encode(
        `<?xml version="1.0"?><worksheet xmlns="${main}"><sheetData><row r="1">` +
          `<c r="A1" t="inlineStr"><is><t>H</t></is></c></row></sheetData>` +
          `<autoFilter ref="A1:C9">${criteria}</autoFilter></worksheet>`
      )
    );
    return archive.bytes();
  }

  /** The filter record names in the written sheet part, in order. */
  async function writtenFilterRecords(criteria: string): Promise<string[]> {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await xlsxWithCriteria(criteria));
    const parts = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    const path = [...parts.keys()].find(name => /worksheets\/sheet\d+\.bin$/.test(name))!;
    return [...iterateInterpretableRecords(parts.get(path)!.data, "s")]
      .map(entry => recordSpec(entry.id)?.name ?? String(entry.id))
      .filter(name => /AFilter|FilterColumn|Filters|Filter$|Top10/.test(name));
  }

  it("writes the criteria inside BrtBeginAFilter, not after it", async () => {
    // The whole point of the nesting: a criterion emitted after `BrtEndAFilter` is at worksheet scope and
    // belongs to nothing, while every individual record still looks correct.
    expect(
      await writtenFilterRecords(
        `<filterColumn colId="0"><filters><filter val="apple"/></filters></filterColumn>` +
          `<filterColumn colId="2"><top10 top="1" val="3" filterVal="7"/></filterColumn>`
      )
    ).toEqual([
      "BrtBeginAFilter",
      "BrtBeginFilterColumn",
      "BrtBeginFilters",
      "BrtFilter",
      "BrtEndFilters",
      "BrtEndFilterColumn",
      "BrtBeginFilterColumn",
      "BrtTop10Filter",
      "BrtEndFilterColumn",
      "BrtEndAFilter"
    ]);
  });

  it("no longer reports a loss for the criteria it can write", async () => {
    const workbook = Workbook.create();
    await Workbook.read(
      workbook,
      await xlsxWithCriteria(
        `<filterColumn colId="1"><customFilters and="1">` +
          `<customFilter operator="greaterThan" val="5"/><customFilter operator="lessThan" val="9"/>` +
          `</customFilters></filterColumn>`
      )
    );
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
  });

  it("still reports a kind it cannot write", async () => {
    const workbook = Workbook.create();
    await Workbook.read(
      workbook,
      await xlsxWithCriteria(
        `<filterColumn colId="0"><extLst><ext uri="{x}"/></extLst></filterColumn>`
      )
    );
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /auto filter criteria/
    );
  });

  it("keeps the range even when every criterion is declined", async () => {
    // The dropdowns should still appear on the right cells. Dropping the range because a criterion could not
    // come with it would be a larger loss than the one being reported.
    expect(
      await writtenFilterRecords(
        `<filterColumn colId="0"><extLst><ext uri="{x}"/></extLst></filterColumn>`
      )
    ).toEqual(["BrtBeginAFilter", "BrtEndAFilter"]);
  });
});

describe("the three dynamic kinds and the date group item", () => {
  it("keeps the hole in the dynamic filter enumeration", () => {
    // `aboveAverage` and `belowAverage` are 1 and 2, and the date periods resume at **8** — 3 through 7 are
    // unassigned. An array indexed by position in the XML schema's list would therefore give "tomorrow" a
    // value with no meaning, and every period after it the wrong one.
    const cftOf = (type: string): number =>
      payloadOf(
        `<filterColumn colId="0"><dynamicFilter type="${type}"/></filterColumn>`,
        "BrtDynamicFilter"
      ).getUint32(0, true);
    expect(cftOf("aboveAverage")).toBe(0x01);
    expect(cftOf("belowAverage")).toBe(0x02);
    expect(cftOf("tomorrow")).toBe(0x08);
    expect(cftOf("yearToDate")).toBe(0x17);
    expect(cftOf("Q1")).toBe(0x18);
    expect(cftOf("Q3")).toBe(0x1a);
    expect(cftOf("M1")).toBe(0x1c);
    expect(cftOf("M12")).toBe(0x27);
  });

  it("does not claim fApplied or write computed values for a dynamic filter", () => {
    // The XML carries no computed values — Excel recalculates a dynamic filter on open, which is the point
    // of calling it dynamic. `fApplied` MUST be 0 when `cft` is at least 0x18 in any case, and claiming it
    // while writing zeroes would assert that zero *is* the computed average.
    const payload = payloadOf(
      `<filterColumn colId="0"><dynamicFilter type="aboveAverage"/></filterColumn>`,
      "BrtDynamicFilter"
    );
    expect(payload.byteLength).toBe(21);
    expect(payload.getUint8(4) & 0x01).toBe(0);
    expect(payload.getFloat64(5, true)).toBe(0);
    expect(payload.getFloat64(13, true)).toBe(0);
  });

  it("declines a dynamic type the enumeration has no value for", () => {
    // Rather than writing `CFTNIL`, which is a record that specifies no filter — a filter silently doing
    // nothing is worse than a reported loss.
    const result = filterCriteriaRecords(
      `<filterColumn colId="0"><dynamicFilter type="bogus"/></filterColumn>`
    );
    expect(result.records).toEqual([]);
    expect(result.unsupported).toEqual(["dynamicFilter"]);
  });

  it("reads cellColor as absent-means-true", () => {
    // `<colorFilter dxfId="0"/>` filters by *fill* colour. Reading the attribute as a plain flag inverts
    // every fill-colour filter into a font-colour one — the same class of trap as `showButton`.
    const cellColourOf = (attributes: string): number =>
      payloadOf(
        `<filterColumn colId="0"><colorFilter dxfId="3"${attributes}/></filterColumn>`,
        "BrtColorFilter"
      ).getUint32(4, true);
    expect(cellColourOf("")).toBe(1);
    expect(cellColourOf(' cellColor="1"')).toBe(1);
    expect(cellColourOf(' cellColor="0"')).toBe(0);
  });

  it("declines a colour filter with no dxfId, rather than writing the sentinel", () => {
    // `dxfid` MUST NOT be 0xFFFFFFFF, which is exactly what "no differential format" would be.
    const result = filterCriteriaRecords(`<filterColumn colId="0"><colorFilter/></filterColumn>`);
    expect(result.unsupported).toEqual(["colorFilter"]);
    expect(result.records).toEqual([]);
  });

  it("maps every icon set to its KPISets value", () => {
    const setOf = (name: string): number =>
      payloadOf(
        `<filterColumn colId="0"><iconFilter iconSet="${name}" iconId="0"/></filterColumn>`,
        "BrtIconFilter"
      ).getUint32(0, true);
    expect(setOf("3Arrows")).toBe(0x00);
    expect(setOf("3TrafficLights1")).toBe(0x03);
    expect(setOf("3Signs")).toBe(0x05);
    expect(setOf("4Rating")).toBe(0x0b);
    expect(setOf("5Quarters")).toBe(0x10);
    // A name the model's own union carries but this enumeration does not — declined rather than guessed at.
    expect(
      filterCriteriaRecords(
        `<filterColumn colId="0"><iconFilter iconSet="3Stars" iconId="0"/></filterColumn>`
      ).unsupported
    ).toEqual(["iconFilter"]);
  });

  it("lays out a date group item with its non-uniform widths", () => {
    // `dom` is four bytes while `hour` is two. Assuming a uniform width shifts every field after it.
    const payload = payloadOf(
      `<filterColumn colId="0"><filters><dateGroupItem year="2025" month="8" day="17" hour="13" minute="45" second="30" dateTimeGrouping="second"/></filters></filterColumn>`,
      "BrtAFilterDateGroupItem"
    );
    expect(payload.byteLength).toBe(24);
    expect(payload.getUint16(0, true)).toBe(2025);
    expect(payload.getUint16(2, true)).toBe(8);
    expect(payload.getUint32(4, true)).toBe(17);
    expect(payload.getUint16(8, true)).toBe(13);
    expect(payload.getUint16(10, true)).toBe(45);
    expect(payload.getUint16(12, true)).toBe(30);
    expect(payload.getUint32(20, true)).toBe(5);
  });

  it("maps each date grouping to its dntChecked value", () => {
    const groupingOf = (name: string): number =>
      payloadOf(
        `<filterColumn colId="0"><filters><dateGroupItem year="2025" dateTimeGrouping="${name}"/></filters></filterColumn>`,
        "BrtAFilterDateGroupItem"
      ).getUint32(20, true);
    expect(groupingOf("year")).toBe(0);
    expect(groupingOf("month")).toBe(1);
    expect(groupingOf("day")).toBe(2);
    expect(groupingOf("hour")).toBe(3);
    expect(groupingOf("minute")).toBe(4);
    expect(groupingOf("second")).toBe(5);
  });

  it("keeps a date group item in document order beside its sibling filters", () => {
    // Both are criteria inside `<filters>`, and reordering them changes which values the filter shows — so
    // they are walked once in order rather than in two passes.
    expect(
      shapeOf(
        `<filterColumn colId="0"><filters><filter val="a"/><dateGroupItem year="2025" dateTimeGrouping="year"/><filter val="b"/></filters></filterColumn>`
      )
    ).toEqual([
      ["BrtBeginFilterColumn", 6],
      ["BrtBeginFilters", 8],
      ["BrtFilter", 6],
      ["BrtAFilterDateGroupItem", 24],
      ["BrtFilter", 6],
      ["BrtEndFilters", 0],
      ["BrtEndFilterColumn", 0]
    ]);
  });

  it("reports nothing lost for a workbook using all six kinds", () => {
    // The point of the whole exercise: every criterion the XLSX reader can preserve now has a record.
    const everything =
      `<filterColumn colId="0"><filters blank="1"><filter val="North"/><dateGroupItem year="2025" month="8" dateTimeGrouping="month"/></filters></filterColumn>` +
      `<filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThan" val="70"/></customFilters></filterColumn>` +
      `<filterColumn colId="2"><dynamicFilter type="aboveAverage"/></filterColumn>` +
      `<filterColumn colId="3"><top10 top="1" val="10" filterVal="42"/></filterColumn>` +
      `<filterColumn colId="4"><colorFilter dxfId="0"/></filterColumn>` +
      `<filterColumn colId="5"><iconFilter iconSet="3TrafficLights1" iconId="0"/></filterColumn>`;
    expect(filterCriteriaRecords(everything).unsupported).toEqual([]);
    expect(worksheetLosses({ autoFilterCriteria: { ref: "A1:G9", xml: everything } })).toEqual([]);
  });
});
