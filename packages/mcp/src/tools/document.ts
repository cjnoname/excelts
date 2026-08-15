/**
 * Shared document helpers for the Word / PDF tools.
 *
 * Concentrates three things the document tools must not each re-derive: which
 * format a path denotes, the awkward corners of the underlying API that were
 * verified empirically, and paginating long text so a tool result never blows
 * the caller's context.
 */

import path from "node:path";

import { toolError } from "../errors.js";

/**
 * Document formats the tools can name.
 *
 * Kept separate from `doc_inspect`'s content sniffing: that answers "what is
 * this file really", while this answers "what has the caller asked for", which
 * for a write target is a question about the extension alone.
 */
export type DocFormat = "docx" | "pdf" | "md" | "html" | "txt" | "xlsx" | "csv" | "odt";

const EXTENSION_FORMATS: Readonly<Record<string, DocFormat>> = {
  ".docx": "docx",
  ".docm": "docx",
  ".pdf": "pdf",
  ".md": "md",
  ".markdown": "md",
  ".html": "html",
  ".htm": "html",
  ".txt": "txt",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".csv": "csv",
  ".odt": "odt"
};

/** Format implied by a path's extension, or `undefined` when unrecognised. */
function formatFromPath(filePath: string): DocFormat | undefined {
  return EXTENSION_FORMATS[path.extname(filePath).toLowerCase()];
}

/**
 * Format implied by a path, or a tool error naming what is supported.
 *
 * Listing the accepted extensions in the error matters: a model that guessed
 * `.doc` can correct itself in one step instead of retrying variations.
 */
export function requireFormat(filePath: string, field: string): DocFormat {
  const format = formatFromPath(filePath);
  if (format === undefined) {
    throw toolError.invalidInput(
      `cannot tell the format of ${field} from its extension: ${JSON.stringify(filePath)}`,
      `Use one of: ${Object.keys(EXTENSION_FORMATS).join(", ")}`
    );
  }
  return format;
}

/**
 * Reject macro-enabled extensions for newly generated output.
 *
 * The writer produces ordinary DOCX/XLSX content. Naming that package `.docm`
 * or `.xlsm` does not make it macro-enabled; worse, rewriting an existing macro
 * file through a path that cannot prove VBA preservation risks silent macro
 * loss. Read operations may still inspect such files.
 */
export function assertNonMacroOutput(filePath: string): void {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".docm" || extension === ".xlsm") {
    throw toolError.unsupported(
      `cannot write ${extension} output safely`,
      `Use ${extension === ".docm" ? ".docx" : ".xlsx"}. A normal OOXML package with a macro-enabled extension is invalid, and this tool does not create or verify a VBA project.`
    );
  }
}

/** A slice of a long text, with enough metadata for the caller to continue. */
export interface TextWindow {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

/**
 * Take a line-bounded window of text.
 *
 * Line-based rather than character-based so the cursor a caller passes back is
 * stable and meaningful: "continue from line 240" survives, whereas a character
 * offset into re-extracted text does not.
 */
export function takeLines(text: string, startLine: number, maxLines: number): TextWindow {
  const lines = text.split("\n");
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, from + maxLines - 1);

  return {
    text: lines.slice(from - 1, to).join("\n"),
    startLine: from,
    endLine: to,
    totalLines: lines.length,
    truncated: to < lines.length
  };
}

/**
 * Render the standard "here is what I left out" footer.
 *
 * Always emitted when content was cut, because a model given a silent partial
 * read will reason over it as though it were complete.
 */
export function continuationNote(window: TextWindow, cursorField = "startLine"): string[] {
  if (!window.truncated) {
    return [];
  }
  return [
    `- **${window.totalLines - window.endLine} more line(s) not shown.** Continue with \`${cursorField}: ${window.endLine + 1}\`.`
  ];
}

/**
 * Normalize a page selection into 1-based page numbers.
 *
 * Accepts `[1,2,5]` or `"1-3,7"`, because a model reaches for both.
 */
export function parsePages(pages: readonly number[] | string | undefined): number[] | undefined {
  if (pages === undefined) {
    return undefined;
  }
  if (typeof pages !== "string") {
    if (pages.length > MAX_SELECTABLE_PAGES) {
      throw toolError.invalidInput(
        `page selection lists ${pages.length} pages, over the ${MAX_SELECTABLE_PAGES} limit`
      );
    }
    return pages.map(page => assertPage(page));
  }

  const out: number[] = [];
  for (const part of pages.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const dash = trimmed.indexOf("-");
    if (dash > 0) {
      const from = assertPage(Number(trimmed.slice(0, dash)));
      const to = assertPage(Number(trimmed.slice(dash + 1)));
      if (to < from) {
        throw toolError.invalidInput(`page range ${JSON.stringify(trimmed)} runs backwards`);
      }
      // Bound the span before expanding it: "1-1000000000" would otherwise
      // allocate a billion entries before any page-count check could reject it.
      if (
        to - from + 1 > MAX_SELECTABLE_PAGES ||
        out.length + (to - from + 1) > MAX_SELECTABLE_PAGES
      ) {
        throw toolError.invalidInput(
          `page selection ${JSON.stringify(trimmed)} covers more than ${MAX_SELECTABLE_PAGES} pages`,
          "Name a narrower range; no document here has that many pages."
        );
      }
      for (let page = from; page <= to; page += 1) {
        out.push(page);
      }
    } else {
      out.push(assertPage(Number(trimmed)));
    }
  }

  if (out.length === 0) {
    throw toolError.invalidInput(
      `could not parse ${JSON.stringify(pages)} as pages`,
      'Use a list like [1,2,5] or a string like "1-3,7".'
    );
  }
  return out;
}

function assertPage(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw toolError.invalidInput(`${value} is not a 1-based page number`);
  }
  return value;
}

/**
 * Whether a PDF can receive a genuine incremental update.
 *
 * `PdfEditor.saveIncremental()` silently falls back to a full rebuild for
 * xref-stream files (PDF 1.5+ without a `trailer` keyword). A full rebuild
 * renumbers objects and invalidates any existing signature, so a tool must not
 * claim "signature preserved" without checking — and callers deserve to know
 * when structure may be reorganised.
 */
export function supportsIncrementalUpdate(bytes: Uint8Array): boolean {
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024));
  return new TextDecoder().decode(tail).includes("trailer");
}

/** Cap on how many pages a selector may name, before it is expanded. */
export const MAX_SELECTABLE_PAGES = 10_000;
