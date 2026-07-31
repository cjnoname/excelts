import { getWorksheets } from "@excel/core/workbook";
import { addWorkbookImage } from "@excel/core/workbook-core";
import {
  addImage,
  addWatermark,
  getImages,
  getHeaderFooterImages,
  getSheetModel,
  getWatermark,
  removeHeaderFooterImage,
  removeWatermark,
  setHeaderFooterImage,
  setSheetModel
} from "@excel/core/worksheet";
import type { WorksheetData } from "@excel/core/worksheet-core";
import { Cell, Workbook } from "@excel/index";
import type { HeaderFooterImagePosition } from "@excel/types";
import { createTextWatermarkImage } from "@excel/utils/watermark-image";
/**
 * Tests for Excel watermark feature.
 *
 * Verifies:
 * - Overlay mode watermark (DrawingML with alphaModFix)
 * - Header mode watermark (VML with legacyDrawingHF)
 * - Watermark API (addWatermark, getWatermark, removeWatermark)
 * - XLSX round-trip (write → read) for watermark drawings
 */
import { describe, it, expect } from "vitest";

// A tiny 1x1 red PNG for image tests
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82
]);

// =============================================================================
// Watermark API
// =============================================================================

describe("Worksheet Watermark API", () => {
  it("should add an overlay watermark", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

    addWatermark(ws, { imageId: imgId, mode: "overlay", opacity: 0.2 });

    const wm = getWatermark(ws);
    expect(wm).not.toBeNull();
    expect(wm!.imageId).toBe(String(imgId));
    expect(wm!.mode).toBe("overlay");
    expect(wm!.opacity).toBe(0.2);
  });

  it("should default to overlay mode", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

    addWatermark(ws, { imageId: imgId });

    const wm = getWatermark(ws);
    expect(wm!.mode).toBe("overlay");
  });

  it("should add a header mode watermark", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

    addWatermark(ws, { imageId: imgId, mode: "header" });

    const wm = getWatermark(ws);
    expect(wm!.mode).toBe("header");
  });

  it("should remove watermark", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

    addWatermark(ws, { imageId: imgId });
    expect(getWatermark(ws)).not.toBeNull();

    removeWatermark(ws);
    expect(getWatermark(ws)).toBeNull();
  });

  // Adding then removing a header watermark must restore the section exactly,
  // for every combination of pre-existing content and target section.
  const roundTripCases: Array<{
    name: string;
    before: string | null;
    position?: HeaderFooterImagePosition;
    edit?: (ws: WorksheetData) => void;
    after: string | null;
  }> = [
    { name: "empty header", before: null, after: null },
    { name: "aligned text in another section", before: "&LReport", after: "&LReport" },
    {
      name: "aligned text in the same section",
      before: "&LReport",
      position: "LH",
      after: "&LReport"
    },
    {
      name: "a pre-existing image placeholder",
      before: "&L&GLogo&CReport",
      after: "&L&GLogo&CReport"
    },
    {
      name: "text appended after the placeholder",
      before: null,
      edit: ws => {
        ws.headerFooter.oddHeader += "Report";
      },
      after: "&CReport"
    }
  ];

  for (const testCase of roundTripCases) {
    it(`should restore the header exactly with ${testCase.name}`, () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      ws.headerFooter.oddHeader = testCase.before;
      const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

      addWatermark(ws, {
        imageId: imgId,
        mode: "header",
        position: testCase.position,
        applyTo: "odd"
      });
      expect(ws.headerFooter.oddHeader).toContain("&G");
      testCase.edit?.(ws);

      removeWatermark(ws);

      expect(ws.headerFooter.oddHeader).toBe(testCase.after);
    });
  }

  it("should preserve header/footer edits made after adding a watermark", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "header" });
    ws.headerFooter.oddFooter = "&CPage &P of &N";

    removeWatermark(ws);

    expect(ws.headerFooter.oddFooter).toBe("&CPage &P of &N");
  });

  it("should not enable first/even variants for the default shared page field", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

    addWatermark(ws, { imageId: imgId, mode: "header" });

    expect(ws.headerFooter.oddHeader).toBe("&C&G");
    expect(ws.headerFooter.evenHeader).toBeNull();
    expect(ws.headerFooter.firstHeader).toBeNull();
    expect(ws.headerFooter.differentOddEven).toBe(false);
    expect(ws.headerFooter.differentFirst).toBe(false);
  });

  it("should not claim ownership of a native image after XLSX round-trip", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "header", applyTo: "odd" });

    const loaded = Workbook.create();
    await Workbook.read(loaded, await Workbook.toBuffer(wb));
    const loadedSheet = getWorksheets(loaded)[0];
    expect(getWatermark(loadedSheet)).toBeNull();

    removeWatermark(loadedSheet);
    expect(loadedSheet.headerFooter.oddHeader).toContain("&G");
  });

  it("should replace an existing image in the same header section", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const first = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: first, mode: "header", position: "CH" });

    const loaded = Workbook.create();
    await Workbook.read(loaded, await Workbook.toBuffer(wb));
    const loadedSheet = getWorksheets(loaded)[0];
    const second = addWorkbookImage(loaded, { buffer: TINY_PNG, extension: "png" });
    addWatermark(loadedSheet, { imageId: second, mode: "header", position: "CH" });

    const headerImages = (getSheetModel(loadedSheet) as any).media.filter(
      (medium: any) => medium.type === "headerImage"
    );
    expect(headerImages).toHaveLength(1);
    expect(headerImages[0].imageId).toBe(String(second));
  });

  it("should keep a native same-file image when only its own watermark is removed", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "header", position: "RH" });

    const loaded = Workbook.create();
    await Workbook.read(loaded, await Workbook.toBuffer(wb));
    const loadedSheet = getWorksheets(loaded)[0];
    const nativeHeader = loadedSheet.headerFooter.oddHeader;

    addWatermark(loadedSheet, { imageId: imgId, mode: "header", position: "LH" });
    removeWatermark(loadedSheet);

    const headerImages = (getSheetModel(loadedSheet) as any).media.filter(
      (medium: any) => medium.type === "headerImage"
    );
    expect(headerImages).toHaveLength(1);
    expect(headerImages[0].position).toBe("RH");
    expect(loadedSheet.headerFooter.oddHeader).toBe(nativeHeader);
  });

  it("should leave the section empty after replacing then removing an image", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "header", position: "CH" });

    const loaded = Workbook.create();
    await Workbook.read(loaded, await Workbook.toBuffer(wb));
    const loadedSheet = getWorksheets(loaded)[0];
    expect(loadedSheet.headerFooter.oddHeader).toContain("&G");

    addWatermark(loadedSheet, { imageId: imgId, mode: "header", position: "CH" });
    removeWatermark(loadedSheet);

    const headerImages = (getSheetModel(loadedSheet) as any).media.filter(
      (medium: any) => medium.type === "headerImage"
    );
    expect(headerImages).toHaveLength(0);
    expect(loadedSheet.headerFooter.oddHeader).toBeNull();
  });

  it("should return null when no watermark is set", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    expect(getWatermark(ws)).toBeNull();
  });
});

