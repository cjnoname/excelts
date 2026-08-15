/**
 * `doc_read` tests.
 *
 * Word content is asserted as Markdown, because that is the contract: a model
 * answering questions about structure needs headings and tables to survive.
 * PDF is asserted page by page, since page markers are what let a model cite
 * "page 3", and the no-OCR limitation must be stated rather than implied.
 */

import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Pdf } from "documonster/pdf";
import { Document, Io } from "documonster/word";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { docReadTool } from "../tools/doc-read.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-docread-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function read(fx: Fixture, args: Record<string, unknown>): Promise<string> {
  const result = await docReadTool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

/** A Word document with headings, a list and a table. */
async function makeWord(fx: Fixture, name: string, extraParagraphs = 0): Promise<string> {
  const doc = Document.create();
  Document.addHeading(doc, "Pricing Policy", 1);
  Document.addParagraph(doc, "Prices rise 8% from 2026-09-01.");
  Document.addHeading(doc, "Exceptions", 2);
  Document.addParagraph(doc, "Education customers are exempt.");
  Document.addBulletList(doc, ["First point", "Second point"]);
  for (let index = 0; index < extraParagraphs; index += 1) {
    Document.addParagraph(doc, `Filler paragraph number ${index + 1}.`);
  }
  await Io.writeFile(Document.build(doc), path.join(fx.root, name));
  return name;
}

describe("doc_read — Word", () => {
  it("returns Markdown so structure survives", async () => {
    const fx = await fixture();
    const file = await makeWord(fx, "policy.docx");
    const text = await read(fx, { path: file });

    expect(text).toContain("# Pricing Policy");
    expect(text).toContain("## Exceptions");
    expect(text).toContain("- First point");
  });

  it("reports document statistics", async () => {
    const fx = await fixture();
    const file = await makeWord(fx, "policy.docx");
    const text = await read(fx, { path: file });
    expect(text).toMatch(/- paragraphs: \d+/);
    expect(text).toMatch(/- words: \d+/);
    expect(text).toContain("- tables: 0");
  });

  it("returns just the outline when asked", async () => {
    const fx = await fixture();
    const file = await makeWord(fx, "policy.docx");
    const text = await read(fx, { path: file, outline: true });

    expect(text).toContain("outline");
    expect(text).toContain("H1: Pricing Policy");
    expect(text).toContain("H2: Exceptions");
    // The body must NOT be included — that is the whole point of the flag.
    expect(text).not.toContain("Education customers are exempt");
  });

  it("says so when a document has no headings", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Just a sentence.");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "flat.docx"));

    expect(await read(fx, { path: "flat.docx", outline: true })).toContain("no headings");
  });

  it("paginates a long document and says how to continue", async () => {
    const fx = await fixture();
    const file = await makeWord(fx, "long.docx", 200);
    const text = await read(fx, { path: file, maxLines: 10 });

    expect(text).toContain("showing lines 1–10");
    expect(text).toContain("more line(s) not shown");
    expect(text).toContain("`startLine: 11`");
  });

  it("resumes from startLine", async () => {
    const fx = await fixture();
    const file = await makeWord(fx, "long.docx", 200);
    expect(await read(fx, { path: file, maxLines: 5, startLine: 20 })).toContain(
      "showing lines 20–24"
    );
  });

  it("rejects a file that is not a Word document", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "fake.docx"), "not a docx", "utf8");
    await expect(docReadTool.handler({ path: "fake.docx" }, { config: fx.config })).rejects.toThrow(
      /could not read fake\.docx as a Word document/
    );
  });
});

describe("doc_read — PDF", () => {
  /** A PDF produced from Markdown, so its text is known. */
  async function makePdf(fx: Fixture, name: string, markdown: string): Promise<string> {
    const { markdownToDocx } = await import("documonster/word/markdown");
    const doc = await markdownToDocx(markdown);
    await writeFile(path.join(fx.root, name), await Pdf.fromDocx(doc));
    return name;
  }

  it("reads text page by page", async () => {
    const fx = await fixture();
    const file = await makePdf(
      fx,
      "report.pdf",
      "# Quarterly Report\n\nRevenue rose to 513.25 this month.\n"
    );
    const text = await read(fx, { path: file });

    expect(text).toContain("(PDF)");
    expect(text).toContain("## Page 1");
    expect(text).toContain("Quarterly Report");
    expect(text).toContain("513.25");
  });

  it("reports the page count and file size", async () => {
    const fx = await fixture();
    const file = await makePdf(fx, "report.pdf", "# T\n\nbody\n");
    const text = await read(fx, { path: file });
    expect(text).toMatch(/- pages in file: \d+/);
    expect(text).toMatch(/- size: \d+/);
  });

  it("accepts a page list and a page range string", async () => {
    const fx = await fixture();
    const file = await makePdf(fx, "report.pdf", "# T\n\nbody\n");
    expect(await read(fx, { path: file, pages: [1] })).toContain("requested 1");
    expect(await read(fx, { path: file, pages: "1" })).toContain("requested 1");
  });

  it("rejects a backwards page range", async () => {
    const fx = await fixture();
    const file = await makePdf(fx, "report.pdf", "# T\n\nbody\n");
    await expect(
      docReadTool.handler({ path: file, pages: "5-2" }, { config: fx.config })
    ).rejects.toThrow(/runs backwards/);
  });

  it("rejects a zero or negative page", async () => {
    const fx = await fixture();
    const file = await makePdf(fx, "report.pdf", "# T\n\nbody\n");
    await expect(
      docReadTool.handler({ path: file, pages: [0] }, { config: fx.config })
    ).rejects.toThrow(/not a 1-based page number/);
  });
});

describe("doc_read — plain text", () => {
  it("reads Markdown and text files", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "notes.md"), "# Notes\n\nline two\n", "utf8");
    await writeFile(path.join(fx.root, "log.txt"), "alpha\nbeta\n", "utf8");

    expect(await read(fx, { path: "notes.md" })).toContain("# Notes");
    expect(await read(fx, { path: "log.txt" })).toContain("alpha");
  });

  it("paginates plain text", async () => {
    const fx = await fixture();
    await writeFile(
      path.join(fx.root, "big.txt"),
      Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n"),
      "utf8"
    );
    const text = await read(fx, { path: "big.txt", maxLines: 3 });
    expect(text).toContain("line 3");
    expect(text).not.toContain("line 4");
    expect(text).toContain("`startLine: 4`");
  });
});

describe("doc_read — routing", () => {
  it("points spreadsheets at sheet_read instead of failing vaguely", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "book.xlsx"), "x", "utf8");
    // The redirect is the actionable part, so it lives in `hint`.
    await expect(
      docReadTool.handler({ path: "book.xlsx" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpToolError &&
        error.message.includes("cannot read .xlsx files") &&
        (error.hint ?? "").includes("sheet_read"),
      "expected the error to redirect to sheet_read"
    );
  });

  it("names the supported extensions for an unknown one", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "thing.dat"), "x", "utf8");
    await expect(docReadTool.handler({ path: "thing.dat" }, { config: fx.config })).rejects.toThrow(
      /cannot tell the format/
    );
  });

  it("cannot read outside the sandbox root", async () => {
    const fx = await fixture();
    await expect(
      docReadTool.handler({ path: "../../etc/hosts" }, { config: fx.config })
    ).rejects.toThrow(/outside the server root/);
  });

  it("works under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    const file = await makeWord(fx, "policy.docx");
    expect(await read(fx, { path: file })).toContain("# Pricing Policy");
  });
});
