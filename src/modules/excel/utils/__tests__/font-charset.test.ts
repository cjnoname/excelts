import { inferFontCharset } from "@excel/utils/font-charset";
/**
 * `<charset>` inference for East Asian fonts.
 *
 * A `<font>` declares its script through `<charset>`, and documonster only ever
 * wrote one that had been read back from a parsed file — so a workbook authored
 * from scratch described 宋体 exactly as it described Calibri.
 */
import { describe, it, expect } from "vitest";

describe("inferFontCharset", () => {
  it("should report GB2312 for Simplified Chinese faces", () => {
    for (const name of ["SimSun", "SimHei", "DengXian", "Microsoft YaHei", "KaiTi", "FangSong"]) {
      expect(inferFontCharset(name), name).toBe(134);
    }
  });

  it("should report Big5 for Traditional Chinese faces", () => {
    for (const name of ["PMingLiU", "MingLiU", "Microsoft JhengHei", "DFKai-SB"]) {
      expect(inferFontCharset(name), name).toBe(136);
    }
  });

  it("should report Shift-JIS for Japanese faces", () => {
    for (const name of ["MS Gothic", "MS Mincho", "Meiryo", "Yu Gothic", "Osaka"]) {
      expect(inferFontCharset(name), name).toBe(128);
    }
  });

  it("should report Hangul for Korean faces", () => {
    for (const name of ["Malgun Gothic", "Batang", "Gulim", "NanumGothic"]) {
      expect(inferFontCharset(name), name).toBe(129);
    }
  });

  it("should recognise the localized name a host application writes", () => {
    // A Chinese Windows Excel stores 微软雅黑, never "Microsoft YaHei".
    expect(inferFontCharset("宋体")).toBe(134);
    expect(inferFontCharset("微软雅黑")).toBe(134);
    expect(inferFontCharset("等线")).toBe(134);
    expect(inferFontCharset("新細明體")).toBe(136);
    expect(inferFontCharset("メイリオ")).toBe(128);
    expect(inferFontCharset("맑은 고딕")).toBe(129);
  });

  it("should agree between a face's English and localized names", () => {
    for (const [en, native] of [
      ["SimSun", "宋体"],
      ["Microsoft YaHei", "微软雅黑"],
      ["DengXian", "等线"],
      ["PMingLiU", "新細明體"],
      ["Meiryo", "メイリオ"],
      ["Malgun Gothic", "맑은 고딕"]
    ]) {
      expect(inferFontCharset(en), `${en} vs ${native}`).toBe(inferFontCharset(native));
    }
  });

  it("should be case- and whitespace-insensitive", () => {
    expect(inferFontCharset("  simsun  ")).toBe(134);
    expect(inferFontCharset("MICROSOFT YAHEI")).toBe(134);
  });

  it("should report nothing for a Latin face", () => {
    // `charset="0"` is a different statement from no charset at all, and a
    // workbook without one should not gain it.
    for (const name of ["Calibri", "Arial", "Times New Roman", "Courier New", "Not A Font"]) {
      expect(inferFontCharset(name), name).toBeUndefined();
    }
  });
});
