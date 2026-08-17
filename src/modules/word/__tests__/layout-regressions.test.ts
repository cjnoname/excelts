/**
 * Regressions found by auditing the layout rewrite.
 *
 * Each test here corresponds to a defect that shipped: the comment says what went
 * wrong, so a future change that reintroduces it fails with an explanation rather
 * than a bare number mismatch.
 */
import { describe, it, expect } from "vitest";

import { layoutDocument } from "../layout/layout";
import { layoutDocumentFull } from "../layout/layout-full";
import type { DocxDocument, Paragraph, SectionProperties } from "../types";

const para = (text: string, properties?: Paragraph["properties"]): Paragraph => ({
  type: "paragraph",
  properties,
  children: [{ content: [{ type: "text", text }] }]
});

const cellPara = (text: string): Paragraph => para(text);

const textOfPage = (page: { content: readonly { type: string }[] }): string =>
  page.content
    .flatMap(b =>
      b.type === "paragraph"
        ? (b as unknown as Paragraph & { lines: { runs: { text?: string }[] }[] }).lines.flatMap(
            l => l.runs.map(r => r.text ?? "")
          )
        : []
    )
    .join("");

describe("sections", () => {
  const LETTER: SectionProperties = {
    pageSize: { width: 12240, height: 15840 },
    margins: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
  };
  const LANDSCAPE: SectionProperties = {
    pageSize: { width: 15840, height: 12240 },
    margins: { top: 720, bottom: 720, left: 720, right: 720 }
  };

  const twoSections = (breakType: SectionProperties["breakType"], trailing = LANDSCAPE) => ({
    body: [
      para("section one", { sectionProperties: { ...LETTER, breakType } }),
      para("section two")
    ],
    sectionProperties: trailing
  });

  it("gives each section its own page geometry", () => {
    // Pass 2 used the document-level properties for every page, so a sectioned
    // document rendered entirely at the *last* section's paper size.
    const out = layoutDocumentFull(twoSections("nextPage"));
    expect(out.totalPages).toBe(2);
    expect([out.pages[0]!.geometry.width, out.pages[0]!.geometry.height]).toEqual([612, 792]);
    expect([out.pages[1]!.geometry.width, out.pages[1]!.geometry.height]).toEqual([792, 612]);
  });

  it("breaks at a section boundary, and agrees with the paginator", () => {
    for (const breakType of ["nextPage", "oddPage", "evenPage", "continuous"] as const) {
      const doc = twoSections(breakType);
      expect(layoutDocumentFull(doc).totalPages).toBe(layoutDocument(doc, {}).pageCount);
    }
  });

  it("keeps a continuous section on the same page when the paper does not change", () => {
    const out = layoutDocumentFull(twoSections("continuous", LETTER));
    expect(out.totalPages).toBe(1);
    expect(out.pages[0]!.content).toHaveLength(2);
  });

  it("inserts a blank page so an oddPage section starts on an odd page", () => {
    const out = layoutDocumentFull(twoSections("oddPage"));
    expect(out.totalPages).toBe(3);
    // The filler page carries no content; the section's own content follows it.
    expect(out.pages[1]!.content).toHaveLength(0);
    expect(out.pages[2]!.content).toHaveLength(1);
  });
});

