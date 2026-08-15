# Examples

Unlike the other modules, whose examples produce a document, these produce a
**test environment**: a workspace of deliberately awkward files plus the client
configuration to point an AI assistant at it.

That difference is the point. The test suite can prove the tools work; it cannot
prove a _model_ uses them correctly from plain language. Only a real client can.

## Files

| File                 | Purpose                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `setup-workspace.ts` | Builds `tmp/mcp-examples/workspace/` and prints ready-to-paste client config                          |
| `probe-tools.ts`     | Drives the real executable over stdio and exercises all six tools — run this before blaming the model |
| `prompts.md`         | Natural-language prompts to try in a client, with what a good and a bad run look like                 |

## Use

```bash
# 1. Build the workspace and print the client configuration
node src/examples/setup-workspace.ts

# 2. Confirm the server itself is healthy (needs a build)
pnpm build
node src/examples/probe-tools.ts

# 3. Paste the printed config into your client, restart it,
#    then work through prompts.md
```

## What the workspace probes

| Fixture                   | Probes                                                          |
| ------------------------- | --------------------------------------------------------------- |
| `reports.zip`             | Archive as the entry point; nested paths; selective extraction  |
| `budget.xlsx`             | Multi-sheet, cross-sheet formulas, merged title, number formats |
| `budget.xlsx` → `Eng`     | 340 rows — forces pagination instead of a full read             |
| `budget.xlsx` → `Archive` | An empty sheet, which reports a zero-based dimension            |
| `inventory.csv`           | 5 000 generated rows — reading it all is the wrong move         |
| `june.csv`                | Semicolon-delimited, CRLF, UTF-8 BOM — dialect detection        |
| `export.xlsx`             | Actually a CSV — extension-mismatch detection                   |
| `legacy.doc`              | CFB container — the ambiguous legacy-or-encrypted case          |
| `spec.docx`               | A real Word file with **no tool to read it**, on purpose        |

`invoice-template.docx` is the most interesting one. It contains a
`{{client.abn}}` field that a model is likely to forget — and a missing field is
an error, not a blank. Whether the model reads the error, adds the field and
retries once, or thrashes, is exactly what no unit test can tell you.

## Note

`probe-tools.ts` spawns `dist/cli.js`, exactly as a client does, so it catches
packaging problems (missing shebang, wrong `bin` path, stray writes to stdout)
that in-process tests cannot. Everything it writes goes under
`tmp/mcp-examples/`, which is gitignored.
