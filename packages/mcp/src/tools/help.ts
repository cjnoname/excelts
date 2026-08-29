/**
 * `documonster_help` — on-demand documentation.
 *
 * Exists to solve a budget problem. Every enabled tool's `inputSchema` is sent
 * to the model on every request, so a schema that spelled out the full option
 * surface of a spreadsheet write would cost thousands of tokens permanently.
 * Instead, tool schemas stay lean and the detail lives here, fetched only when
 * the model actually needs it.
 */

import { z } from "zod";

import { textResult } from "./result.js";
import { defineTool } from "./types.js";

export interface HelpTopic {
  readonly summary: string;
  readonly body: string;
}

/**
 * Topic registry. Add a topic whenever a tool schema has to stay lean but the
 * detail is genuinely needed to use it correctly.
 */
export const HELP_TOPICS = {
  overview: {
    summary: "What this server can do and the order to do it in.",
    body: `# documonster MCP server

Reads, writes and converts Excel, Word, PDF, CSV and ZIP documents on the local
filesystem. All work happens server-side: you send structure and parameters,
never document bytes.

## Working discipline

1. **Always \`doc_inspect\` first.** It is cheap and tells you the file type,
   size, sheet list or page count, and CSV dialect. Reading blind wastes
   context and usually picks the wrong sheet or column.
2. **Then read a narrow range.** Reading a whole large sheet will exhaust your
   context. Ask for the range you need and paginate.
3. **Reference data by path, not by value.** Where a tool accepts a source
   file, pass the path — do not copy rows through your own output. The server
   moves the data without spending your tokens on it.
4. **Reuse returned \`@output/...\` paths.** Plain paths are read-only input.
   Every write returns a path below the separate output root; pass that exact
   path to the next read, edit, convert or archive call.

## Constraints

- Plain paths resolve inside the read-only input root. \`@output/...\` paths
  resolve inside the separate writable output root. Absolute paths and \`..\`
  that escape either root are rejected.
- The server may be running with writes disabled. If so, mutating tools are
  simply absent from your tool list.
- Results are truncated to a fixed character budget, and truncation is always
  marked explicitly. If you see a truncation marker, narrow your request.`
  },

  sandbox: {
    summary: "How paths are resolved and why some are rejected.",
    body: `# Path rules

- Relative paths resolve against the server's root directory.
- Absolute paths are permitted only when they land inside that root.
- Symlinks are followed and then re-checked, so a link pointing outside the
  root is rejected even though it sits inside it.
- URLs are rejected by path arguments. Fetching remote documents is a
  separate, opt-in server capability.

If you get \`[outside_root]\`, the file is genuinely unreachable — do not retry
with a different spelling of the same path. Tell the user the root needs to be
widened.`
  },

  roadmap: {
    summary: "Every tool, grouped by what it does.",
    body: `# Tools

## Orientation
- \`documonster_help\` — this documentation.
- \`doc_inspect\` — identify a file or list a directory. Always first.

## Spreadsheets
- \`sheet_read\` — read a bounded window.
- \`sheet_write\` — create an .xlsx or .xlsb from a spec.
- \`sheet_edit\` — patch an existing .xlsx, .xlsm or .xlsb.
- \`formula_evaluate\` — evaluate a formula against supplied values.

## Documents
- \`doc_read\` — read .docx / .pdf / .md / .txt.
- \`doc_write\` — create a .docx or .pdf from Markdown.
- \`doc_edit\` — find and replace text in a .docx.
- \`doc_search\` — find text, or find text by its formatting.
- \`doc_paginate\` — real page counts and per-heading page numbers.
- \`doc_review\` — compare two versions, or review tracked changes.
- \`doc_convert\` — convert between formats.
- \`pdf_edit\` — watermark, number, stamp, rotate, delete/keep pages, append.

## Forms and templates
- \`template_inspect\` / \`template_fill\` — Word {{placeholder}} templates.
- \`form_fill\` — Word form fields and PDF AcroForms.

## Archives
- \`archive_read\` — list or extract a .zip/.tar.
- \`archive_write\` — package files into a .zip/.tar.

## Not available — say so plainly rather than improvising
- reading a password-protected document
- PDF → Word, or any conversion with a PDF as the source
- OCR: a scanned PDF page yields no text, and a scanned form has no fields
- legacy binary .doc / .xls
- pivot tables and image insertion (the library supports them; no tool does yet)

## Choosing between similar tools
- A Word file with \`{{placeholders}}\` → \`template_fill\`, not \`doc_edit\`.
- A Word file with grey form fields → \`form_fill\`, not \`doc_edit\`.
- Changing ordinary prose → \`doc_edit\`.
- Producing a PDF → make a .docx, .xlsx or .xlsb first, then \`doc_convert\`.
  \`pdf_edit\` changes an existing PDF; it does not create content.
- Two versions of a document → \`doc_review\`, not two \`doc_read\` calls.
- A chart → a \`charts\` entry in \`sheet_write\`, or an \`add_chart\` op in
  \`sheet_edit\`. Charts require XLSX output; there is no separate chart tool.
- Test data → \`generate\` in \`sheet_write\`. Never emit thousands of rows yourself.`
  },

  formulas: {
    summary: "Formula syntax notes and one engine limitation worth knowing.",
    body: `# Formulas

Both \`sheet_write\` (the \`formulas\` map) and \`formula_evaluate\` accept a
formula with or without a leading \`=\`; it is normalized for you.

## Supported

Around 450 functions, including \`XLOOKUP\`, \`XMATCH\`, \`SUMIFS\`, \`LET\`,
dynamic arrays (\`FILTER\`, \`SORT\`, \`UNIQUE\`, \`SEQUENCE\`, \`TEXTSPLIT\`),
statistical, financial (\`XIRR\`, \`PRICE\`, \`COUPNUM\`), engineering and
database functions. Dynamic arrays spill into neighbouring cells, and
\`formula_evaluate\` reports the spilled values.

Higher-order functions work: \`MAP\`, \`REDUCE\`, \`SCAN\`, \`BYROW\`, \`BYCOL\`,
\`MAKEARRAY\`.

## Known limitation

\`LAMBDA\` must be **bound to a name** before it is called. Excel accepts the
immediately-invoked form, this engine does not:

- \`LAMBDA(a,b,a+b)(2,3)\` → \`#NAME?\`
- \`LET(f,LAMBDA(a,b,a+b),f(2,3))\` → \`5\` ✓
- \`REDUCE(0,{1,2,3},LAMBDA(acc,x,acc+x))\` → \`6\` ✓

## Errors are answers

\`#DIV/0!\`, \`#N/A\`, \`#VALUE!\`, \`#NAME?\`, \`#SPILL!\` come back as results,
not tool failures — usually you asked precisely in order to find out. \`#NAME?\`
most often means a misspelled function or an unsupported one.

## Cross-sheet references

In \`sheet_write\`, a formula may reference another sheet in the same spec:
\`SUM('2026-06'!D:D)\`. Quote a sheet name that contains spaces or digits-only.`
  },

  documents: {
    summary: "How the Word / PDF / template / form tools fit together.",
    body: `# Documents

## Reading

\`doc_read\` handles .docx, .pdf, .md and .txt. Word comes back as **Markdown**, so
headings, lists and tables survive. Use \`outline: true\` on a long Word file to
get just the headings before deciding what to read.

PDFs are reported page by page with \`## Page N\` markers, so you can cite a page.
There is **no OCR**: a scanned page reports no extractable text. \`doc_inspect\`
tells you up front whether a PDF has any text at all.

## Writing

\`doc_write\` takes **Markdown** and produces .docx or .pdf. Write the content as
Markdown — that is the input language.

## Converting

\`doc_convert\` moves between formats. PDF is terminal: nothing converts *from* a
PDF, because a faithful PDF→Word conversion does not exist. Lossy conversions
state their loss in the result.

## Which tool for which .docx

Call \`doc_inspect\` and it will tell you, but the rule is:

- \`{{placeholder}}\` tags → \`template_inspect\` then \`template_fill\`
- grey form fields → \`form_fill\`
- tracked changes → \`doc_review\`
- ordinary prose → \`doc_read\` and \`doc_edit\`

Filling a template beats writing a document from scratch whenever one exists:
the styling is the template author's and you cannot break it.`
  },

  editing: {
    summary: "How to change an existing file safely.",
    body: `# Editing existing files

\`sheet_edit\`, \`doc_edit\`, \`pdf_edit\`, \`form_fill\`, \`doc_review\` and
\`doc_paginate\` all change a file someone already has.

## Always read before you edit

Call \`sheet_read\` or \`doc_search\` first. The common failure is not a broken
edit but a **correct edit in the wrong place** — the wrong column, an off-by-one
row, a phrase that also occurs in a footer. Nothing looks wrong afterwards, which
is what makes it dangerous.

## Use dryRun on anything that matters

\`sheet_edit\`, \`doc_edit\` and \`pdf_edit\` accept \`dryRun: true\`: it reports
exactly what would change and writes nothing. Do that whenever the file is the
user's own work rather than something you produced in this session.

## What the tools guarantee

- **Atomic.** \`sheet_edit\` applies every operation in memory first; if one
  fails, the file on disk is untouched.
- **Backed up.** An in-place edit copies the original to \`<name>.bak\`.
- **Narrow.** Only what you name changes.
- **No silent no-ops.** Replacing a phrase that does not occur reports that,
  rather than rewriting the file unchanged.

## Prefer writing a new file

Most of these tools accept \`out\`. An edit that never touches the original
cannot go wrong.`
  }
} as const satisfies Record<string, HelpTopic>;

