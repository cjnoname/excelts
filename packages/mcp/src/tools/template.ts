/**
 * `template_inspect` and `template_fill` — Word templating.
 *
 * The best-shaped pair of tools in this server, because the model's job is
 * reduced to supplying data:
 *
 *   template_inspect  →  "this template wants client.name, items[], signature"
 *   template_fill     →  here is that data as JSON
 *
 * `listTemplateTags` is effectively a self-describing schema, so nothing about
 * the document's internals has to enter the model's context, and the styling,
 * fonts, headers and numbering are whatever the template author set — the model
 * cannot break them. Compared with generating a document from scratch, the
 * surface for error is an order of magnitude smaller.
 */

import path from "node:path";

import { Io, Template } from "documonster/word";
import { z } from "zod";

import { toolError } from "../errors.js";
import { assertWritable, outputDisplay, resolveInRoot, resolveOutputPath } from "../sandbox.js";
import { assertReadableSize, writeWithPolicy } from "./fs-helpers.js";
import { textResult } from "./result.js";
import { defineTool } from "./types.js";

/** Tags listed in one call. */
const MAX_TAGS = 200;

export const templateInspectTool = defineTool({
  name: "template_inspect",
  group: "word",
  title: "List a Word template's placeholders",
  description:
    "List the placeholders in a .docx template — variables, loops and conditionals — with where each appears. Call this before template_fill to learn exactly what data the template expects, instead of guessing field names.",
  inputSchema: {
    path: z.string().min(1).describe("Template path (.docx), relative to the server root.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;
    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    await assertReadableSize(config, resolved, args.path);
    const doc = await readTemplate(resolved, args.path);
    const tags = Template.listTemplateTags(doc);

    if (tags.length === 0) {
      return textResult(
        config,
        [
          `# ${args.path}`,
          "",
          "This document contains no placeholders, so there is nothing for template_fill to do.",
          "",
          "Placeholders look like `{{name}}`, `{{#each items}}…{{/each}}` or `{{#if flag}}…{{/if}}`.",
          "Read the document with doc_read if you wanted its contents."
        ].join("\n")
      );
    }

    const variables = tags.filter(tag => tag.type === "variable");
    const loops = tags.filter(tag => tag.type === "eachOpen");
    const conditionals = tags.filter(tag => tag.type === "ifOpen");

    const lines = [
      `# ${args.path} — template placeholders`,
      "",
      `- total tags: ${tags.length}`,
      `- variables: ${variables.length}`,
      `- loops: ${loops.length}`,
      `- conditionals: ${conditionals.length}`,
      "",
      "| tag | kind | location |",
      "| --- | --- | --- |",
      ...tags
        .slice(0, MAX_TAGS)
        .map(tag => `| \`{{${tag.expression}}}\` | ${tag.type} | ${tag.location} |`)
    ];

    if (tags.length > MAX_TAGS) {
      lines.push("", `[${tags.length - MAX_TAGS} more not listed]`);
    }

    // A worked shape beats prose: the dotted paths and loop names map directly
    // onto the JSON template_fill wants, so the model can build it in one step.
    lines.push("", "## Data shape", "", "```json", buildShape(tags), "```");
    lines.push(
      "",
      "Loop variables written `.name` refer to a property of the current item.",
      "Pass this structure as `data` to template_fill."
    );

    return textResult(config, lines.join("\n"));
  }
});

export const templateFillTool = defineTool({
  name: "template_fill",
  group: "word",
  title: "Fill a Word template",
  description:
    "Fill a .docx template's placeholders from JSON and save the result. Supports variables with dotted paths, {{#each}} loops (including table rows) and {{#if}} conditionals. Call template_inspect first to learn the exact field names. The template's own styling is preserved — you supply only data.",
  inputSchema: {
    template: z.string().min(1).describe("Template path (.docx), relative to the server root."),
    out: z
      .string()
      .min(1)
      .describe("Output .docx path below --output-root; returned as @output/<path>."),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        'Values keyed by placeholder name, e.g. { "client": { "name": "Acme" }, "items": [{ "name": "X", "amount": 10 }], "overdue": true }.'
      ),
    allowMissing: z
      .boolean()
      .optional()
      .describe(
        "Render placeholders with no matching data as empty instead of failing. Defaults to false — failing is safer, because a document silently missing a client name may be sent to that client. Use it only for genuinely optional fields."
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe("Replace the output if it exists. Defaults to false.")
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  mutates: true,
  handler: async (args, context) => {
    const { config } = context;
    assertWritable(config);

    const templatePath = await resolveInRoot(config, args.template, { mustExist: true });
    await assertReadableSize(config, templatePath, args.template);
    const target = await resolveOutputPath(config, args.out);

    if (path.extname(args.out).toLowerCase() !== ".docx") {
      throw toolError.invalidInput(
        `template_fill writes .docx, not ${JSON.stringify(path.extname(args.out))}`,
        "Fill to a .docx, then use doc_convert if you need a PDF."
      );
    }
    // Read fresh: fillTemplate mutates the document in place (verified), so a
    // cached or reused instance would be filled twice.
    const doc = await readTemplate(templatePath, args.template);
    const before = Template.listTemplateTags(doc);

    if (before.length === 0) {
      throw toolError.invalidInput(
        `${args.template} contains no placeholders`,
        "Run template_inspect to confirm; this may not be a template at all."
      );
    }

    try {
      // strict is the engine's default and the right one here: it names the
      // first unresolved placeholder and produces no file, rather than saving a
      // document with a blank where a client's name should be.
      Template.fillTemplate(doc, args.data, { strict: args.allowMissing !== true });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw toolError.invalidInput(
        `filling the template failed: ${message}`,
        /unresolved/i.test(message)
          ? "The message names the placeholder that had no data. Add it to `data` — template_inspect lists every field the template needs — or pass allowMissing: true if it is genuinely optional. No file was written."
          : "Check that every loop name in the template maps to an array in `data`. No file was written.",
        { cause }
      );
    }

    const remaining = Template.listTemplateTags(doc);

    await writeWithPolicy(target, args.overwrite === true, temporary =>
      Io.writeFile(doc, temporary)
    );

    const lines = [
      `Filled **${args.template}** → **${outputDisplay(args.out)}**`,
      `- placeholders in template: ${before.length}`,
      `- placeholders remaining: ${remaining.length}`,
      ...(args.allowMissing === true
        ? ["- `allowMissing` was set, so any field absent from `data` rendered as empty"]
        : [])
    ];

    if (remaining.length > 0) {
      // Left-over tags mean a key was missing — the document still saved, but
      // it now contains literal `{{...}}` text a user would see.
      lines.push(
        "",
        `**${remaining.length} placeholder(s) were not filled** and remain as literal text in the output:`,
        ...remaining.slice(0, 20).map(tag => `- \`{{${tag.expression}}}\` (${tag.location})`),
        "",
        "That usually means a key is missing from `data`. Fix the data and fill again with overwrite: true."
      );
    } else {
      lines.push("- every placeholder was filled");
    }

    lines.push("", "Read the returned @output path with doc_read before reporting success.");
    return textResult(config, lines.join("\n"));
  }
});

/** Build an example JSON shape from the tag list. */
function buildShape(tags: readonly { expression: string; type: string }[]): string {
  const shape: Record<string, unknown> = {};

  for (const tag of tags) {
    if (tag.type === "variable" && !tag.expression.startsWith(".")) {
      assignPath(shape, tag.expression, "…");
    } else if (tag.type === "eachOpen") {
      const name = tag.expression.replace(/^#each\s+/, "").trim();
      if (name.length > 0) {
        assignPath(shape, name, [{ "…": "…" }]);
      }
    } else if (tag.type === "ifOpen") {
      const name = tag.expression.replace(/^#if\s+/, "").trim();
      if (name.length > 0) {
        assignPath(shape, name, true);
      }
    }
  }

  return JSON.stringify(shape, null, 2);
}

/** Set `a.b.c` on a nested object without clobbering a sibling branch. */
function assignPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".").filter(part => part.length > 0);
  if (parts.length === 0) {
    return;
  }

  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (key === undefined) {
      return;
    }
    const existing = cursor[key];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  const last = parts[parts.length - 1];
  if (last !== undefined && cursor[last] === undefined) {
    cursor[last] = value;
  }
}

async function readTemplate(resolved: string, displayPath: string) {
  return await Io.readFile(resolved).catch((cause: unknown) => {
    throw toolError.unsupported(
      `could not read ${displayPath} as a Word document`,
      "Templates must be .docx. Run doc_inspect to check the real file type.",
      { cause }
    );
  });
}
