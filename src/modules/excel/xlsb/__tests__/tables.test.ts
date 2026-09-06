import { extractAll } from "@archive/unzip/extract";
/**
 * Tables.
 *
 * No corpus workbook contains a `BrtBeginList`, so the layout here is not read off Excel's bytes — but
 * MS-XLSB carries a **worked example** for both records (sections 3.3.4 and 3.3.6), and the byte-level
 * assertions below are against that example rather than against a field list. The example's
 * `BrtBeginListCol` is 0x38 bytes and the arithmetic closes exactly, which pins the field order and the
 * four-byte width of a null `XLNullableWideString` at the same time.
 */
import { Cell, Table, Workbook } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { encodeTablePart, readTablePart, type SheetTable } from "@excel/xlsb/tables";
import { describe, expect, it } from "vitest";

/**
 * A three-column table matching the shape of the specification's example.
 *
 * Typed as `SheetTable` rather than `as const`: the latter narrows `totalsRow` to the literal `false`,
 * so every spread that flips it stops type-checking.
 */
const EXAMPLE: SheetTable = {
  ref: "A1:C9",
  name: "Table1",
  headerRow: true,
  totalsRow: false,
  id: 1,
  columns: [{ name: "Item" }, { name: "Qty" }, { name: "Note" }]
};

function recordsOf(bytes: Uint8Array) {
  return [...iterateInterpretableRecords(bytes, "test")].map(entry => ({
    name: recordSpec(entry.id)?.name,
    payload: entry.payload
  }));
}

