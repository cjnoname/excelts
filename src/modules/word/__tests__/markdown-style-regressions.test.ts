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
import { layoutDocumentFull } from "../layout/layout-full";

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

describe("tables", () => {
  const TABLE = [
    "| Layer | Technology |",
    "| ----- | ---------- |",
    "| Runtime | Node.js 26 |",
    "| Package Manager | pnpm 11 (workspaces), and a good deal more prose besides |"
  ].join("\n");

  /** The single table in a converted document. */
  async function tableOf(markdown: string) {
    const doc = await markdownToDocx(markdown);
    const table = doc.body.find(b => b.type === "table");
    expect(table).toBeDefined();
    return table!;
  }

  it("sizes columns from their content instead of dividing the measure equally", async () => {
    // Nothing downstream will do this: `w:tblLayout w:type="autofit"` is
    // advisory, Word renders the grid it is given, and the layout divides
    // equally when there is none. So a `Layer` column got the same 234pt as the
    // prose beside it — half the table wasted while the other half wrapped.
    const table = await tableOf(TABLE);
    const widths = table.columnWidths;
    expect(widths).toBeDefined();
    expect(widths).toHaveLength(2);
    expect(widths![0]).toBeLessThan(widths![1]);
    // The grid covers the measure exactly, so the table's right edge lands on
    // the margin: 12240 twips of Letter less two 1440 margins.
    expect(widths![0] + widths![1]).toBe(9360);
  });

  it("gives a one-column table the whole measure", async () => {
    const table = await tableOf("| Only |\n| ---- |\n| cell |");
    expect(table.columnWidths).toEqual([9360]);
  });

  it("does not leave a paragraph's bottom margin inside a cell", async () => {
    // A cell in the preview holds inline content directly — `<td>text</td>`,
    // with no `<p>` wrapper — so it never picks up `p { margin-bottom: 16px }`.
    // Inheriting it added 12.55pt of dead space to every cell, which made a
    // one-line row half again as tall as its padding and leading call for.
    const table = await tableOf(TABLE);
    for (const row of table.rows) {
      for (const cell of row.cells) {
        for (const block of cell.content) {
          expect(block.type).toBe("paragraph");
          expect(block.type === "paragraph" && block.properties?.spacing?.after).toBe(0);
          // `line` is left to inherit, so a cell leads at the body's 1.57.
          expect(block.type === "paragraph" && block.properties?.spacing?.line).toBeUndefined();
        }
      }
    }
  });

  it("writes the computed grid into the package", async () => {
    const bytes = await toBuffer(await markdownToDocx(TABLE));
    const xml = await part(bytes, "word/document.xml");
    const grid = /<w:tblGrid>(.*?)<\/w:tblGrid>/s.exec(xml);
    expect(grid).not.toBeNull();
    const cols = [...grid![1].matchAll(/w:w="(\d+)"/g)].map(m => Number(m[1]));
    expect(cols).toHaveLength(2);
    // Not the equal split the writer synthesises when no grid is supplied.
    expect(cols[0]).not.toBe(cols[1]);
    expect(cols[0] + cols[1]).toBe(9360);
  });
});

describe("list leading", () => {
  it("leads a list item like the paragraphs around it", async () => {
    // `ListParagraph` declares only `spacing.after`. Style resolution replaced
    // the whole `w:spacing` value instead of merging its attributes, so the
    // document default's `line` was dropped and every list item fell back to
    // single spacing — 13.2pt against the 17.27pt of the prose beside it, a 24%
    // difference that made every list look cramped.
    const doc = await markdownToDocx("Body text here.\n\n- first item\n- second item");
    const page = layoutDocumentFull(doc).pages[0];
    const paragraphs = page.content.filter(b => b.type === "paragraph");
    const leadingOf = (index: number): number => {
      const lines = paragraphs[index].lines;
      expect(lines.length).toBeGreaterThan(0);
      return lines[0].height;
    };
    expect(leadingOf(1)).toBeCloseTo(leadingOf(0), 5);
    // 11pt × 1.2 natural × 314/240 — the `--markdown-line-height: 22px` default.
    expect(leadingOf(1)).toBeCloseTo(17.27, 2);
  });
});

