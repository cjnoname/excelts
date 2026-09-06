/**
 * Panes and page breaks.
 *
 * **The pane assertions are now against Excel's own bytes**, from an XLSB Excel wrote for a workbook this
 * library produced as XLSX (`pnpm oracle:generate` / `pnpm oracle:diff`). They used to be against the
 * specification, and two of them were confidently wrong in the same direction the specification is: the axes
 * are not crossed, and the two freeze bits are not mutually exclusive. A round trip could not see either,
 * because the reader and the writer made the same mistake and cancelled it out.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { selection } from "@excel/xlsb/defaults";
import { encodeBreak, readBreak } from "@excel/xlsb/page-breaks";
import { PANE, encodePane, paneSelections, readPane } from "@excel/xlsb/pane";
import { describe, expect, it } from "vitest";

/** A workbook through XLSB and back. */
async function roundTrip(build: (workbook: ReturnType<typeof Workbook.create>) => void) {
  const workbook = Workbook.create();
  build(workbook);
  const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
  const reopened = Workbook.create();
  await Workbook.read(reopened, bytes);
  return Workbook.getModel(reopened).worksheets[0] as unknown as Record<string, unknown>;
}

describe("BrtPane", () => {
  it("places columns in the first field and rows in the second", () => {
    // The opposite of what MS-XLSB 2.4.723 says, and what Excel writes. Freezing one row gives
    // `xnumXSplit = 0, xnumYSplit = 1`; freezing one column gives the reverse; two columns and one row gives
    // `2` and `1`. This asserted the specification's reading and passed for as long as the writer shared it.
    const payload = encodePane({
      frozen: true,
      rows: 3,
      columns: 7,
      topRow: 3,
      leftColumn: 7,
      activePane: "bottomRight"
    });
    expect(payload).toHaveLength(29);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    expect(view.getFloat64(0, true), "xnumXSplit is columns").toBe(7);
    expect(view.getFloat64(8, true), "xnumYSplit is rows").toBe(3);
    expect(view.getUint32(16, true)).toBe(3);
    expect(view.getUint32(20, true)).toBe(7);
  });

  it("sets both freeze bits, which the specification forbids and Excel does", () => {
    // 2.4.723 puts a MUST on each bit against the other. Excel writes `0x03` for every frozen pane and `0x00`
    // for a split one, so the pair behaves as one two-bit value. This asserted `0x02` on the strength of the
    // prose, and Excel repaired the view.
    const frozen = encodePane({
      frozen: true,
      rows: 1,
      columns: 0,
      topRow: 1,
      leftColumn: 0,
      activePane: "bottomLeft"
    });
    expect(frozen[28]).toBe(0x03);
    const split = encodePane({
      frozen: false,
      rows: 1200,
      columns: 2000,
      topRow: 3,
      leftColumn: 2,
      activePane: "topLeft"
    });
    expect(split[28]).toBe(0x00);
  });

  it("keeps a split pane's position in twips, unrounded and unclamped", () => {
    // Not a row count: a split pane's field is a twip position, and rounding it moves the split line.
    // Clamping it to the row maximum would be applying a row rule to something that is not a row.
    const pane = {
      frozen: false,
      rows: 1234.5,
      columns: 2880.25,
      topRow: 0,
      leftColumn: 0,
      activePane: "bottomRight"
    } as const;
    const decoded = readPane(encodePane(pane), "test");
    expect(decoded?.rows).toBe(1234.5);
    expect(decoded?.columns).toBe(2880.25);
  });

  it("truncates a frozen pane's counts, because there is no half a row", () => {
    const decoded = readPane(
      encodePane({
        frozen: true,
        rows: 2.9,
        columns: 4.9,
        topRow: 0,
        leftColumn: 0,
        activePane: "topLeft"
      }),
      "test"
    );
    expect(decoded?.rows).toBe(2);
    expect(decoded?.columns).toBe(4);
  });

  it("survives a truncated payload without costing the sheet", () => {
    expect(readPane(new Uint8Array(4), "test")).toBeUndefined();
  });

  it("round-trips a frozen view through a workbook", async () => {
    const sheet = await roundTrip(workbook => {
      const worksheet = Workbook.addWorksheet(workbook, "S", {
        views: [{ state: "frozen", xSplit: 2, ySplit: 1 }]
      } as never);
      Cell.setValue(worksheet, "A1", 1);
    });
    const view = (sheet.views as Record<string, unknown>[])[0];
    expect(view?.state).toBe("frozen");
    // Read back on the axes the caller set them on, which is the whole point of the crossover.
    expect(view?.xSplit).toBe(2);
    expect(view?.ySplit).toBe(1);
  });
});

