/**
 * The PivotTable view part.
 *
 * Sizes are asserted against the field tables in `[MS-XLSB]`, and the nesting against the worked example in
 * section 3.8. Two of these layouts were ambiguous in their own tables and were resolved by the example's
 * declared record *size* — those are called out where they are checked, because a size that merely looks
 * plausible is how a misread field table survives.
 */

import { extractAll } from "@archive/unzip/extract";
import { Pivot, Workbook, Worksheet } from "@excel";
import { VALID_SUBTOTALS } from "@excel/core/pivot-table-types";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { pivotViewRecords, type PivotViewModel } from "@excel/xlsb/pivot-view";
import { RECORD_BY_NAME, recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

function sampleView(overrides: Partial<PivotViewModel> = {}): PivotViewModel {
  return {
    name: "PivotTable1",
    cacheId: 10,
    location: { rowFirst: 2, rowLast: 8, columnFirst: 0, columnLast: 2 },
    fields: [
      { name: "Region", itemCount: 2, axis: "row" },
      { name: "Units", itemCount: 0, axis: "data" }
    ],
    rowFields: [0],
    columnFields: [],
    pageFields: [],
    dataItems: [{ field: 1, subtotal: "sum", caption: "Sum of Units" }],
    dataCaption: "Values",
    ...overrides
  };
}

/** The payload of the first record with the given name. */
function payloadOf(view: PivotViewModel, name: string): DataView {
  const found = pivotViewRecords(view).find(([recordName]) => recordName === name);
  if (found?.[1] === undefined) {
    throw new Error(`no ${name} record with a payload`);
  }
  return new DataView(found[1].buffer, found[1].byteOffset, found[1].length);
}

describe("the PivotTable view part", () => {
  it("balances every Begin against its End", () => {
    // The scope checker enforces this on read; getting it wrong on write produces a part that unbalances at
    // the end rather than at the record responsible, so the depth is walked here instead.
    let depth = 0;
    let lowest = 0;
    for (const [name] of pivotViewRecords(sampleView())) {
      if (name.startsWith("BrtEnd")) {
        depth -= 1;
        lowest = Math.min(lowest, depth);
      } else if (name.startsWith("BrtBegin")) {
        depth += 1;
      }
    }
    expect(depth).toBe(0);
    expect(lowest).toBe(0);
  });

  it("names only records the table knows", () => {
    const unknown = [...new Set(pivotViewRecords(sampleView()).map(([name]) => name))].filter(
      name => !RECORD_BY_NAME.has(name)
    );
    expect(unknown).toEqual([]);
  });

  /**
   * `BrtBeginSXPI` — thirteen bytes, and every field pinned to section 3.8.55's worked example.
   *
   * **No test above touches a page field**: `sampleView()` sets `pageFields: []`, so the record was never
   * emitted by the suite and shipped twelve bytes long — missing the trailing flag byte. That is not a
   * cosmetic loss. A short record desynchronises everything after it in the part, and Excel's answer was
   * `Removed Part: /xl/pivotTables/pivotTableN.bin`: nine of the twenty-five pivots in the example
   * vanished, exactly the nine that had a page filter.
   *
   * The length is asserted first and on its own, because it is the property whose violation is
   * catastrophic rather than wrong — a reader that survives a bad `isxvi` does not survive a bad size.
   */
  /**
   * Two or more data items put the data field on the column axis, and three records have to agree about it.
   *
   * `BrtBeginISXVDCols` is specified as stating "the pivot fields that appear on the column axis **and
   * whether the data field appears on the column axis**". This writer only ever wrote the first half, while
   * `sxaxis4Data` was the constant `0x02` — so every view claimed a data field on the column axis, and a view
   * with no column fields omitted the array entirely and claimed it on an axis that did not exist. MS-XLSB
   * 2.5.84 forbids exactly that pairing, and Excel answered `Removed Feature: PivotTable report` for the
   * three example pivots with several values and no column field.
   *
   * Nothing above caught it because every fixture had a single data item, where `0x02` happens to be
   * harmless — the same reason the page-field record shipped a byte short.
   */
  /**
   * `sxaxis` has four independent bits, and a field can be a row field *and* a data item.
   *
   * The example's pivot 10 does exactly that — `rows: ["Quantity"], values: ["Quantity"]` — and got
   * `sxaxisRw` alone, because the view model described the axis with a single string. Excel answered
   * `Repaired Records: PivotTable report`. MS-XLSB 2.5.146 lists `sxaxisRw`, `sxaxisCol`, `sxaxisPage` and
   * `sxaxisData` as four separate bits; only the first three are a choice.
   */
  /**
   * A field's declared subtotal and its item list must not contradict each other.
   *
   * Every field with items ends its list with a `PITDEFAULT` — the automatic subtotal a grand total is drawn
   * from — and `fDefault` in `BrtBeginSXVD` is the declaration that such a subtotal exists. The flag was set
   * for row and column fields only, so a **page** field carried the item while denying the subtotal, and Excel
   * answered `Repaired Records: PivotTable report` for every pivot with a page filter.
   *
   * Checked as a relation across all fields rather than as a value for the page case, because the failure was
   * not "the page branch is wrong" but "two places decide one fact". A future axis added to one and not the
   * other fails here.
   */
  it.each(["row", "column", "page"] as const)(
    "declares fDefault on a %s field, matching the default item it writes",
    axis => {
      const view = sampleView({
        fields: [
          { name: "F", itemCount: 3, axis },
          { name: "Units", itemCount: 0, axis: "data" }
        ],
        rowFields: axis === "row" ? [0] : [],
        columnFields: axis === "column" ? [0] : [],
        pageFields: axis === "page" ? [0] : [],
        dataItems: [{ field: 1, subtotal: "sum", caption: "Sum of Units" }]
      });
      const records = pivotViewRecords(view);
      const field = records.filter(([name]) => name === "BrtBeginSXVD")[0]![1]!;
      expect(new DataView(field.buffer, field.byteOffset).getUint16(1, true) & 0x0001).toBe(0x0001);
    }
  );

  it("never writes a default item for a field that declares no subtotal", () => {
    // The relation stated from the other end. `sampleView()`'s data field has no items, so it must have neither
    // the flag nor the item — and any field that *does* get items must have both.
    const view = sampleView({
      fields: [
        { name: "Region", itemCount: 2, axis: "row" },
        { name: "Year", itemCount: 3, axis: "page" },
        { name: "Units", itemCount: 0, axis: "data" }
      ],
      rowFields: [0],
      pageFields: [1],
      dataItems: [{ field: 2, subtotal: "sum", caption: "Sum of Units" }]
    });

    // Walk the field/item nesting and pair each field's flag with whether it emitted a `PITDEFAULT`.
    const paired: { declared: boolean; hasDefaultItem: boolean }[] = [];
    let current: { declared: boolean; hasDefaultItem: boolean } | undefined;
    for (const [name, payload] of pivotViewRecords(view)) {
      if (name === "BrtBeginSXVD") {
        current = {
          declared:
            (new DataView(payload!.buffer, payload!.byteOffset).getUint16(1, true) & 0x0001) !== 0,
          hasDefaultItem: false
        };
      } else if (name === "BrtBeginSXVI" && current) {
        if (new DataView(payload!.buffer, payload!.byteOffset).getUint16(0, true) === 0x01) {
          current.hasDefaultItem = true;
        }
      } else if (name === "BrtEndSXVD" && current) {
        paired.push(current);
        current = undefined;
      }
    }

    expect(paired).toHaveLength(3);
    for (const field of paired) {
      expect(field.declared).toBe(field.hasDefaultItem);
    }
  });

  it("marks a field that is both a row field and a data item on both axes", () => {
    const view = sampleView({
      fields: [
        { name: "Quantity", itemCount: 5, axis: "row", dataField: true },
        { name: "Region", itemCount: 2, axis: "none" }
      ],
      rowFields: [0],
      dataItems: [{ field: 0, subtotal: "count", caption: "Count of Quantity" }]
    });
    const records = pivotViewRecords(view).filter(([name]) => name === "BrtBeginSXVD");
    expect(records[0]![1]![0]).toBe(0x01 | 0x08);
  });

  it("leaves a plain row field on the row axis only", () => {
    const records = pivotViewRecords(sampleView()).filter(([name]) => name === "BrtBeginSXVD");
    // `sampleView()`'s first field is a row field and not summarised; its second is a data item only.
    expect(records[0]![1]![0]).toBe(0x01);
    expect(records[1]![1]![0]).toBe(0x08);
  });

  it("puts the data field on the column axis when there are several data items", () => {
    const view = sampleView({
      fields: [
        { name: "Region", itemCount: 2, axis: "row" },
        { name: "Units", itemCount: 0, axis: "data" },
        { name: "Cost", itemCount: 0, axis: "data" }
      ],
      rowFields: [0],
      columnFields: [],
      dataItems: [
        { field: 1, subtotal: "sum", caption: "Sum of Units" },
        { field: 2, subtotal: "sum", caption: "Sum of Cost" }
      ]
    });

    // The `-2` sentinel, as a signed read — `indexArray` writes a count then the entries.
    const columns = payloadOf(view, "BrtBeginISXVDCols");
    expect(columns.getUint32(0, true)).toBe(1);
    expect(columns.getInt32(4, true)).toBe(-2);

    // `sxaxis4Data` at offset 12 of `BrtBeginSXView` must be `0x02` precisely because the array has a -2.
    expect(payloadOf(view, "BrtBeginSXView").getUint8(12)).toBe(0x02);

    // One column line per data item, then a grand total — the shape the XLSX writer emits as `colItems`
    // with `values.length + 1` entries, and which Excel requires here too.
    expect(payloadOf(view, "BrtBeginSXLICols").getUint32(0, true)).toBe(3);
  });

  it("still names the column axis for the data field with a single data item", () => {
    // **This asserted `0x00`, and that was an invented rule.** 2.5.84 says an array containing `-2` requires
    // `sxaxis4Data` to be `0x02`; it does not say the converse, and reading that `MUST` as an equivalence broke
    // an oracle case that had been byte-identical to Excel. `05-pivots` is the evidence: Excel writes
    // `sxaxis4Data = 0x02` there for a pivot with one data item and no `BrtBeginISXVDCols` record at all.
    //
    // So the column axis collection is conditional and this field is not.
    const view = sampleView();
    expect(pivotViewRecords(view).some(([name]) => name === "BrtBeginISXVDCols")).toBe(false);
    expect(payloadOf(view, "BrtBeginSXView").getUint8(12)).toBe(0x02);
  });

  it("appends the data field after real column fields", () => {
    const view = sampleView({
      fields: [
        { name: "Region", itemCount: 2, axis: "row" },
        { name: "Quarter", itemCount: 4, axis: "column" },
        { name: "Units", itemCount: 0, axis: "data" },
        { name: "Cost", itemCount: 0, axis: "data" }
      ],
      rowFields: [0],
      columnFields: [1],
      dataItems: [
        { field: 2, subtotal: "sum", caption: "Sum of Units" },
        { field: 3, subtotal: "sum", caption: "Sum of Cost" }
      ]
    });
    const columns = payloadOf(view, "BrtBeginISXVDCols");
    expect(columns.getUint32(0, true)).toBe(2);
    expect(columns.getInt32(4, true)).toBe(1);
    expect(columns.getInt32(8, true)).toBe(-2);
  });

  it("lays out BrtBeginSXPI as thirteen bytes matching the specification's example", () => {
    const view = sampleView({
      fields: [
        { name: "Region", itemCount: 2, axis: "row" },
        { name: "Year", itemCount: 3, axis: "page" },
        { name: "Units", itemCount: 0, axis: "data" }
      ],
      rowFields: [0],
      pageFields: [1],
      dataItems: [{ field: 2, subtotal: "sum", caption: "Sum of Units" }]
    });
    const payload = payloadOf(view, "BrtBeginSXPI");

    expect(payload.byteLength).toBe(13);
    // `isxvd`: the pivot field on the page axis. MUST NOT be -1 or -2.
    expect(payload.getUint32(0, true)).toBe(1);
    // `isxvi`: `0x001000FE` defers to the page-filtering rules, which is the "no single item picked" case.
    // `0xFFFFFFFF` was written here and is not among the values 2.4.256 admits.
    expect(payload.getUint32(4, true)).toBe(0x001000fe);
    // `isxth`: -1, the OLAP hierarchy this non-OLAP view does not have.
    expect(payload.getUint32(8, true)).toBe(0xffffffff);
    // `fUnique` and `fDisplay` clear: both promise an OLAP caption string after the fixed part.
    expect(payload.getUint8(12)).toBe(0);
  });

  it("counts the page fields in BrtBeginSXPIs", () => {
    const view = sampleView({
      fields: [
        { name: "Region", itemCount: 2, axis: "page" },
        { name: "Year", itemCount: 3, axis: "page" },
        { name: "Units", itemCount: 0, axis: "data" }
      ],
      rowFields: [],
      pageFields: [0, 1],
      dataItems: [{ field: 2, subtotal: "sum", caption: "Sum of Units" }]
    });
    const payload = payloadOf(view, "BrtBeginSXPIs");
    expect(payload.byteLength).toBe(4);
    expect(payload.getUint32(0, true)).toBe(2);
    expect(pivotViewRecords(view).filter(([name]) => name === "BrtBeginSXPI")).toHaveLength(2);
  });

  it("lays out BrtBeginSXView as thirty-two bytes and two strings", () => {
    // 32 fixed, 26 for "PivotTable1", 16 for "Values".
    const payload = payloadOf(sampleView(), "BrtBeginSXView");
    expect(payload.byteLength).toBe(74);
    // `idCache` is the last fixed field, and it MUST equal a `BrtBeginPivotCacheID` in the workbook.
    expect(payload.getUint32(28, true)).toBe(10);
    // Then the name's character count.
    expect(payload.getUint32(32, true)).toBe("PivotTable1".length);
  });

  it("sets fDisplayData and both inverted empty-string flags", () => {
    // Three of the flags are *presence* flags for conditional strings, and two are inverted:
    // `fDisplayData` says `irstData` is present and MUST be 1, while `fEmptyDisplayErrorString` and
    // `fEmptyDisplayNullString` say their strings are *absent*. Reading the pair as ordinary "has a value"
    // flags produces a record whose strings are read out of whatever follows it.
    const payload = payloadOf(sampleView(), "BrtBeginSXView");
    expect(payload.getUint32(4, true) & (1 << 19)).toBe(1 << 19);
    expect(payload.getUint32(8, true) & (1 << 6)).toBe(1 << 6);
    expect(payload.getUint32(8, true) & (1 << 7)).toBe(1 << 7);
  });

  it("puts rwFirstHead and rwFirstData on the same row", () => {
    // The specification requires `rwFirstHead <= rwFirstData` and that it equal `rfxGeom.rwFirst + 1` when
    // there is no row or column area. Section 3.8.27's worked example has the two **equal** — both
    // `0x00000005` — and the XLSX writer says the same with `firstHeaderRow="1" firstDataRow="1"`. Asserted as
    // equality rather than the specification's inequality, because the inequality passed while the writer put
    // the data a row too low.
    const payload = payloadOf(sampleView(), "BrtBeginSXLocation");
    expect(payload.byteLength).toBe(36);
    const rowFirst = payload.getUint32(0, true);
    const headerRow = payload.getUint32(16, true);
    expect(rowFirst).toBe(2);
    expect(headerRow).toBe(rowFirst + 1);
    expect(payload.getUint32(20, true)).toBe(headerRow);
  });

  it("puts the data below one header row per column field", () => {
    // **Equal to `rwFirstHead` only when the column axis is empty**, which is the case the assertion above
    // covers and the case the worked example uses. A column field puts its items on their own row, so the data
    // starts below them — Excel's own binary for a pivot with one column field has `rwFirstHead` 3 and
    // `rwFirstData` 4, and this writer had both at 3.
    const payload = payloadOf(
      sampleView({ columnFields: [1], columnFieldCount: 1 }),
      "BrtBeginSXLocation"
    );
    expect(payload.getUint32(20, true)).toBe(payload.getUint32(16, true) + 1);
  });

  it("makes the row area as wide as it has row fields", () => {
    // `colFirstData` was `columnFirst + 1` however many row fields there were, which contradicted this writer's
    // own `fCompactData` — left clear, meaning a tabular layout, in which each row field gets its own column.
    // Excel's binary for two row fields has `colFirstData` 2.
    expect(
      payloadOf(sampleView({ rowAreaWidth: 2 }), "BrtBeginSXLocation").getUint32(24, true)
    ).toBe(2);
    // And one field is still one column, so the fix cannot have shifted the common case.
    expect(payloadOf(sampleView(), "BrtBeginSXLocation").getUint32(24, true)).toBe(1);
  });

  it("counts the page rows only when there are page fields", () => {
    expect(payloadOf(sampleView(), "BrtBeginSXLocation").getUint32(28, true)).toBe(0);
    const withPages = sampleView({
      fields: [
        { name: "Region", itemCount: 2, axis: "page" },
        { name: "Units", itemCount: 0, axis: "data" }
      ],
      rowFields: [],
      pageFields: [0]
    });
    expect(payloadOf(withPages, "BrtBeginSXLocation").getUint32(28, true)).toBe(1);
  });

  it("gives the view a pivot field for every cache field", () => {
    // The axis collections hold indices into `BrtBeginSXVDs`, so the view has to carry a field for every
    // cache field even when most sit on no axis — the indices are positions in that collection, not a
    // separate numbering. A view with fewer fields than the cache makes every index after the gap wrong.
    const view = sampleView({
      fields: [
        { name: "A", itemCount: 1, axis: "none" },
        { name: "B", itemCount: 1, axis: "row" },
        { name: "C", itemCount: 0, axis: "data" }
      ],
      rowFields: [1],
      dataItems: [{ field: 2, subtotal: "sum", caption: "Sum of C" }]
    });
    const records = pivotViewRecords(view);
    expect(records.filter(([name]) => name === "BrtBeginSXVD")).toHaveLength(3);
    expect(payloadOf(view, "BrtBeginSXVDs").getUint32(0, true)).toBe(3);
    expect(payloadOf(view, "BrtBeginISXVDRws").getUint32(4, true)).toBe(1);
  });

  it("writes each axis as its own exclusive bit", () => {
    // `sxaxis` is a bitfield and row, column and page are mutually exclusive; the data axis is a separate bit
    // that may coexist with them.
    const axisOf = (axis: PivotViewModel["fields"][number]["axis"]): number =>
      payloadOf(
        sampleView({ fields: [{ name: "F", itemCount: 0, axis }], rowFields: [], dataItems: [] }),
        "BrtBeginSXVD"
      ).getUint8(0);
    expect(axisOf("row")).toBe(0x01);
    expect(axisOf("column")).toBe(0x02);
    expect(axisOf("page")).toBe(0x04);
    expect(axisOf("data")).toBe(0x08);
    expect(axisOf("none")).toBe(0x00);
  });

  it("writes one pivot item per cache item plus the default subtotal", () => {
    const records = pivotViewRecords(sampleView());
    // Two data items and the `PITDEFAULT`. This asserted two, matching a writer that omitted the subtotal
    // while the layout below drew a grand total from it — and this library's own XLSX writer emits
    // `count="{items + 1}"` for the same model.
    expect(records.filter(([name]) => name === "BrtBeginSXVI")).toHaveLength(3);
    expect(payloadOf(sampleView(), "BrtBeginSXVIs").getUint32(0, true)).toBe(3);
    // The value field has `itemCount: 0`, so it gets no collection at all rather than an empty one.
    expect(records.filter(([name]) => name === "BrtBeginSXVIs")).toHaveLength(1);
  });

  it("refers each data item to the cache item at the same ordinal, and the subtotal to none", () => {
    // `iCache` is signed and MUST be -1 for any type other than `PITDATA`, which is why it is read here as a
    // signed value: an unsigned read of the subtotal's -1 gives 4294967295 and would pass against a wrong
    // expectation just as happily.
    const items = pivotViewRecords(sampleView()).filter(([name]) => name === "BrtBeginSXVI");
    expect(
      items.map(([, payload]) => {
        const view = new DataView(payload!.buffer, payload!.byteOffset);
        return [view.getUint8(0), view.getInt32(3, true)];
      })
    ).toEqual([
      [0x00, 0],
      [0x00, 1],
      [0x01, -1]
    ]);
  });

  it("enumerates the row lines and gives the column line no entry collection", () => {
    // The shape here is Excel's, read from an XLSB it produced for this pivot: a `PITDATA` line per row item,
    // then a `PITGRAND`, each with `cisxvis = 1` and a four-byte `BrtBeginISXVIs`; and one column line with no
    // entries and **no `BrtBeginISXVIs` record at all**.
    //
    // This asserted a single grand-total row line, on the reasoning that `refreshOnLoad` makes Excel rebuild
    // the layout. It does in XLSX — the XLSX writer does exactly that and Excel opens it — and it does not
    // here.
    const records = pivotViewRecords(sampleView());
    const lines: { itemType: number; entryCount: number; entries: number[] | null }[] = [];
    records.forEach(([name, payload], index) => {
      if (name !== "BrtBeginSXLI") {
        return;
      }
      expect(payload!.byteLength).toBe(12);
      const view = new DataView(payload!.buffer, payload!.byteOffset, payload!.byteLength);
      expect(view.getUint16(0, true), "cSic").toBe(0);
      const next = records[index + 1]!;
      const entries =
        next[0] === "BrtBeginISXVIs"
          ? Array.from({ length: next[1]!.byteLength / 4 }, (_, slot) =>
              new DataView(next[1]!.buffer, next[1]!.byteOffset).getInt32(slot * 4, true)
            )
          : null;
      lines.push({ itemType: view.getUint8(2), entryCount: view.getUint32(4, true), entries });
    });
    expect(lines).toEqual([
      { itemType: 0x00, entryCount: 1, entries: [0] },
      { itemType: 0x00, entryCount: 1, entries: [1] },
      { itemType: 0x0d, entryCount: 1, entries: [0] },
      // `entries: null` is the absence of the record, which is not the same as an empty one.
      { itemType: 0x00, entryCount: 0, entries: null }
    ]);
    // The count agrees with the lines actually written.
    expect(payloadOf(sampleView(), "BrtBeginSXLIRws").getUint32(0, true)).toBe(3);
  });

  it("maps each aggregation through the record's own enumeration", () => {
    // The record and the model disagree about order: `count` is 1 here and `countNums` is 6, which is *not*
    // the order OOXML's `ST_DataConsolidateFunction` lists them in. A mapping by position would swap the two,
    // and a pivot table would quietly report a different number — no reader could detect it.
    const functionOf = (subtotal: string): number =>
      payloadOf(
        sampleView({ dataItems: [{ field: 1, subtotal, caption: "c" }] }),
        "BrtBeginSXDI"
      ).getUint32(4, true);
    expect(functionOf("sum")).toBe(0x00);
    expect(functionOf("count")).toBe(0x01);
    expect(functionOf("average")).toBe(0x02);
    expect(functionOf("max")).toBe(0x03);
    expect(functionOf("min")).toBe(0x04);
    expect(functionOf("product")).toBe(0x05);
    expect(functionOf("countNums")).toBe(0x06);
    expect(functionOf("stdDev")).toBe(0x07);
    expect(functionOf("stdDevP")).toBe(0x08);
    expect(functionOf("var")).toBe(0x09);
    expect(functionOf("varP")).toBe(0x0a);
    // An unknown name falls back to SUM rather than writing an out-of-range value.
    expect(functionOf("nonsense")).toBe(0x00);
  });

  it("knows every subtotal the model can hold, by the model's own spelling", () => {
    // This is the assertion that would have caught the real defect: the table was written with `stdDevp` and
    // `varp`, and the model spells them `stdDevP` and `varP`. A `stdDevP` metric therefore fell through to
    // SUM — a pivot table reporting a total where a standard deviation was asked for. The test that checked
    // it asserted the *misspelling*, so it agreed with the bug for as long as both existed.
    //
    // Driving the check from `VALID_SUBTOTALS` is what makes that impossible: a name the model accepts and
    // this encoder does not now fails here rather than aggregating as a sum.
    const fellBackToSum = [...VALID_SUBTOTALS].filter(
      subtotal =>
        subtotal !== "sum" &&
        payloadOf(
          sampleView({ dataItems: [{ field: 1, subtotal, caption: "c" }] }),
          "BrtBeginSXDI"
        ).getUint32(4, true) === 0x00
    );
    expect(fellBackToSum).toEqual([]);
  });

  it("lays out BrtBeginSXDI as twenty-five fixed bytes", () => {
    // The field table lists three consecutive rows all called `ifmt` plus a `reserved`, which does not add
    // up. The worked example's declared `0x3B` for a 34-byte caption is what resolves it: the `reserved` word
    // is *inside* the four-byte `PivotNumFmt`, not beside it. Two bytes too many here makes every record
    // after it in the part unreadable, so the fixed size is asserted directly.
    const payload = payloadOf(
      sampleView({ dataItems: [{ field: 1, subtotal: "sum", caption: "Sum of Quantity" }] }),
      "BrtBeginSXDI"
    );
    // 25 fixed plus 4 + 30 for a fifteen-character caption — the example's own 0x3B.
    expect(payload.byteLength).toBe(0x3b);
    // `fLoadDisplayName` is the last fixed byte, and the caption's character count follows it.
    expect(payload.getUint8(24)).toBe(1);
    expect(payload.getUint32(25, true)).toBe("Sum of Quantity".length);
  });

  it("sets exactly the flags Excel sets on a new pivot field", () => {
    // Read out of an XLSB Excel produced for this pivot. Asserted as one number rather than bit by bit,
    // because the defect was bit *positions*: the code read `0x1f | (1 << 9) | (1 << 11)` under a comment
    // naming `fOutline` and `fSubtotalAtTop`, which are bits 6 and 8. Bit 9 is `fServerBased` — a claim that
    // the field's items come from an ODBC or OLAP server, false for a cache over a worksheet range.
    expect(payloadOf(sampleView(), "BrtBeginSXVD").getUint32(8, true)).toBe(0x0004811f);
  });

  it("keeps every index in the part inside the collection it points at", () => {
    // Excel removes a PivotTable view for an index it cannot resolve, so these are audited together rather
    // than per record. `BrtBeginSXDI.isxvd` was -1 — a value an `ISXVD` cannot take — on the grounds that the
    // field is ignored for a normal `df`. "Ignored" is not "unvalidated".
    const records = pivotViewRecords(sampleView());
    const fieldCount = payloadOf(sampleView(), "BrtBeginSXVDs").getUint32(0, true);
    const itemCounts = records
      .filter(([name]) => name === "BrtBeginSXVIs")
      .map(([, payload]) => new DataView(payload!.buffer, payload!.byteOffset).getUint32(0, true));

    const dataItem = payloadOf(sampleView(), "BrtBeginSXDI");
    // `isxvdData` names the field being summarised; `isxvd` is the base field of a "difference from" format.
    expect(dataItem.getInt32(0, true)).toBeLessThan(fieldCount);
    expect(dataItem.getInt32(0, true)).toBeGreaterThanOrEqual(0);
    expect(dataItem.getInt32(12, true)).toBeGreaterThanOrEqual(0);
    expect(dataItem.getInt32(12, true)).toBeLessThan(fieldCount);

    // The row axis names fields; each pivot line entry names an item of the first of them.
    const rowFields = payloadOf(sampleView(), "BrtBeginISXVDRws");
    for (let index = 0; index < rowFields.getUint32(0, true); index += 1) {
      const field = rowFields.getInt32(4 + index * 4, true);
      expect(field).toBeGreaterThanOrEqual(0);
      expect(field).toBeLessThan(fieldCount);
    }
    for (const [name, payload] of records) {
      if (name !== "BrtBeginISXVIs" || payload === undefined || payload.byteLength === 0) {
        continue;
      }
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      for (let offset = 0; offset < payload.byteLength; offset += 4) {
        expect(view.getInt32(offset, true)).toBeLessThan(itemCounts[0]!);
      }
    }
  });

  it("selects (All) on a page field rather than its first item", () => {
    // The intent is right and this test used to assert the wrong encoding of it: `isxvi` of **-1** was read
    // as "(All)", by analogy with the many `ISXVD`/`ISXDI` indices where -1 does mean "none". `isxvi` is not
    // one of them — 2.4.256 admits only an item index in `0x00000000`–`0x00100000`, or `0x001000FE` to defer
    // to the page-filtering rules, which is how "no single item picked" is actually spelled. So the test
    // pinned a value outside the field's domain, and did so *convincingly*, which is why it survived.
    //
    // What it got right, and what is kept: writing 0 here would filter the whole table to the first item.
    const withPages = sampleView({
      fields: [
        { name: "Region", itemCount: 2, axis: "page" },
        { name: "Units", itemCount: 0, axis: "data" }
      ],
      rowFields: [],
      pageFields: [0]
    });
    const payload = payloadOf(withPages, "BrtBeginSXPI");
    expect(payload.getUint32(0, true)).toBe(0);
    expect(payload.getUint32(4, true)).toBe(0x001000fe);
    expect(payload.getUint32(4, true)).not.toBe(0);
  });

  it("omits an axis collection that has no fields", () => {
    // This asserted the opposite — that a `BrtBeginISXVDCols` with a count of zero was written, "because the
    // collections are positional in the part". They are not: every record carries its own identifier, so a
    // reader dispatches on that rather than on position. Excel omits both of these for a pivot with no column
    // and no page fields, and writing them cost the view.
    const names = pivotViewRecords(sampleView()).map(([name]) => name);
    expect(names).not.toContain("BrtBeginISXVDCols");
    expect(names).not.toContain("BrtBeginSXPIs");
    expect(names).toContain("BrtBeginISXVDRws");
  });

  it("puts one line on the column axis even with no column fields", () => {
    // The data field sits on the column axis, so that line is where its values are read from. The XLSX writer
    // says the same with `<colItems count="1"><i/></colItems>` and notes that omitting it causes repairs.
    expect(payloadOf(sampleView(), "BrtBeginSXLICols").getUint32(0, true)).toBe(1);
  });

  it("agrees with itself about how many data items there are", () => {
    const view = sampleView({
      dataItems: [
        { field: 1, subtotal: "sum", caption: "a" },
        { field: 1, subtotal: "count", caption: "b" }
      ]
    });
    expect(payloadOf(view, "BrtBeginSXDIs").getUint32(0, true)).toBe(
      pivotViewRecords(view).filter(([name]) => name === "BrtBeginSXDI").length
    );
  });
});

describe("end to end, a pivot table written into an XLSB package", () => {
  /** A workbook with one pivot table over a small source range, written to XLSB. */
  async function written(): Promise<Map<string, { data: Uint8Array }>> {
    const workbook = Workbook.create();
    const data = Workbook.addWorksheet(workbook, "Data");
    Worksheet.addAoa(data, [
      ["Region", "Units"],
      ["APAC", 10],
      ["EMEA", 20],
      ["APAC", 30]
    ]);
    const sheet = Workbook.addWorksheet(workbook, "Pivot");
    Pivot.add(sheet, {
      sourceSheet: data,
      rows: ["Region"],
      columns: [],
      values: ["Units"],
      metric: "sum"
    });
    return extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
  }

  /** The payload of the named record in the named part. */
  function recordIn(
    parts: Map<string, { data: Uint8Array }>,
    path: string,
    name: string
  ): DataView {
    for (const entry of iterateInterpretableRecords(parts.get(path)!.data, "s")) {
      if (recordSpec(entry.id)?.name === name && entry.payload !== undefined) {
        return new DataView(entry.payload.buffer, entry.payload.byteOffset, entry.payload.length);
      }
    }
    throw new Error(`no ${name} in ${path}`);
  }

  /** How many records of a name a part carries. */
  function countIn(parts: Map<string, { data: Uint8Array }>, path: string, name: string): number {
    let total = 0;
    for (const entry of iterateInterpretableRecords(parts.get(path)!.data, "s")) {
      if (recordSpec(entry.id)?.name === name) {
        total += 1;
      }
    }
    return total;
  }

  it("writes all four parts and nothing halfway", async () => {
    // The parts are planned together because the specification requires one cache definition *per*
    // `BrtBeginPivotCacheID` record in the workbook — a package with some and not others points at things it
    // does not contain, which Excel offers to repair.
    const parts = await written();
    expect([...parts.keys()].filter(name => /pivot/i.test(name)).sort()).toEqual([
      "xl/pivotCache/_rels/pivotCacheDefinition1.bin.rels",
      "xl/pivotCache/pivotCacheDefinition1.bin",
      "xl/pivotCache/pivotCacheRecords1.bin",
      "xl/pivotTables/_rels/pivotTable1.bin.rels",
      "xl/pivotTables/pivotTable1.bin"
    ]);
  });

  it("declares each part's own content type", async () => {
    // Every pivot part is a `.bin`, so the package-level `Default` already describes it — as a *workbook*.
    // Without an `Override` the part is announced as the wrong thing.
    const contentTypes = new TextDecoder().decode(parts_(await written()));
    expect(contentTypes).toContain(
      '<Override PartName="/xl/pivotTables/pivotTable1.bin" ContentType="application/vnd.ms-excel.pivotTable"/>'
    );
    expect(contentTypes).toContain("application/vnd.ms-excel.pivotCacheDefinition");
    expect(contentTypes).toContain("application/vnd.ms-excel.pivotCacheRecords");
  });

  it("joins the four parts with relationships at all three levels", async () => {
    // sheet → view → cache definition → records. Each level is a separate `.rels`, and a break anywhere
    // leaves the parts present and unreachable.
    const parts = await written();
    const text = (path: string): string => new TextDecoder().decode(parts.get(path)!.data);
    expect(text("xl/_rels/workbook.bin.rels")).toContain("pivotCache/pivotCacheDefinition1.bin");
    expect(text("xl/pivotTables/_rels/pivotTable1.bin.rels")).toContain(
      "../pivotCache/pivotCacheDefinition1.bin"
    );
    expect(text("xl/pivotCache/_rels/pivotCacheDefinition1.bin.rels")).toContain(
      "pivotCacheRecords1.bin"
    );
    const sheetRels = [...parts.keys()].filter(name =>
      /worksheets\/_rels\/sheet\d+\.bin\.rels$/.test(name)
    );
    expect(sheetRels.some(name => text(name).includes("../pivotTables/pivotTable1.bin"))).toBe(
      true
    );
  });

  it("matches idSx in the workbook against idCache in the view", async () => {
    // The binding. A mismatch leaves a view referring to a cache that is in the package under another id,
    // and the pivot table shows nothing — no reader can detect it from either part alone.
    const parts = await written();
    expect(recordIn(parts, "xl/workbook.bin", "BrtBeginPivotCacheID").getUint32(0, true)).toBe(
      recordIn(parts, "xl/pivotTables/pivotTable1.bin", "BrtBeginSXView").getUint32(28, true)
    );
  });

  it("matches cRecords against the rows actually written, in both places", async () => {
    const parts = await written();
    const rows = countIn(parts, "xl/pivotCache/pivotCacheRecords1.bin", "BrtPCRRecord");
    expect(rows).toBe(3);
    expect(
      recordIn(parts, "xl/pivotCache/pivotCacheDefinition1.bin", "BrtBeginPivotCacheDef").getUint32(
        17,
        true
      )
    ).toBe(rows);
    expect(
      recordIn(
        parts,
        "xl/pivotCache/pivotCacheRecords1.bin",
        "BrtBeginPivotCacheRecords"
      ).getUint32(0, true)
    ).toBe(rows);
  });

  it("gives the view one pivot field per cache field", async () => {
    // The axis collections index into `BrtBeginSXVDs`, so a view with fewer fields than the cache makes every
    // index after the gap point at the wrong field.
    const parts = await written();
    expect(
      recordIn(parts, "xl/pivotTables/pivotTable1.bin", "BrtBeginSXVDs").getUint32(0, true)
    ).toBe(countIn(parts, "xl/pivotCache/pivotCacheDefinition1.bin", "BrtBeginPCDField"));
  });

  it("keeps every cache-record index inside its field's item collection", async () => {
    // An index past the collection is a corrupt record rather than a lossy one: the reader follows it into
    // whatever happens to be at that offset.
    const parts = await written();
    const items = recordIn(
      parts,
      "xl/pivotCache/pivotCacheDefinition1.bin",
      "BrtBeginPCDFAtbl"
    ).getUint32(2, true);
    expect(items).toBe(2);
    for (const entry of iterateInterpretableRecords(
      parts.get("xl/pivotCache/pivotCacheRecords1.bin")!.data,
      "s"
    )) {
      if (recordSpec(entry.id)?.name !== "BrtPCRRecord") {
        continue;
      }
      const payload = new DataView(entry.payload!.buffer, entry.payload!.byteOffset);
      expect(payload.getUint32(0, true)).toBeLessThan(items);
    }
  });

  it("writes a shared cache once, and keeps idSx unique", async () => {
    // Two views built from the same source carry the same `cacheId`, and `BrtBeginPivotCacheID.idSx` MUST be
    // unique in its collection. Writing a cache per *view* produced two bindings with the same id — a
    // malformed workbook that this suite did not catch, because nothing exercised a shared cache. The XLSX
    // writer dedupes by `cacheId` for exactly this reason.
    const workbook = Workbook.create();
    const data = Workbook.addWorksheet(workbook, "Data");
    Worksheet.addAoa(data, [
      ["Region", "Units"],
      ["APAC", 10],
      ["EMEA", 20]
    ]);
    const first = Pivot.add(Workbook.addWorksheet(workbook, "P1"), {
      sourceSheet: data,
      rows: ["Region"],
      columns: [],
      values: ["Units"],
      metric: "sum"
    });
    const second = Pivot.add(Workbook.addWorksheet(workbook, "P2"), {
      sourceSheet: data,
      rows: ["Region"],
      columns: [],
      values: ["Units"],
      metric: "count"
    });
    second.cacheId = first.cacheId;
    const parts = extractedFrom(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const resolved = await parts;
    // Two views, one cache.
    expect([...resolved.keys()].filter(name => /pivotTable\d+\.bin$/.test(name))).toHaveLength(2);
    expect(
      [...resolved.keys()].filter(name => /pivotCacheDefinition\d+\.bin$/.test(name))
    ).toHaveLength(1);
    const ids: number[] = [];
    for (const entry of iterateInterpretableRecords(resolved.get("xl/workbook.bin")!.data, "s")) {
      if (recordSpec(entry.id)?.name === "BrtBeginPivotCacheID") {
        ids.push(new DataView(entry.payload!.buffer, entry.payload!.byteOffset).getUint32(0, true));
      }
    }
    expect(ids).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    // And both views still point at a cache definition that exists — a dedupe that left one dangling would
    // be a worse failure than the duplicate it replaced.
    const decoder = new TextDecoder();
    for (const name of [...resolved.keys()].filter(key => /pivotTables\/_rels/.test(key))) {
      const target = /Target="([^"]*)"/.exec(decoder.decode(resolved.get(name)!.data))![1]!;
      expect(resolved.has(`xl/pivotCache/${target.split("/").pop()}`)).toBe(true);
    }
  });

  it("reports no loss, because the pivot table is written", async () => {
    const workbook = Workbook.create();
    const data = Workbook.addWorksheet(workbook, "Data");
    Worksheet.addAoa(data, [
      ["Region", "Units"],
      ["APAC", 10]
    ]);
    const sheet = Workbook.addWorksheet(workbook, "Pivot");
    Pivot.add(sheet, {
      sourceSheet: data,
      rows: ["Region"],
      columns: [],
      values: ["Units"],
      metric: "sum"
    });
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
  });
});