describe("page breaks inside a paragraph", () => {
  it("splits at the break instead of moving the whole paragraph", () => {
    // The paginator treated any `w:br w:type="page"` as "start this paragraph on
    // a new page", which carried the text *before* the break onto the wrong page.
    const out = layoutDocumentFull({
      body: [
        {
          type: "paragraph",
          children: [
            {
              content: [
                { type: "text", text: "BEFORE" },
                { type: "break", breakType: "page" },
                { type: "text", text: "AFTER" }
              ]
            }
          ]
        }
      ]
    });
    expect(out.totalPages).toBe(2);
    expect(textOfPage(out.pages[0]!)).toBe("BEFORE");
    expect(textOfPage(out.pages[1]!)).toBe("AFTER");
  });

  it("honours several breaks in one paragraph", () => {
    const out = layoutDocumentFull({
      body: [
        {
          type: "paragraph",
          children: [
            {
              content: [
                { type: "text", text: "P1" },
                { type: "break", breakType: "page" },
                { type: "text", text: "P2" },
                { type: "break", breakType: "page" },
                { type: "text", text: "P3" }
              ]
            }
          ]
        }
      ]
    });
    expect(out.pages.map(textOfPage)).toEqual(["P1", "P2", "P3"]);
  });

  it("leaves no blank line for a leading page break, but does for a line break", () => {
    const lead = (breakType?: "page") =>
      layoutDocumentFull({
        body: [
          {
            type: "paragraph",
            children: [
              {
                content: [
                  breakType ? { type: "break", breakType } : { type: "break" },
                  { type: "text", text: "X" }
                ]
              }
            ]
          }
        ]
      }).pages[0]!.content[0]!;
    const pageLead = lead("page");
    const lineLead = lead();
    if (pageLead.type !== "paragraph" || lineLead.type !== "paragraph") {
      throw new Error("expected paragraphs");
    }
    // A leading page break is a break-before: Word leaves no empty line.
    expect(pageLead.lines).toHaveLength(1);
    // A leading line break does produce one.
    expect(lineLead.lines).toHaveLength(2);
  });
});

describe("footnotes", () => {
  const note = (id: number, text: string) => ({
    id,
    content: [para(text)]
  });

  it("renders the reference mark", () => {
    // `footnoteRef` produced no segment at all, so every note printed at the foot
    // of the page with nothing in the text pointing at it.
    const laid = layoutDocumentFull({
      body: [
        {
          type: "paragraph",
          children: [
            { content: [{ type: "text", text: "before" }] },
            {
              properties: { style: "FootnoteReference" },
              content: [{ type: "footnoteRef", id: 7 }]
            },
            { content: [{ type: "text", text: "after" }] }
          ]
        }
      ],
      footnotes: [note(7, "the note")],
      styles: [
        {
          type: "character",
          styleId: "FootnoteReference",
          name: "footnote reference",
          runProperties: { vertAlign: "superscript" }
        }
      ]
    }).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const runs = laid.lines[0]!.runs.filter(r => "text" in r) as {
      text: string;
      verticalAlign?: string;
    }[];
    expect(runs.map(r => r.text)).toEqual(["before", "1", "after"]);
    expect(runs[1]!.verticalAlign).toBe("superscript");
  });

  it("puts a note on the page its reference landed on after a split", () => {
    const out = layoutDocumentFull({
      body: [
        {
          type: "paragraph",
          children: [
            { content: [{ type: "text", text: "word ".repeat(1500) }] },
            { content: [{ type: "footnoteRef", id: 1 }] },
            { content: [{ type: "text", text: "TAIL" }] }
          ]
        }
      ],
      footnotes: [note(1, "the note")]
    });
    expect(out.totalPages).toBe(2);
    // The reference is in the part that spilled over, so the note belongs there.
    expect(out.pages[0]!.footnoteArea ?? []).toHaveLength(0);
    expect(out.pages[1]!.footnoteArea ?? []).not.toHaveLength(0);
  });

  it("never drops a note when the stack needs more than one extra page", () => {
    // Only a single overflow page was emitted, so the third of three page-tall
    // notes vanished from the document.
    const big = (id: number) => note(id, `note ${id} `.repeat(900));
    const out = layoutDocumentFull({
      body: [
        {
          type: "paragraph",
          children: [
            { content: [{ type: "text", text: "body" }] },
            { content: [{ type: "footnoteRef", id: 1 }] },
            { content: [{ type: "footnoteRef", id: 2 }] },
            { content: [{ type: "footnoteRef", id: 3 }] }
          ]
        }
      ],
      footnotes: [big(1), big(2), big(3)]
    });
    const rendered = out.pages
      .flatMap(p => p.footnoteArea ?? [])
      .flatMap(b => b.lines.map(l => l.runs.map(r => ("text" in r ? r.text : "")).join("")))
      .join(" ");
    for (const id of [1, 2, 3]) {
      expect(rendered).toContain(`note ${id}`);
    }
  });
});

