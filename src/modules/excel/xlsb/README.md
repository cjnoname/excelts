# XLSB implementation

This directory implements Excel Binary Workbook (`.xlsb`) IO for the same
in-memory workbook model used by the XLSX serializer. XLSB is still an OOXML ZIP
package; its workbook, worksheet, shared-string, and style parts use BIFF12
records instead of XML.

## Architecture

- `binary.ts` owns the bounds-checked BIFF12 record framing and primitive
  readers/writers. Record payload parsers do not decode headers independently.
- `workbook-part.ts`, `worksheet-part.ts`, `shared-strings.ts`, `styles.ts`,
  `table-part.ts`, and `comments.ts` translate individual binary parts to and
  from the Excel core model. `auto-filter.ts` bridges the existing retained
  XLSX criteria XML to typed BIFF12 filter records.
- `package.ts` resolves OOXML relationships, assembles/extracts ZIP entries,
  applies document properties, and commits a parsed model atomically.
- `core/xlsb-io*` and `surface/xlsb*` provide the cross-platform `Xlsb`
  namespace. Only the Node surface exposes file-path methods.

The implementation uses the repository's Archive, Stream, XML, and utility
modules and adds no runtime dependency.

## Fidelity policy

Writing is strict by default. A workbook containing a feature that the BIFF12
writer cannot represent throws `ExcelNotSupportedError`; it is never silently
dropped. `unsupported: "ignore"` is the explicit lossy-output opt-in.

The reader preserves supported BIFF12 formula token arrays by default. Use
`formulas: "cached"` to request only the last calculated values; that lossy
choice is recorded so a later strict write fails instead of replacing formulas
with constants. `formulas: "error"` rejects formula cells during reading.

An unchanged loaded XLSB is returned byte-for-byte, preserving macros and
opaque package parts. Once the model is edited, strict writing rejects any
unmodeled part instead of silently deleting it.

| Feature                        | Read                                                   | Write                |
| ------------------------------ | ------------------------------------------------------ | -------------------- |
| Numbers, strings, booleans     | Yes                                                    | Yes                  |
| Excel errors                   | Yes                                                    | BIFF12 `BErr` values |
| Dates / 1904 date system       | Yes                                                    | Yes                  |
| Shared and direct strings      | Yes                                                    | Shared strings       |
| Custom number formats          | Yes                                                    | Yes                  |
| Rows / columns / visibility    | Yes                                                    | Yes                  |
| Sheet visibility               | Yes                                                    | Yes                  |
| Merged ranges                  | Yes                                                    | Yes                  |
| Formula expressions            | Literals, operators, references and classic functions  | Same supported set   |
| Shared / legacy array formulas | Yes                                                    | Yes                  |
| Font/fill/border/alignment     | Yes                                                    | Yes                  |
| Cell protection                | Yes                                                    | Yes                  |
| Workbook/sheet views and panes | Yes                                                    | Yes                  |
| Defined names                  | References and supported formulas                      | Same supported set   |
| Hyperlinks                     | External and internal                                  | Yes                  |
| Page setup / headers / breaks  | Yes                                                    | Yes                  |
| Sheet protection               | ISO password hashes and permissions                    | Yes                  |
| Data validation                | Core rule types except `time`                          | Same supported set   |
| Auto-filter range and criteria | Values, date groups, custom, dynamic, top, color, icon | Same except color¹   |
| Rich text / notes              | Yes                                                    | Yes                  |
| Tables                         | Styles, formulas, structured references and filters    | Same supported set   |
| Drawings / charts / pivots     | Not yet                                                | Strict fail          |

¹ A color filter can be read and byte-preserved, but an edited write fails
strictly because its referenced differential style (DXF) is not modelled yet.

## Interoperability

Tests cover malformed framing, internal round-trips, Node file and stream IO,
browser execution, and an optional LibreOffice open/convert oracle. The oracle
runs when `DOCUMONSTER_XLSB_LIBREOFFICE_VALIDATION=1` is set and is enabled in
the repository's LibreOffice CI job. Development also checks valid files from
Apache POI, Calamine, and the Apache-licensed `jsxlsb` reference fixture, whose
shared strings, Unicode text, cell coordinates, and merged range are
intentionally different from the generated corpus.

Record IDs and payload layouts come from Microsoft's `[MS-XLSB]` specification.
The `jsxlsb` project was used as an interoperability reference, not as an
authority: several of its record IDs, direct-string/RK readers, and a row-header
writer differ from the current protocol specification, so those paths are not
copied verbatim.

### Reproducible corpus

`pnpm verify:xlsb-corpus` downloads a pinned, SHA-256-verified set of XLSB
fixtures from Calamine, Apache POI, and `jsxlsb`, reads each through the public
`Workbook` API, verifies byte-for-byte passthrough of unchanged files, and runs
the semantic expectations stored beside each selected fixture in the manifest.
Those probes cover worksheet names, the 1900/1904 date epochs, scalar and date
cells, formula text and cached results, comments, hyperlinks, Unicode, and
merged ranges. The `jsxlsb` fixture also receives a new cell, is serialized with
the explicit `unsupported: "ignore"` opt-in required by its opaque records, and
is read again; every original semantic probe and the mutation must survive. The
files are cached under the gitignored `tmp/xlsb-corpus/` directory and are not
distributed with documonster.

```bash
pnpm verify:xlsb-corpus              # populate or reuse the cache
pnpm verify:xlsb-corpus -- --offline # require a complete valid cache
pnpm verify:xlsb-corpus -- --refresh # redownload every pinned fixture
```

Set `DOCUMONSTER_XLSB_CORPUS_DIR` to include an additional private/local XLSB
tree. `DOCUMONSTER_XLSB_CORPUS_CACHE` overrides the cache path. The pinned
sources, revisions, licenses, and hashes live in
`scripts/xlsb-corpus-manifest.json`. The password-protected Calamine fixture is
kept as an expected rejection because encrypted OLE-wrapped XLSB packages are
outside the current ZIP-based reader.

### XLSX/XLSB benchmark

`pnpm benchmark:xlsb` builds one representative workbook for each format and
reports median write/read time, retained heap delta, rows per second, output
size, and XLSB-to-XLSX ratios. Both formats receive the same compression level,
fixed ZIP timestamp, data, table, formulas, styles, note, views, and metadata.

```bash
pnpm benchmark:xlsb
XLSB_BENCHMARK_ROWS=50000 XLSB_BENCHMARK_RUNS=7 pnpm benchmark:xlsb
```

The benchmark is diagnostic rather than a CI performance budget: machine load,
runtime version, and garbage collection materially affect timings. Its JSON
output records the Node version and complete benchmark configuration. CI runs
the command to prevent benchmark drift but does not enforce timing thresholds.
