/**
 * The two writers must describe one model the same way.
 *
 * This file exists because the same defect appeared five times in a row, always in the same shape: a fact about
 * a workbook is decided independently by the XLSX writer and the XLSB writer, they disagree, and only one of
 * them is the version Excel accepts. Nothing caught any of them, because each writer is self-consistent and the
 * XLSB round-trips through its own reader perfectly.
 *
 * The five:
 *
 * | Fact                                   | XLSX                            | XLSB (before)                     |
 * | -------------------------------------- | ------------------------------- | --------------------------------- |
 * | a theme part exists                    | `theme1.xml` written            | nothing — 252 dangling references |
 * | the default font's colour              | `<color theme="1"/>`            | automatic, palette index 64       |
 * | the data field's place on an axis       | `colFields` gets `x="-2"`       | column axis omitted entirely      |
 * | where a pivot body starts               | anchor + one row per filter + 1 | the anchor row itself             |
 * | a pivot field's default subtotal        | `defaultSubtotal` left true     | `fDefault` clear for page fields  |
 *
 * So the assertions here compare *containers*, not a container against a constant. A constant can drift with
 * both writers at once; a comparison cannot. Where the two containers genuinely spell a fact differently — a
 * theme index in XML against a `BrtColor` kind in binary — the test translates one into the other and says so.
 *
 * These are not round-trip tests and must never become them. Reading back through this library's own reader is
 * exactly the check that passed while all five were broken.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Pivot, Workbook, Worksheet } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** Both containers for one workbook, as extracted archives. */
async function both(handle: Workbook.Handle): Promise<{
  readonly xlsx: Map<string, { data: Uint8Array }>;
  readonly xlsb: Map<string, { data: Uint8Array }>;
}> {
  return {
    xlsx: await extractAll(await Workbook.toBuffer(handle, { format: "xlsx" })),
    xlsb: await extractAll(
      await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" })
    )
  };
}

/** The first record with `name` in `part`. */
function firstRecord(part: Uint8Array, name: string): Uint8Array {
  for (const record of iterateInterpretableRecords(part, "w")) {
    if (recordSpec(record.id)?.name === name) {
      return record.payload;
    }
  }
  throw new Error(`no ${name} record`);
}

function withOneCell(): Workbook.Handle {
  const handle = Workbook.create();
  Cell.setValue(Workbook.addWorksheet(handle, "S"), "A1", 1);
  return handle;
}

describe("a theme part", () => {
  it("either exists in both containers or in neither", async () => {
    const parts = await both(withOneCell());
    const themes = (archive: Map<string, unknown>) =>
      [...archive.keys()].filter(path => path.startsWith("xl/theme/")).sort();
    expect(themes(parts.xlsb)).toEqual(themes(parts.xlsx));
  });
});

describe("the default font's colour", () => {
  it("is theme slot 1 in both containers", async () => {
    const parts = await both(withOneCell());

    const styles = new TextDecoder().decode(parts.xlsx.get("xl/styles.xml")!.data);
    const font = /<font>.*?<\/font>/s.exec(styles)![0];
    const themeIndex = /<color theme="(\d+)"\/>/.exec(font)?.[1];

    // `BrtColor`: `fValidRGB` in bit 0, the colour *kind* in bits 1-7, then the index. Kind 3 is a theme slot.
    const payload = firstRecord(parts.xlsb.get("xl/styles.bin")!.data, "BrtFont");
    const kind = payload[12]! >> 1;
    const slot = payload[13]!;

    expect(kind).toBe(3);
    expect(String(slot)).toBe(themeIndex);
  });
});

