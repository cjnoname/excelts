import { loadIife } from "@test/browser/load-iife";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Smoke test for the shipped `documonster.draw.iife.min.js` bundle.
 *
 * Added with the bundle, which the module went several releases without: `documonster/draw`
 * was published in `exports` while nothing built an artifact for it, so the shared drawing
 * engine had no script-tag path at all.
 *
 * The rasteriser is the part worth loading in a real browser rather than trusting to a Node
 * test. It reaches `system-raster-font`, which has a `.browser` variant precisely because the
 * Node one carries font paths a browser cannot open — so a bundle that resolved the wrong
 * variant would either fail here or quietly ship the tables.
 */
describe("Documonster.Draw IIFE bundle", () => {
  let Draw: {
    toSvg: (list: unknown) => string;
    rasterizeToRgba: (
      list: unknown,
      options?: unknown
    ) => { width: number; height: number; data: Uint8Array };
    measureText: (text: string, style: unknown) => number;
    wrapText: (text: string, style: unknown, width: number) => unknown;
    renderDrawList: (list: unknown, surface: unknown) => void;
    cssColour: (token: string) => { r: number; g: number; b: number; a: number };
  };

  /**
   * A blue rectangle with white text on it, built the way a consumer would: paints come
   * from `cssColour`, not from a hand-written tuple. Writing `[0.15, 0.39, 0.92, 1]`
   * instead — as the first version of this test did — makes the SVG surface emit a `<rect>`
   * with a nonsense fill while the rasteriser paints nothing at all, which is the shape of
   * bug this test exists to catch.
   */
  let LIST: unknown;

  beforeAll(async () => {
    Draw = await loadIife("draw", "Draw");
    LIST = {
      width: 40,
      height: 20,
      children: [
        {
          kind: "rect",
          x: 0,
          y: 0,
          width: 40,
          height: 20,
          paint: { fill: Draw.cssColour("#2563eb") }
        },
        {
          kind: "text",
          x: 4,
          y: 14,
          lines: [{ text: "hi", dy: 0 }],
          style: { size: 10, family: "sans-serif", fill: Draw.cssColour("#ffffff") }
        }
      ]
    };
  }, 60000);

  it("exposes the walker, both surfaces and text measurement", () => {
    expect(typeof Draw.renderDrawList).toBe("function");
    expect(typeof Draw.toSvg).toBe("function");
    expect(typeof Draw.rasterizeToRgba).toBe("function");
    expect(typeof Draw.measureText).toBe("function");
    expect(typeof Draw.wrapText).toBe("function");
  });

  it("serialises a display list to SVG", () => {
    const svg = Draw.toSvg(LIST);
    expect(svg.startsWith("<svg")).toBe(true);
    // Assert the paint, not just the tag: a malformed colour still yields a `<rect>`.
    expect(svg).toContain('fill="#2563eb"');
    expect(svg).toContain("hi");
  });

  it("rasterises the same list to the same picture", () => {
    const raster = Draw.rasterizeToRgba(LIST);
    expect(raster.width).toBe(40);
    expect(raster.height).toBe(20);
    expect(raster.data.length).toBe(raster.width * raster.height * 4);
    // The rect covers the whole list, so every pixel is opaque and the corner is the
    // rect's own colour — the same #2563eb the SVG surface wrote, in the other backend.
    expect([...raster.data.slice(0, 4)]).toEqual([37, 99, 235, 255]);
  });

  it("measures text in CSS pixels for a point size", () => {
    const style = { size: 10, family: "sans-serif" };
    const narrow = Draw.measureText("hi", style);
    expect(narrow).toBeGreaterThan(0);
    expect(Draw.measureText("hiiii", style)).toBeGreaterThan(narrow);
    expect(Draw.measureText("", style)).toBe(0);
  });
});
