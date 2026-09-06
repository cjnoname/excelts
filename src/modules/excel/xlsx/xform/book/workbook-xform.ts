import { sheetsInTabOrder } from "@excel/core/sheet-order";
import { RowOutOfBoundsError } from "@excel/errors";
import { colCache } from "@excel/utils/col-cache";
import { resolveRelTarget } from "@excel/utils/ooxml-paths";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { DefinedNamesXform } from "@excel/xlsx/xform/book/defined-name-xform";
import { ExternalReferenceXform } from "@excel/xlsx/xform/book/external-reference-xform";
import { WorksheetXform } from "@excel/xlsx/xform/book/sheet-xform";
import { WorkbookCalcPropertiesXform } from "@excel/xlsx/xform/book/workbook-calc-properties-xform";
import { WorkbookPivotCacheXform } from "@excel/xlsx/xform/book/workbook-pivot-cache-xform";
import { WorkbookPropertiesXform } from "@excel/xlsx/xform/book/workbook-properties-xform";
import { WorkbookProtectionXform } from "@excel/xlsx/xform/book/workbook-protection-xform";
import { WorkbookViewXform } from "@excel/xlsx/xform/book/workbook-view-xform";
import { ListXform } from "@excel/xlsx/xform/list-xform";
import { StaticXform } from "@excel/xlsx/xform/static-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";
import { StdDocAttributes } from "@xml/writer";

class WorkbookXform extends BaseXform {
  declare public parser?: BaseXform;
  declare public map: Record<string, BaseXform>;

  /**
   * The `<sheet>` xform shared with the `sheets` ListXform. Held as a
   * field so `parseOpen` can pass workbook-level state (the prefixes
   * bound to the OOXML relationships namespace) into it.
   */
  private readonly _sheetXform = new WorksheetXform();

  constructor() {
    super();

    this.map = {
      fileVersion: WorkbookXform.STATIC_XFORMS.fileVersion,
      workbookPr: new WorkbookPropertiesXform(),
      workbookProtection: new WorkbookProtectionXform(),
      bookViews: new ListXform({
        tag: "bookViews",
        count: false,
        childXform: new WorkbookViewXform()
      }),
      sheets: new ListXform({ tag: "sheets", count: false, childXform: this._sheetXform }),
      definedNames: new ListXform({
        tag: "definedNames",
        count: false,
        childXform: new DefinedNamesXform()
      }),
      calcPr: new WorkbookCalcPropertiesXform(),
      pivotCaches: new ListXform({
        tag: "pivotCaches",
        count: false,
        childXform: new WorkbookPivotCacheXform()
      }),
      externalReferences: new ListXform({
        tag: "externalReferences",
        count: false,
        childXform: new ExternalReferenceXform()
      })
    };
  }

