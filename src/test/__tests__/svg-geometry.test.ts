/**
 * The equivalence oracle itself.
 *
 * It is the tool that makes a renderer migration provable, so its own
 * canonicalisation has to be exactly as loose as claimed and no looser.
 */

import { describeSvgGeometry, extractSvgGeometry } from "@test/svg-geometry";
import { describe, expect, it } from "vitest";

const wrap = (body: string): string => `<svg width="20" height="20">${body}</svg>`;

describe("benign representation differences compare equal", () => {
  it("treats an M/L path and a polyline as the same shape", () => {
    expect(describeSvgGeometry(wrap('<path d="M0 0 L5 5 L10 0" fill="none" stroke="#f00"/>'))).toBe(
      describeSvgGeometry(wrap('<polyline points="0,0 5,5 10,0" fill="none" stroke="#f00"/>'))
    );
  });

  it("treats a closed M/L/Z path and a polygon as the same shape", () => {
    expect(describeSvgGeometry(wrap('<path d="M0 0 L5 5 L10 0 Z" fill="#f00"/>'))).toBe(
      describeSvgGeometry(wrap('<polygon points="0,0 5,5 10,0" fill="#f00"/>'))
    );
  });

  it("treats a line and a two-point polyline as the same shape", () => {
    expect(describeSvgGeometry(wrap('<line x1="1" y1="2" x2="3" y2="4" stroke="#f00"/>'))).toBe(
      describeSvgGeometry(wrap('<polyline points="1,2 3,4" stroke="#f00"/>'))
    );
  });

  it("treats an absent stroke-width as 1", () => {
    expect(describeSvgGeometry(wrap('<polyline points="0,0 1,1" stroke="#f00"/>'))).toBe(
      describeSvgGeometry(wrap('<polyline points="0,0 1,1" stroke="#f00" stroke-width="1"/>'))
    );
  });

  it("ignores attribute order and number formatting", () => {
    expect(
      describeSvgGeometry(wrap('<rect x="1" y="2" width="3" height="4" fill="#ff0000"/>'))
    ).toBe(describeSvgGeometry(wrap('<rect fill="#f00" height="4.000" width="3" y="2.0" x="1"/>')));
  });

  it("normalises equivalent colour spellings", () => {
    expect(describeSvgGeometry(wrap('<rect width="1" height="1" fill="#f00"/>'))).toBe(
      describeSvgGeometry(wrap('<rect width="1" height="1" fill="rgb(255,0,0)"/>'))
    );
  });
});

describe("anything that would move a pixel still differs", () => {
  it("catches a moved coordinate", () => {
    expect(describeSvgGeometry(wrap('<rect x="1" y="0" width="4" height="4"/>'))).not.toBe(
      describeSvgGeometry(wrap('<rect x="2" y="0" width="4" height="4"/>'))
    );
  });

  it("catches a curve where there was a line", () => {
    // The canonicalisation's boundary: an M/L path folds into a polyline, a path
    // with a cubic must not.
    const line = wrap('<path d="M0 0 L10 10" fill="none" stroke="#f00"/>');
    const curve = wrap('<path d="M0 0 C0 5 5 10 10 10" fill="none" stroke="#f00"/>');
    expect(describeSvgGeometry(line)).not.toBe(describeSvgGeometry(curve));
    expect(extractSvgGeometry(curve)[0].kind).toBe("path");
    expect(extractSvgGeometry(line)[0].kind).toBe("polyline");
  });

  it("catches a changed colour", () => {
    expect(describeSvgGeometry(wrap('<rect width="1" height="1" fill="#f00"/>'))).not.toBe(
      describeSvgGeometry(wrap('<rect width="1" height="1" fill="#0f0"/>'))
    );
  });

  it("catches a changed alpha", () => {
    expect(describeSvgGeometry(wrap('<rect width="1" height="1" fill="#ff000080"/>'))).not.toBe(
      describeSvgGeometry(wrap('<rect width="1" height="1" fill="#f00"/>'))
    );
  });

  it("catches a changed stroke width", () => {
    expect(
      describeSvgGeometry(wrap('<polyline points="0,0 1,1" stroke="#f00" stroke-width="2"/>'))
    ).not.toBe(describeSvgGeometry(wrap('<polyline points="0,0 1,1" stroke="#f00"/>')));
  });

  it("catches a dropped shape", () => {
    expect(
      describeSvgGeometry(wrap('<rect width="1" height="1"/><circle cx="1" cy="1" r="1"/>'))
    ).not.toBe(describeSvgGeometry(wrap('<rect width="1" height="1"/>')));
  });

  it("catches reordered shapes, because paint order is visible", () => {
    expect(
      describeSvgGeometry(
        wrap('<rect width="1" height="1" fill="#f00"/><rect width="2" height="2" fill="#0f0"/>')
      )
    ).not.toBe(
      describeSvgGeometry(
        wrap('<rect width="2" height="2" fill="#0f0"/><rect width="1" height="1" fill="#f00"/>')
      )
    );
  });

  it("records text content and position", () => {
    const shapes = extractSvgGeometry(wrap('<text x="3" y="4" fill="#f00">Hi</text>'));
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ kind: "text", coords: [3, 4], text: "Hi" });
  });

  it("strips tspan markup but keeps the text", () => {
    expect(
      extractSvgGeometry(
        wrap('<text x="0" y="0" fill="#f00"><tspan>A</tspan><tspan>B</tspan></text>')
      )[0].text
    ).toBe("AB");
  });
});
