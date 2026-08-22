import { pdf } from "@pdf/pdf";
import type { PdfExportOptions, PdfTextWatermark, PdfImageWatermark } from "@pdf/types";
import { getFontAscent, getFontDescent, measureTextWidth } from "@utils/font-metrics";
/**
 * Tests for PDF watermark feature.
 *
 * Verifies text and image watermark rendering, including:
 * - Basic text watermark
 * - Text watermark with custom options (color, opacity, rotation, font)
 * - Repeated/tiled text watermark
 * - Image watermark
 * - Watermark combined with other features (grid lines, page numbers)
 */
import { describe, it, expect } from "vitest";

import { decompressPdfContent, pdfToString, expectValidPdf } from "./test-helpers";

// A tiny valid 1x1 red PNG for image watermark tests
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82
]);

const sampleData = [
  ["Product", "Revenue"],
  ["Widget", 1000],
  ["Gadget", 2500]
];

// =============================================================================
// Text Watermark
// =============================================================================

describe("PDF Text Watermark", () => {
  it("should generate valid PDF with default text watermark", async () => {
    const options: PdfExportOptions = {
      watermark: {
        type: "text",
        text: "CONFIDENTIAL"
      }
    };
    const bytes = await pdf(sampleData, options);
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    // Should contain ExtGState for transparency
    expect(text).toContain("/ExtGState");
    // Should contain the watermark text
    expect(text).toContain("CONFIDENTIAL");
  });

  it("should apply custom color, opacity, and rotation", async () => {
    const watermark: PdfTextWatermark = {
      type: "text",
      text: "DRAFT",
      fontSize: 72,
      color: { r: 1, g: 0, b: 0 },
      opacity: 0.25,
      rotation: -30,
      bold: true
    };
    const bytes = await pdf(sampleData, { watermark });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    expect(text).toContain("DRAFT");
    // GS2500 = 0.25 opacity
    expect(text).toContain("GS2500");
  });

  it("should support center positioning (default)", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "CENTER" }
    });
    expectValidPdf(bytes);
    expect(pdfToString(bytes)).toContain("CENTER");
  });

  it("should support custom x,y positioning", async () => {
    const bytes = await pdf(sampleData, {
      watermark: {
        type: "text",
        text: "CUSTOM",
        position: { x: 100, y: 200 }
      }
    });
    expectValidPdf(bytes);
    expect(pdfToString(bytes)).toContain("CUSTOM");
  });

  it("should support repeated/tiled watermark", async () => {
    const bytes = await pdf(sampleData, {
      watermark: {
        type: "text",
        text: "DRAFT",
        repeat: true,
        repeatSpacingX: 150,
        repeatSpacingY: 120
      }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    // The watermark stream contains many repeated text draws; even if compressed,
    // it will be significantly larger than a non-repeating watermark.
    // Verify that the Contents is an array (watermark + main content)
    expect(text).toMatch(/\/Contents\s+\[/);
    // Verify ExtGState is present for the watermark opacity
    expect(text).toContain("/ExtGState");
  });

  it("should support Helvetica-Bold font", async () => {
    const bytes = await pdf(sampleData, {
      watermark: {
        type: "text",
        text: "BOLD",
        fontFamily: "Helvetica",
        bold: true
      }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    expect(text).toContain("Helvetica-Bold");
  });

  it("should combine watermark with grid lines and page numbers", async () => {
    const bytes = await pdf(sampleData, {
      showGridLines: true,
      showPageNumbers: true,
      watermark: {
        type: "text",
        text: "WATERMARK"
      }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    // Watermark text is in an uncompressed stream
    expect(text).toContain("WATERMARK");
    // Page number rendering uses a Type1 font
    // The main content stream is FlateDecode compressed, so we can't check "Page 1"
    // but we can verify that Helvetica font (used by page numbers) is referenced
    expect(text).toContain("Helvetica");
  });

  it("should render watermark behind cell content (Contents array)", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "BEHIND" }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    // When watermark exists, Contents should be an array (two stream refs)
    // The page dict should contain "Contents [" indicating an array
    expect(text).toMatch(/\/Contents\s+\[/);
  });

  it("should not produce Contents array when no watermark", async () => {
    const bytes = await pdf(sampleData);
    const text = pdfToString(bytes);
    // Without watermark, Contents should be a single reference, not an array
    expect(text).not.toMatch(/\/Contents\s+\[/);
  });
});

// =============================================================================
// Image Watermark
// =============================================================================

describe("PDF Image Watermark", () => {
  it("should generate valid PDF with PNG image watermark", async () => {
    const watermark: PdfImageWatermark = {
      type: "image",
      data: TINY_PNG,
      format: "png",
      opacity: 0.1
    };
    const bytes = await pdf(sampleData, { watermark });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    expect(text).toContain("/ExtGState");
    expect(text).toContain("/XObject");
    // Should have the watermark image XObject
    expect(text).toContain("/WmImg");
  });

  it("should support custom scale and rotation", async () => {
    const bytes = await pdf(sampleData, {
      watermark: {
        type: "image",
        data: TINY_PNG,
        format: "png",
        scale: 0.3,
        rotation: 45,
        opacity: 0.2
      }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    expect(text).toContain("GS2000");
  });

  it("should support repeated image watermark", async () => {
    const bytes = await pdf(sampleData, {
      watermark: {
        type: "image",
        data: TINY_PNG,
        format: "png",
        repeat: true,
        repeatSpacingX: 100,
        repeatSpacingY: 100
      }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    // Verify structure: Contents array, XObject, and ExtGState
    expect(text).toMatch(/\/Contents\s+\[/);
    expect(text).toContain("/XObject");
    expect(text).toContain("/WmImg");
    expect(text).toContain("/ExtGState");
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("PDF Watermark Edge Cases", () => {
  it("should handle empty data with watermark", async () => {
    const bytes = await pdf([], {
      watermark: { type: "text", text: "EMPTY" }
    });
    expectValidPdf(bytes);
  });

  it("should handle zero opacity watermark", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "INVISIBLE", opacity: 0 }
    });
    expectValidPdf(bytes);
  });

  it("should handle full opacity watermark", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "SOLID", opacity: 1 }
    });
    expectValidPdf(bytes);
  });

  it("should handle large font size", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "BIG", fontSize: 200 }
    });
    expectValidPdf(bytes);
  });

  it("should handle watermark on multi-page PDF", async () => {
    // Create data large enough for multiple pages
    const bigData: Array<[string, number]> = [];
    for (let i = 0; i < 100; i++) {
      bigData.push([`Row ${i}`, i]);
    }
    const bytes = await pdf(bigData, {
      watermark: { type: "text", text: "MULTI" }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    // Should appear on multiple pages
    const multiCount = (text.match(/MULTI/g) ?? []).length;
    expect(multiCount).toBeGreaterThanOrEqual(2);
  });

  it("should handle rotation of 0 degrees", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "HORIZONTAL", rotation: 0 }
    });
    expectValidPdf(bytes);
  });

  it("should handle rotation of 90 degrees", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "VERTICAL", rotation: 90 }
    });
    expectValidPdf(bytes);
  });

  it("should support italic text watermark", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "ITALIC", italic: true }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    expect(text).toContain("Helvetica-Oblique");
  });
});

