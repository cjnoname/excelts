/**
 * `doc_search` and `doc_edit` — find and change text in a Word document.
 *
 * `doc_search` covers two questions that look similar and are not:
 *
 *   "where does this phrase appear"   — text search
 *   "which text is red and bold"      — format search
 *
 * The second is the interesting one. A model cannot answer it from a Markdown
 * rendering, because colour and highlight do not survive into Markdown at all,
 * and it is a routine document-review request ("find everything marked urgent").
 *
 * `doc_edit` replaces text across run boundaries. Word habitually splits a
 * phrase across several `w:r` elements, so a naive replacement misses matches or
 * destroys formatting; the underlying engine rebuilds the runs and preserves
 * each surviving run's properties.
 */

import { Io, Query } from "documonster/word";
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
import { escapeTableCell, textResult } from "./result.js";
import { defineTool } from "./types.js";

/** Matches reported in one call. */
const MAX_MATCHES = 100;

/** Source characters kept per table cell, so one long run cannot flood the row. */
const MAX_CELL_CHARS = 200;

const formatCriteria = {
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  font: z.string().optional().describe('Font name, e.g. "Calibri".'),
  color: z
    .string()
    .optional()
    .describe('Text colour as hex RGB without "#", e.g. "C00000" for red.'),
  highlight: z.string().optional().describe('Highlight colour name, e.g. "yellow".'),
  paragraphStyle: z.string().optional().describe('Paragraph style id, e.g. "Heading1" or "Quote".')
};

export const docSearchTool = defineTool({
  name: "doc_search",
  group: "word",
  title: "Search a Word document",
  description:
    "Search a .docx by text or by formatting. Formatting search answers questions that reading the document cannot — 'which text is red', 'what is highlighted', 'everything styled as Heading2' — because colour and highlighting do not survive into text. Give `text` for a phrase search, `format` for an appearance search, or both to narrow.",
  inputSchema: {
    path: z.string().min(1).describe("Document path (.docx), relative to the server root."),
    text: z
      .string()
      .optional()
      .describe("Phrase to find. Combine with `regex` to treat it as a pattern."),
    regex: z
      .boolean()
      .optional()
      .describe("Treat `text` as a JavaScript regular expression. Defaults to false."),
    format: z
      .object(formatCriteria)
      .optional()
      .describe("Appearance to match. Any combination; all given properties must hold."),
    listFormats: z
      .boolean()
      .optional()
      .describe(
        "Instead of searching, list every distinct run format used in the document — useful when you do not yet know what to look for."
      )
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;
    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    await assertReadableSize(config, resolved, args.path);
    const doc = await readWord(resolved, args.path);

    if (args.listFormats === true) {
      const formats = Query.getUsedFormats(doc);
      if (formats.length === 0) {
        return textResult(
          config,
          `# ${args.path}\n\nNo run carries direct formatting — every run inherits from its paragraph style.\n\nSearch by \`format: { paragraphStyle: "…" }\` instead, or read the document with doc_read.`
        );
      }
      return textResult(
        config,
        [
          `# ${args.path} — formats in use`,
          "",
          `${formats.length} distinct run format(s):`,
          "",
          ...formats.map(format => `- \`${JSON.stringify(format)}\``),
          "",
          "Search for one with `format: { … }`."
        ].join("\n")
      );
    }

    if (args.text === undefined && args.format === undefined) {
      throw toolError.invalidInput(
        "doc_search needs `text`, `format`, or listFormats: true",
        'To find a phrase pass text; to find an appearance pass format, e.g. { "color": "C00000" }.'
      );
    }

    // Format search first when given, because it is the narrower axis and can
    // additionally filter on text via textMatch.
    if (args.format !== undefined) {
      return textResult(config, searchByFormat(doc, args));
    }

    return textResult(config, searchByText(doc, args));
  }
});

function searchByText(doc: Awaited<ReturnType<typeof Io.readFile>>, args: SearchArgs): string {
  const query = buildQuery(args);
  const results = Query.searchText(doc, query);

  if (results.length === 0) {
    return [
      `# ${args.path} — no match`,
      "",
      `Nothing matched ${describeQuery(args)}.`,
      "",
      "The search covers the body, tables, headers, footers and footnotes. If you expected a match, check spelling and case — text search is case-sensitive."
    ].join("\n");
  }

  return [
    `# ${args.path} — ${results.length} match(es) for ${describeQuery(args)}`,
    "",
    "| # | paragraph | offset | match |",
    "| --- | --- | --- | --- |",
    ...results
      .slice(0, MAX_MATCHES)
      .map(
        (result, index) =>
          `| ${index + 1} | ${result.paragraphIndex} | ${result.offset} | ${escapeCell(result.match)} |`
      ),
    ...(results.length > MAX_MATCHES
      ? ["", `[${results.length - MAX_MATCHES} more not listed]`]
      : []),
    "",
    "`paragraph` is a document-wide ordinal in reading order, not an index into the body — use it for ordering, not addressing.",
    "",
    "Replace these with doc_edit."
  ].join("\n");
}

function searchByFormat(doc: Awaited<ReturnType<typeof Io.readFile>>, args: SearchArgs): string {
  const criteria = {
    ...args.format,
    ...(args.text === undefined ? {} : { textMatch: buildRegex(args) })
  };

  const results = Query.searchByFormat(doc, criteria);
  const described = JSON.stringify(args.format);

  if (results.length === 0) {
    return [
      `# ${args.path} — no match`,
      "",
      `No text matched the formatting ${described}.`,
      "",
      "Call again with `listFormats: true` to see which formats the document actually uses — a colour may differ from the one you assumed, and text styled by a paragraph style carries no direct run formatting."
    ].join("\n");
  }

  return [
    `# ${args.path} — ${results.length} run(s) matching ${described}`,
    "",
    "| # | location | paragraph | style | text |",
    "| --- | --- | --- | --- | --- |",
    ...results
      .slice(0, MAX_MATCHES)
      .map(
        (result, index) =>
          `| ${index + 1} | ${result.location} | ${result.paragraphIndex} | ${result.paragraphStyle ?? "—"} | ${escapeCell(result.text)} |`
      ),
    ...(results.length > MAX_MATCHES
      ? ["", `[${results.length - MAX_MATCHES} more not listed]`]
      : []),
    "",
    "Matches are individual runs, so one visually continuous phrase may appear as several rows."
  ].join("\n");
}

