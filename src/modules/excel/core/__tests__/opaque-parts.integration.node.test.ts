/**
 * Opaque part round-trip.
 *
 * This pins the behaviour the policy in `xlsx/opaque-parts.ts` exists for: a
 * package part this library does not model must survive `read` → `write`, and the
 * two categories that must *not* survive must not.
 *
 * Before opaque preservation, the loader drained every unrecognised entry and
 * dropped the bytes. The macro case was the sharpest: `workbookContentType` is
 * round-tripped, so reading an `.xlsm` and writing it produced a file that still
 * declared itself macro-enabled with every macro gone — a silent, total loss of
 * the feature the user opened the file for.
 *
 * Fixtures are built here rather than checked in, so each case states exactly
 * which part it is about and no binary blob has to be trusted.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { Cell, Workbook, Worksheet } from "@excel";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import type { EntryMap } from "@excel/__tests__/helpers/zip-text";
import { entryText, requireEntryText } from "@excel/__tests__/helpers/zip-text";
import { describe, expect, it } from "vitest";

/** Build a minimal but valid workbook, then inject extra parts into its package. */
async function packageWithExtraParts(
  extras: Record<string, string | Uint8Array>,
  patch?: {
    contentTypes?: (xml: string) => string;
    workbookRels?: (xml: string) => string;
    rootRels?: (xml: string) => string;
    sheetRels?: (xml: string) => string;
    chartRels?: (xml: string) => string;
    sheetXml?: (xml: string) => string;
  }
): Promise<Uint8Array> {
  const source = Workbook.create();
  const sheet = Workbook.addWorksheet(source, "Data");
  Cell.setValue(sheet, "A1", "kept");
  const baseline = await Workbook.toBuffer(source);

  const entries = await extractAll(baseline);
  const archive = new ZipArchive();
  const decoder = new TextDecoder();

  for (const [path, entry] of entries) {
    const data = entry.data;
    let bytes: string | Uint8Array = data;
    if (path === "[Content_Types].xml" && patch?.contentTypes) {
      bytes = patch.contentTypes(decoder.decode(data));
    } else if (path === "xl/_rels/workbook.xml.rels" && patch?.workbookRels) {
      bytes = patch.workbookRels(decoder.decode(data));
    } else if (path === "_rels/.rels" && patch?.rootRels) {
      bytes = patch.rootRels(decoder.decode(data));
    } else if (path === "xl/worksheets/_rels/sheet1.xml.rels" && patch?.sheetRels) {
      bytes = patch.sheetRels(decoder.decode(data));
    } else if (path === "xl/worksheets/sheet1.xml" && patch?.sheetXml) {
      bytes = patch.sheetXml(decoder.decode(data));
    }
    archive.add(path, bytes);
  }
  for (const [path, data] of Object.entries(extras)) {
    archive.add(path, data);
  }
  if (patch?.chartRels) {
    archive.add(
      "xl/charts/_rels/chart1.xml.rels",
      patch.chartRels(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          "</Relationships>"
      )
    );
  }
  if (patch?.sheetRels && !entries.has("xl/worksheets/_rels/sheet1.xml.rels")) {
    archive.add(
      "xl/worksheets/_rels/sheet1.xml.rels",
      patch.sheetRels(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          "</Relationships>"
      )
    );
  }
  return await archive.bytes();
}

const addOverride = (partName: string, contentType: string) => (xml: string) =>
  xml.replace(
    "</Types>",
    `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`
  );

const addDefault = (extension: string, contentType: string) => (xml: string) =>
  xml.replace(
    "<Override",
    `<Default Extension="${extension}" ContentType="${contentType}"/><Override`
  );

const addRel = (id: string, type: string, target: string) => (xml: string) =>
  xml.replace(
    "</Relationships>",
    `<Relationship Id="${id}" Type="${type}" Target="${target}"/></Relationships>`
  );

async function roundTrip(bytes: Uint8Array): Promise<EntryMap> {
  const wb = Workbook.create();
  await Workbook.read(wb, bytes);
  const written = await Workbook.toBuffer(wb);
  await expectValidXlsx(written);
  return await extractAll(written);
}

const VBA_REL = "http://schemas.microsoft.com/office/2006/relationships/vbaProject";
const CUSTOM_PROPS_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
const PRINTER_SETTINGS_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings";

