/**
 * `doc_search`, `doc_edit` and `doc_paginate` tests.
 *
 * The format search and the page computation are the two capabilities here that
 * nothing else can substitute for, so both are asserted against known-good
 * fixtures rather than merely exercised. Replacement is checked for the case
 * that actually breaks naive implementations: a match Word has split across
 * several runs.
 */

import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Build, Document, Io, Layout, Query } from "documonster/word";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { docPaginateTool } from "../tools/doc-paginate.js";
import { docEditTool, docSearchTool } from "../tools/doc-search.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-docsearch-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function run(
  tool: typeof docSearchTool,
  fx: Fixture,
  args: Record<string, unknown>
): Promise<string> {
  const result = await tool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

/**
 * A contract-like document with formatting worth searching for, and a phrase
 * deliberately split across two runs.
 */
async function makeDocument(fx: Fixture, name = "contract.docx"): Promise<string> {
  const doc = Document.create();
  Document.addHeading(doc, "Service Agreement", 1);
  Document.addParagraph(doc, "Acme Corp agrees to the terms. Acme Corp is the client.");
  Document.addParagraphElement(doc, {
    type: "paragraph",
    children: [
      Build.text("CRITICAL RISK", { bold: true, color: "C00000" }),
      Build.text(" — review before signing.")
    ]
  });
  Document.addParagraphElement(doc, {
    type: "paragraph",
    children: [Build.text("Confidential", { highlight: "yellow" })]
  });
  // "Acme Corp" split across two runs, as Word routinely produces.
  Document.addParagraphElement(doc, {
    type: "paragraph",
    children: [Build.text("Signed by Acme "), Build.text("Corp representative.")]
  });
  Document.addHeading(doc, "Schedule", 2);
  Document.addParagraph(doc, "Delivery within 30 days.");
  await Io.writeFile(Document.build(doc), path.join(fx.root, name));
  return name;
}

describe("doc_search — text", () => {
  it("finds every occurrence with its position", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const text = await run(docSearchTool, fx, { path: file, text: "Acme Corp" });

    // Three occurrences: two in one paragraph, one split across runs.
    expect(text).toContain("3 match(es)");
    expect(text).toContain("| offset |");
  });

  it("finds a match split across runs", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    // This phrase exists only as two adjacent runs — a per-run search misses it.
    expect(
      await run(docSearchTool, fx, { path: file, text: "Acme Corp representative" })
    ).toContain("1 match(es)");
  });

  it("supports a regular expression", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const text = await run(docSearchTool, fx, { path: file, text: "Acme\\s+\\w+", regex: true });
    expect(text).toContain("match(es) for pattern");
  });

  it("says plainly when nothing matches, and notes case sensitivity", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const text = await run(docSearchTool, fx, { path: file, text: "acme corp" });
    expect(text).toContain("no match");
    expect(text).toContain("case-sensitive");
  });

  it("rejects an invalid regular expression", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    await expect(
      docSearchTool.handler({ path: file, text: "([unclosed", regex: true }, { config: fx.config })
    ).rejects.toThrow(/not a valid regular expression/);
  });
});

describe("doc_search — formatting", () => {
  it("finds bold text", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const text = await run(docSearchTool, fx, { path: file, format: { bold: true } });
    expect(text).toContain("CRITICAL RISK");
  });

  it("finds text by colour — something reading the document cannot answer", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const text = await run(docSearchTool, fx, { path: file, format: { color: "C00000" } });
    expect(text).toContain("CRITICAL RISK");
    expect(text).not.toContain("review before signing");
  });

  it("finds highlighted text", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    expect(await run(docSearchTool, fx, { path: file, format: { highlight: "yellow" } })).toContain(
      "Confidential"
    );
  });

  it("finds text by paragraph style", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const text = await run(docSearchTool, fx, {
      path: file,
      format: { paragraphStyle: "Heading1" }
    });
    expect(text).toContain("Service Agreement");
    expect(text).not.toContain("Schedule");
  });

  it("narrows a format search with text", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    expect(
      await run(docSearchTool, fx, { path: file, format: { bold: true }, text: "RISK" })
    ).toContain("CRITICAL RISK");
  });

  it("suggests listFormats when a format matches nothing", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const text = await run(docSearchTool, fx, { path: file, format: { color: "00FF00" } });
    expect(text).toContain("no match");
    expect(text).toContain("listFormats");
  });

  it("lists the formats a document actually uses", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const text = await run(docSearchTool, fx, { path: file, listFormats: true });
    expect(text).toContain("format(s)");
    expect(text).toContain("bold");
  });

  it("requires text, format, or listFormats", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    await expect(docSearchTool.handler({ path: file }, { config: fx.config })).rejects.toThrow(
      /needs `text`, `format`, or listFormats/
    );
  });

  it("works under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    const file = await makeDocument(fx);
    expect(await run(docSearchTool, fx, { path: file, format: { bold: true } })).toContain(
      "CRITICAL"
    );
  });
});

