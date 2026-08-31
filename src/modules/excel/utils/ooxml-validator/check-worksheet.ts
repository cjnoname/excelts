/**
 * Worksheet check — the largest and most important part of the validator.
 *
 * Covers four new structural checks beyond the original wiring check:
 *   1. **Child element ordering** — `<worksheet>` children must appear in
 *      the ECMA-376 canonical order. Excel is known to reject files with
 *      out-of-order children; this is a top cause of "Excel needs to
 *      repair" prompts.
 *   2. **Cell `r="A1"` consistency** — every `<c r="…"/>` inside a
 *      `<row r="N"/>` must decode to row `N` and to a column in
 *      `[1, 16384]` (Excel's max column limit, XFD).
 *   3. **Merge region overlap** — every `<mergeCell ref="A1:B2"/>` must
 *      parse and no two merged ranges may overlap.
 *   4. **Style / SST index bounds** — every `<c s="N"/>` must reference a
 *      valid `cellXfs` index, and every `<c t="s"><v>N</v></c>` must
 *      reference an existing `sharedStrings` index.
 *
 * Plus the legacy r:id wiring checks (controls, drawing, comments,
 * hyperlink, tablePart, legacyDrawing) and the "controls without
 * drawing" repair signal. The old "legacyDrawing-after-controls" kind is
 * kept for backward compatibility — it is emitted in parallel with the
 * generic `sheet-child-out-of-order` kind.
 */

import { decodeCol, decodeRow } from "@excel/utils/address";
import type { ValidationContext } from "@excel/utils/ooxml-validator/context";
import { posixBasename } from "@excel/utils/ooxml-validator/path-utils";
import type { OoxmlProblemKind } from "@excel/utils/ooxml-validator/types";
import {
  attrByLocalName,
  collectDescendantsLocal,
  findChildLocal,
  findChildrenLocal,
  matchesLocal
} from "@excel/utils/ooxml-validator/xml-utils";
import { parse } from "@formula/syntax/parser";
import { tokenize } from "@formula/syntax/tokenizer";
import { textContent } from "@xml/dom";
import type { XmlElement } from "@xml/types";

// -----------------------------------------------------------------------------
// ECMA-376 worksheet child order.
// -----------------------------------------------------------------------------

/**
 * Canonical order of `<worksheet>` direct children. The index of each
 * child name within this array is its "rank"; any child with a smaller
 * rank seen after a child with a larger rank is out of order.
 *
 * Names are local names (no namespace prefix). Elements allowed to
 * repeat (like `cols`, `conditionalFormatting`) are still subject to
 * the same rank — two consecutive `cols` blocks is fine, but a `cols`
 * after `sheetData` is not.
 */
const WORKSHEET_CHILD_ORDER: readonly string[] = [
  "sheetPr",
  "dimension",
  "sheetViews",
  "sheetFormatPr",
  "cols",
  "sheetData",
  "sheetCalcPr",
  "sheetProtection",
  "protectedRanges",
  "scenarios",
  "autoFilter",
  "sortState",
  "dataConsolidate",
  "customSheetViews",
  "mergeCells",
  "phoneticPr",
  "conditionalFormatting",
  "dataValidations",
  "hyperlinks",
  "printOptions",
  "pageMargins",
  "pageSetup",
  "headerFooter",
  "rowBreaks",
  "colBreaks",
  "customProperties",
  "cellWatches",
  "ignoredErrors",
  "smartTags",
  "drawing",
  "legacyDrawing",
  "legacyDrawingHF",
  "drawingHF",
  "picture",
  "oleObjects",
  "controls",
  "webPublishItems",
  "tableParts",
  "extLst"
] as const;

const WORKSHEET_CHILD_RANK = new Map(
  WORKSHEET_CHILD_ORDER.map((name, idx) => [name, idx] as const)
);

// Excel 2007+ limits.
const EXCEL_MAX_ROW = 1048576;
const EXCEL_MAX_COL = 16384; // XFD

// -----------------------------------------------------------------------------
// Styles / SST counters (cached lazily from the context).
// -----------------------------------------------------------------------------

interface IndexCounts {
  cellXfs?: number; // number of xf records in cellXfs
  sstSize?: number; // number of si entries in sharedStrings
}