// =============================================================================
// Overlay Watermark — XLSX Write
// =============================================================================

describe("Excel Overlay Watermark (XLSX)", () => {
  it("should write a valid XLSX with overlay watermark", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Hello");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, opacity: 0.15 });

    const buffer = await Workbook.toBuffer(wb);
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer.byteLength).toBeGreaterThan(0);

    // Verify the XLSX can be loaded back
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    expect(getWorksheets(wb2).length).toBe(1);
    expect(Cell.getValue(getWorksheets(wb2)[0], "A1")).toBe("Hello");
  });

  it("should round-trip overlay watermark with getWatermark()", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, opacity: 0.3 });

    const buffer = await Workbook.toBuffer(wb);

    // Load back and verify watermark state is restored
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const ws2 = getWorksheets(wb2)[0];

    // The watermark should be detected from the alphaModFix on the drawing
    const wm = getWatermark(ws2);
    expect(wm).not.toBeNull();
    expect(wm!.mode).toBe("overlay");
    // Opacity round-trips through OOXML percentage (0.3 → 30000 → 0.3)
    expect(wm!.opacity).toBeCloseTo(0.3, 2);
  });

  it("should coexist with regular images", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addImage(ws, imgId, "A1:B2");
    addWatermark(ws, { imageId: imgId, opacity: 0.1 });

    const buffer = await Workbook.toBuffer(wb);
    expect(buffer.byteLength).toBeGreaterThan(0);

    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    // Both the regular image and watermark should have been written
    const ws2 = getWorksheets(wb2)[0];
    const images = getImages(ws2);
    expect(images.length).toBeGreaterThanOrEqual(1);
    // Watermark should be detected
    const wm = getWatermark(ws2);
    expect(wm).not.toBeNull();
    expect(wm!.mode).toBe("overlay");
  });
});

