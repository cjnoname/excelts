import { buildTtfWithCmap } from "@pdf/__tests__/ttf-test-utils";
import { compilePdfFontConfig } from "@pdf/font/font-config";
import {
  buildFontPlan,
  createType1FontPlanFace,
  createType3FontPlanFace,
  type FontPlanConfig
} from "@pdf/font/font-plan";
import { describe, expect, it } from "vitest";

function font(name: string, codepoints: number[], widths?: number[]): Uint8Array {
  const segments = codepoints.map((codePoint, index) => ({
    start: codePoint,
    end: codePoint,
    delta: index + 1 - codePoint
  }));
  return buildTtfWithCmap(segments, codepoints.length + 1, {
    familyName: name,
    advanceWidths: widths ?? [500, ...codepoints.map(() => 500)]
  });
}

function planOne(config: ReturnType<typeof compilePdfFontConfig>, family: string, text: string) {
  const builder = buildFontPlan(config);
  builder.collect({ text, family, bold: false, italic: false });
  return builder.finalize();
}

describe("buildFontPlan", () => {
  it("resolves names and aliases, but sends unknown names directly to default", () => {
    const config = compilePdfFontConfig({
      default: { regular: font("Default", [0x41, 0x42]) },
      families: [
        { name: "Primary", aliases: ["UI Alias"], faces: { regular: font("Primary", [0x41]) } },
        { name: "Unused", faces: { regular: font("Unused", [0x42]) } }
      ],
      fallbackFamilies: ["Primary"]
    });

    expect(planOne(config, " ui   alias ", "A").segments[0].faceId).toBe("family-0:regular");
    expect(planOne(config, "Missing", "B").segments[0].faceId).toBe("default:regular");
  });

  it("only uses the named, explicit fallback, and default families", () => {
    const config = compilePdfFontConfig({
      default: { regular: font("Default", [0x43]) },
      families: [
        { name: "Primary", faces: { regular: font("Primary", [0x41]) } },
        { name: "Arbitrary", faces: { regular: font("Arbitrary", [0x42]) } },
        { name: "Fallback", faces: { regular: font("Fallback", [0x43]) } }
      ],
      fallbackFamilies: ["Fallback"]
    });

    const plan = planOne(config, "Primary", "B");
    expect(plan.segments[0].faceId).toBe("default:regular");
    expect(plan.faces).toHaveLength(1);
  });

  it("reapplies the originally requested style to every fallback family", () => {
    const config = compilePdfFontConfig({
      default: {
        regular: font("Default Regular", [0x43]),
        boldItalic: font("Default Bold Italic", [0x44])
      },
      families: [
        {
          name: "Primary",
          faces: {
            regular: font("Primary Regular", [0x41, 0x42]),
            boldItalic: font("Primary Bold Italic", [0x41])
          }
        },
        {
          name: "Fallback",
          faces: {
            regular: font("Fallback Regular", [0x42]),
            boldItalic: font("Fallback Bold Italic", [0x42])
          }
        }
      ],
      fallbackFamilies: ["Fallback"]
    });
    const builder = buildFontPlan(config);
    builder.collect({ text: "AB", family: "Primary", bold: true, italic: true });
    const plan = builder.finalize();

    expect(plan.segments.map(segment => segment.faceId)).toEqual([
      "family-0:boldItalic",
      "family-1:boldItalic"
    ]);
  });

  it("falls back through style slots within a family before changing family", () => {
    const config = compilePdfFontConfig({
      default: {
        regular: font("CJK Regular", [0x4e2d]),
        italic: font("Latin Italic", [0x41])
      }
    });
    const builder = buildFontPlan(config);
    builder.collect({ text: "A中", family: "any", bold: false, italic: true });

    expect(builder.finalize().segments.map(segment => segment.faceId)).toEqual([
      "default:italic",
      "default:regular"
    ]);
  });

  it("keeps combining, variation-selector, and ZWJ clusters on one covering face", () => {
    const heart = 0x2764;
    const sun = 0x2600;
    const config = compilePdfFontConfig({
      default: { regular: font("Default", [0x41, 0x301, heart, sun]) },
      families: [
        { name: "Primary", faces: { regular: font("Primary", [0x41]) } },
        { name: "Emoji", faces: { regular: font("Emoji", [heart, sun]) } }
      ],
      fallbackFamilies: ["Emoji"]
    });
    const builder = buildFontPlan(config);
    builder.collect({ text: "A\u0301A\ufe0f❤‍☀", family: "Primary", bold: false, italic: false });
    const plan = builder.finalize();

    expect(plan.segments.map(segment => segment.text)).toEqual(["Á", "A️", "❤‍☀"]);
    expect(plan.segments[0].faceId).toBe("default:regular");
    expect(plan.segments[1].faceId).toBe("family-0:regular");
    expect(plan.segments[2].faceId).toBe("family-1:regular");
    expect(plan.segments[2].codepoints).toEqual([heart, 0x200d, sun]);
  });

  it("reports normalized TTF metrics and gathers per-face codepoints at finalize", () => {
    const config = compilePdfFontConfig({
      default: { regular: font("Metrics", [0x41, 0x42], [400, 600, 750]) }
    });
    const builder = buildFontPlan(config);
    builder.collect({ text: "AB", family: "anything", bold: false, italic: false });
    const plan = builder.finalize();

    expect(plan.segments[0]).toMatchObject({ width: 1.35, ascent: 0.8, descent: -0.2 });
    expect([...plan.faces[0].codepoints]).toEqual([0x41, 0x42]);
    expect(plan.faces[0].resourceName).toBe(plan.segments[0].resourceName);
    expect(() => builder.collect({ text: "C", bold: false, italic: false })).toThrow(/finalized/);
  });

  it("adapts a legacy single TTF face and supports planning-only Type1/Type3 faces", () => {
    const compiled = compilePdfFontConfig({ default: { regular: font("Legacy", [0x41]) } });
    const legacy = buildFontPlan(compiled.default.regular);
    legacy.collect({ text: "A", bold: true, italic: true });
    expect(legacy.finalize().segments[0]).toMatchObject({ faceId: "default:regular", kind: "ttf" });

    const generic: FontPlanConfig = {
      default: { regular: createType1FontPlanFace("Helvetica") },
      families: [{ name: "Symbols", faces: { regular: createType3FontPlanFace() } }]
    };
    const type1 = buildFontPlan(generic);
    type1.collect({ text: "A", bold: false, italic: false });
    expect(type1.finalize().segments[0]).toMatchObject({
      kind: "type1",
      width: 0.667,
      ascent: 0.718,
      descent: -0.207
    });

    const type3 = buildFontPlan(generic);
    type3.collect({ text: "✓", family: "Symbols", bold: false, italic: false });
    expect(type3.finalize().segments[0].kind).toBe("type3");
    expect(type3.finalize().segments[0].width).toBeGreaterThan(0);
  });
});
