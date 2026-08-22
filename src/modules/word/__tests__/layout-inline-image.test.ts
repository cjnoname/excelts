/**
 * Inline image rendering — paragraph runs that contain an
 * `InlineImageContent` must produce a `LineBoxItem` with `type:
 * "image"` so renderers (PDF, SVG) can place the image alongside
 * text. Without this the image is silently dropped — a data-loss bug.
 */

import { describe, it, expect } from "vitest";

import { layoutDocumentFull } from "../layout/layout-full";
import { renderPageFromLayout } from "../layout/render-page";
import type { DocxDocument, ImageDef, InlineImageContent, Paragraph, Run } from "../types";

const ONE_PIXEL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0xda, 0x62, 0, 0, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

const baseDoc = (overrides: Partial<DocxDocument> = {}): DocxDocument => ({
  body: [],
  styles: [],
  abstractNumberings: [],
  numberingInstances: [],
  headers: new Map(),
  footers: new Map(),
  footnotes: [],
  endnotes: [],
  comments: [],
  images: [],
  fonts: [],
  embeddedFonts: [],
  customXmlParts: [],
  customProperties: [],
  opaqueParts: [],
  ...overrides
});

function inlineImageRun(rId: string, widthEmu: number, heightEmu: number): Run {
  const img: InlineImageContent = {
    type: "image",
    rId,
    width: widthEmu,
    height: heightEmu
  };
  return { content: [img] };
}

function textRun(text: string): Run {
  return { content: [{ type: "text", text }] };
}

function makeImageDef(rId: string): ImageDef {
  return { data: ONE_PIXEL_PNG, mediaType: "png", fileName: "img.png", rId };
}

