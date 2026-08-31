import { readFileSync } from "node:fs";

/**
 * Images in a binary workbook.
 *

 * `.node` because it reads a PNG off disk for the fixture: the browser config excludes
 * `*.node.test.ts` by glob, which is a rule rather than a hand-kept list.
 *
 * The claim worth testing is not "an image appears" but **"it is the same XML the XLSX path writes"**.
 * A picture in a `.xlsb` is stored exactly as in a `.xlsx` — bytes in `xl/media/`, placement in
 * `xl/drawings/drawingN.xml`, reached through the sheet's own `.rels` — and only the reference is
 * binary: a twelve-byte `BrtDrawing` carrying a relationship id. So the drawing parts are produced by
 * the same code, and asserting byte equality is what keeps that true rather than aspirational.
 */
import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { Cell, Image, Workbook } from "@excel";
import { expectValidXlsb } from "@excel/__tests__/helpers/expect-valid-xlsb";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { iterateBiffRecords } from "@excel/xlsb/binary";
import { encodeDrawing, readDrawing } from "@excel/xlsb/drawing";
import { recordSpec } from "@excel/xlsb/spec/records";
import { biff, rowHeader } from "@test/biff-fixture";
import { describe, expect, it } from "vitest";

const PNG = readFileSync("src/modules/excel/examples/data/image2.png");

function withImage(): ReturnType<typeof Workbook.create> {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "Pictures");
  Cell.setValue(sheet, "A1", "a picture sits to the right");
  const id = Image.add(workbook, { buffer: PNG, extension: "png" });
  Image.place(sheet, id, { tl: { col: 2, row: 1 }, ext: { width: 200, height: 120 } } as never);
  return workbook;
}

describe("BrtDrawing", () => {
  it("is the relationship id and nothing else", () => {
    // Verbatim from `picture.xlsb`, in both of its sheets: an XLWideString reading `"rId2"`, and its
    // `xl/worksheets/_rels/sheet1.bin.rels` declares exactly that id pointing at the drawing.
    const real = new Uint8Array([0x04, 0, 0, 0, 0x72, 0, 0x49, 0, 0x64, 0, 0x32, 0]);
    expect(readDrawing(real, "sheet")).toBe("rId2");
    expect([...encodeDrawing("rId2")]).toEqual([...real]);
    // The length confirms the reading rather than leaving it assumed: 4 + 2 × 4.
    expect(encodeDrawing("rId2")).toHaveLength(12);
  });

  it("treats a truncated record as no drawing rather than as an empty id", () => {
    expect(readDrawing(new Uint8Array([0x04, 0, 0, 0]), "sheet")).toBeUndefined();
    expect(readDrawing(new Uint8Array([0, 0, 0, 0]), "sheet")).toBeUndefined();
  });
});

