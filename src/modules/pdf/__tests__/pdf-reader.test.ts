/**
 * Tests for PDF reader.
 *
 * Tests the entire reading pipeline: tokenizer, parser, document, text extraction,
 * image extraction, and metadata reading using roundtrip tests (write then read).
 */

import { cellSetValue } from "@excel/core/cell";
import { rowGetCell } from "@excel/core/worksheet";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { aesCbcDecrypt, sha256 } from "@utils/crypto";
import { describe, it, expect, beforeAll } from "vitest";

import { PdfDocumentBuilder } from "../builder/document-builder";
import { PdfStructureError } from "../errors";
import { excelToPdf } from "../excel-bridge";
import { pdf } from "../pdf";
import { CMap, parseCMap } from "../reader/cmap-parser";
import type { TextFragment } from "../reader/content-interpreter";
import { extractTextFromPage } from "../reader/content-interpreter";
import { resolveFont, decodeText } from "../reader/font-decoder";
import type { ResolvedFont } from "../reader/font-decoder";
import { decodeXmlEntities } from "../reader/metadata-reader";
import { PdfDocument } from "../reader/pdf-document";
import {
  parseObject,
  isPdfDict,
  isPdfRef,
  isPdfArray,
  decodePdfStringBytes
} from "../reader/pdf-parser";
import { readPdf } from "../reader/pdf-reader";
import { PdfTokenizer, TokenType } from "../reader/pdf-tokenizer";
import { reconstructText } from "../reader/text-reconstruction";

// =============================================================================
// Tokenizer Tests
// =============================================================================

describe("PdfTokenizer", () => {
  it("should tokenize numbers", () => {
    const data = new TextEncoder().encode("42 3.14 -7 +12");
    const tokenizer = new PdfTokenizer(data);

    let token = tokenizer.next();
    expect(token.type).toBe(TokenType.Number);
    expect(token.numValue).toBe(42);

    token = tokenizer.next();
    expect(token.type).toBe(TokenType.Number);
    expect(token.numValue).toBeCloseTo(3.14);

    token = tokenizer.next();
    expect(token.type).toBe(TokenType.Number);
    expect(token.numValue).toBe(-7);

    token = tokenizer.next();
    expect(token.type).toBe(TokenType.Number);
    expect(token.numValue).toBe(12);
  });

  it("should tokenize names", () => {
    const data = new TextEncoder().encode("/Name /Type /Font");
    const tokenizer = new PdfTokenizer(data);

    let token = tokenizer.next();
    expect(token.type).toBe(TokenType.Name);
    expect(token.strValue).toBe("Name");

    token = tokenizer.next();
    expect(token.type).toBe(TokenType.Name);
    expect(token.strValue).toBe("Type");

    token = tokenizer.next();
    expect(token.type).toBe(TokenType.Name);
    expect(token.strValue).toBe("Font");
  });

  it("should tokenize literal strings with escapes", () => {
    const data = new TextEncoder().encode("(Hello\\nWorld)");
    const tokenizer = new PdfTokenizer(data);

    const token = tokenizer.next();
    expect(token.type).toBe(TokenType.LiteralString);
    expect(token.rawBytes).toEqual(
      new Uint8Array([72, 101, 108, 108, 111, 10, 87, 111, 114, 108, 100])
    );
  });

  it("should tokenize nested parentheses in strings", () => {
    const data = new TextEncoder().encode("(a(b)c)");
    const tokenizer = new PdfTokenizer(data);

    const token = tokenizer.next();
    expect(token.type).toBe(TokenType.LiteralString);
    // Should contain a(b)c
    const text = new TextDecoder().decode(token.rawBytes);
    expect(text).toBe("a(b)c");
  });

  it("should tokenize hex strings", () => {
    const data = new TextEncoder().encode("<48656C6C6F>");
    const tokenizer = new PdfTokenizer(data);

    const token = tokenizer.next();
    expect(token.type).toBe(TokenType.HexString);
    expect(token.rawBytes).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  });

  it("should tokenize booleans", () => {
    const data = new TextEncoder().encode("true false");
    const tokenizer = new PdfTokenizer(data);

    let token = tokenizer.next();
    expect(token.type).toBe(TokenType.Boolean);
    expect(token.boolValue).toBe(true);

    token = tokenizer.next();
    expect(token.type).toBe(TokenType.Boolean);
    expect(token.boolValue).toBe(false);
  });

  it("should tokenize null", () => {
    const data = new TextEncoder().encode("null");
    const tokenizer = new PdfTokenizer(data);

    const token = tokenizer.next();
    expect(token.type).toBe(TokenType.Null);
  });

  it("should tokenize dict delimiters", () => {
    const data = new TextEncoder().encode("<< /Type /Page >>");
    const tokenizer = new PdfTokenizer(data);

    expect(tokenizer.next().type).toBe(TokenType.DictBegin);
    expect(tokenizer.next().type).toBe(TokenType.Name);
    expect(tokenizer.next().type).toBe(TokenType.Name);
    expect(tokenizer.next().type).toBe(TokenType.DictEnd);
  });

  it("should tokenize array delimiters", () => {
    const data = new TextEncoder().encode("[1 2 3]");
    const tokenizer = new PdfTokenizer(data);

    expect(tokenizer.next().type).toBe(TokenType.ArrayBegin);
    expect(tokenizer.next().type).toBe(TokenType.Number);
    expect(tokenizer.next().type).toBe(TokenType.Number);
    expect(tokenizer.next().type).toBe(TokenType.Number);
    expect(tokenizer.next().type).toBe(TokenType.ArrayEnd);
  });

  it("should skip comments", () => {
    const data = new TextEncoder().encode("42 % this is a comment\n99");
    const tokenizer = new PdfTokenizer(data);

    let token = tokenizer.next();
    expect(token.type).toBe(TokenType.Number);
    expect(token.numValue).toBe(42);

    token = tokenizer.next();
    expect(token.type).toBe(TokenType.Number);
    expect(token.numValue).toBe(99);
  });

  it("should tokenize keywords", () => {
    const data = new TextEncoder().encode("obj endobj stream endstream xref trailer startxref");
    const tokenizer = new PdfTokenizer(data);

    const keywords: string[] = [];
    let token = tokenizer.next();
    while (token.type !== TokenType.EOF) {
      expect(token.type).toBe(TokenType.Keyword);
      keywords.push(token.strValue!);
      token = tokenizer.next();
    }

    expect(keywords).toEqual([
      "obj",
      "endobj",
      "stream",
      "endstream",
      "xref",
      "trailer",
      "startxref"
    ]);
  });

  it("should handle name with hex escapes", () => {
    const data = new TextEncoder().encode("/Name#20With#20Spaces");
    const tokenizer = new PdfTokenizer(data);

    const token = tokenizer.next();
    expect(token.type).toBe(TokenType.Name);
    expect(token.strValue).toBe("Name With Spaces");
  });
});

// =============================================================================
// Object Parser Tests
// =============================================================================

describe("PDF Object Parser", () => {
  it("should parse dictionary", () => {
    const data = new TextEncoder().encode("<< /Type /Page /Width 612 /Height 792 >>");
    const tokenizer = new PdfTokenizer(data);
    const obj = parseObject(tokenizer);

    expect(isPdfDict(obj)).toBe(true);
    if (isPdfDict(obj)) {
      expect(obj.get("Type")).toBe("Page");
      expect(obj.get("Width")).toBe(612);
      expect(obj.get("Height")).toBe(792);
    }
  });

  it("should parse nested dictionary", () => {
    const data = new TextEncoder().encode("<< /Font << /F1 1 0 R >> >>");
    const tokenizer = new PdfTokenizer(data);
    const obj = parseObject(tokenizer);

    expect(isPdfDict(obj)).toBe(true);
    if (isPdfDict(obj)) {
      const font = obj.get("Font");
      expect(isPdfDict(font)).toBe(true);
    }
  });

  it("should parse indirect reference", () => {
    const data = new TextEncoder().encode("5 0 R");
    const tokenizer = new PdfTokenizer(data);
    const obj = parseObject(tokenizer);

    expect(isPdfRef(obj)).toBe(true);
    if (isPdfRef(obj)) {
      expect(obj.objNum).toBe(5);
      expect(obj.gen).toBe(0);
    }
  });

  it("should parse array", () => {
    const data = new TextEncoder().encode("[1 2 (hello) /Name]");
    const tokenizer = new PdfTokenizer(data);
    const obj = parseObject(tokenizer);

    expect(isPdfArray(obj)).toBe(true);
    if (isPdfArray(obj)) {
      expect(obj.length).toBe(4);
      expect(obj[0]).toBe(1);
      expect(obj[1]).toBe(2);
      expect(obj[2]).toBeInstanceOf(Uint8Array);
      expect(obj[3]).toBe("Name");
    }
  });
});

// =============================================================================
// String Decoding Tests
// =============================================================================

describe("PDF String Decoding", () => {
  it("should decode ASCII string", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    expect(decodePdfStringBytes(bytes)).toBe("Hello");
  });

  it("should decode UTF-16BE string", () => {
    const bytes = new Uint8Array([
      0xfe, 0xff, 0x00, 0x48, 0x00, 0x65, 0x00, 0x6c, 0x00, 0x6c, 0x00, 0x6f
    ]);
    expect(decodePdfStringBytes(bytes)).toBe("Hello");
  });

  it("should decode CJK characters from UTF-16BE", () => {
    // "中文" in UTF-16BE: FE FF 4E 2D 65 87
    const bytes = new Uint8Array([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]);
    expect(decodePdfStringBytes(bytes)).toBe("中文");
  });
});

// =============================================================================
// CMap Parser Tests
// =============================================================================

describe("CMap Parser", () => {
  it("should parse bfchar mappings", () => {
    const cmapData = new TextEncoder().encode(
      "/CIDInit /ProcSet findresource begin\n" +
        "12 dict begin\n" +
        "begincmap\n" +
        "/CMapType 2 def\n" +
        "1 begincodespacerange\n" +
        "<0000> <FFFF>\n" +
        "endcodespacerange\n" +
        "2 beginbfchar\n" +
        "<0001> <0048>\n" +
        "<0002> <0065>\n" +
        "endbfchar\n" +
        "endcmap\n"
    );

    const cmap = parseCMap(cmapData);
    expect(cmap.lookup(0x0001)).toBe("H");
    expect(cmap.lookup(0x0002)).toBe("e");
  });

  it("should parse bfrange mappings", () => {
    const cmapData = new TextEncoder().encode(
      "1 begincodespacerange\n" +
        "<00> <FF>\n" +
        "endcodespacerange\n" +
        "1 beginbfrange\n" +
        "<41> <5A> <0041>\n" +
        "endbfrange\n"
    );

    const cmap = parseCMap(cmapData);
    expect(cmap.lookup(0x41)).toBe("A");
    expect(cmap.lookup(0x42)).toBe("B");
    expect(cmap.lookup(0x5a)).toBe("Z");
  });

  it("should handle CJK character ranges", () => {
    const cmapData = new TextEncoder().encode(
      "1 begincodespacerange\n" +
        "<0000> <FFFF>\n" +
        "endcodespacerange\n" +
        "1 beginbfchar\n" +
        "<0001> <4E2D>\n" +
        "endbfchar\n"
    );

    const cmap = parseCMap(cmapData);
    expect(cmap.lookup(0x0001)).toBe("中");
  });
});