describe("keepNext", () => {
  const heading = (text: string): Paragraph => para(text, { style: "H" });
  const styles: DocxDocument["styles"] = [
    {
      type: "paragraph",
      styleId: "H",
      name: "H",
      paragraphProperties: { keepNext: true },
      runProperties: { size: 28, bold: true }
    }
  ];

  it("does not give every heading its own page when many are consecutive", () => {
    // Requiring a whole `keepNext` chain plus its successor to fit produced one
    // page per heading — 764 pages for 800 headings — and cost quadratic time.
    const body = Array.from({ length: 400 }, (_, i) => heading(`Heading ${i}`));
    body.push(para("tail"));
    const out = layoutDocumentFull({ body, styles });
    expect(out.totalPages).toBeLessThan(40);
  });

  it("still refuses to end a page on a heading in an ordinary document", () => {
    const body: Paragraph[] = [];
    for (let i = 0; i < 60; i++) {
      body.push(heading(`Section ${i}`));
      body.push(para(`Body for section ${i}. `.repeat(3 + (i % 4))));
    }
    const out = layoutDocumentFull({ body, styles });
    const headingIndices = new Set(body.map((b, i) => (b.properties?.style === "H" ? i : -1)));
    for (const page of out.pages) {
      const last = page.content[page.content.length - 1];
      if (!last || last.type !== "paragraph" || page.content.length < 2) {
        continue;
      }
      expect(headingIndices.has(last.sourceIndex)).toBe(false);
    }
  });
});

describe("tables", () => {
  it("honours an explicit row height", () => {
    // `w:trHeight` was ignored, so a table with declared row heights rendered
    // squashed — and, with pass 2 owning pagination, shifted everything after it.
    const mk = (rule: "exact" | "atLeast" | "auto", value: number) =>
      layoutDocumentFull({
        body: [
          {
            type: "table",
            rows: [
              { properties: { height: { value, rule } }, cells: [{ content: [cellPara("x")] }] },
              { cells: [{ content: [cellPara("y")] }] }
            ]
          }
        ]
      }).pages[0]!.content[0]!;
    const rowHeight = (t: ReturnType<typeof mk>, row: number) => {
      if (t.type !== "table") {
        throw new Error("expected table");
      }
      return t.cells.find(c => c.row === row)!.rect.height;
    };
    // 2880 twips = 144pt.
    expect(rowHeight(mk("exact", 2880), 0)).toBeCloseTo(144, 1);
    expect(rowHeight(mk("atLeast", 2880), 0)).toBeCloseTo(144, 1);
    // `exact` clamps even below the content height; `auto` is not a constraint.
    expect(rowHeight(mk("exact", 200), 0)).toBeCloseTo(10, 1);
    expect(rowHeight(mk("auto", 2880), 0)).toBeLessThan(30);
    // A neighbouring row is unaffected.
    expect(rowHeight(mk("exact", 2880), 1)).toBeLessThan(30);
  });

  it("bands rows in groups of rowBandSize", () => {
    // Banding alternated per single row regardless of `w:tblStyleRowBandSize`,
    // turning every "banded by twos" table style into a one-row zebra.
    const banded = (rowBandSize: number) => {
      const laid = layoutDocumentFull({
        body: [
          {
            type: "table",
            properties: { style: "S", look: {}, rowBandSize },
            rows: Array.from({ length: 8 }, (_, i) => ({
              cells: [{ content: [cellPara(`r${i}`)] }]
            }))
          }
        ],
        styles: [
          {
            type: "table",
            styleId: "S",
            name: "S",
            tableStyleConditions: [
              { type: "oddRowBanding", cellProperties: { shading: { fill: "EEEEEE" } } }
            ]
          }
        ]
      }).pages[0]!.content[0]!;
      if (laid.type !== "table") {
        throw new Error("expected table");
      }
      return laid.cells.map(c => (c.backgroundColor ? "#" : ".")).join("");
    };
    expect(banded(1)).toBe("#.#.#.#.");
    expect(banded(2)).toBe("##..##..");
  });
});