describe("fenced code blocks", () => {
  /** Courier's advance is 600/1000 em, so a column is 0.6 × the size. */
  const COLUMN_RATIO = 0.6;
  /** Letter content width less the `CodeBlock` style's 16px of padding a side. */
  const MEASURE_PT = (12240 - 2 * 1440) / 20 - (2 * Math.round(16 * (11 / 14) * 20)) / 20;

  /** The run size, in half-points, of the single code block in `markdown`. */
  async function codeSize(markdown: string, options?: Parameters<typeof markdownToDocx>[1]) {
    const doc = await markdownToDocx(markdown, options);
    const block = doc.body.find(b => b.type === "paragraph" && b.properties?.style === "CodeBlock");
    expect(block).toBeDefined();
    if (block?.type !== "paragraph") {
      throw new Error("unreachable");
    }
    const sizes = new Set(
      block.children.flatMap(child =>
        "content" in child && child.content.some(c => c.type === "text" && c.text.length > 0)
          ? [child.properties?.size]
          : []
      )
    );
    // One size for the whole block: a listing set at two sizes is not a listing.
    expect(sizes.size).toBe(1);
    return [...sizes][0]!;
  }

  const fence = (lines: readonly string[]) => "```\n" + lines.join("\n") + "\n```\n";

  it("leaves a block that already fits at the body size", async () => {
    expect(await codeSize(fence(["short line", "another"]))).toBe(22);
  });

  it("sets a block small enough that its longest line does not wrap", async () => {
    // `pre` in the preview scrolls; a page cannot, and wrapping one line destroys
    // the column alignment of the whole block — which for a directory tree or an
    // aligned comment column is most of what it was for.
    const columns = 108;
    const size = await codeSize(fence(["x".repeat(columns), "y"]));
    expect(size).toBeLessThan(22);
    expect((size / 2) * COLUMN_RATIO * columns).toBeLessThanOrEqual(MEASURE_PT);
    // And no smaller than it has to be: one more half-point would overflow.
    expect(((size + 1) / 2) * COLUMN_RATIO * columns).toBeGreaterThan(MEASURE_PT);
  });

  it("stops shrinking at the floor and lets the rest wrap", async () => {
    // 60% of the code size. Without a floor one 400-character line would render
    // the other twenty lines of its block unreadable.
    expect(await codeSize(fence(["x".repeat(4000)]))).toBe(Math.floor(22 * 0.6));
  });

  it("honours codeBlockFit: wrap", async () => {
    expect(await codeSize(fence(["x".repeat(108)]), { codeBlockFit: "wrap" })).toBe(22);
  });

  it("fits to the measure the caller declares", async () => {
    // 90 columns needs shrinking on Letter but not to the floor, so the three
    // measures give three different answers.
    const lines = fence(["x".repeat(90)]);
    const narrow = await codeSize(lines, { contentWidth: 4680 });
    const wide = await codeSize(lines, { contentWidth: 20000 });
    const letter = await codeSize(lines);
    expect(letter).toBeLessThan(22);
    expect(narrow).toBeLessThan(letter);
    expect(wide).toBe(22);
  });

  it("sizes each block for itself", async () => {
    const doc = await markdownToDocx(
      fence(["x".repeat(108)]) + "\ntext between\n\n" + fence(["short"])
    );
    const sizes = doc.body
      .filter(b => b.type === "paragraph" && b.properties?.style === "CodeBlock")
      .map(b =>
        b.type === "paragraph" ? b.children.find(c => "content" in c)?.properties?.size : undefined
      );
    expect(sizes).toHaveLength(2);
    expect(sizes[0]).toBeLessThan(22);
    expect(sizes[1]).toBe(22);
  });
});

describe("declared content width", () => {
  it("sizes table columns against it", async () => {
    const table = "| a | b |\n| - | - |\n| one | two |";
    const doc = await markdownToDocx(table, { contentWidth: 5000 });
    const t = doc.body.find(b => b.type === "table");
    expect(t?.type).toBe("table");
    if (t?.type !== "table") {
      throw new Error("unreachable");
    }
    expect(t.columnWidths?.reduce((a, b) => a + b, 0)).toBe(5000);
  });
});