  prepare(model: any): void {
    // Tab order comes from `core/sheet-order`, which the XLSB writer uses too. It lived here, and the XLSB
    // writer consequently invented its own answer — every worksheet then every chartsheet — which put a
    // workbook whose first tab is a chartsheet in the wrong order. See that module for why the fallback chain
    // has three levels.
    model.sheets = sheetsInTabOrder(model.worksheets ?? [], model.chartsheets ?? []);

    // collate all the print areas from all of the sheets and add them to the defined names
    //
    // OOXML (ECMA-376 §18.2.5) requires that the (name, localSheetId) pair
    // is unique within `<definedNames>` — so multiple print areas on the
    // same sheet must collapse into a *single* `<definedName>` whose text
    // is a comma-separated list of ranges (the format Excel itself emits).
    // The `printArea` field uses `&&` as the multi-range separator (a
    // historical convention preserved for backwards compatibility); we
    // also accept commas so users can paste Excel's native format.
    //
    // Both `printArea` and the `printTitlesRow`/`printTitlesColumn` fields
    // are normalised through `parsePrintReference` before being emitted.
    // This means the writer accepts any of the forms Excel itself accepts
    // — `A1`, `A1:B5`, `$A$1:$B$5`, `a1:b5`, ` A1 : B5 `, `Sheet!A1:B5`,
    // `'Q,F'!A1:B5`, whole-row `1:5`, whole-column `A:C` — and always
    // emits the canonical `$col$row[:$col$row]` shape that Excel
    // round-trips faithfully. Without normalisation, the previous
    // string-concatenation path produced `$$A$1` for a `$A$1` input
    // (corrupt), `$a1` for a `a1` input (Excel rejects), and
    // `$A1:$B5` row-relative (semantically wrong for a print area).
    const printAreas: any[] = [];
    let index = 0; // sheets is sparse array - calc index manually
    model.sheets.forEach((sheet: any) => {
      if (sheet.pageSetup && sheet.pageSetup.printArea) {
        const ranges: string[] = [];
        // Split on either `&&` (legacy documonster separator) or `,` (Excel's
        // native separator) at the *top level* — commas / `&&` inside a
        // quoted sheet name (`'Q1, Forecast'!A1:B5`) must NOT be treated
        // as separators. A naive `split(/&&|,/)` shreds such inputs.
        for (const segment of splitPrintAreaInput(sheet.pageSetup.printArea)) {
          const normalised = normalisePrintAreaRange(segment, sheet.name);
          if (normalised) {
            ranges.push(normalised);
          }
        }
        if (ranges.length > 0) {
          printAreas.push({
            name: "_xlnm.Print_Area",
            ranges,
            localSheetId: index
          });
        }
      }

      if (
        sheet.pageSetup &&
        (sheet.pageSetup.printTitlesRow || sheet.pageSetup.printTitlesColumn)
      ) {
        const ranges: string[] = [];

        if (sheet.pageSetup.printTitlesColumn) {
          const normalised = normalisePrintTitlesAxis(
            sheet.pageSetup.printTitlesColumn,
            sheet.name
          );
          if (normalised) {
            ranges.push(normalised);
          }
        }

        if (sheet.pageSetup.printTitlesRow) {
          const normalised = normalisePrintTitlesAxis(sheet.pageSetup.printTitlesRow, sheet.name);
          if (normalised) {
            ranges.push(normalised);
          }
        }

        if (ranges.length > 0) {
          printAreas.push({
            name: "_xlnm.Print_Titles",
            ranges,
            localSheetId: index
          });
        }
      }
      index++;
    });
    if (printAreas.length) {
      model.definedNames = model.definedNames.concat(printAreas);
    }

    (model.media ?? []).forEach((medium: any, i: number) => {
      // assign name
      medium.name = medium.type + (i + 1);
    });
  }

