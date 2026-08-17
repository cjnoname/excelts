/**
 * `doc_inspect` — the cheap first call.
 *
 * Every other tool is expensive in context: reading a sheet or a document body
 * spends thousands of tokens. This one spends a few dozen and answers the
 * questions that stop the model guessing — what kind of file is this, how big,
 * and for CSV, which delimiter and line ending is it actually using.
 *
 * The CSV dialect fields are why this tool imports from the core package: a
 * model has no way to know that a "csv" is semicolon-separated with a BOM,
 * and getting it wrong silently produces a one-column table.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { ArchiveFile } from "documonster/archive";
import { Csv } from "documonster/csv";
import { Workbook } from "documonster/excel";
import { Pdf } from "documonster/pdf";
import { Io, Layout, Query, Template } from "documonster/word";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { toolError } from "../errors.js";
import { resolveInRoot } from "../sandbox.js";
import { formatBytes, textResult } from "./result.js";
import { describeWindow, sheetName, usedWindow } from "./spreadsheet.js";
import { defineTool } from "./types.js";

/** Bytes read from the head of a text file for dialect detection. */
const HEAD_SAMPLE_BYTES = 64 * 1024;

/** Maximum directory entries listed in one call. */
const MAX_DIR_ENTRIES = 200;

/** Detected container / document family. */
type FileKind =
  | "excel"
  | "word"
  | "powerpoint"
  | "pdf"
  | "zip"
  | "tar"
  | "csv"
  | "markdown"
  | "xml"
  | "text"
  | "cfb"
  | "unknown";

export const inspectTool = defineTool({
  name: "doc_inspect",
  group: "core",
  title: "Inspect a document or directory",
  description:
    "Identify a file (type, size, and for CSV its delimiter/line-ending/BOM) or list a directory. Always call this before reading a document: it is cheap and prevents guessing the wrong format, sheet or column.",
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe("File or directory path, relative to the server root. Use '.' for the root itself.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;
    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    const stats = await fs.stat(resolved);
    const displayPath = toDisplayPath(config.root, resolved);

    if (stats.isDirectory()) {
      return textResult(config, await describeDirectory(resolved, displayPath));
    }

    if (!stats.isFile()) {
      throw toolError.unsupported(
        `not a regular file or directory: ${args.path}`,
        "Only files and directories can be inspected."
      );
    }

    return textResult(
      config,
      await describeFile(config, resolved, displayPath, stats.size, stats.mtime)
    );
  }
});

