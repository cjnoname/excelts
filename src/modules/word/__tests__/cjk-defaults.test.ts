/**
 * East Asian declarations in a document authored from scratch.
 *
 * `useDefaultStyles` named SimSun as the docDefaults East Asian typeface, and
 * then nothing else in the package agreed: the font table declared the Japanese
 * MS Gothic but no Chinese face, `w:lang` set only the Latin slot, and the theme
 * wrote `<a:ea typeface=""/>` with no per-script fonts at all. Each of those is a
 * different way for Word to end up resolving Chinese glyph forms from something
 * other than what the document asked for.
 */
import { XmlWriter } from "@xml/writer";
import { describe, it, expect } from "vitest";

import * as Document from "../builder/document-handle";
import { renderFontTable, renderTheme } from "../writer/parts-writer";
import { renderStyles } from "../writer/styles-writer";

describe("CJK defaults", () => {
  it("should not declare a language it cannot know", () => {
    const h = Document.create();
    Document.useDefaultStyles(h);
    const doc = Document.build(h);

    // `useDefaultStyles` runs before any content exists, so it has nothing to base an
    // East Asian language on — and this document never gains any text. Declaring
    // `zh-CN` here once meant every English, Japanese and Korean document was labelled
    // Simplified Chinese, which applies zh-CN proofing and Han glyph preferences to
    // Japanese. With no evidence, the honest output is no claim.
    expect(doc.docDefaults?.runProperties?.language).toEqual({ val: "en-US" });
  });

  it("should derive the East Asian language from the document's own text", () => {
    // The other half of the same question: `useDefaultStyles` cannot know, but by
    // `build()` the text is all in one place. Without this, a hand-built Chinese
    // document opens in Word with a red underline under every single word, because an
    // English dictionary is being asked about Chinese.
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.addHeading(h, "第一章 销售业绩概述", 1);
    Document.addParagraph(h, "其中华东地区同比增长百分之十二。");
    const rPr = Document.build(h).docDefaults?.runProperties;

    expect(rPr?.language).toEqual({ val: "en-US", eastAsia: "zh-CN" });
    expect(rPr?.font).toMatchObject({ ascii: "Calibri", eastAsia: "SimSun" });
  });

  it("should follow the text to Japanese rather than assuming Chinese", () => {
    // The reason the East Asian *font* slot moved out of `useDefaultStyles` too: it
    // hardcoded `SimSun` while refusing to hardcode `zh-CN` on the grounds that the
    // language was unknowable. Naming a Chinese face is the same claim as naming a
    // Chinese language, so a Japanese document used to be given a Chinese typeface.
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.addParagraph(h, "日本語のテスト資料です。");
    const rPr = Document.build(h).docDefaults?.runProperties;

    expect(rPr?.language).toEqual({ val: "en-US", eastAsia: "ja-JP" });
    expect(rPr?.font).toMatchObject({ eastAsia: "Yu Gothic" });
  });

  it("should leave an English document with no East Asian claim", () => {
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.addParagraph(h, "Plain English paragraph.");
    const rPr = Document.build(h).docDefaults?.runProperties;

    expect(rPr?.language?.eastAsia).toBeUndefined();
    expect(rPr?.font).not.toMatchObject({ eastAsia: expect.any(String) });
  });

  it("should never overwrite a language or face the caller stated", () => {
    // A caller who answered the question has answered it, even if the text disagrees.
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.setDocDefaults(h, {
      runProperties: {
        language: { val: "en-GB", eastAsia: "ja-JP" },
        font: { ascii: "Arial", eastAsia: "Meiryo" }
      }
    });
    Document.addParagraph(h, "简体中文内容");
    const rPr = Document.build(h).docDefaults?.runProperties;

    expect(rPr?.language).toEqual({ val: "en-GB", eastAsia: "ja-JP" });
    expect(rPr?.font).toEqual({ ascii: "Arial", eastAsia: "Meiryo" });
  });

  it("should carry an explicitly set East Asian language through to styles.xml", () => {
    const h = Document.create();
    Document.useDefaultStyles(h);
    const doc = Document.build(h);
    const writer = new XmlWriter();
    renderStyles(
      writer,
      {
        ...doc.docDefaults,
        runProperties: {
          ...doc.docDefaults?.runProperties,
          language: { val: "zh-CN", eastAsia: "zh-CN" }
        }
      },
      doc.styles
    );
    expect(writer.xml).toContain('w:eastAsia="zh-CN"');
  });

  it("should declare the East Asian typeface it uses in the font table", () => {
    // docDefaults name SimSun, so the font table has to declare it. It listed
    // MS Gothic (charset 80, Japanese) and no Chinese face whatsoever. Charset 86
    // is GB2312; fontTable.xml writes these in hex where styles.xml uses decimal.
    const writer = new XmlWriter();
    renderFontTable(writer);
    const xml = writer.xml;

    expect(xml).toContain('w:name="SimSun"');
    expect(xml).toMatch(/w:name="SimSun"[\s\S]{0,400}?w:val="86"/);
    expect(xml).toContain('w:name="Microsoft YaHei"');
    expect(xml).toContain('w:name="PMingLiU"');
  });

  it("should give a generated theme per-script East Asian fonts", () => {
    // Without these, `minorEastAsia` resolves against nothing — which is how a
    // document whose docDefaults name SimSun still rendered Chinese in whatever
    // the host happened to pick. Excel's own theme has carried them all along.
    const writer = new XmlWriter();
    renderTheme(writer);
    const xml = writer.xml;

    expect(xml).toContain('script="Hans"');
    expect(xml).toContain('script="Hant"');
    expect(xml).toContain('script="Jpan"');
    expect(xml).toContain('script="Hang"');
    expect(xml).toContain("宋体");
  });

  it("should reproduce a supplied theme rather than improving it", () => {
    // The defaults must not overwrite a round-tripped theme.
    const writer = new XmlWriter();
    renderTheme(writer, {
      colorScheme: {
        name: "Office",
        colors: {
          dk1: "000000",
          lt1: "FFFFFF",
          dk2: "44546A",
          lt2: "E7E6E6",
          accent1: "4472C4",
          accent2: "ED7D31",
          accent3: "A5A5A5",
          accent4: "FFC000",
          accent5: "5B9BD5",
          accent6: "70AD47",
          hlink: "0563C1",
          folHlink: "954F72"
        }
      },
      fontScheme: {
        name: "Custom",
        majorFont: "Arial",
        minorFont: "Arial",
        major: { latin: "Arial", supplementalFonts: { Hans: "微软雅黑" } },
        minor: { latin: "Arial", supplementalFonts: { Hans: "微软雅黑" } }
      }
    });
    const xml = writer.xml;

    expect(xml).toContain('typeface="微软雅黑"');
    expect(xml).not.toContain('script="Jpan"');
  });
});