describe("bookmarks", () => {
  it("resolves a bookmark in the spilled part of a paragraph to its own page", () => {
    // Bookmarks were mapped from the source body, so one in the tail of a split
    // paragraph reported the page the paragraph *started* on.
    const out = layoutDocumentFull({
      body: [
        {
          type: "paragraph",
          children: [
            { type: "bookmarkStart", name: "head", id: 1 },
            { content: [{ type: "text", text: "word ".repeat(1500) }] },
            { type: "bookmarkStart", name: "tail", id: 2 },
            { content: [{ type: "text", text: "END" }] }
          ]
        }
      ]
    });
    expect(out.totalPages).toBe(2);
    expect(out.bookmarkPages.get("head")).toBe(1);
    expect(out.bookmarkPages.get("tail")).toBe(2);
  });
});

describe("reentrancy", () => {
  it("restores layout state so a nested call cannot strip the outer one", () => {
    // The module-level document / list-marker / spacing slots were *cleared* on
    // the way out instead of restored, so a `measureText` callback that laid out
    // another document left the outer one resolving styles against nothing.
    const styles: DocxDocument["styles"] = [
      { type: "paragraph", styleId: "S", name: "S", runProperties: { size: 48 } }
    ];
    const doc: DocxDocument = {
      body: [para("aaa", { style: "S" }), para("bbb", { style: "S" }), para("ccc", { style: "S" })],
      styles
    };
    let calls = 0;
    let fired = false;
    const out = layoutDocumentFull(doc, {
      measureText: (text, _font, size) => {
        calls++;
        // Fire late, so the nested call lands inside the positioning pass.
        if (calls > 9 && !fired) {
          fired = true;
          layoutDocumentFull({ body: [para("x")] });
        }
        return text.length * size * 0.5;
      }
    });
    expect(fired).toBe(true);
    const sizes = out.pages[0]!.content.map(b => {
      if (b.type !== "paragraph") {
        throw new Error("expected paragraph");
      }
      const run = b.lines[0]!.runs[0]!;
      return "fontSize" in run ? run.fontSize : 0;
    });
    // All three keep the 24pt the style declares.
    expect(sizes).toEqual([24, 24, 24]);
  });
});

describe("SVG output", () => {
  it("renders cell content at the cell's origin on both axes, nested tables included", async () => {
    // The layout-model SVG renderer added a cell's origin to the y axis only and
    // ignored the block's own x, so a cell's left margin vanished; and it skipped
    // nested tables entirely, so the same layout differed from the PDF.
    const { renderPageFromLayout } = await import("../layout/render-page");
    const nested = {
      type: "table" as const,
      rows: [{ cells: [{ content: [cellPara("NESTED")] }] }]
    };
    const layout = layoutDocumentFull({
      body: [
        {
          type: "table",
          properties: {
            cellMargins: {
              left: { value: 720, type: "dxa" },
              right: { value: 720, type: "dxa" }
            }
          },
          rows: [{ cells: [{ content: [cellPara("OUTER")] }, { content: [nested] }] }]
        }
      ]
    });
    const svg = renderPageFromLayout(layout, 1);

    // 720 twips = 36pt of cell margin, on top of the 72pt page margin.
    const outer = /<text x="([\d.]+)"[^>]*>OUTER<\/text>/.exec(svg);
    expect(outer).not.toBeNull();
    expect(Number.parseFloat(outer![1])).toBeCloseTo(108, 1);

    expect(svg).toContain("NESTED");
  });

  it("renders the document through the same layout the PDF uses", async () => {
    // `renderDocumentToSvg` used to go through the paginating *estimate* and a
    // simplified cell renderer, so its output disagreed with both the layout model
    // and the PDF: cell text was truncated with an ellipsis instead of wrapped.
    const { renderDocumentToSvg } = await import("../layout/render-page");
    const long = "wrap this cell text across several lines rather than truncating it";
    const pages = renderDocumentToSvg({
      body: [
        {
          type: "table",
          rows: [{ cells: [{ content: [cellPara(long)] }] }]
        }
      ]
    });
    expect(pages).toHaveLength(1);
    expect(pages[0]).not.toContain("…");
  });
});