describe("opaque part round-trip", () => {
  it("preserves a VBA project, its content type and the relationship that reaches it", async () => {
    // The regression this whole mechanism exists for. A preserved part is only
    // preserved if all three of bytes, content type and inbound relationship
    // survive: bytes alone leave a macro project nothing points at, which is
    // indistinguishable to Excel from no macros at all.
    const vba = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4);
    const source = await packageWithExtraParts(
      { "xl/vbaProject.bin": vba },
      {
        contentTypes: addOverride("/xl/vbaProject.bin", "application/vnd.ms-office.vbaProject"),
        workbookRels: addRel("rId99", VBA_REL, "vbaProject.bin")
      }
    );

    const out = await roundTrip(source);

    expect(out.get("xl/vbaProject.bin")?.data).toEqual(vba);

    const contentTypes = requireEntryText(out, "[Content_Types].xml");
    expect(contentTypes).toContain('PartName="/xl/vbaProject.bin"');
    expect(contentTypes).toContain("application/vnd.ms-office.vbaProject");

    const rels = requireEntryText(out, "xl/_rels/workbook.xml.rels");
    expect(rels).toContain(VBA_REL);
    expect(rels).toContain('Target="vbaProject.bin"');
  });

  it("preserves custom document properties reached from the package root", async () => {
    // A root-relationship case, which resolves against the package root rather
    // than against `_rels/` — the distinction that made an early implementation
    // look for `_rels/docProps/custom.xml`.
    const custom =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"' +
      ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="CostCentre">' +
      "<vt:lpwstr>R&amp;D</vt:lpwstr></property></Properties>";
    const source = await packageWithExtraParts(
      { "docProps/custom.xml": custom },
      {
        contentTypes: addOverride(
          "/docProps/custom.xml",
          "application/vnd.openxmlformats-officedocument.custom-properties+xml"
        ),
        rootRels: addRel("rId4", CUSTOM_PROPS_REL, "docProps/custom.xml")
      }
    );

    const out = await roundTrip(source);

    expect(requireEntryText(out, "docProps/custom.xml")).toContain("CostCentre");
    expect(requireEntryText(out, "_rels/.rels")).toContain(CUSTOM_PROPS_REL);
  });

  it("preserves a part declared by extension rather than by an explicit override", async () => {
    // Excel registers printer settings with a single `Default Extension="bin"`.
    // Capturing only Overrides preserves the bytes and loses the declaration,
    // which the OOXML self-check reports as `content-types-missing-for-part` —
    // and `expectValidXlsx` inside `roundTrip` is what enforces that here.
    const settings = Uint8Array.of(9, 8, 7, 6, 5);
    const source = await packageWithExtraParts(
      { "xl/printerSettings/printerSettings1.bin": settings },
      {
        contentTypes: addDefault(
          "bin",
          "application/vnd.openxmlformats-officedocument.printerSettings"
        )
      }
    );

    const out = await roundTrip(source);

    expect(out.get("xl/printerSettings/printerSettings1.bin")?.data).toEqual(settings);
    expect(requireEntryText(out, "[Content_Types].xml")).toContain('Extension="bin"');
  });

  it("preserves a relationship that reaches a part from a worksheet", async () => {
    // Printer settings and query tables hang off a *sheet*, not off the
    // workbook. Recording inbound relationships only from the root and workbook
    // rels preserves the bytes and the content type while losing the one thing
    // that makes the part reachable — the exact failure this mechanism exists to
    // prevent, one level down. The first version of this code had that bug, and
    // the printer-settings test above did not catch it because it only checked
    // the bytes and the content type.
    const settings = Uint8Array.of(1, 1, 2, 3, 5, 8);
    const source = await packageWithExtraParts(
      { "xl/printerSettings/printerSettings1.bin": settings },
      {
        contentTypes: addDefault(
          "bin",
          "application/vnd.openxmlformats-officedocument.printerSettings"
        ),
        sheetRels: addRel("rId7", PRINTER_SETTINGS_REL, "../printerSettings/printerSettings1.bin")
      }
    );

    const out = await roundTrip(source);

    expect(out.get("xl/printerSettings/printerSettings1.bin")?.data).toEqual(settings);
    const sheetRels = requireEntryText(out, "xl/worksheets/_rels/sheet1.xml.rels");
    expect(sheetRels).toContain(PRINTER_SETTINGS_REL);
    expect(sheetRels).toContain('Target="../printerSettings/printerSettings1.bin"');
  });

  it("keeps a sheet-sourced relationship with its sheet when sheets are reordered", async () => {
    // The relationship travels on the sheet's own model rather than on its
    // position. This has to move the sheet for real: an earlier version of this
    // test called `addWorksheet`, which appends, so `Data` stayed `sheet1.xml` and
    // nothing was actually reordered.
    const settings = Uint8Array.of(4, 4, 4);
    const source = await packageWithExtraParts(
      { "xl/printerSettings/printerSettings1.bin": settings },
      {
        contentTypes: addDefault(
          "bin",
          "application/vnd.openxmlformats-officedocument.printerSettings"
        ),
        sheetRels: addRel("rId7", PRINTER_SETTINGS_REL, "../printerSettings/printerSettings1.bin")
      }
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const front = Workbook.addWorksheet(wb, "Front");
    Cell.setValue(front, "A1", "front");

    // Move the added sheet ahead of `Data`, so `Data` is no longer sheet1.
    const model = Workbook.getModel(wb);
    const dataIndex = model.sheets!.findIndex(sheet => sheet.name === "Data");
    const frontIndex = model.sheets!.findIndex(sheet => sheet.name === "Front");
    expect(dataIndex).toBeLessThan(frontIndex);
    const reordered = [...model.sheets!];
    reordered.splice(frontIndex, 1);
    reordered.unshift(model.sheets![frontIndex]);
    Workbook.setModel(wb, { ...model, sheets: reordered });

    const names = Workbook.getWorksheets(wb).map(sheet => Worksheet.getName(sheet));
    expect(names[0]).toBe("Front");
    expect(names[1]).toBe("Data");

    const written = await Workbook.toBuffer(wb);
    await expectValidXlsx(written);
    const out = await extractAll(written);

    // `Data` is now sheet2, and the relationship must have followed it there.
    expect(entryText(out, "xl/worksheets/_rels/sheet2.xml.rels")).toContain(PRINTER_SETTINGS_REL);
    expect(entryText(out, "xl/worksheets/_rels/sheet1.xml.rels") ?? "").not.toContain(
      PRINTER_SETTINGS_REL
    );
  });

  it("keeps the sheet XML reference that makes printer settings usable", async () => {
    // Preserving the part and the relationship is not enough. `<pageSetup r:id>`
    // is the only thing that connects the sheet to it, and it is not a modelled
    // page-setup property — so it used to be dropped on read, leaving a package
    // that carried printer settings no sheet referred to.
    const source = await packageWithExtraParts(
      { "xl/printerSettings/printerSettings1.bin": Uint8Array.of(3, 1, 4) },
      {
        contentTypes: addDefault(
          "bin",
          "application/vnd.openxmlformats-officedocument.printerSettings"
        ),
        sheetRels: addRel("rId7", PRINTER_SETTINGS_REL, "../printerSettings/printerSettings1.bin"),
        sheetXml: xml =>
          xml.replace(
            "</worksheet>",
            '<pageSetup paperSize="9" orientation="portrait" r:id="rId7"/></worksheet>'
          )
      }
    );

    const out = await roundTrip(source);

    const sheet = requireEntryText(out, "xl/worksheets/sheet1.xml");
    const relsXml = requireEntryText(out, "xl/worksheets/_rels/sheet1.xml.rels");
    const referenced = /<pageSetup[^>]*r:id="(rId\d+)"/.exec(sheet);
    expect(referenced, "pageSetup must still carry an r:id").not.toBeNull();
    // And that id must be the one the printer-settings relationship actually got.
    const declared = new RegExp(
      `<Relationship[^>]*Id="${referenced![1]}"[^>]*Target="\\.\\./printerSettings/printerSettings1\\.bin"`
    );
    expect(relsXml).toMatch(declared);
  });

  it("drops a pageSetup reference rather than let it dangle when the part is gone", async () => {
    // The sheet is deleted and re-created around the reference: with the part
    // unreachable and dropped, an r:id left in the XML would point at nothing, or
    // at whatever else was later given that id.
    const source = await packageWithExtraParts(
      {},
      {
        sheetXml: xml =>
          xml.replace(
            "</worksheet>",
            '<pageSetup paperSize="9" orientation="portrait" r:id="rId7"/></worksheet>'
          )
      }
    );

    const out = await roundTrip(source);
    expect(requireEntryText(out, "xl/worksheets/sheet1.xml")).not.toContain("r:id");
  });

  it("keeps a vendor content type that arrived as a conflicting Default", async () => {
    // OPC lets a package declare `<Default Extension="xml">` as something other
    // than application/xml, because the modelled parts each carry their own
    // Override. This writer emits its own `xml` Default, so re-emitting it would
    // silently reclassify the preserved part — bytes intact, meaning gone. The
    // conflicting Default is promoted to an Override on the part that needed it.
    const source = await packageWithExtraParts(
      { "vendor/state.xml": '<?xml version="1.0"?><state/>' },
      {
        contentTypes: xml =>
          xml.replace(
            '<Default Extension="xml" ContentType="application/xml"/>',
            '<Default Extension="xml" ContentType="application/vnd.vendor.feature+xml"/>'
          )
      }
    );

    const out = await roundTrip(source);
    const contentTypes = requireEntryText(out, "[Content_Types].xml");

    expect(out.has("vendor/state.xml")).toBe(true);
    expect(contentTypes).toContain(
      '<Override PartName="/vendor/state.xml" ContentType="application/vnd.vendor.feature+xml"/>'
    );
    // The package-wide default stays what this writer needs for its own parts.
    expect(contentTypes).toContain('<Default Extension="xml" ContentType="application/xml"/>');
  });

  it("does not emit a duplicate Default when extension casing differs", async () => {
    // OPC matches an extension case-insensitively, so a media part recorded as
    // `PNG` and an opaque default keyed `png` are the same declaration.
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const source = await packageWithExtraParts(
      { "vendor/preview.PNG": png },
      { contentTypes: addDefault("PNG", "image/png") }
    );

    const out = await roundTrip(source);
    const contentTypes = requireEntryText(out, "[Content_Types].xml");
    const pngDefaults = [...contentTypes.matchAll(/<Default Extension="[Pp][Nn][Gg]"/g)];
    expect(pngDefaults).toHaveLength(1);
  });

  it("preserves a part's own relationships so what it points at still resolves", async () => {
    const item = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root><a/></root>';
    const props =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"' +
      ' ds:itemID="{2B7C7A0B-1111-2222-3333-444455556666}"/>';
    const propsRel =
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps";

    const source = await packageWithExtraParts({
      "customXml/item1.xml": item,
      "customXml/itemProps1.xml": props,
      "customXml/_rels/item1.xml.rels":
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${propsRel}" Target="itemProps1.xml"/></Relationships>`
    });

    const out = await roundTrip(source);

    expect(out.has("customXml/item1.xml")).toBe(true);
    expect(out.has("customXml/itemProps1.xml")).toBe(true);
    expect(entryText(out, "customXml/_rels/item1.xml.rels")).toContain('Target="itemProps1.xml"');
  });

  it("preserves through the streaming file loader, not just the buffer one", async () => {
    // `Workbook.read` buffers the package and hands each entry's bytes to the
    // loader; `Workbook.readFile` on Node streams the ZIP and hands over a
    // stream instead. They are two code paths through `_processDefaultEntry`,
    // and only the second one has to collect the bytes itself — so a test that
    // exercises only the buffer path proves nothing about reading a file.
    const vba = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 77);
    const source = await packageWithExtraParts(
      { "xl/vbaProject.bin": vba },
      {
        contentTypes: addOverride("/xl/vbaProject.bin", "application/vnd.ms-office.vbaProject"),
        workbookRels: addRel("rId99", VBA_REL, "vbaProject.bin")
      }
    );

    const dir = await mkdtemp(join(tmpdir(), "documonster-opaque-"));
    try {
      const path = join(dir, "macro-enabled.xlsm");
      await writeFile(path, source);

      const wb = Workbook.create();
      await Workbook.readFile(wb, path);
      const written = await Workbook.toBuffer(wb);
      await expectValidXlsx(written);

      const out = await extractAll(written);
      expect(out.get("xl/vbaProject.bin")?.data).toEqual(vba);
      expect(requireEntryText(out, "xl/_rels/workbook.xml.rels")).toContain(VBA_REL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a stale calculation chain instead of replaying it", async () => {
    // Not data loss: calcChain records the order Excel last evaluated formulas
    // in, which describes a workbook state the write invalidates. Excel rebuilds
    // it on open, so writing a stale one back asserts something false.
    const source = await packageWithExtraParts(
      {
        "xl/calcChain.xml":
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<c r="A1" i="1"/></calcChain>'
      },
      {
        contentTypes: addOverride(
          "/xl/calcChain.xml",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"
        )
      }
    );

    const out = await roundTrip(source);
    expect(out.has("xl/calcChain.xml")).toBe(false);
    expect(requireEntryText(out, "[Content_Types].xml")).not.toContain("calcChain");
  });

  it("drops a digital signature rather than emit one that cannot be valid", async () => {
    // Re-serialising any modelled part changes bytes the signature covers, so a
    // preserved signature would claim a guarantee that no longer holds. A file
    // that is honestly unsigned is the better outcome.
    const source = await packageWithExtraParts({
      "_xmlsignatures/sig1.xml": '<?xml version="1.0"?><Signature/>'
    });

    const out = await roundTrip(source);
    expect([...out.keys()].some(path => path.startsWith("_xmlsignatures/"))).toBe(false);
  });

  it("does not leave a dangling relationship behind a dropped part", async () => {
    // A relationship pointing at something we declined to write is exactly the
    // kind of package error Excel offers to repair, so dropping the part has to
    // drop its inbound relationship too.
    const revisionRel =
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/revisionHeaders";
    const source = await packageWithExtraParts(
      { "xl/revisions/revisionHeaders.xml": '<?xml version="1.0"?><headers/>' },
      { workbookRels: addRel("rId98", revisionRel, "revisions/revisionHeaders.xml") }
    );

    const out = await roundTrip(source);
    expect(out.has("xl/revisions/revisionHeaders.xml")).toBe(false);
    expect(requireEntryText(out, "xl/_rels/workbook.xml.rels")).not.toContain("revisionHeaders");
  });

  it("drops an opaque part whose only inbound relationship came from a deleted sheet", async () => {
    // The bytes live on the workbook while the relationship lives on the sheet, so
    // deleting the sheet removed the edge and left the part behind — shipping a
    // deleted sheet's printer configuration in a package nothing points at.
    const source = await packageWithExtraParts(
      { "xl/printerSettings/printerSettings1.bin": Uint8Array.of(1, 2, 3) },
      {
        contentTypes: addDefault(
          "bin",
          "application/vnd.openxmlformats-officedocument.printerSettings"
        ),
        sheetRels: addRel("rId7", PRINTER_SETTINGS_REL, "../printerSettings/printerSettings1.bin")
      }
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    Workbook.addWorksheet(wb, "Keeper");
    Workbook.removeWorksheet(wb, "Data");

    const written = await Workbook.toBuffer(wb);
    await expectValidXlsx(written);
    const out = await extractAll(written);

    expect(out.has("xl/printerSettings/printerSettings1.bin")).toBe(false);
    // And the now-unused extension default goes with it.
    expect(requireEntryText(out, "[Content_Types].xml")).not.toContain('Extension="bin"');
  });

  it("drops an opaque part reached only from a part whose rels are rebuilt without it", async () => {
    // A chart's `.rels` is regenerated from the chart model, so a vendor sidecar
    // hanging off it has no channel back into the output. Preserving the bytes
    // anyway would ship a part nothing can reach, which is the failure this is
    // supposed to prevent — so it is dropped, and reported.
    const source = await packageWithExtraParts(
      { "xl/vendor/chartState1.bin": Uint8Array.of(7, 7, 7) },
      {
        contentTypes: addOverride(
          "/xl/vendor/chartState1.bin",
          "application/vnd.vendor.chartstate"
        ),
        chartRels: addRel(
          "rId9",
          "http://example.com/vendor/chartState",
          "../vendor/chartState1.bin"
        )
      }
    );

    const out = await roundTrip(source);
    expect(out.has("xl/vendor/chartState1.bin")).toBe(false);
  });

  it("does not leave a dangling relationship inside a preserved part's own rels", async () => {
    // `collectOpaqueParts` promised that dropping a stale cache leaves no dangling
    // reference. That held only for the relationships this writer regenerates: a
    // preserved part's own `.rels` was re-emitted verbatim, so an edge from it to
    // a dropped part survived.
    const source = await packageWithExtraParts({
      "vendor/state.xml": '<?xml version="1.0"?><state/>',
      "vendor/_rels/state.xml.rels":
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://example.com/vendor/chain" Target="../xl/calcChain.xml"/>' +
        '<Relationship Id="rId2" Type="http://example.com/vendor/keep" Target="keep.xml"/>' +
        "</Relationships>",
      "vendor/keep.xml": '<?xml version="1.0"?><keep/>',
      "xl/calcChain.xml":
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<c r="A1" i="1"/></calcChain>'
    });

    const out = await roundTrip(source);

    expect(out.has("xl/calcChain.xml")).toBe(false);
    expect(out.has("vendor/state.xml")).toBe(true);
    // Reached only from the preserved part's own rels, so it must survive too.
    expect(out.has("vendor/keep.xml")).toBe(true);

    const rels = requireEntryText(out, "vendor/_rels/state.xml.rels");
    expect(rels).not.toContain("calcChain");
    expect(rels).toContain('Target="keep.xml"');
  });

  it("collapses a chain of preserved parts when the part they hang off is dropped", async () => {
    // Reachability is transitive: if the owner goes, everything reached only
    // through it goes too, rather than becoming a set of mutually-referencing
    // orphans.
    const source = await packageWithExtraParts({
      "_xmlsignatures/sig1.xml": '<?xml version="1.0"?><Signature/>',
      "_xmlsignatures/_rels/sig1.xml.rels":
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://example.com/sig/data" Target="sigData1.bin"/>' +
        "</Relationships>",
      "_xmlsignatures/sigData1.bin": Uint8Array.of(9, 9)
    });

    const out = await roundTrip(source);
    expect([...out.keys()].some(path => path.startsWith("_xmlsignatures/"))).toBe(false);
  });

  it("reports what it dropped, so a signature removal is not silent", async () => {
    // Removing an invalidated signature is the right call, but doing it without
    // saying so leaves a security-relevant change invisible: the caller ends up
    // with an unsigned file and no way to learn that it used to be signed.
    const source = await packageWithExtraParts({
      "_xmlsignatures/sig1.xml": '<?xml version="1.0"?><Signature/>',
      "xl/calcChain.xml": '<?xml version="1.0"?><calcChain/>'
    });

    const wb = Workbook.create();
    await Workbook.read(wb, source);

    const drops = Workbook.getModel(wb).opaqueDrops ?? [];
    expect(drops.map(drop => drop.reason).sort()).toEqual(["invalidated-signature", "stale-cache"]);
    expect(drops.find(drop => drop.reason === "invalidated-signature")?.path).toBe(
      "_xmlsignatures/sig1.xml"
    );
    expect(drops.every(drop => drop.description.length > 0)).toBe(true);
  });

  it("keeps preserved parts across an edit", async () => {
    // Preservation must not depend on the workbook being untouched — the whole
    // point is that a caller can read, change something, and write without
    // destroying the parts they never asked about.
    const vba = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 42);
    const source = await packageWithExtraParts(
      { "xl/vbaProject.bin": vba },
      {
        contentTypes: addOverride("/xl/vbaProject.bin", "application/vnd.ms-office.vbaProject"),
        workbookRels: addRel("rId99", VBA_REL, "vbaProject.bin")
      }
    );

    const wb = Workbook.create();
    await Workbook.read(wb, source);
    const sheet = Workbook.getWorksheet(wb, "Data")!;
    Cell.setValue(sheet, "B2", "edited");
    Worksheet.addAoa(sheet, [["more", "rows"]]);
    const written = await Workbook.toBuffer(wb);
    await expectValidXlsx(written);

    const out = await extractAll(written);
    expect(out.get("xl/vbaProject.bin")?.data).toEqual(vba);
    const reread = Workbook.create();
    await Workbook.read(reread, written);
    expect(Cell.getValue(Workbook.getWorksheet(reread, "Data")!, "B2")).toBe("edited");
  });

  it("preserves an unrecognised part nobody has classified", async () => {
    // The default has to be "keep": a part no one has seen before is more likely
    // to be someone's data than something we may delete.
    const source = await packageWithExtraParts({
      "xl/somethingFromTheFuture.xml": '<?xml version="1.0"?><future/>'
    });

    const out = await roundTrip(source);
    expect(out.has("xl/somethingFromTheFuture.xml")).toBe(true);
  });

  it("round-trips repeatedly without accumulating or shedding parts", async () => {
    // A preserved part has to survive the second cycle too — it is read back out
    // of the package it was written into, not out of the original.
    const source = await packageWithExtraParts(
      { "xl/vbaProject.bin": Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 7) },
      {
        contentTypes: addOverride("/xl/vbaProject.bin", "application/vnd.ms-office.vbaProject"),
        workbookRels: addRel("rId99", VBA_REL, "vbaProject.bin")
      }
    );

    const first = await roundTrip(source);
    const wb = Workbook.create();
    const repacked = new ZipArchive();
    for (const [path, entry] of first) {
      repacked.add(path, entry.data);
    }
    await Workbook.read(wb, await repacked.bytes());
    const second = await extractAll(await Workbook.toBuffer(wb));

    expect(second.get("xl/vbaProject.bin")?.data).toEqual(first.get("xl/vbaProject.bin")?.data);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
  });
});
