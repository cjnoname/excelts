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
import type { BodyContent, TemplateImage } from "documonster/word";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { McpToolError, toolError } from "../errors.js";
import { assertWritable, outputDisplay, resolveInRoot, resolveOutputPath } from "../sandbox.js";
import { summariseDiagram } from "./diagram.js";
import { assertReadableSize, writeWithPolicy } from "./fs-helpers.js";
import {
  imageSourceShape,
  newImageBudget,
  resolveImageSource,
  toEmu,
  type ResolvedImage
} from "./image.js";
import { textResult } from "./result.js";
import { defineTool } from "./types.js";

/**
 * Widest an image may be inside a template, in points.
 *
 * US Letter less one-inch margins. A template author's page may differ, but Word
 * does not shrink an oversized inline image — it runs it off the paper — so a cap
 * that is occasionally conservative beats one that is occasionally broken.
 */
const MAX_TEMPLATE_IMAGE_WIDTH = 468;

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
    const imageTags = tags.filter(tag => tag.type === "image");

    const lines = [
      `# ${args.path} — template placeholders`,
      "",
      `- total tags: ${tags.length}`,
      `- variables: ${variables.length}`,
      `- loops: ${loops.length}`,
      `- conditionals: ${conditionals.length}`,
      ...(imageTags.length === 0 ? [] : [`- image placeholders: ${imageTags.length}`]),
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

    if (imageTags.length > 0) {
      // These do NOT belong in `data`: a picture cannot travel through JSON, so
      // they take a separate argument naming a file or a diagram. Listing them
      // under the data shape — which is what this tool used to do by omitting
      // them entirely — sends the model to fill them with a string.
      lines.push(
        "",
        "## Image placeholders",
        "",
        ...imageTags.map(tag => {
          const blocker = imageBlocker(tag);
          return blocker === undefined
            ? `- \`{{${tag.expression}}}\` → \`images.${imageKey(tag)}\` (${tag.location})`
            : `- \`{{${tag.expression}}}\` (${tag.location}) — **cannot be filled**: ${blocker}.`;
        }),
        "",
        "Pass the fillable ones in `images`, **not** in `data` — a picture cannot go through",
        'JSON. Each takes a file (`from: "logo.png"`) or a Mermaid diagram',
        '(`source: "flowchart LR…"`), e.g. `images: { logo: { from: "logo.png" } }`.'
      );
    }

    return textResult(config, lines.join("\n"));
  }
});