/** Alias kept short for use inside this module. */
const TOPICS = HELP_TOPICS;

type TopicName = keyof typeof TOPICS;

/**
 * `z.enum` needs a non-empty tuple. `Object.keys` erases the literal key types,
 * so one cast is unavoidable; it is sound because `TOPICS` is a non-empty
 * object literal, and typing it as `TopicName` (rather than `string`) means a
 * renamed topic breaks the handler lookup at compile time.
 */
const TOPIC_NAMES = Object.keys(TOPICS) as [TopicName, ...TopicName[]];

export const helpTool = defineTool({
  name: "documonster_help",
  group: "core",
  title: "documonster help",
  description:
    "Read documentation for this server: usage conventions, path rules, and detailed parameter guidance that is deliberately kept out of tool schemas. Call with no topic to list available topics.",
  inputSchema: {
    topic: z
      .enum(TOPIC_NAMES)
      .optional()
      .describe("Topic to read. Omit to list all topics with one-line summaries.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  mutates: false,
  handler: async (args, context) => {
    const { topic } = args;

    if (topic === undefined) {
      const lines = ["# Available topics", ""];
      for (const [name, entry] of Object.entries(TOPICS)) {
        lines.push(`- \`${name}\` — ${entry.summary}`);
      }
      lines.push("", 'Read one with `documonster_help({ topic: "overview" })`.');
      return textResult(context.config, lines.join("\n"));
    }

    // `z.enum` already rejected unknown topics, so this lookup cannot miss.
    const entry = TOPICS[topic];
    return textResult(context.config, entry?.body ?? "");
  }
});
