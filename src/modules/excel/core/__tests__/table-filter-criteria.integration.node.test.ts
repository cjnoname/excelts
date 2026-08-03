import { extractAll } from "@archive/unzip/extract";
import { createZipSync } from "@archive/zip/zip-bytes";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { requireEntryText } from "@excel/__tests__/helpers/zip-text";
import { cellSetValue } from "@excel/core/cell";
import {
  tableGetColumn,
  tableSetHeaderRow,
  tableSetRef,
  tableSetTotalsRow,
  tableColumnSetFilterButton,
  tableModel
} from "@excel/core/table";
import { getCell } from "@excel/core/worksheet";
import { Table, Workbook } from "@excel/index";
import { describe, expect, it } from "vitest";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Rewrites a single part inside an xlsx buffer, leaving every other entry byte-identical. */
async function patchPart(
  buffer: Uint8Array | ArrayBuffer,
  path: string,
  patch: (xml: string) => string
): Promise<Uint8Array> {
  const entries = await extractAll(new Uint8Array(buffer));
  const patched = patch(decoder.decode(entries.get(path)!.data));
  return createZipSync(
    [...entries.values()].map(entry => ({
      name: entry.path,
      data: entry.path === path ? encoder.encode(patched) : entry.data
    }))
  );
}

/**
 * Filter criteria this library does not model — `<top10>` plus the
 * `<extLst>` extension block that `CT_FilterColumn` allows alongside it —
 * injected into an otherwise ordinary table part.
 */
const INJECTED_AUTO_FILTER =
  '<autoFilter ref="A1:B3">' +
  '<filterColumn colId="1" hiddenButton="0">' +
  '<top10 val="10" percent="0" filterVal="10"/>' +
  '<extLst><ext uri="{6BC0E1C0-0F9D-4A8C-9A6D-0F1B5C7A9E11}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:filter val="August"/></ext></extLst>' +
  "</filterColumn>" +
  "</autoFilter>";

/**
 * Builds a workbook containing a table, then rewrites its table part so the
 * autoFilter carries criteria only Excel understands. This is the shape of the
 * real-world files that used to fail to load outright.
 */
async function buildWorkbookWithUnmodelledFilter(): Promise<Uint8Array> {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Data");
  Table.add(ws, {
    name: "TestTable",
    ref: "A1",
    headerRow: true,
    totalsRow: false,
    columns: [{ name: "Name" }, { name: "Age" }],
    rows: [
      ["Alice", 30],
      ["Bob", 25]
    ]
  });

  const buffer = await Workbook.toBuffer(wb);
  const source = await patchPart(buffer, "xl/tables/table1.xml", xml => {
    const patched = xml.replace(
      /<autoFilter[^>]*\/>|<autoFilter[\s\S]*?<\/autoFilter>/,
      INJECTED_AUTO_FILTER
    );
    expect(patched).toContain("<top10");
    expect(patched).toContain("<x14:filter");
    return patched;
  });
  return source;
}