  render(xmlStream: XmlSink, model: any): void {
    xmlStream.openXml(StdDocAttributes);
    xmlStream.openNode("workbook", WorkbookXform.WORKBOOK_ATTRIBUTES);

    this.map.fileVersion.render(xmlStream);
    this.map.workbookPr.render(xmlStream, model.properties);
    this.map.workbookProtection.render(xmlStream, model.protection);
    this.map.bookViews.render(xmlStream, model.views);
    this.map.sheets.render(xmlStream, model.sheets);
    this.map.definedNames.render(xmlStream, model.definedNames);

    // <externalReferences> must appear BEFORE <calcPr> per ECMA-376
    // CT_Workbook sequence: sheets → definedNames → externalReferences →
    // calcPr → pivotCaches. Violating this order causes Excel to reject
    // the file as corrupt.
    const externalLinks = model.externalLinks ?? [];
    if (externalLinks.length > 0) {
      const externalReferenceModels = externalLinks.map((link: any) => ({ rId: link.rId }));
      this.map.externalReferences.render(xmlStream, externalReferenceModels);
    }

    this.map.calcPr.render(xmlStream, model.calcProperties);
    // R9-B6: Deduplicate pivot caches by cacheId before rendering.
    // Multiple pivot tables may share the same cache, but workbook.xml should
    // only list each cache once in <pivotCaches>.
    const pivotTables = model.pivotTables ?? [];
    const seenCacheIds = new Set<string>();
    const uniquePivotCaches = pivotTables.filter((pt: any) => {
      if (seenCacheIds.has(pt.cacheId)) {
        return false;
      }
      seenCacheIds.add(pt.cacheId);
      return true;
    });
    this.map.pivotCaches.render(xmlStream, uniquePivotCaches);

    xmlStream.closeNode();
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "workbook":
        // Capture every prefix the workbook root binds to the OOXML
        // relationships namespace so nested `<sheet>` parsing can
        // read the relationship id under any of them. Falls back to
        // the conventional `r` if the workbook declares no binding.
        this._sheetXform.relationshipsPrefixes = WorkbookXform._findRelationshipsPrefixes(node);
        return true;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.parseOpen(node);
        }
        return true;
    }
  }

  private static _findRelationshipsPrefixes(node: ParseOpenTag): readonly string[] {
    const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const attrs = node.attributes ?? {};
    const prefixes: string[] = [];
    for (const attrName of Object.keys(attrs)) {
      if (attrName.startsWith("xmlns:") && attrs[attrName] === RELATIONSHIPS_NS) {
        prefixes.push(attrName.slice("xmlns:".length));
      }
    }
    return prefixes.length > 0 ? prefixes : ["r"];
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case "workbook":
        this.model = {
          sheets: this.map.sheets.model,
          properties: this.map.workbookPr.model || {},
          protection: this.map.workbookProtection.model,
          views: this.map.bookViews.model,
          calcProperties: this.map.calcPr.model || {}
        };
        if (this.map.definedNames.model) {
          this.model.definedNames = this.map.definedNames.model;
        }
        if (this.map.pivotCaches.model && this.map.pivotCaches.model.length > 0) {
          this.model.pivotCaches = this.map.pivotCaches.model;
        }
        // Attach parsed <externalReferences> as a list of { rId } objects.
        // The reader in xlsx.browser.ts will later join each entry with the
        // matching workbookRels row (to pick up the externalLink Target) and
        // the parsed externalLinkN.xml part (to pick up sheetNames / cache).
        if (this.map.externalReferences.model && this.map.externalReferences.model.length > 0) {
          this.model.externalReferences = this.map.externalReferences.model;
        }

        return false;
      default:
        // not quite sure how we get here!
        return true;
    }
  }

  reconcile(model: any): void {
    const rels = (model.workbookRels ?? []).reduce((map: any, rel: any) => {
      map[rel.Id] = rel;
      return map;
    }, {});

    // reconcile sheet ids, rIds and names
    //
    // `worksheets` is indexed positionally across BOTH sheet kinds
    // (worksheet and chartsheet). OOXML `definedName/@localSheetId`
    // is a 0-based index into the workbook-level `<sheets>` element,
    // which mixes both kinds — so a chartsheet occupying position 1
    // in `<sheets>` shifts every subsequent worksheet's effective
    // index by one. Compressing to a worksheets-only array (the
    // previous implementation) made `localSheetId` resolve to the
    // wrong worksheet whenever chartsheets were interleaved, so
    // `_xlnm.Print_Area` / `_xlnm.Print_Titles` landed on an
    // unrelated sheet.
    const worksheets: any[] = [];
    const chartsheetsList: any[] = [];
    let worksheet: any;
    let sheetPosition = 0;

    (model.sheets ?? []).forEach((sheet: any) => {
      const rel = rels[sheet.rId];
      if (!rel) {
        sheetPosition += 1;
        return;
      }
      const target = resolveRelTarget("xl", rel.Target);

      // Check if this is a chartsheet
      const chartsheetMatch = /xl\/chartsheets\/sheet(\d+)\.xml/.exec(target);
      if (chartsheetMatch) {
        const csNo = parseInt(chartsheetMatch[1], 10);
        const chartsheet = model.chartsheets?.[csNo];
        if (chartsheet) {
          chartsheet.name = sheet.name;
          chartsheet.id = sheet.id;
          chartsheet.state = sheet.state;
          chartsheet.rId = sheet.rId;
          chartsheet.orderNo = sheetPosition;
          chartsheetsList.push(chartsheet);
        }
        sheetPosition += 1;
        return;
      }

      worksheet = model.worksheetHash[target];
      if (worksheet) {
        worksheet.name = sheet.name;
        worksheet.id = sheet.id;
        worksheet.state = sheet.state;
        worksheet.orderNo = sheetPosition;
        // Index by the workbook `<sheets>` position — not the
        // compressed worksheet counter — so `definedName.localSheetId`
        // resolves correctly when chartsheets are interleaved.
        worksheets[sheetPosition] = worksheet;
      }
      sheetPosition += 1;
    });

    // Store reconciled chartsheets on the model
    model.chartsheetsList = chartsheetsList;

    // Drop unbound worksheet parts. The reader (xlsx.browser.ts)
    // collects every `xl/worksheets/sheetN.xml` it sees in the zip,
    // because zip entries arrive in arbitrary order relative to
    // workbook.xml. The authoritative `<sheets>` list is only
    // available here, post-parse — so this is the first point at
    // which we can prune worksheet parts that no `<sheet>` element
    // claims through a working rel binding.
    //
    // Without pruning, such worksheets propagate downstream with
    // `id`/`name`/`state` all `undefined`, landing under the literal
    // string key `"undefined"` in `Workbook._worksheets` and becoming
    // unreachable via `getWorksheet(name)`. OOXML treats
    // the workbook's `<sheets>` element as the single source of truth
    // for which parts belong to the workbook; we follow that contract
    // strictly. Genuinely-cursed workbooks reach this branch only when
    // their `<sheet>` declarations are themselves missing or broken;
    // namespace-prefix and Target-path quirks are handled upstream
    // (the relationships-prefix lookup in sheet-xform and
    // resolveRelTarget above), so a normal Excel-authored file never
    // loses sheets here.
    if (Array.isArray(model.worksheets)) {
      model.worksheets = model.worksheets.filter(
        (ws: any) => ws && Number.isInteger(ws.id) && ws.id > 0
      );
    }

    // reconcile print areas
    const definedNames: any[] = [];
    if (model.definedNames) {
      model.definedNames.forEach((definedName: any) => {
        // For print area/titles, use rawText to extract ranges since the xform
        // layer no longer pre-classifies content (two-phase design).
        // When falling back to rawText we must split on top-level commas
        // (commas inside a quoted sheet name like `'Q1, Forecast'!$A$1` do
        // *not* delimit ranges), so a naive `rawText.split(",")` is wrong
        // and would mis-split sheet names with embedded commas.
        const effectiveRanges: string[] =
          definedName.ranges?.length > 0
            ? definedName.ranges
            : definedName.rawText
              ? splitPrintAreaInput(definedName.rawText)
              : [];

        if (definedName.name === "_xlnm.Print_Area") {
          worksheet = worksheets[definedName.localSheetId];
          if (worksheet && effectiveRanges.length > 0) {
            if (!worksheet.pageSetup) {
              worksheet.pageSetup = {};
            }
            // A print-area `<definedName>` may carry multiple ranges as a
            // comma-separated list (Excel's native format) — read every
            // range, not just the first. Rejoin with `&&` so the
            // worksheet-level `printArea` field uses the legacy documonster
            // separator (preserved for backwards compatibility on the
            // public API; both `&&` and `,` are accepted on write).
            //
            // Route through the same `parsePrintReference` the writer
            // uses so every legitimate Excel reference shape (cell,
            // range, whole-row, whole-column) round-trips. The previous
            // implementation called `colCache.decodeEx` directly, which
            // returns a `NaN`-laced result for whole-row/column inputs
            // (those are not cell addresses) — those legitimate shapes
            // came back as `"NaN:NaN"` on the worksheet model.
            const decoded: string[] = [];
            for (const rangeStr of effectiveRanges) {
              // Wrap in try/catch: `parsePrintReference` throws
              // `ColumnOutOfBoundsError` (column past XFD) or
              // `RowOutOfBoundsError` (row 0 or row past 1048576) for
              // out-of-range refs. On the *write* side that throw
              // surfaces a user error, but on this *read* side a
              // malformed file (or one authored by another tool) must
              // not blow up the whole load — drop the bad range and
              // continue.
              let ref: PrintReference | undefined;
              try {
                ref = parsePrintReference(rangeStr);
              } catch {
                ref = undefined;
              }
              if (!ref) {
                continue;
              }
              // Promote a bare cell to a degenerate range so the
              // worksheet `printArea` field is always a range string —
              // that's the documented API contract and matches what
              // Excel itself emits for single-cell print areas.
              decoded.push(
                ref.kind === "cell" ? `${ref.dimensions}:${ref.dimensions}` : ref.dimensions
              );
            }
            if (decoded.length > 0) {
              const joined = decoded.join("&&");
              worksheet.pageSetup.printArea = worksheet.pageSetup.printArea
                ? `${worksheet.pageSetup.printArea}&&${joined}`
                : joined;
            }
          }
        } else if (definedName.name === "_xlnm.Print_Titles") {
          worksheet = worksheets[definedName.localSheetId];
          if (worksheet && effectiveRanges.length > 0) {
            if (!worksheet.pageSetup) {
              worksheet.pageSetup = {};
            }

            const rangeString = effectiveRanges.join(",");

            const dollarRegex = /\$/g;

            const rowRangeRegex = /\$\d+:\$\d+/;
            const rowRangeMatches = rangeString.match(rowRangeRegex);

            if (rowRangeMatches && rowRangeMatches.length) {
              const range = rowRangeMatches[0];
              worksheet.pageSetup.printTitlesRow = range.replace(dollarRegex, "");
            }

            const columnRangeRegex = /\$[A-Z]+:\$[A-Z]+/;
            const columnRangeMatches = rangeString.match(columnRangeRegex);

            if (columnRangeMatches && columnRangeMatches.length) {
              const range = columnRangeMatches[0];
              worksheet.pageSetup.printTitlesColumn = range.replace(dollarRegex, "");
            }
          }
        } else {
          definedNames.push(definedName);
        }
      });
    }
    model.definedNames = definedNames;

    // used by sheets to build their image models.
    // Matches the `(model.media ?? []).forEach(...)` guard in
    // `prepare` (line 144): `reconcile` may be called from code paths
    // where `model.media` was never initialised (e.g. a programmatic
    // workbook with no images; the xlsx reader populates this array,
    // but builder-constructed workbooks do not). Without the guard,
    // the forEach throws `TypeError: Cannot read properties of
    // undefined (reading 'forEach')` and aborts the load/save cycle.
    (model.media ?? []).forEach((media: any, i: number) => {
      media.index = i;
    });
  }

  static WORKBOOK_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "xmlns:mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "mc:Ignorable": "x15",
    "xmlns:x15": "http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"
  };

  static STATIC_XFORMS = {
    fileVersion: new StaticXform({
      tag: "fileVersion",
      $: { appName: "xl", lastEdited: 5, lowestEdited: 5, rupBuild: 9303 }
    })
  };
}