describe("table part structure", () => {
  /**
   * Two `BrtBeginList` fields whose right value is the *container's default*, not something a model states.
   *
   * Both were answered from the model and both came out wrong against Excel, in the same direction: the XLSX
   * writer expresses the default by leaving an attribute out, and the XLSB writer has no "leave it out" — it
   * must write the resolved value, and it wrote the other one.
   */
  describe("defaults Excel and the XLSX writer agree on", () => {
    /** `BrtBeginList`'s payload for a table, as a `DataView`. */
    function header(table: SheetTable): DataView {
      const payload = recordsOf(encodeTablePart(table)!).find(
        entry => entry.name === "BrtBeginList"
      )!.payload!;
      return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    }

    it("sets fShownTotalRow even for a table with no totals row", () => {
      // "Ever been shown" is not "is shown", and this wrote the second answer. `CT_Table/@totalsRowShown`
      // defaults to `1` and the XLSX writer omits it, so an XLSX from here said yes while its XLSB said no.
      // Excel's own record for a table with `crwTotals = 0` carries `fShownTotalRow = 1`.
      expect(header({ ...EXAMPLE, totalsRow: false }).getUint32(28, true)).toBe(0);
      expect(header({ ...EXAMPLE, totalsRow: false }).getUint32(32, true) & 0x01).toBe(1);
      expect(header({ ...EXAMPLE, totalsRow: true }).getUint32(32, true) & 0x01).toBe(1);
    });

    it("writes stComment as the empty string, not NULL", () => {
      // Section 3.3.2 is explicit — "The empty string specifies that there is no comment" — and NULL is what
      // the field is for when `fSingleCell` is 1, where the specification requires it. The two are the same
      // four bytes on the wire, which is why no size assertion here ever noticed the difference.
      const payload = recordsOf(encodeTablePart(EXAMPLE)!).find(
        entry => entry.name === "BrtBeginList"
      )!.payload!;
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      // `stName`, then `stDisplayName`, then `stComment`, each a count followed by UTF-16 units.
      let at = 64;
      for (let field = 0; field < 2; field += 1) {
        const count = view.getUint32(at, true);
        at += 4 + (count === 0xffffffff ? 0 : count * 2);
      }
      expect(view.getUint32(at, true)).toBe(0);
      expect(view.getUint32(at, true)).not.toBe(0xffffffff);
    });
  });

  it("nests the records the way Excel does", () => {
    // **Excel's order, not the ABNF's alone.** Taken from a table Excel wrote for the oracle case: the
    // filter comes before the column collection and the style client after it, both inside `BrtBeginList`.
    // This asserted a nine-record sequence that was missing both, which is how a table went out unstyled and
    // unfilterable while the same table in an XLSX had `<autoFilter>` and `<tableStyleInfo>`.
    expect(recordsOf(encodeTablePart(EXAMPLE)!).map(entry => entry.name)).toEqual([
      "BrtBeginList",
      "BrtBeginAFilter",
      "BrtEndAFilter",
      "BrtBeginListCols",
      "BrtBeginListCol",
      "BrtEndListCol",
      "BrtBeginListCol",
      "BrtEndListCol",
      "BrtBeginListCol",
      "BrtEndListCol",
      "BrtEndListCols",
      "BrtTableStyleClient",
      "BrtEndList"
    ]);
  });

  it("matches the size of the specification's worked BrtBeginListCol", () => {
    // Section 3.3.6: 0x38 bytes for a column whose caption is "Item" and whose other five strings are
    // null. That is `24 + 4 + 12 + 4 + 4 + 4 + 4`, and it only adds up if a null `XLNullableWideString`
    // is four bytes and the six fixed fields come first in the stated order.
    const column = recordsOf(encodeTablePart(EXAMPLE)!).find(
      entry => entry.name === "BrtBeginListCol"
    )!;
    expect(column.payload).toHaveLength(0x38);
    const view = new DataView(column.payload.buffer, column.payload.byteOffset);
    expect(view.getUint32(0, true)).toBe(1); // idField
    expect(view.getUint32(4, true)).toBe(0); // ilta = ILTA_NONE
    expect(view.getUint32(8, true)).toBe(0xffffffff); // nDxfHdr
    expect(view.getUint32(12, true)).toBe(0xffffffff); // nDxfInsertRow
    expect(view.getUint32(16, true)).toBe(0xffffffff); // nDxfAgg
    expect(view.getUint32(20, true)).toBe(0); // idqsif
    // `stName` is NULL for a standard table, and the caption carries the header text. Reversing the two
    // produces a table whose headers are blank, which the specification's example states explicitly.
    expect(view.getUint32(24, true)).toBe(0xffffffff);
  });

  it("writes a DXFId of none as 0xFFFFFFFF, not zero", () => {
    // Zero is a valid index into the differential-format table, so zeroed fields would claim every
    // table is formatted by whatever happens to be first in it.
    const header = recordsOf(encodeTablePart(EXAMPLE)!).find(
      entry => entry.name === "BrtBeginList"
    )!;
    const view = new DataView(header.payload.buffer, header.payload.byteOffset);
    // 16 bytes of range, then lt, idList, crwHeader, crwTotals, flags — so the six DXFIds start at 36
    // and run to 59, with dwConnID after them.
    for (let offset = 36; offset < 60; offset += 4) {
      expect(view.getUint32(offset, true), `offset ${offset}`).toBe(0xffffffff);
    }
  });

  it("writes crwHeader and crwTotals as whole Booleans, not flag bits", () => {
    const view = (table: SheetTable) => {
      const header = recordsOf(encodeTablePart(table)!).find(
        entry => entry.name === "BrtBeginList"
      )!;
      return new DataView(header.payload.buffer, header.payload.byteOffset);
    };
    // 16 bytes of range, then `lt`, `idList`, `crwHeader`, `crwTotals`.
    expect(view(EXAMPLE).getUint32(16, true)).toBe(0); // lt = LTRANGE
    expect(view(EXAMPLE).getUint32(20, true)).toBe(1); // idList
    expect(view(EXAMPLE).getUint32(24, true)).toBe(1); // crwHeader
    expect(view(EXAMPLE).getUint32(28, true)).toBe(0); // crwTotals
    const withTotals = { ...EXAMPLE, totalsRow: true };
    expect(view(withTotals).getUint32(28, true)).toBe(1);
    // `fShownTotalRow` at bit 0 of the flag word that follows.
    expect(view(withTotals).getUint32(32, true) & 0x01).toBe(1);
  });

  it("maps the totals function by name, because the two orders differ", () => {
    // The record counts `none, average, count, countNums, max, min, sum, stdDev, var, custom`; the
    // model's union reads `none, average, countNums, count, max, min, stdDev, var, sum, custom`. Two
    // pairs are transposed and `sum` moves three places, so an index-for-index mapping turns a column's
    // average into a count.
    const expected: readonly [string, number][] = [
      ["average", 1],
      ["count", 2],
      ["countNums", 3],
      ["max", 4],
      ["min", 5],
      ["sum", 6],
      ["stdDev", 7],
      ["var", 8],
      ["custom", 9]
    ];
    for (const [name, value] of expected) {
      const bytes = encodeTablePart({
        ...EXAMPLE,
        columns: [{ name: "C", totalsRowFunction: name as never }]
      })!;
      const column = recordsOf(bytes).find(entry => entry.name === "BrtBeginListCol")!;
      expect(
        new DataView(column.payload.buffer, column.payload.byteOffset).getUint32(4, true),
        name
      ).toBe(value);
    }
  });

  it("round-trips the header and the columns", () => {
    const back = readTablePart(
      encodeTablePart({ ...EXAMPLE, columns: [{ name: "Item" }, { name: "Qty" }] })!,
      "test",
      iterateInterpretableRecords,
      id => recordSpec(id)?.name
    );
    expect(back).toMatchObject({
      ref: "A1:C9",
      name: "Table1",
      headerRow: true,
      totalsRow: false,
      columns: [{ name: "Item" }, { name: "Qty" }]
    });
  });

  it("round-trips a totals function", () => {
    const back = readTablePart(
      encodeTablePart({
        ...EXAMPLE,
        totalsRow: true,
        columns: [{ name: "Qty", totalsRowFunction: "sum" }]
      })!,
      "test",
      iterateInterpretableRecords,
      id => recordSpec(id)?.name
    );
    expect(back?.columns[0]).toMatchObject({ name: "Qty", totalsRowFunction: "sum" });
    expect(back?.totalsRow).toBe(true);
  });

  it("refuses a table with no range or no columns", () => {
    // `BrtBeginList` requires a range, and a table with no columns has nothing to describe. Returning
    // `undefined` lets the caller report it and still write the sheet.
    expect(encodeTablePart({ ...EXAMPLE, columns: [] })).toBeUndefined();
    expect(encodeTablePart({ ...EXAMPLE, ref: "not a range" })).toBeUndefined();
  });
});

