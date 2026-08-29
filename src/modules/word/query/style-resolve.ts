/**
 * Style Resolution (Effective/Computed Style)
 *
 * Resolve the effective style for a paragraph by walking the style inheritance chain.
 */

import type {
  DocxDocument,
  Paragraph,
  ParagraphProperties,
  Run,
  RunProperties,
  Shading,
  StyleDef,
  Table,
  TableCell,
  TableLook,
  NumberingLevel,
  TableProperties,
  TableStyleConditionalFormat,
  TableStyleConditionType
} from "@word/types";

// =============================================================================
// Types
// =============================================================================

/** Context for style resolution when a paragraph is inside a table. */
export interface StyleResolveContext {
  /** If the paragraph is inside a table, provide table context. */
  readonly tableContext?: {
    readonly tableStyleId?: string;
    readonly tblLook?: TableLook;
    readonly rowIndex: number;
    readonly colIndex: number;
    readonly totalRows: number;
    readonly totalCols: number;
    /** `w:tblStyleRowBandSize` — rows per stripe. Defaults to 1. */
    readonly rowBandSize?: number;
    /** `w:tblStyleColBandSize` — columns per stripe. Defaults to 1. */
    readonly colBandSize?: number;
  };
}

/** Resolved paragraph properties with all inherited values merged. */
export interface ResolvedParagraphStyle {
  /** The style chain (from most specific to base). */
  readonly chain: readonly string[];
  /** Merged paragraph properties (inherited + own). */
  readonly paragraphProperties: ParagraphProperties;
  /** Merged run properties (inherited + own). */
  readonly runProperties: RunProperties;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Resolve the effective (computed) style for a paragraph by walking the style inheritance chain.
 *
 * Merges properties from the document defaults → base style chain → table conditional formats → paragraph's own properties.
 *
 * @param doc - The document containing styles and defaults.
 * @param para - The paragraph to resolve styles for.
 * @param context - Optional context providing table position for conditional format overlay.
 * @returns The fully resolved paragraph style with all inherited properties merged.
 */
export function resolveStyle(
  doc: DocxDocument,
  para: Paragraph,
  context?: StyleResolveContext
): ResolvedParagraphStyle {
  const styleMap = new Map<string, StyleDef>();
  if (doc.styles) {
    for (const s of doc.styles) {
      styleMap.set(s.styleId, s);
    }
  }

  // Walk the chain from paragraph's style to root
  const chain: string[] = [];
  const styleId = para.properties?.style;
  if (styleId) {
    let current: string | undefined = styleId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      chain.push(current);
      const def = styleMap.get(current);
      current = def?.basedOn;
    }
  }

  // Build merged properties: start from doc defaults, apply chain bottom-up, then paragraph
  let mergedPProps: Record<string, unknown> = {};
  let mergedRProps: Record<string, unknown> = {};

  // Document defaults
  if (doc.docDefaults) {
    if (doc.docDefaults.paragraphProperties) {
      mergedPProps = mergeProperties({}, doc.docDefaults.paragraphProperties);
    }
    if (doc.docDefaults.runProperties) {
      mergedRProps = mergeProperties({}, doc.docDefaults.runProperties);
    }
  }

  // Apply style chain (from base to most specific)
  for (let i = chain.length - 1; i >= 0; i--) {
    const def = styleMap.get(chain[i]);
    if (!def) {
      continue;
    }
    if (def.paragraphProperties) {
      mergedPProps = mergeProperties(mergedPProps, def.paragraphProperties);
    }
    if (def.runProperties) {
      mergedRProps = mergeProperties(mergedRProps, def.runProperties);
    }
    // Linked styles: if a paragraph style links to a character style, merge its runProperties.
    // The linked character style's runProperties layer on top of the paragraph style's own
    // runProperties at the same level, giving the linked style slightly higher specificity.
    if (def.type === "paragraph" && def.link) {
      const linkedDef = styleMap.get(def.link);
      if (linkedDef?.type === "character" && linkedDef.runProperties) {
        mergedRProps = mergeProperties(mergedRProps, linkedDef.runProperties);
      }
    }
  }

