/**
 * `w:shd` pattern flattening.
 *
 * A shading is a two-colour pattern: `w:fill` behind, `w:color` in the pattern.
 * Renderers paint one flat colour, so the pattern has to be reduced to the tone
 * it reads as — dropping `w:color` entirely painted a 25 % grey box white.
 */
import { describe, it, expect } from "vitest";

import { resolveShadingFill } from "../query/style-resolve";

describe("resolveShadingFill", () => {
  it("paints the fill for a clear pattern", () => {
    expect(resolveShadingFill({ fill: "F0F0F0", pattern: "clear" })).toBe("F0F0F0");
    expect(resolveShadingFill({ fill: "F0F0F0" })).toBe("F0F0F0");
  });

  it("paints nothing for nil, or for an automatic fill with no pattern", () => {
    expect(resolveShadingFill({ fill: "112233", pattern: "nil" })).toBeUndefined();
    expect(resolveShadingFill({ fill: "auto" })).toBeUndefined();
    expect(resolveShadingFill(undefined)).toBeUndefined();
  });

  it("blends a percentage pattern by its literal coverage", () => {
    // Word's `pct25` of black on white is the familiar 25 % grey.
    expect(resolveShadingFill({ fill: "FFFFFF", color: "000000", pattern: "pct25" })).toBe(
      "BFBFBF"
    );
    expect(resolveShadingFill({ fill: "FFFFFF", color: "000000", pattern: "pct50" })).toBe(
      "808080"
    );
    expect(resolveShadingFill({ fill: "FFFFFF", color: "000000", pattern: "pct10" })).toBe(
      "E6E6E6"
    );
  });

  it("lets a solid pattern hide the fill entirely", () => {
    expect(resolveShadingFill({ fill: "FFFFFF", color: "FF0000", pattern: "solid" })).toBe(
      "FF0000"
    );
  });

  it("blends a hatch by its approximate coverage, thin variants more lightly", () => {
    const thin = resolveShadingFill({
      fill: "FFFFFF",
      color: "000000",
      pattern: "thinDiagStripe"
    })!;
    const heavy = resolveShadingFill({ fill: "FFFFFF", color: "000000", pattern: "diagStripe" })!;
    const cross = resolveShadingFill({ fill: "FFFFFF", color: "000000", pattern: "diagCross" })!;
    const lightness = (hex: string) => Number.parseInt(hex.slice(0, 2), 16);
    // Denser hatch → darker result.
    expect(lightness(thin)).toBeGreaterThan(lightness(heavy));
    expect(lightness(heavy)).toBeGreaterThan(lightness(cross));
  });

  it("blends onto the page when a pattern has no fill behind it", () => {
    expect(resolveShadingFill({ fill: "auto", color: "000000", pattern: "pct10" })).toBe("E6E6E6");
  });

  it("ignores an automatic pattern colour rather than darkening the fill", () => {
    expect(resolveShadingFill({ fill: "D9E2F3", color: "auto", pattern: "pct25" })).toBe("D9E2F3");
  });

  it("normalises short hex to a canonical upper-case six digits", () => {
    expect(resolveShadingFill({ fill: "f00" })).toBe("FF0000");
    expect(resolveShadingFill({ fill: "#abc" })).toBe("AABBCC");
    expect(resolveShadingFill({ fill: "not-a-colour" })).toBeUndefined();
  });
});
