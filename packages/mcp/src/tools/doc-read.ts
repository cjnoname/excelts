/**
 * `doc_read` — read a document's text content.
 *
 * Covers Word, PDF, Markdown and plain text behind one tool because from the
 * caller's point of view they are the same request: "what does this say". The
 * differences that do matter are surfaced in the output — Word gains structure
 * (headings, tables), PDF gains page boundaries — rather than in the schema.
 *
 * Word output is Markdown rather than flat text: headings, lists and tables
 * survive, which is what lets a model answer questions about structure instead
 * of only about words.
 */

import { readFile } from "node:fs/promises";

import { Pdf } from "documonster/pdf";
import { Io, Query } from "documonster/word";
import { renderToMarkdown } from "documonster/word/markdown";
import { z } from "zod";

import { toolError } from "../errors.js";
import { resolveInRoot } from "../sandbox.js";
import { describeFences } from "./diagram.js";
import {
  continuationNote,
  parsePages,
  requireFormat,
  takeLines,
  type DocFormat
} from "./document.js";
import { assertReadableSize } from "./fs-helpers.js";
import { formatBytes, textResult } from "./result.js";
import { defineTool } from "./types.js";

/** Lines returned when the caller does not say. */
const DEFAULT_MAX_LINES = 200;

export const docReadTool = defineTool({
  name: "doc_read",
  group: ["word", "pdf"],
  title: "Read a document's text",
  description:
    "Read the text of a .docx, .pdf, .md, .txt or .mmd file. Word documents come back as Markdown so headings, lists and tables survive; PDFs are reported page by page; a Markdown file's ```mermaid fences are indexed so you can draw one without copying its source. Reads a bounded number of lines and always says what it omitted. Call doc_inspect first to learn the file's real type.",
  inputSchema: {
    path: z.string().min(1).describe("Document path, relative to the server root."),
    pages: z
      .union([z.array(z.number().int().positive()), z.string()])
      .optional()
      .describe('PDF only: pages to read, as [1,2,5] or "1-3,7". Omit for all pages.'),
    maxLines: z
      .number()
      .int()
      .positive()
      .max(5000)
      .optional()
      .describe(`Line cap for this call. Defaults to ${DEFAULT_MAX_LINES}.`),
    startLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based line to resume from — use the value the previous call reported."),
    outline: z
      .boolean()
      .optional()
      .describe(
        "Word only: return just the heading outline and document statistics instead of the body. Cheap way to decide what to read."
      )
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;
    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    await assertReadableSize(config, resolved, args.path);
    const format = requireFormat(args.path, "path");

    switch (format) {
      case "docx":
        return textResult(config, await readWord(resolved, args));
      case "pdf":
        return textResult(config, await readPdf(resolved, args));
      case "md":
      case "txt":
      case "html":
      case "mermaid":
        return textResult(config, await readPlainText(resolved, args, format));
      default:
        throw toolError.unsupported(
          `doc_read cannot read .${format} files`,
          format === "xlsx" || format === "csv"
            ? "Use sheet_read for spreadsheets and CSV files."
            : "Supported: .docx, .pdf, .md, .txt, .html, .mmd"
        );
    }
  }
});

async function readWord(resolved: string, args: DocReadArgs): Promise<string> {
  const doc = await Io.readFile(resolved).catch((cause: unknown) => {
    throw toolError.unsupported(
      `could not read ${args.path} as a Word document`,
      "If it is password-protected, that is not supported here yet. Run doc_inspect to confirm the container type — a CFB file is either a legacy .doc or an encrypted .docx.",
      { cause }
    );
  });

  const headings = Query.getHeadings(doc);
  const stats = [
    `- paragraphs: ${Query.paragraphCount(doc)}`,
    `- words: ${Query.countWords(doc)}`,
    `- tables: ${Query.tableCount(doc)}`,
    `- images: ${Query.listImages(doc).length}`
  ];

  if (args.outline === true) {
    const lines = [`# ${args.path} — outline`, "", ...stats, ""];
    if (headings.length === 0) {
      lines.push("This document has no headings.", "", "Read the body with `outline: false`.");
      return lines.join("\n");
    }
    lines.push("## Headings", "");
    for (const heading of headings) {
      lines.push(
        `${"  ".repeat(Math.max(0, heading.level - 1))}- H${heading.level}: ${heading.text}`
      );
    }
    lines.push("", "Read the body by calling again without `outline`.");
    return lines.join("\n");
  }

  const markdown = renderToMarkdown(doc);
  const window = takeLines(markdown, args.startLine ?? 1, args.maxLines ?? DEFAULT_MAX_LINES);

  return [
    `# ${args.path} (Word, as Markdown)`,
    "",
    ...stats,
    `- showing lines ${window.startLine}–${window.endLine} of ${window.totalLines}`,
    ...(headings.length > 0
      ? [`- headings: ${headings.length} (use \`outline: true\` for just the outline)`]
      : []),
    ...continuationNote(window),
    "",
    window.text
  ].join("\n");
}