/** `[Content_Types].xml`, which every one of these packages has. */
function parts_(parts: Map<string, { data: Uint8Array }>): Uint8Array {
  return parts.get("[Content_Types].xml")!.data;
}

/** `extractAll`, named so the shared-cache test reads without a nested await in an expression. */
function extractedFrom(bytes: Uint8Array): Promise<Map<string, { data: Uint8Array }>> {
  return extractAll(bytes);
}

/**
 * The two writers, on one model.
 *
 * Three of the defects that stopped Excel opening an XLSB pivot table were found by writing the same workbook
 * both ways and reading the difference: a cache field with no type record, a column axis with no line, and a
 * body one row taller than the XLSX form claimed. None of them was visible from inside the XLSB writer, whose
 * output was internally consistent and matched every field list in `[MS-XLSB]`.
 *
 * So this is the gate that would have caught them. It is not a round trip and not a schema check — it asks
 * whether this library tells the same story about one pivot table in its two output formats, and a
 * disagreement is a defect in one of them regardless of which.
 */
describe("XLSB and XLSX agree about the same pivot table", () => {
  /** A workbook with one two-column source range and one pivot table over it. */
  async function bothFormats(): Promise<{ xlsb: Uint8Array; xlsx: Uint8Array }> {
    const build = (): ReturnType<typeof Workbook.create> => {
      const workbook = Workbook.create();
      const source = Workbook.addWorksheet(workbook, "S");
      Worksheet.addAoa(source, [
        ["Region", "Units"],
        ["APAC", 10],
        ["EMEA", 20]
      ]);
      Pivot.add(Workbook.addWorksheet(workbook, "P"), {
        sourceSheet: source,
        rows: ["Region"],
        columns: [],
        values: ["Units"],
        metric: "sum"
      });
      return workbook;
    };
    return {
      xlsb: await Workbook.toBuffer(build(), { format: "xlsb" }),
      xlsx: await Workbook.toBuffer(build(), { format: "xlsx" })
    };
  }

  it("claims the same rectangle for the pivot body", async () => {
    const { xlsb, xlsx } = await bothFormats();

    const xml = new TextDecoder().decode(
      (await extractAll(xlsx)).get("xl/pivotTables/pivotTable1.xml")!.data
    );
    const location =
      /<location ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*firstHeaderRow="(\d+)"[^>]*firstDataRow="(\d+)"[^>]*firstDataCol="(\d+)"/.exec(
        xml
      );
    expect(location, "XLSX location").not.toBeNull();
    const [, firstColumn, firstRow, lastColumn, lastRow, headerOffset, dataOffset, columnOffset] =
      location!;
    const letterToIndex = (letters: string): number =>
      [...letters].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0) - 1;

    let payload: Uint8Array | undefined;
    for (const entry of iterateInterpretableRecords(
      (await extractAll(xlsb)).get("xl/pivotTables/pivotTable1.bin")!.data,
      "s"
    )) {
      if (recordSpec(entry.id)?.name === "BrtBeginSXLocation") {
        payload = entry.payload;
        break;
      }
    }
    expect(payload, "XLSB BrtBeginSXLocation").toBeDefined();
    const view = new DataView(payload!.buffer, payload!.byteOffset, payload!.byteLength);

    // XLSX rows and columns are one-based and its three offsets are relative to the range's top left; the
    // binary form is zero-based and absolute. Converting one to the other is the whole comparison.
    const rowFirst = Number(firstRow) - 1;
    const columnFirst = letterToIndex(firstColumn);
    expect(view.getUint32(0, true)).toBe(rowFirst);
    expect(view.getUint32(8, true)).toBe(columnFirst);
    expect(view.getUint32(12, true)).toBe(letterToIndex(lastColumn));
    expect(view.getUint32(16, true)).toBe(rowFirst + Number(headerOffset));
    expect(view.getUint32(20, true)).toBe(rowFirst + Number(dataOffset));
    expect(view.getUint32(24, true)).toBe(columnFirst + Number(columnOffset));

    // **The last row is deliberately not required to match**, and that is a fact about the two formats rather
    // than a gap in this check. XLSX may claim a minimal rectangle and leave the real extent to Excel's
    // refresh — its writer says so, emitting "header + 1 data row placeholder" — and Excel accepts it. The
    // binary form does not get that latitude: it enumerates its pivot lines, so its rectangle has to span
    // them. An XLSB whose extent matched this XLSX exactly had its view removed.
    //
    // So the assertion is that the binary claims at least as much as the XML, and everything above it — the
    // origin, the width, and all three interior offsets — still has to agree exactly.
    expect(view.getUint32(4, true)).toBeGreaterThanOrEqual(Number(lastRow) - 1);
  });

  it("describes every cache field's type in both, including one with no shared items", async () => {
    const { xlsb, xlsx } = await bothFormats();
    // Two `<sharedItems>`, one per cache field — the numeric one carries type flags and bounds but no items.
    const xml = new TextDecoder().decode(
      (await extractAll(xlsx)).get("xl/pivotCache/pivotCacheDefinition1.xml")!.data
    );
    expect(xml.match(/<sharedItems/g)).toHaveLength(2);

    const names = [
      ...iterateInterpretableRecords(
        (await extractAll(xlsb)).get("xl/pivotCache/pivotCacheDefinition1.bin")!.data,
        "w"
      )
    ].map(entry => recordSpec(entry.id)?.name);
    expect(names.filter(name => name === "BrtBeginPCDFAtbl")).toHaveLength(2);
    expect(names.filter(name => name === "BrtBeginPCDField")).toHaveLength(2);
  });

  it("puts one line on the column axis in both", async () => {
    const { xlsb, xlsx } = await bothFormats();
    const xml = new TextDecoder().decode(
      (await extractAll(xlsx)).get("xl/pivotTables/pivotTable1.xml")!.data
    );
    expect(xml).toContain('<colItems count="1"');

    let columns: number | undefined;
    for (const entry of iterateInterpretableRecords(
      (await extractAll(xlsb)).get("xl/pivotTables/pivotTable1.bin")!.data,
      "s"
    )) {
      if (recordSpec(entry.id)?.name === "BrtBeginSXLICols") {
        const payload = entry.payload!;
        columns = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
      }
    }
    expect(columns).toBe(1);
  });
});