function readCellXfsCount(ctx: ValidationContext): number | undefined {
  const dom = ctx.readDom("xl/styles.xml");
  if (!dom) {
    return undefined;
  }
  const cellXfs = findChildLocal(dom.root, "cellXfs");
  if (!cellXfs) {
    return 0;
  }
  const count = attrByLocalName(cellXfs, "count");
  const n = count !== undefined ? parseInt(count, 10) : NaN;
  if (Number.isFinite(n) && n >= 0) {
    return n;
  }
  return findChildrenLocal(cellXfs, "xf").length;
}

function readSstSize(ctx: ValidationContext): number | undefined {
  const dom = ctx.readDom("xl/sharedStrings.xml");
  if (!dom) {
    return undefined;
  }
  const uniqueCount = attrByLocalName(dom.root, "uniqueCount");
  const n = uniqueCount !== undefined ? parseInt(uniqueCount, 10) : NaN;
  if (Number.isFinite(n) && n >= 0) {
    return n;
  }
  return findChildrenLocal(dom.root, "si").length;
}

function loadIndexCounts(ctx: ValidationContext): IndexCounts {
  return {
    cellXfs: readCellXfsCount(ctx),
    sstSize: readSstSize(ctx)
  };
}

// -----------------------------------------------------------------------------
// Cell address helpers — safe wrappers around `address.ts`.
// -----------------------------------------------------------------------------

/**
 * Parse an A1-style reference into `{ col, row }` (1-based) or
 * `undefined` when the string is not a legal cell reference. Accepts
 * absolute-address `$`-markers produced by some serialisers.
 */
function parseCellRef(ref: string): { col: number; row: number } | undefined {
  // Match optional `$`, letters, optional `$`, digits.
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref);
  if (!m) {
    return undefined;
  }
  try {
    const col = decodeCol(m[1]) + 1;
    const row = decodeRow(m[2]) + 1;
    if (!Number.isFinite(col) || !Number.isFinite(row)) {
      return undefined;
    }
    return { col, row };
  } catch {
    return undefined;
  }
}

interface MergeRect {
  t: number; // top row (1-based, inclusive)
  l: number; // left col (1-based, inclusive)
  b: number; // bottom row
  r: number; // right col
  ref: string;
}

function parseMergeRef(ref: string): MergeRect | undefined {
  const idx = ref.indexOf(":");
  if (idx === -1) {
    const p = parseCellRef(ref);
    return p ? { t: p.row, l: p.col, b: p.row, r: p.col, ref } : undefined;
  }
  const a = parseCellRef(ref.slice(0, idx));
  const b = parseCellRef(ref.slice(idx + 1));
  if (!a || !b) {
    return undefined;
  }
  return {
    t: Math.min(a.row, b.row),
    b: Math.max(a.row, b.row),
    l: Math.min(a.col, b.col),
    r: Math.max(a.col, b.col),
    ref
  };
}

function rectsOverlap(a: MergeRect, b: MergeRect): boolean {
  return a.l <= b.r && b.l <= a.r && a.t <= b.b && b.t <= a.b;
}

// -----------------------------------------------------------------------------
// Public checker
// -----------------------------------------------------------------------------

export function checkWorksheets(ctx: ValidationContext): void {
  let counts: IndexCounts | undefined;
  for (const [path, entry] of ctx.files()) {
    if (ctx.reporter.capped) {
      return;
    }
    if (
      entry.type === "directory" ||
      !path.startsWith("xl/worksheets/sheet") ||
      !path.endsWith(".xml")
    ) {
      continue;
    }
    counts ??= loadIndexCounts(ctx);
    checkSingleWorksheet(ctx, path, counts);
  }
}

function checkSingleWorksheet(ctx: ValidationContext, path: string, counts: IndexCounts): void {
  const dom = ctx.readDom(path, err => {
    ctx.reporter.error("xml-malformed", `Malformed XML: ${err.message}`, path);
  });
  if (!dom) {
    return;
  }
  const root = dom.root;

  // 1) Child element ordering.
  checkChildOrdering(ctx, path, root);

  // 2) Cell ref consistency + style/SST index bounds + sharedFormula masters.
  const sheetData = findChildLocal(root, "sheetData");
  if (sheetData) {
    checkSheetData(ctx, path, sheetData, counts);
  }

  // 3) Merge cell overlap.
  const mergeCells = findChildLocal(root, "mergeCells");
  if (mergeCells) {
    checkMergeCells(ctx, path, mergeCells);
  }

  // 4) Legacy wiring + controls-without-drawing + legacyDrawing ordering.
  checkSheetWiring(ctx, path, root);
}

