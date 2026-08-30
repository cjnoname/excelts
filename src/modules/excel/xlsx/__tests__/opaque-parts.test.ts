/**
 * Opaque part policy.
 *
 * These are the decisions that determine whether a real workbook survives a
 * round-trip, so they are tested as decisions — directly, on paths — rather than
 * only through a full read/write cycle where a wrong answer shows up as a
 * missing file three layers away.
 */

import {
  classifyOpaquePart,
  isRelationshipsPart,
  ownerOfRelationshipsPart,
  relationshipsPathFor,
  resolveRelationshipTarget
} from "@excel/xlsx/opaque-parts";
import { describe, expect, it } from "vitest";

describe("classifyOpaquePart", () => {
  it("preserves the parts whose loss is silent data loss", () => {
    // Each of these was measured disappearing from a read → write cycle before
    // opaque preservation existed. `vbaProject.bin` is the worst of them: the
    // workbook content type *is* round-tripped, so the output kept claiming to
    // be macro-enabled while carrying no macros.
    for (const path of [
      "xl/vbaProject.bin",
      "docProps/custom.xml",
      "customXml/item1.xml",
      "customXml/itemProps1.xml",
      "xl/connections.xml",
      "xl/queryTables/queryTable1.xml",
      "xl/printerSettings/printerSettings1.bin",
      "xl/richData/rdrichvalue.xml",
      "xl/cellimages.xml"
    ]) {
      expect(classifyOpaquePart(path), path).toBeUndefined();
    }
  });

  it("preserves an unclassified part rather than guessing", () => {
    // The default has to be "keep". A part no one has seen before is more likely
    // to be someone's data than something we may delete, and a slightly larger
    // file is a much cheaper mistake than a missing feature.
    expect(classifyOpaquePart("xl/somethingNobodyHasSeen.xml")).toBeUndefined();
    expect(classifyOpaquePart("vendor/futureFeature.bin")).toBeUndefined();
  });

  it("drops caches that describe a workbook state the write invalidates", () => {
    expect(classifyOpaquePart("xl/calcChain.xml")?.reason).toBe("stale-cache");
    expect(classifyOpaquePart("xl/volatileDependencies.xml")?.reason).toBe("stale-cache");
    expect(classifyOpaquePart("xl/revisions/revisionHeaders.xml")?.reason).toBe("stale-cache");
    expect(classifyOpaquePart("xl/revisions/revisionLog1.xml")?.reason).toBe("stale-cache");
  });

  it("drops a digital signature rather than emit one that cannot be valid", () => {
    // Re-serialising any modelled part changes bytes the signature covers, so
    // writing it back would produce a file that claims to be signed and is not.
    const signature = classifyOpaquePart("_xmlsignatures/sig1.xml");
    expect(signature?.reason).toBe("invalidated-signature");
    expect(classifyOpaquePart("_xmlsignatures/_rels/origin.sigs.rels")?.reason).toBe(
      "invalidated-signature"
    );
  });

  it("explains itself, so the reason can be reported to a caller", () => {
    expect(classifyOpaquePart("xl/calcChain.xml")?.description).toMatch(/rebuilds it on open/);
    expect(classifyOpaquePart("_xmlsignatures/sig1.xml")?.description).toMatch(
      /this write replaces/
    );
  });

  it("classifies case-insensitively", () => {
    // OPC part names are compared case-insensitively, and real packages in the
    // wild do vary the casing.
    expect(classifyOpaquePart("xl/CalcChain.xml")?.reason).toBe("stale-cache");
    expect(classifyOpaquePart("_XmlSignatures/sig1.xml")?.reason).toBe("invalidated-signature");
  });
});

describe("isRelationshipsPart", () => {
  it("recognises a relationships part at any depth", () => {
    expect(isRelationshipsPart("_rels/.rels")).toBe(true);
    expect(isRelationshipsPart("xl/_rels/workbook.xml.rels")).toBe(true);
    expect(isRelationshipsPart("xl/worksheets/_rels/sheet1.xml.rels")).toBe(true);
  });

  it("does not mistake a part that merely mentions rels", () => {
    expect(isRelationshipsPart("xl/relsSomething.xml")).toBe(false);
    expect(isRelationshipsPart("xl/_rels/notrels.xml")).toBe(false);
    expect(isRelationshipsPart("xl/workbook.xml")).toBe(false);
  });
});

describe("relationshipsPathFor / ownerOfRelationshipsPart", () => {
  it("round-trips a part path through its relationships path", () => {
    for (const path of ["xl/workbook.xml", "xl/vbaProject.bin", "customXml/item1.xml"]) {
      const rels = relationshipsPathFor(path);
      expect(ownerOfRelationshipsPart(rels), path).toBe(path);
    }
  });

  it("handles the package root", () => {
    expect(relationshipsPathFor("[Content_Types].xml")).toBe("_rels/[Content_Types].xml.rels");
    expect(ownerOfRelationshipsPart("_rels/.rels")).toBe("");
  });

  it("returns undefined for something that is not a relationships path", () => {
    expect(ownerOfRelationshipsPart("xl/workbook.xml")).toBeUndefined();
  });
});

describe("resolveRelationshipTarget", () => {
  it("resolves against the declaring part's directory, not the package root", () => {
    // This is the detail that decides whether a preserved part can be found
    // again: a workbook relationship targeting `vbaProject.bin` means
    // `xl/vbaProject.bin`, because `xl/workbook.xml` declares it.
    expect(resolveRelationshipTarget("xl/workbook.xml", "vbaProject.bin")).toBe(
      "xl/vbaProject.bin"
    );
    expect(resolveRelationshipTarget("xl/workbook.xml", "connections.xml")).toBe(
      "xl/connections.xml"
    );
    expect(
      resolveRelationshipTarget("xl/worksheets/sheet1.xml", "../printerSettings/ps1.bin")
    ).toBe("xl/printerSettings/ps1.bin");
  });

  it("climbs out of the workbook directory", () => {
    expect(resolveRelationshipTarget("xl/workbook.xml", "../customXml/item1.xml")).toBe(
      "customXml/item1.xml"
    );
  });

  it("resolves from the package root", () => {
    expect(resolveRelationshipTarget("_rels/.rels", "docProps/custom.xml")).toBe(
      "docProps/custom.xml"
    );
  });

  it("treats a leading slash as package-absolute", () => {
    expect(resolveRelationshipTarget("xl/workbook.xml", "/xl/vbaProject.bin")).toBe(
      "xl/vbaProject.bin"
    );
  });

  it("normalises redundant segments", () => {
    expect(resolveRelationshipTarget("xl/workbook.xml", "./worksheets/sheet1.xml")).toBe(
      "xl/worksheets/sheet1.xml"
    );
  });

  it("returns undefined for a target outside the package", () => {
    // An external relationship has no part to preserve, and treating a URL as a
    // path would invent an entry named `https:/example.com/...`.
    expect(
      resolveRelationshipTarget("xl/workbook.xml", "https://example.com/a.xlsx", "External")
    ).toBeUndefined();
    expect(
      resolveRelationshipTarget("xl/workbook.xml", "mailto:someone@example.com")
    ).toBeUndefined();
    expect(
      resolveRelationshipTarget("xl/workbook.xml", "https://example.com/a.xlsx")
    ).toBeUndefined();
  });
});
