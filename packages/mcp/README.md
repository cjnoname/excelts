# @documonster/mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for
[documonster](https://github.com/documonster/documonster). Gives an AI assistant
the ability to read, write and convert Excel, Word, PDF, CSV and ZIP documents —
and to draw Mermaid diagrams — on the local filesystem.

> **Status: usable.** Twenty-one tools cover spreadsheets, Word, PDF, templates,
> archives and diagrams — reading, writing, editing, searching, converting and
> drawing. See [Deliberately absent](#deliberately-absent) for the intentional
> scope boundaries.

## Install

No install needed — point your MCP client at `npx`.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "documonster": {
      "command": "npx",
      "args": [
        "-y",
        "@documonster/mcp",
        "--root",
        "/path/to/your/documents",
        "--output-root",
        "/path/to/generated"
      ]
    }
  }
}
```

### opencode

`opencode.json`:

```json
{
  "mcp": {
    "documonster": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@documonster/mcp",
        "--root",
        "/path/to/documents",
        "--output-root",
        "/path/to/generated"
      ],
      "enabled": true
    }
  }
}
```

## Options

| Flag                      | Default      | Meaning                                                                                                          |
| ------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `--root <dir>`            | cwd          | Sandbox root. Every path a tool touches must resolve inside it.                                                  |
| `--output-root <dir>`     | private temp | Separate writable root. Outputs are returned as `@output/<path>` for later calls.                                |
| `--allow-in-place`        | off          | Permit edits below `--root`; disabled by default because it weakens isolation.                                   |
| `--readonly`              | off          | Withhold every mutating tool from the model's tool list.                                                         |
| `--enable <groups>`       | all          | Comma-separated tool groups: `core`, `excel`, `word`, `pdf`, `forms`, `archive`, `diagram`. `core` is always on. |
| `--max-file-size <bytes>` | 67108864     | Reject larger input documents.                                                                                   |
| `--max-output-chars <n>`  | 40000        | Truncate tool output — a token budget in disguise.                                                               |
| `--pdf-font <file>`       | none         | TrueType font embedded in every PDF written. See [PDF fonts](#pdf-fonts).                                        |

### PDF fonts

Text outside WinAnsi — CJK, Cyrillic, Greek — needs a font that has glyphs for
it. Without `--pdf-font` the server borrows one from the host, which makes the
result a property of the machine: a laptop with a CJK face produces a readable
PDF, and a container with none produces a page of `.notdef` boxes from the same
Markdown. Every PDF-writing tool now reports which of the two happened, so the
degradation is visible rather than discovered by opening the file.

Naming a font removes the host from the answer:

```json
{
  "mcpServers": {
    "documonster": {
      "command": "npx",
      "args": [
        "-y",
        "@documonster/mcp",
        "--root",
        "/path/to/documents",
        "--pdf-font",
        "/path/to/NotoSansSC-Regular.ttf"
      ]
    }
  }
}
```

It must be a TrueType font — `.ttf` or `.ttc` with `glyf` outlines. A
CFF-flavoured `.otf` is rejected at startup rather than at conversion time,
because the subsetting embedder cannot use CFF outlines: that rules out macOS
PingFang and Hiragino, and the official Noto Sans CJK `.otf`/`.otc` releases, so
reach for Noto Sans SC's `.ttf` build instead.

## Security

An MCP server hands a model the ability to name files, so the boundaries are
part of the design rather than an afterthought.

- **Read-only input by default.** Plain paths resolve below `--root`, and tools
  never write there. New files go to a disjoint private `--output-root`; a path
  returned as `@output/reports/q3.xlsx` can be passed to later tools. Editing an
  input requires an explicit `out`, unless the operator deliberately enables
  the weaker compatibility mode with `--allow-in-place`.
- **Sandbox.** Every path follows symlinks segment by segment and then re-checks
  containment. A symlink inside either root that points outside it is rejected.
- **Read-only mode.** Under `--readonly`, always-writing tools are removed from
  `tools/list`. Conditional tools remain for their read branch — list archive or
  form fields, compare versions, compute pages — while their write branch is
  rejected server-side.
- **No network at all.** This server only reads local files; path arguments
  reject URLs outright. When remote document support is added it will arrive as
  an explicit opt-in flag, because outbound access from a model-driven process
  can be aimed anywhere — including cloud metadata endpoints.
- **Symlinks cannot be used to escape.** Every path is resolved segment by
  segment, so a link inside the root that points outside it is rejected — whether
  its target exists or not, and including sidecar paths such as `<name>.bak` and
  the destination a tool extracts an archive into.
- **Archives are treated as hostile.** Entries are written one at a time through
  the same sandbox check, so a `..` entry name or a pre-planted symlink in the
  destination is refused; symlink entries are never created, file modes are not
  preserved, and the container's own size is checked before it is opened. Entry
  names this server _writes_ are validated too, so it cannot produce a Zip Slip
  payload for someone else.
- **Size limits are enforced, not advertised.** Every tool that opens a document
  checks `--max-file-size` first.
- **Do not rely on your client's approval prompt.** Programmatic clients have no
  prompt, so all of the above is enforced server-side.

The sandbox protects against model-supplied paths and links already present
when a call starts. It is not an OS security boundary against another local
process that can concurrently replace directories inside `--root`; Node does
not expose a portable `openat`/`O_NOFOLLOW` write API. Do not share a writable
server root with an untrusted local account or process while the server runs.

## Tools

| Tool                    | Purpose                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orientation**         |                                                                                                                                                                  |
| `documonster_help`      | Conventions, path rules, and formula/document/editing notes kept out of tool schemas to save context.                                                            |
| `doc_inspect`           | Identify a file (type, size, sheet list, CSV dialect, extension mismatches) or list a directory. Always first.                                                   |
| **Spreadsheets**        |                                                                                                                                                                  |
| `sheet_read`            | Read a bounded window as a Markdown table with column letters and row numbers. Paginates; reports what it omitted.                                               |
| `sheet_write`           | Create an `.xlsx` from a declarative spec. `fromCsv` pulls source data in server-side; `images` places pictures.                                                 |
| `sheet_edit`            | Patch an existing `.xlsx` — cells, ranges, formulas, rows, styles, sheets, images. Atomic, backed up, `dryRun` available.                                        |
| `formula_evaluate`      | Evaluate a formula against supplied values using the real engine (~450 functions). Touches no files.                                                             |
| **Documents**           |                                                                                                                                                                  |
| `doc_read`              | Read `.docx` / `.pdf` / `.md` / `.txt` / `.mmd`. Word returns Markdown; PDFs page by page; a Markdown file's mermaid fences are indexed.                         |
| `doc_write`             | Create a `.docx` or `.pdf` from Markdown.                                                                                                                        |
| `doc_edit`              | Find and replace text in a `.docx`, including matches Word split across runs. Formatting preserved.                                                              |
| `doc_search`            | Find text, or find text **by its formatting** — "which text is red", "what is highlighted".                                                                      |
| `doc_paginate`          | Real page count and per-heading page numbers without Word installed; optionally refresh fields and the TOC.                                                      |
| `doc_convert`           | `docx`→`md`/`html`/`pdf`/`txt`, `md`→`docx`/`pdf`, `xlsx`→`csv`/`pdf`, `csv`→`xlsx`. Lossy conversions state their loss.                                         |
| `pdf_edit`              | Watermark, page numbers, stamps, a Mermaid diagram drawn as vectors, rotate, delete/keep pages, append another PDF. Overlays never rewrite the original content. |
| **Forms and templates** |                                                                                                                                                                  |
| `template_inspect`      | List a template's placeholders and print the JSON shape needed to fill it.                                                                                       |
| `template_fill`         | Fill a Word template from JSON, plus `{{%name}}` image placeholders. A missing field fails loudly rather than shipping a blank.                                  |
| `form_fill`             | List or fill Word form fields and PDF AcroForms. PDF values are verified by re-reading the saved file.                                                           |
| **Diagrams**            |                                                                                                                                                                  |
| `diagram_inspect`       | Parse Mermaid text and report what it means — every node, edge, participant, task or slice recognised. Writes nothing.                                           |
| `diagram_render`        | Draw it as `.svg` / `.png` / `.pdf`. Twenty-one diagram types, themed, from one display list.                                                                    |
| **Archives**            |                                                                                                                                                                  |
| `archive_read`          | List or extract a `.zip`/`.tar`. Guards traversal, decompression bombs and symlink entries.                                                                      |
| `archive_write`         | Package files and directories into a `.zip`/`.tar`, verified by reading it back.                                                                                 |

### Two worked examples

**Spreadsheets** — a zip of CSVs in, a summary out:

```jsonc
archive_read  { "path": "reports.zip" }
archive_read  { "path": "reports.zip", "action": "extract",
                "out": "tmp", "entries": ["*.csv"] }