async function describeDirectory(resolved: string, displayPath: string): Promise<string> {
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const sorted = entries.toSorted((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.slice(0, MAX_DIR_ENTRIES);

  // stat every shown entry so the model can judge what is worth reading, in
  // parallel — serial awaits would cost up to MAX_DIR_ENTRIES round trips. A
  // failure on one entry (broken symlink, concurrent delete) must not fail the
  // whole listing, so each result is settled independently.
  const sizes = await Promise.all(
    shown.map(async entry => {
      if (entry.isDirectory()) {
        return undefined;
      }
      try {
        const stats = await fs.stat(path.join(resolved, entry.name));
        return formatBytes(stats.size);
      } catch {
        return "(unreadable)";
      }
    })
  );

  const lines = [`# Directory: ${displayPath}`, "", `${entries.length} entries`, ""];

  for (const [index, entry] of shown.entries()) {
    if (entry.isDirectory()) {
      lines.push(`- \`${entry.name}/\``);
      continue;
    }
    const size = sizes[index];
    lines.push(`- \`${entry.name}\`${size === undefined ? "" : ` — ${size}`}`);
  }

  if (sorted.length > shown.length) {
    lines.push("", `[${sorted.length - shown.length} more entries not listed]`);
  }

  return lines.join("\n");
}

async function describeFile(
  config: ServerConfig,
  resolved: string,
  displayPath: string,
  size: number,
  modified: Date
): Promise<string> {
  const head = await readHead(resolved, HEAD_SAMPLE_BYTES);
  const kind = await detectKind(resolved, head);

  const lines = [
    `# File: ${displayPath}`,
    "",
    `- kind: **${kind}**`,
    `- size: ${formatBytes(size)} (${size} bytes)`,
    `- modified: ${modified.toISOString()}`
  ];

  if (size > config.maxFileSize) {
    lines.push(
      `- **over the server's ${formatBytes(config.maxFileSize)} size limit** — reading it will be rejected`
    );
  }

  const detail = await describeKind(kind, head, resolved, config);
  if (detail.length > 0) {
    lines.push("", ...detail);
  }

  const mismatch = describeExtensionMismatch(resolved, kind);
  if (mismatch.length > 0) {
    lines.push("", ...mismatch);
  }

  return lines.join("\n");
}

/**
 * Warn when the extension claims a format the bytes contradict.
 *
 * This is the payoff for checking magic bytes first. A `.xlsx` that is really a
 * CSV is routine in exported data, and left unflagged the model would confidently
 * hand it to a spreadsheet reader and misread the resulting failure.
 */
function describeExtensionMismatch(filePath: string, kind: FileKind): string[] {
  const claimed = CLAIMED_BY_EXTENSION[path.extname(filePath).toLowerCase()];
  if (claimed === undefined || claimed === kind) {
    return [];
  }
  return [
    `**Extension mismatch**: the name claims \`${claimed}\` but the content is not that format (detected: \`${kind}\`).`,
    "Trust the detected kind, not the extension, and tell the user about the discrepancy."
  ];
}

/** Formats an extension asserts, for cross-checking against detected content. */
const CLAIMED_BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  ".xlsx": "excel",
  ".xlsm": "excel",
  ".xltx": "excel",
  ".docx": "word",
  ".docm": "word",
  ".dotx": "word",
  ".pptx": "powerpoint",
  ".pdf": "pdf",
  ".zip": "zip"
};

/** Per-kind extra facts worth knowing before reading. */
async function describeKind(
  kind: FileKind,
  head: Uint8Array,
  resolved: string,
  config: ServerConfig
): Promise<string[]> {
  switch (kind) {
    case "csv":
      return describeCsv(head);
    case "excel":
      return await describeWorkbook(resolved, config);
    case "word":
      return await describeWordDocument(resolved, config);
    case "pdf":
      return await describePdf(resolved, config);
    case "powerpoint":
      return [
        "This is a PowerPoint package. No tool reads .pptx — say so rather than guessing at its",
        "contents."
      ];
    case "cfb":
      return [
        "This is a CFB/OLE2 container. That means either a legacy binary Office file (.doc/.xls,",
        "which this toolkit does not read) or a password-encrypted OOXML document (which it does,",
        "given the password). Ask the user which, rather than guessing."
      ];
    default:
      return [];
  }
}

/**
 * List a workbook's sheets with their used ranges.
 *
 * This is what makes "always inspect first" pay for itself: the model learns
 * the sheet names and roughly how much data each holds, so its next call names a
 * real sheet and a sensible range instead of guessing and retrying.
 *
 * Opening the package costs the same parse a `sheet_read` would pay, so it is
 * skipped for files over the configured size limit — where reading is refused
 * anyway.
 */
async function describeWorkbook(resolved: string, config: ServerConfig): Promise<string[]> {
  const stats = await fs.stat(resolved);
  if (stats.size > config.maxFileSize) {
    return [
      "This is an Excel workbook, but it is over the size limit, so its sheets were not listed."
    ];
  }

  const wb = Workbook.create();
  try {
    await Workbook.readFile(wb, resolved);
  } catch (cause) {
    return [
      `This looks like an Excel workbook but could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "It may be corrupt, or password-protected."
    ];
  }

  const sheets = Workbook.getWorksheets(wb);
  if (sheets.length === 0) {
    // A valid .xlsx always has at least one sheet, and a ZIP that merely looks
    // like one parses without error into an empty workbook — so report the
    // likely cause rather than the literal finding.
    return [
      "No worksheets were found. A valid Excel workbook always has at least one, so this is most",
      "likely a ZIP file that is not really an .xlsx. Treat the extension as unreliable."
    ];
  }

  const lines = [
    "## Sheets",
    "",
    "| sheet | used range | rows | cols |",
    "| --- | --- | --- | --- |"
  ];
  for (const ws of sheets) {
    const window = usedWindow(ws);
    lines.push(
      window === undefined
        ? `| \`${sheetName(ws)}\` | (empty) | 0 | 0 |`
        : `| \`${sheetName(ws)}\` | ${describeWindow(window)} | ${window.bottom - window.top + 1} | ${window.right - window.left + 1} |`
    );
  }
  lines.push("", "Read one with `sheet_read`, naming the sheet and a range.");
  return lines;
}

/**
 * Describe a Word document, and point at the right tool for it.
 *
 * The routing matters more than the statistics. A `.docx` may be prose, a
 * `{{placeholder}}` template, or a form with legacy fields, and each wants a
 * different tool — `doc_edit`, `template_fill`, `form_fill`. A model that cannot
 * tell them apart reaches for the wrong one and then thrashes, so the answer is
 * given here, in the call the model already makes first.
 */
async function describeWordDocument(resolved: string, config: ServerConfig): Promise<string[]> {
  const stats = await fs.stat(resolved);
  if (stats.size > config.maxFileSize) {
    return ["This is a Word document, but it is over the size limit, so it was not opened."];
  }

  let doc: Awaited<ReturnType<typeof Io.readFile>>;
  try {
    doc = await Io.readFile(resolved);
  } catch (cause) {
    return [
      `This looks like a Word document but could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "It may be corrupt, or password-protected — neither can be read here."
    ];
  }

  const headings = Query.getHeadings(doc);
  const templateTags = Template.listTemplateTags(doc);
  const formFields = Query.extractFormFields(doc);
  const revisions = Query.listRevisions(doc);

  const lines = [
    "## Word document",
    "",
    `- pages: ${Layout.document(doc).pageCount} (computed, no Word needed)`,
    `- paragraphs: ${Query.paragraphCount(doc)} · words: ${Query.countWords(doc)}`,
    `- tables: ${Query.tableCount(doc)} · images: ${Query.listImages(doc).length}`,
    `- headings: ${headings.length}`
  ];

  if (headings.length > 0) {
    lines.push(
      "",
      "Outline:",
      ...headings
        .slice(0, 20)
        .map(
          heading =>
            `${"  ".repeat(Math.max(0, heading.level - 1))}- H${heading.level}: ${heading.text}`
        ),
      ...(headings.length > 20 ? [`  … ${headings.length - 20} more`] : [])
    );
  }

  // The routing advice. Each branch names one tool, because naming two invites
  // the model to try both.
  const routes: string[] = [];
  if (templateTags.length > 0) {
    routes.push(
      `- **This is a template**: ${templateTags.length} \`{{placeholder}}\` tag(s). Use \`template_inspect\` then \`template_fill\` — not doc_edit.`
    );
  }
  if (formFields.length > 0) {
    routes.push(
      `- **This is a form**: ${formFields.length} fillable field(s). Use \`form_fill\` — not doc_edit.`
    );
  }
  if (revisions.length > 0) {
    routes.push(
      `- **Contains ${revisions.length} tracked change(s).** Use \`doc_review\` to list, accept or reject them.`
    );
  }
  if (routes.length === 0) {
    routes.push("- Ordinary prose. Read it with `doc_read`, change text with `doc_edit`.");
  }

  return [...lines, "", ...routes];
}

/**
 * Describe a PDF, including whether there is any text to read at all.
 *
 * The scanned-document case is the one worth catching early: there is no OCR
 * here, so a page image yields nothing, and a model told only "this is a PDF"
 * will read it, get an empty result, and start inventing.
 *
 * The size guard measures and reads through one open descriptor rather than
 * `stat(path)` then `readFile(path)`. Those are two independent lookups, so the
 * name can be repointed at a different file in between and the bytes actually
 * loaded into memory are then the ones nothing checked — which is exactly the
 * limit's purpose. A descriptor cannot be re-bound: what was measured is what is
 * read.
 */
async function describePdf(resolved: string, config: ServerConfig): Promise<string[]> {
  let bytes: Buffer;
  const handle = await fs.open(resolved, "r");
  try {
    const stats = await handle.stat();
    if (stats.size > config.maxFileSize) {
      return ["This is a PDF, but it is over the size limit, so it was not opened."];
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }

  let result: Awaited<ReturnType<typeof Pdf.read>>;
  try {
    result = await Pdf.read(new Uint8Array(bytes), {
      extractText: true,
      extractImages: false,
      extractTables: false,
      extractAnnotations: false,
      extractFormFields: true,
      extractBookmarks: true
    });
  } catch (cause) {
    return [
      `This looks like a PDF but could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "It may be corrupt, or password-protected — a password cannot be supplied here."
    ];
  }

  const pageCount = result.metadata?.pageCount ?? result.pages.length;
  const emptyPages = result.pages.filter(page => page.text.trim().length === 0).length;
  const formFields = result.formFields ?? [];

  const lines = [
    "## PDF",
    "",
    `- pages: ${pageCount}`,
    `- PDF version: ${result.metadata?.pdfVersion ?? "unknown"}${result.metadata?.encrypted ? " · **encrypted**" : ""}`
  ];

  if (result.metadata?.title !== undefined && result.metadata.title.length > 0) {
    lines.push(`- title: ${result.metadata.title}`);
  }
  if ((result.bookmarks?.length ?? 0) > 0) {
    lines.push(`- bookmarks: ${result.bookmarks?.length}`);
  }

  if (formFields.length > 0) {
    lines.push(
      "",
      `- **This is a fillable form**: ${formFields.length} AcroForm field(s). Use \`form_fill\`.`
    );
  }

  if (emptyPages === pageCount) {
    lines.push(
      "",
      "- **No page yields any extractable text.** This is almost certainly a scan. There is no OCR",
      "  here, so its contents cannot be read — say so rather than inferring them.",
      "  You can still watermark, reorder or split it with `pdf_edit`."
    );
  } else if (emptyPages > 0) {
    lines.push(
      "",
      `- ${emptyPages} of ${pageCount} page(s) yield no text — probably scanned pages.`
    );
  } else {
    lines.push("", "- Text is extractable on every page. Read it with `doc_read`.");
  }

  return lines;
}

/** Report the CSV dialect so the model does not have to guess it. */
function describeCsv(head: Uint8Array): string[] {
  // `ignoreBOM: true` is required, despite reading backwards: it means "treat a
  // leading U+FEFF as an ordinary character" rather than silently consuming it.
  // Without it the BOM never reaches the string and we would always report
  // "no BOM" — which is the one thing a caller most needs to know, because a
  // stray BOM corrupts the first column's header.
  const raw = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(head);
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const text = Csv.stripBom(raw);
  const delimiter = Csv.detectDelimiter(text);
  const linebreak = Csv.detectLinebreak(text);
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
  const columns = firstLine.length > 0 ? firstLine.split(delimiter).length : 0;

  return [
    "## CSV dialect (detected from the first 64 KiB)",
    "",
    `- delimiter: \`${describeChar(delimiter)}\``,
    `- line ending: \`${describeChar(linebreak)}\``,
    `- UTF-8 BOM: ${hasBom ? "yes" : "no"}`,
    `- columns in first line: ${columns}`,
    "",
    "Note: character-set detection is not implemented yet. A non-UTF-8 file (for example GBK from",
    "a Chinese Windows export) will decode incorrectly — if the text below looks like mojibake, say",
    "so instead of interpreting it.",
    "",
    "First line:",
    "",
    "```",
    firstLine.slice(0, 500),
    "```"
  ];
}

function describeChar(value: string): string {
  return value.replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

/**
 * Identify the file from its magic bytes, falling back to its extension.
 *
 * Magic bytes come first because extensions lie — a `.xlsx` that is really a
 * CSV is a routine occurrence in exported data.
 */
async function detectKind(filePath: string, head: Uint8Array): Promise<FileKind> {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    return await zipContentKind(filePath);
  }
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "pdf";
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "cfb";
  }
  if (startsWith(head, [0x1f, 0x8b])) {
    return "tar";
  }
  return textKindFromExtension(filePath);
}

/** Identify OOXML by the parts in the ZIP, never by the filename. */
async function zipContentKind(filePath: string): Promise<FileKind> {
  try {
    const archive = await ArchiveFile.fromFile(filePath);
    const names = new Set((await archive.getEntries()).map(entry => entry.path));
    if (names.has("xl/workbook.xml")) {
      return "excel";
    }
    if (names.has("word/document.xml")) {
      return "word";
    }
    if (names.has("ppt/presentation.xml")) {
      return "powerpoint";
    }
  } catch {
    // A malformed ZIP is still best described as ZIP; the archive tool will
    // provide the parse failure if the caller tries to open it.
  }
  return "zip";
}

function textKindFromExtension(filePath: string): FileKind {
  switch (path.extname(filePath).toLowerCase()) {
    case ".csv":
    case ".tsv":
      return "csv";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".xml":
      return "xml";
    case ".tar":
      return "tar";
    case ".txt":
    case ".json":
    case ".log":
      return "text";
    default:
      return "unknown";
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** Read at most `limit` bytes from the head of a file. */
async function readHead(filePath: string, limit: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = new Uint8Array(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    // A fixed byte count can split a multi-byte UTF-8 sequence at the tail;
    // decoding is non-fatal, so that becomes one replacement character at the
    // very end of a 64 KiB sample and cannot affect dialect detection.
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Render a path relative to the sandbox root, so the root itself never leaks. */
function toDisplayPath(root: string, resolved: string): string {
  const relative = path.relative(root, resolved);
  return relative.length === 0 ? "." : relative;
}