  // Apply table conditional format overlay (higher priority than base table/paragraph style,
  // but lower priority than paragraph's own direct properties).
  if (context?.tableContext?.tableStyleId) {
    const tblCtx = context.tableContext;
    const tableStyleId: string = tblCtx.tableStyleId!;
    const tblStyleDef = styleMap.get(tableStyleId);
    if (tblStyleDef?.tableStyleConditions) {
      const matchingConditions = getMatchingTableConditions(
        tblStyleDef.tableStyleConditions,
        tblCtx.tblLook,
        tblCtx.rowIndex,
        tblCtx.colIndex,
        tblCtx.totalRows,
        tblCtx.totalCols,
        {
          row: tblCtx.rowBandSize ?? tblStyleDef.tableProperties?.rowBandSize,
          column: tblCtx.colBandSize ?? tblStyleDef.tableProperties?.colBandSize
        }
      );
      for (const cond of matchingConditions) {
        if (cond.paragraphProperties) {
          mergedPProps = mergeProperties(mergedPProps, cond.paragraphProperties);
        }
        if (cond.runProperties) {
          mergedRProps = mergeProperties(mergedRProps, cond.runProperties);
        }
      }
    }
  }

  // Apply paragraph's own properties (most specific)
  if (para.properties) {
    const { style: _s, sectionProperties: _sp, ...ownPProps } = para.properties;
    mergedPProps = mergeProperties(mergedPProps, ownPProps);
  }

  return {
    chain,
    paragraphProperties: mergedPProps as ParagraphProperties,
    runProperties: mergedRProps as RunProperties
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Property keys whose value OOXML expresses as a bag of independently
 * inherited attributes — or, for `borders` and `cellMargins`, as a container of
 * independently inherited child elements.
 *
 * Word merges these one attribute at a time down the style hierarchy: a style
 * declaring `<w:spacing w:after="154"/>` does **not** reset the `w:line` it
 * inherited, and `<w:ind w:left="720"/>` does not reset `w:firstLine`.
 * Replacing the whole value instead silently dropped whatever a lower level had
 * set, which is how `ListParagraph` — declaring only `after` — lost the
 * document default's 1.31 line spacing and rendered every list item at single
 * spacing while the paragraphs around it stayed 24% looser.
 *
 * A key is listed only when the merge can actually change something. A `Border`
 * or a `TableWidth` has a required member, so no level can declare half of one
 * and replacing it whole is already the correct answer.
 */
const MERGEABLE_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  "spacing", // w:spacing — before / after / line / lineRule
  "indent", // w:ind — left / right / firstLine / hanging / start / end
  "borders", // w:pBdr / w:tblBorders / w:tcBorders — per side
  "cellMargins", // w:tblCellMar — per side
  "shading", // w:shd — val / color / fill
  "font", // w:rFonts — ascii / hAnsi / eastAsia / cs and their themes
  "language", // w:lang — val / eastAsia / bidi
  "color", // w:color — val / themeColor / themeTint / themeShade
  "underline", // w:u — val / color
  "look", // w:tblLook
  "float", // w:tblpPr
  "frame", // w:framePr
  "markRunProperties" // the paragraph mark's w:rPr — merges like any other rPr
]);

