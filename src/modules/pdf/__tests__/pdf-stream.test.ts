import { PdfContentStream, isWinAnsiCodePoint } from "@pdf/core/pdf-stream";
/**
 * Tests for PDF content stream builder.
 */
import { describe, it, expect } from "vitest";

describe("PdfContentStream", () => {
  describe("Graphics State", () => {
    it("should generate save/restore operators", () => {
      const stream = new PdfContentStream();
      stream.save().restore();
      expect(stream.toString()).toBe("q\nQ");
    });
  });

  describe("Color Operators", () => {
    it("should set stroke color", () => {
      const stream = new PdfContentStream();
      stream.setStrokeColor({ r: 1, g: 0, b: 0 });
      expect(stream.toString()).toBe("1 0 0 RG");
    });

    it("should set fill color", () => {
      const stream = new PdfContentStream();
      stream.setFillColor({ r: 0, g: 0.5, b: 1 });
      expect(stream.toString()).toBe("0 0.5 1 rg");
    });
  });

  describe("Line Style", () => {
    it("should set line width", () => {
      const stream = new PdfContentStream();
      stream.setLineWidth(2);
      expect(stream.toString()).toBe("2 w");
    });

    it("should set dash pattern", () => {
      const stream = new PdfContentStream();
      stream.setDashPattern([3, 2], 0);
      expect(stream.toString()).toBe("[3 2] 0 d");
    });

    it("should set solid line (empty dash)", () => {
      const stream = new PdfContentStream();
      stream.setDashPattern([]);
      expect(stream.toString()).toBe("[] 0 d");
    });
  });

  describe("Path Construction", () => {
    it("should move to a point", () => {
      const stream = new PdfContentStream();
      stream.moveTo(100, 200);
      expect(stream.toString()).toBe("100 200 m");
    });

    it("should draw a line", () => {
      const stream = new PdfContentStream();
      stream.moveTo(0, 0).lineTo(100, 200);
      expect(stream.toString()).toBe("0 0 m\n100 200 l");
    });

    it("should draw a rectangle", () => {
      const stream = new PdfContentStream();
      stream.rect(10, 20, 100, 50);
      expect(stream.toString()).toBe("10 20 100 50 re");
    });
  });

  describe("Path Painting", () => {
    it("should stroke", () => {
      const stream = new PdfContentStream();
      stream.stroke();
      expect(stream.toString()).toBe("S");
    });

    it("should fill", () => {
      const stream = new PdfContentStream();
      stream.fill();
      expect(stream.toString()).toBe("f");
    });

    it("should fill and stroke", () => {
      const stream = new PdfContentStream();
      stream.fillAndStroke();
      expect(stream.toString()).toBe("B");
    });
  });

  describe("Text Operations", () => {
    it("should begin and end text", () => {
      const stream = new PdfContentStream();
      stream.beginText().endText();
      expect(stream.toString()).toBe("BT\nET");
    });

    it("should set font", () => {
      const stream = new PdfContentStream();
      stream.setFont("F1", 12);
      expect(stream.toString()).toBe("/F1 12 Tf");
    });

    it("should show text", () => {
      const stream = new PdfContentStream();
      stream.showText("Hello World");
      expect(stream.toString()).toBe("(Hello World) Tj");
    });

    it("should escape text content", () => {
      const stream = new PdfContentStream();
      stream.showText("Hello (world)");
      expect(stream.toString()).toBe("(Hello \\(world\\)) Tj");
    });

    it("should set text matrix for positioning", () => {
      const stream = new PdfContentStream();
      stream.setTextMatrix(1, 0, 0, 1, 72, 720);
      expect(stream.toString()).toBe("1 0 0 1 72 720 Tm");
    });

    it("should set text rendering mode", () => {
      const stream = new PdfContentStream();
      stream.setTextRenderingMode(1);
      expect(stream.toString()).toBe("1 Tr");
    });

    it("should emit the default text rendering mode to reset text state", () => {
      const stream = new PdfContentStream();
      stream.setTextRenderingMode(0);
      expect(stream.toString()).toBe("0 Tr");
    });

    it("should move text position", () => {
      const stream = new PdfContentStream();
      stream.moveText(10, -15);
      expect(stream.toString()).toBe("10 -15 Td");
    });
  });

  describe("Convenience Methods", () => {
    it("should draw a filled rectangle", () => {
      const stream = new PdfContentStream();
      stream.fillRect(10, 20, 100, 50, { r: 0.9, g: 0.9, b: 0.9 });
      const result = stream.toString();
      expect(result).toContain("q");
      expect(result).toContain("0.9 0.9 0.9 rg");
      expect(result).toContain("10 20 100 50 re");
      expect(result).toContain("f");
      expect(result).toContain("Q");
    });

    it("should draw a line with color and width", () => {
      const stream = new PdfContentStream();
      stream.drawLine(0, 0, 100, 100, { r: 0, g: 0, b: 0 }, 1);
      const result = stream.toString();
      expect(result).toContain("q");
      expect(result).toContain("0 0 0 RG");
      expect(result).toContain("1 w");
      expect(result).toContain("0 0 m");
      expect(result).toContain("100 100 l");
      expect(result).toContain("S");
      expect(result).toContain("Q");
    });

    it("should draw a dashed line", () => {
      const stream = new PdfContentStream();
      stream.drawLine(0, 0, 100, 0, { r: 0.5, g: 0.5, b: 0.5 }, 0.5, [3, 2]);
      const result = stream.toString();
      expect(result).toContain("[3 2] 0 d");
    });
  });

  describe("Serialization", () => {
    it("should convert to Uint8Array", () => {
      const stream = new PdfContentStream();
      stream.moveTo(0, 0).lineTo(100, 100).stroke();
      const bytes = stream.toUint8Array();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
    });

    it("should produce valid UTF-8", () => {
      const stream = new PdfContentStream();
      stream.showText("Hello");
      const bytes = stream.toUint8Array();
      const text = new TextDecoder().decode(bytes);
      expect(text).toBe("(Hello) Tj");
    });
  });

  describe("append", () => {
    it("copies deferred fragments without evaluating them", () => {
      const target = new PdfContentStream();
      const source = new PdfContentStream();
      let evaluated = 0;
      source.deferred(() => {
        evaluated++;
        return "(late) Tj";
      });

      target.append(source);
      expect(evaluated).toBe(0);
      expect(new TextDecoder().decode(target.toUint8Array())).toBe("(late) Tj");
      expect(evaluated).toBe(1);
    });

    /**
     * A content stream's fragment count grows with the marks on the page and has
     * no ceiling. `append` used to copy with `push(...other.parts)`, which turns
     * that count into an *argument list* — V8 throws
     * `RangeError: Maximum call stack size exceeded` past roughly 125k arguments.
     * A vector chart over a five-figure row count crossed it, so exporting the
     * `sales-dashboard` example failed outright with no way for a caller to
     * work around it.
     *
     * 200k is chosen to sit clearly above the threshold measured on V8 (~125k);
     * the operators themselves are trivial so the test stays fast.
     */
    it("copies a fragment count past the engine's argument limit", () => {
      const source = new PdfContentStream();
      const COUNT = 200_000;
      for (let i = 0; i < COUNT; i++) {
        source.raw("q Q");
      }

      const target = new PdfContentStream();
      expect(() => target.append(source)).not.toThrow();
      expect(new TextDecoder().decode(target.toUint8Array()).split("\n")).toHaveLength(COUNT);
    });
  });

  describe("WinAnsi Encoding", () => {
    it("should encode non-ASCII Latin chars as WinAnsi hex string", () => {
      const stream = new PdfContentStream();
      stream.showText("café");
      // c=0x63, a=0x61, f=0x66, é=0xE9 in WinAnsi
      expect(stream.toString()).toBe("<636166e9> Tj");
    });

    it("should keep pure ASCII as parenthesized string", () => {
      const stream = new PdfContentStream();
      stream.showText("Hello");
      expect(stream.toString()).toBe("(Hello) Tj");
    });

    it("should encode € as WinAnsi 0x80", () => {
      const stream = new PdfContentStream();
      stream.showText("€10");
      // €=0x80, 1=0x31, 0=0x30
      expect(stream.toString()).toBe("<803130> Tj");
    });

    it("should replace unmappable chars with space", () => {
      const stream = new PdfContentStream();
      // Chinese char not in WinAnsi → should become 0x20 (space)
      stream.showText("A\u4e2dB");
      expect(stream.toString()).toBe("<412042> Tj");
    });

    it("should handle ü ñ ö correctly", () => {
      const stream = new PdfContentStream();
      stream.showText("üñö");
      // ü=0xFC, ñ=0xF1, ö=0xF6
      expect(stream.toString()).toBe("<fcf1f6> Tj");
    });
  });

  describe("nextLineShowText WinAnsi", () => {
    it("should encode non-ASCII via WinAnsi for next-line-show", () => {
      const stream = new PdfContentStream();
      stream.nextLineShowText("café");
      expect(stream.toString()).toBe("<636166e9> '");
    });

    it("should keep ASCII as parenthesized string for next-line-show", () => {
      const stream = new PdfContentStream();
      stream.nextLineShowText("Hello");
      expect(stream.toString()).toBe("(Hello) '");
    });
  });
});

describe("isWinAnsiCodePoint", () => {
  it("should return true for ASCII", () => {
    expect(isWinAnsiCodePoint(0x41)).toBe(true); // 'A'
    expect(isWinAnsiCodePoint(0x20)).toBe(true); // space
  });

  it("should return true for Latin-1 supplement", () => {
    expect(isWinAnsiCodePoint(0xe9)).toBe(true); // é
    expect(isWinAnsiCodePoint(0xfc)).toBe(true); // ü
  });

  it("should return true for WinAnsi special range", () => {
    expect(isWinAnsiCodePoint(0x20ac)).toBe(true); // €
    expect(isWinAnsiCodePoint(0x2122)).toBe(true); // ™
  });

  it("should return false for non-WinAnsi", () => {
    expect(isWinAnsiCodePoint(0x4e2d)).toBe(false); // 中
    expect(isWinAnsiCodePoint(0x25cb)).toBe(false); // ○
    expect(isWinAnsiCodePoint(0x2713)).toBe(false); // ✓
  });
});