describe("tables through a workbook", () => {
  it("writes the part, declares it, and links it from the sheet", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Table.add(sheet, {
      name: "Sales",
      ref: "A1:C4",
      headerRow: true,
      columns: [{ name: "Item" }, { name: "Qty" }, { name: "Note" }],
      rows: [
        ["a", 1, "x"],
        ["b", 2, "y"],
        ["c", 3, "z"]
      ]
    } as never);
    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    const parts = await extractAll(bytes);
    expect([...parts.keys()]).toContain("xl/tables/table1.bin");
    // A `.bin` is covered by this writer's `Default` with the *workbook's* type, so without an override
    // the table is described as a second workbook.
    const declared = new TextDecoder().decode(parts.get("[Content_Types].xml")!.data);
    expect(declared).toContain('PartName="/xl/tables/table1.bin"');
    expect(declared).toContain("application/vnd.ms-excel.table");
    // Nothing in the worksheet's records names a table, so the relationship is the only link there is.
    const rels = new TextDecoder().decode(parts.get("xl/worksheets/_rels/sheet1.bin.rels")!.data);
    expect(rels).toContain("../tables/table1.bin");
  });

  it("round-trips a table through a workbook", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Table.add(sheet, {
      name: "Sales",
      ref: "A1:B3",
      headerRow: true,
      columns: [{ name: "Item" }, { name: "Qty", totalsRowFunction: "sum" }],
      rows: [
        ["a", 1],
        ["b", 2]
      ]
    } as never);
    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);
    const tables = (
      Workbook.getModel(reopened).worksheets[0] as unknown as {
        tables?: { name: string; ref: string; columns: { name: string }[] }[];
      }
    ).tables;
    expect(tables).toHaveLength(1);
    expect(tables![0]).toMatchObject({
      name: "Sales",
      ref: "A1:B3",
      columns: [{ name: "Item" }, { name: "Qty", totalsRowFunction: "sum" }]
    });
  });

  it("numbers the parts across the workbook, not within a sheet", async () => {
    // `idList` must be unique across the whole workbook, and so must the part number — two sheets each
    // with one table would otherwise both write `table1.bin`.
    const workbook = Workbook.create();
    for (const [sheetName, tableName] of [
      ["S1", "First"],
      ["S2", "Second"]
    ] as const) {
      const sheet = Workbook.addWorksheet(workbook, sheetName);
      Table.add(sheet, {
        name: tableName,
        ref: "A1:A2",
        headerRow: true,
        columns: [{ name: "Item" }],
        rows: [["a"]]
      } as never);
    }
    const parts = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    expect([...parts.keys()].filter(path => path.startsWith("xl/tables/")).sort()).toEqual([
      "xl/tables/table1.bin",
      "xl/tables/table2.bin"
    ]);
  });

  it("writes no table part for a sheet with none", async () => {
    const workbook = Workbook.create();
    Workbook.addWorksheet(workbook, "S");
    const parts = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    expect([...parts.keys()].some(path => path.includes("tables"))).toBe(false);
  });
});