export const templateFillTool = defineTool({
  name: "template_fill",
  group: "word",
  title: "Fill a Word template",
  description:
    "Fill a .docx template's placeholders from JSON and save the result. Supports variables with dotted paths, {{#each}} loops (including table rows), {{#if}} conditionals, and {{%name}} image placeholders filled from the `images` argument (a file or a Mermaid diagram). Call template_inspect first to learn the exact field names. The template's own styling is preserved — you supply only data.",
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
    images: z
      .record(z.string(), z.object(imageSourceShape))
      .optional()
      .describe(
        'Pictures for the template\'s `{{%name}}` placeholders, keyed without the %. Each takes a .png/.jpg/.gif file or a Mermaid diagram, e.g. { "logo": { "from": "logo.png" }, "flow": { "source": "flowchart LR\\n A --> B" } }. Images go here rather than in `data` because a picture cannot travel through JSON.'
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
    // Read fresh: a fill may mutate the document in place, so a cached or reused
    // instance would be filled twice.
    const doc = await readTemplate(templatePath, args.template);
    const before = Template.listTemplateTags(doc);

    if (before.length === 0) {
      throw toolError.invalidInput(
        `${args.template} contains no placeholders`,
        "Run template_inspect to confirm; this may not be a template at all."
      );
    }

    // Resolved before the fill, so an unreadable picture fails without having
    // half-filled the document. Names are checked against the template's own tags,
    // and the media names against what the template already carries.
    const images = await resolveTemplateImages(config, args.images);
    assertImagePlaceholdersExist(before, [...images.keys()]);
    const media = assignMediaNames(images, doc);
    // Merged *before* the try, so a name collision is reported as itself rather
    // than being caught below and re-labelled "filling the template failed" with
    // the wrong hint attached.
    const templateData = mergeTemplateData(args.data, images, media);

    // Typed explicitly: a bare `let` is implicitly `any`, which would silently
    // erase the tag types read off the result below.
    let filled: ReturnType<typeof Template.fillTemplateEnhanced>;
    try {
      // strict is the engine's default and the right one here: it names the
      // first unresolved placeholder and produces no file, rather than saving a
      // document with a blank where a client's name should be.
      //
      // `fillTemplateEnhanced` rather than `fillTemplate`: it is the same engine
      // plus a pass that understands `{{%image}}`, so this is a superset of the
      // previous behaviour. With the basic fill an image placeholder could only
      // ever end up unresolved, which is why the tool could not fill one at all.
      //
      // **Use the return value.** Unlike `fillTemplate`, the enhanced form is not
      // in-place: substituting an image replaces the whole paragraph, so it builds
      // a new body and deliberately leaves the caller's document untouched — it
      // even clones the headers to stop edits leaking back. Ignoring the result
      // writes the *unfilled* template out, and because the fill itself succeeded
      // nothing reports a failure.
      filled = Template.fillTemplateEnhanced(doc, templateData, {
        strict: args.allowMissing !== true
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw toolError.invalidInput(
        `filling the template failed: ${message}`,
        unresolvedHint(message, before),
        { cause }
      );
    }

    // Prune before writing: the engine registers a picture's bytes when it
    // substitutes the placeholder, and a paragraph removed afterwards by a false
    // {{#if}} leaves those bytes in the package with nothing pointing at them.
    const dropped = pruneUnreferencedMedia(filled, media);

    await writeWithPolicy(target, args.overwrite === true, temporary =>
      Io.writeFile(filled, temporary)
    );

    // Verified against the file on disk, not against the in-memory document the
    // writer was handed: a media part that failed to serialise, or a run pointing
    // at a relationship that does not exist, is invisible until it is read back.
    const verified = await verifyWrittenImages(target, media);
    const remaining = Template.listTemplateTags(filled);

    const lines = [
      `Filled **${args.template}** → **${outputDisplay(args.out)}**`,
      `- placeholders in template: ${before.length}`,
      `- placeholders remaining: ${remaining.length}`,
      ...(args.allowMissing === true
        ? ["- `allowMissing` was set, so any field absent from `data` rendered as empty"]
        : []),
      ...describeFilledImages(images, media, dropped, verified)
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

/**
 * Read every image the caller supplied, keyed by its placeholder name.
 *
 * @throws {McpToolError} from `resolveImageSource` for a missing file, an
 *   unsupported extension or a header that will not parse.
 */
async function resolveTemplateImages(
  config: ServerConfig,
  images: Record<string, unknown> | undefined
): Promise<Map<string, ResolvedImage>> {
  const resolved = new Map<string, ResolvedImage>();
  const budget = newImageBudget();
  for (const [name, spec] of Object.entries(images ?? {})) {
    resolved.set(
      name,
      await resolveImageSource(config, spec as Parameters<typeof resolveImageSource>[1], {
        maxWidthPoints: MAX_TEMPLATE_IMAGE_WIDTH,
        budget
      })
    );
  }
  return resolved;
}

/**
 * Advice for a failed fill, chosen by *what kind* of placeholder was unresolved.
 *
 * The generic "add it to `data`" is actively wrong for an image tag — the caller may
 * have already put it in `images` and be told to move it to the one place it cannot
 * go. For a placeholder the engine cannot reach at all it is wrong twice, because no
 * argument fills that one. An error that sends the model somewhere useless costs a
 * retry loop, so the branch is worth having.
 */
function unresolvedHint(message: string, tags: readonly TagLike[]): string {
  if (!/unresolved/i.test(message)) {
    return "Check that every loop name in the template maps to an array in `data`. No file was written.";
  }
  const named = tags.find(tag => tag.type === "image" && message.includes(`{{${tag.expression}}}`));
  if (named !== undefined) {
    const blocker = imageBlocker(named);
    return blocker === undefined
      ? `\`{{${named.expression}}}\` is an **image** placeholder — pass it in \`images\` (keyed \`${imageKey(named)}\`, without the %), not in \`data\`. A picture cannot travel through JSON. No file was written.`
      : `\`{{${named.expression}}}\` is an image placeholder that nothing can fill: ${blocker}. It needs moving to a paragraph of its own in the document body. No file was written.`;
  }
  return "The message names the placeholder that had no data. Add it to `data` — template_inspect lists every field the template needs — or pass allowMissing: true if it is genuinely optional. No file was written.";
}

/** The subset of a template tag these checks need. */
interface TagLike {
  readonly expression: string;
  readonly type: string;
  readonly location: string;
}

/** An image tag's `images` key — the expression without its `%` marker. */
function imageKey(tag: TagLike): string {
  return tag.expression.replace(/^%/, "");
}

/**
 * Why an image placeholder cannot be filled, or `undefined` when it can.
 *
 * One case is left, and it is architectural rather than an omission: the engine
 * substitutes images in a pass that runs *before* loops are expanded, so a
 * `{{%.photo}}` inside a `{{#each}}` has no current item to read from. One picture
 * per row would need the substitution to happen during expansion, which is a
 * different arrangement of the two passes rather than a missing branch.
 *
 * Table cells and headers/footers used to be here too. Both were fixed in the engine
 * instead — a logo in a header or a letterhead table is what a template author
 * reaches for first, and refusing the commonest layouts was the wrong answer to
 * "the pass does not go there".
 */
function imageBlocker(tag: TagLike): string | undefined {
  if (imageKey(tag).startsWith(".")) {
    return "it is scoped to a {{#each}} item, and images are substituted before loops are expanded — one picture per row is not expressible";
  }
  return undefined;
}

/**
 * Refuse an `images` key the template cannot use, naming which and why.
 *
 * Two kinds of mistake, and silence would be expensive for both. A **misspelled
 * key** leaves the document saved and looking fine with the picture simply absent
 * behind a plausible success message, so the error lists the placeholders that do
 * exist. An **unfillable placeholder** is worse, because the caller did everything
 * right and the limitation is the engine's: without this the failure arrives two
 * passes deeper as "Unresolved variable", advising the model to move the image into
 * `data` — the one place it can never go.
 */
export function assertImagePlaceholdersExist(
  tags: readonly TagLike[],
  imageKeys: readonly string[]
): void {
  if (imageKeys.length === 0) {
    return;
  }
  const imageTags = tags.filter(tag => tag.type === "image");
  const available = imageTags.map(imageKey);

  const unknown = imageKeys.filter(name => !available.includes(name));
  if (unknown.length > 0) {
    throw toolError.invalidInput(
      `the template has no image placeholder for ${unknown.map(name => JSON.stringify(name)).join(", ")}`,
      available.length === 0
        ? "This template contains no `{{%name}}` image placeholder at all. Run template_inspect to see what it does have; an ordinary `{{name}}` cannot hold a picture."
        : `Available image placeholders: ${available.map(name => `{{%${name}}}`).join(", ")}. Key \`images\` without the %.`
    );
  }

  const blocked = imageTags
    .filter(tag => imageKeys.includes(imageKey(tag)))
    .map(tag => ({ tag, reason: imageBlocker(tag) }))
    .filter((entry): entry is { tag: TagLike; reason: string } => entry.reason !== undefined);

  if (blocked.length > 0) {
    throw toolError.unsupported(
      `image placeholder(s) ${blocked.map(entry => `{{${entry.tag.expression}}}`).join(", ")} cannot be filled`,
      `${blocked
        .map(entry => `{{${entry.tag.expression}}} (${entry.tag.location}): ${entry.reason}`)
        .join(
          ". "
        )}. Move the placeholder to a paragraph of its own in the document body, or have the template author place the picture directly — it does not need to be a placeholder to be there. No file was written.`
    );
  }
}

/**
 * The media file name and relationship id a picture will be registered under.
 *
 * Both have to be chosen here, and both have to be unique against the template's
 * *existing* media as well as against each other.
 *
 * The engine de-duplicates registered media **by file name**, so two pictures that
 * happen to share one collapse into a single part while both paragraphs keep their
 * own relationship id — the second placeholder then silently shows the first
 * picture, or points at nothing. That is not a hypothetical: every Mermaid flowchart
 * was named `flowchart-diagram.png`, so any template with two flowchart placeholders
 * produced one picture shown twice.
 */
interface MediaName {
  readonly fileName: string;
  readonly rId: string;
}

/**
 * Give every supplied picture a media name nothing else in the package uses.
 *
 * Derived from the placeholder key, which is unique by construction, rather than
 * from the source file or the diagram kind, which are not.
 */
function assignMediaNames(
  images: Map<string, ResolvedImage>,
  template: { readonly images?: readonly { readonly fileName: string; readonly rId?: string }[] }
): Map<string, MediaName> {
  const takenFiles = new Set((template.images ?? []).map(entry => entry.fileName));
  const takenIds = new Set(
    (template.images ?? []).map(entry => entry.rId).filter((id): id is string => id !== undefined)
  );

  const assigned = new Map<string, MediaName>();
  for (const [name, image] of images) {
    const stem = `mcpimg-${name.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
    const fileName = firstFree(`${stem}.${image.mediaType}`, candidate =>
      takenFiles.has(candidate)
    );
    takenFiles.add(fileName);
    const rId = firstFree(`rId_${stem}`, candidate => takenIds.has(candidate));
    takenIds.add(rId);
    assigned.set(name, { fileName, rId });
  }
  return assigned;
}

/** `name`, or `name-2`, `name-3`… until one is free. */
function firstFree(preferred: string, taken: (candidate: string) => boolean): string {
  if (!taken(preferred)) {
    return preferred;
  }
  const dot = preferred.lastIndexOf(".");
  const stem = dot === -1 ? preferred : preferred.slice(0, dot);
  const extension = dot === -1 ? "" : preferred.slice(dot);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
  throw toolError.invalidInput(`could not find a free media name for ${preferred}`);
}

/**
 * Merge the pictures into the template data without colliding with it.
 *
 * The engine reads an image from the same namespace as everything else — `{{%logo}}`
 * looks up `logo` — so the values have to be merged in. Two consequences, both of
 * which were wrong before:
 *
 * 1. **A dotted key is a path, not a name.** `{{%client.logo}}` resolves `client`
 *    then `logo`, so a flat `data["client.logo"]` is never found. The value is
 *    assigned down the path instead.
 * 2. **A collision must be refused, not silently won.** With `{{logo}}` and
 *    `{{%logo}}` in one template, a flat spread overwrote the text value with the
 *    image object — and the plain placeholder rendered the whole `TemplateImage` as
 *    JSON, pixel bytes included, into the document. Nine hundred characters of
 *    `{"0":137,"1":80,…}` where a client's name belonged.
 */
function mergeTemplateData(
  data: Record<string, unknown>,
  images: Map<string, ResolvedImage>,
  media: Map<string, MediaName>
): Record<string, unknown> {
  // Cloned so the caller's arguments are never mutated; the fill is retried by
  // nothing today, but a mutated `data` would be a trap for whoever adds a retry.
  const merged = structuredCloneSafe(data);
  for (const [name, value] of imageValues(images, media)) {
    const existing = readPath(merged, name);
    if (existing !== undefined) {
      throw toolError.invalidInput(
        `\`images.${name}\` collides with \`data.${name}\``,
        `The template engine reads images from the same namespace as text, so one name cannot be both. Remove ${JSON.stringify(name)} from \`data\`, or rename the image placeholder. No file was written.`
      );
    }
    assignPath(merged, name, value);
  }
  return merged;
}

/** The `TemplateImage` values, keyed by placeholder path. */
function imageValues(
  images: Map<string, ResolvedImage>,
  media: Map<string, MediaName>
): Map<string, TemplateImage> {
  const values = new Map<string, TemplateImage>();
  for (const [name, entry] of media) {
    const image = images.get(name);
    if (image === undefined) {
      continue;
    }
    values.set(name, {
      image: {
        data: image.bytes,
        mediaType: image.mediaType,
        fileName: entry.fileName,
        rId: entry.rId
      },
      // EMU, which is the only unit the engine accepts here.
      width: toEmu(image.width),
      height: toEmu(image.height),
      altText: image.altText
    });
  }
  return values;
}

/** Read a dotted path, or `undefined` when any step is absent. */
function readPath(target: Record<string, unknown>, dotted: string): unknown {
  let cursor: unknown = target;
  for (const part of dotted.split(".").filter(step => step.length > 0)) {
    if (typeof cursor !== "object" || cursor === null) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** A shallow-safe clone of the caller's data, preserving arrays and plain objects. */
function structuredCloneSafe(data: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    clone[key] =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? structuredCloneSafe(value as Record<string, unknown>)
        : value;
  }
  return clone;
}

/**
 * Remove media the finished document does not reference, and say which.
 *
 * Images are substituted *before* conditionals are evaluated, so a `{{%logo}}`
 * inside a `{{#if}}` that turns out false is registered and then removed along with
 * its paragraph. Reporting that is not enough: the bytes stay in the package, and
 * anyone who unzips the `.docx` can recover a picture the document was supposed to
 * withhold. For a signature or an ID photo behind a conditional that is a data leak,
 * not file bloat — so the part is dropped rather than merely mentioned.
 *
 * Only pictures this tool added are considered. The template author's own media may
 * be referenced from parts this walk does not cover, and deleting one because it was
 * not found would be a far worse bug than leaving it.
 */
function pruneUnreferencedMedia(filled: DocumentLike, media: Map<string, MediaName>): string[] {
  const referenced = collectDocumentImageRefs(filled);

  const dropped: string[] = [];
  const ours = new Set<string>();
  for (const [name, entry] of media) {
    if (!referenced.has(entry.rId)) {
      dropped.push(name);
      ours.add(entry.rId);
    }
  }
  if (ours.size > 0) {
    // Reassigned rather than mutated in place: `images` is a readonly array on the
    // document type, and the writer reads whatever is on the object.
    (filled as { images?: readonly unknown[] }).images = (filled.images ?? []).filter(
      entry => entry.rId === undefined || !ours.has(entry.rId)
    );
  }
  return dropped;
}

/** The parts of a filled document these checks walk. */
interface DocumentLike {
  images?: readonly { readonly rId?: string }[];
  readonly body: readonly BodyContent[];
  readonly headers?: ReadonlyMap<
    string,
    { readonly content: { readonly children: readonly unknown[] } }
  >;
  readonly footers?: ReadonlyMap<
    string,
    { readonly content: { readonly children: readonly unknown[] } }
  >;
  readonly footnotes?: readonly { readonly content: readonly unknown[] }[];
  readonly endnotes?: readonly { readonly content: readonly unknown[] }[];
}

/**
 * Every inline-image relationship the whole document references.
 *
 * Not just the body. Once the engine learned to substitute images in headers and
 * footers, a body-only walk reported a header logo as unreferenced — and the pruning
 * below then deleted the picture it had just correctly placed. A check that only
 * looks where it used to be correct is worse than no check, because it destroys
 * output while reporting a problem that does not exist.
 */
function collectDocumentImageRefs(doc: DocumentLike): Set<string> {
  const referenced = new Set<string>();
  collectImageRefs(doc.body, referenced);
  for (const part of [...(doc.headers?.values() ?? []), ...(doc.footers?.values() ?? [])]) {
    collectImageRefs(part.content.children as readonly BodyContent[], referenced);
  }
  for (const note of [...(doc.footnotes ?? []), ...(doc.endnotes ?? [])]) {
    collectImageRefs(note.content as readonly BodyContent[], referenced);
  }
  return referenced;
}

/**
 * Every media file name the whole document references.
 *
 * Names rather than relationship ids, because a relationship is **per part**: an
 * image referenced from a header has an rId in that header's own space, so `rId5` in
 * `word/_rels/document.xml.rels` and `rId_x` in `word/_rels/header1.xml.rels` are
 * unrelated numbers that happen to look comparable. Matching them across parts
 * reported a correctly placed header logo as unverifiable. The engine writes each
 * image run's `name` as its media file name, and those *are* global.
 */
function collectDocumentImageNames(doc: DocumentLike): Set<string> {
  const names = new Set<string>();
  const walk = (blocks: readonly BodyContent[]): void => collectImageRefs(blocks, names, "name");
  walk(doc.body);
  for (const part of [...(doc.headers?.values() ?? []), ...(doc.footers?.values() ?? [])]) {
    walk(part.content.children as readonly BodyContent[]);
  }
  for (const note of [...(doc.footnotes ?? []), ...(doc.endnotes ?? [])]) {
    walk(note.content as readonly BodyContent[]);
  }
  return names;
}

/** Gather every inline-image relationship id, or file name, reachable in a block list. */
function collectImageRefs(
  blocks: readonly BodyContent[],
  into: Set<string>,
  key: "rId" | "name" = "rId"
): void {
  for (const block of blocks) {
    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          // A cell holds paragraphs and further tables, so the walk recurses.
          collectImageRefs(cell.content as readonly BodyContent[], into, key);
        }
      }
      continue;
    }
    if (!("children" in block)) {
      continue;
    }
    for (const run of block.children) {
      if (!("content" in run)) {
        continue;
      }
      for (const entry of run.content) {
        if (entry.type === "image") {
          const value = key === "rId" ? entry.rId : entry.name;
          if (value !== undefined) {
            into.add(value);
          }
        }
      }
    }
  }
}

/**
 * Re-open the written file and confirm each picture really arrived.
 *
 * The in-memory document is what the writer was *handed*, not what it produced. A
 * relationship that failed to serialise, or a run pointing at a part that is not
 * there, looks perfect from the document object and is broken in the file — and the
 * file is the only artefact anyone else will open. Since nothing downstream can look
 * at a picture, this is the last place a false claim can be caught.
 *
 * @returns The placeholder names whose picture is present and resolvable on disk.
 */
async function verifyWrittenImages(
  target: string,
  media: Map<string, MediaName>
): Promise<Set<string>> {
  if (media.size === 0) {
    return new Set();
  }
  const reopened = await Io.readFile(target).catch((cause: unknown) => {
    throw new McpToolError(
      "internal",
      `the document was written but could not be re-opened for verification: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        hint: "The file exists but may be malformed. Read it with doc_read before relying on it.",
        cause
      }
    );
  });

  // Re-reading renumbers relationships, so a picture is matched by its media file
  // name — which `assignMediaNames` made unique for exactly this purpose.
  const byFileName = new Map(
    (reopened.images ?? []).map(entry => [entry.fileName, entry] as const)
  );
  const referenced = collectDocumentImageNames(reopened as DocumentLike);

  const present = new Set<string>();
  for (const [name, entry] of media) {
    const definition = byFileName.get(entry.fileName);
    // Both halves are needed: bytes in the package that nothing points at are dead
    // weight, and a run pointing at a part that is not there is a broken picture.
    if (definition !== undefined && definition.data.length > 0 && referenced.has(entry.fileName)) {
      present.add(name);
    }
  }
  return present;
}

/** Report each picture: where it came from, and whether it is really in the file. */
function describeFilledImages(
  images: Map<string, ResolvedImage>,
  media: Map<string, MediaName>,
  dropped: readonly string[],
  verified: ReadonlySet<string>
): string[] {
  const lines = [...images].map(([name, image]) => {
    const drawn = image.diagram === undefined ? "" : ` — ${summariseDiagram(image.diagram)}`;
    const size = `${Math.round(image.width)}×${Math.round(image.height)} pt`;
    if (dropped.includes(name)) {
      return `- \`{{%${name}}}\` ← ${image.origin} — **not in the output**: its paragraph was removed, most likely by a {{#if}} whose condition was false. Its bytes were dropped from the package too, so nothing is recoverable from the file.`;
    }
    const state = verified.has(name)
      ? ""
      : " — **could not be verified in the written file**; read it with doc_read before relying on it";
    return `- \`{{%${name}}}\` ← ${image.origin} (${size}, \`${media.get(name)?.fileName ?? "?"}\`)${drawn}${state}`;
  });
  if (dropped.length > 0) {
    lines.push(
      `- **${dropped.length} supplied picture(s) are not in the document.** Images are substituted before conditionals are evaluated, so one inside a false {{#if}} is dropped with its block. Do not report it as added.`
    );
  }
  return lines;
}

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