describe("a pivot table's geometry and axes", () => {
  function withPivot(options: {
    readonly values: readonly string[];
    readonly pages: readonly string[];
  }): Workbook.Handle {
    const handle = Workbook.create();
    const source = Workbook.addWorksheet(handle, "Data");
    Worksheet.addAoa(source, [
      ["Region", "Units", "Cost", "Year"],
      ["APAC", 10, 1, 2024],
      ["EMEA", 20, 2, 2025]
    ]);
    Pivot.add(
      Workbook.addWorksheet(handle, "P") as never,
      {
        sourceSheet: source,
        rows: ["Region"],
        columns: [],
        pages: options.pages,
        values: options.values,
        anchor: "A3"
      } as never
    );
    return handle;
  }

  /** The `location` the XLSX declares and the `BrtBeginSXLocation` the XLSB does, as one shape. */
  async function locations(handle: Workbook.Handle): Promise<{
    readonly xlsxFirstRow: number;
    readonly xlsbFirstRow: number;
    readonly xlsxHasDataFieldOnColumnAxis: boolean;
    readonly xlsbHasDataFieldOnColumnAxis: boolean;
  }> {
    const parts = await both(handle);
    const xmlPath = [...parts.xlsx.keys()].find(path =>
      /pivotTables\/pivotTable\d+\.xml$/.test(path)
    )!;
    const xml = new TextDecoder().decode(parts.xlsx.get(xmlPath)!.data);
    const ref = /ref="([^"]+)"/.exec(xml)![1]!;

    const binPath = [...parts.xlsb.keys()].find(path =>
      /pivotTables\/pivotTable\d+\.bin$/.test(path)
    )!;
    const bin = parts.xlsb.get(binPath)!.data;
    const location = firstRecord(bin, "BrtBeginSXLocation");

    let columnAxis: Uint8Array | undefined;
    for (const record of iterateInterpretableRecords(bin, "w")) {
      if (recordSpec(record.id)?.name === "BrtBeginISXVDCols") {
        columnAxis = record.payload;
      }
    }
    const view = columnAxis && new DataView(columnAxis.buffer, columnAxis.byteOffset);
    const entries = view === undefined ? [] : [...Array(view.getUint32(0, true)).keys()];

    return {
      // The XLSX `ref` is one-based; `rwFirst` is zero-based.
      xlsxFirstRow: Number(/\d+/.exec(ref.split(":")[0]!)![0]) - 1,
      xlsbFirstRow: new DataView(location.buffer, location.byteOffset).getUint32(0, true),
      xlsxHasDataFieldOnColumnAxis: /<colFields[^>]*>[\s\S]*?x="-2"/.test(xml),
      xlsbHasDataFieldOnColumnAxis: entries.some(
        index => view!.getInt32(4 + index * 4, true) === -2
      )
    };
  }

  it.each([0, 1, 2])("starts the body on the same row with %i page filters", async count => {
    const found = await locations(
      withPivot({ values: ["Units"], pages: ["Year", "Cost"].slice(0, count) })
    );
    expect(found.xlsbFirstRow).toBe(found.xlsxFirstRow);
  });

  it.each([
    ["one value", ["Units"]],
    ["two values", ["Units", "Cost"]]
  ] as const)("agrees about the data field on the column axis with %s", async (_name, values) => {
    const found = await locations(withPivot({ values, pages: [] }));
    expect(found.xlsbHasDataFieldOnColumnAxis).toBe(found.xlsxHasDataFieldOnColumnAxis);
  });

  it("agrees about the default subtotal on every axis", async () => {
    // XLSX spells it by *omitting* `defaultSubtotal="0"`; XLSB spells it as `fDefault` in `BrtBeginSXVD`. The
    // fields are matched by position, which is the same order both writers emit them in.
    const parts = await both(withPivot({ values: ["Units"], pages: ["Year"] }));
    const xmlPath = [...parts.xlsx.keys()].find(path =>
      /pivotTables\/pivotTable\d+\.xml$/.test(path)
    )!;
    const xml = new TextDecoder().decode(parts.xlsx.get(xmlPath)!.data);
    const fromXlsx = [...xml.matchAll(/<pivotField([^>]*?)(?:\/>|>[\s\S]*?<\/pivotField>)/g)].map(
      match => !/defaultSubtotal="0"/.test(match[1] ?? "")
    );

    const binPath = [...parts.xlsb.keys()].find(path =>
      /pivotTables\/pivotTable\d+\.bin$/.test(path)
    )!;
    const fromXlsb: boolean[] = [];
    for (const record of iterateInterpretableRecords(parts.xlsb.get(binPath)!.data, "w")) {
      if (recordSpec(record.id)?.name !== "BrtBeginSXVD") {
        continue;
      }
      const view = new DataView(record.payload.buffer, record.payload.byteOffset);
      fromXlsb.push((view.getUint16(1, true) & 0x0001) !== 0);
    }

    expect(fromXlsb).toEqual(fromXlsx);
  });
});
