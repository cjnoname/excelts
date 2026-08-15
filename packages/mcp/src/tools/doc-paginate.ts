/**
 * `doc_paginate` — compute a Word document's real page layout.
 *
 * The capability nothing else here can substitute for. "How many pages is this?"
 * and "which page is that heading on?" normally require Microsoft Word: the
 * answer depends on line breaking, font metrics, widow/orphan control and table
 * cell heights. This runs the layout engine and answers without Office
 * installed, and without a rasteriser.
 *
 * It also updates computed field values — PAGE, NUMPAGES, PAGEREF, TOC entries —
 * which otherwise only refresh when a human presses F9 in Word.
 */

import { Io, Layout, Query } from "documonster/word";
import { z } from "zod";

import { toolError } from "../errors.js";
import { assertWritable, resolveEditTarget, resolveInRoot } from "../sandbox.js";
import {
  assertReadableSize,
  assertUnchanged,
  backupOnce,
  describeBackup,
  fingerprint,
  isSameFile,
  replaceAtomically,
  writeWithPolicy
} from "./fs-helpers.js";
import { textResult } from "./result.js";
import { defineTool } from "./types.js";

/** Headings listed in one call. */
const MAX_HEADINGS = 150;

export const docPaginateTool = defineTool({
  name: "doc_paginate",
  group: "word",
  title: "Compute a document's page layout",
  description:
    "Compute how many pages a .docx really is, and which page each heading falls on, by running the layout engine — no Word installation needed. Optionally update computed fields (PAGE, NUMPAGES, PAGEREF) and regenerate the table of contents with correct page numbers, which otherwise only refresh when someone opens the document in Word.",
  inputSchema: {
    path: z.string().min(1).describe("Document path (.docx), relative to the server root."),
    updateFields: z
      .boolean()
      .optional()
      .describe(
        "Recompute field values and the table of contents, then save. Requires a writable server. Defaults to false — pagination alone changes nothing on disk."
      ),
    out: z
      .string()
      .optional()
      .describe(
        "With updateFields, write below @output/. Required for input files unless --allow-in-place is enabled."
      ),
    overwrite: z.boolean().optional().describe("Replace an existing `out` file. Defaults to false.")
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  // Pagination alone writes nothing; only `updateFields` does. Declared
  // non-mutating so page counts stay available on a read-only server, with
  // assertWritable guarding the write path.
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;
    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    await assertReadableSize(config, resolved, args.path);
    const inputVersion = await fingerprint(resolved);
    const doc = await Io.readFile(resolved).catch((cause: unknown) => {
      throw toolError.unsupported(
        `could not read ${args.path} as a Word document`,
        "Run doc_inspect to check the real file type.",
        { cause }
      );
    });

    // Page size always comes from the document's own section properties:
    // Layout.document takes no geometry override, and exposing a parameter the
    // engine ignores would be worse than not having one.
    const layout = Layout.document(doc);

    const lines = [
      `# ${args.path} — page layout`,
      "",
      `- **pages: ${layout.pageCount}**`,
      `- sections: ${layout.sectionPageCounts.length} (${layout.sectionPageCounts.join(", ")} page(s) each)`,
      `- paragraphs: ${Query.paragraphCount(doc)}`,
      `- words: ${Query.countWords(doc)}`,
      "- page size: taken from the document's own section setup"
    ];

    // Walk the body directly rather than using Query.getHeadings: that reports a
    // walk-order ordinal which counts paragraphs nested in tables, whereas
    // contentPages is indexed by body position. Mixing the two misreports pages
    // for any document containing a table.
    const headings = collectHeadings(doc, layout.contentPages);

    if (headings.length > 0) {
      lines.push(
        "",
        "## Headings by page",
        "",
        "| page | level | heading |",
        "| --- | --- | --- |",
        ...headings
          .slice(0, MAX_HEADINGS)
          .map(heading => `| ${heading.page} | H${heading.level} | ${heading.text} |`)
      );
      if (headings.length > MAX_HEADINGS) {
        lines.push("", `[${headings.length - MAX_HEADINGS} more not listed]`);
      }
    } else {
      lines.push("", "This document has no headings, so there is no per-section page map.");
    }

    if (layout.bookmarkPages.size > 0) {
      lines.push(
        "",
        `Bookmarks: ${[...layout.bookmarkPages.entries()]
          .slice(0, 20)
          .map(([name, page]) => `\`${name}\` → page ${page}`)
          .join(", ")}`
      );
    }

    if (args.updateFields !== true) {
      lines.push(
        "",
        "Nothing was written. Pass `updateFields: true` to recompute PAGE / NUMPAGES / PAGEREF fields and the table of contents."
      );
      return textResult(config, lines.join("\n"));
    }

    assertWritable(config);

    const withFields = Io.updateFields(doc);
    const withToc = Io.updateTableOfContents(withFields);

    await assertUnchanged(resolved, inputVersion);
    const writeTarget = await resolveEditTarget(config, args.path, args.out);
    const inPlace = isSameFile(writeTarget.path, resolved);
    const backupPath = inPlace ? await backupOnce(writeTarget) : undefined;

    if (inPlace) {
      await replaceAtomically(writeTarget.path, temporary => Io.writeFile(withToc, temporary));
    } else {
      await writeWithPolicy(writeTarget.path, args.overwrite === true, temporary =>
        Io.writeFile(withToc, temporary)
      );
    }

    lines.push(
      "",
      `Fields and table of contents recomputed and written to ${writeTarget.display}${inPlace ? " (in place)" : ""}.`,
      ...describeBackup(writeTarget.display, backupPath),
      "",
      "Read it back with doc_read to verify before reporting success to the user."
    );

    return textResult(config, lines.join("\n"));
  }
});

interface HeadingPage {
  readonly level: number;
  readonly text: string;
  readonly page: number;
}

/** Headings in body order, each with the page its paragraph starts on. */
function collectHeadings(
  doc: Awaited<ReturnType<typeof Io.readFile>>,
  contentPages: readonly number[]
): HeadingPage[] {
  const found: HeadingPage[] = [];

  doc.body.forEach((item, index) => {
    if (item.type !== "paragraph") {
      return;
    }
    const style = item.properties?.style;
    if (typeof style !== "string") {
      return;
    }
    const match = /^Heading(\d)$/i.exec(style);
    if (match === null) {
      return;
    }

    const text = paragraphText(item);
    if (text.length === 0) {
      return;
    }

    found.push({
      level: Number(match[1] ?? 1),
      text: text.replace(/\|/g, "\\|").slice(0, 120),
      page: contentPages[index] ?? 1
    });
  });

  return found;
}

/** Concatenate a paragraph's text runs. */
function paragraphText(paragraph: { readonly children?: readonly unknown[] }): string {
  let out = "";
  for (const child of paragraph.children ?? []) {
    const content = (child as { content?: readonly { text?: string }[] }).content;
    for (const item of content ?? []) {
      if (typeof item.text === "string") {
        out += item.text;
      }
    }
  }
  return out.trim();
}