describe("images through XLSB", () => {
  it("writes the media, the drawing and the reference to it", async () => {
    const entries = await extractAll(await Workbook.toBuffer(withImage(), { format: "xlsb" }));
    for (const part of [
      "xl/media/image1.png",
      "xl/drawings/drawing1.xml",
      "xl/drawings/_rels/drawing1.xml.rels",
      "xl/worksheets/_rels/sheet1.bin.rels"
    ]) {
      expect(entries.has(part), part).toBe(true);
    }
    expect([...entries.get("xl/media/image1.png")!.data]).toEqual([...PNG]);
  });

  it("produces the same drawing XML as the XLSX path, byte for byte", async () => {
    // The property this whole feature rests on. Two serialisers for one schema would be two things to
    // keep in step, and the one with fewer users would be the one that drifted.
    const asXlsb = await extractAll(await Workbook.toBuffer(withImage(), { format: "xlsb" }));
    const asXlsx = await extractAll(await Workbook.toBuffer(withImage()));
    const decoder = new TextDecoder();
    for (const part of ["xl/drawings/drawing1.xml", "xl/drawings/_rels/drawing1.xml.rels"]) {
      expect(decoder.decode(asXlsb.get(part)!.data), part).toBe(
        decoder.decode(asXlsx.get(part)!.data)
      );
    }
  });

  it("names the media so the drawing's relationship resolves", async () => {
    // `addWorkbookImage` leaves the name unset — a name is a fact about the package, not about the
    // image — so a writer has to assign one. Skipping that produced a drawing pointing at
    // `../media/undefined.png` beside a part called `image.png`: a dangling reference, which Excel
    // treats as damage.
    const entries = await extractAll(await Workbook.toBuffer(withImage(), { format: "xlsb" }));
    const rels = new TextDecoder().decode(entries.get("xl/drawings/_rels/drawing1.xml.rels")!.data);
    expect(rels).toContain("../media/image1.png");
    expect(rels).not.toContain("undefined");
  });

  it("points the sheet at its drawing through a BrtDrawing after the margins", async () => {
    const entries = await extractAll(await Workbook.toBuffer(withImage(), { format: "xlsb" }));
    const order: string[] = [];
    let relId: string | undefined;
    for (const record of iterateBiffRecords(entries.get("xl/worksheets/sheet1.bin")!.data, "s")) {
      const name = recordSpec(record.id)?.name;
      if (name !== undefined) {
        order.push(name);
      }
      if (name === "BrtDrawing") {
        relId = readDrawing(record.payload, "s");
      }
    }
    expect(relId).toBeDefined();
    // The position `picture.xlsb` uses.
    expect(order.indexOf("BrtDrawing")).toBeGreaterThan(order.indexOf("BrtMargins"));
    expect(order.indexOf("BrtDrawing")).toBeLessThan(order.indexOf("BrtEndSheet"));

    // And the id it names is the one the sheet's own relationships declare.
    const rels = new TextDecoder().decode(entries.get("xl/worksheets/_rels/sheet1.bin.rels")!.data);
    expect(rels).toContain(`Id="${relId}"`);
    expect(rels).toContain("../drawings/drawing1.xml");
  });

  it("declares the content types the image parts need", async () => {
    const entries = await extractAll(await Workbook.toBuffer(withImage(), { format: "xlsb" }));
    const types = new TextDecoder().decode(entries.get("[Content_Types].xml")!.data);
    // The extension as a Default, the way Excel declares it, and the drawing as an Override.
    expect(types).toContain('Extension="png" ContentType="image/png"');
    expect(types).toContain('PartName="/xl/drawings/drawing1.xml"');
  });

  it("stores one copy of a picture placed several times", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Repeated");
    Cell.setValue(sheet, "A1", 1);
    const id = Image.add(workbook, { buffer: PNG, extension: "png" });
    for (const row of [1, 8, 15]) {
      Image.place(sheet, id, { tl: { col: 1, row }, ext: { width: 80, height: 60 } } as never);
    }
    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect([...entries.keys()].filter(part => part.startsWith("xl/media/"))).toEqual([
      "xl/media/image1.png"
    ]);
  });

  it("survives a read-modify-write", async () => {
    const first = await Workbook.toBuffer(withImage(), { format: "xlsb" });
    const reopened = Workbook.create();
    await Workbook.read(reopened, first);
    const again = await extractAll(
      await Workbook.toBuffer(reopened, { format: "xlsb", unsupported: "ignore" })
    );
    for (const part of [
      "xl/media/image1.png",
      "xl/drawings/drawing1.xml",
      "xl/drawings/_rels/drawing1.xml.rels"
    ]) {
      expect(again.has(part), part).toBe(true);
    }
  });

  it("produces a package the validator accepts", async () => {
    const result = await validateXlsbBuffer(
      await Workbook.toBuffer(withImage(), { format: "xlsb" }),
      {
        includeWarnings: true
      }
    );
    expect(result.problems).toEqual([]);
  });

  it("writes no drawing for a sheet with no images", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "Plain"), "A1", 1);
    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect([...entries.keys()].some(part => part.includes("drawing"))).toBe(false);
  });
});

/**
 * The three forms `ImageData` accepts, and the two ways a name can already be taken.
 *
 * Each case here is a package that was *malformed rather than merely incomplete*, which is why they
 * are worth their own block: the drawing relationship was written in every one of them, so the
 * reference existed and the thing it pointed at did not.
 */