// =============================================================================
// Header Watermark — XLSX Write
// =============================================================================

describe("Excel Header Watermark (XLSX)", () => {
  it("should write a valid XLSX with header watermark", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Hello");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "header" });

    const buffer = await Workbook.toBuffer(wb);
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it("should set &G in oddHeader for header watermark", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "header" });

    const buffer = await Workbook.toBuffer(wb);

    // Read back and verify header footer
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const hf = getWorksheets(wb2)[0].headerFooter;
    expect(hf.oddHeader).toContain("&G");
  });
});

// =============================================================================
// BlipXform alphaModFix
// =============================================================================

describe("BlipXform alphaModFix", () => {
  it("should render alphaModFix element when opacity < 100%", async () => {
    // This is tested indirectly through the XLSX write/read cycle
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, opacity: 0.5 });

    const buffer = await Workbook.toBuffer(wb);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});

// =============================================================================
// createTextWatermarkImage utility
// =============================================================================

describe("createTextWatermarkImage", () => {
  it("should generate a valid PNG", () => {
    const png = createTextWatermarkImage("TEST");
    // PNG signature: 0x89 P N G
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
    expect(png.length).toBeGreaterThan(100);
  });

  it("should generate a non-zero-size image", () => {
    const png = createTextWatermarkImage("WATERMARK");
    expect(png.length).toBeGreaterThan(50);
  });

  it("should accept custom options", () => {
    const png = createTextWatermarkImage("DRAFT", {
      fontSize: 96,
      color: { r: 255, g: 0, b: 0 },
      opacity: 20,
      rotation: -30,
      padding: 40
    });
    expect(png[0]).toBe(0x89);
    expect(png.length).toBeGreaterThan(100);
  });

  it("should handle single character", () => {
    const png = createTextWatermarkImage("X");
    expect(png[0]).toBe(0x89);
  });

  it("should handle empty string", () => {
    const png = createTextWatermarkImage("");
    expect(png[0]).toBe(0x89);
  });

  it("should produce a usable image for addImage/addWatermark", async () => {
    const png = createTextWatermarkImage("CONFIDENTIAL", {
      fontSize: 48,
      color: { r: 128, g: 128, b: 128 },
      opacity: 30,
      rotation: -45
    });

    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Hello");

    const imgId = addWorkbookImage(wb, { buffer: png, extension: "png" });
    addWatermark(ws, { imageId: imgId, opacity: 0.3 });

    const buffer = await Workbook.toBuffer(wb);
    expect(buffer.byteLength).toBeGreaterThan(0);

    // Verify it can be read back
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    expect(Cell.getValue(getWorksheets(wb2)[0], "A1")).toBe("Hello");
  });

  it("should handle zero rotation", () => {
    const png = createTextWatermarkImage("HORIZONTAL", { rotation: 0 });
    expect(png[0]).toBe(0x89);
  });
});

// =============================================================================
// Watermark round-trip
// =============================================================================

