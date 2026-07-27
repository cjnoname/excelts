import * as Csv from "@csv/index";
import * as Formula from "@formula/index";
import * as Markdown from "@markdown/index";
import * as Word from "@word/index";
import * as Xml from "@xml/index";
/**
 * Public namespace-surface contract for the non-excel domain modules:
 * `documonster/word`, `/csv`, `/markdown`, `/xml`, `/pdf`, `/formula`.
 *
 * Locks each module's namespace shape and verifies a representative member
 * is callable / behaves. Guards against accidental removal or rename of
 * public surface members.
 */
import { describe, it, expect } from "vitest";

function isFn(ns: unknown, member: string): boolean {
  return typeof (ns as Record<string, unknown>)[member] === "function";
}

describe("documonster/word namespace surface", () => {
  it("exposes the expected domain namespaces", () => {
    for (const ns of [
      "Document",
      "Build",
      "Query",
      "Io",
      "Template",
      "Convert",
      "Font",
      "Layout",
      "Security",
      "Ole",
      "Vba",
      "Glossary",
      "Styles",
      "Diff",
      "Validation",
      "Streaming",
      "RenderContext",
      "Units",
      "Theme"
    ]) {
      expect((Word as Record<string, unknown>)[ns], `Word.${ns}`).toBeDefined();
    }
  });

  it("Build namespace exposes content-node builders", () => {
    for (const m of ["paragraph", "text", "table", "heading", "createShape"]) {
      expect(isFn(Word.Build, m), `Build.${m}`).toBe(true);
    }
  });

  it("Io namespace exposes package/read + merge/split", () => {
    for (const m of ["package", "read", "toBuffer", "merge", "split"]) {
      expect(isFn(Word.Io, m), `Io.${m}`).toBe(true);
    }
  });

  it("Document builder round-trips a paragraph", () => {
    const doc = Word.Document.create();
    Word.Document.addParagraph(doc, "Hello");
    const built = Word.Document.build(doc);
    expect(built.body.length).toBeGreaterThan(0);
  });

  it("data-model types stay flat (error classes exported)", () => {
    expect(typeof Word.DocxError).toBe("function");
    expect(typeof Word.isDocxError).toBe("function");
  });
});

describe("documonster/csv namespace surface", () => {
  it("Csv namespace exposes parse/format/detection", () => {
    for (const m of ["parse", "format", "parseAsync", "detectDelimiter"]) {
      expect(isFn(Csv.Csv, m), `Csv.${m}`).toBe(true);
    }
  });

  it("Csv.parse round-trips simple data", () => {
    const rows = Csv.Csv.parse("a,b\n1,2");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  it("error classes stay flat", () => {
    expect(typeof Csv.CsvError).toBe("function");
  });
});

describe("documonster/markdown namespace surface", () => {
  it("Markdown namespace exposes parse/format", () => {
    for (const m of ["parse", "parseAll", "format"]) {
      expect(isFn(Markdown.Markdown, m), `Markdown.${m}`).toBe(true);
    }
  });

  it("Markdown.format produces a GFM table", () => {
    const out = Markdown.Markdown.format(["h1", "h2"], [["a", "b"]]);
    expect(out).toContain("|");
    expect(out).toContain("h1");
  });
});

describe("documonster/xml namespace surface", () => {
  it("Xml namespace exposes encode/parse/writers", () => {
    for (const m of ["encode", "decode", "parse", "query"]) {
      expect(isFn(Xml.Xml, m), `Xml.${m}`).toBe(true);
    }
    expect(typeof Xml.Xml.Writer).toBe("function"); // class
  });

  it("Xml.encode escapes markup", () => {
    expect(Xml.Xml.encode("<a>&")).toBe("&lt;a&gt;&amp;");
  });

  it("error classes stay flat", () => {
    expect(typeof Xml.XmlError).toBe("function");
  });
});

describe("documonster/formula namespace surface", () => {
  it("Formula namespace exposes tokenize/parse", () => {
    for (const m of ["tokenize", "parse"]) {
      expect(isFn(Formula.Formula, m), `Formula.${m}`).toBe(true);
    }
    expect("calculate" in Formula.Formula).toBe(false);
  });

  it("Formula.tokenize produces tokens", () => {
    const tokens = Formula.Formula.tokenize("=1+2");
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens.length).toBeGreaterThan(0);
  });
});