// =============================================================================
// Text Reconstruction Tests
// =============================================================================

describe("Text Reconstruction", () => {
  it("should sort fragments into reading order", () => {
    const fragments: TextFragment[] = [
      {
        text: "World",
        x: 100,
        y: 700,
        fontSize: 12,
        fontName: "F1",
        width: 50,
        charSpacing: 0,
        wordSpacing: 0,
        horizontalScaling: 100,
        isVertical: false,
        isRtl: false
      },
      {
        text: "Hello",
        x: 50,
        y: 700,
        fontSize: 12,
        fontName: "F1",
        width: 45,
        charSpacing: 0,
        wordSpacing: 0,
        horizontalScaling: 100,
        isVertical: false,
        isRtl: false
      }
    ];

    const text = reconstructText(fragments);
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text.indexOf("Hello")).toBeLessThan(text.indexOf("World"));
  });

  it("should group fragments into lines", () => {
    const fragments: TextFragment[] = [
      {
        text: "Line 1",
        x: 50,
        y: 700,
        fontSize: 12,
        fontName: "F1",
        width: 50,
        charSpacing: 0,
        wordSpacing: 0,
        horizontalScaling: 100,
        isVertical: false,
        isRtl: false
      },
      {
        text: "Line 2",
        x: 50,
        y: 685,
        fontSize: 12,
        fontName: "F1",
        width: 50,
        charSpacing: 0,
        wordSpacing: 0,
        horizontalScaling: 100,
        isVertical: false,
        isRtl: false
      }
    ];

    const text = reconstructText(fragments);
    const lines = text.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain("Line 1");
    expect(lines[1]).toContain("Line 2");
  });

  it("should insert spaces between fragments with gaps", () => {
    const fragments: TextFragment[] = [
      {
        text: "Hello",
        x: 50,
        y: 700,
        fontSize: 12,
        fontName: "F1",
        width: 30,
        charSpacing: 0,
        wordSpacing: 0,
        horizontalScaling: 100,
        isVertical: false,
        isRtl: false
      },
      {
        text: "World",
        x: 85,
        y: 700,
        fontSize: 12,
        fontName: "F1",
        width: 30,
        charSpacing: 0,
        wordSpacing: 0,
        horizontalScaling: 100,
        isVertical: false,
        isRtl: false
      }
    ];

    const text = reconstructText(fragments);
    expect(text).toContain("Hello");
    expect(text).toContain("World");
  });
});

// =============================================================================
// Roundtrip Tests (Write then Read)
// =============================================================================

describe("PDF Roundtrip (Write → Read)", () => {
  let simplePdf: Uint8Array;

  beforeAll(async () => {
    simplePdf = await pdf(
      [
        ["Name", "Score"],
        ["Alice", 95],
        ["Bob", 87]
      ],
      {
        title: "Test Document",
        author: "Test Author",
        showGridLines: true
      }
    );
  });

  it("should read a self-generated PDF without errors", async () => {
    const result = await readPdf(simplePdf);
    expect(result).toBeDefined();
    expect(result.pages.length).toBeGreaterThan(0);
  });

  it("should extract metadata", async () => {
    const result = await readPdf(simplePdf);
    expect(result.metadata).toBeDefined();
    expect(result.metadata.pdfVersion).toBe("2.0");
    expect(result.metadata.pageCount).toBeGreaterThan(0);
    expect(result.metadata.producer).toContain("documonster");
  });

  it("should extract page dimensions", async () => {
    const result = await readPdf(simplePdf);
    expect(result.pages[0].width).toBeGreaterThan(0);
    expect(result.pages[0].height).toBeGreaterThan(0);
  });

  it("should find fonts and content in page structure", () => {
    const doc = new PdfDocument(simplePdf);
    const pages = doc.getPages();
    expect(pages.length).toBeGreaterThan(0);

    const pageDict = pages[0];
    const resources = pageDict.get("Resources");
    expect(resources).toBeDefined();

    const resolvedResources = doc.derefDict(resources);
    expect(resolvedResources).not.toBeNull();

    if (resolvedResources) {
      const fontObj = resolvedResources.get("Font");
      expect(fontObj).toBeDefined();

      const fontDict = doc.derefDict(fontObj);
      expect(fontDict).not.toBeNull();
      if (fontDict) {
        expect(fontDict.size).toBeGreaterThan(0);
        for (const [_name, ref] of fontDict) {
          const fd = doc.derefDict(ref);
          expect(fd).not.toBeNull();
          if (fd) {
            const rf = resolveFont(fd, doc);
            expect(rf.subtype).toBeDefined();
          }
        }
      }
    }

    // Check content stream
    const contents = pageDict.get("Contents");
    expect(contents).toBeDefined();
    const stream = doc.derefStream(contents);
    expect(stream).not.toBeNull();
    if (stream) {
      // Check that the stream dict has Filter
      const filter = stream.dict.get("Filter");
      expect(filter).toBe("FlateDecode");

      // Check that getStreamData decodes properly
      const data = doc.getStreamData(stream);
      expect(data.length).toBeGreaterThan(0);
      const text = new TextDecoder().decode(data);
      expect(text).toContain("BT");
    }

    // Now extract text
    const fragments = extractTextFromPage(pageDict, doc);
    expect(fragments.length).toBeGreaterThan(0);
  });

  it("should extract text from self-generated PDF", async () => {
    const result = await readPdf(simplePdf);
    const text = result.text;
    // The text should contain our data values
    expect(text).toContain("Name");
    expect(text).toContain("Score");
    expect(text).toContain("Alice");
    expect(text).toContain("95");
    expect(text).toContain("Bob");
    expect(text).toContain("87");
  });

  it("should handle multi-sheet PDF", async () => {
    const multiSheetPdf = await pdf({
      title: "Multi-Sheet",
      sheets: [
        {
          name: "Sheet1",
          data: [
            ["A1", "B1"],
            ["A2", "B2"]
          ]
        },
        {
          name: "Sheet2",
          data: [
            ["C1", "D1"],
            ["C2", "D2"]
          ]
        }
      ]
    });

    const result = await readPdf(multiSheetPdf);
    expect(result.pages.length).toBeGreaterThanOrEqual(2);
    expect(result.text).toContain("A1");
    expect(result.text).toContain("C1");
  });

  it("should support selective page extraction", async () => {
    const multiSheetPdf = await pdf({
      sheets: [
        { name: "Sheet1", data: [["Page1"]] },
        { name: "Sheet2", data: [["Page2"]] },
        { name: "Sheet3", data: [["Page3"]] }
      ]
    });

    const result = await readPdf(multiSheetPdf, { pages: [1, 3] });
    expect(result.pages.length).toBe(2);
    expect(result.pages[0].pageNumber).toBe(1);
    expect(result.pages[1].pageNumber).toBe(3);
  });

  it("should support text-only extraction", async () => {
    const result = await readPdf(simplePdf, { extractImages: false });
    expect(result.text).toBeTruthy();
    expect(result.pages[0].images.length).toBe(0);
  });

  it("should support metadata-only extraction", async () => {
    const result = await readPdf(simplePdf, { extractText: false, extractImages: false });
    expect(result.metadata).toBeDefined();
    expect(result.pages[0].text).toBe("");
  });
});

// =============================================================================
// PDF with Styled Content
// =============================================================================