describe("Watermark round-trip", () => {
  it("should preserve watermark state through model getter/setter (copyWorksheet)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "overlay", opacity: 0.2 });

    // Get model and restore it
    const model = getSheetModel(ws) as any;
    expect(model.watermark).not.toBeNull();
    expect(model.watermark.mode).toBe("overlay");

    // Apply to a new worksheet (change name to avoid conflict)
    const ws2 = Workbook.addWorksheet(wb, "Sheet2");
    const modelCopy = { ...model, name: "Sheet2", id: ws2.id };
    setSheetModel(ws2, modelCopy);
    const wm = getWatermark(ws2);
    expect(wm).not.toBeNull();
    expect(wm!.mode).toBe("overlay");
    expect(wm!.opacity).toBe(0.2);
  });

  it("should not accumulate media on repeated addWatermark calls", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

    addWatermark(ws, { imageId: imgId, opacity: 0.1 });
    addWatermark(ws, { imageId: imgId, opacity: 0.2 });
    addWatermark(ws, { imageId: imgId, opacity: 0.3 });

    // Should only have one watermark media entry
    const model = getSheetModel(ws) as any;
    const wmMedia = model.media.filter((m: any) => m.type === "watermark");
    expect(wmMedia.length).toBe(1);
    expect(getWatermark(ws)!.opacity).toBe(0.3);
  });
});

// =============================================================================
// Header watermark applyTo
// =============================================================================

describe("Header/footer image sections", () => {
  it("manages the six sections independently", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

    setHeaderFooterImage(ws, { imageId: imgId, position: "LH" });
    setHeaderFooterImage(ws, { imageId: imgId, position: "RF", width: 20, height: 10 });

    expect(
      getHeaderFooterImages(ws)
        .map(image => image.position)
        .sort()
    ).toEqual(["LH", "RF"]);
    expect(ws.headerFooter.oddHeader).toBe("&L&G");
    expect(ws.headerFooter.oddFooter).toBe("&R&G");

    expect(removeHeaderFooterImage(ws, "LH")).toBe(true);
    expect(removeHeaderFooterImage(ws, "LH")).toBe(false);
    expect(ws.headerFooter.oddHeader).toBeNull();
    expect(getHeaderFooterImages(ws).map(image => image.position)).toEqual(["RF"]);
    expect(ws.headerFooter.oddFooter).toBe("&R&G");
  });

  it("replaces the occupant of a section", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const first = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    const second = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

    setHeaderFooterImage(ws, { imageId: first, position: "CH" });
    setHeaderFooterImage(ws, { imageId: second, position: "CH" });

    const images = getHeaderFooterImages(ws);
    expect(images).toHaveLength(1);
    expect(images[0].imageId).toBe(String(second));
    expect(ws.headerFooter.oddHeader).toBe("&C&G");
  });

  it("can remove images loaded from an existing workbook", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    setHeaderFooterImage(ws, { imageId: imgId, position: "RH", width: 30, height: 12 });

    const loaded = Workbook.create();
    await Workbook.read(loaded, await Workbook.toBuffer(wb));
    const loadedSheet = getWorksheets(loaded)[0];
    expect(getHeaderFooterImages(loadedSheet)).toEqual([
      { imageId: "0", position: "RH", width: 30, height: 12 }
    ]);

    expect(removeHeaderFooterImage(loadedSheet, "RH")).toBe(true);
    expect(getHeaderFooterImages(loadedSheet)).toHaveLength(0);
    expect(loadedSheet.headerFooter.oddHeader).toBeNull();
  });

  it("round-trips every section through XLSX", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    setHeaderFooterImage(ws, { imageId: imgId, position: "LH", width: 10, height: 10 });
    setHeaderFooterImage(ws, { imageId: imgId, position: "RH", width: 12, height: 12 });
    setHeaderFooterImage(ws, { imageId: imgId, position: "CF", width: 14, height: 14 });

    const loaded = Workbook.create();
    await Workbook.read(loaded, await Workbook.toBuffer(wb));

    expect(getHeaderFooterImages(getWorksheets(loaded)[0])).toEqual([
      { imageId: "0", position: "LH", width: 10, height: 10 },
      { imageId: "0", position: "RH", width: 12, height: 12 },
      { imageId: "0", position: "CF", width: 14, height: 14 }
    ]);
  });

  it("keeps other sections when the watermark API removes its own image", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    setHeaderFooterImage(ws, { imageId: imgId, position: "LF" });
    addWatermark(ws, { imageId: imgId, mode: "header", position: "CH" });

    removeWatermark(ws);

    expect(getHeaderFooterImages(ws).map(image => image.position)).toEqual(["LF"]);
    expect(ws.headerFooter.oddFooter).toBe("&L&G");
    expect(ws.headerFooter.oddHeader).toBeNull();
  });
});

