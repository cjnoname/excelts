/**
 * `template_inspect` and `template_fill` tests.
 *
 * The behaviour that makes this pair worth having is that the template tells
 * the model what data it needs, and that a *missing* key is reported rather
 * than silently leaving `{{placeholder}}` text in a document someone will send
 * to a client. Both get explicit coverage.
 */

import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Document, Io, Query, Template } from "documonster/word";

import { resolveConfig, type ServerConfig } from "../config.js";
import { McpToolError } from "../errors.js";
import { templateFillTool, templateInspectTool } from "../tools/template.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-template-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function run(
  tool: typeof templateInspectTool,
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

/** An invoice template with a variable, a dotted path, a conditional and a loop. */
async function makeTemplate(fx: Fixture, name = "invoice.docx"): Promise<string> {
  const doc = Document.create();
  Document.addHeading(doc, "Invoice {{invoice.number}}", 1);
  Document.addParagraph(doc, "Client: {{client.name}}");
  Document.addParagraph(doc, "Contact: {{client.email}}");
  Document.addParagraph(
    doc,
    "{{#if overdue}}PAYMENT OVERDUE{{else}}Thank you for your business{{/if}}"
  );
  Document.addParagraph(doc, "{{#each items}}{{.name}} — {{.amount}}{{/each}}");
  await Io.writeFile(Document.build(doc), path.join(fx.root, name));
  return name;
}

describe("template_inspect", () => {
  it("lists variables, loops and conditionals with their locations", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);
    const text = await run(templateInspectTool, fx, { path: file });

    expect(text).toContain("`{{invoice.number}}`");
    expect(text).toContain("`{{client.name}}`");
    expect(text).toContain("`{{#if overdue}}`");
    expect(text).toContain("`{{#each items}}`");
    expect(text).toContain("body paragraph");
  });

  it("counts each kind of tag", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);
    const text = await run(templateInspectTool, fx, { path: file });
    expect(text).toMatch(/- variables: \d+/);
    expect(text).toContain("- loops: 1");
    expect(text).toContain("- conditionals: 1");
  });

  it("emits a JSON data shape the model can fill in directly", async () => {
    // This is what removes the guesswork: the shape mirrors the dotted paths.
    const fx = await fixture();
    const file = await makeTemplate(fx);
    const text = await run(templateInspectTool, fx, { path: file });

    expect(text).toContain("## Data shape");
    const json = text.slice(text.indexOf("```json") + 7, text.lastIndexOf("```"));
    const shape = JSON.parse(json) as Record<string, unknown>;

    expect(shape).toHaveProperty("invoice");
    expect(shape).toHaveProperty("client");
    expect(shape.client).toEqual({ name: "…", email: "…" });
    expect(shape.overdue).toBe(true);
    expect(Array.isArray(shape.items)).toBe(true);
  });

  it("says plainly when a document has no placeholders", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "An ordinary document.");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "plain.docx"));

    const text = await run(templateInspectTool, fx, { path: "plain.docx" });
    expect(text).toContain("no placeholders");
    expect(text).toContain("doc_read");
  });

  it("rejects a non-Word file", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "fake.docx"), "nope", "utf8");
    await expect(
      templateInspectTool.handler({ path: "fake.docx" }, { config: fx.config })
    ).rejects.toThrow(/could not read fake\.docx as a Word document/);
  });

  it("works under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    const file = await makeTemplate(fx);
    expect(await run(templateInspectTool, fx, { path: file })).toContain("{{client.name}}");
  });
});

