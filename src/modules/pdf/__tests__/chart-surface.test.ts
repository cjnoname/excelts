/**
 * Chart drawing surface — opacity and grayscale handling.
 *
 * The chart engine pushes colors straight into this surface, bypassing the cell
 * style pipeline, so both the black-and-white print option and per-paint opacity
 * have to be handled here.
 */
import { PdfContentStream } from "@pdf/core/pdf-stream";
import { FontManager } from "@pdf/font/font-manager";
import { createChartSurface } from "@pdf/render/chart-surface";
import { describe, expect, it } from "vitest";

function surface(grayscale = false) {
  const stream = new PdfContentStream();
  const alphaValues = new Set<number>();
  const api = createChartSurface(stream, new FontManager(), alphaValues, grayscale);
  return { stream, alphaValues, api, ops: () => stream.toString().replace(/\s+/g, " ").trim() };
}

describe("chart surface opacity", () => {
  it("should paint distinct fill and stroke opacities independently", () => {
    const { api, alphaValues, ops } = surface();
    api.drawRect({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: { r: 1, g: 0, b: 0, a: 0.3 },
      stroke: { r: 0, g: 0, b: 1, a: 0.9 },
      lineWidth: 2
    });

    // Both opacities must survive. A single `fillAndStroke` under one
    // ExtGState collapsed them, because /ca and /CA are set together.
    expect([...alphaValues].sort((a, b) => a - b)).toEqual([0.3, 0.9]);

    const out = ops();
    // Two passes: fill under its own state, then the path rebuilt and stroked.
    expect(out).toContain("f Q");
    expect(out).toContain("S Q");
    expect(out).not.toContain(" B");
  });

  it("should keep the single-pass path when both opacities agree", () => {
    const { api, ops } = surface();
    api.drawRect({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: { r: 1, g: 0, b: 0, a: 0.5 },
      stroke: { r: 0, g: 0, b: 1, a: 0.5 }
    });
    // No reason to pay for two passes when one graphics state suffices.
    expect(ops()).toContain("B");
  });

  it("should not leak a translucent fill onto a solid stroke", () => {
    const { api, alphaValues, ops } = surface();
    api.drawRect({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: { r: 1, g: 0, b: 0, a: 0.4 },
      stroke: { r: 0, g: 0, b: 1 }
    });
    // Only the fill's opacity is registered: the stroke runs in its own q/Q and
    // therefore starts opaque, so no explicit reset ExtGState is needed.
    expect([...alphaValues].sort((a, b) => a - b)).toEqual([0.4]);
    const out = ops();
    expect(out).toContain("/GS4000 gs");
    expect(out).not.toContain("/GS10000 gs");
  });

  it("should apply the dash pattern on the stroke pass of a split paint", () => {
    const { api, ops } = surface();
    // `drawPath` is optional on the interface; this surface always supplies it.
    expect(api.drawPath).toBeDefined();
    api.drawPath!(
      [
        { op: "move", x: 0, y: 0 },
        { op: "line", x: 10, y: 10 }
      ],
      {
        fill: { r: 1, g: 0, b: 0, a: 0.2 },
        stroke: { r: 0, g: 0, b: 1, a: 0.8 },
        dashPattern: [3, 2]
      }
    );
    const out = ops();
    expect(out).toContain("[3 2] 0 d");
    expect(out).toContain("S Q");
  });
});

describe("chart surface grayscale", () => {
  it("should grayscale fill and stroke while preserving opacity", () => {
    const { api, alphaValues, ops } = surface(true);
    api.drawRect({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: { r: 1, g: 0, b: 0, a: 0.3 },
      stroke: { r: 0, g: 1, b: 0, a: 0.9 }
    });

    expect([...alphaValues].sort((a, b) => a - b)).toEqual([0.3, 0.9]);
    const out = ops();
    const triples = [...out.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)/g)];
    // Guard against a vacuous pass if the color operators ever stop appearing.
    expect(triples.length).toBeGreaterThan(0);
    for (const m of triples) {
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      expect(Math.abs(r - g)).toBeLessThan(0.001);
      expect(Math.abs(g - b)).toBeLessThan(0.001);
    }
    // …and still distinguishable: red and green have different luma.
    expect(out).not.toMatch(/0 0 0 rg[\s\S]*0 0 0 RG/);
  });

  it("should grayscale line and text colors", () => {
    const { api, ops } = surface(true);
    api.drawLine({ x1: 0, y1: 0, x2: 5, y2: 5, color: { r: 1, g: 0, b: 0 } });
    api.drawText("hi", { x: 0, y: 0, color: { r: 0, g: 0, b: 1 } });
    const triples = [...ops().matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)/g)];
    expect(triples.length).toBeGreaterThan(0);
    for (const m of triples) {
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      expect(Math.abs(r - g)).toBeLessThan(0.001);
      expect(Math.abs(g - b)).toBeLessThan(0.001);
    }
  });
});