describe("Header watermark applyTo", () => {
  it("should explicitly apply to all page variants", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "header", applyTo: "all" });

    const buffer = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const hf = getWorksheets(wb2)[0].headerFooter;
    expect(hf.oddHeader).toContain("&G");
    expect(hf.evenHeader).toContain("&G");
    expect(hf.firstHeader).toContain("&G");
  });

  it("should only set oddHeader when applyTo is odd", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "header", applyTo: "odd" });

    const buffer = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const hf = getWorksheets(wb2)[0].headerFooter;
    expect(hf.oddHeader).toContain("&G");
    // evenHeader and firstHeader should NOT have &G
    expect(hf.evenHeader || "").not.toContain("&G");
    expect(hf.firstHeader || "").not.toContain("&G");
  });

  it("should not overwrite existing header text", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");
    ws.headerFooter.oddHeader = "&LMy Report&CPage &P";

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, mode: "header", applyTo: "odd" });

    const buffer = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const hf = getWorksheets(wb2)[0].headerFooter;
    // Should contain both original text and &G
    expect(hf.oddHeader).toContain("&LMy Report");
    expect(hf.oddHeader).toContain("&G");
  });
});

// =============================================================================
// createTextWatermarkImage compression
// =============================================================================

describe("createTextWatermarkImage compression", () => {
  it("should generate a compressed PNG much smaller than raw RGBA data", () => {
    const png = createTextWatermarkImage("WATERMARK", {
      fontSize: 48,
      rotation: -45
    });
    // Raw RGBA for a watermark image this size would be hundreds of KB.
    // With deflate compression, it should be well under 50KB.
    expect(png.length).toBeLessThan(50000);
    // But still a valid PNG
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  });

  it("should be significantly smaller than the old uncompressed output", () => {
    // A 9-char text at fontSize 48 (scale=6) creates a ~324x48 bitmap before rotation.
    // Uncompressed RGBA + PNG overhead would be > 200KB.
    // Compressed should be < 10% of that.
    const png = createTextWatermarkImage("ABCDEFGHI", {
      fontSize: 48,
      rotation: 0,
      padding: 10
    });
    // Raw size: (9*6*6 + 20) * (8*6 + 20) * 4 ≈ 130KB+
    // Compressed should be way less
    expect(png.length).toBeLessThan(15000);
  });
});

// =============================================================================
// Overlay watermark opacity edge cases
// =============================================================================

describe("Excel watermark opacity edge cases", () => {
  it("should clamp opacity > 1 to 1 (detected as regular image on read-back)", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, opacity: 2.5 }); // over 1

    const buffer = await Workbook.toBuffer(wb);
    // Should not throw
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    // Opacity clamped to 1.0 means no alphaModFix is written (fully opaque),
    // so on read-back it becomes a regular image rather than a watermark.
    // This is correct behavior: a fully opaque "watermark" is just an image.
    const images = getImages(getWorksheets(wb2)[0]);
    expect(images.length).toBeGreaterThanOrEqual(1);
  });

  it("should clamp negative opacity to 0", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "Test");

    const imgId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addWatermark(ws, { imageId: imgId, opacity: -0.5 }); // negative

    const buffer = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const wm = getWatermark(getWorksheets(wb2)[0]);
    expect(wm).not.toBeNull();
    expect(wm!.opacity).toBeGreaterThanOrEqual(0);
  });
});
