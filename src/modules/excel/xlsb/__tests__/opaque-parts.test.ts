/**
 * Parts this reader does not interpret survive a read-modify-write.
 *
 * The corpus makes the cost of not doing this concrete: two workbooks carry `xl/vbaProject.bin`,
 * one carries `xl/printerSettings/`, two carry `xl/media/` and `xl/drawings/`, and **all nine**
 * carry `xl/theme/theme1.xml`. Every one of them was silently dropped, and losing the theme is not
 * cosmetic — a `{ theme: 1 }` colour resolves through it, so a workbook read and written back would
 * have rendered its text in a different colour.
 *
 * The mechanism is `xlsx/opaque-parts.ts`, not a second one built here: the drop policy for stale
 * caches and invalidated signatures, the reachability filter and the content-type declarations are
 * the same problem in a different container.
 */
import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { Cell, Workbook } from "@excel";
import { readXlsbPackage } from "@excel/xlsb/read/package";
import { theme1Xml } from "@excel/xlsx/xml/theme1";
import { biff, rowHeader } from "@test/biff-fixture";
import { describe, expect, it } from "vitest";

const WORKBOOK_TYPE = "application/vnd.ms-excel.sheet.binary.macroEnabled.main";
const THEME = new TextEncoder().encode('<?xml version="1.0"?><theme>original bytes</theme>');
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

async function packageWithExtraParts(): Promise<Uint8Array> {
  const archive = new ZipArchive();
  archive.add(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      `<Default Extension="bin" ContentType="${WORKBOOK_TYPE}"/>` +
      '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
      '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      "</Types>"
  );
  archive.add(
    "xl/_rels/workbook.bin.rels",
    '<?xml version="1.0"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vbaProject" Target="vbaProject.bin"/>' +
      "</Relationships>"
  );
  archive.add(
    "xl/workbook.bin",
    biff([
      ["BrtBeginBook"],
      ["BrtBeginBundleShs"],
      ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "S1" }],
      ["BrtEndBundleShs"],
      ["BrtEndBook"]
    ])
  );
  archive.add(
    "xl/worksheets/sheet1.bin",
    biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0 })],
      ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (7 << 2) | 0x02 }],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ])
  );
  archive.add("xl/theme/theme1.xml", THEME);
  archive.add("xl/vbaProject.bin", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 9, 9]));
  archive.add("xl/media/image1.png", IMAGE);
  return archive.bytes();
}

describe("opaque parts survive a read-modify-write", () => {
  it("collects them on read", async () => {
    const workbook = Workbook.create();
    await readXlsbPackage(workbook, await packageWithExtraParts());
    const paths = (Workbook.getModel(workbook).opaqueParts ?? []).map(part => part.path).sort();
    expect(paths).toEqual(["xl/media/image1.png", "xl/theme/theme1.xml", "xl/vbaProject.bin"]);
  });

  it("writes them back byte for byte", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithExtraParts());
    const written = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));

    // Byte equality, not merely presence: a theme re-serialised through an XML writer would come
    // back semantically equal and textually different, and the point of preserving a part is that
    // this library makes no claim to understand it.
    // Spread rather than compared directly: the archive yields a Buffer in Node, and a Buffer is
    // never `toEqual` a Uint8Array however identical its bytes.
    expect([...written.get("xl/theme/theme1.xml")!.data]).toEqual([...THEME]);
    expect([...written.get("xl/media/image1.png")!.data]).toEqual([...IMAGE]);
    expect([...written.get("xl/vbaProject.bin")!.data]).toEqual([0xd0, 0xcf, 0x11, 0xe0, 9, 9]);
  });

  it("declares their content types, by Override or by Default as the source did", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithExtraParts());
    const written = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const types = new TextDecoder().decode(written.get("[Content_Types].xml")!.data);
    // The theme had an Override in the source and keeps one.
    expect(types).toContain('PartName="/xl/theme/theme1.xml"');
    // The image relied on a Default for its extension, which travels with it.
    expect(types).toContain('Extension="png"');
  });

  it("carries the relationships that make them reachable", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithExtraParts());
    const written = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const rels = new TextDecoder().decode(written.get("xl/_rels/workbook.bin.rels")!.data);
    expect(rels).toContain("theme/theme1.xml");
    expect(rels).toContain("vbaProject.bin");
  });

  it("still keeps the modelled content it does understand", async () => {
    // Preservation must not come at the cost of reading: the cell is still read and rewritten.
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithExtraParts());
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(Cell.getValue(Workbook.getWorksheets(reopened)[0]!, "A1")).toBe(7);
  });

  it("does not preserve the parts it re-serialises", async () => {
    // The workbook, the sheets, the styles and the shared strings are written from the model, so
    // preserving the originals as well would put two versions of each in the package. A
    // `binaryIndex` part is excluded for the same reason: it is a rebuildable lookup into a stream
    // this library re-serialised from scratch, so a stale one would describe bytes that are gone.
    const workbook = Workbook.create();
    await readXlsbPackage(workbook, await packageWithExtraParts());
    const paths = (Workbook.getModel(workbook).opaqueParts ?? []).map(part => part.path);
    expect(paths).not.toContain("xl/workbook.bin");
    expect(paths).not.toContain("xl/worksheets/sheet1.bin");
    expect(paths).not.toContain("[Content_Types].xml");
  });

  it("writes the workbook relationships where OPC looks for them", async () => {
    // `workbook.bin.rels`, not `workbook.xml.rels`. OPC locates a part's relationships at
    // `<dir>/_rels/<filename>.rels`, so the `.xml` name left the workbook part with no
    // relationships at all — the sheets unreachable through the only mechanism that reaches them.
    // Nothing caught it because the reader used to compute sheet paths arithmetically.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 1);
    const written = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(written.has("xl/_rels/workbook.bin.rels")).toBe(true);
    expect(written.has("xl/_rels/workbook.xml.rels")).toBe(false);
  });
});