doc_inspect   { "path": "@output/tmp/june.csv" }               // delimiter? BOM?
formula_evaluate { "formula": "=SUMPRODUCT(A1:A3,B1:B3)", "context": { … } }
sheet_write   { "path": "out/summary.xlsx",
                "sheets": [{ "name": "June", "fromCsv": "@output/tmp/june.csv",
                             "formulas": { "D2": "=B2*C2" } }] }
sheet_read    { "path": "@output/out/summary.xlsx" }           // verify
```

**Documents** — fill a template, deliver a PDF:

```jsonc
template_inspect { "path": "invoice-template.docx" }           // what data is needed?
template_fill    { "template": "invoice-template.docx",
                   "out": "out/INV-014.docx",
                   "data": { "client": { "name": "Acme" },
                             "items": [{ "name": "Consulting", "amount": "12,000" }] } }
doc_convert      { "from": "@output/out/INV-014.docx", "to": "out/INV-014.pdf" }
doc_read         { "path": "@output/out/INV-014.pdf" }         // verify
```

Note what does **not** happen in either: no document bytes and no bulk rows pass
through the model's context. `fromCsv`, the `entries` filter and template data
keep the payload on the server.

### Diagrams

`diagram_render` takes Mermaid text and draws `flowchart`, `sequenceDiagram`,
`classDiagram`, `stateDiagram`, `erDiagram`, `gantt`, `gitGraph`, `mindmap`,
`timeline`, `journey`, `kanban`, `quadrantChart`, `xychart`, `radar`, `sankey`,
`packet`, `block`, `pie`, `C4`, `requirementDiagram` and `architecture` — the same
twenty-one the core library draws, since this is a thin consumer of its public API.

```jsonc
diagram_inspect { "source": "flowchart TD\n  A[Read] --> B{Valid?}\n  B -->|no| A" }
diagram_render  { "source": "…", "to": "arch.svg", "theme": "dark" }
```

**The result reports the parsed structure, and that is the point.** This is the one
place in the server where reading the output back is impossible — nothing can look
at a picture. So both tools answer with what the parser recognised: `3 node(s),
3 edge(s)`, `A (Read)`, `B -[no]-> A`. The parser implements a subset of Mermaid and
a subset fails by _silently dropping_ what it did not understand, so a missing edge
in that list is the only symptom there will ever be.

SVG, PNG and PDF come from the **same display list** rather than three renderers, so
they are the same picture and not three that might disagree. `theme` picks a colour
set (`default` is Mermaid's own base theme token for token; `dark` and `neutral` are
this server's), `themeOverrides` sets individual tokens, and `background` defaults to
white — a transparent PNG is invisible in a dark viewer, which is a failure the model
would never see.

A ` ```mermaid ` fence in the Markdown you give `doc_write` (or in a `.md` file you
pass to `doc_convert`) becomes a real embedded image, scaled to fit the text column:
Word does not shrink an oversized inline image, it runs it off the page. A fence that
fails to parse is left as a code block and reported, so one bad diagram never costs
you the document. `diagrams: false` opts out.