/**
 * Split a print-area string on its multi-range separators while honouring
 * single-quoted sheet name segments.
 *
 * Used by both the writer (parsing user-supplied `printArea` values) and
 * the reader (parsing the body of an OOXML `<definedName>` when the
 * defined-name layer hands us the raw text). Recognises both:
 *   - `,` — the OOXML / Excel-native separator
 *   - `&&` — the legacy documonster convention preserved on the public API
 *
 * Quoted sheet names (`'Q1, Forecast'!A1:B5`) are skipped over: any `,`,
 * `&`, or `'` inside a quoted name is preserved verbatim. A doubled
 * apostrophe inside a quoted segment (`''`) is the OOXML escape for a
 * literal apostrophe and does not terminate the quote.
 *
 * Empty / whitespace-only segments are dropped; the caller normalises
 * each surviving segment further with `parsePrintReference`.
 */
function splitPrintAreaInput(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'") {
      // Doubled apostrophe inside a quoted segment is an escaped literal.
      if (inQuote && input[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (!inQuote) {
      if (ch === ",") {
        if (current.trim()) {
          result.push(current);
        }
        current = "";
        continue;
      }
      if (ch === "&" && input[i + 1] === "&") {
        if (current.trim()) {
          result.push(current);
        }
        current = "";
        i++; // skip the second `&`
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) {
    result.push(current);
  }
  return result;
}

/**
 * Quote a sheet name for inclusion in an OOXML defined-name reference.
 *
 * Per ECMA-376 §18.17 sheet names that contain spaces or any character
 * outside `[A-Za-z0-9_]` MUST be wrapped in single quotes; a literal
 * apostrophe inside the name is doubled. We always quote — over-quoting
 * is harmless (Excel parses both forms) and keeps the writer trivial.
 */
function quoteSheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

/**
 * Find the index of the first `!` that lies outside any single-quoted
 * sheet-name segment, or `-1` if no unquoted `!` is present.
 *
 * Sheet names quoted with `'` may contain unbalanced characters, so we
 * walk the string honouring quote toggles before declaring a `!` to be
 * the sheet/address separator. Doubled apostrophes (`''`) inside a
 * quoted name are treated as a literal apostrophe per OOXML.
 */
function findUnquotedExclamation(value: string): number {
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'") {
      if (inQuote && value[i + 1] === "'") {
        i++;
        continue;
      }
      inQuote = !inQuote;
    } else if (ch === "!" && !inQuote) {
      return i;
    }
  }
  return -1;
}

/**
 * The four reference shapes Excel accepts for a print area or print
 * title's defined-name body. Read- and write-side helpers branch on
 * `kind` to produce the right user-facing string (`A1:B5` for the
 * worksheet `printArea` field, `1:2` / `A:B` for `printTitlesRow` /
 * `printTitlesColumn`).
 */
type PrintReferenceKind = "cell" | "range" | "row" | "col";

interface PrintReference {
  kind: PrintReferenceKind;
  /** Canonical OOXML body, e.g. `$A$1:$B$5`, `$A$1`, `$1:$5`, `$A:$C`. */
  ooxml: string;
  /** Worksheet-facing dimensions, e.g. `A1:B5`, `A1`, `1:5`, `A:C`. */
  dimensions: string;
}

// Excel 2007+ row limit. Print-area / print-titles references emitted
// to OOXML must respect this — Excel rejects definitions that point
// past the addressable sheet, so the writer normalises every row
// through `parseRowToken` (which throws `RowOutOfBoundsError` on
// overflow). The rest of the codebase tolerates higher row numbers in
// transient API calls (`getCell("A99999999")`) because those never
// reach the file format; print references do.
const EXCEL_MAX_ROW = 1048576;

/**
 * Parse a row token (the digits portion of a cell reference, or a
 * whole-row number) into a canonical integer string.
 *
 * Rejects:
 *   - row 0 (Excel rows are 1-indexed; `$A$0` is never a valid Excel ref)
 *   - rows beyond `EXCEL_MAX_ROW` (Excel hard limit)
 *
 * Normalises:
 *   - leading zeros (`001` → `1`) — OOXML expects bare integers, and
 *     `Number(...)` collapses any padding the user typed.
 */
function parseRowToken(token: string): string {
  // The caller has already matched the token against `\d+`, so `Number`
  // is safe (no NaN). We re-emit the canonical decimal form to drop
  // leading zeros the user typed.
  const n = Number(token);
  if (n < 1) {
    throw new RowOutOfBoundsError(n, `Excel rows are 1-indexed; row ${token} is invalid`);
  }
  if (n > EXCEL_MAX_ROW) {
    throw new RowOutOfBoundsError(n, `Excel supports rows from 1 to ${EXCEL_MAX_ROW}`);
  }
  return String(n);
}

/**
 * Parse a single user- or OOXML-supplied print reference into one of
 * Excel's four valid shapes (cell / range / row / column), discarding
 * any sheet prefix the input carries. Both the writer and the reader
 * route through this single parser so the two sides agree on what is
 * accepted and how it is canonicalised.
 *
 * Accepts every form Excel itself accepts on input, regardless of which
 * side calls it:
 *   - cell: `A1`, `$A$1`, `Sheet1!$A$1`, `'Q,F'!$A$1`, `a1`
 *   - range: `A1:B5`, `$A$1:$B$5`, `Sheet!A1:B5`, ` A1 : B5 `, `a1:b5`,
 *     mixed `$A1:$B$5`, reversed `B5:A1` (canonicalised to `A1:B5`)
 *   - whole row: `1:5`, `$1:$5`, `Sheet!$1:$5`, `5` (single row),
 *     reversed `5:1` (canonicalised to `1:5`), padded `001:005`
 *   - whole column: `A:C`, `$A:$C`, `Sheet!$A:$C`, `C` (single column),
 *     `a:c`, reversed `C:A` (canonicalised to `A:C`)
 *
 * Returns `undefined` for inputs that do not match one of the four
 * shapes — callers drop the entry rather than emit corrupt XML.
 *
 * **Throws**:
 *   - `ColumnOutOfBoundsError` when the input parses as a valid shape
 *     but references a column letter beyond Excel's XFD (16384) limit.
 *   - `RowOutOfBoundsError` for row 0 (Excel rows are 1-indexed) or
 *     rows beyond Excel's `1048576` limit.
 *
 * Both errors match what `getCell` and `colCache.l2n` already throw for
 * the same inputs; surfacing them here means a user who hand-authors a
 * malformed `printArea` finds out at write time rather than producing
 * a workbook Excel silently rejects.
 *
 * Why a hand-rolled parser instead of `colCache.decodeEx`? `decodeEx`
 * was designed for cell addresses and produces `NaN`-laced output for
 * whole-row (`$1:$5`) and whole-column (`$A:$C`) references. Print
 * areas and print titles legitimately use both, so we need a parser
 * that recognises all four shapes uniformly *and* canonicalises
 * reversed endpoints (which `decodeEx` does for cells but not for
 * row/column references).
 */
function parsePrintReference(input: string): PrintReference | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  // Strip the sheet prefix if present (we anchor by `localSheetId`,
  // never by the prefix). Any prefix the caller supplies is discarded.
  const exclamation = findUnquotedExclamation(trimmed);
  const body = exclamation === -1 ? trimmed : trimmed.slice(exclamation + 1);
  // Strip every `$`, every whitespace, and upper-case the remaining
  // letters in one pass. This subsumes mixed/redundant `$` signs
  // (`$A1:$B$5` → `A1:B5`), surrounding/internal whitespace
  // (`A1 : B5` → `A1:B5`), and lowercase columns (`a1:b5` → `A1:B5`).
  const cleaned = body.replace(/[\s$]+/g, "").toUpperCase();
  if (!cleaned) {
    return undefined;
  }
  const parts = cleaned.split(":");
  if (parts.length > 2) {
    return undefined;
  }
  const startRaw = parts[0];
  const endRaw = parts.length === 2 ? parts[1] : startRaw;

  // Cell shape: both endpoints are full `<col><row>` addresses.
  const cellRe = /^([A-Z]+)(\d+)$/;
  const startCell = cellRe.exec(startRaw);
  const endCell = cellRe.exec(endRaw);
  if (startCell && endCell) {
    // Validate column letters against Excel's XFD (16384) limit and
    // rows against the `1..1048576` band. `l2n` and `parseRowToken`
    // throw the project-standard errors here so the caller (and end
    // user) sees a familiar diagnosis when they hand-author a bad ref.
    // We keep the column numbers around to canonicalise reversed
    // endpoints below without a second lookup.
    const startColNum = colCache.l2n(startCell[1]);
    const endColNum = colCache.l2n(endCell[1]);
    const startRow = Number(parseRowToken(startCell[2]));
    const endRow = Number(parseRowToken(endCell[2]));

    // Canonicalise reversed endpoints. Excel's UI never produces
    // `B5:A1`, but a hand-authored input might; downstream consumers
    // (PDF layout, the OOXML reader's sort comparators) assume
    // top-left → bottom-right ordering, so we sort here once.
    const tlCol = startColNum <= endColNum ? startCell[1] : endCell[1];
    const brCol = startColNum <= endColNum ? endCell[1] : startCell[1];
    const tlRow = startRow <= endRow ? startRow : endRow;
    const brRow = startRow <= endRow ? endRow : startRow;

    // A bare cell (no `:` in the input) is the only true `cell` shape.
    // `A1:A1` — a `:`-bearing range whose endpoints happen to coincide —
    // is reported as `range`, matching the user's typed intent and
    // avoiding the question of whether `parts.length === 2 && tl === br`
    // should round-trip as a cell or a degenerate range.
    if (parts.length === 1) {
      return {
        kind: "cell",
        ooxml: `$${tlCol}$${tlRow}`,
        dimensions: `${tlCol}${tlRow}`
      };
    }
    return {
      kind: "range",
      ooxml: `$${tlCol}$${tlRow}:$${brCol}$${brRow}`,
      dimensions: `${tlCol}${tlRow}:${brCol}${brRow}`
    };
  }

  // Whole-row shape: both endpoints are bare row numbers.
  if (/^\d+$/.test(startRaw) && /^\d+$/.test(endRaw)) {
    const startRow = Number(parseRowToken(startRaw));
    const endRow = Number(parseRowToken(endRaw));
    const tl = Math.min(startRow, endRow);
    const br = Math.max(startRow, endRow);
    return {
      kind: "row",
      ooxml: `$${tl}:$${br}`,
      dimensions: `${tl}:${br}`
    };
  }

  // Whole-column shape: both endpoints are bare column letters. We
  // reuse `l2n`'s already-validated index to canonicalise reversed
  // endpoints — `colCache.l2n` is the project-wide source of truth for
  // column ordering.
  if (/^[A-Z]+$/.test(startRaw) && /^[A-Z]+$/.test(endRaw)) {
    const startNum = colCache.l2n(startRaw);
    const endNum = colCache.l2n(endRaw);
    const tl = startNum <= endNum ? startRaw : endRaw;
    const br = startNum <= endNum ? endRaw : startRaw;
    return {
      kind: "col",
      ooxml: `$${tl}:$${br}`,
      dimensions: `${tl}:${br}`
    };
  }

  return undefined;
}

