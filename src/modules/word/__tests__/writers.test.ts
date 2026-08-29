/**
 * DOCX Writer - Unit Tests for Writer Modules
 *
 * Tests for individual writer modules. Most writers don't have a clean
 * unit-testable surface (they emit to an XmlSink), so these tests
 * exercise the public functions and verify the resulting XML.
 */

import { XmlWriter } from "@xml/writer";
import { describe, it, expect } from "vitest";

import type {
  AbstractNumbering,
  CommentDef,
  MathBlock,
  NumberingInstance,
  Paragraph,
  Run,
  SectionProperties,
  StyleDef,
  Table
} from "../types";
import { renderComments } from "../writer/comment-writer";
import {
  addContentTypeDefault,
  addContentTypeOverride,
  addImageContentTypeDefaults,
  createContentTypes,
  renderContentTypes
} from "../writer/content-types";
import { renderMathBlock } from "../writer/math-writer";
import { renderNumbering } from "../writer/numbering-writer";
import { renderParagraph, renderParagraphProperties } from "../writer/paragraph-writer";
import {
  addRelationship,
  addRelationshipWithId,
  createRelationships,
  getRelationshipCount,
  renderRelationships
} from "../writer/relationships";
import { renderRun, renderRunProperties, renderShading } from "../writer/run-writer";
import { renderSectionProperties } from "../writer/section-writer";
import { StringBuf } from "../writer/string-buf";
import { renderStyles } from "../writer/styles-writer";
import { renderTable } from "../writer/table-writer";

// =============================================================================
// String Buffer
// =============================================================================

describe("StringBuf", () => {
  it("starts empty", () => {
    const buf = new StringBuf();
    expect(buf.length).toBe(0);
  });

  it("appends text", () => {
    const buf = new StringBuf();
    buf.addText("hello");
    expect(buf.length).toBe(5);
    const out = new TextDecoder().decode(buf.toBuffer());
    expect(out).toBe("hello");
  });

  it("supports unicode characters", () => {
    const buf = new StringBuf();
    buf.addText("hello 世界 🌍");
    const out = new TextDecoder().decode(buf.toBuffer());
    expect(out).toBe("hello 世界 🌍");
  });

  it("grows automatically when capacity exceeded", () => {
    const buf = new StringBuf({ size: 8 });
    expect(buf.capacity).toBe(8);
    buf.addText("a string longer than 8 bytes");
    expect(buf.capacity).toBeGreaterThan(8);
    const out = new TextDecoder().decode(buf.toBuffer());
    expect(out).toBe("a string longer than 8 bytes");
  });

  it("appends multiple strings", () => {
    const buf = new StringBuf();
    buf.addText("foo");
    buf.addText("bar");
    buf.addText("baz");
    const out = new TextDecoder().decode(buf.toBuffer());
    expect(out).toBe("foobarbaz");
  });

  it("can append another StringBuf", () => {
    const a = new StringBuf();
    a.addText("hello");
    const b = new StringBuf();
    b.addText(" world");
    a.addStringBuf(b);
    const out = new TextDecoder().decode(a.toBuffer());
    expect(out).toBe("hello world");
  });

  it("reset() clears the buffer", () => {
    const buf = new StringBuf();
    buf.addText("data");
    buf.reset();
    expect(buf.length).toBe(0);
    buf.addText("new");
    const out = new TextDecoder().decode(buf.toBuffer());
    expect(out).toBe("new");
  });

  it("toBuffer() is idempotent (caches result)", () => {
    const buf = new StringBuf();
    buf.addText("test");
    const buf1 = buf.toBuffer();
    const buf2 = buf.toBuffer();
    expect(buf1).toBe(buf2); // Same reference (cached)
  });
});

// =============================================================================
// Content Types
// =============================================================================