async function readPdf(resolved: string, args: DocReadArgs): Promise<string> {
  const bytes = await readFile(resolved);
  const wanted = parsePages(args.pages);

  const result = await Pdf.read(new Uint8Array(bytes), {
    extractText: true,
    extractImages: false,
    extractTables: false,
    extractAnnotations: false,
    extractFormFields: false,
    extractBookmarks: true,
    ...(wanted === undefined ? {} : { pages: wanted })
  }).catch((cause: unknown) => {
    throw toolError.unsupported(
      `could not read ${args.path} as a PDF`,
      "If it is password-protected, this tool cannot open it yet.",
      { cause }
    );
  });

  const pageCount = result.metadata?.pageCount ?? result.pages.length;
  const header = [
    `# ${args.path} (PDF)`,
    "",
    `- pages in file: ${pageCount}`,
    `- pages read: ${result.pages.length}${wanted === undefined ? "" : ` (requested ${wanted.join(", ")})`}`,
    `- size: ${formatBytes(bytes.byteLength)}`
  ];

  if (result.metadata?.title !== undefined && result.metadata.title.length > 0) {
    header.push(`- title: ${result.metadata.title}`);
  }
  if (result.bookmarks !== undefined && result.bookmarks.length > 0) {
    header.push(`- bookmarks: ${result.bookmarks.length}`);
  }

  // Page markers are load-bearing: without them a model cannot cite "page 4",
  // and a heading split across a page break reads as two unrelated fragments.
  const body = result.pages
    .map(
      page =>
        `\n## Page ${page.pageNumber}\n\n${page.text.trim().length === 0 ? "_(no extractable text — this page may be a scan)_" : page.text}`
    )
    .join("\n");

  const window = takeLines(body, args.startLine ?? 1, args.maxLines ?? DEFAULT_MAX_LINES);

  const emptyPages = result.pages.filter(page => page.text.trim().length === 0).length;
  if (emptyPages > 0) {
    header.push(
      `- **${emptyPages} page(s) yielded no text.** There is no OCR here, so a scanned page reads as empty — say so rather than inferring content.`
    );
  }

  const warnings = result.pages.flatMap(page => page.warnings ?? []);
  if (warnings.length > 0) {
    header.push(`- parser warnings: ${warnings.slice(0, 3).join("; ")}`);
  }

  header.push(`- showing lines ${window.startLine}–${window.endLine} of ${window.totalLines}`);
  header.push(...continuationNote(window));

  return [...header, window.text].join("\n");
}

/**
 * Read a text file, and route anything in it that is not really text.
 *
 * A Markdown file's mermaid fences arrive here as source code, and a `.mmd` file
 * is nothing but a diagram. Both are shown verbatim — this tool's output is text,
 * and a model cannot see a picture — but the footer names the tool that can draw
 * it, so the model does not resort to copying the source back out through its own
 * reply in order to render it.
 */
async function readPlainText(
  resolved: string,
  args: DocReadArgs,
  format: DocFormat
): Promise<string> {
  const raw = await readFile(resolved, "utf8");
  const window = takeLines(raw, args.startLine ?? 1, args.maxLines ?? DEFAULT_MAX_LINES);

  return [
    `# ${args.path} (${format === "mermaid" ? "Mermaid diagram source" : format})`,
    "",
    `- showing lines ${window.startLine}–${window.endLine} of ${window.totalLines}`,
    ...continuationNote(window),
    "",
    window.text,
    ...(format === "mermaid"
      ? [
          "",
          "This whole file is one diagram. Draw it with",
          `\`diagram_render({ from: ${JSON.stringify(args.path)}, to: "diagram.svg" })\`, or read its`,
          "structure with `diagram_inspect`. Do not paste the source above back as `source`.",
          "",
          "There is no conversion **to** a .mmd file: a diagram is written, not derived."
        ]
      : // The whole file is scanned, not just the returned window, so the indices
        // are stable no matter which lines this call happened to show.
        appendFenceNote(raw))
  ].join("\n");
}

/** The fence index, separated from the body by a blank line when there is one. */
function appendFenceNote(raw: string): string[] {
  const fences = describeFences(raw);
  return fences.length === 0 ? [] : ["", ...fences];
}

interface DocReadArgs {
  readonly path: string;
  readonly pages?: readonly number[] | string;
  readonly maxLines?: number;
  readonly startLine?: number;
  readonly outline?: boolean;
}