describe("BrtBrk", () => {
  it("matches the specification's worked example", () => {
    // MS-XLSB 2.4.315's own example: a horizontal break at row 8 across columns A to Z is
    // `unRwCol = 7`, `unColRwStrt = 0`, `unColRwEnd = 25` — the record is zero-based, the model is not.
    const payload = encodeBreak({ id: 8, min: 1, max: 26, man: 1 }, "row");
    expect(payload).toHaveLength(20);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    expect(view.getUint32(0, true)).toBe(7);
    expect(view.getUint32(4, true)).toBe(0);
    expect(view.getUint32(8, true)).toBe(25);
    expect(view.getUint32(12, true)).toBe(1); // fMan
    expect(view.getUint32(16, true)).toBe(0); // fPivot — this writer models no pivot tables
  });

  it("reads back what it wrote, on both axes", () => {
    for (const axis of ["row", "column"] as const) {
      const entry = { id: 12, min: 2, max: 40, man: 1 };
      expect(readBreak(encodeBreak(entry, axis), "test")).toEqual(entry);
    }
  });

  it("defaults an absent min to the first row or column", () => {
    const decoded = readBreak(encodeBreak({ id: 5, max: 10, man: 1 }, "row"), "test");
    expect(decoded?.min).toBe(1);
  });

  it("survives a truncated payload", () => {
    expect(readBreak(new Uint8Array(6), "test")).toBeUndefined();
  });

  it("round-trips manual breaks through a workbook", async () => {
    const sheet = await roundTrip(workbook => {
      const worksheet = Workbook.addWorksheet(workbook, "S") as unknown as Record<string, unknown>;
      Cell.setValue(worksheet as never, "A1", 1);
      worksheet.rowBreaks = [{ id: 8, min: 1, max: 26, man: 1 }];
      worksheet.colBreaks = [{ id: 3, min: 1, max: 100, man: 1 }];
    });
    expect(sheet.rowBreaks).toEqual([{ id: 8, min: 1, max: 26, man: 1 }]);
    expect(sheet.colBreaks).toEqual([{ id: 3, min: 1, max: 100, man: 1 }]);
  });

  it("drops an automatic break rather than pinning Excel's own pagination", async () => {
    // `BrtBeginRwBrk` carries the count twice and the specification requires the two to be equal, which
    // only holds if every break written is manual. An automatic break is recomputed on open anyway.
    const sheet = await roundTrip(workbook => {
      const worksheet = Workbook.addWorksheet(workbook, "S") as unknown as Record<string, unknown>;
      Cell.setValue(worksheet as never, "A1", 1);
      worksheet.rowBreaks = [
        { id: 4, min: 1, max: 26, man: 0 },
        { id: 8, min: 1, max: 26, man: 1 }
      ];
    });
    expect(sheet.rowBreaks).toEqual([{ id: 8, min: 1, max: 26, man: 1 }]);
  });
});

/**
 * `BrtSel`, one per pane.
 *
 * **Excel still repairs the view of every frozen-pane file this writer produces**, so what these pin is the
 * shape the specification implies, not an accepted output. Eleven hand-built probes were opened in Excel;
 * these are the findings that survived, stated at the strength the evidence supports:
 *
 * - **Demonstrated.** `BrtPane` is 29 bytes. Padding it to 32, which the bit diagram's 32-bit last row can
 *   be read to suggest, makes Excel discard the whole part (`Replaced Part`) rather than repair a record —
 *   a strictly worse failure, and the clearest signal in the exercise.
 * - **Demonstrated.** A `BrtSel` naming a pane no `BrtPane` created is rejected: `PNNBOTLEFT` on an unsplit
 *   sheet fails where `PNNTOPLEFT` opens.
 * - **Demonstrated.** The fault is in the records, not the package: rezipping a failing file unchanged
 *   reproduces it exactly.
 * - **Not demonstrated.** One selection per pane. It is what the XLSX form implies once you notice that its
 *   `<selection>` without a `pane` attribute is the top-left one, but one, two and zero selections are all
 *   repaired, so this remains a reading rather than a fix.
 */