describe("table filter criteria round-trip", () => {
  /**
   * Every criteria element PR #196 set out to make loadable. `dynamicFilter` is
   * the exceljs#2972 case (Excel "Number Filters > Above Average"); the date
   * group is the case the PR author hit themselves. Here they must not only
   * load but also survive the save.
   */
  const PR196_CRITERIA: Array<{ label: string; xml: string }> = [
    { label: "dynamicFilter", xml: '<dynamicFilter type="aboveAverage"/>' },
    {
      label: "dateGroupItem",
      xml: '<filters><dateGroupItem year="2025" month="8" dateTimeGrouping="month"/></filters>'
    },
    { label: "top10", xml: '<top10 top="1" percent="0" val="10" filterVal="10"/>' },
    { label: "colorFilter", xml: '<colorFilter dxfId="0" cellColor="1"/>' },
    { label: "iconFilter", xml: '<iconFilter iconSet="3TrafficLights1" iconId="0"/>' },
    {
      label: "extLst",
      xml: '<extLst><ext uri="{6BC0E1C0-0F9D-4A8C-9A6D-0F1B5C7A9E11}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:filter val="1"/></ext></extLst>'
    }
  ];

  for (const criteria of PR196_CRITERIA) {
    it(`loads and preserves a table ${criteria.label} filter`, async () => {
      const wb0 = Workbook.create();
      const ws0 = Workbook.addWorksheet(wb0, "Data");
      Table.add(ws0, {
        name: "PrTable",
        ref: "A1",
        headerRow: true,
        totalsRow: false,
        columns: [{ name: "Name" }, { name: "Age" }],
        rows: [["Alice", 30]]
      });
      const source = await patchPart(await Workbook.toBuffer(wb0), "xl/tables/table1.xml", xml =>
        xml.replace(
          /<autoFilter[^>]*\/>|<autoFilter[\s\S]*?<\/autoFilter>/,
          `<autoFilter ref="A1:B2"><filterColumn colId="1">${criteria.xml}</filterColumn></autoFilter>`
        )
      );

      const wb = Workbook.create();
      await Workbook.read(wb, source);
      const resaved = await Workbook.toBuffer(wb);
      await expectValidXlsx(resaved, { label: `PR196 ${criteria.label}` });

      const tableXml = requireEntryText(
        await extractAll(new Uint8Array(resaved)),
        "xl/tables/table1.xml"
      );
      expect(tableXml).toContain(criteria.xml);
      expect(tableXml).toContain('colId="1"');
    });
  }

  it("preserves unmodelled filter criteria through load and save", async () => {
    const source = await buildWorkbookWithUnmodelledFilter();

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const resaved = await Workbook.toBuffer(wb);
    await expectValidXlsx(resaved, { label: "table filter criteria round-trip" });

    const entries = await extractAll(new Uint8Array(resaved));
    const tableXml = requireEntryText(entries, "xl/tables/table1.xml");

    // The criteria survive, still attached to the column they came from.
    expect(tableXml).toContain('<top10 val="10" percent="0" filterVal="10"/>');
    expect(tableXml).toContain('colId="1"');
    expect(tableXml).toContain("<x14:filter");
    // Exactly one criteria element — never the preserved XML plus a duplicate.
    expect(tableXml.match(/<top10/g)).toHaveLength(1);
    // The untouched first column must not inherit the second column's filter.
    expect(tableXml).not.toMatch(/<filterColumn colId="0"[^>]*>\s*<top10/);
  });

  it("survives a second load/save cycle", async () => {
    const source = await buildWorkbookWithUnmodelledFilter();

    const first = Workbook.create();
    await Workbook.read(first, source);
    const once = await Workbook.toBuffer(first);

    const second = Workbook.create();
    await Workbook.read(second, once);
    const twice = await Workbook.toBuffer(second);

    const tableXml = requireEntryText(
      await extractAll(new Uint8Array(twice)),
      "xl/tables/table1.xml"
    );
    expect(tableXml).toContain('<top10 val="10" percent="0" filterVal="10"/>');
    expect(tableXml).toContain("<x14:filter");
  });

  it("preserves the table's own extension block and namespace declarations", async () => {
    const wb0 = Workbook.create();
    const ws0 = Workbook.addWorksheet(wb0, "Data");
    Table.add(ws0, {
      name: "SortTable",
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      columns: [{ name: "Name" }, { name: "Age" }],
      rows: [["Alice", 30]]
    });
    const base = await Workbook.toBuffer(wb0);

    const tablePath = "xl/tables/table1.xml";
    // `x14:table` carries alternative text and slicer links; Excel drops those
    // table settings if the `<extLst>` block disappears on save.
    const source = await patchPart(base, tablePath, xml =>
      xml
        .replace(
          "<table ",
          '<table xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="xr3" xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3" xr3:uid="{00000000-000C-0000-FFFF-FFFF00000000}" '
        )
        .replace(
          "</table>",
          '<extLst><ext uri="{504A1905-F514-4f6f-8877-14C23A59335A}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:table altText="Sales"/></ext></extLst></table>'
        )
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const resaved = await Workbook.toBuffer(wb);
    await expectValidXlsx(resaved, { label: "table extLst round-trip" });

    const tableXml = requireEntryText(await extractAll(new Uint8Array(resaved)), tablePath);
    expect(tableXml).toContain('<x14:table altText="Sales"/>');
    // The declaration the preserved markup depends on must come with it.
    expect(tableXml).toContain(
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
    );
    // The default namespace must not be duplicated by the preserved attributes.
    expect(
      tableXml.match(/xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/g)
    ).toHaveLength(1);
  });
});

describe("worksheet filter criteria round-trip", () => {
  async function buildSheetWithCriteria(ref = "A1:B2"): Promise<Uint8Array> {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    cellSetValue(getCell(ws, "A1"), "Name");
    cellSetValue(getCell(ws, "B1"), "Age");
    cellSetValue(getCell(ws, "A2"), "Alice");
    cellSetValue(getCell(ws, "B2"), 30);
    ws.autoFilter = ref;

    const base = await Workbook.toBuffer(wb);
    return patchPart(base, "xl/worksheets/sheet1.xml", xml =>
      xml.replace(
        /<autoFilter[^>]*\/>/,
        `<autoFilter ref="${ref}"><filterColumn colId="1"><filters><filter val="30"/></filters></filterColumn></autoFilter>`
      )
    );
  }

  it("preserves worksheet filter criteria through load and save", async () => {
    const source = await buildSheetWithCriteria();

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const resaved = await Workbook.toBuffer(wb);
    await expectValidXlsx(resaved, { label: "worksheet filter criteria round-trip" });

    const sheetXml = requireEntryText(
      await extractAll(new Uint8Array(resaved)),
      "xl/worksheets/sheet1.xml"
    );
    expect(sheetXml).toContain(
      '<autoFilter ref="A1:B2"><filterColumn colId="1"><filters><filter val="30"/></filters></filterColumn></autoFilter>'
    );
  });

  it("preserves worksheet namespace declarations used by captured criteria", async () => {
    const source = await patchPart(
      await buildSheetWithCriteria(),
      "xl/worksheets/sheet1.xml",
      xml =>
        xml
          .replace(
            "<worksheet ",
            '<worksheet xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" '
          )
          .replace('mc:Ignorable="x14ac"', 'mc:Ignorable="x14ac x15"')
          .replace(
            "</autoFilter>",
            '<extLst><ext uri="x"><x15:filter val="1"/></ext></extLst></autoFilter>'
          )
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const sheetXml = requireEntryText(
      await extractAll(new Uint8Array(await Workbook.toBuffer(wb))),
      "xl/worksheets/sheet1.xml"
    );
    expect(sheetXml).toContain(
      'xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"'
    );
    expect(sheetXml).toContain("<x15:filter");
    expect(sheetXml).toMatch(/mc:Ignorable="[^"]*x15[^"]*"/);
  });

  it("drops stale criteria when the filter range is changed", async () => {
    const source = await buildSheetWithCriteria();

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const ws = Workbook.getWorksheet(wb, "Data")!;
    // Criteria are indexed by column offset within the range, so replaying them
    // against a different range would filter the wrong column.
    ws.autoFilter = "A1:A2";

    const sheetXml = requireEntryText(
      await extractAll(new Uint8Array(await Workbook.toBuffer(wb))),
      "xl/worksheets/sheet1.xml"
    );
    expect(sheetXml).toContain('<autoFilter ref="A1:A2"/>');
    expect(sheetXml).not.toContain("filterColumn");
  });
});

describe("sort state round-trip", () => {
  const SORT_STATE =
    '<sortState ref="A2:B2"><sortCondition descending="1" ref="B2:B2"/></sortState>';

  it("preserves a table's sortState", async () => {
    const wb0 = Workbook.create();
    const ws0 = Workbook.addWorksheet(wb0, "Data");
    Table.add(ws0, {
      name: "SortTable",
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      columns: [{ name: "Name" }, { name: "Age" }],
      rows: [["Alice", 30]]
    });
    const base = await Workbook.toBuffer(wb0);
    const tablePath = "xl/tables/table1.xml";
    const source = await patchPart(base, tablePath, xml =>
      xml.replace("<tableColumns", `${SORT_STATE}<tableColumns`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const resaved = await Workbook.toBuffer(wb);
    await expectValidXlsx(resaved, { label: "table sortState round-trip" });

    const tableXml = requireEntryText(await extractAll(new Uint8Array(resaved)), tablePath);
    expect(tableXml).toContain(SORT_STATE);
    // CT_Table order: autoFilter, sortState, tableColumns, tableStyleInfo, extLst.
    expect(tableXml.indexOf("<sortState")).toBeLessThan(tableXml.indexOf("<tableColumns"));
    expect(tableXml.indexOf("<sortState")).toBeGreaterThan(tableXml.indexOf("<autoFilter"));
  });

  it("drops a loaded table sortState after the table moves", async () => {
    const wb0 = Workbook.create();
    const ws0 = Workbook.addWorksheet(wb0, "Data");
    Table.add(ws0, {
      name: "SortTable",
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      columns: [{ name: "Name" }, { name: "Age" }],
      rows: [["Alice", 30]]
    });
    const source = await patchPart(await Workbook.toBuffer(wb0), "xl/tables/table1.xml", xml =>
      xml.replace("<tableColumns", `${SORT_STATE}<tableColumns`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const table = Table.get(Workbook.getWorksheet(wb, "Data")!, "SortTable");
    tableSetRef(table, "C2");

    const tableXml = requireEntryText(
      await extractAll(new Uint8Array(await Workbook.toBuffer(wb))),
      "xl/tables/table1.xml"
    );
    expect(tableXml).not.toContain("<sortState");
  });

  it("keeps sortState when structural setters receive the current value", async () => {
    const wb0 = Workbook.create();
    const ws0 = Workbook.addWorksheet(wb0, "Data");
    Table.add(ws0, {
      name: "SortTable",
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      columns: [{ name: "Name" }, { name: "Age" }],
      rows: [["Alice", 30]]
    });
    const source = await patchPart(await Workbook.toBuffer(wb0), "xl/tables/table1.xml", xml =>
      xml.replace("<tableColumns", `${SORT_STATE}<tableColumns`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const table = Table.get(Workbook.getWorksheet(wb, "Data")!, "SortTable");
    tableSetRef(table, "A1:B2");
    tableSetHeaderRow(table, true);

    const tableXml = requireEntryText(
      await extractAll(new Uint8Array(await Workbook.toBuffer(wb))),
      "xl/tables/table1.xml"
    );
    expect(tableXml).toContain("<sortState");
  });

  it("lets API changes override preserved table and column attributes", async () => {
    const wb0 = Workbook.create();
    const ws0 = Workbook.addWorksheet(wb0, "Data");
    Table.add(ws0, {
      name: "OverrideTable",
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      columns: [{ name: "Name", filterButton: true }],
      rows: [["Alice"]]
    });
    const source = await patchPart(await Workbook.toBuffer(wb0), "xl/tables/table1.xml", xml =>
      xml
        .replace("<table ", '<table totalsRowShown="0" ')
        .replace('hiddenButton="0"', 'hiddenButton="0" showButton="0"')
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const table = Table.get(Workbook.getWorksheet(wb, "Data")!, "OverrideTable");
    tableSetTotalsRow(table, true);
    tableColumnSetFilterButton(tableGetColumn(table, 0), false);

    expect(tableModel(table).rawAttributes?.totalsRowShown).toBeUndefined();
    const tableXml = requireEntryText(
      await extractAll(new Uint8Array(await Workbook.toBuffer(wb))),
      "xl/tables/table1.xml"
    );
    expect(tableXml).toContain('totalsRowCount="1"');
    expect(tableXml).not.toContain("totalsRowShown");
    expect(tableXml).toContain('hiddenButton="1"');
    expect(tableXml).not.toContain("showButton");
  });

  it("preserves a worksheet's sortState", async () => {
    const wb0 = Workbook.create();
    const ws0 = Workbook.addWorksheet(wb0, "Data");
    cellSetValue(getCell(ws0, "A1"), "Name");
    cellSetValue(getCell(ws0, "B1"), "Age");
    cellSetValue(getCell(ws0, "B2"), 30);
    ws0.autoFilter = "A1:B2";
    const base = await Workbook.toBuffer(wb0);
    const sheetPath = "xl/worksheets/sheet1.xml";
    const source = await patchPart(base, sheetPath, xml =>
      xml.replace(/(<autoFilter[^>]*\/>)/, `$1${SORT_STATE}`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const resaved = await Workbook.toBuffer(wb);
    await expectValidXlsx(resaved, { label: "worksheet sortState round-trip" });

    const sheetXml = requireEntryText(await extractAll(new Uint8Array(resaved)), sheetPath);
    expect(sheetXml).toContain(SORT_STATE);
    // CT_Worksheet order: ... autoFilter, sortState, ... mergeCells ...
    expect(sheetXml.indexOf("<sortState")).toBeGreaterThan(sheetXml.indexOf("<autoFilter"));
  });

  it("preserves a worksheet sortState without an autoFilter", async () => {
    const wb0 = Workbook.create();
    const ws0 = Workbook.addWorksheet(wb0, "Data");
    cellSetValue(getCell(ws0, "A1"), "Name");
    cellSetValue(getCell(ws0, "B1"), "Age");
    cellSetValue(getCell(ws0, "B2"), 30);
    const source = await patchPart(await Workbook.toBuffer(wb0), "xl/worksheets/sheet1.xml", xml =>
      xml.replace(/(<sheetData[\s\S]*?<\/sheetData>)/, `$1${SORT_STATE}`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const sheetXml = requireEntryText(
      await extractAll(new Uint8Array(await Workbook.toBuffer(wb))),
      "xl/worksheets/sheet1.xml"
    );
    expect(sheetXml).toContain(SORT_STATE);
    expect(sheetXml).not.toContain("<autoFilter");
  });

  it("drops a worksheet sortState after the filter range changes", async () => {
    const wb0 = Workbook.create();
    const ws0 = Workbook.addWorksheet(wb0, "Data");
    cellSetValue(getCell(ws0, "A1"), "Name");
    cellSetValue(getCell(ws0, "B1"), "Age");
    ws0.autoFilter = "A1:B2";
    const source = await patchPart(await Workbook.toBuffer(wb0), "xl/worksheets/sheet1.xml", xml =>
      xml.replace(/(<autoFilter[^>]*\/>)/, `$1${SORT_STATE}`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    Workbook.getWorksheet(wb, "Data")!.autoFilter = "D1:E2";
    const sheetXml = requireEntryText(
      await extractAll(new Uint8Array(await Workbook.toBuffer(wb))),
      "xl/worksheets/sheet1.xml"
    );
    expect(sheetXml).not.toContain("<sortState");
  });

  it("keeps worksheet sortState for an equivalent object-form filter range", async () => {
    const wb0 = Workbook.create();
    const ws0 = Workbook.addWorksheet(wb0, "Data");
    cellSetValue(getCell(ws0, "A1"), "Name");
    cellSetValue(getCell(ws0, "B1"), "Age");
    ws0.autoFilter = "A1:B2";
    const source = await patchPart(await Workbook.toBuffer(wb0), "xl/worksheets/sheet1.xml", xml =>
      xml.replace(/(<autoFilter[^>]*\/>)/, `$1${SORT_STATE}`)
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    Workbook.getWorksheet(wb, "Data")!.autoFilter = { from: "A1", to: "B2" };
    const sheetXml = requireEntryText(
      await extractAll(new Uint8Array(await Workbook.toBuffer(wb))),
      "xl/worksheets/sheet1.xml"
    );
    expect(sheetXml).toContain("<sortState");
  });
});
