import { measureTextWidthPx } from "@excel/utils/text-metrics";
import { measureText as measureType1Text } from "@pdf/font/metrics";
/**
 * Chart label reservation must be expressed in the same units the chart scene
 * draws text in.
 *
 * `@excel/utils/text-metrics` reports CSS-pixel widths for a point-sized font,
 * so it carries a 96/72 factor. A chart scene is one coordinate space: the SVG
 * emitter writes `font-size="N"` (user units) and the PDF surface passes `N`
 * through as points. Reserving the pixel width therefore over-allocated every
 * legend, title, and axis label by 4/3.
 */
import { describe, expect, it } from "vitest";

const POINTS_PER_PIXEL = 72 / 96;

describe("chart text measurement units", () => {
  it.each([
    ["Revenue for the northern region", 9],
    ["Quarterly Revenue Performance Summary", 14],
    ["Category number 1", 10]
  ])("reserves scene units for %j at size %i", (text, size) => {
    const reserved = measureTextWidthPx(text, { name: "arial", size }) * POINTS_PER_PIXEL;
    const drawn = measureType1Text(text, "Helvetica", size);

    // Arial vs Helvetica metrics and the pixel-rounding in the Excel engine keep
    // this from being exact; the point is that it is not off by a factor.
    expect(reserved).toBeGreaterThan(drawn * 0.8);
    expect(reserved).toBeLessThan(drawn * 1.2);
  });

  // Non-Latin text is deliberately absent: a standard Type1 base font has no
  // CJK glyphs, so its advance is a placeholder and cannot serve as the
  // reference width. Coverage for embedded-font measurement lives with the
  // font-planning tests.
  it("would be off by 4/3 if the pixel width were reserved directly", () => {
    const text = "Revenue for the northern region";
    const pixels = measureTextWidthPx(text, { name: "arial", size: 9 });
    const drawn = measureType1Text(text, "Helvetica", 9);

    expect(pixels / drawn).toBeGreaterThan(1.25);
  });
});