describe("relationships a worksheet declares", () => {
  /**
   * A drawing is reached from a worksheet, not from the workbook: `picture.xlsb` carries
   * `xl/worksheets/_rels/sheet1.bin.rels` pointing at `xl/drawings/drawing1.xml`. Preserving the
   * drawing while dropping that `.rels` leaves the drawing in the package with nothing pointing at
   * it — and Excel treats a dangling part as damage rather than as a file with a spare part in it,
   * which is the difference between "opens" and "do you want us to recover as much as we can".
   */
  async function packageWithSheetRelationship(): Promise<Uint8Array> {
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        `<Default Extension="bin" ContentType="${WORKBOOK_TYPE}"/>` +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        "</Types>"
    );
    archive.add(
      "xl/_rels/workbook.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
        "</Relationships>"
    );
    // The relationship that matters: declared by the *sheet*, pointing at a part above it.
    archive.add(
      "xl/worksheets/_rels/sheet1.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/pic.png"/>' +
        "</Relationships>"
    );
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "S1" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    archive.add(
      "xl/worksheets/sheet1.bin",
      biff([
        ["BrtBeginSheet"],
        ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
        ["BrtBeginSheetData"],
        ["BrtRowHdr", rowHeader({ row: 0 })],
        ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (7 << 2) | 0x02 }],
        ["BrtEndSheetData"],
        ["BrtEndSheet"]
      ])
    );
    archive.add("xl/media/pic.png", IMAGE);
    return archive.bytes();
  }

  it("keeps the sheet's own .rels so the part it points at is still reachable", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithSheetRelationship());
    const written = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));

    expect([...written.get("xl/media/pic.png")!.data]).toEqual([...IMAGE]);
    const rels = written.get("xl/worksheets/_rels/sheet1.bin.rels");
    expect(rels, "the sheet's relationships part").toBeDefined();
    expect(new TextDecoder().decode(rels!.data)).toContain("../media/pic.png");
  });

  it("does not write a sheet .rels for a sheet that points at nothing", async () => {
    // An empty relationships part is a part with no information in it, and every sheet getting one
    // would be noise in every package this library writes.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 1);
    const written = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(written.has("xl/worksheets/_rels/sheet1.bin.rels")).toBe(false);
  });
});

