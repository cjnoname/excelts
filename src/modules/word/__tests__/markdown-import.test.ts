/**
 * DOCX Module - Markdown Import Tests
 */

import { describe, it, expect } from "vitest";

import type { MarkdownImageData } from "../convert/markdown/markdown-import";
import { markdownToDocx, markdownToDocxBody } from "../convert/markdown/markdown-import";
import { Io } from "../index";
import type { BodyContent, Hyperlink, InlineImageContent, Paragraph, Run, Table } from "../types";

/** Convenience: return just the body content array. */
async function mdBody(markdown: string): Promise<BodyContent[]> {
  return (await markdownToDocxBody(markdown)).body;
}

describe("markdownToDocxBody", () => {
  describe("headings", () => {
    it("should convert ATX headings (# to ######)", async () => {
      const body = await mdBody("# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6");
      const paragraphs = body.filter(b => b.type === "paragraph") as Paragraph[];

      expect(paragraphs).toHaveLength(6);
      expect(paragraphs[0].properties?.style).toBe("Heading1");
      expect(paragraphs[1].properties?.style).toBe("Heading2");
      expect(paragraphs[2].properties?.style).toBe("Heading3");
      expect(paragraphs[3].properties?.style).toBe("Heading4");
      expect(paragraphs[4].properties?.style).toBe("Heading5");
      expect(paragraphs[5].properties?.style).toBe("Heading6");
    });

    it("should convert setext headings", async () => {
      const body = await mdBody("Title\n===\n\nSubtitle\n---");
      const paragraphs = body.filter(b => b.type === "paragraph") as Paragraph[];

      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0].properties?.style).toBe("Heading1");
      expect(paragraphs[1].properties?.style).toBe("Heading2");
    });

    it("should handle inline formatting in headings", async () => {
      const body = await mdBody("# Hello **bold** world");
      const para = body[0] as Paragraph;
      expect(para.children).toHaveLength(3);
      const boldRun = para.children[1] as Run;
      expect(boldRun.properties?.bold).toBe(true);
    });
  });

  describe("paragraphs and inline formatting", () => {
    it("should convert plain paragraphs", async () => {
      const body = await mdBody("Hello world");
      expect(body).toHaveLength(1);
      const para = body[0] as Paragraph;
      expect(para.type).toBe("paragraph");
      const run = para.children[0] as Run;
      expect(run.content[0]).toEqual({ type: "text", text: "Hello world" });
    });

    it("should handle bold text", async () => {
      const body = await mdBody("Hello **bold** world");
      const para = body[0] as Paragraph;
      expect(para.children).toHaveLength(3);
      const boldRun = para.children[1] as Run;
      expect(boldRun.properties?.bold).toBe(true);
      expect(boldRun.content[0]).toEqual({ type: "text", text: "bold" });
    });

    it("should handle italic text", async () => {
      const body = await mdBody("Hello *italic* world");
      const para = body[0] as Paragraph;
      const italicRun = para.children[1] as Run;
      expect(italicRun.properties?.italic).toBe(true);
    });

    it("should handle bold italic text", async () => {
      const body = await mdBody("Hello ***bold italic*** world");
      const para = body[0] as Paragraph;
      // Bold wraps italic
      const boldRun = para.children[1] as Run;
      expect(boldRun.properties?.bold).toBe(true);
      expect(boldRun.properties?.italic).toBe(true);
    });

    it("should handle strikethrough text", async () => {
      const body = await mdBody("Hello ~~deleted~~ world");
      const para = body[0] as Paragraph;
      const strikeRun = para.children[1] as Run;
      expect(strikeRun.properties?.strike).toBe(true);
    });

    it("should handle inline code", async () => {
      const body = await mdBody("Use `console.log()` to debug");
      const para = body[0] as Paragraph;
      const codeRun = para.children[1] as Run;
      expect(codeRun.properties?.font).toBe("Courier New");
      expect(codeRun.content[0]).toEqual({ type: "text", text: "console.log()" });
    });

    it("should handle links", async () => {
      const body = await mdBody("Visit [Google](https://google.com)");
      const para = body[0] as Paragraph;
      const link = para.children[1] as Hyperlink;
      expect(link.type).toBe("hyperlink");
      expect(link.url).toBe("https://google.com");
      expect(link.children[0].content[0]).toEqual({ type: "text", text: "Google" });
    });

    it("should handle links with title", async () => {
      const body = await mdBody('Visit [Link](https://example.com "Example") here');
      const para = body[0] as Paragraph;
      const link = para.children.find(c => "type" in c && c.type === "hyperlink") as Hyperlink;
      expect(link).toBeDefined();
      expect(link.url).toBe("https://example.com");
      expect(link.tooltip).toBe("Example");
    });

    it("should handle hard line breaks (two trailing spaces)", async () => {
      const body = await mdBody("Line one  \nLine two");
      const para = body[0] as Paragraph;
      // Should contain: "Line one", break, "Line two"
      const hasBreak = para.children.some(
        child => "content" in child && (child as Run).content.some(c => c.type === "break")
      );
      expect(hasBreak).toBe(true);
    });

    it("should handle escaped characters", async () => {
      const body = await mdBody("Use \\*asterisks\\* literally");
      const para = body[0] as Paragraph;
      const textContent = para.children
        .filter((c): c is Run => "content" in c)
        .flatMap(r => r.content)
        .filter(c => c.type === "text")
        .map(c => (c as { type: "text"; text: string }).text)
        .join("");
      expect(textContent).toBe("Use *asterisks* literally");
    });
  });

  describe("code blocks", () => {
    it("should convert fenced code blocks", async () => {
      const body = await mdBody("```javascript\nconst x = 1;\nconsole.log(x);\n```");
      expect(body).toHaveLength(1);
      const para = body[0] as Paragraph;
      expect(para.properties?.style).toBe("CodeBlock");
      // Should contain code text with code font
      const runs = para.children.filter((c): c is Run => "content" in c);
      expect(runs.length).toBeGreaterThan(0);
    });

    it("should handle code blocks with tilde fence", async () => {
      const body = await mdBody("~~~\ncode here\n~~~");
      const para = body[0] as Paragraph;
      expect(para.properties?.style).toBe("CodeBlock");
    });
  });

  describe("lists", () => {
    it("should convert unordered lists", async () => {
      const body = await mdBody("- Item 1\n- Item 2\n- Item 3");
      const paragraphs = body.filter(b => b.type === "paragraph") as Paragraph[];
      expect(paragraphs).toHaveLength(3);
      // Each should have numbering reference
      for (const para of paragraphs) {
        expect(para.properties?.numbering).toBeDefined();
        expect(para.properties?.numbering?.level).toBe(0);
      }
    });

    it("should convert ordered lists", async () => {
      const body = await mdBody("1. First\n2. Second\n3. Third");
      const paragraphs = body.filter(b => b.type === "paragraph") as Paragraph[];
      expect(paragraphs).toHaveLength(3);
      for (const para of paragraphs) {
        expect(para.properties?.numbering).toBeDefined();
      }
    });

    it("respects a non-default ordered list start", async () => {
      // markdownToDocx exposes the numbering instances on the document; the
      // list's first paragraph's numId must reference an instance whose
      // override starts at 3.
      const doc = await markdownToDocx("3. third\n4. fourth");
      const paragraphs = doc.body.filter(b => b.type === "paragraph") as Paragraph[];
      expect(paragraphs).toHaveLength(2);
      const numId = paragraphs[0].properties?.numbering?.numId;
      expect(numId).toBeDefined();
      const inst = doc.numberingInstances?.find(n => n.numId === numId);
      expect(inst).toBeDefined();
      const override = inst?.overrides?.find(o => o.level === 0);
      expect(override?.startOverride).toBe(3);
    });

    it("should handle task lists", async () => {
      const body = await mdBody("- [x] Done\n- [ ] Not done");
      const paragraphs = body.filter(b => b.type === "paragraph") as Paragraph[];
      expect(paragraphs).toHaveLength(2);
      // First item should have checkbox prefix
      const firstRun = paragraphs[0].children[0] as Run;
      const text = firstRun.content[0] as { type: "text"; text: string };
      expect(text.text).toContain("☑");
    });
  });

  describe("blockquotes", () => {
    it("should convert blockquotes", async () => {
      const body = await mdBody("> This is a quote");
      const para = body[0] as Paragraph;
      expect(para.properties?.style).toBe("Quote");
    });

    it("carries the quote's geometry and bar on the Quote style, not the paragraph", async () => {
      // Indent, background and the left bar belong to the named style; a
      // paragraph that repeats them cannot be restyled by editing the style.
      const { markdownToDocx } = await import("../convert/markdown/markdown-import");
      const doc = await markdownToDocx("> This is a quote");
      const quote = doc.styles?.find(s => s.styleId === "Quote");
      expect(quote?.paragraphProperties?.indent?.left).toBeGreaterThan(0);
      expect(quote?.paragraphProperties?.borders?.left?.style).toBe("single");
      // The stylesheet marks a quote with the bar alone — never italic or grey.
      expect(quote?.runProperties?.italic).toBeUndefined();
      expect(quote?.runProperties?.color).toBeUndefined();
    });

    it("should handle multi-line blockquotes", async () => {
      const body = await mdBody("> Line 1\n> Line 2");
      expect(body).toHaveLength(1);
      const para = body[0] as Paragraph;
      expect(para.properties?.style).toBe("Quote");
    });
  });

  describe("thematic breaks", () => {
    it("should convert horizontal rules", async () => {
      const body = await mdBody("---");
      const para = body[0] as Paragraph;
      expect(para.properties?.thematicBreak).toBe(true);
    });

    it("should handle *** and ___", async () => {
      const body1 = await mdBody("***");
      const body2 = await mdBody("___");
      expect((body1[0] as Paragraph).properties?.thematicBreak).toBe(true);
      expect((body2[0] as Paragraph).properties?.thematicBreak).toBe(true);
    });
  });

  describe("tables", () => {
    it("should convert GFM tables", async () => {
      const md = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
      const body = await mdBody(md);
      expect(body).toHaveLength(1);
      const table = body[0] as Table;
      expect(table.type).toBe("table");
      expect(table.rows).toHaveLength(3); // header + 2 data rows
    });

    it("should handle table alignment", async () => {
      const md = "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |";
      const body = await mdBody(md);
      const table = body[0] as Table;
      // First data row cells should have alignment
      const dataRow = table.rows[1];
      const cellParas = dataRow.cells.map(c => c.content[0] as Paragraph);
      expect(cellParas[0].properties?.alignment).toBe("start");
      expect(cellParas[1].properties?.alignment).toBe("center");
      expect(cellParas[2].properties?.alignment).toBe("end");
    });

    it("should bold header cells", async () => {
      const md = "| H1 | H2 |\n| --- | --- |\n| a | b |";
      const body = await mdBody(md);
      const table = body[0] as Table;
      const headerRow = table.rows[0];
      const headerPara = headerRow.cells[0].content[0] as Paragraph;
      const headerRun = headerPara.children[0] as Run;
      expect(headerRun.properties?.bold).toBe(true);
    });
  });

  describe("images", () => {
    it("falls back to placeholder text when no resolver is supplied", async () => {
      const body = await mdBody("![Alt text](https://example.com/img.png)");
      const para = body[0] as Paragraph;
      const run = para.children[0] as Run;
      const text = run.content[0] as { type: "text"; text: string };
      expect(text.text).toContain("Alt text");
    });

    it("falls back to placeholder when the resolver returns undefined", async () => {
      const doc = await markdownToDocx("![logo](logo.png)", {
        resolveImage: () => undefined
      });
      expect(doc.images ?? []).toHaveLength(0);
      const para = doc.body[0] as Paragraph;
      const run = para.children[0] as Run;
      const text = run.content[0] as { type: "text"; text: string };
      expect(text.text).toContain("logo");
    });

    it("embeds an image when the resolver returns data", async () => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
      const doc = await markdownToDocx('![diagram](diagram.png "tip")', {
        resolveImage: (url): MarkdownImageData | undefined =>
          url === "diagram.png"
            ? { data: png, mediaType: "png", width: 914400, height: 457200 }
            : undefined
      });

      // Image registered in the document media collection.
      expect(doc.images).toHaveLength(1);
      const imgDef = doc.images![0];
      expect(imgDef.mediaType).toBe("png");
      expect(imgDef.fileName).toBe("image1.png");
      expect(imgDef.data).toBe(png);

      // The paragraph run carries an inline image content node referencing it.
      const para = doc.body[0] as Paragraph;
      const run = para.children[0] as Run;
      const img = run.content[0] as InlineImageContent;
      expect(img.type).toBe("image");
      expect(img.rId).toBe(imgDef.rId);
      expect(img.width).toBe(914400);
      expect(img.height).toBe(457200);
      expect(img.altText).toBe("diagram");
    });

    it("supports an async resolver", async () => {
      const jpg = Uint8Array.from([0xff, 0xd8, 0xff]);
      const doc = await markdownToDocx("![photo](photo.jpg)", {
        resolveImage: async (): Promise<MarkdownImageData> => {
          await Promise.resolve();
          return { data: jpg, mediaType: "jpeg" };
        }
      });
      expect(doc.images).toHaveLength(1);
      expect(doc.images![0].fileName).toBe("image1.jpg");
    });

    it("embeds an SVG with its PNG fallback", async () => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
      const doc = await markdownToDocx("![vector](chart.svg)", {
        resolveImage: (): MarkdownImageData => ({
          data: svg,
          mediaType: "svg",
          fallbackData: png
        })
      });

      // A single ImageDef carries the SVG plus its raster fallback; the SVG
      // split / second relationship / svgRId back-fill is the packager's job.
      expect(doc.images).toHaveLength(1);
      const imgDef = doc.images![0];
      expect(imgDef.mediaType).toBe("svg");
      expect(imgDef.fileName).toBe("image1.svg");
      expect(imgDef.fallbackData).toBe(png);

      // The inline image references only the primary rId (no manual svgRId).
      const para = doc.body[0] as Paragraph;
      const run = para.children[0] as Run;
      const img = run.content[0] as InlineImageContent;
      expect(img.type).toBe("image");
      expect(img.rId).toBe(imgDef.rId);
      expect(img.svgRId).toBeUndefined();

      // End-to-end: the document packages without error and the packager emits
      // both the SVG part and an auto-named PNG fallback part.
      const buf = await Io.toBuffer(doc);
      const archive = new TextDecoder("latin1").decode(buf);
      expect(archive).toContain("image1.svg");
      expect(archive).toContain("image1_fallback.png");
    });

    it("omitting fallbackData lets the packager synthesize one for SVG", async () => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
      const doc = await markdownToDocx("![vector](chart.svg)", {
        resolveImage: (): MarkdownImageData => ({ data: svg, mediaType: "svg" })
      });
      expect(doc.images).toHaveLength(1);
      expect(doc.images![0].fallbackData).toBeUndefined();
      // Still packages successfully (packager synthesizes a placeholder PNG).
      const buf = await Io.toBuffer(doc);
      expect(buf.length).toBeGreaterThan(0);
    });
  });

  describe("footnotes", () => {
    it("parses a footnote reference and its definition", async () => {
      const doc = await markdownToDocx("Fact[^1].\n\n[^1]: Source: World Bank.");
      // A footnote definition was emitted.
      expect(doc.footnotes).toHaveLength(1);
      expect(doc.footnotes![0].id).toBe(1);
      const noteText = (doc.footnotes![0].content[0].children[0] as Run).content[0] as {
        type: "text";
        text: string;
      };
      expect(noteText.text).toContain("World Bank");

      // The in-text reference is a footnoteRef run, not literal text.
      const para = doc.body[0] as Paragraph;
      const refRun = para.children.find(
        c => "content" in c && (c as Run).content.some(x => x.type === "footnoteRef")
      ) as Run;
      expect(refRun).toBeDefined();
      expect(refRun.properties?.style).toBe("FootnoteReference");
      const ref = refRun.content.find(x => x.type === "footnoteRef") as {
        type: "footnoteRef";
        id: number;
      };
      expect(ref.id).toBe(1);
    });

    it("assigns ids in reference order and deduplicates repeated labels", async () => {
      const doc = await markdownToDocx(
        "A[^b] then B[^a] then A again[^b].\n\n[^a]: alpha\n\n[^b]: bravo"
      );
      // Two distinct footnotes despite three references.
      expect(doc.footnotes).toHaveLength(2);
      // [^b] referenced first → id 1; [^a] → id 2.
      const byId = new Map(
        doc.footnotes!.map(f => [
          f.id,
          ((f.content[0].children[0] as Run).content[0] as { text: string }).text
        ])
      );
      expect(byId.get(1)).toBe("bravo");
      expect(byId.get(2)).toBe("alpha");
    });

    it("includes FootnoteReference and FootnoteText styles", async () => {
      const doc = await markdownToDocx("X[^1]\n\n[^1]: note");
      expect(doc.styles?.find(s => s.styleId === "FootnoteReference")).toBeDefined();
      expect(doc.styles?.find(s => s.styleId === "FootnoteText")).toBeDefined();
    });

    it("does not treat a `[^id]:`-looking line inside a code fence as a definition", async () => {
      const doc = await markdownToDocx(
        "Real[^1].\n\n```\n[^1]: this is code, not a definition\n```\n\n[^1]: real note"
      );
      // Only one footnote (the real definition); the code line is preserved.
      expect(doc.footnotes).toHaveLength(1);
      const noteText = (
        (doc.footnotes![0].content[0].children[0] as Run).content[0] as {
          text: string;
        }
      ).text;
      expect(noteText).toBe("real note");

      // The code block paragraph still contains the literal code line.
      const codeParas = doc.body.filter(
        b => b.type === "paragraph" && b.properties?.style === "CodeBlock"
      ) as Paragraph[];
      const codeText = codeParas
        .flatMap(p => p.children)
        .filter((c): c is Run => "content" in c)
        .flatMap(r => r.content)
        .filter(c => c.type === "text")
        .map(c => (c as { text: string }).text)
        .join("");
      expect(codeText).toContain("[^1]: this is code, not a definition");
    });

    it("keeps a footnote (with empty content) for an undefined reference", async () => {
      const doc = await markdownToDocx("Mystery[^x] fact.");
      expect(doc.footnotes).toHaveLength(1);
      expect(doc.footnotes![0].id).toBe(1);
    });
  });

  describe("markdownToDocx (full document)", () => {
    it("should produce a valid DocxDocument with styles and numbering", async () => {
      const doc = await markdownToDocx("# Title\n\n- Item 1\n- Item 2\n\nParagraph");
      expect(doc.body).toHaveLength(4); // heading + 2 list items + paragraph
      expect(doc.styles).toBeDefined();
      expect(doc.styles!.length).toBeGreaterThan(0);
      expect(doc.abstractNumberings).toBeDefined();
      expect(doc.numberingInstances).toBeDefined();
    });

    it("should include heading styles", async () => {
      const doc = await markdownToDocx("# Test");
      const headingStyle = doc.styles?.find(s => s.styleId === "Heading1");
      expect(headingStyle).toBeDefined();
    });
  });

  describe("complex documents", () => {
    it("should handle a mixed markdown document", async () => {
      const md = `# My Document

This is a paragraph with **bold** and *italic* text.

## Section 1

- Bullet one
- Bullet two

### Subsection

| Column A | Column B |
| -------- | -------- |
| Value 1  | Value 2  |

> A blockquote here

\`\`\`typescript
const x = 42;
\`\`\`

---

End of document.`;

      const body = await mdBody(md);
      expect(body.length).toBeGreaterThan(5);

      // Check various block types are present
      const types = body.map(b => b.type);
      expect(types).toContain("paragraph");
      expect(types).toContain("table");
    });

    it("should handle autolinks", async () => {
      const body = await mdBody("Visit <https://example.com> for more");
      const para = body[0] as Paragraph;
      const link = para.children.find(c => "type" in c && c.type === "hyperlink") as Hyperlink;
      expect(link).toBeDefined();
      expect(link.url).toBe("https://example.com");
    });
  });
});