**Onto a PDF that already exists**, `pdf_edit` takes `{ op: "diagram", source, pages }`
and draws **vectors** onto the page — sharp at any zoom, saved as an incremental
update so bookmarks, form fields and signature bytes survive. Two defaults invert
because it draws _over_ existing content: `background` is transparent, and omitting
the position centres the diagram at its natural size shrunk to fit, so the simplest
call lands on the page rather than off the edge of it.

**Reading** is the one direction that stays textual, deliberately: `doc_read` cannot
show you a picture, so it returns a `.mmd` file's source and _indexes_ a Markdown
file's fences instead. The footer names `diagram_render({ from, index, to })` — the
point being that the model never has to copy a diagram's source out through its own
reply in order to draw it.

### Images

A diagram is not a separate kind of thing from a picture, so it is not a separate
argument. Four destinations take an image, and all four take the **same source
shape**, routed by extension rather than by a format flag:

````jsonc
{ "from": "logo.png" }                  // .png / .jpg / .gif — embedded as-is
{ "from": "flow.mmd" }                  // a diagram file — drawn server-side
{ "from": "design.md", "index": 2 }     // a ```mermaid fence out of Markdown
{ "source": "flowchart LR\n A --> B" }  // Mermaid text
````

| Destination                   | How                                                          |
| ----------------------------- | ------------------------------------------------------------ |
| a worksheet                   | `images` in `sheet_write`, `op: "add_image"` in `sheet_edit` |
| a Word template's `{{%name}}` | `images` in `template_fill`                                  |
| a page of an existing PDF     | `op: "diagram"` in `pdf_edit`                                |
| a document you write          | a ` ```mermaid ` fence in `doc_write`'s Markdown             |

```jsonc
sheet_write   { "path": "out/report.xlsx", "sheets": [{ "name": "June",
                  "images": [{ "at": "F2", "from": "logo.png" },
                             { "at": "A10:H30", "source": "flowchart LR\n A --> B" }] }] }