describe("parts both writers author are not preserved as opaque", () => {
  /**
   * `docProps/core.xml` and `docProps/app.xml` are modelled — every writer here produces them from
   * `WorkbookModel`. Preserving them verbatim *as well* makes a package that declares each of them
   * twice in `[Content_Types].xml`, and a duplicate `Override PartName` is a malformed content-types
   * part rather than a harmless one. Excel refused the file.
   *
   * It surfaced only on the XLSB → XLSX direction, which is worth noting: reading an XLSB and writing
   * it back as XLSB never showed it, because that writer skips the parts it is about to author. The
   * defect needed two different writers to become visible, which is exactly what a conversion is.
   */
  it("does not carry docProps into the opaque set", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S"), "A1", 1);
    const asXlsb = await Workbook.toBuffer(source, { format: "xlsb" });

    const reopened = Workbook.create();
    await Workbook.read(reopened, asXlsb);
    const preserved = (Workbook.getModel(reopened).opaqueParts ?? []).map(part => part.path);
    expect(preserved).not.toContain("docProps/core.xml");
    expect(preserved).not.toContain("docProps/app.xml");
  });

  it("declares each content type once after an xlsb to xlsx conversion", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A1", 1);
    Cell.setValue(sheet, "B1", { formula: "A1*2", result: 2 });

    const viaXlsb = Workbook.create();
    await Workbook.read(viaXlsb, await Workbook.toBuffer(source, { format: "xlsb" }));
    const backToXlsx = await extractAll(await Workbook.toBuffer(viaXlsb));

    const types = new TextDecoder().decode(backToXlsx.get("[Content_Types].xml")!.data);
    for (const part of ["/docProps/core.xml", "/docProps/app.xml"]) {
      expect([...types.matchAll(new RegExp(`PartName="${part}"`, "g"))], part).toHaveLength(1);
    }
  });

  it("still preserves a part no writer here authors verbatim", async () => {
    // The rule is about who *writes* a part, not about who reads it. The theme is the sharpest case
    // now that this writer has a built-in default (see the `built-in theme` block below): a preserved
    // theme must come back with its own bytes rather than being replaced by that default.
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithExtraParts());
    const preserved = (Workbook.getModel(workbook).opaqueParts ?? []).map(part => part.path);
    expect(preserved).toContain("xl/theme/theme1.xml");
  });
});

/**
 * A workbook built from scratch still gets a theme.
 *
 * This is the one theme path that is neither preserved nor converted, and it was missing: every
 * from-scratch XLSB this library wrote omitted `xl/theme/theme1.xml` while still *referencing* theme
 * slots — 62 of the 69 example outputs, and the reason Excel repaired them. The XLSX writer had always
 * defaulted (`model.themes || { theme1: theme1Xml }`), so the same model written to the two formats
 * disagreed about whether the part exists.
 *
 * The assertions are deliberately about the three places a part has to appear to *be* a part — the
 * archive, the content types and a relationship — because declaring only some of them is exactly the
 * failure mode that produces a repair rather than a missing file.
 */
describe("built-in theme", () => {
  async function scratchXlsb(): Promise<Map<string, { data: Uint8Array }>> {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    return await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
  }

  it("writes the part", async () => {
    expect([...(await scratchXlsb()).keys()]).toContain("xl/theme/theme1.xml");
  });

  it("declares its content type", async () => {
    const parts = await scratchXlsb();
    const types = new TextDecoder().decode(parts.get("[Content_Types].xml")!.data);
    expect(types).toContain("application/vnd.openxmlformats-officedocument.theme+xml");
  });

  it("reaches it from the workbook relationships", async () => {
    const parts = await scratchXlsb();
    const rels = new TextDecoder().decode(parts.get("xl/_rels/workbook.bin.rels")!.data);
    expect(rels).toContain("theme/theme1.xml");
  });

  it("agrees with the xlsx writer about whether a theme exists", async () => {
    // The defect was an asymmetry between two writers over one model, so the gate compares them
    // rather than pinning a path — a future disagreement fails here whichever writer moves.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    const themes = async (format: "xlsx" | "xlsb") =>
      [...(await extractAll(await Workbook.toBuffer(workbook, { format }))).keys()]
        .filter(path => path.startsWith("xl/theme/"))
        .sort();
    expect(await themes("xlsb")).toEqual(await themes("xlsx"));
  });

  it("writes exactly one theme when a preserved one is present", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithExtraParts());
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect([...parts.keys()].filter(p => p.startsWith("xl/theme/"))).toEqual([
      "xl/theme/theme1.xml"
    ]);
  });

  it("falls back when a preserved theme is no longer reachable", async () => {
    // Renaming the part without repointing the relationship leaves it unreachable, so the reachability
    // filter drops it. The interesting part is what happens next: suppressing the fallback for a part
    // that is about to be dropped would ship a package with *no* theme and 252 dangling references to
    // one, so the fallback has to fire — and the bytes are how the test tells which theme won.
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithExtraParts());
    const model = Workbook.getModel(workbook);
    Workbook.setModel(workbook, {
      ...model,
      opaqueParts: (model.opaqueParts ?? []).map(part =>
        part.path === "xl/theme/theme1.xml" ? { ...part, path: "xl/theme/theme2.xml" } : part
      )
    });
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect([...parts.keys()].filter(p => p.startsWith("xl/theme/"))).toEqual([
      "xl/theme/theme1.xml"
    ]);
    expect(new TextDecoder().decode(parts.get("xl/theme/theme1.xml")!.data)).toBe(theme1Xml);
  });

  it("keeps a preserved theme's own bytes", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithExtraParts());
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(parts.get("xl/theme/theme1.xml")!.data).toEqual(THEME);
  });
});

