import { beforeAll, describe, expect, it } from "vitest";

/**
 * XLSB in a browser.
 *
 * The reason this file exists is a bug the Node suite could not see. `writeXlsbPackage` is on the
 * browser IO path, and its base64 image decoder called `Buffer.from` — so writing a workbook whose
 * picture arrived as base64 threw `ReferenceError: Buffer is not defined` in a browser while the same
 * workbook wrote correctly under Node. Every XLSB image test was `*.node.test.ts`, which the browser
 * config excludes by glob, so nothing ran the failing path. Adding the fix without adding this file
 * would have left the next one just as invisible.
 *
 * These are deliberately end-to-end through the public surface: the point is not that a codec works
 * but that the *browser build* of the whole write-then-read path does.
 */

declare const Documonster: any;

let Workbook: any, Cell: any, Image: any;
beforeAll(() => {
  ({ Workbook, Cell, Image } = Documonster.Excel);
});

/** A 1×1 PNG, as bytes — small enough to inline and a real file rather than a fake header. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("Documonster.Excel XLSB in the browser", () => {
  it("writes and reads a binary workbook", async () => {
    const wb = Workbook.create();
    const sheet = Workbook.addWorksheet(wb, "Binary");
    Cell.setValue(sheet, "A1", "Hello, World!");
    Cell.setValue(sheet, "A2", 7);
    Cell.setValue(sheet, "A3", true);
    const when = new Date(Date.UTC(2024, 4, 17));
    Cell.setValue(sheet, "A4", when);
    // BIFF12 stores a date as a number and says so only through the format, exactly as XLSX does —
    // so a date with no format is a number, and reads back as one. That is the format's design
    // rather than a gap, and asserting a `Date` without setting a format would be asserting the
    // wrong thing.
    Cell.setStyle(sheet, "A4", { numFmt: "yyyy-mm-dd" });

    const buffer = await Workbook.toBuffer(wb, { format: "xlsb" });
    const reopened = Workbook.create();
    await Workbook.read(reopened, buffer);

    const read = Workbook.getWorksheet(reopened, "Binary")!;
    expect(Cell.getValue(read, "A1")).toEqual("Hello, World!");
    expect(Cell.getValue(read, "A2")).toEqual(7);
    expect(Cell.getValue(read, "A3")).toEqual(true);
    expect(Cell.getValue(read, "A4")).toBeInstanceOf(Date);
    expect((Cell.getValue(read, "A4") as Date).toISOString()).toBe(when.toISOString());
  });

  it("detects the format on read without being told", async () => {
    const wb = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(wb, "S1"), "A1", 42);
    const reopened = Workbook.create();
    // No `format` option: the reader has to recognise `xl/workbook.bin` on its own, which is the
    // path a consumer handed a file by a file picker actually takes.
    await Workbook.read(reopened, await Workbook.toBuffer(wb, { format: "xlsb" }));
    expect(Cell.getValue(Workbook.getWorksheet(reopened, "S1")!, "A1")).toEqual(42);
  });

  it("embeds an image supplied as bytes", async () => {
    const wb = Workbook.create();
    const sheet = Workbook.addWorksheet(wb, "Pictures");
    Cell.setValue(sheet, "A1", 1);
    const id = Image.add(wb, { buffer: PNG, extension: "png" });
    Image.place(sheet, id, { tl: { col: 2, row: 1 }, ext: { width: 40, height: 40 } });
    // Nothing to assert beyond "it produced a package": a browser has no ZIP reader here, and the
    // part-level assertions belong to the Node suite. What this covers is that the code path runs at
    // all in a browser build.
    expect((await Workbook.toBuffer(wb, { format: "xlsb" })).byteLength).toBeGreaterThan(0);
  });

  it("embeds an image supplied as base64", async () => {
    const wb = Workbook.create();
    const sheet = Workbook.addWorksheet(wb, "Pictures");
    Cell.setValue(sheet, "A1", 1);
    // The case that threw. `Buffer` does not exist in a browser, so this is the assertion — that the
    // decoder goes through the shared platform-neutral helper rather than Node's.
    const id = Image.add(wb, { base64: toBase64(PNG), extension: "png" });
    Image.place(sheet, id, { tl: { col: 2, row: 1 }, ext: { width: 40, height: 40 } });
    expect((await Workbook.toBuffer(wb, { format: "xlsb" })).byteLength).toBeGreaterThan(0);
  });

  it("embeds an image supplied as a data URL", async () => {
    const wb = Workbook.create();
    const sheet = Workbook.addWorksheet(wb, "Pictures");
    Cell.setValue(sheet, "A1", 1);
    const id = Image.add(wb, {
      base64: `data:image/png;base64,${toBase64(PNG)}`,
      extension: "png"
    });
    Image.place(sheet, id, { tl: { col: 2, row: 1 }, ext: { width: 40, height: 40 } });
    expect((await Workbook.toBuffer(wb, { format: "xlsb" })).byteLength).toBeGreaterThan(0);
  });

  it("reports what it cannot express instead of dropping it", async () => {
    const wb = Workbook.create();
    const sheet = Workbook.addWorksheet(wb, "S1");
    Cell.setValue(sheet, "A1", 1);
    // An array constant: still refused, and refused by the same writer in a browser. This case used to
    // use a border, which the writer now carries — so it was asserting that a *supported* feature was
    // rejected, and the browser suite is where that surfaced.
    Cell.setValue(sheet, "A2", { formula: "SUM({1,2;3,4})" } as never);
    // The default is to refuse, and that has to hold in a browser too — the rejection is what makes the
    // loss discoverable, and it is produced by the same writer.
    await expect(Workbook.toBuffer(wb, { format: "xlsb" })).rejects.toThrow(/array constant/);
    expect(
      (await Workbook.toBuffer(wb, { format: "xlsb", unsupported: "ignore" })).byteLength
    ).toBeGreaterThan(0);
  });

  it("carries a border, which it once reported as a loss", async () => {
    // The inverse of the case above, in the browser: `BrtBorder`'s layout is established now, so a
    // border is written rather than counted — and the same bundle has to do it.
    const wb = Workbook.create();
    const sheet = Workbook.addWorksheet(wb, "S1");
    Cell.setValue(sheet, "A1", 1);
    Cell.setStyle(sheet, "A1", { border: { top: { style: "thin" } } });
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(wb, { format: "xlsb" }));
    expect(Cell.getStyle(Workbook.getWorksheet(reopened, "S1")!, "A1")?.border).toMatchObject({
      top: { style: "thin" }
    });
  });
});
