import { describe, expect, it } from "vitest";

import { resolveWordLineMetrics } from "../layout/line-metrics";

describe("resolveWordLineMetrics", () => {
  it("splits leading evenly around the ink", () => {
    const line = resolveWordLineMetrics({ nominalHeight: 14.4, ascent: 8.616, descent: -2.484 });
    const above = line.baseline - 8.616;
    const below = line.height - line.baseline - 2.484;

    expect(above).toBeCloseTo(below, 10);
    expect(line.height).toBeCloseTo(14.4, 10);
  });

  it("grows an automatic line around tall ink", () => {
    const line = resolveWordLineMetrics({ nominalHeight: 12, ascent: 11, descent: -4 });

    expect(line.height).toBe(15);
    expect(line.baseline).toBe(11);
  });

  it("keeps an exact line at its declared height without moving the baseline", () => {
    const auto = resolveWordLineMetrics({ nominalHeight: 12, ascent: 11, descent: -4 });
    const exact = resolveWordLineMetrics({
      nominalHeight: 12,
      ascent: 11,
      descent: -4,
      exact: true
    });

    // `w:lineRule="exact"` fixes what follows this line, but the glyphs are
    // still drawn whole — they overlap the neighbouring lines instead of being
    // sliced, the same as a CSS line-height smaller than the font size.
    expect(exact.height).toBe(12);
    expect(exact.baseline).toBe(auto.baseline);
  });

  it("puts an inline image on the shared baseline", () => {
    const line = resolveWordLineMetrics({
      nominalHeight: 14.4,
      ascent: 8.616,
      descent: -2.484,
      imageAscent: 30
    });

    expect(line.baseline).toBe(30);
    expect(line.height).toBeCloseTo(32.484, 10);
  });

  it("keeps an exact-line image whole at its own baseline", () => {
    const line = resolveWordLineMetrics({
      nominalHeight: 8,
      ascent: 0,
      descent: 0,
      imageAscent: 30,
      exact: true
    });

    expect(line.height).toBe(8);
    // The picture still sits on its own baseline; the row/cell that contains it
    // is what bounds the overflow.
    expect(line.baseline).toBe(30);
  });
});
