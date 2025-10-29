import { describe, it, expect } from "vitest";
import { copyStyle } from "../../../utils/copy-style.js";
import { styles } from "../../utils/styles.js";

const style1 = {
  numFmt: styles.numFmts.numFmt1,
  font: styles.fonts.broadwayRedOutline20,
  alignment: styles.namedAlignments.topLeft,
  border: styles.borders.thickRainbow,
  fill: styles.fills.redGreenDarkTrellis
};
const style2 = {
  fill: styles.fills.rgbPathGrad
};

describe("copyStyle", () => {
  it("should copy a style deeply", () => {
    const copied = copyStyle(style1);
    expect(copied).toEqual(style1);
    expect(copied!.font).not.toBe(style1.font);
    expect(copied!.alignment).not.toBe(style1.alignment);
    expect(copied!.border).not.toBe(style1.border);
    expect(copied!.fill).not.toBe(style1.fill);

    expect(copyStyle({})).toEqual({});
  });

  it("should copy fill.stops deeply", () => {
    const copied = copyStyle(style2);
    expect(copied!.fill.stops).toEqual(style2.fill.stops);
    expect(copied!.fill.stops).not.toBe(style2.fill.stops);
    expect(copied!.fill.stops[0]).not.toBe(style2.fill.stops[0]);
  });

  it("should return the argument if a falsy value passed", () => {
    expect(copyStyle(null)).toBe(null);
    expect(copyStyle(undefined)).toBe(undefined);
  });
});