describe("PDF Reader - Styled Content", () => {
  it("should extract text from styled cells", async () => {
    const styledPdf = await pdf([
      [
        { value: "Bold", bold: true },
        { value: "Italic", italic: true },
        { value: "Colored", fontColor: "FFFF0000" }
      ],
      ["Normal", "Text", "Here"]
    ]);

    const result = await readPdf(styledPdf);
    expect(result.text).toContain("Bold");
    expect(result.text).toContain("Italic");
    expect(result.text).toContain("Normal");
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("PDF Reader - Edge Cases", () => {
  it("should handle empty PDF", async () => {
    const emptyPdf = await pdf([[]]);
    const result = await readPdf(emptyPdf);
    expect(result.pages.length).toBeGreaterThanOrEqual(0);
  });

  it("should handle single-cell PDF", async () => {
    const singleCellPdf = await pdf([["Hello"]]);
    const result = await readPdf(singleCellPdf);
    expect(result.text).toContain("Hello");
  });

  it("should handle numbers and dates", async () => {
    const dataPdf = await pdf([
      ["Integer", 42],
      ["Float", 3.14],
      ["Boolean", true]
    ]);

    const result = await readPdf(dataPdf);
    expect(result.text).toContain("42");
    expect(result.text).toContain("3.14");
    expect(result.text).toContain("TRUE");
  });
});

// =============================================================================
// Metadata Tests
// =============================================================================

describe("PDF Reader - Metadata", () => {
  it("should extract title and author", async () => {
    const pdfBytes = await pdf([["Test"]], {
      title: "My Title",
      author: "My Author",
      subject: "My Subject"
    });

    const result = await readPdf(pdfBytes);
    expect(result.metadata.title).toBe("My Title");
    expect(result.metadata.author).toBe("My Author");
    expect(result.metadata.subject).toBe("My Subject");
  });

  it("should detect PDF version", async () => {
    const pdfBytes = await pdf([["Test"]]);
    const result = await readPdf(pdfBytes);
    expect(result.metadata.pdfVersion).toBe("2.0");
  });

  it("should report page count", async () => {
    const pdfBytes = await pdf({
      sheets: [
        { name: "S1", data: [["A"]] },
        { name: "S2", data: [["B"]] }
      ]
    });

    const result = await readPdf(pdfBytes);
    expect(result.metadata.pageCount).toBeGreaterThanOrEqual(2);
  });

  it("should report page size", async () => {
    const pdfBytes = await pdf([["Test"]]);
    const result = await readPdf(pdfBytes);
    expect(result.metadata.pageSize).toBeDefined();
    if (result.metadata.pageSize) {
      expect(result.metadata.pageSize.width).toBeGreaterThan(0);
      expect(result.metadata.pageSize.height).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// XML Entity Decoding (regression: no double-unescaping)
// =============================================================================

describe("decodeXmlEntities", () => {
  it("should decode basic XML entities", () => {
    expect(decodeXmlEntities("a &amp; b")).toBe("a & b");
    expect(decodeXmlEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeXmlEntities("&quot;hello&quot;")).toBe('"hello"');
    expect(decodeXmlEntities("it&apos;s")).toBe("it's");
  });

  it("should not double-unescape &amp;lt; into <", () => {
    // &amp;lt; should become &lt; (not <)
    expect(decodeXmlEntities("&amp;lt;tag&amp;gt;")).toBe("&lt;tag&gt;");
  });

  it("should not double-unescape &amp;amp; into &", () => {
    // &amp;amp; should become &amp; (not &)
    expect(decodeXmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("should not double-unescape &amp;quot; into a quote", () => {
    expect(decodeXmlEntities("&amp;quot;")).toBe("&quot;");
  });

  it("should handle text with no entities", () => {
    expect(decodeXmlEntities("plain text")).toBe("plain text");
  });
});

// =============================================================================
// Image Helpers (duplicated from pdf-exporter.test.ts to avoid cross-test deps)
// =============================================================================

function buildMinimalJpeg(): Uint8Array {
  // prettier-ignore
  return new Uint8Array([
    0xFF, 0xD8,             // SOI
    0xFF, 0xE0,             // APP0
    0x00, 0x10,             // length = 16
    0x4A, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01,             // version 1.1
    0x00,                   // aspect ratio
    0x00, 0x01, 0x00, 0x01, // 1x1 pixel density
    0x00, 0x00,             // no thumbnail
    0xFF, 0xDB,             // DQT
    0x00, 0x43,             // length = 67
    0x00,                   // table 0, 8-bit precision
    // 64 quantization values (all 1s for simplicity)
    ...Array.from({ length: 64 }, () => 0x01),
    0xFF, 0xC0,             // SOF0 (baseline)
    0x00, 0x0B,             // length = 11
    0x08,                   // 8-bit precision
    0x00, 0x01,             // height = 1
    0x00, 0x01,             // width = 1
    0x01,                   // 1 component
    0x01,                   // component ID = 1
    0x11,                   // H/V sampling = 1x1
    0x00,                   // quant table 0
    0xFF, 0xC4,             // DHT
    0x00, 0x1F,             // length = 31
    0x00,                   // DC table 0
    // Number of codes of each length (1-16)
    0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    // Values
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
    0xFF, 0xDA,             // SOS
    0x00, 0x08,             // length = 8
    0x01,                   // 1 component
    0x01,                   // component 1
    0x00,                   // DC/AC table 0/0
    0x00, 0x3F, 0x00,       // spectral selection
    0x7B, 0x40,             // scan data (minimal)
    0xFF, 0xD9              // EOI
  ]);
}

function buildMinimalPng(): Uint8Array {
  const parts: number[] = [];
  // PNG signature
  parts.push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  // IHDR
  const ihdr = [
    0x00,
    0x00,
    0x00,
    0x02, // width = 2
    0x00,
    0x00,
    0x00,
    0x02, // height = 2
    0x08, // bit depth = 8
    0x06, // color type = 6 (RGBA)
    0x00,
    0x00,
    0x00 // compression, filter, interlace
  ];
  writeChunk(parts, "IHDR", ihdr);

  // IDAT — raw pixel data
  const rawPixels = [
    0x00,
    0xff,
    0x00,
    0x00,
    0xff,
    0x00,
    0xff,
    0x00,
    0x80, // row 1
    0x00,
    0x00,
    0x00,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0x00 // row 2
  ];
  const deflated = deflateStored(rawPixels);
  writeChunk(parts, "IDAT", Array.from(deflated));
  writeChunk(parts, "IEND", []);
  return new Uint8Array(parts);
}

function writeChunk(buf: number[], type: string, data: number[]): void {
  const len = data.length;
  buf.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  for (let i = 0; i < 4; i++) {
    buf.push(type.charCodeAt(i));
  }
  buf.push(...data);
  const crcInput = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) {
    crcInput[i] = type.charCodeAt(i);
  }
  for (let i = 0; i < data.length; i++) {
    crcInput[4 + i] = data[i];
  }
  const crc = crc32Png(crcInput);
  buf.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
}

function crc32Png(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function deflateStored(data: number[]): Uint8Array {
  const len = data.length;
  const result = [0x78, 0x01];
  result.push(0x01);
  result.push(len & 0xff, (len >>> 8) & 0xff);
  result.push(~len & 0xff, (~len >>> 8) & 0xff);
  result.push(...data);
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  result.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return new Uint8Array(result);
}

// =============================================================================
// Encrypted PDF Roundtrip Tests
// =============================================================================

describe("PDF Reader - Encryption Roundtrip", () => {
  let encryptedWithUserPw: Uint8Array;
  let encryptedOwnerOnly: Uint8Array;

  beforeAll(async () => {
    // Create encrypted PDF with both user and owner passwords
    encryptedWithUserPw = await pdf(
      [
        ["Secret", "Data"],
        ["Alice", 42],
        ["Bob", 99]
      ],
      {
        title: "Encrypted Doc",
        author: "Test Author",
        encryption: {
          ownerPassword: "owner123",
          userPassword: "user456"
        }
      }
    );

    // Create encrypted PDF with owner password only (empty user password)
    encryptedOwnerOnly = await pdf(
      [
        ["Public", "Info"],
        ["Row1", 100]
      ],
      {
        title: "Owner Only",
        encryption: { ownerPassword: "ownerSecret" }
      }
    );
  });

  it("should read encrypted PDF with correct user password", async () => {
    const result = await readPdf(encryptedWithUserPw, { password: "user456" });
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.text).toContain("Secret");
    expect(result.text).toContain("Data");
    expect(result.text).toContain("Alice");
    expect(result.text).toContain("42");
  });

  it("should read encrypted PDF with owner password", async () => {
    const result = await readPdf(encryptedWithUserPw, { password: "owner123" });
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.text).toContain("Secret");
    expect(result.text).toContain("Bob");
    expect(result.text).toContain("99");
  });

  it("should throw on wrong password", async () => {
    await expect(readPdf(encryptedWithUserPw, { password: "wrongPassword" })).rejects.toThrow(
      PdfStructureError
    );
  });

  it("should read owner-only encrypted PDF with empty password", async () => {
    // When there is no user password, the empty password should work
    const result = await readPdf(encryptedOwnerOnly, { password: "" });
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.text).toContain("Public");
    expect(result.text).toContain("Info");
  });

  it("should read owner-only encrypted PDF without providing password", async () => {
    // Default password is "" so this should also work
    const result = await readPdf(encryptedOwnerOnly);
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.text).toContain("Public");
  });

  it("should read owner-only encrypted PDF with owner password", async () => {
    const result = await readPdf(encryptedOwnerOnly, { password: "ownerSecret" });
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.text).toContain("Public");
  });

  it("should report encrypted status in metadata", async () => {
    const result = await readPdf(encryptedWithUserPw, { password: "user456" });
    expect(result.metadata.encrypted).toBe(true);
  });

  it("should extract metadata from encrypted PDF", async () => {
    const result = await readPdf(encryptedWithUserPw, { password: "user456" });
    expect(result.metadata.title).toBe("Encrypted Doc");
    expect(result.metadata.author).toBe("Test Author");
  });

  it("should report non-encrypted for unencrypted PDFs", async () => {
    const plainPdf = await pdf([["Hello"]]);
    const result = await readPdf(plainPdf);
    expect(result.metadata.encrypted).toBe(false);
  });
});

// =============================================================================
// Encrypted PDF via excelToPdf (different path)
// =============================================================================

describe("PDF Reader - Encryption via excelToPdf", () => {
  it("should roundtrip encrypted Excel-to-PDF", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Secrets");
    Cell.setValue(ws, "A1", "Confidential");
    Cell.setValue(ws, "B1", 12345);
    Cell.setValue(ws, "A2", "TopSecret");
    Cell.setValue(ws, "B2", 67890);

    const encrypted = await excelToPdf(wb, {
      encryption: { ownerPassword: "owner", userPassword: "user" }
    });

    const result = await readPdf(encrypted, { password: "user" });
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.text).toContain("Confidential");
    expect(result.text).toContain("12345");
    expect(result.text).toContain("TopSecret");
    expect(result.text).toContain("67890");
    expect(result.metadata.encrypted).toBe(true);
  });
});

// =============================================================================
// Image Extraction Roundtrip Tests
// =============================================================================

describe("PDF Reader - Image Extraction", () => {
  it("should extract JPEG image from roundtrip PDF", async () => {
    const jpegData = buildMinimalJpeg();
    const pdfBytes = await pdf({
      data: [["Image Test"]],
      images: [{ data: jpegData, format: "jpeg", col: 0, row: 1, width: 100, height: 80 }]
    });

    const result = await readPdf(pdfBytes);
    expect(result.pages.length).toBeGreaterThan(0);

    const page = result.pages[0];
    expect(page.images.length).toBeGreaterThanOrEqual(1);

    const img = page.images[0];
    expect(img.format).toBe("jpeg");
    expect(img.width).toBe(1); // Actual pixel dimensions from JPEG header
    expect(img.height).toBe(1);
    // JPEG is embedded as-is, so data should be identical
    expect(img.data).toEqual(jpegData);
  });

  it("should extract PNG image as raw pixels from roundtrip PDF", async () => {
    const pngData = buildMinimalPng();
    const pdfBytes = await pdf({
      data: [["PNG Test"]],
      images: [{ data: pngData, format: "png", col: 0, row: 1, width: 100, height: 80 }]
    });

    const result = await readPdf(pdfBytes);
    expect(result.pages.length).toBeGreaterThan(0);

    const page = result.pages[0];
    expect(page.images.length).toBeGreaterThanOrEqual(1);

    const img = page.images[0];
    // PNG is decoded to raw RGB during writing, so format will be "raw"
    expect(img.format).toBe("raw");
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(img.data.length).toBeGreaterThan(0);
  });

  it("should extract alpha mask (SMask) from PNG with transparency", async () => {
    const pngData = buildMinimalPng();
    const pdfBytes = await pdf({
      data: [["Alpha Test"]],
      images: [{ data: pngData, format: "png", col: 0, row: 1, width: 100, height: 80 }]
    });

    const result = await readPdf(pdfBytes);
    const page = result.pages[0];
    expect(page.images.length).toBeGreaterThanOrEqual(1);

    const img = page.images[0];
    // Our test PNG has alpha channel, so SMask should be present
    expect(img.alphaMask).not.toBeNull();
    if (img.alphaMask) {
      expect(img.alphaMask.length).toBeGreaterThan(0);
    }
  });

  it("should report image color space and components", async () => {
    const jpegData = buildMinimalJpeg();
    const pdfBytes = await pdf({
      data: [["Color Test"]],
      images: [{ data: jpegData, format: "jpeg", col: 0, row: 1, width: 50, height: 50 }]
    });

    const result = await readPdf(pdfBytes);
    const img = result.pages[0].images[0];
    expect(img.colorSpace).toBeDefined();
    expect(img.bitsPerComponent).toBeGreaterThan(0);
  });

  it("should skip image extraction when extractImages is false", async () => {
    const jpegData = buildMinimalJpeg();
    const pdfBytes = await pdf({
      data: [["Skip Test"]],
      images: [{ data: jpegData, format: "jpeg", col: 0, row: 1, width: 50, height: 50 }]
    });

    const result = await readPdf(pdfBytes, { extractImages: false });
    expect(result.pages[0].images.length).toBe(0);
    // But text should still be extracted
    expect(result.text).toContain("Skip Test");
  });

  it("should extract images from encrypted PDF", async () => {
    const jpegData = buildMinimalJpeg();
    const pdfBytes = await pdf(
      {
        data: [["Encrypted Image"]],
        images: [{ data: jpegData, format: "jpeg", col: 0, row: 1, width: 100, height: 80 }]
      },
      { encryption: { ownerPassword: "owner", userPassword: "user" } }
    );

    const result = await readPdf(pdfBytes, { password: "user" });
    expect(result.pages[0].images.length).toBeGreaterThanOrEqual(1);

    const img = result.pages[0].images[0];
    expect(img.format).toBe("jpeg");
    // After decryption, the JPEG data should be recovered
    expect(img.data).toEqual(jpegData);
  });

  it("should handle multiple images on one page", async () => {
    const jpeg1 = buildMinimalJpeg();
    const jpeg2 = buildMinimalJpeg();
    const pdfBytes = await pdf({
      data: [["Multi Image"]],
      images: [
        { data: jpeg1, format: "jpeg", col: 0, row: 1, width: 50, height: 50 },
        { data: jpeg2, format: "jpeg", col: 2, row: 1, width: 50, height: 50 }
      ]
    });

    const result = await readPdf(pdfBytes);
    expect(result.pages[0].images.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Multilingual Text Extraction Tests
// =============================================================================

describe("PDF Reader - Multilingual Text", () => {
  it("should extract ASCII text correctly", async () => {
    const pdfBytes = await pdf([
      ["Hello", "World"],
      ["Foo", "Bar"]
    ]);
    const result = await readPdf(pdfBytes);
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("World");
    expect(result.text).toContain("Foo");
    expect(result.text).toContain("Bar");
  });

  it("should extract numeric values correctly", async () => {
    const pdfBytes = await pdf([
      ["Amount", 1234567.89],
      ["Count", -42]
    ]);
    const result = await readPdf(pdfBytes);
    expect(result.text).toContain("1234567.89");
    expect(result.text).toContain("-42");
  });

  it("should extract boolean values", async () => {
    const pdfBytes = await pdf([
      ["Active", true],
      ["Deleted", false]
    ]);
    const result = await readPdf(pdfBytes);
    expect(result.text).toContain("TRUE");
    expect(result.text).toContain("FALSE");
  });

  it("should extract accented European characters", async () => {
    // These characters are in WinAnsiEncoding range, should work with standard fonts
    const pdfBytes = await pdf([["Name"], ["Caf\u00e9"], ["R\u00e9sum\u00e9"]]);
    const result = await readPdf(pdfBytes);
    // At minimum we should get the base ASCII parts
    expect(result.text).toContain("Name");
    expect(result.text).toContain("Caf");
    expect(result.text).toContain("sum");
  });
});

// =============================================================================
// Text Reconstruction Tests
// =============================================================================

describe("PDF Reader - Text Reconstruction", () => {
  it("should reconstruct text lines from fragments", async () => {
    const pdfBytes = await pdf([
      ["First", "Second"],
      ["Third", "Fourth"]
    ]);
    const result = await readPdf(pdfBytes);

    // textLines should provide structured line data
    const page = result.pages[0];
    expect(page.textLines.length).toBeGreaterThan(0);

    // Each line should have text and position info
    for (const line of page.textLines) {
      expect(line.text).toBeDefined();
      expect(typeof line.y).toBe("number");
    }
  });

  it("should preserve textFragments with position data", async () => {
    const pdfBytes = await pdf([["Positioned", "Text"]]);
    const result = await readPdf(pdfBytes);

    const page = result.pages[0];
    expect(page.textFragments.length).toBeGreaterThan(0);

    for (const frag of page.textFragments) {
      expect(typeof frag.x).toBe("number");
      expect(typeof frag.y).toBe("number");
      expect(typeof frag.fontSize).toBe("number");
      expect(frag.fontSize).toBeGreaterThan(0);
      expect(frag.text.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Fault Tolerance Tests
// =============================================================================

describe("PDF Reader - Fault Tolerance", () => {
  it("should throw PdfStructureError on invalid data", async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    await expect(readPdf(garbage)).rejects.toThrow(PdfStructureError);
  });

  it("should throw PdfStructureError on empty data", async () => {
    await expect(readPdf(new Uint8Array(0))).rejects.toThrow(PdfStructureError);
  });

  it("should throw on truncated PDF", async () => {
    const validPdf = await pdf([["Hello"]]);
    // Truncate to half
    const truncated = validPdf.subarray(0, Math.floor(validPdf.length / 2));
    await expect(readPdf(truncated)).rejects.toThrow(PdfStructureError);
  });

  it("should include warnings array on every page", async () => {
    const pdfBytes = await pdf([["Test"]]);
    const result = await readPdf(pdfBytes);
    for (const page of result.pages) {
      expect(Array.isArray(page.warnings)).toBe(true);
    }
  });

  it("should handle PDF with no pages gracefully", async () => {
    // Minimal PDF that we can parse but has unusual structure
    const pdfBytes = await pdf([[]]);
    const result = await readPdf(pdfBytes);
    // Should not throw; may have 0 or more pages depending on writer behavior
    expect(result).toBeDefined();
    expect(Array.isArray(result.pages)).toBe(true);
  });

  it("should handle very large cell values", async () => {
    const longText = "A".repeat(10000);
    const pdfBytes = await pdf([[longText]]);
    const result = await readPdf(pdfBytes);
    // Should extract at least some portion of the long text
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("should handle special characters in cell values", async () => {
    const pdfBytes = await pdf([["<>&\"'"], ["Tab\there"], ["Line\nbreak"]]);
    const result = await readPdf(pdfBytes);
    expect(result.pages.length).toBeGreaterThan(0);
    // At minimum the PDF should parse without throwing
  });

  it("should handle many pages", async () => {
    const sheets = Array.from({ length: 10 }, (_, i) => ({
      name: `Sheet${i + 1}`,
      data: [[`Page ${i + 1} content`]] as (string | number)[][]
    }));
    const pdfBytes = await pdf({ sheets });
    const result = await readPdf(pdfBytes);
    expect(result.pages.length).toBeGreaterThanOrEqual(10);
  });
});

// =============================================================================
// Selective Extraction Tests
// =============================================================================

describe("PDF Reader - Selective Extraction", () => {
  it("should extract only text when images disabled", async () => {
    const pdfBytes = await pdf([["Text Only"]]);
    const result = await readPdf(pdfBytes, { extractImages: false });
    expect(result.text).toContain("Text Only");
    expect(result.pages[0].images).toEqual([]);
  });

  it("should extract only metadata when text and images disabled", async () => {
    const pdfBytes = await pdf([["Metadata Only"]], { title: "My Doc" });
    const result = await readPdf(pdfBytes, {
      extractText: false,
      extractImages: false,
      extractMetadata: true
    });
    expect(result.metadata.title).toBe("My Doc");
    expect(result.pages[0].text).toBe("");
    expect(result.pages[0].images).toEqual([]);
  });

  it("should skip metadata when extractMetadata is false", async () => {
    const pdfBytes = await pdf([["No Metadata"]], { title: "Hidden" });
    const result = await readPdf(pdfBytes, { extractMetadata: false });
    // Metadata should be empty/default
    expect(result.metadata.title).toBe("");
    expect(result.text).toContain("No Metadata");
  });

  it("should respect page selection with encryption", async () => {
    const pdfBytes = await pdf(
      {
        sheets: [
          { name: "S1", data: [["Page1Content"]] },
          { name: "S2", data: [["Page2Content"]] },
          { name: "S3", data: [["Page3Content"]] }
        ]
      },
      { encryption: { ownerPassword: "owner" } }
    );

    const result = await readPdf(pdfBytes, { pages: [2] });
    expect(result.pages.length).toBe(1);
    expect(result.pages[0].pageNumber).toBe(2);
    expect(result.text).toContain("Page2Content");
    expect(result.text).not.toContain("Page1Content");
    expect(result.text).not.toContain("Page3Content");
  });
});

// =============================================================================
// Structural Robustness Tests
// =============================================================================

describe("PDF Reader - Structural Robustness", () => {
  it("should resolve page dimensions correctly from roundtrip PDF", async () => {
    const pdfBytes = await pdf([["Dimension Test"]], { pageSize: "A4" });
    const result = await readPdf(pdfBytes);
    const page = result.pages[0];
    // A4 = 595.28 x 841.89 points (approximately)
    expect(page.width).toBeGreaterThan(500);
    expect(page.width).toBeLessThan(700);
    expect(page.height).toBeGreaterThan(750);
    expect(page.height).toBeLessThan(900);
  });

  it("should resolve page dimensions consistently between page and metadata", async () => {
    const pdfBytes = await pdf([["Consistency Test"]]);
    const result = await readPdf(pdfBytes);
    const page = result.pages[0];
    const metaSize = result.metadata.pageSize;
    expect(metaSize).not.toBeNull();
    if (metaSize) {
      expect(page.width).toBe(metaSize.width);
      expect(page.height).toBe(metaSize.height);
    }
  });

  it("should handle landscape orientation page dimensions", async () => {
    const pdfBytes = await pdf([["Landscape"]], { orientation: "landscape" });
    const result = await readPdf(pdfBytes);
    const page = result.pages[0];
    // Landscape: width > height
    expect(page.width).toBeGreaterThan(page.height);
  });

  it("should resolve page resources for text extraction on all pages", async () => {
    const pdfBytes = await pdf({
      sheets: [
        { name: "S1", data: [["TextA"]] },
        { name: "S2", data: [["TextB"]] }
      ]
    });
    const result = await readPdf(pdfBytes);
    // Both pages should have extracted text (proving resource resolution works)
    expect(result.pages[0].text).toContain("TextA");
    expect(result.pages[1].text).toContain("TextB");
  });

  it("should use getPagesWithObjInfo for correct page identity", async () => {
    // Encrypted multi-page PDF — if page objNum is wrong, decryption will fail
    const pdfBytes = await pdf(
      {
        sheets: [
          { name: "S1", data: [["EncryptedPage1"]] },
          { name: "S2", data: [["EncryptedPage2"]] },
          { name: "S3", data: [["EncryptedPage3"]] }
        ]
      },
      { encryption: { ownerPassword: "owner", userPassword: "user" } }
    );
    const result = await readPdf(pdfBytes, { password: "user" });
    expect(result.pages.length).toBeGreaterThanOrEqual(3);
    expect(result.text).toContain("EncryptedPage1");
    expect(result.text).toContain("EncryptedPage2");
    expect(result.text).toContain("EncryptedPage3");
  });
});

// =============================================================================
// Crypto Primitive Verification (NIST test vectors)
// =============================================================================

/** Convert hex string to Uint8Array */
function hex(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(s.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

describe("AES-CBC Decrypt — NIST SP 800-38A test vectors", () => {
  it("AES-128-CBC: should decrypt NIST F.2.2 vector correctly", () => {
    // NIST SP 800-38A, Section F.2.2 — CBC-AES128.Decrypt
    const key = hex("2b7e151628aed2a6abf7158809cf4f3c");
    const iv = hex("000102030405060708090a0b0c0d0e0f");
    const ciphertext = hex(
      "7649abac8119b246cee98e9b12e9197d" +
        "5086cb9b507219ee95db113a917678b2" +
        "73bed6b8e3c1743b7116e69e22229516" +
        "3ff1caa1681fac09120eca307586e1a7"
    );
    const expected = hex(
      "6bc1bee22e409f96e93d7e117393172a" +
        "ae2d8a571e03ac9c9eb76fac45af8e51" +
        "30c81c46a35ce411e5fbc1191a0a52ef" +
        "f69f2445df4f9b17ad2b417be66c3710"
    );

    // aesCbcDecrypt has PKCS#7 padding removal, but here the plaintext is not
    // PKCS#7 padded (last byte 0x10 but remaining bytes don't match), so the
    // full 64 bytes are returned — which is correct for NIST test vectors.
    const result = aesCbcDecrypt(ciphertext, key, iv);
    expect(result.length).toBe(64);
    expect(result).toEqual(expected);
  });

  it("AES-256-CBC: should decrypt NIST F.2.6 vector correctly", () => {
    // NIST SP 800-38A, Section F.2.6 — CBC-AES256.Decrypt
    const key = hex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4");
    const iv = hex("000102030405060708090a0b0c0d0e0f");
    const ciphertext = hex(
      "f58c4c04d6e5f1ba779eabfb5f7bfbd6" +
        "9cfc4e967edb808d679f777bc6702c7d" +
        "39f23369a9d9bacfa530e26304231461" +
        "b2eb05e2c39be9fcda6c19078c6a9d1b"
    );
    const expected = hex(
      "6bc1bee22e409f96e93d7e117393172a" +
        "ae2d8a571e03ac9c9eb76fac45af8e51" +
        "30c81c46a35ce411e5fbc1191a0a52ef" +
        "f69f2445df4f9b17ad2b417be66c3710"
    );

    const result = aesCbcDecrypt(ciphertext, key, iv);
    expect(result.length).toBe(64);
    expect(result).toEqual(expected);
  });

  it("AES-128-CBC: should handle single block", () => {
    // First block only from NIST F.2.2
    const key = hex("2b7e151628aed2a6abf7158809cf4f3c");
    const iv = hex("000102030405060708090a0b0c0d0e0f");
    const ciphertext = hex("7649abac8119b246cee98e9b12e9197d");
    const expected = hex("6bc1bee22e409f96e93d7e117393172a");

    const result = aesCbcDecrypt(ciphertext, key, iv);
    // Last byte is 0x2a — not valid PKCS#7 padding for 16-byte block, so no stripping
    expect(result).toEqual(expected);
  });
});

describe("SHA-256 — NIST FIPS 180-4 test vectors", () => {
  it("should hash 'abc' correctly", () => {
    // NIST FIPS 180-4, Section B.1 — SHA-256("abc")
    const input = new TextEncoder().encode("abc");
    const expected = hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(input)).toEqual(expected);
  });

  it("should hash empty string correctly", () => {
    // SHA-256("")
    const input = new Uint8Array(0);
    const expected = hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256(input)).toEqual(expected);
  });

  it("should hash two-block message correctly", () => {
    // NIST FIPS 180-4, Section B.2 — SHA-256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
    const input = new TextEncoder().encode(
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
    );
    const expected = hex("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256(input)).toEqual(expected);
  });
});

// =============================================================================
// Hand-crafted PDF Fixture Tests
// =============================================================================

/**
 * Build a minimal valid PDF from a string template.
 * Ensures proper byte representation for the parser.
 */
function pdfFromString(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

describe("PDF Reader - Indirect MediaBox", () => {
  it("should resolve page dimensions from an indirect MediaBox reference", async () => {
    // Hand-crafted PDF where the page's /MediaBox is an indirect reference (obj 5)
    // instead of a direct array. This tests that resolvePageBox() derefs properly.
    //
    // Object layout:
    //   1 0 obj: Catalog  → /Pages 2 0 R
    //   2 0 obj: Pages    → /Kids [3 0 R] /Count 1
    //   3 0 obj: Page     → /MediaBox 5 0 R  (indirect!)
    //   4 0 obj: empty content stream
    //   5 0 obj: [0 0 200 100]  (the actual MediaBox array)
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox 5 0 R /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj [0 0 200 100] endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000206 00000 n ",
      "0000000256 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "289",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.pages.length).toBe(1);
    expect(result.pages[0].width).toBe(200);
    expect(result.pages[0].height).toBe(100);
    // Metadata page size should match
    expect(result.metadata.pageSize).toEqual({ width: 200, height: 100 });
  });
});

describe("PDF Reader - Form XObject Recursion Guard", () => {
  it("should not stack overflow on self-referencing Form XObject", async () => {
    // Hand-crafted PDF where a Form XObject's content stream references itself
    // via the Do operator: /XObj1 Do. This would infinite-recurse without the
    // MAX_FORM_DEPTH guard.
    //
    // Object layout:
    //   1 0 obj: Catalog
    //   2 0 obj: Pages
    //   3 0 obj: Page with Resources pointing to XObject dict
    //   4 0 obj: Page content stream: "/XObj1 Do"
    //   5 0 obj: XObject dict: /XObj1 → 6 0 R
    //   6 0 obj: Form XObject whose content also does "/XObj1 Do" (self-ref via page resources)
    const contentData = "/XObj1 Do";
    const formData = "/XObj1 Do";
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /XObj1 6 0 R >> >> >> endobj`,
      `4 0 obj << /Length ${contentData.length} >> stream`,
      contentData,
      "endstream endobj",
      "5 0 obj << /XObj1 6 0 R >> endobj",
      `6 0 obj << /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /XObj1 6 0 R >> >> /Length ${formData.length} >> stream`,
      formData,
      "endstream endobj",
      "xref",
      "0 7",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000308 00000 n ",
      "0000000381 00000 n ",
      "0000000418 00000 n ",
      "trailer << /Size 7 /Root 1 0 R >>",
      "startxref",
      "600",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    // Should NOT throw or hang — the recursion guard should kick in
    const result = await readPdf(pdfBytes);
    expect(result.pages.length).toBe(1);
    // No text in this PDF (the form xobject has no real text operators)
    // The key assertion is that we get here at all without stack overflow
    expect(result.pages[0].warnings.length).toBe(0);
  });
});

// =============================================================================
// CMap getCodeLength — overlapping codespace range bug
// =============================================================================

describe("CMap.getCodeLength — overlapping codespace ranges", () => {
  it("should return longest match when 1-byte and 2-byte ranges overlap", () => {
    // Real-world CJK ToUnicode CMap pattern:
    //   <00>   <FF>     ← 1-byte range (covers ALL first bytes 0x00–0xFF)
    //   <8140> <FEFE>   ← 2-byte range (first byte 0x81–0xFE overlaps the 1-byte range)
    //
    // For firstByte=0x81, the old code returned 1 (wrong — matched 1-byte first and stopped).
    // Correct: return 2 (longest match wins per PDF spec).
    const cmap = new CMap();
    cmap.addCodeSpaceRange(0x00, 0xff, 1);
    cmap.addCodeSpaceRange(0x8140, 0xfefe, 2);

    // Byte in the overlapping zone → must return 2 (longest)
    expect(cmap.getCodeLength(0x81)).toBe(2);
    expect(cmap.getCodeLength(0xfe)).toBe(2);
    expect(cmap.getCodeLength(0xa0)).toBe(2);

    // Byte only in the 1-byte range → must return 1
    expect(cmap.getCodeLength(0x20)).toBe(1);
    expect(cmap.getCodeLength(0x7f)).toBe(1);
    expect(cmap.getCodeLength(0x00)).toBe(1);
  });

  it("should return longest match when ranges are added in reverse order", () => {
    // Same ranges but added 2-byte first — should still prefer longest
    const cmap = new CMap();
    cmap.addCodeSpaceRange(0x8140, 0xfefe, 2);
    cmap.addCodeSpaceRange(0x00, 0xff, 1);

    expect(cmap.getCodeLength(0x81)).toBe(2);
    expect(cmap.getCodeLength(0x20)).toBe(1);
  });

  it("should handle non-overlapping ranges correctly", () => {
    // Disjoint: 1-byte 0x00-0x7F, 2-byte 0x8000-0xFFFF
    const cmap = new CMap();
    cmap.addCodeSpaceRange(0x00, 0x7f, 1);
    cmap.addCodeSpaceRange(0x8000, 0xffff, 2);

    expect(cmap.getCodeLength(0x20)).toBe(1);
    expect(cmap.getCodeLength(0x80)).toBe(2);
    expect(cmap.getCodeLength(0x7f)).toBe(1);
  });
});

// =============================================================================
// decodeText regression — CID font with overlapping codespace ranges
// =============================================================================

describe("decodeText — CID variable-length code regression", () => {
  /**
   * Build a minimal synthetic ResolvedFont with a ToUnicode CMap
   * that has overlapping 1-byte and 2-byte codespace ranges.
   */
  function makeCIDFont(): ResolvedFont {
    const cmap = new CMap();
    // Typical CJK pattern: 1-byte 00-FF, 2-byte 8140-FEFE
    cmap.addCodeSpaceRange(0x00, 0xff, 1);
    cmap.addCodeSpaceRange(0x8140, 0xfefe, 2);
    // Map 2-byte code 0x8140 → "亜" (U+4E9C)
    cmap.addBfChar(0x8140, "\u4E9C");
    // Map 2-byte code 0x8141 → "唖" (U+5516)
    cmap.addBfChar(0x8141, "\u5516");
    // Map 1-byte code 0x41 → "A"
    cmap.addBfChar(0x41, "A");
    cmap.sortRanges();

    return {
      name: "TestCJK",
      subtype: "Type0",
      toUnicode: cmap,
      encoding: new Map(),
      bytesPerCode: 2,
      baseFontName: "TestCJK-Identity-H",
      isSymbolic: false,
      widths: new Map(),
      defaultWidth: 1000,
      missingWidth: 0,
      isIdentityEncoding: false,
      cidToUnicode: null,
      wmode: 0
    };
  }

  it("should decode 2-byte CJK code as one character, not two garbage bytes", () => {
    const font = makeCIDFont();
    // 0x81 0x40 should be consumed as one 2-byte code → "亜"
    const result = decodeText(new Uint8Array([0x81, 0x40]), font);
    expect(result).toBe("\u4E9C");
  });

  it("should decode mixed 1-byte and 2-byte codes correctly", () => {
    const font = makeCIDFont();
    // 0x41 (1-byte "A") + 0x81 0x41 (2-byte "唖")
    const result = decodeText(new Uint8Array([0x41, 0x81, 0x41]), font);
    expect(result).toBe("A\u5516");
  });

  it("should decode consecutive 2-byte codes correctly", () => {
    const font = makeCIDFont();
    // 0x8140 "亜" + 0x8141 "唖"
    const result = decodeText(new Uint8Array([0x81, 0x40, 0x81, 0x41]), font);
    expect(result).toBe("\u4E9C\u5516");
  });
});

// =============================================================================
// Text Reconstruction — Table vs Multi-Column
// =============================================================================

describe("CMap bfrange — multi-code-unit destinations", () => {
  it("keeps the destination prefix and increments only the last code unit", () => {
    const cmap = new CMap();
    // PDF 32000-1 9.10.3: <0000> <0002> <00410042> maps to "AB", "AC", "AD".
    cmap.addBfRange(0x0000, 0x0002, "AB");
    cmap.sortRanges();

    expect(cmap.lookup(0x0000)).toBe("AB");
    expect(cmap.lookup(0x0001)).toBe("AC");
    expect(cmap.lookup(0x0002)).toBe("AD");
  });

  it("preserves a combining sequence rather than truncating it to the base", () => {
    const cmap = new CMap();
    cmap.addBfRange(0x0010, 0x0011, "e\u0301");
    cmap.sortRanges();

    expect(cmap.lookup(0x0010)).toBe("e\u0301");
    expect(cmap.lookup(0x0011)).toBe("e\u0302");
  });

  it("still handles a single-code-unit destination", () => {
    const cmap = new CMap();
    cmap.addBfRange(0x0020, 0x0022, "A");
    cmap.sortRanges();

    expect(cmap.lookup(0x0020)).toBe("A");
    expect(cmap.lookup(0x0022)).toBe("C");
  });

  it("increments within the supplementary plane through the low surrogate", () => {
    const cmap = new CMap();
    // U+1F600; incrementing the low surrogate yields U+1F601.
    cmap.addBfRange(0x0030, 0x0031, "\u{1F600}");
    cmap.sortRanges();

    expect(cmap.lookup(0x0030)).toBe("\u{1F600}");
    expect(cmap.lookup(0x0031)).toBe("\u{1F601}");
  });

  it("refuses to invent characters when the range outruns its destination", () => {
    const cmap = new CMap();
    // Incrementing the low surrogate past DFFF would break the pair.
    cmap.addBfRange(0x0040, 0x0500, "\u{1F600}");
    cmap.sortRanges();

    expect(cmap.lookup(0x0040)).toBe("\u{1F600}");
    expect(cmap.lookup(0x0500)).toBeUndefined();
  });

  it("does not produce an unpaired surrogate", () => {
    const cmap = new CMap();
    cmap.addBfRange(0xd7ff, 0xd800, "\ud7ff");
    cmap.sortRanges();

    expect(cmap.lookup(0xd7ff)).toBe("\ud7ff");
    expect(cmap.lookup(0xd800)).toBeUndefined();
  });
});

describe("decodeText — 3-byte codespace and embedded-cmap fallback", () => {
  it("decodes a 3-byte code as a single character", () => {
    const cmap = new CMap();
    cmap.addCodeSpaceRange(0x000000, 0xffffff, 3);
    cmap.addBfChar(0x010203, "\u4E9C");
    cmap.sortRanges();

    const font: ResolvedFont = {
      name: "ThreeByte",
      subtype: "Type0",
      toUnicode: cmap,
      encoding: new Map(),
      bytesPerCode: 3,
      baseFontName: "ThreeByte",
      isSymbolic: false,
      widths: new Map(),
      defaultWidth: 1000,
      missingWidth: 0,
      isIdentityEncoding: false,
      cidToUnicode: null,
      wmode: 0
    };

    expect(decodeText(new Uint8Array([0x01, 0x02, 0x03]), font)).toBe("\u4E9C");
  });

  it("recovers text through the embedded font cmap when ToUnicode is absent", async () => {
    const { PdfDocumentBuilder } = await import("@pdf/builder/document-builder");
    const { buildTtfWithCmap } = await import("./ttf-test-utils");
    const builder = new PdfDocumentBuilder();
    builder.embedFont(
      buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: 1 - 0x41 }], 3, {
        familyName: "NoToUnicode"
      })
    );
    builder.addPage().drawText("AB", { x: 72, y: 700 });
    const withToUnicode = await builder.build();

    // Strip the /ToUnicode reference so extraction has to fall back to the
    // embedded font program, which is what many third-party producers emit.
    // Rename the key in place rather than deleting bytes: xref offsets must stay
    // valid, and an unknown key is ignored exactly like a missing ToUnicode.
    // The patch is done on bytes because decoding a PDF as text is lossy.
    const bytes = withToUnicode.slice();
    const needle = [..."/ToUnicode "].map(ch => ch.charCodeAt(0));
    let keyOffset = -1;
    for (let i = 0; i + needle.length <= bytes.length && keyOffset < 0; i++) {
      if (needle.every((byte, j) => bytes[i + j] === byte)) {
        keyOffset = i;
      }
    }
    expect(keyOffset).toBeGreaterThan(0);
    bytes[keyOffset + "/ToUnicod".length] = "X".charCodeAt(0);

    const result = await readPdf(bytes, { extractImages: false });
    expect(result.text).toContain("AB");
  });
});

describe("Text Reconstruction — table data should not be split into columns", () => {
  it("should keep table columns on the same line", async () => {
    // Write a 3-column table and read it back.
    // Before the fix, detectColumns would split this into 2-3 "columns"
    // and put each table column on its own set of lines.
    const pdfBytes = await pdf([
      ["Product", "Price", "Quantity"],
      ["Widget A", 19.99, 100],
      ["Widget B", 24.5, 250]
    ]);

    const result = await readPdf(pdfBytes);
    const text = result.text;

    // All three column headers should be on the same line
    const lines = text.split("\n").filter(l => l.trim().length > 0);
    const headerLine = lines.find(l => l.includes("Product"));
    expect(headerLine).toBeDefined();
    expect(headerLine).toContain("Price");
    expect(headerLine).toContain("Quantity");

    // Data rows should also be on the same line
    const widgetALine = lines.find(l => l.includes("Widget A"));
    expect(widgetALine).toBeDefined();
    expect(widgetALine).toContain("19.99");
    expect(widgetALine).toContain("100");
  });

  it("should keep 5-column table on same lines", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Test");
    Worksheet.setColumns(ws, [
      { header: "Item", key: "item", width: 20 },
      { header: "SKU", key: "sku", width: 15 },
      { header: "Qty", key: "qty", width: 10 },
      { header: "Price", key: "price", width: 12 },
      { header: "Stock", key: "stock", width: 10 }
    ]);
    Worksheet.addRows(ws, [
      { item: "Laptop", sku: "LP-001", qty: 42, price: 1299.99, stock: true },
      { item: "Mouse", sku: "WM-055", qty: 350, price: 29.99, stock: true }
    ]);
    const pdfBytes = await excelToPdf(wb);
    const result = await readPdf(pdfBytes);

    const lines = result.text.split("\n").filter(l => l.trim().length > 0);

    // Header line should contain all 5 columns
    const headerLine = lines.find(l => l.includes("Item"));
    expect(headerLine).toBeDefined();
    expect(headerLine).toContain("SKU");
    expect(headerLine).toContain("Qty");
    expect(headerLine).toContain("Price");
    expect(headerLine).toContain("Stock");

    // Data row
    const laptopLine = lines.find(l => l.includes("Laptop"));
    expect(laptopLine).toBeDefined();
    expect(laptopLine).toContain("LP-001");
    expect(laptopLine).toContain("42");
    expect(laptopLine).toContain("1299.99");
  });

  it("should use tab separators between table columns", async () => {
    const pdfBytes = await pdf(
      [
        ["Name", "Department", "Salary"],
        ["Alice", "Engineering", 120000],
        ["Bob", "Marketing", 95000]
      ],
      { showGridLines: true }
    );

    const result = await readPdf(pdfBytes);
    const lines = result.text.split("\n").filter(l => l.trim().length > 0);

    // All column values should appear in the text
    const headerLine = lines.find(l => l.includes("Name"));
    expect(headerLine).toBeDefined();

    // With wide enough gaps, tab separators should be detected
    // (at least one tab between the header columns)
    const tabCount = (headerLine!.match(/\t/g) || []).length;
    expect(tabCount).toBeGreaterThanOrEqual(1);
  });

  it("should preserve single-column text without false column detection", async () => {
    const pdfBytes = await pdf([["Single Column"], ["Row 1"], ["Row 2"], ["Row 3"]]);

    const result = await readPdf(pdfBytes);
    const lines = result.text.split("\n").filter(l => l.trim().length > 0);

    expect(lines).toContain("Single Column");
    expect(lines).toContain("Row 1");
    expect(lines).toContain("Row 2");
    expect(lines).toContain("Row 3");
  });
});

// =============================================================================
// Annotation Extraction
// =============================================================================

describe("PDF Reader - Annotation Extraction", () => {
  it("should extract Link annotations from hand-crafted PDF", async () => {
    // Hand-crafted PDF with a Link annotation that has a URI action
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R 6 0 R] >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      // Link annotation with URI
      "5 0 obj << /Type /Annot /Subtype /Link /Rect [72 700 200 720] /A << /Type /Action /S /URI /URI (https://example.com) >> >> endobj",
      // Text (sticky note) annotation
      "6 0 obj << /Type /Annot /Subtype /Text /Rect [72 600 92 620] /Contents (This is a note) /T (Author Name) >> endobj",
      "xref",
      "0 7",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000260 00000 n ",
      "0000000310 00000 n ",
      "0000000453 00000 n ",
      "trailer << /Size 7 /Root 1 0 R >>",
      "startxref",
      "600",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.pages.length).toBe(1);
    const annots = result.pages[0].annotations;
    expect(annots.length).toBe(2);

    // Link annotation
    const link = annots.find(a => a.subtype === "Link")!;
    expect(link).toBeDefined();
    expect(link.uri).toBe("https://example.com");
    expect(link.rect.x1).toBe(72);
    expect(link.rect.y1).toBe(700);
    expect(link.rect.x2).toBe(200);
    expect(link.rect.y2).toBe(720);

    // Text (sticky note) annotation
    const note = annots.find(a => a.subtype === "Text")!;
    expect(note).toBeDefined();
    expect(note.contents).toBe("This is a note");
    expect(note.author).toBe("Author Name");
  });

  it("should extract Highlight annotation", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Highlight /Rect [100 500 300 520] /Contents (Important text) /C [1 1 0] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000260 00000 n ",
      "0000000310 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "450",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    const annots = result.pages[0].annotations;
    expect(annots.length).toBe(1);
    expect(annots[0].subtype).toBe("Highlight");
    expect(annots[0].contents).toBe("Important text");
    expect(annots[0].color).toEqual([1, 1, 0]); // Yellow
  });

  it("should skip Widget and Popup annotations", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R 6 0 R 7 0 R] >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      // Widget (form field) — should be skipped
      "5 0 obj << /Type /Annot /Subtype /Widget /Rect [72 700 200 720] >> endobj",
      // Popup — should be skipped
      "6 0 obj << /Type /Annot /Subtype /Popup /Rect [72 600 200 620] >> endobj",
      // FreeText — should be extracted
      "7 0 obj << /Type /Annot /Subtype /FreeText /Rect [72 500 300 530] /Contents (Free text content) >> endobj",
      "xref",
      "0 8",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000280 00000 n ",
      "0000000330 00000 n ",
      "0000000410 00000 n ",
      "0000000490 00000 n ",
      "trailer << /Size 8 /Root 1 0 R >>",
      "startxref",
      "620",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    const annots = result.pages[0].annotations;
    // Only FreeText — Widget and Popup should be filtered out
    expect(annots.length).toBe(1);
    expect(annots[0].subtype).toBe("FreeText");
    expect(annots[0].contents).toBe("Free text content");
  });

  it("should return empty annotations for pages without /Annots", async () => {
    const pdfBytes = await pdf([["Hello", "World"]]);
    const result = await readPdf(pdfBytes);

    // Our simple PDF writer doesn't add annotations for plain data
    expect(result.pages[0].annotations).toEqual([]);
  });

  it("should respect extractAnnotations: false option", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Text /Rect [72 700 92 720] /Contents (Note) >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000260 00000 n ",
      "0000000310 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "430",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes, { extractAnnotations: false });

    // Annotations should be empty when extraction is disabled
    expect(result.pages[0].annotations).toEqual([]);
  });

  it("should extract Link annotation with direct /Dest", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Link /Rect [72 700 200 720] /Dest /Chapter1 >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000260 00000 n ",
      "0000000310 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "440",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    const annots = result.pages[0].annotations;
    expect(annots.length).toBe(1);
    expect(annots[0].subtype).toBe("Link");
    expect(annots[0].destination).toBe("Chapter1");
  });

  it("should extract annotations from roundtrip Excel PDF with hyperlinks", async () => {
    // Create a workbook with hyperlinks — the writer will create Link annotations
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Links");
    const row = Worksheet.addRow(sheet, ["Click here"]);
    cellSetValue(rowGetCell(row, 1), {
      text: "Example",
      hyperlink: "https://example.com"
    });

    const pdfBytes = await excelToPdf(workbook);
    const result = await readPdf(pdfBytes);

    // The writer should have created at least one Link annotation
    const allAnnotations = result.pages.flatMap(p => p.annotations);
    const links = allAnnotations.filter(a => a.subtype === "Link");
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].uri).toBe("https://example.com");
  });
});

// =============================================================================
// Form Field Extraction
// =============================================================================

describe("PDF Reader - Form Field Extraction", () => {
  it("should extract text field from AcroForm", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      // Text field with value
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (username) /V (john_doe) /Rect [72 700 200 720] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000252 00000 n ",
      "0000000302 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "440",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.formFields.length).toBe(1);
    expect(result.formFields[0].name).toBe("username");
    expect(result.formFields[0].type).toBe("text");
    expect(result.formFields[0].value).toBe("john_doe");
  });

  it("should extract checkbox field", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      // Checkbox field — /Btn without Pushbutton or Radio flags
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /V /Yes /Ff 0 /Rect [72 700 92 720] /AP << /N << /Yes 6 0 R /Off 6 0 R >> >> >> endobj",
      "6 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "xref",
      "0 7",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000252 00000 n ",
      "0000000302 00000 n ",
      "0000000510 00000 n ",
      "trailer << /Size 7 /Root 1 0 R >>",
      "startxref",
      "570",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.formFields.length).toBe(1);
    expect(result.formFields[0].name).toBe("agree");
    expect(result.formFields[0].type).toBe("checkbox");
    expect(result.formFields[0].value).toBe("Yes");
    expect(result.formFields[0].exportValue).toBe("Yes");
  });

  it("should extract dropdown (choice) field with options", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      // Dropdown: /Ch with /Ff bit 17 (Combo) set = 131072
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Ch /T (country) /V (Australia) /Ff 131072 /Opt [(Australia) (Canada) (Japan)] /Rect [72 700 200 720] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000252 00000 n ",
      "0000000302 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "500",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.formFields.length).toBe(1);
    const field = result.formFields[0];
    expect(field.name).toBe("country");
    expect(field.type).toBe("dropdown");
    expect(field.value).toBe("Australia");
    expect(field.options).toEqual(["Australia", "Canada", "Japan"]);
  });

  it("should extract multiple form fields", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R 7 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Alice) /Rect [72 700 200 720] >> endobj",
      "6 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (email) /V (alice@example.com) /Rect [72 670 200 690] >> endobj",
      "7 0 obj << /Type /Annot /Subtype /Widget /FT /Btn /T (subscribe) /V /Off /Ff 0 /Rect [72 640 92 660] >> endobj",
      "xref",
      "0 8",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000120 00000 n ",
      "0000000177 00000 n ",
      "0000000272 00000 n ",
      "0000000322 00000 n ",
      "0000000430 00000 n ",
      "0000000550 00000 n ",
      "trailer << /Size 8 /Root 1 0 R >>",
      "startxref",
      "680",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.formFields.length).toBe(3);

    const nameField = result.formFields.find(f => f.name === "name")!;
    expect(nameField.type).toBe("text");
    expect(nameField.value).toBe("Alice");

    const emailField = result.formFields.find(f => f.name === "email")!;
    expect(emailField.type).toBe("text");
    expect(emailField.value).toBe("alice@example.com");

    const subscribeField = result.formFields.find(f => f.name === "subscribe")!;
    expect(subscribeField.type).toBe("checkbox");
    expect(subscribeField.value).toBe("Off");
  });

  it("should extract read-only and required flags", async () => {
    // Ff: bit 0 (ReadOnly) = 1, bit 1 (Required) = 2 → combined = 3
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (readonly_required) /V (locked) /Ff 3 /Rect [72 700 200 720] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000252 00000 n ",
      "0000000302 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "460",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.formFields.length).toBe(1);
    expect(result.formFields[0].readOnly).toBe(true);
    expect(result.formFields[0].required).toBe(true);
  });

  it("should return empty formFields for PDFs without AcroForm", async () => {
    const pdfBytes = await pdf([["Hello", "World"]]);
    const result = await readPdf(pdfBytes);

    expect(result.formFields).toEqual([]);
  });

  it("should respect extractFormFields: false option", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (field1) /V (value1) /Rect [72 700 200 720] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000252 00000 n ",
      "0000000302 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "440",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes, { extractFormFields: false });

    expect(result.formFields).toEqual([]);
  });

  it("should handle hierarchical field names", async () => {
    // Parent field "address" with children "city" and "zip"
    // → should produce "address.city" and "address.zip"
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      // Parent node (no /FT, has /T and /Kids)
      "5 0 obj << /T (address) /Kids [6 0 R 7 0 R] >> endobj",
      // Child text fields
      "6 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (city) /V (Sydney) /Parent 5 0 R /Rect [72 700 200 720] >> endobj",
      "7 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (zip) /V (2000) /Parent 5 0 R /Rect [72 670 200 690] >> endobj",
      "xref",
      "0 8",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000252 00000 n ",
      "0000000302 00000 n ",
      "0000000360 00000 n ",
      "0000000490 00000 n ",
      "trailer << /Size 8 /Root 1 0 R >>",
      "startxref",
      "620",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.formFields.length).toBe(2);
    const names = result.formFields.map(f => f.name).sort();
    expect(names).toEqual(["address.city", "address.zip"]);

    const cityField = result.formFields.find(f => f.name === "address.city")!;
    expect(cityField.value).toBe("Sydney");

    const zipField = result.formFields.find(f => f.name === "address.zip")!;
    expect(zipField.value).toBe("2000");
  });

  it("should extract listbox field (Ch without Combo flag)", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      // Listbox: /Ch with /Ff 0 (no Combo bit)
      "5 0 obj << /Type /Annot /Subtype /Widget /FT /Ch /T (colors) /V (Red) /Ff 0 /Opt [(Red) (Green) (Blue)] /Rect [72 700 200 780] >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000100 00000 n ",
      "0000000157 00000 n ",
      "0000000252 00000 n ",
      "0000000302 00000 n ",
      "trailer << /Size 6 /Root 1 0 R >>",
      "startxref",
      "480",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.formFields.length).toBe(1);
    const field = result.formFields[0];
    expect(field.name).toBe("colors");
    expect(field.type).toBe("listbox");
    expect(field.value).toBe("Red");
    expect(field.options).toEqual(["Red", "Green", "Blue"]);
  });
});

// =============================================================================
// Bookmark (Outline) Extraction
// =============================================================================

describe("PDF Reader - Bookmark Extraction", () => {
  it("should extract a 2-level outline tree", async () => {
    // Hand-crafted PDF with a 2-level outline tree:
    //   Chapter 1 → page 1
    //     Section 1.1 → page 1
    //     Section 1.2 → page 2
    //   Chapter 2 → page 2
    //
    // Object layout:
    //   1: Catalog (with /Outlines 7 0 R)
    //   2: Pages
    //   3: Page 1
    //   4: Page 2
    //   5: Contents (page 1, empty)
    //   6: Contents (page 2, empty)
    //   7: Outlines root (/First 8 /Last 9 /Count 4)
    //   8: Chapter 1 (/First 10 /Last 11 /Next 9)
    //   9: Chapter 2 (/Prev 8)
    //  10: Section 1.1 (/Next 11)
    //  11: Section 1.2 (/Prev 10)
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >> endobj",
      "4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >> endobj",
      "5 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "6 0 obj << /Length 0 >> stream",
      "endstream endobj",
      // Outlines root
      "7 0 obj << /Type /Outlines /First 8 0 R /Last 9 0 R /Count 4 >> endobj",
      // Chapter 1 → page 1 (obj 3), with children
      "8 0 obj << /Title (Chapter 1) /Parent 7 0 R /First 10 0 R /Last 11 0 R /Count 2 /Next 9 0 R /Dest [3 0 R /Fit] >> endobj",
      // Chapter 2 → page 2 (obj 4), no children
      "9 0 obj << /Title (Chapter 2) /Parent 7 0 R /Prev 8 0 R /Dest [4 0 R /Fit] >> endobj",
      // Section 1.1 → page 1 (obj 3)
      "10 0 obj << /Title (Section 1.1) /Parent 8 0 R /Next 11 0 R /Dest [3 0 R /XYZ 0 700 0] >> endobj",
      // Section 1.2 → page 2 (obj 4)
      "11 0 obj << /Title (Section 1.2) /Parent 8 0 R /Prev 10 0 R /Dest [4 0 R /XYZ 0 700 0] >> endobj",
      "xref",
      "0 12",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000080 00000 n ",
      "0000000145 00000 n ",
      "0000000240 00000 n ",
      "0000000335 00000 n ",
      "0000000385 00000 n ",
      "0000000435 00000 n ",
      "0000000510 00000 n ",
      "0000000650 00000 n ",
      "0000000740 00000 n ",
      "0000000850 00000 n ",
      "trailer << /Size 12 /Root 1 0 R >>",
      "startxref",
      "960",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.bookmarks.length).toBe(2);

    // Chapter 1
    const ch1 = result.bookmarks[0];
    expect(ch1.title).toBe("Chapter 1");
    expect(ch1.pageIndex).toBe(0); // page 1 → index 0
    expect(ch1.children.length).toBe(2);

    // Section 1.1
    expect(ch1.children[0].title).toBe("Section 1.1");
    expect(ch1.children[0].pageIndex).toBe(0);
    expect(ch1.children[0].children).toEqual([]);

    // Section 1.2
    expect(ch1.children[1].title).toBe("Section 1.2");
    expect(ch1.children[1].pageIndex).toBe(1); // page 2 → index 1
    expect(ch1.children[1].children).toEqual([]);

    // Chapter 2
    const ch2 = result.bookmarks[1];
    expect(ch2.title).toBe("Chapter 2");
    expect(ch2.pageIndex).toBe(1);
    expect(ch2.children).toEqual([]);
  });

  it("should return empty array for PDF with no outlines", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "xref",
      "0 5",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "0000000230 00000 n ",
      "trailer << /Size 5 /Root 1 0 R >>",
      "startxref",
      "280",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.bookmarks).toEqual([]);
  });

  it("should extract bookmarks with action-based destinations", async () => {
    // Outline items use /A << /S /GoTo /D [...] >> instead of /Dest
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
      "4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
      // Outlines root
      "5 0 obj << /Type /Outlines /First 6 0 R /Last 7 0 R /Count 2 >> endobj",
      // Bookmark with GoTo action to page 1
      "6 0 obj << /Title (Introduction) /Parent 5 0 R /Next 7 0 R /A << /S /GoTo /D [3 0 R /Fit] >> >> endobj",
      // Bookmark with GoTo action to page 2
      "7 0 obj << /Title (Appendix) /Parent 5 0 R /Prev 6 0 R /A << /S /GoTo /D [4 0 R /XYZ 0 792 0] >> >> endobj",
      "xref",
      "0 8",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000080 00000 n ",
      "0000000145 00000 n ",
      "0000000220 00000 n ",
      "0000000295 00000 n ",
      "0000000370 00000 n ",
      "0000000500 00000 n ",
      "trailer << /Size 8 /Root 1 0 R >>",
      "startxref",
      "640",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes);

    expect(result.bookmarks.length).toBe(2);

    expect(result.bookmarks[0].title).toBe("Introduction");
    expect(result.bookmarks[0].pageIndex).toBe(0);

    expect(result.bookmarks[1].title).toBe("Appendix");
    expect(result.bookmarks[1].pageIndex).toBe(1);
  });

  it("should respect extractBookmarks: false option", async () => {
    const src = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 0 >> stream",
      "endstream endobj",
      "5 0 obj << /Type /Outlines /First 6 0 R /Last 6 0 R /Count 1 >> endobj",
      "6 0 obj << /Title (Bookmark) /Parent 5 0 R /Dest [3 0 R /Fit] >> endobj",
      "xref",
      "0 7",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000080 00000 n ",
      "0000000137 00000 n ",
      "0000000252 00000 n ",
      "0000000302 00000 n ",
      "0000000380 00000 n ",
      "trailer << /Size 7 /Root 1 0 R >>",
      "startxref",
      "460",
      "%%EOF"
    ].join("\n");

    const pdfBytes = pdfFromString(src);
    const result = await readPdf(pdfBytes, { extractBookmarks: false });

    expect(result.bookmarks).toEqual([]);
  });
});

// =============================================================================
// Table Extraction
// =============================================================================

describe("PDF Reader - Table Extraction", () => {
  it("should extract a 3x3 table from a simple PDF", async () => {
    const pdfBytes = await pdf([
      ["Name", "Age", "City"],
      ["Alice", 30, "New York"],
      ["Bob", 25, "London"]
    ]);

    const result = await readPdf(pdfBytes, { extractTables: true });
    expect(result.pages.length).toBeGreaterThan(0);

    const page = result.pages[0];
    expect(page.tables.length).toBeGreaterThanOrEqual(1);

    const table = page.tables[0];
    expect(table.rows.length).toBeGreaterThanOrEqual(2);

    // Each row should have at least 2 cells
    for (const row of table.rows) {
      expect(row.cells.length).toBeGreaterThanOrEqual(2);
    }

    // All text from the table should be present in cell text
    const allCellText = table.rows.flatMap(r => r.cells.map(c => c.text));
    expect(allCellText).toContain("Name");
    expect(allCellText).toContain("Age");
    expect(allCellText).toContain("City");

    // Table bounding box should have reasonable dimensions
    expect(table.width).toBeGreaterThan(0);
    expect(table.height).toBeGreaterThan(0);
    expect(table.x).toBeGreaterThanOrEqual(0);
    expect(table.y).toBeGreaterThan(0);
  });

  it("should return empty tables when extractTables is false (default)", async () => {
    const pdfBytes = await pdf([
      ["Name", "Score"],
      ["Alice", 95],
      ["Bob", 87]
    ]);

    const result = await readPdf(pdfBytes);
    const page = result.pages[0];
    expect(page.tables).toEqual([]);
  });

  it("should return empty tables for a PDF with no tabular structure", async () => {
    // Single-column data — should not detect a table
    const pdfBytes = await pdf([["Hello"], ["World"], ["Test"]]);

    const result = await readPdf(pdfBytes, { extractTables: true });
    const page = result.pages[0];
    expect(page.tables).toEqual([]);
  });

  it("should detect cells with correct position data", async () => {
    const pdfBytes = await pdf([
      ["Product", "Price"],
      ["Widget", 19.99],
      ["Gadget", 24.5]
    ]);

    const result = await readPdf(pdfBytes, { extractTables: true });
    const page = result.pages[0];

    if (page.tables.length > 0) {
      const table = page.tables[0];
      for (const row of table.rows) {
        for (const cell of row.cells) {
          // Each cell should have numeric position and size
          expect(typeof cell.x).toBe("number");
          expect(typeof cell.y).toBe("number");
          expect(typeof cell.width).toBe("number");
          expect(typeof cell.height).toBe("number");
        }
      }
    }
  });

  it("should extract table from a multi-column Excel workbook PDF", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Worksheet.setColumns(ws, [
      { header: "Item", key: "item", width: 20 },
      { header: "Qty", key: "qty", width: 10 },
      { header: "Price", key: "price", width: 12 }
    ]);
    Worksheet.addRows(ws, [
      { item: "Laptop", qty: 5, price: 999.99 },
      { item: "Mouse", qty: 50, price: 29.99 },
      { item: "Keyboard", qty: 30, price: 49.99 }
    ]);
    const pdfBytes = await excelToPdf(wb);

    const result = await readPdf(pdfBytes, { extractTables: true });
    const page = result.pages[0];
    expect(page.tables.length).toBeGreaterThanOrEqual(1);

    const table = page.tables[0];
    // Should have at least header + 3 data rows
    expect(table.rows.length).toBeGreaterThanOrEqual(3);

    // Verify all data values appear in cell text
    const allCellText = table.rows.flatMap(r => r.cells.map(c => c.text));
    expect(allCellText.some(t => t.includes("Laptop"))).toBe(true);
    expect(allCellText.some(t => t.includes("Mouse"))).toBe(true);
    expect(allCellText.some(t => t.includes("Keyboard"))).toBe(true);
  });

  it("should not detect single-column paragraph text as a table", async () => {
    // A PDF with multi-line paragraph text — no tabular structure
    const doc = new PdfDocumentBuilder();
    const page = doc.addPage();
    const lines = [
      "This is a paragraph of text that spans a single column.",
      "It has multiple lines but no tabular structure at all.",
      "Each line is positioned sequentially, one below the other.",
      "There are no columns, no alignment patterns, no grid.",
      "Table extraction should return zero tables for this page."
    ];
    let y = 700;
    for (const line of lines) {
      page.drawText(line, { x: 72, y, fontSize: 12 });
      y -= 18;
    }
    const pdfBytes = await doc.build();

    const result = await readPdf(pdfBytes, { extractTables: true });
    expect(result.pages[0].tables.length).toBe(0);
  });
});
