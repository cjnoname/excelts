/**
 * Where `fillTemplateEnhanced` substitutes an image.
 *
 * The enhanced pass used to visit top-level body paragraphs and nothing else, which
 * made the two commonest real placements — a logo in a header, and a logo in the
 * letterhead table — the ones that could not be filled. Under `strict` they did not
 * even fail cleanly: the second pass reported an unresolved variable for a
 * placeholder the caller had supplied correctly.
 *
 * These pin the reach. The loop case is deliberately still unsupported: one picture
 * per row needs substitution to happen *during* loop expansion, which is a different
 * arrangement of the two passes rather than a missing branch.
 */

import { Build, Document, Template } from "@word/index";
import type { TemplateImage } from "@word/template/template-engine";
import type { ImageDef, InlineImageContent, Paragraph, Table } from "@word/types";
import { describe, expect, it } from "vitest";

/** A one-pixel PNG is enough: these tests are about placement, not pixels. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89
]);

function templateImage(fileName: string): TemplateImage {
  const image: ImageDef = { data: PNG, mediaType: "png", fileName };
  return { image, width: 914400, height: 457200 };
}

/** Every image run reachable from a block list, tables included. */
function imageRuns(blocks: readonly (Paragraph | Table)[]): InlineImageContent[] {
  return blocks.flatMap(block => {
    if (block.type === "table") {
      return block.rows.flatMap(row =>
        row.cells.flatMap(cell => imageRuns(cell.content as readonly (Paragraph | Table)[]))
      );
    }
    return block.children.flatMap(child =>
      "content" in child
        ? child.content.filter((entry): entry is InlineImageContent => entry.type === "image")
        : []
    );
  });
}

describe("fillTemplateEnhanced image reach", () => {
  it("substitutes an image in a top-level body paragraph", () => {
    const handle = Document.create();
    Document.addParagraph(handle, "{{%logo}}");
    const filled = Template.fillTemplateEnhanced(Document.build(handle), {
      logo: templateImage("logo.png")
    });
    expect(imageRuns(filled.body as readonly (Paragraph | Table)[])).toHaveLength(1);
    expect(filled.images).toHaveLength(1);
  });

  it("descends into a table cell", () => {
    const handle = Document.create();
    Document.addTable(handle, [["{{%logo}}", "Acme Ltd"]]);
    const filled = Template.fillTemplateEnhanced(Document.build(handle), {
      logo: templateImage("logo.png")
    });
    expect(imageRuns(filled.body as readonly (Paragraph | Table)[])).toHaveLength(1);
    expect(filled.images).toHaveLength(1);
    // The neighbouring cell is untouched.
    expect(JSON.stringify(filled.body)).toContain("Acme Ltd");
  });

  it("descends into a nested table", () => {
    const handle = Document.create();
    const inner: Table = {
      type: "table",
      rows: [{ cells: [{ content: [Build.textParagraph("{{%logo}}")] }] }]
    };
    Document.addTableElement(handle, {
      type: "table",
      rows: [{ cells: [{ content: [inner] }] }]
    });
    const filled = Template.fillTemplateEnhanced(Document.build(handle), {
      logo: templateImage("logo.png")
    });
    expect(imageRuns(filled.body as readonly (Paragraph | Table)[])).toHaveLength(1);
  });

  it("substitutes an image in a header and in a footer", () => {
    const handle = Document.create();
    Document.addParagraph(handle, "Body");
    Document.setHeader(handle, "default", { children: [Build.textParagraph("{{%mark}}")] });
    Document.setFooter(handle, "default", { children: [Build.textParagraph("{{%mark}}")] });

    const filled = Template.fillTemplateEnhanced(Document.build(handle), {
      mark: templateImage("mark.png")
    });

    const header = [...(filled.headers?.values() ?? [])][0];
    const footer = [...(filled.footers?.values() ?? [])][0];
    expect(imageRuns(header?.content.children ?? [])).toHaveLength(1);
    expect(imageRuns(footer?.content.children ?? [])).toHaveLength(1);
    // One media part, shared: the merge de-duplicates by file name.
    expect(filled.images).toHaveLength(1);
  });

  it("registers header media even though the body has none", () => {
    // The merge used to read `collectedImages` while building the document literal,
    // which happened before the header pass appended to it — so a header-only image
    // was substituted and then never registered.
    const handle = Document.create();
    Document.addParagraph(handle, "Body");
    Document.setHeader(handle, "default", { children: [Build.textParagraph("{{%logo}}")] });
    const filled = Template.fillTemplateEnhanced(Document.build(handle), {
      logo: templateImage("logo.png")
    });
    expect(imageRuns(filled.body as readonly (Paragraph | Table)[])).toHaveLength(0);
    expect(filled.images, "the header's picture was not registered").toHaveLength(1);
  });

  it("leaves the caller's document untouched", () => {
    const handle = Document.create();
    Document.addParagraph(handle, "{{%logo}}");
    Document.setHeader(handle, "default", { children: [Build.textParagraph("{{%logo}}")] });
    const original = Document.build(handle);
    const snapshot = JSON.stringify(original, (key, value) =>
      key === "data" ? "<bytes>" : (value as unknown)
    );

    Template.fillTemplateEnhanced(original, { logo: templateImage("logo.png") });

    expect(
      JSON.stringify(original, (key, value) => (key === "data" ? "<bytes>" : (value as unknown))),
      "the input document was mutated"
    ).toBe(snapshot);
  });

  it("still cannot fill a placeholder scoped to a loop item", () => {
    // Documented rather than fixed: the image pass runs before loops expand, so
    // `.photo` has no current item to resolve against.
    const handle = Document.create();
    Document.addParagraph(handle, "{{#each items}}");
    Document.addParagraph(handle, "{{%.photo}}");
    Document.addParagraph(handle, "{{/each}}");
    expect(() =>
      Template.fillTemplateEnhanced(Document.build(handle), {
        items: [{}],
        ".photo": templateImage("p.png")
      })
    ).toThrow(/Unresolved/);
  });
});