template_fill { "template": "invoice.docx", "out": "out/INV.docx",
                "data": { "client": "Acme" },
                "images": { "logo": { "from": "logo.png" } } }
```

Four details are worth knowing, because each was a real defect before it was a rule.
**A worksheet anchor means two different things**: a single cell (`"F2"`) hangs the
picture at its own size, a range (`"A10:H30"`) binds it to those cells so it moves
_and resizes_ with them — offering only one silently answers half the requests
wrongly. **One dimension implies the other**, keeping the aspect ratio, because an
image squashed to a ratio nobody asked for is a defect the model cannot see. **A
declared resolution is honoured** — a PNG's `pHYs`, a JPEG's JFIF density — because
Word and Excel honour it, so ignoring it placed a 300-dpi photograph at three times
its intended size. And **a header that will not parse is an error**, not a 1×1
placement: the library's own reader answers 1×1 for an unreadable file, which is right
for a renderer that must draw something and wrong here, where the result would be
invisible and unreportable.

Sizes are in points. A single call may place 20 pictures, 64 MiB of source and 80
million decoded pixels; the budget is aggregate, because twenty images each just under
a per-file limit cost the same memory as one enormous one.

### Deliberately absent

Not implemented, and the server tells the model to say so rather than improvise:
password-protected files, PDF→Word (no faithful conversion exists), OCR, legacy
binary `.doc`/`.xls`, and pivot tables — the library supports that last one, no
tool does yet.

A Word template's `{{%name}}` must sit in **a paragraph of its own** — in the body, a
table cell, or a header or footer, nesting included. One placement is genuinely
impossible: scoped to a `{{#each}}` item, because images are substituted before loops
expand, so one picture per row is not expressible. `template_fill` refuses that up
front and `template_inspect` marks it rather than inventing a key for it.

Every image is also checked for **integrity**, not just for a readable header: PNG
chunk CRCs and an inflate that yields exactly the declared scanlines, a JPEG's
end-of-image marker, a GIF's trailer. Truncation is how images really arrive broken,
and a header check cannot see it — the first bytes of a cut-off PNG are identical to a
whole one's.

Because that same pass runs before conditionals are evaluated, a picture inside a
`{{#if}}` that turns out false is substituted and then removed with its block. The
fill still succeeds, so `template_fill` reports it as **not in the output** and drops
its bytes from the package — a document that withholds a picture must not leak it to
anyone who unzips the file. Every placed picture is then verified by re-opening the
written `.docx`, because the document handed to the writer is not evidence about the
file it produced.

### Editing existing files

`sheet_edit` and `doc_edit` change files a user already has, so they carry
guarantees the create-only tools do not need:

- **Safe replacement** — every operation is applied in memory first, then
  written in a random private sibling directory. POSIX installs it with one
  atomic rename; Windows uses a rollback rename because its filesystem does not
  atomically replace an existing file. In either case a failed write restores or
  leaves the old file rather than a truncated hybrid.
- **Backed up** — an in-place edit copies the original to `<name>.bak`, and never
  overwrites an existing backup: the second edit's copy goes to `.bak.2`, so the
  pristine original stays recoverable.
- **`dryRun`** — reports exactly what would change and writes nothing.
- **No silent no-ops** — replacing a phrase that does not occur reports that
  rather than rewriting the file unchanged.

The failure these guard against is not a broken edit but a _correct edit in the
wrong place_, which nothing in the output looks wrong after.

## Resources and prompts

Besides tools, the server publishes:

- **Resources** — every help topic at `documonster://help/{topic}`, so a client can
  display them and a model can read one without spending a tool call.
- **Prompts** — six workflow templates (`summarise-spreadsheet`, `build-report`,
  `fill-document`, `review-changes`, `convert-document`, `draw-diagram`). Each
  encodes the working order that matters — inspect, read narrowly, verify — and
  tells the model never to invent a value it was not given.

## Programmatic use

```ts
import { createServer, resolveConfig } from "@documonster/mcp";

const server = createServer(resolveConfig(["--root", "./workspace", "--readonly"]));
await server.connect(myTransport);
```

## Development

This package lives in the documonster monorepo and consumes the core through its
published `exports` map — never through internal path aliases. That means the
core's ESM + type output must exist first:

```bash
pnpm i
pnpm build:esm         # from the repo root — produces dist/esm + dist/types
pnpm type:packages
pnpm test:packages
pnpm build:packages
```

`pnpm verify:packages` (part of `pnpm check`) fails the build if this package
ever imports `@excel/*`, `@utils/*` or reaches into `../../src`.

### Testing layers

| Layer      | File                                                    | Catches                                                                                                                      |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Unit       | `config` / `sandbox` / `result` / `errors` / `registry` | Argument parsing, path containment, output budget, error text, tool filtering                                                |
| Per-kind   | `diagram.test.ts`                                       | All 21 diagram types through inspect + SVG + PNG + PDF — a structural summary reading a field one kind spells differently    |
| Units      | `image.test.ts`                                         | px-at-96 / pt-at-72 / EMU-at-914400 confusions, by asserting a known pixel size survives into a worksheet anchor             |
| Package    | `image.test.ts`                                         | Media integrity in the produced OOXML: unique parts, resolvable relationships, and no bytes left behind by a false `{{#if}}` |
| Budget     | `schema-budget.test.ts`                                 | The permanent context cost of `tools/list`, which nothing else makes visible as it grows                                     |
| Protocol   | `server.test.ts`                                        | Handshake, `tools/list`, JSON Schema generation, `tools/call`, in-memory transport                                           |
| Executable | `stdio.e2e.test.ts`                                     | Real spawned process: `bin` entry, shebang, exit codes, manifest version, and that stdout carries nothing but JSON-RPC       |

The e2e suite compiles the package itself in `beforeAll`, so it never
silently skips when `dist/` is absent.

## License

Apache-2.0
