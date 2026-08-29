import {
  computeTextBlockHeight,
  computeTextStartY,
  computeTextX,
  wrapTextLines,
  alphaGsName
} from "@pdf/render/page-renderer";
/**
 * Focused tests for page renderer helpers.
 */
import { describe, expect, it } from "vitest";

describe("page-renderer helpers", () => {
  describe("computeTextX", () => {
    it("should apply indent for left-aligned text", () => {
      expect(computeTextX("left", { x: 10, width: 100 }, 20, 8)).toBe(21);
    });

    it("should ignore indent for centered text", () => {
      expect(computeTextX("center", { x: 10, width: 100 }, 20, 8)).toBe(50);
    });

    it("should use asymmetric padding when provided", () => {
      const rect = { x: 10, width: 100 };
      const padLeft = 5;
      const padRight = 10;

      // left-aligned: x + padLeft + indent
      expect(computeTextX("left", rect, 20, 0, padLeft, padRight)).toBe(15);

      // right-aligned: x + width - padRight - textWidth
      expect(computeTextX("right", rect, 20, 0, padLeft, padRight)).toBe(80);

      // center: unchanged by padding
      expect(computeTextX("center", rect, 20, 0, padLeft, padRight)).toBe(50);
    });

    it("should clamp right-aligned text to padLeft boundary", () => {
      // Right-aligned with very wide text that would start before cell left
      const rect = { x: 10, width: 50 };
      // textWidth=100 > rect.width, so right-align would put x at 10+50-5-100 = -45
      // Clamp to minX = x + padLeft = 15
      expect(computeTextX("right", rect, 100, 0, 5, 5)).toBe(15);
    });
  });

  describe("computeTextStartY", () => {
    const rect = { x: 0, y: 10, width: 100, height: 40 };

    it("should order top above middle above bottom", () => {
      const top = computeTextStartY("top", rect, 12, 8);
      const middle = computeTextStartY("middle", rect, 12, 8);
      const bottom = computeTextStartY("bottom", rect, 12, 8);

      expect(top).toBeGreaterThan(middle);
      expect(middle).toBeGreaterThan(bottom);
    });

    it("should use asymmetric vertical padding", () => {
      const padTop = 5;
      const padBottom = 10;

      // top-aligned: y + height - padTop - ascent
      const topY = computeTextStartY("top", rect, 12, 8, padTop, padBottom);
      expect(topY).toBe(10 + 40 - 5 - 8); // 37

      // bottom-aligned: y + padBottom + (textBlockHeight - ascent)
      const bottomY = computeTextStartY("bottom", rect, 12, 8, padTop, padBottom);
      expect(bottomY).toBe(10 + 10 + (12 - 8)); // 24
    });

    it("should inset top and bottom equally for an ink-height block", () => {
      const ascent = 8;
      const descent = -2;
      const pad = 3;
      const blockHeight = computeTextBlockHeight(1, 12, ascent, descent);

      const topY = computeTextStartY("top", rect, blockHeight, ascent, pad, pad);
      const bottomY = computeTextStartY("bottom", rect, blockHeight, ascent, pad, pad);

      // Gap above the ascent equals the gap below the descent — the whole point:
      // a line box's leading must not land on one side only.
      expect(rect.y + rect.height - (topY + ascent)).toBeCloseTo(pad, 10);
      expect(bottomY + descent - rect.y).toBeCloseTo(pad, 10);
    });

    it("should centre the ink of a middle-aligned block", () => {
      const ascent = 8;
      const descent = -2;
      const blockHeight = computeTextBlockHeight(2, 12, ascent, descent);

      const y = computeTextStartY("middle", rect, blockHeight, ascent);
      const inkTop = y + ascent;
      const inkBottom = y - 12 + descent; // second line's descent

      expect((inkTop + inkBottom) / 2).toBeCloseTo(rect.y + rect.height / 2, 10);
    });
  });

  describe("computeTextBlockHeight", () => {
    it("should span the first ascent to the last descent", () => {
      // 3 lines: two full advances plus one line's ink height.
      expect(computeTextBlockHeight(3, 12, 8, -2)).toBe(34);
    });

    it("should exclude line leading for a single line", () => {
      expect(computeTextBlockHeight(1, 12, 8, -2)).toBe(10);
    });

    it("should treat an empty stack as one line", () => {
      expect(computeTextBlockHeight(0, 12, 8, -2)).toBe(10);
    });
  });

  describe("wrapTextLines", () => {
    const measure = (s: string) => s.length;

    // East Asian text has no spaces, so `split(/\s+/)` produced a single word
    // that was placed unconditionally and overflowed the cell however narrow it
    // was. Break opportunities now come from `@utils/cjk`.
    it("should wrap East Asian text between characters", () => {
      expect(wrapTextLines("中文报表二零二四年度", measure, 8)).toEqual([
        "中文报表二零二四",
        "年度"
      ]);
    });

    it("should not start a wrapped line with sentence-final punctuation", () => {
      // Naive per-character wrapping would put 。 at the head of line 2.
      expect(wrapTextLines("甲乙丙丁戊己庚辛。壬癸", measure, 8)).toEqual([
        "甲乙丙丁戊己庚",
        "辛。壬癸"
      ]);
    });

    it("should move a bracketed group whole rather than orphan the bracket", () => {
      expect(wrapTextLines("甲乙丙丁戊己庚（辛壬）癸", measure, 8)).toEqual([
        "甲乙丙丁戊己庚",
        "（辛壬）癸"
      ]);
    });

    it("should wrap at the boundary between Latin and ideographs", () => {
      expect(wrapTextLines("PDF导出", measure, 3)).toEqual(["PDF", "导出"]);
    });

    it("should wrap greedily by words", () => {
      expect(wrapTextLines("aa bb ccc", measure, 5)).toEqual(["aa bb", "ccc"]);
    });

    it("should preserve explicit blank lines", () => {
      expect(wrapTextLines("a\n\nb", measure, 10)).toEqual(["a", "", "b"]);
    });

    it("should keep a single oversized word on one line", () => {
      expect(wrapTextLines("superlongword", measure, 3)).toEqual(["superlongword"]);
    });
  });

  describe("alphaGsName", () => {
    it("should avoid collisions for close alpha values", () => {
      expect(alphaGsName(0.5001)).not.toBe(alphaGsName(0.5002));
    });
  });
});