describe("BrtSel per pane", () => {
  /** What `paneSelections` produces, as `[pnn, row, column]` triples. */
  const triples = (pane: Parameters<typeof paneSelections>[0]): number[][] =>
    paneSelections(pane).map(selection => [selection.pane, selection.row, selection.column]);

  it("writes one selection per pane, all of them at A1", () => {
    // Counts and pane sets read off Excel's own file: a frozen row gives two, a frozen column two, and both
    // ways four. **Every one of them sits at A1**, including panes that begin further down or across — a
    // pane's active cell is not required to be inside it. This computed each pane's own first cell, which is
    // a tidier idea than Excel's and not Excel's.
    expect(
      triples({
        frozen: true,
        rows: 1,
        columns: 0,
        topRow: 1,
        leftColumn: 0,
        activePane: "bottomLeft"
      })
    ).toEqual([
      [PANE.topLeft, 0, 0],
      [PANE.bottomLeft, 0, 0]
    ]);
    expect(
      triples({
        frozen: true,
        rows: 0,
        columns: 1,
        topRow: 0,
        leftColumn: 1,
        activePane: "topRight"
      })
    ).toEqual([
      [PANE.topLeft, 0, 0],
      [PANE.topRight, 0, 0]
    ]);
    expect(
      triples({
        frozen: true,
        rows: 1,
        columns: 2,
        topRow: 1,
        leftColumn: 2,
        activePane: "bottomRight"
      })
    ).toEqual([
      [PANE.topLeft, 0, 0],
      [PANE.topRight, 0, 0],
      [PANE.bottomLeft, 0, 0],
      [PANE.bottomRight, 0, 0]
    ]);
    // A split pane has all four too, on the same terms.
    expect(
      triples({
        frozen: false,
        rows: 1200,
        columns: 2000,
        topRow: 3,
        leftColumn: 2,
        activePane: "topLeft"
      })
    ).toHaveLength(4);
  });

  it("writes the pane and its selections into the sheet, in that order", async () => {
    // Asserted on the record stream: the defect was a record *count*, which a model round trip cannot see
    // because the reader produces the same view model from one selection as from two.
    const workbook = Workbook.create();
    const worksheet = Workbook.addWorksheet(workbook, "S") as unknown as Record<string, unknown>;
    Cell.setValue(worksheet as never, "A1", 1);
    worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }];
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { recordSpec } = await import("@excel/xlsb/spec/records");
    const view: string[] = [];
    for (const entry of iterateInterpretableRecords(
      parts.get("xl/worksheets/sheet1.bin")!.data,
      "s"
    )) {
      const name = recordSpec(entry.id)?.name ?? "";
      if (name === "BrtPane") {
        const payload = entry.payload!;
        const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        view.push(
          `BrtPane(cols=${data.getFloat64(0, true)},rows=${data.getFloat64(8, true)},flags=0x${payload[28]!.toString(16).padStart(2, "0")})`
        );
      }
      if (name === "BrtSel") {
        const payload = entry.payload!;
        const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        view.push(`BrtSel(${data.getUint32(0, true)},${data.getUint32(4, true)})`);
      }
    }
    expect(view).toEqual([
      "BrtPane(cols=0,rows=1,flags=0x03)",
      `BrtSel(${PANE.topLeft},0)`,
      `BrtSel(${PANE.bottomLeft},0)`
    ]);
  });

  it("keeps a single top-left selection when nothing is split", () => {
    const bytes = selection();
    expect(bytes.length).toBe(36);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)).toBe(PANE.topLeft);
  });
});