// -----------------------------------------------------------------------------
// Ordering
// -----------------------------------------------------------------------------

function checkChildOrdering(ctx: ValidationContext, path: string, root: XmlElement): void {
  let maxRank = -1;
  let sawControls = false;
  let sawLegacyDrawingAfterControls = false;

  for (const child of iterateWorksheetChildren(root)) {
    if (child.type !== "element") {
      continue;
    }
    const local = child.name.includes(":")
      ? child.name.slice(child.name.lastIndexOf(":") + 1)
      : child.name;
    const rank = WORKSHEET_CHILD_RANK.get(local);
    if (rank === undefined) {
      // Unknown element — don't flag, someone might have added an extension.
      continue;
    }
    if (rank < maxRank) {
      const expectedAfter = WORKSHEET_CHILD_ORDER[maxRank] ?? "?";
      ctx.reporter.error(
        "sheet-child-out-of-order",
        `Worksheet child <${local}> appears after <${expectedAfter}>; expected order violated`,
        path
      );
      if (local === "legacyDrawing" && sawControls) {
        sawLegacyDrawingAfterControls = true;
      }
    }
    if (rank > maxRank) {
      maxRank = rank;
    }
    if (local === "controls") {
      sawControls = true;
    }
  }

  // Backwards-compat: emit the legacy-specific kind too so existing
  // regression tests that grep for it still match.
  if (sawLegacyDrawingAfterControls) {
    ctx.reporter.error(
      "sheet-legacyDrawing-after-controls",
      "Worksheet has <legacyDrawing> after <controls>; Excel may repair or reject this sheet",
      path
    );
  }
}

/**
 * Yield every direct child of the worksheet — but transparently unwrap
 * `<mc:AlternateContent><mc:Choice>…</mc:Choice></mc:AlternateContent>`.
 * The MCE alternate-content wrapper is a schema-level feature that lets
 * writers express a primary serialisation and a fallback; for ordering
 * purposes the Choice's children are logically in the worksheet itself.
 * Without this flattening, checkers miss the inner `<controls>` element
 * because it hides inside a namespace-prefixed envelope.
 */
function* iterateWorksheetChildren(root: XmlElement): Generator<XmlElement> {
  for (const child of root.children) {
    if (child.type !== "element") {
      continue;
    }
    const local = child.name.includes(":")
      ? child.name.slice(child.name.lastIndexOf(":") + 1)
      : child.name;
    if (local === "AlternateContent") {
      // Use Choice's children (fallback is the degenerate substitute).
      for (const c of child.children) {
        if (c.type !== "element") {
          continue;
        }
        const cLocal = c.name.includes(":") ? c.name.slice(c.name.lastIndexOf(":") + 1) : c.name;
        if (cLocal === "Choice") {
          for (const inner of c.children) {
            if (inner.type === "element") {
              yield inner;
            }
          }
        }
      }
      continue;
    }
    yield child;
  }
}

// -----------------------------------------------------------------------------
// sheetData (cell refs / style idx / SST idx / sharedFormula)
// -----------------------------------------------------------------------------