export const docEditTool = defineTool({
  name: "doc_edit",
  group: "word",
  title: "Replace text in a Word document",
  description:
    "Find and replace text throughout a .docx, preserving all formatting. Handles matches that Word has split across several runs, which a naive replacement would miss. Use dryRun first to see how many matches there are. Everything else in the document is untouched.",
  inputSchema: {
    path: z.string().min(1).describe("Document to edit (.docx), relative to the server root."),
    find: z.string().min(1).describe("Text to replace."),
    replace: z
      .string()
      .describe("Replacement text. With regex: true, $1 refers to the first capture group."),
    regex: z
      .boolean()
      .optional()
      .describe(
        "Treat `find` as a JavaScript regular expression, applied globally. Defaults to false."
      ),
    out: z
      .string()
      .optional()
      .describe(
        "Write below @output/. Required for input files unless --allow-in-place is enabled."
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "Report the match count without writing anything. Do this first on a document the user cares about."
      ),
    backup: z
      .boolean()
      .optional()
      .describe("When editing in place, copy the original to <name>.bak first. Defaults to true."),
    overwrite: z.boolean().optional().describe("Replace an existing `out` file. Defaults to false.")
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  },
  mutates: true,
  handler: async (args, context) => {
    const { config } = context;
    assertWritable(config);

    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    await assertReadableSize(config, resolved, args.path);
    const inputVersion = await fingerprint(resolved);
    const doc = await readWord(resolved, args.path);
    const query = buildQuery(args);

    // Count first, so dryRun and the real run report the same number and a
    // zero-match edit can be reported as a no-op instead of silently rewriting
    // the file.
    const found = Query.searchText(doc, query).length;

    if (found === 0) {
      return textResult(
        config,
        [
          `No occurrence of ${describeQuery(args)} in **${args.path}** — nothing was written.`,
          "",
          "Text search is case-sensitive. Use doc_search to confirm what the document actually contains."
        ].join("\n")
      );
    }

    if (args.dryRun === true) {
      return textResult(
        config,
        [
          `**Dry run** — nothing was written.`,
          `- ${found} occurrence(s) of ${describeQuery(args)} in ${args.path}`,
          `- would be replaced with ${JSON.stringify(args.replace)}`,
          "",
          "Re-run without dryRun to apply."
        ].join("\n")
      );
    }

    const replaced = Query.replaceText(doc, query, args.replace);

    await assertUnchanged(resolved, inputVersion);
    const writeTarget = await resolveEditTarget(config, args.path, args.out);
    const inPlace = isSameFile(writeTarget.path, resolved);
    const backupPath = inPlace && (args.backup ?? true) ? await backupOnce(writeTarget) : undefined;

    if (inPlace) {
      await replaceAtomically(writeTarget.path, temporary => Io.writeFile(doc, temporary));
    } else {
      await writeWithPolicy(writeTarget.path, args.overwrite === true, temporary =>
        Io.writeFile(doc, temporary)
      );
    }

    return textResult(
      config,
      [
        `Replaced **${replaced}** occurrence(s) of ${describeQuery(args)} with ${JSON.stringify(args.replace)}.`,
        `- written to ${writeTarget.display}${inPlace ? " (in place)" : ""}`,
        ...describeBackup(writeTarget.display, backupPath),
        "- all other formatting preserved",
        "",
        "Read it back with doc_read to verify before reporting success to the user."
      ].join("\n")
    );
  }
});

interface SearchArgs {
  readonly path: string;
  readonly text?: string;
  readonly regex?: boolean;
  readonly format?: Record<string, unknown>;
}

/** A string query, or a global regex when `regex` is set. */
function buildQuery(args: {
  readonly find?: string;
  readonly text?: string;
  readonly regex?: boolean;
}): string | RegExp {
  const source = args.find ?? args.text ?? "";
  return args.regex === true ? buildRegex({ text: source, regex: true }) : source;
}

function buildRegex(args: { readonly text?: string; readonly regex?: boolean }): RegExp {
  const source = args.text ?? "";
  try {
    return new RegExp(source, "g");
  } catch (cause) {
    throw toolError.invalidInput(
      `${JSON.stringify(source)} is not a valid regular expression`,
      "Escape any special characters, or drop regex: true for a literal search.",
      { cause }
    );
  }
}

function describeQuery(args: {
  readonly find?: string;
  readonly text?: string;
  readonly regex?: boolean;
}): string {
  const source = args.find ?? args.text ?? "";
  return args.regex === true ? `pattern \`/${source}/g\`` : JSON.stringify(source);
}

/** A match rendered into a table cell, capped so one long run cannot flood a row. */
function escapeCell(text: string): string {
  return escapeTableCell(text, MAX_CELL_CHARS);
}

async function readWord(resolved: string, displayPath: string) {
  return await Io.readFile(resolved).catch((cause: unknown) => {
    throw toolError.unsupported(
      `could not read ${displayPath} as a Word document`,
      "Run doc_inspect to check the real file type; a CFB container is either a legacy .doc or an encrypted .docx.",
      { cause }
    );
  });
}
