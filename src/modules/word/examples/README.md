# Word Module — Examples

Self-contained, runnable examples that cover every public Word-module API
plus its conversion bridges (HTML, Markdown, Excel, PDF, Flat OPC, ODT)
plus the `documonster/word/crypto` subpath for decryption. Each file is
hermetic — no external assets are required; all images / fonts are inline
byte literals.

## Run

```bash
# Run a single example
pnpm example --filter 01-basics

# Run every Word example (writes everything into tmp/word-examples/)
pnpm example --filter word/examples
```

`pnpm example` runs the whole tree; `--filter` narrows it by path substring. It
resolves imports the way the test suite does, which a bare `tsx` invocation does
not — see `scripts/run-examples.ts`.

Output is written to `tmp/word-examples/`.

## Index

### 1–14 Authoring building blocks

| File                                | Topic                                                          |
| ----------------------------------- | -------------------------------------------------------------- |
| `01-basics.ts`                      | Document creation, headings, paragraphs, breaks, Unicode/RTL   |
| `02-formatting.ts`                  | All run-level formatting (bold, color, font, effects, …)       |
| `03-tables.ts`                      | Tables: merging, borders, nested, vertical text, floating      |
| `04-layout.ts`                      | Pages, margins, columns, sections, line numbers, RTL           |
| `05-lists.ts`                       | Bullet / numbered / multi-level / custom abstract numbering    |
| `06-headers-footers.ts`             | Default / first / even-odd headers, page-of-N footer, table FT |
| `07-images.ts`                      | Inline / floating / behind / rotated / nested images           |
| `08-hyperlinks-bookmarks.ts`        | URL / mailto / anchor links, bookmarks, REF / PAGEREF          |
| `09-styles-numbering.ts`            | Custom paragraph / character / table styles, asian numerals    |
| `10-toc-fields.ts`                  | Table of contents, every field helper                          |
| `11-footnotes-endnotes-comments.ts` | Notes (rich content) and review comments + 100-footnote stress |
| `12-math.ts`                        | OMML — fractions, integrals, matrices, eq arrays               |
| `13-shapes.ts`                      | DrawingML shapes, gradients, effects, 3D bevel                 |
| `14-charts.ts`                      | Built-in chart types (column, line, pie, scatter, combo)       |

### 15–24 Editing, querying & document features

| File                          | Topic                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `15-track-changes.ts`         | Insertion / deletion / move + accept/reject helpers                                       |
| `16-templates.ts`             | `fillTemplate` + JSON / XML / CSV data sources, custom delim                              |
| `17-forms-sdt.ts`             | Legacy form fields + SDT (content controls) + data binding                                |
| `18-read-modify.ts`           | `Io.read`, `Query.extractText`, `Query.searchText`, `Query.replaceText` (in 9 containers) |
| `19-merge-split-diff.ts`      | `Io.merge` / `Io.split` / `Diff.documents`                                                |
| `20-protection-encryption.ts` | `protectDocument` + `encryptDocx`                                                         |
| `21-validation.ts`            | `validateDocument` (clean / malformed / strict / compat)                                  |
| `22-streaming.ts`             | `createDocxStream` for huge documents                                                     |
| `23-fonts.ts`                 | `embedFont` (with subsetting & ODTTF obfuscation)                                         |
| `24-watermark-bg.ts`          | Text & image watermark, page background, custom theme                                     |

### 25–30 Conversions & edge cases

| File                        | Topic                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `25-html-conversion.ts`     | `htmlToDocxBody` / `renderToHtml`                                                       |
| `26-markdown-conversion.ts` | `markdownToDocx` / `renderToMarkdown`                                                   |
| `27-excel-conversion.ts`    | `excelToDocx` / `extractTablesToExcel`                                                  |
| `28-pdf-conversion.ts`      | `Pdf.fromDocx` (custom page size, custom chart renderer)                                |
| `29-flat-opc-odt.ts`        | `toFlatOpcFromDoc` / `parseFlatOpc` / `readOdt` / `writeOdt`                            |
| `30-edge-cases.ts`          | Encryption rejection, empty / large / nested-table docs, corrupted ZIP, 1 000 bookmarks |

### 31–47 Advanced internals & low-level surface

| File                             | Topic                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `31-walker-mapper.ts`            | `walkDocument` / `walkBlocks` / `mapDocument` / collectors                                                                    |
| `32-style-resolve-themes.ts`     | `resolveStyle` / `resolveRunStyle` / `resolveTableStyle` / `resolveThemeColor` / `parseStyleMap`                              |
| `33-incremental-edit.ts`         | `editDocxIncremental` / `listDocxParts` / `readDocxPart`                                                                      |
| `34-decrypt-roundtrip.ts`        | `isEncryptedDocx` / `decryptDocx` / `Io.read` with password                                                                   |
| `35-mathml-conversion.ts`        | `ommlToMathML` / `mathMLToOmml` + `ruby` + `mathPhantom`                                                                      |
| `36-text-shaping-hyphenation.ts` | `shapeText` / `detectScript` / `detectDirection` / `hyphenateText`                                                            |
| `37-svg-render.ts`               | `layoutDocument` / `layoutDocumentFull` / `renderPageToSvg` / `renderDocumentToSvg`                                           |
| `38-glossary-buildingblocks.ts`  | `createBuildingBlock` / `createGlossaryDocument` / `getQuickParts`                                                            |
| `39-ole-vba.ts`                  | `extractOleObjects` / `createOleEmbedding` / `addVbaProject` (.docm round-trip)                                               |
| `40-templates-advanced.ts`       | `compileTemplate` / `patchTemplate` / `bindChartData` / `createCompositeDataSource`                                           |
| `41-fields-engine.ts`            | `updateFields` / `updateTableOfContents` / `tcField` / `indexEntryField` / `indexField` / `noteRefField`                      |
| `42-conversion-ir.ts`            | `docxToSemantic` / `createConversionContext`                                                                                  |
| `43-compat-modes.ts`             | `getCompatibilityMode` / `setCompatibilityMode` for Word 2003-2013+                                                           |
| `44-queries-deep.ts`             | `Query.findBookmark` / `Query.findComment` / `Query.searchByFormat` / `Query.getUsedFormats`                                  |
| `45-digital-signatures.ts`       | `extractSignatures` / `parseSignatureXml` / `isWellFormedSignature` / `hasDigitalSignatures`                                  |
| `46-security-policy.ts`          | `DEFAULT_SECURITY_POLICY` / `STRICT_SECURITY_POLICY` / `resolveSecurityPolicy` / `createRenderContext` / `createIdGenerators` |
| `47-low-level-crypto.ts`         | `readCfb` / `writeCfb` / `parseEncryptionInfoXml` / `verifyPassword` / `AGILE_BLOCK_KEYS`                                     |

## Conventions

- Every file is a standalone ES module. They import from `../index` for the
  core API, and from `../html` / `../markdown` / `../excel` / `../crypto` /
  `../../pdf` for the conversion bridges and crypto sub-path.
- Output files use the file name as a prefix (e.g. `07-images.docx`).
- Examples that produce many outputs use a sub-directory
  (e.g. `19-merge-split-diff/`).
- All output paths are relative to the project root: `tmp/word-examples/`.
  This directory is gitignored.