describe("ContentTypes", () => {
  it("creates initial state with rels and xml defaults", () => {
    const state = createContentTypes();
    expect(state.defaults.get("rels")).toBeDefined();
    expect(state.defaults.get("xml")).toBeDefined();
  });

  it("adds default content types", () => {
    const state = createContentTypes();
    addContentTypeDefault(state, "png", "image/png");
    expect(state.defaults.get("png")).toBe("image/png");
  });

  it("adds override content types", () => {
    const state = createContentTypes();
    addContentTypeOverride(
      state,
      "/word/document.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    );
    expect(state.overrides.length).toBe(1);
    expect(state.overrides[0].partName).toBe("/word/document.xml");
  });

  it("normalizes partName to start with /", () => {
    const state = createContentTypes();
    addContentTypeOverride(state, "word/document.xml", "type/x");
    expect(state.overrides[0].partName).toBe("/word/document.xml");
  });

  it("deduplicates override by partName (last wins)", () => {
    const state = createContentTypes();
    addContentTypeOverride(state, "/a.xml", "type/old");
    addContentTypeOverride(state, "/a.xml", "type/new");
    expect(state.overrides.length).toBe(1);
    expect(state.overrides[0].contentType).toBe("type/new");
  });

  it("addImageContentTypeDefaults adds known image extensions", () => {
    const state = createContentTypes();
    addImageContentTypeDefaults(state, ["png", "jpg", "gif"]);
    expect(state.defaults.get("png")).toBe("image/png");
    expect(state.defaults.get("jpg")).toBe("image/jpeg");
    expect(state.defaults.get("gif")).toBe("image/gif");
  });

  it("renders content types XML", () => {
    const state = createContentTypes();
    addContentTypeDefault(state, "png", "image/png");
    addContentTypeOverride(state, "/word/document.xml", "type/document");

    const xml = new XmlWriter();
    renderContentTypes(state, xml);
    const output = xml.toString();

    expect(output).toContain("<?xml");
    expect(output).toContain("<Types ");
    expect(output).toContain('Extension="png"');
    expect(output).toContain('ContentType="image/png"');
    expect(output).toContain('PartName="/word/document.xml"');
    expect(output).toContain("</Types>");
  });

  it("sorts defaults alphabetically in output", () => {
    const state = createContentTypes();
    addContentTypeDefault(state, "zip", "application/zip");
    addContentTypeDefault(state, "abc", "type/abc");

    const xml = new XmlWriter();
    renderContentTypes(state, xml);
    const output = xml.toString();
    const abcPos = output.indexOf('Extension="abc"');
    const zipPos = output.indexOf('Extension="zip"');
    expect(abcPos).toBeLessThan(zipPos);
  });
});

// =============================================================================
// Relationships
// =============================================================================

describe("Relationships", () => {
  it("creates empty state", () => {
    const state = createRelationships();
    expect(state.count()).toBe(0);
    expect(getRelationshipCount(state)).toBe(0);
  });

  it("adds a relationship and returns rId", () => {
    const state = createRelationships();
    const rId = addRelationship(state, "type/x", "target/y");
    expect(rId).toMatch(/^rId\d+$/);
    expect(state.count()).toBe(1);
  });

  it("auto-increments rIds", () => {
    const state = createRelationships();
    const id1 = addRelationship(state, "type/a", "target/1");
    const id2 = addRelationship(state, "type/b", "target/2");
    expect(id1).not.toBe(id2);
  });

  it("dedupes by (type, target, targetMode)", () => {
    const state = createRelationships();
    const id1 = addRelationship(state, "type/x", "target/y");
    const id2 = addRelationship(state, "type/x", "target/y");
    expect(id1).toBe(id2);
    expect(state.count()).toBe(1);
  });

  it("treats different targetMode as different rels", () => {
    const state = createRelationships();
    const id1 = addRelationship(state, "type/x", "https://example.com");
    const id2 = addRelationship(state, "type/x", "https://example.com", "External");
    expect(id1).not.toBe(id2);
  });

  it("addRelationshipWithId throws on duplicate id", () => {
    const state = createRelationships();
    addRelationshipWithId(state, "rId99", "type/x", "target/y");
    expect(() => addRelationshipWithId(state, "rId99", "type/z", "target/w")).toThrow();
  });

  it("addRelationshipWithId advances internal counter", () => {
    const state = createRelationships();
    addRelationshipWithId(state, "rId50", "type/x", "target/y");
    const next = addRelationship(state, "type/z", "target/w");
    // Next auto-id should be > 50
    const num = parseInt(next.replace("rId", ""), 10);
    expect(num).toBeGreaterThan(50);
  });

  it("findByTypeAndTarget returns existing relationship", () => {
    const state = createRelationships();
    addRelationship(state, "type/x", "target/y");
    const found = state.findByTypeAndTarget("type/x", "target/y");
    expect(found).toBeDefined();
    expect(found!.target).toBe("target/y");
  });

  it("findByTypeAndTarget returns undefined for missing", () => {
    const state = createRelationships();
    expect(state.findByTypeAndTarget("none", "none")).toBeUndefined();
  });

  it("hasId checks existence", () => {
    const state = createRelationships();
    addRelationshipWithId(state, "rId42", "t", "x");
    expect(state.hasId("rId42")).toBe(true);
    expect(state.hasId("rId999")).toBe(false);
  });

  it("validate detects duplicate IDs", () => {
    const state = createRelationships();
    addRelationship(state, "t", "x");
    // Inject duplicate manually (test boundary, since add() prevents this)
    const internal = state.rels as { id: string; type: string; target: string }[];
    internal.push({ id: internal[0].id, type: "other", target: "z" } as any);
    const errors = state.validate();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("renders relationships to XML", () => {
    const state = createRelationships();
    addRelationship(state, "type/a", "target/x");
    addRelationship(state, "type/b", "https://ext.com", "External");

    const xml = new XmlWriter();
    renderRelationships(state, xml);
    const output = xml.toString();

    expect(output).toContain("<?xml");
    expect(output).toContain("<Relationships");
    expect(output).toContain('Type="type/a"');
    expect(output).toContain('Target="target/x"');
    expect(output).toContain('TargetMode="External"');
    expect(output).toContain("</Relationships>");
  });
});

// =============================================================================
// Run Writer
// =============================================================================

describe("renderRun", () => {
  it("renders a simple text run", () => {
    const run: Run = { content: [{ type: "text", text: "Hello" }] };
    const xml = new XmlWriter();
    renderRun(xml, run);
    const output = xml.toString();
    expect(output).toContain("<w:r>");
    expect(output).toContain("<w:t");
    expect(output).toContain("Hello");
    expect(output).toContain("</w:r>");
  });

  it("renders bold + italic run properties", () => {
    const run: Run = {
      properties: { bold: true, italic: true },
      content: [{ type: "text", text: "x" }]
    };
    const xml = new XmlWriter();
    renderRun(xml, run);
    const output = xml.toString();
    expect(output).toContain("<w:b/>");
    expect(output).toContain("<w:i/>");
  });

  it("preserves whitespace with xml:space=preserve", () => {
    const run: Run = { content: [{ type: "text", text: "  spaced  " }] };
    const xml = new XmlWriter();
    renderRun(xml, run);
    const output = xml.toString();
    expect(output).toContain('xml:space="preserve"');
  });

  it("renders break content", () => {
    const run: Run = { content: [{ type: "break", breakType: "page" }] };
    const xml = new XmlWriter();
    renderRun(xml, run);
    const output = xml.toString();
    expect(output).toContain('<w:br w:type="page"/>');
  });

  it("renders tab content", () => {
    const run: Run = { content: [{ type: "tab" }] };
    const xml = new XmlWriter();
    renderRun(xml, run);
    expect(xml.toString()).toContain("<w:tab/>");
  });

  it("renders multiple content items in order", () => {
    const run: Run = {
      content: [{ type: "text", text: "A" }, { type: "tab" }, { type: "text", text: "B" }]
    };
    const xml = new XmlWriter();
    renderRun(xml, run);
    const output = xml.toString();
    const aPos = output.indexOf(">A<");
    const tabPos = output.indexOf("<w:tab");
    const bPos = output.indexOf(">B<");
    expect(aPos).toBeLessThan(tabPos);
    expect(tabPos).toBeLessThan(bPos);
  });

  it("splits text containing \\n into multiple <w:t> with <w:br/> between", () => {
    // OOXML's CT_Text forbids U+000A inside its value; Word rejects the
    // file. The writer should transparently split on newlines.
    const run: Run = { content: [{ type: "text", text: "line1\nline2\nline3" }] };
    const xml = new XmlWriter();
    renderRun(xml, run);
    const output = xml.toString();
    // Original text with literal \n must NOT survive
    expect(output.includes("line1\nline2")).toBe(false);
    // We expect three <w:t> segments and two <w:br/>
    expect((output.match(/<w:t[^>]*>line\d<\/w:t>/g) ?? []).length).toBe(3);
    expect((output.match(/<w:br\/>/g) ?? []).length).toBe(2);
  });

  it("normalises CRLF / lone CR to <w:br/>", () => {
    const run: Run = { content: [{ type: "text", text: "a\r\nb\rc" }] };
    const xml = new XmlWriter();
    renderRun(xml, run);
    const output = xml.toString();
    // Two breaks (one between a/b, one between b/c) and three text parts
    expect((output.match(/<w:br\/>/g) ?? []).length).toBe(2);
    expect(output.includes(">a<")).toBe(true);
    expect(output.includes(">b<")).toBe(true);
    expect(output.includes(">c<")).toBe(true);
    // No raw CR/LF should leak into the XML payload of any <w:t>
    expect(/[\r\n]/.test(output.replace(/(?<=>)[\s\S]*?(?=<)/g, ""))).toBe(false);
  });

  it("skips empty segments around newlines (does not emit empty <w:t>)", () => {
    const run: Run = { content: [{ type: "text", text: "\nfoo\n" }] };
    const xml = new XmlWriter();
    renderRun(xml, run);
    const output = xml.toString();
    expect((output.match(/<w:t[^>]*>foo<\/w:t>/g) ?? []).length).toBe(1);
    // 2 breaks (leading and trailing newlines), 1 text segment
    expect((output.match(/<w:br\/>/g) ?? []).length).toBe(2);
    // No empty <w:t></w:t> nor <w:t/> emitted
    expect(/<w:t[^>]*><\/w:t>|<w:t[^>]*\/>/.test(output)).toBe(false);
  });
});

describe("renderRunProperties", () => {
  it("emits empty rPr for empty properties", () => {
    const xml = new XmlWriter();
    renderRunProperties(xml, {});
    const output = xml.toString();
    expect(output).toContain("<w:rPr/>");
  });

  it("emits rStyle for style", () => {
    const xml = new XmlWriter();
    renderRunProperties(xml, { style: "MyStyle" });
    expect(xml.toString()).toContain('<w:rStyle w:val="MyStyle"/>');
  });

  it("emits rFonts for font name string", () => {
    const xml = new XmlWriter();
    renderRunProperties(xml, { font: "Arial" });
    const output = xml.toString();
    // A Latin family leaves the East Asian slot inherited. Claiming it would
    // point ideographs at a face with no CJK glyphs — worse than the East Asian
    // face they inherit from docDefaults.
    expect(output).toContain('<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>');
  });

  it("names the East Asian slot so a Chinese typeface reaches Chinese text", () => {
    // `w:ascii`/`w:hAnsi` govern only ASCII and High ANSI, so without this
    // `{ font: "宋体" }` applied to none of a run's Chinese text.
    const xml = new XmlWriter();
    renderRunProperties(xml, { font: "宋体" });
    expect(xml.toString()).toContain('w:eastAsia="宋体"');
  });

  it("recognises East Asian families by their English and localized names", () => {
    for (const name of ["SimSun", "Microsoft YaHei", "微软雅黑", "MS Gothic", "Malgun Gothic"]) {
      const xml = new XmlWriter();
      renderRunProperties(xml, { font: name });
      expect(xml.toString(), name).toContain(`w:eastAsia="${name}"`);
    }
  });

  it("leaves the East Asian slot inherited for Latin families", () => {
    for (const name of ["Calibri Light", "Courier New", "Times New Roman", "Helvetica"]) {
      const xml = new XmlWriter();
      renderRunProperties(xml, { font: name });
      expect(xml.toString(), name).not.toContain("w:eastAsia");
    }
  });

  it("leaves the East Asian slot alone when the object form omits it", () => {
    // A caller that wants a Latin-only override says so explicitly.
    const xml = new XmlWriter();
    renderRunProperties(xml, { font: { ascii: "Arial", hAnsi: "Arial" } });
    expect(xml.toString()).not.toContain("w:eastAsia");
  });

  it("emits color", () => {
    const xml = new XmlWriter();
    renderRunProperties(xml, { color: "FF0000" });
    expect(xml.toString()).toContain('<w:color w:val="FF0000"/>');
  });

  it("emits sz (size in half-points)", () => {
    const xml = new XmlWriter();
    renderRunProperties(xml, { size: 24 });
    expect(xml.toString()).toContain('<w:sz w:val="24"/>');
  });

  it("emits underline as simple value", () => {
    const xml = new XmlWriter();
    renderRunProperties(xml, { underline: "single" });
    expect(xml.toString()).toContain('<w:u w:val="single"/>');
  });

  it("emits highlight", () => {
    const xml = new XmlWriter();
    renderRunProperties(xml, { highlight: "yellow" });
    expect(xml.toString()).toContain('<w:highlight w:val="yellow"/>');
  });
});

describe("renderShading", () => {
  it("renders shading with color and fill", () => {
    const xml = new XmlWriter();
    renderShading(xml, { pattern: "clear", color: "auto", fill: "FFFF00" });
    const output = xml.toString();
    expect(output).toContain("<w:shd ");
    expect(output).toContain('w:val="clear"');
    expect(output).toContain('w:fill="FFFF00"');
  });
});

// =============================================================================
// Paragraph Writer
// =============================================================================

describe("renderParagraph", () => {
  it("renders a simple paragraph with text", () => {
    const para: Paragraph = {
      type: "paragraph",
      children: [{ content: [{ type: "text", text: "Hello" }] } as Run]
    };
    const xml = new XmlWriter();
    renderParagraph(xml, para);
    const output = xml.toString();
    expect(output).toContain("<w:p>");
    expect(output).toContain("</w:p>");
    expect(output).toContain("Hello");
  });

  it("renders empty paragraph", () => {
    const para: Paragraph = { type: "paragraph", children: [] };
    const xml = new XmlWriter();
    renderParagraph(xml, para);
    const output = xml.toString();
    // Self-closing tag for empty paragraph
    expect(output).toMatch(/<w:p(\/>|>.*<\/w:p>)/);
  });

  it("renders paragraph with style", () => {
    const para: Paragraph = {
      type: "paragraph",
      properties: { style: "Heading1" },
      children: []
    };
    const xml = new XmlWriter();
    renderParagraph(xml, para);
    expect(xml.toString()).toContain('<w:pStyle w:val="Heading1"/>');
  });

  it("renders alignment", () => {
    const para: Paragraph = {
      type: "paragraph",
      properties: { alignment: "center" },
      children: []
    };
    const xml = new XmlWriter();
    renderParagraph(xml, para);
    expect(xml.toString()).toContain('<w:jc w:val="center"/>');
  });

  it("renders multiple runs", () => {
    const para: Paragraph = {
      type: "paragraph",
      children: [
        { content: [{ type: "text", text: "Hello " }] } as Run,
        { content: [{ type: "text", text: "World" }] } as Run
      ]
    };
    const xml = new XmlWriter();
    renderParagraph(xml, para);
    const output = xml.toString();
    expect(output.match(/<w:r>/g)?.length).toBe(2);
  });
});

describe("renderParagraphProperties", () => {
  it("emits empty pPr for empty properties", () => {
    const xml = new XmlWriter();
    renderParagraphProperties(xml, {});
    expect(xml.toString()).toContain("<w:pPr/>");
  });

  it("emits keepNext flag", () => {
    const xml = new XmlWriter();
    renderParagraphProperties(xml, { keepNext: true });
    expect(xml.toString()).toContain("<w:keepNext/>");
  });

  it("emits indent", () => {
    const xml = new XmlWriter();
    renderParagraphProperties(xml, { indent: { left: 720 } });
    expect(xml.toString()).toContain('w:left="720"');
  });

  it("emits spacing", () => {
    const xml = new XmlWriter();
    renderParagraphProperties(xml, { spacing: { before: 100, after: 200 } });
    const output = xml.toString();
    expect(output).toContain('w:before="100"');
    expect(output).toContain('w:after="200"');
  });

  it("emits numbering reference", () => {
    const xml = new XmlWriter();
    renderParagraphProperties(xml, { numbering: { level: 0, numId: 1 } });
    const output = xml.toString();
    expect(output).toContain('<w:ilvl w:val="0"/>');
    expect(output).toContain('<w:numId w:val="1"/>');
  });
});

// =============================================================================
// Table Writer
// =============================================================================

describe("renderTable", () => {
  it("renders a 2x2 table", () => {
    const table: Table = {
      type: "table",
      rows: [
        {
          cells: [
            {
              content: [
                {
                  type: "paragraph",
                  children: [{ content: [{ type: "text", text: "A" }] } as Run]
                }
              ]
            },
            {
              content: [
                {
                  type: "paragraph",
                  children: [{ content: [{ type: "text", text: "B" }] } as Run]
                }
              ]
            }
          ]
        },
        {
          cells: [
            {
              content: [
                {
                  type: "paragraph",
                  children: [{ content: [{ type: "text", text: "C" }] } as Run]
                }
              ]
            },
            {
              content: [
                {
                  type: "paragraph",
                  children: [{ content: [{ type: "text", text: "D" }] } as Run]
                }
              ]
            }
          ]
        }
      ]
    } as any;
    const xml = new XmlWriter();
    renderTable(xml, table);
    const output = xml.toString();
    expect(output).toContain("<w:tbl>");
    expect(output).toContain("</w:tbl>");
    expect((output.match(/<w:tr[ >]/g) ?? []).length).toBe(2);
    expect((output.match(/<w:tc[ >]/g) ?? []).length).toBe(4);
    expect(output).toContain(">A<");
    expect(output).toContain(">D<");
  });

  it("renders empty table", () => {
    const table: Table = { type: "table", rows: [] } as any;
    const xml = new XmlWriter();
    renderTable(xml, table);
    expect(xml.toString()).toContain("<w:tbl");
  });

  it("renders table with style", () => {
    const table: Table = {
      type: "table",
      properties: { style: "TableGrid" },
      rows: []
    } as any;
    const xml = new XmlWriter();
    renderTable(xml, table);
    expect(xml.toString()).toContain('<w:tblStyle w:val="TableGrid"/>');
  });

  it("renders cell with gridSpan", () => {
    const table: Table = {
      type: "table",
      rows: [
        {
          cells: [
            {
              properties: { gridSpan: 2 },
              content: [{ type: "paragraph", children: [] }]
            }
          ]
        }
      ]
    } as any;
    const xml = new XmlWriter();
    renderTable(xml, table);
    expect(xml.toString()).toContain('<w:gridSpan w:val="2"/>');
  });
});

// =============================================================================
// Math Writer
// =============================================================================

describe("renderMathBlock", () => {
  it("renders simple math run", () => {
    const math: MathBlock = {
      type: "math",
      content: [{ type: "mathRun", text: "x + 1" }]
    };
    const xml = new XmlWriter();
    renderMathBlock(xml, math);
    const output = xml.toString();
    expect(output).toContain("<m:oMathPara");
    expect(output).toContain("<m:oMath>");
    expect(output).toContain("<m:r>");
    expect(output).toContain("<m:t");
    expect(output).toContain("x + 1");
  });

  it("renders fraction", () => {
    const math: MathBlock = {
      type: "math",
      content: [
        {
          type: "mathFraction",
          numerator: [{ type: "mathRun", text: "1" }],
          denominator: [{ type: "mathRun", text: "2" }]
        }
      ]
    };
    const xml = new XmlWriter();
    renderMathBlock(xml, math);
    const output = xml.toString();
    expect(output).toContain("<m:f>");
    expect(output).toContain("<m:num>");
    expect(output).toContain("<m:den>");
  });

  it("renders radical (square root)", () => {
    const math: MathBlock = {
      type: "math",
      content: [
        {
          type: "mathRadical",
          content: [{ type: "mathRun", text: "x" }]
        }
      ]
    };
    const xml = new XmlWriter();
    renderMathBlock(xml, math);
    expect(xml.toString()).toContain("<m:rad>");
  });
});

// =============================================================================
// Comment Writer
// =============================================================================

describe("renderComments", () => {
  it("renders comments XML", () => {
    const comments: CommentDef[] = [
      {
        id: 1,
        author: "Alice",
        date: "2024-01-01T00:00:00Z",
        content: [
          {
            type: "paragraph",
            children: [{ content: [{ type: "text", text: "Comment text" }] } as Run]
          }
        ]
      }
    ];
    const xml = new XmlWriter();
    renderComments(xml, comments);
    const output = xml.toString();
    expect(output).toContain("<w:comments");
    expect(output).toContain('w:author="Alice"');
    expect(output).toContain("Comment text");
  });

  it("renders empty comments list", () => {
    const xml = new XmlWriter();
    renderComments(xml, []);
    const output = xml.toString();
    expect(output).toContain("<w:comments");
  });
});

// =============================================================================
// Styles Writer
// =============================================================================

describe("renderStyles", () => {
  it("renders empty styles document", () => {
    const xml = new XmlWriter();
    renderStyles(xml);
    const output = xml.toString();
    expect(output).toContain("<?xml");
    expect(output).toContain("<w:styles");
    // May be self-closing if no styles
    expect(output).toMatch(/<\/w:styles>|<w:styles[^>]*\/>/);
  });

  it("renders style definitions", () => {
    const styles: StyleDef[] = [
      {
        type: "paragraph",
        styleId: "Normal",
        name: "Normal",
        isDefault: true
      }
    ];
    const xml = new XmlWriter();
    renderStyles(xml, undefined, styles);
    const output = xml.toString();
    expect(output).toContain("<w:style ");
    expect(output).toContain('w:type="paragraph"');
    expect(output).toContain('w:styleId="Normal"');
    expect(output).toContain('w:default="1"');
  });

  it("renders style with based-on relationship", () => {
    const styles: StyleDef[] = [
      {
        type: "paragraph",
        styleId: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal"
      }
    ];
    const xml = new XmlWriter();
    renderStyles(xml, undefined, styles);
    const output = xml.toString();
    expect(output).toContain('<w:basedOn w:val="Normal"/>');
    expect(output).toContain('<w:next w:val="Normal"/>');
  });

  it("renders document defaults", () => {
    const xml = new XmlWriter();
    renderStyles(xml, {
      runProperties: { font: "Calibri", size: 22 }
    });
    const output = xml.toString();
    expect(output).toContain("<w:docDefaults>");
    expect(output).toContain("<w:rPrDefault>");
  });
});

// =============================================================================
// Numbering Writer
// =============================================================================

describe("renderNumbering", () => {
  it("renders empty numbering", () => {
    const xml = new XmlWriter();
    renderNumbering(xml, [], []);
    const output = xml.toString();
    expect(output).toContain("<?xml");
    expect(output).toContain("<w:numbering");
    // May be self-closing
    expect(output).toMatch(/<\/w:numbering>|<w:numbering[^>]*\/>/);
  });

  it("renders abstract numbering with levels", () => {
    const abstractNums: AbstractNumbering[] = [
      {
        abstractNumId: 0,
        levels: [
          {
            level: 0,
            format: "decimal",
            text: "%1.",
            justification: "left"
          }
        ]
      }
    ];
    const instances: NumberingInstance[] = [{ numId: 1, abstractNumId: 0 }];

    const xml = new XmlWriter();
    renderNumbering(xml, abstractNums, instances);
    const output = xml.toString();
    expect(output).toContain('<w:abstractNum w:abstractNumId="0">');
    expect(output).toContain('<w:numFmt w:val="decimal"/>');
    expect(output).toContain('<w:lvlText w:val="%1."/>');
    expect(output).toContain('<w:num w:numId="1">');
    expect(output).toContain('<w:abstractNumId w:val="0"/>');
  });

  it("renders bullet numbering", () => {
    const abstractNums: AbstractNumbering[] = [
      {
        abstractNumId: 0,
        levels: [
          {
            level: 0,
            format: "bullet",
            text: "\u2022"
          }
        ]
      }
    ];
    const xml = new XmlWriter();
    renderNumbering(xml, abstractNums, []);
    expect(xml.toString()).toContain('<w:numFmt w:val="bullet"/>');
  });
});

// =============================================================================
// Section Properties (w:sectPr)
// =============================================================================

describe("renderSectionProperties", () => {
  /** Return the order in which the given local element names appear in xml. */
  function orderOf(xml: string, names: string[]): string[] {
    return names
      .map(n => ({ n, pos: xml.indexOf(`<w:${n}`) }))
      .filter(e => e.pos >= 0)
      .sort((a, b) => a.pos - b.pos)
      .map(e => e.n);
  }

  it("emits sectPr children in the OOXML schema order", () => {
    // A section that exercises every ordering-sensitive child at once.
    const sect: SectionProperties = {
      headers: [{ type: "default", rId: "rId10" }],
      footers: [{ type: "default", rId: "rId11" }],
      footnoteProperties: { numFmt: "decimal" },
      endnoteProperties: { numFmt: "lowerRoman" },
      breakType: "nextPage",
      pageSize: { width: 11906, height: 16838 },
      margins: { top: 720, bottom: 720, left: 720, right: 720 },
      pageBorders: {
        display: "allPages",
        top: { style: "single", size: 4, color: "000000" }
      },
      lineNumbers: { countBy: 1, start: 1, restart: "newPage" },
      pageNumbering: { start: 1, format: "lowerRoman" },
      columns: { count: 2, space: 720, equalWidth: true },
      formProtection: true,
      verticalAlign: "center",
      titlePage: true,
      textDirection: "lrTb",
      bidi: true,
      rtlGutter: true,
      docGrid: { type: "lines", linePitch: 360 }
    };
    const xml = new XmlWriter();
    renderSectionProperties(xml, sect);
    const out = xml.toString();

    // The canonical CT_SectPr sequence (subset present in this section).
    const expected = [
      "headerReference",
      "footerReference",
      "footnotePr",
      "endnotePr",
      "type",
      "pgSz",
      "pgMar",
      "pgBorders",
      "lnNumType",
      "pgNumType",
      "cols",
      "formProt",
      "vAlign",
      "titlePg",
      "textDirection",
      "bidi",
      "rtlGutter",
      "docGrid"
    ];
    expect(orderOf(out, expected)).toEqual(expected);
  });

  it("places lnNumType before pgNumType and cols after pgNumType", () => {
    const sect: SectionProperties = {
      pageSize: { width: 11906, height: 16838 },
      margins: { top: 720, bottom: 720, left: 720, right: 720 },
      pageNumbering: { start: 1, format: "lowerRoman" },
      lineNumbers: { countBy: 1 },
      columns: { count: 1 }
    };
    const xml = new XmlWriter();
    renderSectionProperties(xml, sect);
    const out = xml.toString();
    const ln = out.indexOf("<w:lnNumType");
    const pn = out.indexOf("<w:pgNumType");
    const cols = out.indexOf("<w:cols");
    expect(ln).toBeGreaterThanOrEqual(0);
    expect(pn).toBeGreaterThan(ln);
    expect(cols).toBeGreaterThan(pn);
  });

  it("places footnotePr/endnotePr before type and pgSz", () => {
    const sect: SectionProperties = {
      footnoteProperties: { numFmt: "decimal" },
      endnoteProperties: { numFmt: "decimal" },
      breakType: "nextPage",
      pageSize: { width: 11906, height: 16838 },
      margins: { top: 720, bottom: 720, left: 720, right: 720 }
    };
    const xml = new XmlWriter();
    renderSectionProperties(xml, sect);
    const out = xml.toString();
    expect(out.indexOf("<w:footnotePr")).toBeLessThan(out.indexOf("<w:type"));
    expect(out.indexOf("<w:endnotePr")).toBeLessThan(out.indexOf("<w:type"));
    expect(out.indexOf("<w:type")).toBeLessThan(out.indexOf("<w:pgSz"));
  });
});