function checkSheetData(
  ctx: ValidationContext,
  path: string,
  sheetData: XmlElement,
  counts: IndexCounts
): void {
  // Track shared-formula si masters: si -> how many masters have been seen.
  const masterSiCounts = new Map<string, number>();
  // si values referenced by followers that had no master yet.
  const followerSi = new Set<string>();

  for (const row of sheetData.children) {
    if (ctx.reporter.capped) {
      return;
    }
    if (row.type !== "element" || !matchesLocal(row.name, "row")) {
      continue;
    }
    const rowAttr = attrByLocalName(row, "r");
    const rowIndex = rowAttr !== undefined ? parseInt(rowAttr, 10) : NaN;
    if (Number.isFinite(rowIndex)) {
      if (rowIndex < 1 || rowIndex > EXCEL_MAX_ROW) {
        ctx.reporter.error(
          "sheet-row-index-out-of-bounds",
          `Row r="${rowAttr}" is outside Excel's limit 1..${EXCEL_MAX_ROW}`,
          path
        );
      }
    }

    for (const cell of row.children) {
      if (ctx.reporter.capped) {
        return;
      }
      if (cell.type !== "element" || !matchesLocal(cell.name, "c")) {
        continue;
      }
      checkCell(ctx, path, cell, Number.isFinite(rowIndex) ? rowIndex : undefined, counts);
      checkSharedFormula(cell, masterSiCounts, followerSi);
    }
  }

  // Shared-formula: every follower si must have a master, every si must
  // have exactly one master.
  for (const [si, n] of masterSiCounts) {
    if (n > 1) {
      ctx.reporter.error(
        "sheet-sharedFormula-duplicate-master",
        `Shared formula si="${si}" has ${n} master entries (should be exactly one)`,
        path
      );
    }
  }
  for (const si of followerSi) {
    if (!masterSiCounts.has(si)) {
      ctx.reporter.error(
        "sheet-sharedFormula-master-missing",
        `Shared formula si="${si}" has no master entry`,
        path
      );
    }
  }
}

function checkCell(
  ctx: ValidationContext,
  path: string,
  cell: XmlElement,
  rowIndex: number | undefined,
  counts: IndexCounts
): void {
  const ref = attrByLocalName(cell, "r");
  if (ref === undefined) {
    ctx.reporter.error("sheet-cell-ref-missing", `Cell missing r="" attribute`, path);
    return;
  }
  const parsed = parseCellRef(ref);
  if (!parsed) {
    ctx.reporter.error("sheet-cell-ref-invalid", `Cell has invalid r="${ref}"`, path);
    return;
  }
  if (
    parsed.col < 1 ||
    parsed.col > EXCEL_MAX_COL ||
    parsed.row < 1 ||
    parsed.row > EXCEL_MAX_ROW
  ) {
    ctx.reporter.error(
      "sheet-cell-ref-out-of-bounds",
      `Cell r="${ref}" is outside Excel's sheet bounds (max XFD1048576)`,
      path
    );
  }
  if (rowIndex !== undefined && parsed.row !== rowIndex) {
    ctx.reporter.error(
      "sheet-cell-ref-row-mismatch",
      `Cell r="${ref}" has row ${parsed.row} but is inside <row r="${rowIndex}">`,
      path
    );
  }
  // The formula, parsed rather than pattern-matched.
  //
  // This check exists because a single invalid formula makes Excel refuse to open the workbook —
  // "we found a problem with some content", and its repair log says `Removed Records: Formula from
  // /xl/worksheets/sheet1.xml part`. Nothing else here noticed: the XML is well-formed, the cell
  // reference is valid, the style index is in range, and the formula is a string like any other.
  //
  // Parsed with this library's own parser rather than checked against a pattern, because the
  // question is exactly "would a spreadsheet accept this", and the parser is the only thing here
  // that can answer it. The example that produced the file above wrote
  // `CONCATENATE(A6,', ',B6,'!')` — single quotes delimit a *sheet name* in a formula, never a
  // string, so that is a syntax error rather than a stylistic choice.
  for (const formula of findChildrenLocal(cell, "f")) {
    const text = textContent(formula).trim();
    // A shared formula's dependent cells carry an empty `<f t="shared" si="…"/>`, and an array
    // formula's covered cells the same — nothing to parse, and nothing wrong.
    if (text.length === 0) {
      continue;
    }
    try {
      parse(tokenize(text));
    } catch (cause) {
      ctx.reporter.error(
        "sheet-formula-unparseable",
        `Cell r="${ref}" has a formula Excel will reject: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}` +
          ` (${cause instanceof Error ? cause.message : String(cause)})`,
        path
      );
    }
  }

  // Style index.
  const styleAttr = attrByLocalName(cell, "s");
  if (styleAttr !== undefined && counts.cellXfs !== undefined) {
    const s = parseInt(styleAttr, 10);
    if (!Number.isFinite(s) || s < 0 || s >= counts.cellXfs) {
      ctx.reporter.error(
        "sheet-cell-style-index-oob",
        `Cell r="${ref}" s="${styleAttr}" is outside cellXfs range [0, ${counts.cellXfs})`,
        path
      );
    }
  }
  // Shared-strings index (t="s" means cell value is an index into sharedStrings).
  const typeAttr = attrByLocalName(cell, "t");
  if (typeAttr === "s" && counts.sstSize !== undefined) {
    const v = findChildLocal(cell, "v");
    if (v) {
      const text = textContent(v).trim();
      const n = parseInt(text, 10);
      if (!Number.isFinite(n) || n < 0 || n >= counts.sstSize) {
        ctx.reporter.error(
          "sheet-cell-sst-index-oob",
          `Cell r="${ref}" references sharedStrings index ${text} but SST has ${counts.sstSize} entries`,
          path
        );
      }
    }
  }
}