/** Whether a value is a mergeable object rather than a scalar or an array. */
function isPropertyBag(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Layer one style-hierarchy level onto the levels below it.
 *
 * An absent member means "inherit", not "reset", so `undefined` never erases
 * what a lower level set. The attribute-bag keys above are merged rather than
 * replaced, and recursively: `markRunProperties` therefore gets the same
 * treatment as a top-level run-properties bag, and a `borders` container merges
 * per side while each side is still replaced whole.
 *
 * The `isPropertyBag` guard on both sides is what lets a single key set serve
 * paragraph, run and table properties even where a name is reused for different
 * shapes — `RunProperties.spacing` is a `Twips` and `TableProperties.indent` a
 * number, and a scalar never takes the merge branch.
 */
function mergeProperties(base: Record<string, unknown>, override: object): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const existing = result[key];
    if (MERGEABLE_PROPERTY_KEYS.has(key) && isPropertyBag(existing) && isPropertyBag(value)) {
      result[key] = mergeProperties(existing, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Determine which table style conditions match the given cell position.
 *
 * Returns matching conditions in application order (banding → whole row/col → corner cells).
 * Within Word, the specificity order from lowest to highest is:
 *   banding → first/last row/col → corner cells.
 */
function getMatchingTableConditions(
  conditions: readonly TableStyleConditionalFormat[],
  look: TableLook | undefined,
  rowIndex: number,
  colIndex: number,
  totalRows: number,
  totalCols: number,
  bandSize?: { readonly row?: number; readonly column?: number }
): TableStyleConditionalFormat[] {
  // Resolve effective banding flags: noHBand means band rows are disabled,
  // noVBand means band columns are disabled.
  const bandRow = look?.noHBand !== true;
  const bandCol = look?.noVBand !== true;

  // `w:tblStyleRowBandSize` / `w:tblStyleColBandSize`: how many rows or columns
  // make up one stripe. Alternating per single row regardless of it turned every
  // "banded by twos" table style into a one-row zebra.
  const rowBand = Math.max(1, Math.trunc(bandSize?.row ?? 1));
  const colBand = Math.max(1, Math.trunc(bandSize?.column ?? 1));

  // Build a set of applicable condition types based on position and tblLook.
  const applicable = new Set<TableStyleConditionType>();

  // Banding (lowest priority among conditions)
  if (bandRow) {
    if (Math.floor(rowIndex / rowBand) % 2 === 0) {
      applicable.add("oddRowBanding");
    } else {
      applicable.add("evenRowBanding");
    }
  }
  if (bandCol) {
    if (Math.floor(colIndex / colBand) % 2 === 0) {
      applicable.add("oddColumnBanding");
    } else {
      applicable.add("evenColumnBanding");
    }
  }

  // Whole row/column conditions
  if (rowIndex === 0 && look?.firstRow !== false) {
    applicable.add("firstRow");
  }
  if (rowIndex === totalRows - 1 && look?.lastRow !== false) {
    applicable.add("lastRow");
  }
  if (colIndex === 0 && look?.firstColumn !== false) {
    applicable.add("firstColumn");
  }
  if (colIndex === totalCols - 1 && look?.lastColumn !== false) {
    applicable.add("lastColumn");
  }

  // Corner cells (highest priority among conditions)
  if (rowIndex === 0 && colIndex === 0 && look?.firstRow !== false && look?.firstColumn !== false) {
    applicable.add("topLeftCell");
  }
  if (
    rowIndex === 0 &&
    colIndex === totalCols - 1 &&
    look?.firstRow !== false &&
    look?.lastColumn !== false
  ) {
    applicable.add("topRightCell");
  }
  if (
    rowIndex === totalRows - 1 &&
    colIndex === 0 &&
    look?.lastRow !== false &&
    look?.firstColumn !== false
  ) {
    applicable.add("bottomLeftCell");
  }
  if (
    rowIndex === totalRows - 1 &&
    colIndex === totalCols - 1 &&
    look?.lastRow !== false &&
    look?.lastColumn !== false
  ) {
    applicable.add("bottomRightCell");
  }

  // Filter and sort conditions by specificity order:
  // banding < first/last row/col < corner cells
  const priorityOrder: readonly TableStyleConditionType[] = [
    "oddRowBanding",
    "evenRowBanding",
    "oddColumnBanding",
    "evenColumnBanding",
    "firstRow",
    "lastRow",
    "firstColumn",
    "lastColumn",
    "topLeftCell",
    "topRightCell",
    "bottomLeftCell",
    "bottomRightCell"
  ];
  const priorityMap = new Map<TableStyleConditionType, number>();
  for (let i = 0; i < priorityOrder.length; i++) {
    priorityMap.set(priorityOrder[i], i);
  }

  return conditions
    .filter(c => applicable.has(c.type))
    .sort((a, b) => (priorityMap.get(a.type) ?? 0) - (priorityMap.get(b.type) ?? 0));
}

// =============================================================================
// Table cell formatting
// =============================================================================

/** Where a cell sits in its table, which is what selects the conditional formats. */
export interface TableCellPosition {
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly totalRows: number;
  readonly totalCols: number;
}

/** Cell-level formatting a table style contributes to one cell position. */
export interface ResolvedTableCellStyle {
  /** Effective background shading, or undefined for no fill. */
  readonly shading?: Shading;
}

/**
 * Resolve the cell-level formatting a table style contributes at one position.
 *
 * This is where Word's built-in table styles keep the look that makes a table
 * read as a table: the header band, the alternating row stripes, the emphasised
 * corner cells. They live in `tableStyleConditions[].cellProperties`, which
 * `resolveStyle` deliberately ignores (it answers a question about a paragraph),
 * so cells need their own resolution pass.
 *
 * Precedence, lowest to highest — matching Word:
 *   1. the table style chain's base `tableProperties.shading`
 *   2. its conditional formats, in `getMatchingTableConditions` order
 *      (banding → first/last row/column → corner cells)
 *
 * A cell's own `w:shd` and the table's direct `w:tblPr/w:shd` are *direct*
 * formatting and outrank everything here; callers apply them on top.
 */
export function resolveTableCellStyle(
  doc: DocxDocument,
  tableStyleId: string | undefined,
  look: TableLook | undefined,
  position: TableCellPosition,
  bandSize?: { readonly row?: number; readonly column?: number }
): ResolvedTableCellStyle {
  if (!tableStyleId || !doc.styles) {
    return {};
  }
  const styleMap = new Map<string, StyleDef>();
  for (const s of doc.styles) {
    styleMap.set(s.styleId, s);
  }

  // Style chain, most specific first.
  const chain: StyleDef[] = [];
  let current: string | undefined = tableStyleId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const def = styleMap.get(current);
    if (!def) {
      break;
    }
    chain.push(def);
    current = def.basedOn;
  }

  let shading: Shading | undefined;
  // Band sizes may be declared by the table or by any style in its chain; the
  // table's own value wins, then the most derived style that sets one.
  let rowBand = bandSize?.row;
  let colBand = bandSize?.column;
  for (let i = chain.length - 1; i >= 0; i--) {
    rowBand = rowBand ?? chain[i].tableProperties?.rowBandSize;
    colBand = colBand ?? chain[i].tableProperties?.colBandSize;
  }
  // Walk base → specific so a derived style overrides the one it is based on.
  for (let i = chain.length - 1; i >= 0; i--) {
    const def = chain[i];
    if (def.tableProperties?.shading) {
      shading = def.tableProperties.shading;
    }
    if (!def.tableStyleConditions) {
      continue;
    }
    const matching = getMatchingTableConditions(
      def.tableStyleConditions,
      look,
      position.rowIndex,
      position.colIndex,
      position.totalRows,
      position.totalCols,
      { row: rowBand, column: colBand }
    );
    for (const cond of matching) {
      if (cond.cellProperties?.shading) {
        shading = cond.cellProperties.shading;
      }
    }
  }

  return shading ? { shading } : {};
}

/**
 * The background colour of a table cell as a bare 6-digit hex string, or
 * undefined when nothing should be painted.
 *
 * Applies the full OOXML precedence in one place so every renderer agrees:
 *
 *   cell `w:tcPr/w:shd`  →  table `w:tblPr/w:shd`  →  table style
 *
 * `fill: "auto"` means "let the consumer decide", which for a cell background is
 * no fill; `pattern: "nil"` is an explicit absence of shading. The striped and
 * percentage patterns are approximated by their fill colour, which is what they
 * amount to at document scale.
 */
export function resolveTableCellFill(
  doc: DocxDocument,
  table: Table,
  cell: TableCell,
  position: TableCellPosition
): string | undefined {
  // Direct formatting wins even when it paints nothing: `w:shd w:val="clear"
  // w:fill="auto"` is exactly how Word records "this cell has no shading",
  // which has to override whatever the table style would have contributed.
  // Treating that as "unspecified" and falling through would make it impossible
  // to clear a styled header band.
  if (cell.properties?.shading) {
    return resolveShadingFill(cell.properties.shading);
  }
  if (table.properties?.shading) {
    return resolveShadingFill(table.properties.shading);
  }
  const fromStyle = resolveTableCellStyle(
    doc,
    table.properties?.style,
    table.properties?.look,
    position,
    { row: table.properties?.rowBandSize, column: table.properties?.colBandSize }
  ).shading;
  return resolveShadingFill(fromStyle);
}

/** A `RRGGBB` hex string normalised from `w:fill` / `w:color`, or undefined. */
function normalizeHex(raw: string | undefined): string | undefined {
  if (!raw || raw === "auto") {
    return undefined;
  }
  const stripped = raw.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(stripped)) {
    return stripped.toUpperCase();
  }
  if (/^[0-9a-fA-F]{3}$/.test(stripped)) {
    return stripped
      .split("")
      .map(ch => ch + ch)
      .join("")
      .toUpperCase();
  }
  return undefined;
}

/**
 * How much of a shading pattern's area its pattern colour covers, 0–1.
 *
 * A `w:shd` is a two-colour pattern: `w:fill` behind, `w:color` in the pattern
 * itself. `pct25` is literally 25 % coverage, and the named hatches are close to
 * fixed ratios. Flattening each to its coverage-weighted blend reproduces the
 * tone the pattern reads as at document scale, which is what a reader sees —
 * far closer than dropping the pattern colour entirely and painting bare `fill`.
 *
 * Returns 0 for a pattern that shows only the fill, and 1 for one that hides it.
 */
function patternCoverage(pattern: string | undefined): number {
  if (!pattern || pattern === "clear") {
    return 0;
  }
  if (pattern === "solid") {
    return 1;
  }
  const pct = /^pct(\d+)$/.exec(pattern);
  if (pct) {
    return Math.min(100, Math.max(0, Number.parseInt(pct[1], 10))) / 100;
  }
  // Hatches: the `thin*` variants use a 1px stroke, the rest a heavier one.
  if (pattern.startsWith("thin")) {
    return pattern.includes("Cross") ? 0.25 : 0.15;
  }
  if (pattern.endsWith("Cross")) {
    return 0.5;
  }
  if (pattern.endsWith("Stripe")) {
    return 0.3;
  }
  return 0;
}

/** Blend `over` onto `under` at `ratio`, both `RRGGBB`. */
function blendHex(under: string, over: string, ratio: number): string {
  let out = "";
  for (let i = 0; i < 6; i += 2) {
    const a = Number.parseInt(under.slice(i, i + 2), 16);
    const b = Number.parseInt(over.slice(i, i + 2), 16);
    out += Math.round(a + (b - a) * ratio)
      .toString(16)
      .toUpperCase()
      .padStart(2, "0");
  }
  return out;
}

/**
 * A shading's paintable fill as a bare `RRGGBB` hex string, or undefined when it
 * paints nothing.
 *
 * `fill: "auto"` means "let the consumer decide", which for a background is no
 * fill; `pattern: "nil"` is an explicit absence of shading. A pattern blends its
 * `w:color` into the fill by its coverage (see `patternCoverage`). Exported so
 * table cells and paragraphs cannot disagree about what a given `w:shd` paints.
 */
export function resolveShadingFill(shading: Shading | undefined): string | undefined {
  if (!shading || shading.pattern === "nil") {
    return undefined;
  }
  const fill = normalizeHex(shading.fill);
  const patternColor = normalizeHex(shading.color);
  const coverage = patternCoverage(shading.pattern);

  if (patternColor === undefined || coverage === 0) {
    return fill;
  }
  if (fill === undefined) {
    // No fill behind the pattern: the pattern colour is all there is to paint,
    // and only in proportion to how much of the area it covers. Blend onto
    // white, the page it sits on.
    return coverage >= 1 ? patternColor : blendHex("FFFFFF", patternColor, coverage);
  }
  return coverage >= 1 ? patternColor : blendHex(fill, patternColor, coverage);
}

// =============================================================================
// Extended Style Resolution APIs
// =============================================================================

/** Resolved run style with full inheritance chain. */
export interface ResolvedRunStyle {
  /** Style chain (most specific → base). */
  readonly chain: readonly string[];
  /** Merged run properties. */
  readonly runProperties: RunProperties;
}

/**
 * Resolve the effective style for a single Run by walking the character
 * style inheritance chain.
 *
 * Resolution order (low → high specificity):
 * 1. Document defaults
 * 2. Paragraph's resolved style (if `paragraphRunProperties` provided)
 * 3. Run's character style chain (if `run.properties.style` is set)
 * 4. Run's own direct properties
 *
 * @param doc - The document containing styles.
 * @param run - The run to resolve.
 * @param paragraphRunProperties - Optional inherited run properties from the
 *   parent paragraph's resolved style. Pass `resolveStyle(doc, para).runProperties`
 *   to layer the paragraph style on top of doc defaults.
 * @returns The fully resolved run style.
 */
export function resolveRunStyle(
  doc: DocxDocument,
  run: Run,
  paragraphRunProperties?: RunProperties
): ResolvedRunStyle {
  const styleMap = new Map<string, StyleDef>();
  if (doc.styles) {
    for (const s of doc.styles) {
      styleMap.set(s.styleId, s);
    }
  }

  // Build chain from run's character style
  const chain: string[] = [];
  const runStyleId = run.properties?.style;
  if (runStyleId) {
    let current: string | undefined = runStyleId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      chain.push(current);
      const def = styleMap.get(current);
      current = def?.basedOn;
    }
  }

  let merged: Record<string, unknown> = {};

  // 1. Document defaults
  if (doc.docDefaults?.runProperties) {
    merged = mergeProperties({}, doc.docDefaults.runProperties);
  }

  // 2. Inherited from paragraph's resolved style
  if (paragraphRunProperties) {
    merged = mergeProperties(merged, paragraphRunProperties);
  }

  // 3. Run's character style chain (base → specific)
  for (let i = chain.length - 1; i >= 0; i--) {
    const def = styleMap.get(chain[i]);
    if (def?.runProperties) {
      merged = mergeProperties(merged, def.runProperties);
    }
  }

  // 4. Run's own direct properties (highest priority)
  if (run.properties) {
    const { style: _s, ...own } = run.properties;
    merged = mergeProperties(merged, own);
  }

  return {
    chain,
    runProperties: merged as RunProperties
  };
}