describe("image byte sources", () => {
  it("embeds a base64 image", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Base64");
    // Deliberately with the `data:` prefix, which the model documents as optional.
    const id = Image.add(workbook, {
      base64: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
      extension: "png"
    });
    Image.place(sheet, id, { tl: { col: 1, row: 1 }, ext: { width: 60, height: 40 } } as never);
    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect([...entries.get("xl/media/image1.png")!.data]).toEqual([...PNG]);
  });

  it("embeds an image named by filename", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "FromDisk");
    // Supported by `ImageData` and by the XLSX writer. This wrote the drawing relationship and no
    // part at all, so the package referenced `../media/image1.png` and did not contain it.
    const id = Image.add(workbook, {
      filename: "src/modules/excel/examples/data/image2.png",
      extension: "png"
    });
    Image.place(sheet, id, { tl: { col: 1, row: 1 }, ext: { width: 60, height: 40 } } as never);
    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect([...entries.get("xl/media/image1.png")!.data]).toEqual([...PNG]);
  });

  it("declares a content type for an image whose extension the model omits", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "NoExtension");
    const id = Image.add(workbook, { buffer: PNG } as never);
    Image.place(sheet, id, { tl: { col: 1, row: 1 }, ext: { width: 60, height: 40 } } as never);
    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    // The part path defaulted the extension to `png` while the content-type scan skipped the medium
    // for having none, so the package contained a part it did not describe.
    expect(entries.has("xl/media/image1.png")).toBe(true);
    expect(new TextDecoder().decode(entries.get("[Content_Types].xml")!.data)).toContain(
      'Extension="png"'
    );
  });

  it("refuses an image that carries neither bytes nor a link", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Empty");
    Cell.setValue(sheet, "A1", 1);
    // `ImageData` makes all four sources optional, so this type-checks — and it used to write a drawing
    // relationship pointing at `../media/image1.png` with no such part in the package. A reference to
    // something that is not there is one of the things Excel offers to repair.
    const id = Image.add(workbook, { extension: "png" } as never);
    Image.place(sheet, id, { tl: { col: 1, row: 1 }, ext: { width: 40, height: 40 } } as never);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /image with no bytes and no link/
    );
  });

  it("leaves no reference behind when such an image is ignored", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Empty");
    Cell.setValue(sheet, "A1", 1);
    const id = Image.add(workbook, { extension: "png" } as never);
    Image.place(sheet, id, { tl: { col: 1, row: 1 }, ext: { width: 40, height: 40 } } as never);
    const entries = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    // Reporting the loss is only half of it: the anchor and the relationship have to go with it, or
    // "ignore" still produces the broken package.
    expect([...entries.keys()].some(part => part.includes("drawing"))).toBe(false);
    expect([...entries.keys()].some(part => part.startsWith("xl/media/"))).toBe(false);
    await expectValidXlsb(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
  });

  it("does not name the caller's media objects", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Pure");
    const id = Image.add(workbook, { buffer: PNG, extension: "png" });
    Image.place(sheet, id, { tl: { col: 1, row: 1 }, ext: { width: 60, height: 40 } } as never);
    const media = Workbook.getModel(workbook).media!;
    expect(media[0]!.name).toBeUndefined();
    await Workbook.toBuffer(workbook, { format: "xlsb" });
    // Serialising is not a mutation. Naming the caller's objects made a second write depend on
    // whether a first had happened, and left the name behind even when the write then failed.
    expect(media[0]!.name).toBeUndefined();
  });
});

/**
 * Adding a picture to a sheet that already had one.
 *
 * **A sheet has at most one drawing.** Every picture, chart and shape on it is an anchor inside that one
 * part, which is why `BrtDrawing` carries a single id. So this combination cannot be written: a second
 * drawing part means the sheet names one of the two, and whichever it does not name becomes unreachable.
 *
 * The previous version of this block asserted the opposite — that two drawings coexist with two distinct
 * relationship ids — and passed. It was testing the shape of the package rather than whether the
 * pictures could still be reached from the sheet, so it confirmed a package in which the preserved
 * images had silently disappeared. Merging would need the preserved drawing's XML parsed, and this
 * reader deliberately does not model drawings, so the combination is refused and named instead.
 */
describe("a new picture beside a preserved one", () => {
  async function reopened(): Promise<Workbook.Handle> {
    const first = await Workbook.toBuffer(withImage(), { format: "xlsb" });
    const workbook = Workbook.create();
    await Workbook.read(workbook, first);
    const sheet = Workbook.getWorksheet(workbook, "Pictures")!;
    const id = Image.add(workbook, { buffer: PNG, extension: "png" });
    Image.place(sheet, id, { tl: { col: 6, row: 1 }, ext: { width: 90, height: 60 } } as never);
    return workbook;
  }

  it("refuses rather than making the preserved pictures unreachable", async () => {
    await expect(Workbook.toBuffer(await reopened(), { format: "xlsb" })).rejects.toThrow(
      /already has a preserved drawing/
    );
  });

  it("keeps the preserved drawing when the new image is ignored", async () => {
    // `"ignore"` writes the workbook without what was reported. What was reported is the *new* image, so
    // the sheet keeps pointing at the drawing it already had — the caller asked to add a picture, not to
    // delete the ones that were there.
    const entries = await extractAll(
      await Workbook.toBuffer(await reopened(), { format: "xlsb", unsupported: "ignore" })
    );
    const drawings = [...entries.keys()].filter(part =>
      /^xl\/drawings\/drawing\d+\.xml$/.test(part)
    );
    expect(drawings).toEqual(["xl/drawings/drawing1.xml"]);
    expect(drawingReferenceOf(entries)).toBe("rId1");
  });

  it("produces a package the validator accepts", async () => {
    const bytes = await Workbook.toBuffer(await reopened(), {
      format: "xlsb",
      unsupported: "ignore"
    });
    expect((await validateXlsbBuffer(bytes, { includeWarnings: true })).problems).toEqual([]);
  });
});