describe("useDefaultStyles supplies defaults without discarding settings", () => {
  it("keeps document defaults the caller already stated", () => {
    // It replaced `docDefaults` outright, so `setDocDefaults` followed by
    // `useDefaultStyles` silently lost the caller's size, font and spacing. The name
    // says "use the defaults", not "discard mine".
    const h = Document.create();
    Document.setDocDefaults(h, { runProperties: { size: 40 } });
    Document.useDefaultStyles(h);

    expect(Document.build(h).docDefaults?.runProperties?.size).toBe(40);
  });

  it("does not define the same style twice when called again", () => {
    // Appending unconditionally produced 38 styles with 19 distinct ids — a second
    // definition of every one, and a `styles.xml` that declares `Normal` twice.
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.useDefaultStyles(h);

    const ids = (Document.build(h).styles ?? []).map(style => style.styleId);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe("the font table declares every face the defaults can name", () => {
  it.each([
    ["中文正文与统计。", "SimSun"],
    ["日本語の本文です。", "Yu Gothic"],
    ["한국어 본문입니다.", "Malgun Gothic"],
    ["繁體中文銷售業績。", "PMingLiU"]
  ])("declares %s → %s", (text, expected) => {
    // A document that references a typeface its own font table never introduces leaves
    // substitution and charset hints to the reader. `SimSun` was declared; the three
    // faces the language mapping can also produce were not.
    const h = Document.create();
    Document.useDefaultStyles(h);
    Document.addParagraph(h, text);
    const doc = Document.build(h);

    expect(doc.docDefaults?.runProperties?.font).toMatchObject({ eastAsia: expected });

    const writer = new XmlWriter();
    renderFontTable(writer);
    expect(writer.xml).toContain(`w:name="${expected}"`);
  });
});