/** Resolved numbering level information. */
export interface ResolvedNumberingLevel {
  /** The level index (0-8). */
  readonly level: number;
  /** Number format. */
  readonly format?: string;
  /** Level text template (e.g. `"%1."`). */
  readonly text?: string;
  /** Justification. */
  readonly justification?: string;
  /** Run properties for the numbering text itself (bullet/number marker). */
  readonly runProperties?: RunProperties;
  /** Paragraph properties from the level (indent, alignment, etc.). */
  readonly paragraphProperties?: ParagraphProperties;
}

/**
 * Resolve the numbering level for a paragraph that has a numbering reference.
 *
 * Walks: paragraph.numbering → numberingInstances → abstractNumberings → level definition.
 * Also applies `LevelOverride` if present.
 *
 * @param doc - The document.
 * @param para - The paragraph (must have `numbering` set).
 * @returns The resolved level, or undefined if no numbering or level not found.
 */
export function resolveNumberingLevel(
  doc: DocxDocument,
  para: Paragraph
): ResolvedNumberingLevel | undefined {
  const numRef = para.properties?.numbering;
  if (!numRef) {
    return undefined;
  }

  // Find numbering instance
  const instance = doc.numberingInstances?.find(n => n.numId === numRef.numId);
  if (!instance) {
    return undefined;
  }

  // Check for level override first
  const override = instance.overrides?.find(o => o.level === numRef.level);
  let levelDef: NumberingLevel | undefined;
  if (override?.levelDef) {
    levelDef = override.levelDef;
  } else {
    // Walk to abstract numbering
    const absNum = doc.abstractNumberings?.find(a => a.abstractNumId === instance.abstractNumId);
    levelDef = absNum?.levels.find(l => l.level === numRef.level);
  }

  if (!levelDef) {
    return undefined;
  }

  return {
    level: levelDef.level,
    format: levelDef.format,
    text: levelDef.text,
    justification: levelDef.justification,
    runProperties: levelDef.runProperties,
    paragraphProperties: levelDef.paragraphProperties
  };
}

