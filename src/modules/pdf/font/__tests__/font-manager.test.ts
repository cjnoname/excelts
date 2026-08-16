import { buildTtfWithCmap } from "@pdf/__tests__/ttf-test-utils";
import { PdfWriter } from "@pdf/core/pdf-writer";
import { compilePdfFontConfig } from "@pdf/font/font-config";
import { FontManager } from "@pdf/font/font-manager";
import { describe, expect, it } from "vitest";

function font(
  name: string,
  codepoints: number[],
  widths?: number[],
  metrics?: { ascent: number; descent: number }
): Uint8Array {
  return buildTtfWithCmap(
    codepoints.map((codePoint, index) => ({
      start: codePoint,
      end: codePoint,
      delta: index + 1 - codePoint
    })),
    codepoints.length + 1,
    {
      familyName: name,
      advanceWidths: widths ?? [500, ...codepoints.map(() => 500)],
      ...metrics
    }
  );
}

describe("configured FontManager", () => {
  it("routes graphemes through requested family, explicit fallback, and default only", () => {
    const manager = new FontManager(
      compilePdfFontConfig({
        default: { regular: font("Default", [0x43]) },
        families: [
          {
            name: "Primary",
            faces: {
              regular: font("Primary Regular", [0x41]),
              boldItalic: font("Primary Bold Italic", [0x41])
            }
          },
          { name: "Arbitrary", faces: { regular: font("Arbitrary", [0x42]) } },
          {
            name: "Fallback",
            faces: {
              regular: font("Fallback Regular", [0x42]),
              boldItalic: font("Fallback Bold Italic", [0x42])
            }
          }
        ],
        fallbackFamilies: ["Fallback"]
      })
    );
    const request = manager.resolveFont("Primary", true, true);
    const segments = manager.routeText("ABC", request);

    expect(segments.map(segment => segment.text)).toEqual(["A", "B", "C"]);
    expect(segments.map(segment => segment.resourceName)).toHaveLength(3);
    expect(manager.measureText("ABC", request, 10)).toBe(15);
  });

  it("never splits combining, variation-selector, or ZWJ graphemes", () => {
    const heart = 0x2764;
    const sun = 0x2600;
    const manager = new FontManager(
      compilePdfFontConfig({
        default: { regular: font("Default", [0x41, heart, sun]) },
        families: [
          { name: "Primary", faces: { regular: font("Primary", [0x41]) } },
          { name: "Emoji", faces: { regular: font("Emoji", [heart, sun]) } }
        ],
        fallbackFamilies: ["Emoji"]
      })
    );
    const request = manager.resolveFont("Primary", false, false);

    expect(manager.routeText("A\u0301A\ufe0f❤‍☀", request).map(segment => segment.text)).toEqual([
      "Á",
      "A️",
      "❤‍☀"
    ]);
  });

  it("subsets and encodes each concrete face independently", async () => {
    const manager = new FontManager(
      compilePdfFontConfig({
        default: { regular: font("Default", [0x43]) },
        families: [
          { name: "Primary", faces: { regular: font("Primary", [0x41]) } },
          { name: "Fallback", faces: { regular: font("Fallback", [0x42]) } }
        ],
        fallbackFamilies: ["Fallback"]
      })
    );
    const request = manager.resolveFont("Primary", false, false);
    const segments = manager.routeText("ABC", request);
    const resources = await manager.writeFontResources(new PdfWriter());

    expect(new Set(segments.map(segment => segment.resourceName)).size).toBe(3);
    expect(resources.size).toBe(4);
    expect(segments.map(segment => manager.encodeText(segment.text, segment.resourceName))).toEqual(
      ["<0001>", "<0001>", "<0001>"]
    );
  });

  it("uses .notdef width for uncovered text and preserves its Unicode", async () => {
    const manager = new FontManager(
      compilePdfFontConfig({
        default: { regular: font("Default", [0x41], [700, 500]) }
      })
    );
    const request = manager.resolveFont("Missing", false, false);
    const segments = manager.routeText("中", request);

    expect(segments[0].width).toBe(0.7);
    manager.beginBuild();
    await manager.writeFontResources(new PdfWriter());
    expect(manager.encodeText("中", segments[0].resourceName)).not.toBe("<0000>");
    expect(manager.getMissingCodePoints()).toEqual(new Set([0x4e2d]));
    manager.endBuild();
  });

  it("takes vertical metrics from every fallback face used by the text", () => {
    const manager = new FontManager(
      compilePdfFontConfig({
        default: { regular: font("Default", [0x41]) },
        families: [
          {
            name: "Short",
            faces: {
              regular: font("Short", [0x41], undefined, { ascent: 600, descent: -100 })
            }
          },
          {
            name: "Tall",
            faces: {
              regular: font("Tall", [0x4e2d], undefined, { ascent: 1000, descent: -300 })
            }
          }
        ],
        fallbackFamilies: ["Tall"]
      })
    );
    const request = manager.resolveFont("Short", false, false);
    const metrics = manager.measureTextMetrics("A中", request, 10);

    expect(metrics.width).toBe(10);
    expect(metrics.ascent).toBe(10);
    expect(metrics.descent).toBe(-3);
  });
});
