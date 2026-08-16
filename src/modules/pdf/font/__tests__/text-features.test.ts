import { buildTtfWithCmap } from "@pdf/__tests__/ttf-test-utils";
import { PdfDocumentBuilder } from "@pdf/builder/document-builder";
import { describe, expect, it } from "vitest";

/**
 * These tests pin the *contract* that unsupported text is detectable, not that
 * it renders correctly — shaping, bidi and color glyph rendering are outside
 * this writer's scope, and silently emitting wrong text is the failure mode
 * being guarded against.
 */

function latinFont(): Uint8Array {
  return buildTtfWithCmap([{ start: 0x20, end: 0x7e, delta: 1 - 0x20 }], 0x60, {
    familyName: "Probe"
  });
}

/** A font covering a code point range, so coverage warnings stay out of the way. */
function fontCovering(start: number, end: number, familyName: string): Uint8Array {
  return buildTtfWithCmap(
    [
      { start: 0x20, end: 0x7e, delta: 1 - 0x20 },
      { start, end, delta: 0x100 - start }
    ],
    0x400,
    { familyName }
  );
}

async function warningsFor(text: string, font: Uint8Array): Promise<string[]> {
  const warnings: string[] = [];
  const builder = new PdfDocumentBuilder({ fonts: { default: { regular: font } } });
  builder.onWarning(message => warnings.push(message));
  builder.addPage().drawText(text, { x: 72, y: 700 });
  await builder.build();
  return warnings;
}

describe("unsupported text feature diagnostics", () => {
  it("warns that Arabic needs shaping this writer does not do", async () => {
    const warnings = await warningsFor("مرحبا", fontCovering(0x0600, 0x06ff, "ArabicProbe"));
    expect(warnings.some(w => w.includes("Arabic") && w.includes("GSUB/GPOS"))).toBe(true);
  });

  it("names each complex script present", async () => {
    const warnings = await warningsFor("नमस्ते สวัสดี", fontCovering(0x0900, 0x0e7f, "IndicProbe"));
    const shaping = warnings.find(w => w.includes("GSUB/GPOS")) ?? "";
    expect(shaping).toContain("Devanagari");
    expect(shaping).toContain("Thai");
  });

  it("warns about right-to-left text ordering", async () => {
    const warnings = await warningsFor("שלום", fontCovering(0x0590, 0x05ff, "HebrewProbe"));
    expect(warnings.some(w => w.includes("right-to-left"))).toBe(true);
    // Hebrew needs bidi, not shaping — do not over-report.
    expect(warnings.some(w => w.includes("GSUB/GPOS"))).toBe(false);
  });

  it("stays silent for text it renders correctly", async () => {
    const warnings = await warningsFor(
      "Hello, world! Привет 你好",
      fontCovering(0x0400, 0x9fff, "WideProbe")
    );
    expect(warnings).toEqual([]);
  });

  it("reports each script once regardless of how much text uses it", async () => {
    const font = fontCovering(0x0600, 0x06ff, "ArabicProbe");
    const warnings: string[] = [];
    const builder = new PdfDocumentBuilder({ fonts: { default: { regular: font } } });
    builder.onWarning(message => warnings.push(message));
    const page = builder.addPage();
    for (let i = 0; i < 50; i++) {
      page.drawText("مرحبا", { x: 72, y: 700 - i * 12 });
    }
    await builder.build();
    expect(warnings.filter(w => w.includes("GSUB/GPOS"))).toHaveLength(1);
  });

  it("warns that color glyph tables are not embedded", async () => {
    const font = buildTtfWithCmap([{ start: 0x20, end: 0x7e, delta: 1 - 0x20 }], 0x60, {
      familyName: "EmojiProbe",
      extraTableTags: ["COLR"]
    });
    const warnings = await warningsFor("hello", font);
    expect(warnings.some(w => w.includes("EmojiProbe") && w.includes("color glyph tables"))).toBe(
      true
    );
  });

  it("also reports through the legacy single-font API", async () => {
    // `embedFont()` (and build-time system font auto-discovery) take a different
    // tracking path than a configured family set; both must warn.
    const font = buildTtfWithCmap(
      [
        { start: 0x20, end: 0x7e, delta: 1 - 0x20 },
        { start: 0x0600, end: 0x06ff, delta: 0x100 - 0x0600 }
      ],
      0x400,
      { familyName: "LegacyProbe", extraTableTags: ["COLR"] }
    );
    const warnings: string[] = [];
    const builder = new PdfDocumentBuilder();
    builder.onWarning(message => warnings.push(message));
    builder.embedFont(font);
    builder.addPage().drawText("مرحبا", { x: 72, y: 700 });
    await builder.build();

    expect(warnings.some(w => w.includes("GSUB/GPOS"))).toBe(true);
    expect(warnings.some(w => w.includes("right-to-left"))).toBe(true);
    expect(warnings.some(w => w.includes("LegacyProbe"))).toBe(true);
  });

  it("does not misreport a left-to-right historic script as right-to-left", async () => {
    // Cypriot was written right-to-left historically but is Bidi_Class=L in
    // Unicode. A hand-written code point range around it would false-positive.
    const warnings = await warningsFor(
      "\u{10800}\u{10801}",
      fontCovering(0x10800, 0x1080f, "CypriotProbe")
    );
    expect(warnings.some(w => w.includes("right-to-left"))).toBe(false);
  });

  it("does not warn about shaping when the document has none of it", async () => {
    const warnings = await warningsFor("plain ascii", latinFont());
    expect(warnings).toEqual([]);
  });
});