/**
 * Normalise a user-supplied `printArea` value into the canonical OOXML
 * `'Sheet'!<ref>` form. Returns `undefined` for malformed input so the
 * caller drops the entry instead of emitting corrupt XML.
 *
 * `printArea` accepts cell, range, whole-row, and whole-column shapes —
 * Excel itself supports all four (e.g. selecting entire columns A:C as
 * the print area is a common UI gesture). Bare cell inputs are promoted
 * to a degenerate range `$A$1:$A$1` because that is what Excel itself
 * emits for a single-cell print area, and the worksheet API exposes
 * `printArea` as a range string (single-cell entries surface as `A1:A1`).
 */
export function normalisePrintAreaRange(input: string, sheetName: string): string | undefined {
  const ref = parsePrintReference(input);
  if (!ref) {
    return undefined;
  }
  const ooxml = ref.kind === "cell" ? `${ref.ooxml}:${ref.ooxml}` : ref.ooxml;
  return `${quoteSheetName(sheetName)}!${ooxml}`;
}

/**
 * Normalise a user-supplied print-titles row or column expression into
 * the canonical OOXML form `'Sheet'!$N:$N` (rows) or `'Sheet'!$L:$L`
 * (columns).
 *
 * Long-standing documonster behaviour lets users put a column expression on
 * `printTitlesRow` (and vice versa) — the OOXML reader has always
 * re-classified the value onto the correct field on round-trip — so we
 * honour that by letting the parser infer the actual axis from the
 * input shape. Strict enforcement would silently drop print titles
 * users have set successfully for years.
 */
export function normalisePrintTitlesAxis(input: string, sheetName: string): string | undefined {
  const ref = parsePrintReference(input);
  if (!ref || (ref.kind !== "row" && ref.kind !== "col")) {
    return undefined;
  }
  return `${quoteSheetName(sheetName)}!${ref.ooxml}`;
}

export { WorkbookXform };