/**
 * Resolve table-level styles for a given table.
 *
 * Walks the table style inheritance chain (basedOn) to merge table properties.
 *
 * @param doc - The document.
 * @param tableStyleId - The starting table style ID.
 * @returns The merged table-level style chain.
 */
export function resolveTableStyle(
  doc: DocxDocument,
  tableStyleId: string
): {
  chain: string[];
  paragraphProperties: ParagraphProperties;
  runProperties: RunProperties;
  tableProperties?: TableProperties;
} {
  const styleMap = new Map<string, StyleDef>();
  if (doc.styles) {
    for (const s of doc.styles) {
      styleMap.set(s.styleId, s);
    }
  }

  const chain: string[] = [];
  let current: string | undefined = tableStyleId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    const def = styleMap.get(current);
    current = def?.basedOn;
  }

  let pProps: Record<string, unknown> = {};
  let rProps: Record<string, unknown> = {};
  let tProps: Record<string, unknown> = {};

  // Apply doc defaults first
  if (doc.docDefaults?.paragraphProperties) {
    pProps = mergeProperties({}, doc.docDefaults.paragraphProperties);
  }
  if (doc.docDefaults?.runProperties) {
    rProps = mergeProperties({}, doc.docDefaults.runProperties);
  }

  // Apply chain (base → specific)
  for (let i = chain.length - 1; i >= 0; i--) {
    const def = styleMap.get(chain[i]);
    if (!def) {
      continue;
    }
    if (def.paragraphProperties) {
      pProps = mergeProperties(pProps, def.paragraphProperties);
    }
    if (def.runProperties) {
      rProps = mergeProperties(rProps, def.runProperties);
    }
    if (def.tableProperties) {
      tProps = mergeProperties(tProps, def.tableProperties);
    }
  }

  return {
    chain,
    paragraphProperties: pProps as ParagraphProperties,
    runProperties: rProps as RunProperties,
    tableProperties: Object.keys(tProps).length > 0 ? (tProps as TableProperties) : undefined
  };
}