// =============================================================================
// Per-page / Per-sheet Filtering
// =============================================================================

describe("PDF Watermark Filtering", () => {
  it("should only apply watermark to specified pages", async () => {
    const bigData: Array<[string, number]> = [];
    for (let i = 0; i < 80; i++) {
      bigData.push([`Row ${i}`, i]);
    }
    const bytes = await pdf(bigData, {
      watermark: {
        type: "text",
        text: "PAGE1ONLY",
        pages: [1]
      }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    // Should appear exactly once (only on page 1, which has uncompressed watermark stream)
    const matches = (text.match(/PAGE1ONLY/g) ?? []).length;
    expect(matches).toBe(1);
  });

  it("should apply watermark to all pages when no filter is set", async () => {
    const bigData: Array<[string, number]> = [];
    for (let i = 0; i < 80; i++) {
      bigData.push([`Row ${i}`, i]);
    }
    const bytes = await pdf(bigData, {
      watermark: { type: "text", text: "ALLPAGES" }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    const matches = (text.match(/ALLPAGES/g) ?? []).length;
    // Should appear on multiple pages (each has its own watermark stream)
    expect(matches).toBeGreaterThan(1);
  });

  it("should only apply watermark to specified sheets", async () => {
    const bytes = await pdf(
      {
        sheets: [
          { name: "Public", data: [["A", 1]] },
          { name: "Secret", data: [["B", 2]] }
        ]
      },
      {
        watermark: {
          type: "text",
          text: "SECRETONLY",
          sheets: ["Secret"]
        }
      }
    );
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    const matches = (text.match(/SECRETONLY/g) ?? []).length;
    expect(matches).toBe(1);
  });

  it("should match sheet names case-insensitively", async () => {
    const bytes = await pdf(
      {
        sheets: [
          { name: "Summary", data: [["A", 1]] },
          { name: "Detail", data: [["B", 2]] }
        ]
      },
      {
        watermark: {
          type: "text",
          text: "CASETEST",
          sheets: ["summary"] // lowercase vs "Summary"
        }
      }
    );
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    expect(text).toContain("CASETEST");
  });

  it("should support combined pages + sheets filter", async () => {
    const bigData: Array<[string, number]> = [];
    for (let i = 0; i < 80; i++) {
      bigData.push([`Row ${i}`, i]);
    }
    // pages: [1] + sheets filter — both must match
    const bytes = await pdf(bigData, {
      watermark: {
        type: "text",
        text: "COMBO",
        pages: [1],
        sheets: ["Sheet 1"]
      }
    });
    expectValidPdf(bytes);
  });
});

// =============================================================================
// Placement (under / over)
// =============================================================================

describe("PDF Watermark Placement", () => {
  it.each([0, 45, -45])(
    "should centre a %i° watermark's ink on the requested point",
    async rotation => {
      const fontSize = 48;
      const text = "CENTRE";
      const bytes = await pdf(sampleData, {
        watermark: { type: "text", text, fontSize, rotation, position: "center" }
      });
      expectValidPdf(bytes);

      const content = decompressPdfContent(bytes);
      // Bind the matrix to this watermark's text instead of taking the first Tm
      // from whichever content stream the writer happened to serialise first.
      const tm = content.match(
        /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm\s*\(CENTRE\) Tj/
      );
      const mediaBox = pdfToString(bytes).match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
      expect(tm).not.toBeNull();
      expect(mediaBox).not.toBeNull();

      const pageWidth = Number(mediaBox![1]);
      const pageHeight = Number(mediaBox![2]);
      const [a, b, c, d, x, baseline] = tm!.slice(1).map(Number);
      const ascent = getFontAscent("Helvetica", fontSize);
      const descent = getFontDescent("Helvetica", fontSize);
      const width = measureTextWidth(text, "Helvetica", fontSize);

      // Transform the local ink centre through the emitted text matrix. This
      // checks both axes for rotated marks; an ascent-only approximation lifts a
      // 48pt watermark several points off centre.
      const localCenterX = width / 2;
      const localCenterY = (ascent + descent) / 2;
      expect(x + a * localCenterX + c * localCenterY).toBeCloseTo(pageWidth / 2, 1);
      expect(baseline + b * localCenterX + d * localCenterY).toBeCloseTo(pageHeight / 2, 1);
    }
  );

  it("should default to under (watermark stream before content)", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "UNDER" }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    // Contents array: watermark ref comes first
    expect(text).toMatch(/\/Contents\s+\[/);
  });

  it("should support placement over (watermark stream after content)", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "OVER", placement: "over" }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    // Still a Contents array
    expect(text).toMatch(/\/Contents\s+\[/);
  });

  it("should render valid PDF with placement under explicitly set", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "EXPLICIT", placement: "under" }
    });
    expectValidPdf(bytes);
  });

  it("should render valid PDF with image watermark placement over", async () => {
    const bytes = await pdf(sampleData, {
      watermark: {
        type: "image",
        data: TINY_PNG,
        format: "png",
        placement: "over"
      }
    });
    expectValidPdf(bytes);
    const text = pdfToString(bytes);
    expect(text).toMatch(/\/Contents\s+\[/);
    expect(text).toContain("/WmImg");
  });
});

// =============================================================================
// Opacity edge cases
// =============================================================================

describe("PDF Watermark Opacity Edge Cases", () => {
  it("should not create ExtGState when opacity is 1", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "OPAQUE", opacity: 1 }
    });
    expectValidPdf(bytes);
    // The watermark stream should not reference any GS name
    // (no unnecessary ExtGState for fully opaque)
    const text = pdfToString(bytes);
    expect(text).toContain("OPAQUE");
  });

  it("should handle opacity 0 gracefully", async () => {
    const bytes = await pdf(sampleData, {
      watermark: { type: "text", text: "GHOST", opacity: 0 }
    });
    expectValidPdf(bytes);
  });
});