describe("doc_edit", () => {
  it("replaces text and preserves formatting", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const report = await run(docEditTool, fx, {
      path: file,
      find: "Acme Corp",
      replace: "Acme Pty Ltd"
    });

    expect(report).toContain("Replaced **3**");
    const doc = await Io.readFile(path.join(fx.root, file));
    const text = Query.extractText(doc);
    expect(text).toContain("Acme Pty Ltd agrees");
    expect(text).not.toContain("Acme Corp");
    // The unrelated bold red run must still be bold and red.
    expect(Query.searchByFormat(doc, { bold: true, color: "C00000" }).map(r => r.text)).toEqual([
      "CRITICAL RISK"
    ]);
  });

  it("replaces a match split across runs", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    await run(docEditTool, fx, {
      path: file,
      find: "Acme Corp representative",
      replace: "authorised signatory"
    });

    const text = Query.extractText(await Io.readFile(path.join(fx.root, file)));
    expect(text).toContain("Signed by authorised signatory.");
  });

  it("supports regex backreferences", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    await run(docEditTool, fx, {
      path: file,
      find: "Acme (Corp)",
      replace: "Globex $1",
      regex: true
    });

    expect(Query.extractText(await Io.readFile(path.join(fx.root, file)))).toContain("Globex Corp");
  });

  it("dryRun reports the count and writes nothing", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const before = await readFile(path.join(fx.root, file));

    const report = await run(docEditTool, fx, {
      path: file,
      find: "Acme Corp",
      replace: "X",
      dryRun: true
    });

    expect(report).toContain("Dry run");
    expect(report).toContain("3 occurrence(s)");
    expect(await readFile(path.join(fx.root, file))).toEqual(before);
  });

  it("reports a no-op instead of rewriting the file when nothing matches", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    const before = await readFile(path.join(fx.root, file));

    const report = await run(docEditTool, fx, { path: file, find: "Nonexistent", replace: "X" });
    expect(report).toContain("No occurrence");
    expect(await readFile(path.join(fx.root, file))).toEqual(before);
  });

  it("writes to `out` and leaves the original alone", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    await run(docEditTool, fx, {
      path: file,
      find: "Acme Corp",
      replace: "Acme Pty Ltd",
      out: "out/renamed.docx"
    });

    expect(Query.extractText(await Io.readFile(path.join(fx.root, file)))).toContain("Acme Corp");
    expect(Query.extractText(await Io.readFile(path.join(fx.root, "out/renamed.docx")))).toContain(
      "Acme Pty Ltd"
    );
    // No backup when writing elsewhere — the original was never at risk.
    await expect(stat(path.join(fx.root, `${file}.bak`))).rejects.toThrow();
  });

  it("backs up before an in-place edit", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    await run(docEditTool, fx, { path: file, find: "Acme Corp", replace: "Z" });

    const backup = await Io.readFile(path.join(fx.root, `${file}.bak`));
    expect(Query.extractText(backup)).toContain("Acme Corp");
  });

  it("is withheld under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    await expect(
      docEditTool.handler({ path: "a.docx", find: "a", replace: "b" }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });

  it("cannot write outside the sandbox root", async () => {
    const fx = await fixture();
    const file = await makeDocument(fx);
    await expect(
      docEditTool.handler(
        { path: file, find: "Acme Corp", replace: "X", out: "../escape.docx" },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "outside_root",
      "expected an outside_root error"
    );
  });
});