function checkSharedFormula(
  cell: XmlElement,
  masterSiCounts: Map<string, number>,
  followerSi: Set<string>
): void {
  const f = findChildLocal(cell, "f");
  if (!f) {
    return;
  }
  const t = attrByLocalName(f, "t");
  if (t !== "shared") {
    return;
  }
  const si = attrByLocalName(f, "si");
  if (si === undefined) {
    return;
  }
  const hasRef = attrByLocalName(f, "ref") !== undefined;
  const hasBody = textContent(f).trim().length > 0;
  // A master is identified by having a `ref` attribute (range); a follower
  // has just `si` with an empty body. Some producers also emit a body on
  // masters, which is fine.
  if (hasRef || hasBody) {
    masterSiCounts.set(si, (masterSiCounts.get(si) ?? 0) + 1);
  } else {
    followerSi.add(si);
  }
}

// -----------------------------------------------------------------------------
// mergeCells
// -----------------------------------------------------------------------------

function checkMergeCells(ctx: ValidationContext, path: string, mergeCells: XmlElement): void {
  const rects: MergeRect[] = [];
  for (const mc of findChildrenLocal(mergeCells, "mergeCell")) {
    if (ctx.reporter.capped) {
      return;
    }
    const ref = attrByLocalName(mc, "ref");
    if (!ref) {
      ctx.reporter.error("sheet-merge-invalid-range", `<mergeCell> missing ref attribute`, path);
      continue;
    }
    const rect = parseMergeRef(ref);
    if (!rect) {
      ctx.reporter.error(
        "sheet-merge-invalid-range",
        `<mergeCell ref="${ref}"> does not parse as a range`,
        path
      );
      continue;
    }
    for (const prior of rects) {
      if (rectsOverlap(prior, rect)) {
        ctx.reporter.error(
          "sheet-merge-overlap",
          `Merge ${ref} overlaps with earlier merge ${prior.ref}`,
          path
        );
        break;
      }
    }
    rects.push(rect);
  }
}

// -----------------------------------------------------------------------------
// Legacy wiring (controls / drawing / comments / hyperlink / tablePart)
// -----------------------------------------------------------------------------

interface RidUsage {
  rid: string;
  kind: "control" | "legacyDrawing" | "drawing" | "comments" | "tablePart" | "hyperlink";
  typeIncludes: string;
  missingKind: OoxmlProblemKind;
  wrongKind: OoxmlProblemKind;
  label: string;
}