describe("template_fill", () => {
  it("fills variables, dotted paths, conditionals and loops", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);

    const report = await run(templateFillTool, fx, {
      template: file,
      out: "filled.docx",
      data: {
        invoice: { number: "INV-2026-014" },
        client: { name: "Acme Pty Ltd", email: "ap@acme.example" },
        overdue: true,
        items: [
          { name: "Consulting", amount: "12,000" },
          { name: "Support", amount: "3,400" }
        ]
      }
    });

    expect(report).toContain("every placeholder was filled");

    const filled = await Io.readFile(path.join(fx.root, "filled.docx"));
    const text = Query.extractText(filled);
    expect(text).toContain("Invoice INV-2026-014");
    expect(text).toContain("Acme Pty Ltd");
    expect(text).toContain("ap@acme.example");
    expect(text).toContain("PAYMENT OVERDUE");
    expect(text).toContain("Consulting");
    expect(text).toContain("Support");
    // No placeholder syntax may survive into a document a client would see.
    expect(text).not.toContain("{{");
  });

  it("takes the else branch when the condition is false", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);
    await run(templateFillTool, fx, {
      template: file,
      out: "ok.docx",
      data: {
        invoice: { number: "1" },
        client: { name: "N", email: "e" },
        overdue: false,
        items: []
      }
    });

    const text = Query.extractText(await Io.readFile(path.join(fx.root, "ok.docx")));
    expect(text).toContain("Thank you for your business");
    expect(text).not.toContain("PAYMENT OVERDUE");
  });

  it("fails and names the missing field rather than shipping a blank document", async () => {
    // The engine is strict by default, which is the behaviour we want: a
    // document silently missing a client name may be sent to that client.
    const fx = await fixture();
    const file = await makeTemplate(fx);

    await expect(
      templateFillTool.handler(
        {
          template: file,
          out: "partial.docx",
          data: { invoice: { number: "1" }, overdue: false, items: [] }
        },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpToolError &&
        error.message.includes("client.name") &&
        (error.hint ?? "").includes("template_inspect") &&
        (error.hint ?? "").includes("No file was written"),
      "expected the error to name the missing placeholder and say no file was written"
    );

    // And no file may exist.
    const { stat } = await import("node:fs/promises");
    await expect(stat(path.join(fx.root, "partial.docx"))).rejects.toThrow();
  });

  it("renders missing fields as empty when allowMissing is set", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);

    const report = await run(templateFillTool, fx, {
      template: file,
      out: "loose.docx",
      data: { invoice: { number: "INV-9" }, overdue: false, items: [] },
      allowMissing: true
    });

    expect(report).toContain("allowMissing");
    const text = Query.extractText(await Io.readFile(path.join(fx.root, "loose.docx")));
    expect(text).toContain("Invoice INV-9");
    // The absent client name became empty, and left no placeholder behind.
    expect(text).not.toContain("{{");
  });

  it("does not mutate the template on disk", async () => {
    // fillTemplate mutates its in-memory document, so a stale handle would fill
    // twice; this pins that the source file is untouched.
    const fx = await fixture();
    const file = await makeTemplate(fx);
    await run(templateFillTool, fx, {
      template: file,
      out: "one.docx",
      data: {
        invoice: { number: "1" },
        client: { name: "A", email: "b" },
        overdue: false,
        items: []
      }
    });

    const template = await Io.readFile(path.join(fx.root, file));
    expect(Template.listTemplateTags(template).length).toBeGreaterThan(0);
    expect(Query.extractText(template)).toContain("{{invoice.number}}");
  });

  it("can be run twice with different data", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);
    const base = { client: { name: "A", email: "b" }, overdue: false, items: [] };

    await run(templateFillTool, fx, {
      template: file,
      out: "a.docx",
      data: { ...base, invoice: { number: "A-1" } }
    });
    await run(templateFillTool, fx, {
      template: file,
      out: "b.docx",
      data: { ...base, invoice: { number: "B-2" } }
    });

    expect(Query.extractText(await Io.readFile(path.join(fx.root, "a.docx")))).toContain("A-1");
    expect(Query.extractText(await Io.readFile(path.join(fx.root, "b.docx")))).toContain("B-2");
  });

  it("creates the parent directory", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);
    await run(templateFillTool, fx, {
      template: file,
      out: "out/nested/x.docx",
      data: {
        invoice: { number: "1" },
        client: { name: "A", email: "b" },
        overdue: false,
        items: []
      }
    });
    const { stat } = await import("node:fs/promises");
    await expect(stat(path.join(fx.root, "out/nested/x.docx"))).resolves.toBeDefined();
  });

  it("rejects a non-docx output", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);
    await expect(
      templateFillTool.handler({ template: file, out: "x.pdf", data: {} }, { config: fx.config })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpToolError && (error.hint ?? "").includes("doc_convert"),
      "expected a redirect to doc_convert for PDFs"
    );
  });

  it("rejects a template with no placeholders", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Nothing to fill.");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "plain.docx"));

    await expect(
      templateFillTool.handler(
        { template: "plain.docx", out: "o.docx", data: { a: 1 } },
        { config: fx.config }
      )
    ).rejects.toThrow(/contains no placeholders/);
  });

  it("refuses to overwrite unless told to", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);
    const data = {
      invoice: { number: "1" },
      client: { name: "A", email: "b" },
      overdue: false,
      items: []
    };

    await run(templateFillTool, fx, { template: file, out: "o.docx", data });
    await expect(
      templateFillTool.handler({ template: file, out: "o.docx", data }, { config: fx.config })
    ).rejects.toThrow(/already exists/);
    await run(templateFillTool, fx, { template: file, out: "o.docx", data, overwrite: true });
  });

  it("is withheld under --readonly", async () => {
    const fx = await fixture(["--readonly"]);
    await expect(
      templateFillTool.handler(
        { template: "t.docx", out: "o.docx", data: {} },
        { config: fx.config }
      )
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof McpToolError && error.code === "readonly",
      "expected a readonly error"
    );
  });

  it("cannot read or write outside the sandbox root", async () => {
    const fx = await fixture();
    const file = await makeTemplate(fx);
    await expect(
      templateFillTool.handler(
        { template: "../../etc/hosts", out: "o.docx", data: {} },
        { config: fx.config }
      )
    ).rejects.toThrow(/outside (?:the server root|--output-root)/);
    await expect(
      templateFillTool.handler(
        { template: file, out: "../escape.docx", data: {} },
        { config: fx.config }
      )
    ).rejects.toThrow(/outside (?:the server root|--output-root)/);
  });
});