/**
 * The reference itself, which is the only part of a picture that is binary.
 *
 * `BrtDrawing` was written when a modelled drawing was built and never otherwise, so a plain
 * read-modify-write of a workbook with pictures produced a package whose drawing XML, media and `.rels`
 * were all intact and whose sheet pointed at none of them. Every structural check passed and Excel
 * opened it with no pictures — which is the exact failure mode this module's opaque-part machinery
 * exists to prevent, reached from the one direction it did not cover.
 */
describe("the drawing reference survives a read-modify-write", () => {
  it("re-emits the BrtDrawing the sheet arrived with", async () => {
    const first = await Workbook.toBuffer(withImage(), { format: "xlsb" });
    expect(drawingReferenceOf(await extractAll(first))).toBe("rId1");

    const workbook = Workbook.create();
    await Workbook.read(workbook, first);
    const again = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    // The part and the relationship both survived before this fix; the record connecting them did not.
    expect(again.has("xl/drawings/drawing1.xml")).toBe(true);
    expect(again.has("xl/worksheets/_rels/sheet1.bin.rels")).toBe(true);
    expect(drawingReferenceOf(again)).toBe("rId1");
  });

  it("writes none for a sheet that never had one", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "Plain"), "A1", 1);
    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(drawingReferenceOf(entries)).toBeUndefined();
  });
});

/** The relationship id in the first sheet's `BrtDrawing`, or `undefined` when it has none. */
function drawingReferenceOf(entries: Map<string, { data: Uint8Array }>): string | undefined {
  for (const record of iterateBiffRecords(
    entries.get("xl/worksheets/sheet1.bin")!.data,
    "sheet1.bin"
  )) {
    if (recordSpec(record.id)?.name === "BrtDrawing") {
      return readDrawing(record.payload, "sheet1.bin");
    }
  }
  return undefined;
}

/**
 * Two things cannot occupy one path, and a name is a request rather than a guarantee.
 *
 * `ZipArchive.add` appends; it does not reject a path it already holds. So a duplicate produces two
 * central-directory entries for one name, and which one a reader sees is up to the reader — a corruption
 * that `extractAll` cannot even show you, because it keys by path and collapses the pair.
 */
describe("package paths are unique", () => {
  /** Entry names straight from the local file headers, so duplicates are visible. */
  function entryNames(bytes: Uint8Array): string[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const names: string[] = [];
    for (let at = 0; at + 30 <= bytes.length; at++) {
      if (view.getUint32(at, true) !== 0x04034b50) {
        continue;
      }
      const length = view.getUint16(at + 26, true);
      names.push(new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + length)));
    }
    return names;
  }

  it("gives two images the same requested name two paths", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    for (const column of [1, 5]) {
      const id = Image.add(workbook, { buffer: PNG, extension: "png" });
      Image.place(sheet, id, {
        tl: { col: column, row: 1 },
        ext: { width: 40, height: 40 }
      } as never);
    }
    // Both ask to be called `logo`. The package can honour that once.
    for (const medium of Workbook.getModel(workbook).media!) {
      (medium as { name?: string }).name = "logo";
    }
    const names = entryNames(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const media = names.filter(name => name.startsWith("xl/media/"));
    expect(media).toHaveLength(2);
    expect(new Set(media).size).toBe(2);
  });

  it("does not hand two sheets the same drawing path", async () => {
    // A preserved `drawing1` pushes the first sheet's choice to `drawing2`; the second sheet's own first
    // choice *is* `drawing2`, and only the preserved paths were consulted — so both took it, and the
    // archive received one path twice.
    //
    // The preserved drawing is reached from the *workbook* here, not from a sheet, which is what makes
    // the case reachable at all: a sheet that carries its own preserved drawing refuses a new image
    // outright, because a sheet has only one `BrtDrawing` to give.
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        "</Types>"
    );
    archive.add(
      "xl/_rels/workbook.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.bin"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="drawings/drawing1.xml"/>' +
        "</Relationships>"
    );
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "A" }],
        ["BrtBundleSh", { state: 0, tabId: 2, relId: "rId2", name: "B" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    const sheetBytes = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0 })],
      ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (7 << 2) | 0x02 }],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    archive.add("xl/worksheets/sheet1.bin", sheetBytes);
    archive.add("xl/worksheets/sheet2.bin", sheetBytes);
    archive.add("xl/drawings/drawing1.xml", new TextEncoder().encode("<wsDr/>"));

    const workbook = Workbook.create();
    await Workbook.read(workbook, await archive.bytes());
    for (const name of ["A", "B"]) {
      const id = Image.add(workbook, { buffer: PNG, extension: "png" });
      Image.place(Workbook.getWorksheet(workbook, name)!, id, {
        tl: { col: 1, row: 1 },
        ext: { width: 40, height: 40 }
      } as never);
    }
    const names = entryNames(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    const drawings = names.filter(name => name.startsWith("xl/drawings/"));
    expect(drawings.length).toBeGreaterThan(2);
    expect(new Set(drawings).size).toBe(drawings.length);
  });
});