describe("structured references", () => {
  /** A workbook with one table and a set of formulas referring to it. */
  async function withTable(formulas: readonly (readonly [string, string])[]) {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Table.add(sheet, {
      name: "Sales",
      ref: "A1:C4",
      headerRow: true,
      columns: [{ name: "Item" }, { name: "Qty" }, { name: "Note" }],
      rows: [
        ["a", 1, "x"],
        ["b", 2, "y"],
        ["c", 3, "z"]
      ]
    } as never);
    for (const [address, formula] of formulas) {
      Cell.setValue(sheet, address, { formula } as never);
    }
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const back = Workbook.getWorksheet(reopened, "S")!;
    return new Map(
      formulas.map(([address]) => [
        address,
        (Cell.getValue(back, address) as { formula?: string } | undefined)?.formula
      ])
    );
  }

  /**
   * `PtgList` carries an `ixti`, and it must name the table's own sheet.
   *
   * **Every test above passes with `ixti` hard-coded to 0**, because `withTable` puts its table on the
   * *first* sheet — and 0 is the first entry of the extern-sheet table, which for this writer's identity
   * table is the first sheet. So the field was written as a literal 0 and nothing noticed until Excel
   * refused a workbook whose table sat on sheet 2, reporting a repair against the table part *and* against
   * `workbook.bin`, which is where the extern-sheet table lives.
   *
   * The assertion deliberately does **not** read the formula back. The decoder finds the table through
   * `listIndex` and discards `ixti` entirely — correctly, since a table id locates a table on its own — so
   * a round trip through this codec agrees with itself no matter what the field says. That is the same trap
   * as the operand classes and the function table, and the only way out is to resolve the emitted `ixti`
   * against the emitted `BrtExternSheet` and compare against the sheet name.
   */
  it("points a structured reference at the sheet its table is on", async () => {
    const workbook = Workbook.create();
    Workbook.addWorksheet(workbook, "First");
    const host = Workbook.addWorksheet(workbook, "Host");
    const user = Workbook.addWorksheet(workbook, "User");
    Table.add(host, {
      name: "Sales",
      ref: "A1:B3",
      headerRow: true,
      columns: [{ name: "Item" }, { name: "Qty" }],
      rows: [
        ["a", 1],
        ["b", 2]
      ]
    } as never);
    Cell.setValue(user, "A1", { formula: "SUM(Sales[Qty])" } as never);

    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const name = (id: number) => recordSpec(id)?.name;

    // The workbook's sheet order and its extern-sheet table, which together turn an `ixti` into a sheet.
    const sheets: string[] = [];
    const itabFirst: number[] = [];
    for (const record of iterateInterpretableRecords(parts.get("xl/workbook.bin")!.data, "w")) {
      const view = new DataView(record.payload.buffer, record.payload.byteOffset);
      if (name(record.id) === "BrtBundleSh") {
        const rel = view.getUint32(8, true);
        const at = 12 + (rel === 0xffffffff ? 0 : rel * 2);
        const length = view.getUint32(at, true);
        let text = "";
        for (let index = 0; index < length; index++) {
          text += String.fromCharCode(view.getUint16(at + 4 + index * 2, true));
        }
        sheets.push(text);
      }
      if (name(record.id) === "BrtExternSheet") {
        const count = view.getUint32(0, true);
        for (let index = 0; index < count; index++) {
          itabFirst.push(view.getInt32(4 + index * 12 + 4, true));
        }
      }
    }

    const resolved = new Set<string>();
    for (const path of [...parts.keys()].filter(key => /worksheets\/sheet\d+\.bin$/.test(key))) {
      for (const record of iterateInterpretableRecords(parts.get(path)!.data, "s")) {
        if (!(name(record.id) ?? "").startsWith("BrtFmla")) {
          continue;
        }
        const view = new DataView(record.payload.buffer, record.payload.byteOffset);
        const rgce = record.payload.slice(22, 22 + view.getUint32(18, true));
        for (let at = 0; at + 14 <= rgce.length; at++) {
          // `0x18` then the mandatory `eptg` `0x19` is a `PtgList`; `ixti` is the two bytes after it.
          if (rgce[at] !== 0x18 || rgce[at + 1] !== 0x19) {
            continue;
          }
          const ixti = rgce[at + 2]! | (rgce[at + 3]! << 8);
          resolved.add(sheets[itabFirst[ixti]!] ?? `<ixti ${ixti} out of range>`);
        }
      }
    }

    expect(resolved).toEqual(new Set(["Host"]));
  });

  it("round-trips a bare column reference", async () => {
    // The common case, and the one that would pass even if `rowType` were never written — `DATA` is 0.
    const back = await withTable([["E1", "SUM(Sales[Qty])"]]);
    expect(back.get("E1")).toBe("SUM(Sales[Qty])");
  });

  it("round-trips each row specifier", async () => {
    // These are what `rowType` exists for, and each is a different value: `#All` is 1, `#Headers` 2,
    // `#Totals` 8. Writing 0 for all of them would leave the bare case correct and these three wrong.
    const back = await withTable([
      ["E1", "SUM(Sales[[#All],[Qty]])"],
      ["E2", "SUM(Sales[[#Headers],[Qty]])"],
      ["E3", "SUM(Sales[[#Totals],[Qty]])"]
    ]);
    expect(back.get("E1")).toBe("SUM(Sales[[#All],[Qty]])");
    expect(back.get("E2")).toBe("SUM(Sales[[#Headers],[Qty]])");
    expect(back.get("E3")).toBe("SUM(Sales[[#Totals],[Qty]])");
  });

  it("round-trips a whole-table reference", async () => {
    // `columns = 0`, and `colFirst`/`colLast` are then unused — so a reader that trusted them would
    // report the first column instead of the whole table.
    const back = await withTable([["E1", "COUNTA(Sales[])"]]);
    expect(back.get("E1")).toBe("COUNTA(Sales[])");
  });

  it("normalises a column span into a column list", async () => {
    // A real difference from XLSX, and not a codec fault: `[[Qty]:[Note]]` and `[[Qty],[Note]]` parse to
    // the same `StructuredRefNode`, so the AST cannot tell them apart and `printAst` prints the comma
    // form. XLSX stores the formula as text and returns it verbatim; XLSB stores tokens.
    //
    // Asserted rather than left undocumented, because a caller comparing the two containers will see it.
    const back = await withTable([["E1", "SUM(Sales[[Qty]:[Note]])"]]);
    expect(back.get("E1")).toBe("SUM(Sales[[Qty],[Note]])");
  });

  it("refuses a reference to a table the workbook does not define", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", { formula: "SUM(Missing[Qty])" } as never);
    // Named rather than written with a guessed id: an `idList` matching no `BrtBeginList` is a reference
    // Excel reports as broken, which is worse than a reported loss.
    // Reported through the loss list, which is how every other unencodable construct is reported — the
    // write refuses under the default and names the reason.
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(/cannot express/);
    const report = await Workbook.toBuffer(workbook, { format: "xlsb" }).catch(
      (cause: unknown) => cause
    );
    expect(JSON.stringify((report as { items?: string[] }).items)).toContain("Missing");
  });

  it("refuses a column the table does not have", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Table.add(sheet, {
      name: "Sales",
      ref: "A1:A2",
      headerRow: true,
      columns: [{ name: "Item" }],
      rows: [["a"]]
    } as never);
    Cell.setValue(sheet, "E1", { formula: "SUM(Sales[Nope])" } as never);
    const report = await Workbook.toBuffer(workbook, { format: "xlsb" }).catch(
      (cause: unknown) => cause
    );
    expect(JSON.stringify((report as { items?: string[] }).items)).toContain(
      "column Sales does not have"
    );
  });

  it("resolves a table on another sheet", async () => {
    // The reason the ids are assigned before any sheet is written: a formula on sheet 1 may reference a
    // table on sheet 2, and the encoder needs the id while the first sheet is being serialised.
    const workbook = Workbook.create();
    const first = Workbook.addWorksheet(workbook, "First");
    const second = Workbook.addWorksheet(workbook, "Second");
    Table.add(second, {
      name: "Remote",
      ref: "A1:B3",
      headerRow: true,
      columns: [{ name: "Item" }, { name: "Qty" }],
      rows: [
        ["a", 1],
        ["b", 2]
      ]
    } as never);
    Cell.setValue(first, "A1", { formula: "SUM(Remote[Qty])" } as never);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(
      (
        Cell.getValue(Workbook.getWorksheet(reopened, "First")!, "A1") as
          | { formula?: string }
          | undefined
      )?.formula
    ).toBe("SUM(Remote[Qty])");
  });
});
