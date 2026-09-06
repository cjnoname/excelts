/**
 * Workbook views, workbook protection, named cell styles and calculation properties.
 *
 * All four were on the loss list and none needed a new record: `BrtBookView`, `BrtBookProtection`,
 * `BrtStyle` and `BrtCalcProp` were already being written with their fields hard-coded or zeroed. The
 * specification supplied the layouts.
 */
import { Cell, Workbook } from "@excel";
import {
  bookProtection,
  bookView,
  calculationProperties,
  readBookProtection,
  readBookView,
  readCalculationProperties
} from "@excel/xlsb/defaults";
import { describe, expect, it } from "vitest";

describe("BrtBookView", () => {
  it("assembles Excel's default flag byte rather than writing the literal", () => {
    // `0x78` — both scroll bars, the sheet tabs and date grouping. Assembling it is what lets
    // `visibility` be expressed; asserting it equals the literal is what pins the bit order.
    expect(bookView()[28]).toBe(0x78);
  });

  it("carries the two visibility bits", () => {
    expect(bookView({ visibility: "hidden" })[28] & 0x03).toBe(0x01);
    // `veryHidden` sets `fHidden` too — the specification defines it as `fHidden` plus one more bit, so
    // writing only bit 1 would produce a window Excel treats as visible.
    expect(bookView({ visibility: "veryHidden" })[28] & 0x03).toBe(0x03);
    expect(bookView({ visibility: "visible" })[28] & 0x03).toBe(0);
  });

  it("falls back to a usable window size, not to zero", () => {
    // A zero-sized window is one Excel opens with no usable area.
    const back = readBookView(bookView(), "test");
    expect(back?.width).toBe(23040);
    expect(back?.height).toBe(8880);
  });

  it("clamps the tab ratio to the range the record permits", () => {
    expect(readBookView(bookView({ tabRatio: 5000 }), "test")?.tabRatio).toBe(1000);
    expect(readBookView(bookView({ tabRatio: -1 }), "test")?.tabRatio).toBe(0);
  });

  it("round-trips the geometry and the active sheet", () => {
    const view = {
      x: 100,
      y: 200,
      width: 30000,
      height: 12000,
      tabRatio: 600,
      firstSheet: 1,
      activeTab: 2,
      visibility: "visible"
    } as const;
    expect(readBookView(bookView(view), "test")).toEqual(view);
  });
});

describe("BrtBookProtection", () => {
  it("is six bytes: two verifiers and a flag word", () => {
    expect(bookProtection({ lockStructure: true })).toHaveLength(6);
  });

  it("packs the three locks at bits 0, 1 and 2", () => {
    const flags = (protection: Parameters<typeof bookProtection>[0]): number =>
      new DataView(bookProtection(protection).buffer).getUint16(4, true);
    expect(flags({ lockStructure: true })).toBe(0x01);
    expect(flags({ lockWindows: true })).toBe(0x02);
    expect(flags({ lockRevision: true })).toBe(0x04);
    expect(flags({ lockStructure: true, lockWindows: true, lockRevision: true })).toBe(0x07);
  });

  it("reports a workbook that locks nothing as unprotected", () => {
    // Excel writes this record for such a workbook, so returning an object would report every workbook
    // as deliberately configured.
    expect(readBookProtection(bookProtection({}), "test")).toBeUndefined();
  });

  it("round-trips through a workbook", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    const model = Workbook.getModel(workbook);
    (model as unknown as Record<string, unknown>).protection = {
      lockStructure: true,
      lockWindows: true
    };
    Workbook.setModel(workbook, model);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(
      (Workbook.getModel(reopened) as unknown as Record<string, unknown>).protection
    ).toMatchObject({
      lockStructure: true,
      lockWindows: true
    });
  });
});

describe("BrtCalcProp", () => {
  it("sets fIter at bit 2", () => {
    // The count and the delta were always written; the switch that makes either do anything was the one
    // field left reported rather than expressed.
    const flags = (iterate: boolean): number =>
      new DataView(calculationProperties({ iterate }).buffer).getUint16(24, true);
    expect(flags(true) & (1 << 2)).not.toBe(0);
    expect(flags(false) & (1 << 2)).toBe(0);
  });

  it("keeps Excel's default flags while adding its own", () => {
    // `0x6a` is `fRefA1`, `fFullPrec`, `fSaveRecalc`, `fMTREnabled`. Losing any of them while setting
    // `fIter` would change the workbook's reference style or its precision mode as a side effect.
    const flags = new DataView(calculationProperties({ iterate: true }).buffer).getUint16(24, true);
    expect(flags & 0x6a).toBe(0x6a);
  });

  it("reports the count and the delta only when iteration is on", () => {
    // Both are meaningless otherwise — the specification says so of each — so reporting them would
    // present Excel's own defaults as settings a caller made.
    expect(readCalculationProperties(calculationProperties({}), "test")).toEqual({});
    expect(
      readCalculationProperties(
        calculationProperties({ iterate: true, iterateCount: 50, iterateDelta: 0.0001 }),
        "test"
      )
    ).toMatchObject({ iterate: true, iterateCount: 50, iterateDelta: 0.0001 });
  });
});

describe("named cell styles", () => {
  it("round-trips a style's name and every facet", async () => {
    const workbook = Workbook.create();
    Workbook.defineCellStyle(workbook, "Warning", {
      font: { bold: true, color: { argb: "FFFF0000" } },
      numFmt: "0.00%",
      border: { top: { style: "thin" } }
    } as never);
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const styles = Workbook.listCellStyles(reopened);
    expect(styles).toHaveLength(1);
    // The *name* especially: `model.cellStyles` is an array whose entries carry their own `name`, not a
    // record keyed by it, and reading it as a record produced styles called "0" and "1".
    expect(styles[0].name).toBe("Warning");
    expect(styles[0]).toMatchObject({
      font: { bold: true, color: { argb: "FFFF0000" } },
      numFmt: "0.00%",
      border: { top: { style: "thin" } }
    });
  });

  it("keeps two styles distinct and carries the hidden flag", async () => {
    const workbook = Workbook.create();
    Workbook.defineCellStyle(workbook, "Warning", { font: { bold: true } } as never);
    Workbook.defineCellStyle(workbook, "Muted", { font: { italic: true }, hidden: true } as never);
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const byName = new Map(Workbook.listCellStyles(reopened).map(style => [style.name, style]));
    expect([...byName.keys()].sort()).toEqual(["Muted", "Warning"]);
    expect(byName.get("Warning")?.font?.bold).toBe(true);
    expect(byName.get("Muted")?.font?.italic).toBe(true);
    expect((byName.get("Muted") as { hidden?: boolean }).hidden).toBe(true);
  });

  it("does not report Normal as a style a caller defined", async () => {
    // Every workbook carries it. Reading it back as a named style would give a caller who defined none
    // a list of one.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(Workbook.listCellStyles(reopened)).toEqual([]);
  });
});
