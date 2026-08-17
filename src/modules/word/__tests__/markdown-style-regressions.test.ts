import { extractAll } from "@archive/unzip/extract";
/**
 * Regressions in the Markdown → DOCX style port.
 *
 * The formatting moved out of individual paragraphs and into named styles. These
 * tests pin the consequences of that move which went wrong the first time.
 */
import { describe, it, expect } from "vitest";

import { markdownToDocx, markdownToDocxBody } from "../convert/markdown/markdown-import";
import { toBuffer } from "../document-io";

/** Read one part out of a packaged .docx as text. */
async function part(bytes: Uint8Array, path: string): Promise<string> {
  const files = await extractAll(bytes);
  const entry = files.get(path);
  expect(entry).toBeDefined();
  return new TextDecoder().decode(entry!.data);
}

describe("markdownToDocxBody", () => {
  it("returns the styles and defaults the body only references by name", async () => {
    // The body's paragraphs name `Quote`, `CodeBlock` and `ListParagraph`; every
    // visual property lives in those definitions. Without them a caller splicing
    // the body into a host document got unstyled text.
    const result = await markdownToDocxBody("> quoted\n\n```ts\ncode\n```\n\n- item");
    const referenced = new Set(
      result.body
        .filter(b => b.type === "paragraph")
        .map(b => b.properties?.style)
        .filter((s): s is string => s !== undefined)
    );
    expect(referenced.size).toBeGreaterThan(0);
    const provided = new Set(result.styles.map(s => s.styleId));
    for (const name of referenced) {
      expect(provided.has(name)).toBe(true);
    }
    expect(result.docDefaults.runProperties?.size).toBeGreaterThan(0);
  });
});

describe("blockquote", () => {
  it("does not overwrite the style of a block that carries its own", async () => {
    // Everything inside a quote was forced to `Quote`, which stripped a fenced
    // code block of its frame, background and leading, and flattened headings.
    const doc = await markdownToDocx("> ```ts\n> code\n> ```\n\n> # heading\n\n> plain");
    const styles = doc.body.filter(b => b.type === "paragraph").map(b => b.properties?.style);
    expect(styles).toEqual(["CodeBlock", "Heading1", "Quote"]);
  });

  it("takes its bar and tint from the theme, and never italicises the text", async () => {
    // `markdown.css` sets no colours on a block quote — the *webview host* does,
    // via `--vscode-textBlockQuote-background` / `-border`. Reading only the
    // extension's stylesheet once led to both being dropped, which turned the
    // blue bar grey and removed the tint. What no stylesheet does is italicise or
    // grey the text.
    const doc = await markdownToDocx("> quoted");
    const quote = doc.styles?.find(s => s.styleId === "Quote");
    // `textBlockQuote.border` `#007acc80` over the quote's own `#f2f2f2`.
    expect(quote?.paragraphProperties?.borders?.left?.color).toBe("79B6DF");
    // `textBlockQuote.background` `#f2f2f2`.
    expect(quote?.paragraphProperties?.shading?.fill).toBe("F2F2F2");
    expect(quote?.runProperties?.italic).toBeUndefined();
    expect(quote?.runProperties?.color).toBeUndefined();
  });

  it("gives a code block a background but no frame", async () => {
    // `pre` asks for `1px solid var(--vscode-widget-border)`, and `widget.border`
    // resolves to nothing outside the high-contrast themes, so the border never
    // computes.
    const doc = await markdownToDocx("```ts\nx\n```");
    const code = doc.styles?.find(s => s.styleId === "CodeBlock");
    expect(code?.paragraphProperties?.shading?.fill).toBe("F1F1F1");
    expect(code?.paragraphProperties?.borders).toBeUndefined();
  });
});

describe("packaged output", () => {
  it("writes exactly one w:pBdr for a thematic break", async () => {
    // `w:pPr` permits a single `w:pBdr`. A thematic break that also carried
    // explicit borders emitted two, and a reader dropped the real settings.
    const bytes = await toBuffer(await markdownToDocx("a\n\n---\n\nb"));
    const xml = await part(bytes, "word/document.xml");
    const bordered = xml.split("<w:p>").filter(p => p.includes("<w:pBdr>"));
    expect(bordered).not.toHaveLength(0);
    for (const paragraph of bordered) {
      expect(paragraph.match(/<w:pBdr>/g)).toHaveLength(1);
    }
  });

  it("writes w:space as a whole number of points", async () => {
    // `w:space` is ST_PointMeasure. Converted CSS lengths are rarely integral, and
    // `w:space="12.571428571428571"` is rejected by strict consumers.
    const bytes = await toBuffer(await markdownToDocx("> q\n\n```ts\nx\n```\n\n# h"));
    const xml = (await part(bytes, "word/document.xml")) + (await part(bytes, "word/styles.xml"));
    expect(xml.match(/w:space="[^"]*\.[^"]*"/g)).toBeNull();
  });
});
