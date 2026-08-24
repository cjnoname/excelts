# @documonster/mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for
[documonster](https://github.com/documonster/documonster). Gives an AI assistant
the ability to read, write and convert Excel, Word, PDF, CSV and ZIP documents
on the local filesystem.

> **Status: usable.** Nineteen tools cover spreadsheets, Word, PDF, templates and
> archives — reading, writing, editing, searching and converting. See
> See [Deliberately absent](#deliberately-absent) for the intentional scope boundaries.

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

| Flag                      | Default      | Meaning                                                                                               |
| ------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `--root <dir>`            | cwd          | Sandbox root. Every path a tool touches must resolve inside it.                                       |
| `--output-root <dir>`     | private temp | Separate writable root. Outputs are returned as `@output/<path>` for later calls.                     |
| `--allow-in-place`        | off          | Permit edits below `--root`; disabled by default because it weakens isolation.                        |
| `--readonly`              | off          | Withhold every mutating tool from the model's tool list.                                              |
| `--enable <groups>`       | all          | Comma-separated tool groups: `core`, `excel`, `word`, `pdf`, `forms`, `archive`. `core` is always on. |
| `--max-file-size <bytes>` | 67108864     | Reject larger input documents.                                                                        |
| `--max-output-chars <n>`  | 40000        | Truncate tool output — a token budget in disguise.                                                    |

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

| Tool                    | Purpose                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Orientation**         |                                                                                                                              |
| `documonster_help`      | Conventions, path rules, and formula/document/editing notes kept out of tool schemas to save context.                        |
| `doc_inspect`           | Identify a file (type, size, sheet list, CSV dialect, extension mismatches) or list a directory. Always first.               |
| **Spreadsheets**        |                                                                                                                              |
| `sheet_read`            | Read a bounded window as a Markdown table with column letters and row numbers. Paginates; reports what it omitted.           |
| `sheet_write`           | Create an `.xlsx` from a declarative spec. `fromCsv` pulls source data in server-side.                                       |
| `sheet_edit`            | Patch an existing `.xlsx` — cells, ranges, formulas, rows, styles, sheets. Atomic, backed up, `dryRun` available.            |
| `formula_evaluate`      | Evaluate a formula against supplied values using the real engine (~450 functions). Touches no files.                         |
| **Documents**           |                                                                                                                              |
| `doc_read`              | Read `.docx` / `.pdf` / `.md` / `.txt`. Word returns Markdown; PDFs are reported page by page.                               |
| `doc_write`             | Create a `.docx` or `.pdf` from Markdown.                                                                                    |
| `doc_edit`              | Find and replace text in a `.docx`, including matches Word split across runs. Formatting preserved.                          |
| `doc_search`            | Find text, or find text **by its formatting** — "which text is red", "what is highlighted".                                  |
| `doc_paginate`          | Real page count and per-heading page numbers without Word installed; optionally refresh fields and the TOC.                  |
| `doc_convert`           | `docx`→`md`/`html`/`pdf`/`txt`, `md`→`docx`/`pdf`, `xlsx`→`csv`/`pdf`, `csv`→`xlsx`. Lossy conversions state their loss.     |
| `pdf_edit`              | Watermark, page numbers, stamps, rotate, delete/keep pages, append another PDF. Overlays never rewrite the original content. |
| **Forms and templates** |                                                                                                                              |
| `template_inspect`      | List a template's placeholders and print the JSON shape needed to fill it.                                                   |
| `template_fill`         | Fill a Word template from JSON. A missing field fails loudly rather than shipping a blank.                                   |
| `form_fill`             | List or fill Word form fields and PDF AcroForms. PDF values are verified by re-reading the saved file.                       |
| **Archives**            |                                                                                                                              |
| `archive_read`          | List or extract a `.zip`/`.tar`. Guards traversal, decompression bombs and symlink entries.                                  |
| `archive_write`         | Package files and directories into a `.zip`/`.tar`, verified by reading it back.                                             |

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

### Deliberately absent

Not implemented, and the server tells the model to say so rather than improvise:
password-protected files, PDF→Word (no faithful conversion exists), OCR, legacy
binary `.doc`/`.xls`, and image/pivot-table insertion — the library supports
those, no tool does yet. Spreadsheet charts are supported by `sheet_write` and
`sheet_edit`.

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
- **Prompts** — five workflow templates (`summarise-spreadsheet`, `build-report`,
  `fill-document`, `review-changes`, `convert-document`). Each encodes the working
  order that matters — inspect, read narrowly, verify — and tells the model never
  to invent a value it was not given.

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

| Layer      | File                                                    | Catches                                                                                                                |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Unit       | `config` / `sandbox` / `result` / `errors` / `registry` | Argument parsing, path containment, output budget, error text, tool filtering                                          |
| Protocol   | `server.test.ts`                                        | Handshake, `tools/list`, JSON Schema generation, `tools/call`, in-memory transport                                     |
| Executable | `stdio.e2e.test.ts`                                     | Real spawned process: `bin` entry, shebang, exit codes, manifest version, and that stdout carries nothing but JSON-RPC |

The e2e suite compiles the package itself in `beforeAll`, so it never
silently skips when `dist/` is absent.

## License

Apache-2.0