describe("inline image layout", () => {
  it('emits a LineBoxItem with type: "image" for an inline image run', () => {
    const para: Paragraph = {
      type: "paragraph",
      children: [
        textRun("before "),
        inlineImageRun("rId1", 914_400, 914_400), // 1in × 1in
        textRun(" after")
      ]
    };
    const doc = baseDoc({
      body: [para],
      images: [makeImageDef("rId1")]
    });
    const layout = layoutDocumentFull(doc);
    const paraItem = layout.pages[0].content[0];
    expect(paraItem.type).toBe("paragraph");
    if (paraItem.type === "paragraph") {
      const allItems = paraItem.lines.flatMap(l => l.runs);
      const images = allItems.filter(item => item.type === "image");
      expect(images).toHaveLength(1);
      const image = images[0];
      if (image.type === "image") {
        expect(image.width).toBeCloseTo(72); // 1 inch
        expect(image.height).toBeCloseTo(72);
        expect(image.data).toBe(ONE_PIXEL_PNG);
        expect(image.mimeType).toBe("image/png");
      }
    }
  });

  it("places the image between surrounding text runs in document order", () => {
    const para: Paragraph = {
      type: "paragraph",
      children: [textRun("A"), inlineImageRun("rId1", 914_400, 914_400), textRun("B")]
    };
    const doc = baseDoc({
      body: [para],
      images: [makeImageDef("rId1")]
    });
    const layout = layoutDocumentFull(doc);
    const paraItem = layout.pages[0].content[0];
    if (paraItem.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    // Walk the line items: A, image, B in that order.
    const items = paraItem.lines.flatMap(l => l.runs);
    expect(items.length).toBeGreaterThanOrEqual(3);
    // A's text should appear before image's x; B's after.
    const imageIdx = items.findIndex(i => i.type === "image");
    expect(imageIdx).toBeGreaterThan(0);
    const before = items[imageIdx - 1];
    const after = items[imageIdx + 1];
    if (before.type !== "image") {
      expect(before.text).toContain("A");
    }
    if (after && after.type !== "image") {
      expect(after.text).toContain("B");
    }
  });

  it("expands the line height to fit a tall inline image", () => {
    const para: Paragraph = {
      type: "paragraph",
      children: [
        textRun("text "),
        inlineImageRun("rId1", 914_400, 1_828_800), // 1in × 2in
        textRun(" more")
      ]
    };
    const doc = baseDoc({
      body: [para],
      images: [makeImageDef("rId1")]
    });
    const layout = layoutDocumentFull(doc);
    const paraItem = layout.pages[0].content[0];
    if (paraItem.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    // The line containing the image must be at least the image's
    // height (144pt), regardless of the default 14.4pt text line.
    const imageLine = paraItem.lines.find(l => l.runs.some(item => item.type === "image"));
    expect(imageLine).toBeDefined();
    expect(imageLine!.height).toBeGreaterThanOrEqual(144);
    // Inline drawings sit on the same baseline as the text. The tallest image
    // therefore pushes the baseline to its own bottom edge, with the text's
    // descent reserved below it.
    expect(imageLine!.baseline).toBeCloseTo(144, 6);
    expect(imageLine!.height).toBeGreaterThan(imageLine!.baseline);
  });

  it("falls back gracefully when the rId cannot be resolved (no crash)", () => {
    const para: Paragraph = {
      type: "paragraph",
      children: [inlineImageRun("rIdMissing", 914_400, 914_400)]
    };
    const doc = baseDoc({
      body: [para],
      images: [] // intentionally empty
    });
    const layout = layoutDocumentFull(doc);
    const paraItem = layout.pages[0].content[0];
    if (paraItem.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const items = paraItem.lines.flatMap(l => l.runs);
    const image = items.find(i => i.type === "image");
    expect(image).toBeDefined();
    if (image?.type === "image") {
      // Empty data signals "renderer should skip / draw placeholder".
      expect(image.data.length).toBe(0);
    }
  });

  it("emits an SVG <image> element when rendering the page", () => {
    const para: Paragraph = {
      type: "paragraph",
      children: [inlineImageRun("rId1", 914_400, 914_400)]
    };
    const doc = baseDoc({
      body: [para],
      images: [makeImageDef("rId1")]
    });
    const layout = layoutDocumentFull(doc);
    const svg = renderPageFromLayout(layout, 1);
    expect(svg).toMatch(/<image[^>]*href="data:image\/png;base64,/);
  });

  it("renders inline images inside table cells (most common container)", () => {
    const cellPara: Paragraph = {
      type: "paragraph",
      children: [textRun("logo "), inlineImageRun("rId1", 914_400, 914_400)]
    };
    const doc = baseDoc({
      body: [
        {
          type: "table",
          rows: [{ cells: [{ content: [cellPara] }] }]
        }
      ],
      images: [makeImageDef("rId1")]
    });
    const layout = layoutDocumentFull(doc);
    const tableItem = layout.pages[0].content[0];
    expect(tableItem.type).toBe("table");
    if (tableItem.type !== "table") {
      return;
    }
    const cellContent = tableItem.cells[0].content;
    expect(cellContent.length).toBe(1);
    const innerPara = cellContent[0];
    expect(innerPara.type).toBe("paragraph");
    if (innerPara.type !== "paragraph") {
      return;
    }
    const items = innerPara.lines.flatMap(l => l.runs);
    const image = items.find(i => i.type === "image");
    expect(image).toBeDefined();
    if (image?.type === "image") {
      expect(image.data).toBe(ONE_PIXEL_PNG);
    }
  });

  it("renders inline images inside header content", () => {
    const headerPara: Paragraph = {
      type: "paragraph",
      children: [inlineImageRun("rId1", 914_400, 457_200)]
    };
    const doc = baseDoc({
      body: [{ type: "paragraph", children: [textRun("body")] }],
      headers: new Map([["rIdH1", { content: { children: [headerPara] } }]]),
      sectionProperties: {
        headers: [{ type: "default", rId: "rIdH1" }]
      },
      images: [makeImageDef("rId1")]
    });
    const layout = layoutDocumentFull(doc);
    const headerItems = layout.pages[0].header;
    expect(headerItems).toBeDefined();
    if (!headerItems) {
      return;
    }
    const para = headerItems[0];
    expect(para.type).toBe("paragraph");
    if (para.type !== "paragraph") {
      return;
    }
    const image = para.lines.flatMap(l => l.runs).find(i => i.type === "image");
    expect(image).toBeDefined();
  });

  it("renders inline images inside footnotes", () => {
    const footnotePara: Paragraph = {
      type: "paragraph",
      children: [textRun("see "), inlineImageRun("rId1", 457_200, 457_200)]
    };
    const bodyPara: Paragraph = {
      type: "paragraph",
      children: [textRun("text"), { content: [{ type: "footnoteRef", id: 1 }] }]
    };
    const doc = baseDoc({
      body: [bodyPara],
      footnotes: [{ id: 1, content: [footnotePara] }],
      images: [makeImageDef("rId1")]
    });
    const layout = layoutDocumentFull(doc);
    const fnArea = layout.pages[0].footnoteArea;
    expect(fnArea).toBeDefined();
    if (!fnArea) {
      return;
    }
    const image = fnArea[0].lines.flatMap(l => l.runs).find(i => i.type === "image");
    expect(image).toBeDefined();
  });

  it("renders inline images inside SDTs", () => {
    const inner: Paragraph = {
      type: "paragraph",
      children: [inlineImageRun("rId1", 457_200, 457_200)]
    };
    const doc = baseDoc({
      body: [{ type: "sdt", content: [inner] }],
      images: [makeImageDef("rId1")]
    });
    const layout = layoutDocumentFull(doc);
    const sdt = layout.pages[0].content[0];
    expect(sdt.type).toBe("sdt");
    if (sdt.type !== "sdt") {
      return;
    }
    const innerPara = sdt.content[0];
    expect(innerPara.type).toBe("paragraph");
    if (innerPara.type !== "paragraph") {
      return;
    }
    const image = innerPara.lines.flatMap(l => l.runs).find(i => i.type === "image");
    expect(image).toBeDefined();
  });
});