describe("doc_paginate", () => {
  /** A document long enough to span several pages, with headings on different ones. */
  async function makeLongDocument(fx: Fixture, name = "long.docx"): Promise<string> {
    const doc = Document.create();
    Document.addHeading(doc, "Alpha", 1);
    for (let index = 0; index < 60; index += 1) {
      Document.addParagraph(
        doc,
        `Alpha body paragraph ${index + 1} with a reasonable amount of text to occupy a full line.`
      );
    }
    Document.addHeading(doc, "Beta", 1);
    for (let index = 0; index < 60; index += 1) {
      Document.addParagraph(
        doc,
        `Beta body paragraph ${index + 1} with a reasonable amount of text to occupy a full line.`
      );
    }
    await Io.writeFile(Document.build(doc), path.join(fx.root, name));
    return name;
  }

  it("reports a page count that matches the layout engine", async () => {
    const fx = await fixture();
    const file = await makeLongDocument(fx);
    const expected = Layout.document(await Io.readFile(path.join(fx.root, file))).pageCount;

    const text = await run(docPaginateTool, fx, { path: file });
    expect(expected).toBeGreaterThan(1);
    expect(text).toContain(`**pages: ${expected}**`);
  });

  it("maps each heading to the page it starts on", async () => {
    const fx = await fixture();
    const file = await makeLongDocument(fx);
    const text = await run(docPaginateTool, fx, { path: file });

    expect(text).toContain("## Headings by page");
    expect(text).toMatch(/\| 1 \| H1 \| Alpha \|/);
    // Beta must be on a later page than Alpha — the whole point of the tool.
    const beta = /\| (\d+) \| H1 \| Beta \|/.exec(text);
    expect(beta).not.toBeNull();
    expect(Number(beta?.[1])).toBeGreaterThan(1);
  });

  it("writes nothing unless updateFields is set", async () => {
    const fx = await fixture();
    const file = await makeLongDocument(fx);
    const before = await readFile(path.join(fx.root, file));

    const text = await run(docPaginateTool, fx, { path: file });
    expect(text).toContain("Nothing was written");
    expect(await readFile(path.join(fx.root, file))).toEqual(before);
  });

  it("updates fields and the table of contents on request", async () => {
    const fx = await fixture();
    const file = await makeLongDocument(fx);
    const report = await run(docPaginateTool, fx, { path: file, updateFields: true });

    expect(report).toContain("recomputed");
    // Still a readable document afterwards.
    const doc = await Io.readFile(path.join(fx.root, file));
    expect(Query.extractText(doc)).toContain("Alpha");
    // And a backup was taken.
    await expect(stat(path.join(fx.root, `${file}.bak`))).resolves.toBeDefined();
  });

  it("can write the updated document elsewhere", async () => {
    const fx = await fixture();
    const file = await makeLongDocument(fx);
    await run(docPaginateTool, fx, { path: file, updateFields: true, out: "out/updated.docx" });

    await expect(stat(path.join(fx.root, "out/updated.docx"))).resolves.toBeDefined();
    await expect(stat(path.join(fx.root, `${file}.bak`))).rejects.toThrow();
  });

  it("says so for a document with no headings", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Just one paragraph.");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "flat.docx"));

    expect(await run(docPaginateTool, fx, { path: "flat.docx" })).toContain("no headings");
  });

  it("rejects a non-Word file", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "fake.docx"), "nope", "utf8");
    await expect(
      docPaginateTool.handler({ path: "fake.docx" }, { config: fx.config })
    ).rejects.toThrow(/could not read fake\.docx as a Word document/);
  });

  it("refuses to update fields under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    const file = await makeLongDocument(fx);
    await expect(
      docPaginateTool.handler({ path: file, updateFields: true }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });
});