function checkSheetWiring(ctx: ValidationContext, path: string, root: XmlElement): void {
  const relsPath = `xl/worksheets/_rels/${posixBasename(path)}.rels`;

  // Resolve the effective worksheet children, flattening AlternateContent/Choice.
  const effectiveChildren: XmlElement[] = [];
  for (const child of iterateWorksheetChildren(root)) {
    effectiveChildren.push(child);
  }
  const firstLocal = (el: XmlElement): string =>
    el.name.includes(":") ? el.name.slice(el.name.lastIndexOf(":") + 1) : el.name;

  const uses: RidUsage[] = [];
  const controls = effectiveChildren.find(el => firstLocal(el) === "controls");
  if (controls) {
    // `<control>` elements may be wrapped in inner
    // `<mc:AlternateContent><mc:Choice>…` blocks (one per control). Use
    // a recursive descent so we pick them up regardless of nesting.
    for (const c of collectDescendantsLocal(controls, "control")) {
      const rid = attrByLocalName(c, "id");
      if (rid) {
        uses.push({
          rid,
          kind: "control",
          typeIncludes: "/relationships/ctrlProp",
          missingKind: "sheet-control-missing-rel",
          wrongKind: "sheet-control-wrong-rel-type",
          label: "<control>"
        });
      }
    }
  }
  const legacyDrawing = effectiveChildren.find(el => firstLocal(el) === "legacyDrawing");
  if (legacyDrawing) {
    const rid = attrByLocalName(legacyDrawing, "id");
    if (rid) {
      uses.push({
        rid,
        kind: "legacyDrawing",
        typeIncludes: "/relationships/vmlDrawing",
        missingKind: "sheet-legacyDrawing-missing-rel",
        wrongKind: "sheet-legacyDrawing-wrong-rel-type",
        label: "<legacyDrawing>"
      });
    }
  }
  const drawing = effectiveChildren.find(el => firstLocal(el) === "drawing");
  if (drawing) {
    const rid = attrByLocalName(drawing, "id");
    if (rid) {
      uses.push({
        rid,
        kind: "drawing",
        typeIncludes: "/relationships/drawing",
        missingKind: "sheet-drawing-missing-rel",
        wrongKind: "sheet-drawing-wrong-rel-type",
        label: "<drawing>"
      });
    }
  }
  const hyperlinks = effectiveChildren.find(el => firstLocal(el) === "hyperlinks");
  if (hyperlinks) {
    for (const hl of findChildrenLocal(hyperlinks, "hyperlink")) {
      const rid = attrByLocalName(hl, "id");
      if (rid) {
        uses.push({
          rid,
          kind: "hyperlink",
          typeIncludes: "/relationships/hyperlink",
          missingKind: "sheet-hyperlink-missing-rel",
          wrongKind: "sheet-hyperlink-wrong-rel-type",
          label: "<hyperlink>"
        });
      }
    }
  }
  const tableParts = effectiveChildren.find(el => firstLocal(el) === "tableParts");
  if (tableParts) {
    for (const tp of findChildrenLocal(tableParts, "tablePart")) {
      const rid = attrByLocalName(tp, "id");
      if (rid) {
        uses.push({
          rid,
          kind: "tablePart",
          typeIncludes: "/relationships/table",
          missingKind: "sheet-tablePart-missing-rel",
          wrongKind: "sheet-tablePart-wrong-rel-type",
          label: "<tablePart>"
        });
      }
    }
  }
  // `<comments r:id="..."/>` is not actually a standard worksheet child — the
  // comments relationship is normally declared without a `<comments>` element
  // in the sheet. But the original validator matched this pattern, so keep
  // the behaviour for any serialiser that emits it.
  for (const c of effectiveChildren.filter(el => firstLocal(el) === "comments")) {
    const rid = attrByLocalName(c, "id");
    if (rid) {
      uses.push({
        rid,
        kind: "comments",
        typeIncludes: "/relationships/comments",
        missingKind: "sheet-comments-missing-rel",
        wrongKind: "sheet-comments-wrong-rel-type",
        label: "<comments>"
      });
    }
  }

  // controls without drawing -> repair signal.
  const hasControl = uses.some(u => u.kind === "control");
  const hasDrawing = uses.some(u => u.kind === "drawing");
  if (hasControl && !hasDrawing) {
    ctx.reporter.error(
      "sheet-controls-missing-drawing",
      "Worksheet has legacy <controls> but no <drawing>; Excel may repair/reject legacy form controls",
      path
    );
  }

  // If there are any r:ids in use, rels file must exist.
  if (uses.length > 0 && !ctx.has(relsPath)) {
    ctx.reporter.error(
      "sheet-missing-rels",
      `Worksheet has controls/legacyDrawing/drawing/hyperlinks/tableParts but missing rels part: ${relsPath}`,
      path
    );
    return;
  }
  if (!ctx.has(relsPath)) {
    return;
  }
  const rels = ctx.readRels(relsPath);

  for (const use of uses) {
    if (ctx.reporter.capped) {
      return;
    }
    const rel = rels.byId.get(use.rid);
    if (!rel) {
      ctx.reporter.error(
        use.missingKind,
        `Sheet ${use.label} references missing relationship: ${use.rid} (in ${relsPath})`,
        path
      );
      continue;
    }
    if (!rel.type.includes(use.typeIncludes)) {
      ctx.reporter.error(
        use.wrongKind,
        `Sheet ${use.label} ${use.rid} relationship is not ${use.typeIncludes}: ${rel.type}`,
        path
      );
    }
  }
}
