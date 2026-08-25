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

Reads, writes and converts Excel, Word, PDF, CSV, ZIP and Mermaid documents on the
local filesystem. All work happens server-side: you send structure and parameters,
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
- \`sheet_write\` — create an .xlsx from a spec, images included.
- \`sheet_edit\` — patch an existing .xlsx; \`add_image\` places a picture.
- \`formula_evaluate\` — evaluate a formula against supplied values.

## Documents
- \`doc_read\` — read .docx / .pdf / .md / .txt / .mmd.
- \`doc_write\` — create a .docx or .pdf from Markdown.
- \`doc_edit\` — find and replace text in a .docx.
- \`doc_search\` — find text, or find text by its formatting.
- \`doc_paginate\` — real page counts and per-heading page numbers.
- \`doc_review\` — compare two versions, or review tracked changes.
- \`doc_convert\` — convert between formats.
- \`pdf_edit\` — watermark, number, stamp, draw a diagram, rotate, delete/keep
  pages, append.

## Forms and templates
- \`template_inspect\` / \`template_fill\` — Word {{placeholder}} templates,
  including {{%image}} placeholders.
- \`form_fill\` — Word form fields and PDF AcroForms.

## Diagrams
- \`diagram_inspect\` — parse Mermaid text and report what it means. Writes nothing.
- \`diagram_render\` — draw it as .svg / .png / .pdf.
- A \`\`\`mermaid fence in \`doc_write\` / \`doc_convert\` Markdown becomes an
  embedded picture, not a code block.
- \`pdf_edit\` with \`op: "diagram"\` draws one onto a page of an existing PDF.

## Archives
- \`archive_read\` — list or extract a .zip/.tar.
- \`archive_write\` — package files into a .zip/.tar.

## Not available — say so plainly rather than improvising
- reading a password-protected document
- PDF → Word, or any conversion with a PDF as the source
- OCR: a scanned PDF page yields no text, and a scanned form has no fields
- legacy binary .doc / .xls
- pivot tables (the library supports them; no tool does yet)
- an image in a Word **header or footer** placeholder — the template engine
  substitutes images in the body only

## Choosing between similar tools
- A Word file with \`{{placeholders}}\` → \`template_fill\`, not \`doc_edit\`.
- A Word file with grey form fields → \`form_fill\`, not \`doc_edit\`.
- Changing ordinary prose → \`doc_edit\`.
- Producing a PDF → make a .docx or .xlsx first, then \`doc_convert\`.
  \`pdf_edit\` changes an existing PDF; it does not create content.
- Two versions of a document → \`doc_review\`, not two \`doc_read\` calls.
- A chart of *numbers* → a \`charts\` entry in \`sheet_write\`, or an \`add_chart\` op
  in \`sheet_edit\`. There is no separate chart tool.
- A diagram of *relationships* — a flow, a sequence, a state machine, an ER model
  → \`diagram_render\` with Mermaid text.
- Test data → \`generate\` in \`sheet_write\`. Never emit thousands of rows yourself.
- A picture in a document → see the \`images\` topic. Every destination takes the
  same source shape, and a Mermaid diagram is one of the sources.`
  },

  images: {
    summary: "Putting a picture in a workbook, a template or a PDF — one source shape.",
    body: `# Images

Four destinations take a picture, and they all take it the **same way**:

| Destination | How |
| --- | --- |
| a worksheet | \`images\` in \`sheet_write\`, or \`op: "add_image"\` in \`sheet_edit\` |
| a Word template's \`{{%name}}\` | \`images\` in \`template_fill\` |
| a page of an existing PDF | \`op: "diagram"\` in \`pdf_edit\` (diagrams only) |
| a Word/PDF document you write | a \`\`\`mermaid fence in \`doc_write\`'s Markdown |

## The source shape

Every one of them accepts the same fields, and the **extension decides** what
happens — there is no format argument to get wrong:

- \`from: "logo.png"\` — a \`.png\` / \`.jpg\` / \`.gif\`, embedded as it is.
- \`from: "flow.mmd"\` — a Mermaid file, drawn server-side.
- \`from: "design.md"\` (+ \`index\`) — a \`\`\`mermaid fence out of a Markdown file.
- \`source: "flowchart LR\\n A --> B"\` — Mermaid text you write.

Plus \`width\` / \`height\` in **points** (72 per inch), \`altText\`, and — for
diagram sources — \`theme\` and \`background\`.

A Mermaid diagram is deliberately just *one source of an image* here rather than a
feature of its own. A caller with a PNG on disk has the same route as a caller with
a diagram, and neither has to know how the other works.

These fields work whether or not the \`diagram\` tool group is enabled: that group
governs which tools are listed, and whether a \`\`\`mermaid fence in \`doc_write\`'s
Markdown is *implicitly* turned into a picture. Naming a diagram in \`images\` is an
explicit request, so nothing gates it.

## Sizing

Give **one** of \`width\`/\`height\` and the other follows, keeping the aspect ratio —
an image squashed to a ratio nobody asked for is a defect you cannot see. Give both
and they are taken literally. Give neither and the file's own size is used: its pixels
at the resolution it declares (a PNG's \`pHYs\`, a JPEG's JFIF density), or 96 per inch
when it declares none. A diagram uses its own layout size.

Sizes are in **points**, 72 to the inch. That is not what a worksheet anchor or a Word
drawing stores — those want CSS pixels at 96 and EMU at 914400 — but the conversion is
this server's problem, not yours.

## Damaged files are refused

A file's header parsing is not evidence it works: the first bytes of a truncated PNG
are identical to a whole one's. Every image is checked for integrity before it enters
a document — each PNG chunk's CRC-32, and that its compressed data inflates to exactly
the scanlines its size needs; a JPEG's segment chain reaching its end-of-image marker;
a GIF's block chain reaching its trailer. Truncation is how images actually arrive
broken, and embedding one produces a document showing a broken-image box that no tool
here could ever see. \`doc_inspect\` reports the same damage rather than only refusing
it later.

This is an integrity check, not a decoder: a complete, uncorrupted container whose
pixels a viewer still rejects is a decoder bug rather than a damaged file.

## Limits

One call may place at most **20 pictures**, totalling 64 MiB of source and 80 million
decoded pixels; a Markdown document may embed at most 20 diagrams. These are aggregate,
because twenty images each just under a per-file limit is the same memory as one
enormous one, and every picture is held until the file is written. Split a bigger job
across calls.

In a Word template the width is capped to the 468-point text column, because Word
does not shrink an oversized inline image — it runs it off the paper.

## Anchoring in a worksheet

\`at\` decides which of two genuinely different things you get:

- **A single cell**, \`at: "F2"\` — the picture keeps its own size and hangs from
  that corner. This is "put the logo at F2".
- **A range**, \`at: "A10:H30"\` — the picture is bound to those cells and moves and
  resizes with them. This is "fill this block with the diagram".

## Verifying

Nothing here can show you a picture, so verification is indirect and you have to
know where to look.

- The **write** report names the source, the size and the anchor. For a diagram it
  also reports what the parser recognised — \`flowchart — 5 node(s), 4 edge(s)\` —
  which is the only check there is on the content. See the \`diagrams\` topic.
- **\`sheet_read\`** reports \`images: N\` with each anchor, because a picture
  occupies no cell and so cannot appear in the grid it prints.
- **\`doc_inspect\`** counts them per sheet for a workbook, and \`doc_read\` reports
  \`images: N\` for a Word document.

An anchor is reported as the range you asked for. The file stores the bottom-right
as an *edge* one cell past the last one covered, so a raw reading of it would report
\`A6:H26\` back as \`A6:I27\` — which looks like an off-by-one in the placement rather
than in the description.

## Naming a template image

The key is the placeholder's path without the \`%\`, and a **dotted key is a path**:
\`{{%client.logo}}\` takes \`images: { "client.logo": … }\`.

Images share the engine's data namespace, so a name cannot be both text and a picture.
\`data.logo\` together with \`images.logo\` is refused rather than silently resolved —
it used to render the entire image object, pixel bytes and all, as JSON into the
document.

## Where a template's \`{{%name}}\` may sit

**A paragraph of its own** — in the body, in a table cell, or in a header or footer.
Nested tables work too.

One placement remains impossible: scoped to a \`{{#each}}\` item (\`{{%.photo}}\`).
Images are substituted before loops are expanded, so there is no current item to read
from, and one picture per row is not expressible. \`template_fill\` refuses it up
front and \`template_inspect\` marks it \`cannot be filled\` rather than inventing an
\`images\` key for it. Put the picture outside the loop, or have the template author
place the row images directly.

## One report worth reading carefully

Images are substituted **before** conditionals are evaluated, so a \`{{%logo}}\`
inside a \`{{#if}}\` whose condition turns out false is put in and then removed with
its block. The fill succeeds. \`template_fill\` says so — **not in the output** —
because otherwise the report would claim a picture that is not there, and you would
pass that claim on. Its bytes are dropped from the package too: a picture the document
withholds must not be recoverable by unzipping it.

Every placeholder's picture is verified by **re-opening the written file**, not by
trusting the document that was handed to the writer. If a report says a picture
\`could not be verified\`, read the file with \`doc_read\` before relying on it.`
  },

  diagrams: {
    summary: "Mermaid: which diagram types work, and how to verify one you cannot see.",
    body: `# Diagrams

\`diagram_render\` and \`diagram_inspect\` take **Mermaid** text. \`doc_write\` and
\`doc_convert\` also render \`\`\`mermaid fences found in their Markdown.

## Verify, because you cannot look at it

This is the one place in this server where reading the output back is impossible —
you cannot see a picture. So both tools report the **parsed structure** instead:
every node, edge, participant, task or slice the parser recognised.

Read that list. The parser implements a subset of Mermaid, and a subset fails by
*silently dropping* what it did not understand — a mistyped arrow yields one fewer
edge, not an error. A missing entry in that list is the only symptom, and nothing
about the file itself will look wrong.

Use \`diagram_inspect\` before rendering when the diagram is long or generated: it
writes nothing, works under \`--readonly\`, and tells you the size it would render
at.

## Supported diagram types

\`flowchart\` / \`graph\`, \`sequenceDiagram\`, \`classDiagram\`, \`stateDiagram\`,
\`erDiagram\`, \`gantt\`, \`gitGraph\`, \`mindmap\`, \`timeline\`, \`journey\`,
\`kanban\`, \`quadrantChart\`, \`xychart\`, \`radar\`, \`sankey\`, \`packet\`,
\`block\`, \`pie\`, \`C4Context\` (and the other C4 forms), \`requirementDiagram\`,
\`architecture\`.

The first non-empty line chooses the type. Anything else is rejected with a list of
what is possible, so a wrong guess costs one turn rather than a retry loop.

## Choosing a format

- **\`.svg\`** — smallest, resolution-independent, text stays selectable. The right
  default for anything that will be viewed on a screen or edited later.
- **\`.png\`** — pastes into anything. \`scale\` sets pixels per point; the default
  of 2 is 144 DPI. This is what a \`\`\`mermaid fence becomes inside a document.
- **\`.pdf\`** — one page sized to the diagram, drawn as vectors rather than pixels.

All three come from the *same* display list, so they are the same picture rather
than three renderings that might disagree.

## Colour

\`theme\` picks a colour set: \`default\` reproduces Mermaid's own base theme token
for token; \`dark\` and \`neutral\` are this server's own and are not Mermaid's
themes of those names. \`themeOverrides\` sets individual tokens on top —
\`nodeFill\`, \`nodeStroke\`, \`nodeText\`, \`edge\`, \`groupFill\`, \`palette\` and
the rest. \`palette\` is what colours the slices of a pie, the series of an
xychart or radar, and the bands of a journey or quadrant.

\`background\` defaults to **white**, not transparent: a transparent PNG is
invisible in a dark viewer, and that is a failure you would never see. Pass
\`"transparent"\` explicitly if you are compositing it onto something else.

## Layout

\`rankGap\`, \`nodeGap\`, \`maxLabelWidth\` and \`padding\` tune the graph diagrams
(flowchart, state, class, ER, requirement, C4, architecture). Reach for
\`maxLabelWidth\` first when a diagram comes out too wide — long labels, not the
graph, are usually the cause.

## Embedding in a document

Put a \`\`\`mermaid fence in the Markdown you pass to \`doc_write\`. It is rendered
and embedded as a picture, scaled down if needed to fit the text column — Word does
not shrink an oversized image, it runs it off the page. A fence that fails to parse
is left as a code block and reported, so one bad diagram does not lose the document.
Pass \`diagrams: false\` to keep every fence as code.

## Adding one to a PDF that already exists

\`pdf_edit\` takes \`{ op: "diagram", source | from, pages, x, y, width, height }\`.
It draws **vectors** onto the page rather than pasting a picture, so the diagram
stays sharp at any zoom, and the file is saved as an incremental update — bookmarks,
form fields and signature bytes survive.

Two defaults differ from \`diagram_render\`, both because this draws *over* content
that is already there:

- \`background\` is \`"transparent"\`. A white plate would hide the page beneath it.
- Omitting \`x\`/\`y\` centres it, and omitting \`width\`/\`height\` uses the diagram's
  natural size **shrunk to fit** the page. So \`{ op: "diagram", source, pages: [3] }\`
  lands on the page rather than off the edge of it.

## Everywhere else a diagram can go

A worksheet, and a Word template's \`{{%name}}\` placeholder. Both go through the
generic image source described in the \`images\` topic, where a diagram is one
source among several rather than a special case.`
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

\`doc_read\` handles .docx, .pdf, .md, .txt and .mmd. Word comes back as
**Markdown**, so headings, lists and tables survive. Use \`outline: true\` on a long
Word file to get just the headings before deciding what to read.

A Markdown file's \`\`\`mermaid fences come back as source, because this tool's
output is text — but they are **indexed** in a footer. Draw one with
\`diagram_render({ from, index, to })\`; do not copy the source out through your own
reply to pass it back as \`source\`.

PDFs are reported page by page with \`## Page N\` markers, so you can cite a page.
There is **no OCR**: a scanned page reports no extractable text. \`doc_inspect\`
tells you up front whether a PDF has any text at all.

## Writing

\`doc_write\` takes **Markdown** and produces .docx or .pdf. Write the content as
Markdown — that is the input language. A \`\`\`mermaid fence in it becomes a real
embedded diagram rather than a code block; see the \`diagrams\` topic.

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