/**
 * Preserved parts reached from the package root, and preserved parts whose extension this writer
 * also declares.
 *
 * Both were handled for the workbook and not for the root: `appendOpaqueSourceRelationships` was
 * called with `"xl/workbook.bin"` and never with `""`. The consequence is worse than a missing
 * relationship, because `reachableOpaqueParts` counts *every* inbound edge the model holds — so a
 * root-reached part was judged reachable, written, and then pointed at by nothing. That is the exact
 * state the reachability filter exists to prevent, produced by the filter itself.
 */
describe("preserved parts reached from the package root", () => {
  const CUSTOM = new TextEncoder().encode('<?xml version="1.0"?><Properties>custom</Properties>');
  const VENDOR = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

  async function packageWithRootRelationship(): Promise<Uint8Array> {
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        // Deliberately *not* the workbook type: a preserved `.bin` that relies on a conflicting
        // Default is the case the reserved-extension map exists to catch.
        '<Default Extension="bin" ContentType="application/vnd.vendor.sidecar"/>' +
        '<Override PartName="/xl/workbook.bin" ContentType="' +
        WORKBOOK_TYPE +
        '"/>' +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>' +
        "</Types>"
    );
    archive.add(
      "_rels/.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.bin"/>' +
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>' +
        "</Relationships>"
    );
    archive.add(
      "xl/_rels/workbook.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vbaProject" Target="sidecar.bin"/>' +
        "</Relationships>"
    );
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "S1" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    archive.add(
      "xl/worksheets/sheet1.bin",
      biff([
        ["BrtBeginSheet"],
        ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
        ["BrtBeginSheetData"],
        ["BrtRowHdr", rowHeader({ row: 0 })],
        ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (7 << 2) | 0x02 }],
        ["BrtEndSheetData"],
        ["BrtEndSheet"]
      ])
    );
    archive.add("docProps/custom.xml", CUSTOM);
    archive.add("xl/sidecar.bin", VENDOR);
    return archive.bytes();
  }

  it("keeps the root relationship that reaches them", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithRootRelationship());
    const written = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    expect([...written.get("docProps/custom.xml")!.data]).toEqual([...CUSTOM]);
    const rootRels = new TextDecoder().decode(written.get("_rels/.rels")!.data);
    expect(rootRels).toContain("docProps/custom.xml");
    // And the ids stay distinct, since the writer numbers its own three from rId1.
    const ids = [...rootRels.matchAll(/Id="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("promotes a preserved part's conflicting bin Default to an Override", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithRootRelationship());
    // **Edited on purpose, to reach the writer at all.** An unmodified XLSB is now returned as the bytes it arrived
    // as — which is the right answer for a caller and the wrong one for this test, whose subject is what the
    // *writer* does with a `Default` that clashes with its own. Touching one cell is the smallest thing that makes
    // the package be rebuilt.
    Cell.setValue(Workbook.getWorksheets(workbook)[0], "Z99", 1);
    const written = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    const types = new TextDecoder().decode(written.get("[Content_Types].xml")!.data);
    // `bin` is the writer's own Default, so the preserved part's classification has to travel as an
    // Override or it silently becomes a binary workbook part.
    expect(types).toContain('PartName="/xl/sidecar.bin"');
    expect(types).toContain("application/vnd.vendor.sidecar");
    // And the writer's own Default is still the workbook type, exactly once.
    expect(types.match(/<Default Extension="bin"/g)).toHaveLength(1);
    expect(types).toContain(`<Default Extension="bin" ContentType="${WORKBOOK_TYPE}"/>`);
  });
});

/**
 * A preserved part whose only referrer is deleted must go with it.
 *
 * `reachableOpaqueParts` claimed to do this and did the opposite. It built the set of "relationships
 * this write emits" from *every* relationship the model remembered — including the one declared by a
 * worksheet that no longer exists — so the part counted its own historical inbound edge as evidence
 * that something still pointed at it. It was written, nothing referenced it, and an unreferenced part
 * is exactly the state the filter exists to prevent.
 */
describe("opaque reachability follows what this write actually emits", () => {
  async function twoSheetsOneDrawing(): Promise<Uint8Array> {
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        `<Default Extension="bin" ContentType="${WORKBOOK_TYPE}"/>` +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        '<Override PartName="/xl/worksheets/sheet2.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        "</Types>"
    );
    archive.add(
      "xl/_rels/workbook.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.bin"/>' +
        "</Relationships>"
    );
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "Keep" }],
        ["BrtBundleSh", { state: 0, tabId: 2, relId: "rId2", name: "Doomed" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    const sheet = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0 })],
      ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (7 << 2) | 0x02 }],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    archive.add("xl/worksheets/sheet1.bin", sheet);
    archive.add("xl/worksheets/sheet2.bin", sheet);
    // Only the second sheet reaches the drawing.
    archive.add(
      "xl/worksheets/_rels/sheet2.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing9.xml"/>' +
        "</Relationships>"
    );
    archive.add("xl/drawings/drawing9.xml", new TextEncoder().encode("<wsDr/>"));
    return archive.bytes();
  }

  it("drops a part whose only referring sheet was deleted", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await twoSheetsOneDrawing());
    Workbook.removeWorksheet(workbook, "Doomed");
    const written = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    expect(written.has("xl/drawings/drawing9.xml")).toBe(false);
  });

  it("keeps it while that sheet is still there", async () => {
    // The other half of the claim: the filter has to drop an orphan without dropping a part that is
    // still reached, and the same fixture proves both.
    const workbook = Workbook.create();
    await Workbook.read(workbook, await twoSheetsOneDrawing());
    const written = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    expect(written.has("xl/drawings/drawing9.xml")).toBe(true);
    const rels = new TextDecoder().decode(written.get("xl/worksheets/_rels/sheet2.bin.rels")!.data);
    expect(rels).toContain("drawing9");
  });
});

describe("a part this reader parses is not also preserved", () => {
  /** An XLSB carrying comments, read back and written as the other container. */
  async function crossWritten() {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A1", 1);
    Cell.setComment(sheet, "A1", { texts: [{ text: "note" }] });
    const handle = Workbook.create();
    await Workbook.read(handle, await Workbook.toBuffer(source, { format: "xlsb" }));
    return extractAll(await Workbook.toBuffer(handle, { format: "xlsx", validate: false }));
  }

  it("describes the comments once, in the target container's form", async () => {
    // The defect this pins: the comments part was parsed *and* kept verbatim, so an XLSB written back as XLSX
    // contained `comments1.xml` and `comments1.bin` both — with the sheet's relationship pointing at the `.bin`,
    // which is why it surfaced as `rels-type-target-mismatch` rather than as anything about duplication.
    const parts = await crossWritten();
    expect([...parts.keys()].filter(path => /comments\d*\.xml$/i.test(path))).toHaveLength(1);
    expect([...parts.keys()].filter(path => /comments\d*\.bin$/i.test(path))).toEqual([]);
  });

  it("leaves no relationship pointing into the source container's form", async () => {
    // The observable symptom, asserted separately: a reader that skipped the part but left the rel would pass
    // the test above and still produce a package Excel repairs.
    const parts = await crossWritten();
    for (const [path, file] of parts) {
      if (!path.endsWith(".rels")) {
        continue;
      }
      expect(new TextDecoder().decode(file.data), path).not.toMatch(
        /Target="[^"]*comments\d*\.bin"/i
      );
    }
  });

  it("still writes a validator-clean package", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A1", 1);
    Cell.setComment(sheet, "A1", { texts: [{ text: "note" }] });
    const handle = Workbook.create();
    await Workbook.read(handle, await Workbook.toBuffer(source, { format: "xlsb" }));
    // `validate` left on: this is the self-check that found the defect in the first place.
    await expect(Workbook.toBuffer(handle, { format: "xlsx" })).resolves.toBeInstanceOf(Uint8Array);
  });
});
