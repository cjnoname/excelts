/**
 * Lightweight TrueType glyph rasterizer for chart PNG text rendering.
 *
 * Parses the minimal set of TTF tables (cmap, hmtx, loca, glyf, head, hhea,
 * maxp) needed to extract glyph outlines, then rasterizes them via scan-line
 * fill. No dependencies outside this module except `@utils/fs`.
 *
 * Supports:
 * - Simple glyphs (positive numberOfContours)
 * - Composite glyphs (negative numberOfContours, recursive component assembly)
 * - Quadratic B-spline outlines (on-curve / off-curve points, implicit
 *   on-curve midpoints between consecutive off-curve points)
 *
 * Does NOT support: hinting, kerning, OpenType features, vertical layout.
 * This is intentional — the goal is readable chart labels, not DTP.
 */

// =============================================================================
// Types
// =============================================================================

interface GlyphPoint {
  x: number;
  y: number;
  onCurve: boolean;
}

interface GlyphOutline {
  contours: GlyphPoint[][];
  advanceWidth: number;
}

export interface RasterFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  getOutline(codePoint: number): GlyphOutline | undefined;
}

// =============================================================================
// TTF binary reader helpers
// =============================================================================

function u16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function i16(data: Uint8Array, offset: number): number {
  const v = (data[offset] << 8) | data[offset + 1];
  return v >= 0x8000 ? v - 0x10000 : v;
}

function u32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

function tag(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

// =============================================================================
// TTF Parser (minimal)
// =============================================================================

interface TableEntry {
  offset: number;
  length: number;
}

function parseTableDirectory(data: Uint8Array): Map<string, TableEntry> {
  const numTables = u16(data, 4);
  const tables = new Map<string, TableEntry>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const t = tag(data, rec);
    tables.set(t, { offset: u32(data, rec + 8), length: u32(data, rec + 12) });
  }
  return tables;
}

function parseCmap(data: Uint8Array, table: TableEntry): Map<number, number> {
  const base = table.offset;
  const numSubtables = u16(data, base + 2);

  let format4Offset = -1;
  let format12Offset = -1;

  for (let i = 0; i < numSubtables; i++) {
    const rec = base + 4 + i * 8;
    const platformID = u16(data, rec);
    const encodingID = u16(data, rec + 2);
    const subtableOffset = base + u32(data, rec + 4);

    // The Unicode platform (0, any encoding) or Windows Unicode — BMP (3,1) and
    // full repertoire (3,10).
    //
    // Platform 0 is not a fallback for exotic fonts: macOS ships `STHeiti` and
    // `STFangsong` with a `(0,4)` format 12 subtable and *nothing* on platform 3,
    // so a Windows-only scan built an empty map and every glyph resolved to
    // `undefined`. Chinese text then rasterised as blank — and `Heiti SC` is the
    // first embeddable `zh-Hans` family on a stock macOS install, so that was the
    // default path, not a corner. The PDF parser in `@pdf/font/ttf-parser` has
    // always accepted platform 0, which is why the same font embedded correctly
    // while drawing nothing; the two now agree.
    const isUnicode =
      platformID === 0 || (platformID === 3 && (encodingID === 1 || encodingID === 10));
    if (!isUnicode) {
      continue;
    }

    const format = u16(data, subtableOffset);
    if (format === 12 && format12Offset < 0) {
      format12Offset = subtableOffset;
    } else if (format === 4 && format4Offset < 0) {
      format4Offset = subtableOffset;
    }
  }

  // Format 12 reaches the supplementary planes; format 4 stops at the BMP. Pick
  // one rather than merging both, matching `ttf-parser` so a glyph that embeds in
  // a PDF rasterises from the same mapping.
  const map = new Map<number, number>();
  if (format12Offset >= 0) {
    parseCmapFormat12(data, format12Offset, map);
  } else if (format4Offset >= 0) {
    parseCmapFormat4(data, format4Offset, map);
  }
  return map;
}

function parseCmapFormat4(data: Uint8Array, offset: number, map: Map<number, number>): void {
  const segCount = u16(data, offset + 6) >> 1;
  const endCodesOff = offset + 14;
  const startCodesOff = endCodesOff + segCount * 2 + 2; // +2 for reservedPad
  const idDeltasOff = startCodesOff + segCount * 2;
  const idRangeOffsetsOff = idDeltasOff + segCount * 2;

  for (let i = 0; i < segCount; i++) {
    const endCode = u16(data, endCodesOff + i * 2);
    const startCode = u16(data, startCodesOff + i * 2);
    const idDelta = i16(data, idDeltasOff + i * 2);
    const idRangeOffset = u16(data, idRangeOffsetsOff + i * 2);

    if (startCode === 0xffff) {
      break;
    }

    for (let c = startCode; c <= endCode; c++) {
      let gid: number;
      if (idRangeOffset === 0) {
        gid = (c + idDelta) & 0xffff;
      } else {
        const glyphIndexAddr = idRangeOffsetsOff + i * 2 + idRangeOffset + (c - startCode) * 2;
        gid = u16(data, glyphIndexAddr);
        if (gid !== 0) {
          gid = (gid + idDelta) & 0xffff;
        }
      }
      if (gid !== 0 && !map.has(c)) {
        map.set(c, gid);
      }
    }
  }
}

function parseCmapFormat12(data: Uint8Array, offset: number, map: Map<number, number>): void {
  const numGroups = u32(data, offset + 12);
  let pos = offset + 16;
  for (let i = 0; i < numGroups; i++) {
    const startCharCode = u32(data, pos);
    const endCharCode = u32(data, pos + 4);
    let startGlyphID = u32(data, pos + 8);
    for (let c = startCharCode; c <= endCharCode; c++) {
      if (!map.has(c)) {
        map.set(c, startGlyphID);
      }
      startGlyphID++;
    }
    pos += 12;
  }
}

/**
 * Read the glyph index, clamped into `glyf` and non-decreasing.
 *
 * These offsets are the only thing that turns a glyph ID into a byte range, so a
 * broken index would otherwise walk into neighbouring tables. An offset that
 * breaks either rule collapses onto its predecessor, which reads as an empty
 * glyph.
 */
function parseLoca(
  data: Uint8Array,
  table: TableEntry,
  numGlyphs: number,
  isLong: boolean,
  glyfLength: number
): Uint32Array {
  const offsets = new Uint32Array(numGlyphs + 1);
  const base = table.offset;
  const width = isLong ? 4 : 2;
  const end = base + table.length;

  let last = 0;
  let previous = 0;
  for (let i = 0; i <= numGlyphs; i++) {
    const at = base + i * width;
    if (at + width <= end) {
      last = isLong ? u32(data, at) : u16(data, at) * 2;
    }
    previous = Math.min(Math.max(last, previous), glyfLength);
    offsets[i] = previous;
  }
  return offsets;
}

interface HorizontalMetrics {
  advanceWidths: Uint16Array;
  leftSideBearings: Int16Array;
}

/**
 * Read the advance width and left side bearing of every glyph.
 *
 * After `numHMetrics` long records the advance width is shared and only the
 * bearing is stored, in a trailing int16 array — Courier New keeps 3 records
 * for 3151 glyphs, so for a monospaced font almost every bearing lives there.
 */
function parseHmtx(
  data: Uint8Array,
  table: TableEntry,
  numHMetrics: number,
  numGlyphs: number
): HorizontalMetrics {
  const advanceWidths = new Uint16Array(numGlyphs);
  const leftSideBearings = new Int16Array(numGlyphs);
  const base = table.offset;
  const end = base + table.length;

  const longRecords = Math.min(numHMetrics, numGlyphs);
  let lastWidth = 0;
  let gid = 0;
  for (; gid < longRecords && base + gid * 4 + 4 <= end; gid++) {
    lastWidth = u16(data, base + gid * 4);
    advanceWidths[gid] = lastWidth;
    leftSideBearings[gid] = i16(data, base + gid * 4 + 2);
  }

  const tailStart = base + numHMetrics * 4;
  const tailPresent = gid === numHMetrics && numHMetrics > 0;
  for (; gid < numGlyphs; gid++) {
    advanceWidths[gid] = lastWidth;
    const at = tailStart + (gid - numHMetrics) * 2;
    leftSideBearings[gid] = tailPresent && at + 2 <= end ? i16(data, at) : 0;
  }

  return { advanceWidths, leftSideBearings };
}

// =============================================================================
// Glyph Outline Parsing
// =============================================================================

// TrueType simple glyph flags
const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT_FLAG = 0x08;
const X_SAME_OR_POS = 0x10;
const Y_SAME_OR_POS = 0x20;

function parseSimpleGlyph(data: Uint8Array, offset: number, numContours: number): GlyphPoint[][] {
  let pos = offset + 10; // skip header (numberOfContours, xMin, yMin, xMax, yMax)
  const endPts: number[] = [];
  for (let i = 0; i < numContours; i++) {
    endPts.push(u16(data, pos));
    pos += 2;
  }
  const numPoints = endPts[endPts.length - 1] + 1;

  // Skip instructions
  const instructionLength = u16(data, pos);
  pos += 2 + instructionLength;

  // Read flags
  const flags: number[] = [];
  while (flags.length < numPoints) {
    const f = data[pos++];
    flags.push(f);
    if (f & REPEAT_FLAG) {
      const repeat = data[pos++];
      for (let r = 0; r < repeat; r++) {
        flags.push(f);
      }
    }
  }

  // Read X coordinates
  const xs: number[] = new Array(numPoints);
  let x = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i];
    if (f & X_SHORT) {
      const dx = data[pos++];
      x += f & X_SAME_OR_POS ? dx : -dx;
    } else if (!(f & X_SAME_OR_POS)) {
      x += i16(data, pos);
      pos += 2;
    }
    xs[i] = x;
  }

  // Read Y coordinates
  const ys: number[] = new Array(numPoints);
  let y = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i];
    if (f & Y_SHORT) {
      const dy = data[pos++];
      y += f & Y_SAME_OR_POS ? dy : -dy;
    } else if (!(f & Y_SAME_OR_POS)) {
      y += i16(data, pos);
      pos += 2;
    }
    ys[i] = y;
  }

  // Build contours
  const contours: GlyphPoint[][] = [];
  let start = 0;
  for (let c = 0; c < numContours; c++) {
    const end = endPts[c];
    const contour: GlyphPoint[] = [];
    for (let i = start; i <= end; i++) {
      contour.push({ x: xs[i], y: ys[i], onCurve: !!(flags[i] & ON_CURVE) });
    }
    contours.push(contour);
    start = end + 1;
  }
  return contours;
}

// Composite glyph flags
const COMP_ARG_1_AND_2_ARE_WORDS = 0x0001;
const COMP_ARGS_ARE_XY_VALUES = 0x0002;
const COMP_WE_HAVE_A_SCALE = 0x0008;
const COMP_MORE_COMPONENTS = 0x0020;
const COMP_WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const COMP_WE_HAVE_A_TWO_BY_TWO = 0x0080;
const COMP_USE_MY_METRICS = 0x0200;

/**
 * How deep a composite may nest before it is treated as empty. The spec says to
 * avoid nesting at all and real fonts stay at one or two levels; the limit is
 * what stops a font whose components reference each other in a cycle from
 * recursing forever.
 */
const MAX_COMPOSITE_DEPTH = 5;

/**
 * Find the glyph whose horizontal metrics a composite adopts.
 *
 * `USE_MY_METRICS` forces the composite's advance width and left side bearing to
 * be those of the flagged component — an i-circumflex takes the metrics of the
 * dotless i it is built from. FreeType implements this by keeping that
 * component's phantom points instead of restoring the parent's, and because the
 * points it keeps are saved per component, the last flagged component is the one
 * that survives. Returns the glyph itself when nothing claims the metrics.
 */
function metricsGlyphId(
  data: Uint8Array,
  glyphId: number,
  glyfBase: number,
  glyphOffsets: Uint32Array,
  depth = 0
): number {
  const start = glyphOffsets[glyphId];
  const end = glyphOffsets[glyphId + 1];
  if (depth > MAX_COMPOSITE_DEPTH || end - start < 10) {
    return glyphId;
  }
  const offset = glyfBase + start;
  if (i16(data, offset) >= 0) {
    return glyphId; // simple glyph: it owns its own metrics
  }

  let pos = offset + 10;
  let claimed = glyphId;
  for (;;) {
    const component = readComponentRecord(data, pos);
    pos = component.next;
    if (component.flags & COMP_USE_MY_METRICS) {
      claimed = metricsGlyphId(data, component.glyphId, glyfBase, glyphOffsets, depth + 1);
    }
    if (!(component.flags & COMP_MORE_COMPONENTS)) {
      return claimed;
    }
  }
}

/** One component of a composite glyph, and where the next one starts. */
interface ComponentRecord {
  flags: number;
  glyphId: number;
  dx: number;
  dy: number;
  /** 2x2 transform, as [a, b, c, d]. */
  transform: [number, number, number, number];
  next: number;
}

/**
 * Read one component record. The record's length depends on its own flags, so
 * this is the single place that knows the layout — every walk over a composite
 * goes through it.
 */
function readComponentRecord(data: Uint8Array, pos: number): ComponentRecord {
  const flags = u16(data, pos);
  const glyphId = u16(data, pos + 2);
  let at = pos + 4;

  // Point-matching placement (no XY values) is not supported; it needs the
  // parent's points, which are not available here.
  let dx = 0;
  let dy = 0;
  if (flags & COMP_ARG_1_AND_2_ARE_WORDS) {
    if (flags & COMP_ARGS_ARE_XY_VALUES) {
      dx = i16(data, at);
      dy = i16(data, at + 2);
    }
    at += 4;
  } else {
    if (flags & COMP_ARGS_ARE_XY_VALUES) {
      dx = data[at] >= 0x80 ? data[at] - 256 : data[at];
      dy = data[at + 1] >= 0x80 ? data[at + 1] - 256 : data[at + 1];
    }
    at += 2;
  }

  let transform: [number, number, number, number] = [1, 0, 0, 1];
  if (flags & COMP_WE_HAVE_A_SCALE) {
    const scale = i16(data, at) / 16384;
    transform = [scale, 0, 0, scale];
    at += 2;
  } else if (flags & COMP_WE_HAVE_AN_X_AND_Y_SCALE) {
    transform = [i16(data, at) / 16384, 0, 0, i16(data, at + 2) / 16384];
    at += 4;
  } else if (flags & COMP_WE_HAVE_A_TWO_BY_TWO) {
    transform = [
      i16(data, at) / 16384,
      i16(data, at + 2) / 16384,
      i16(data, at + 4) / 16384,
      i16(data, at + 6) / 16384
    ];
    at += 8;
  }

  return { flags, glyphId, dx, dy, transform, next: at };
}

function parseCompositeGlyph(
  data: Uint8Array,
  offset: number,
  glyfBase: number,
  glyphOffsets: Uint32Array,
  depth: number
): GlyphPoint[][] {
  let pos = offset + 10; // skip header
  const allContours: GlyphPoint[][] = [];

  for (;;) {
    const component = readComponentRecord(data, pos);
    pos = component.next;
    const [a, b, c, d] = component.transform;

    // Recursively get component outlines
    const compContours = getGlyphContours(
      data,
      component.glyphId,
      glyfBase,
      glyphOffsets,
      depth + 1
    );
    for (const contour of compContours) {
      const transformed = contour.map(pt => ({
        x: a * pt.x + c * pt.y + component.dx,
        y: b * pt.x + d * pt.y + component.dy,
        onCurve: pt.onCurve
      }));
      allContours.push(transformed);
    }

    if (!(component.flags & COMP_MORE_COMPONENTS)) {
      break;
    }
  }
  return allContours;
}

function getGlyphContours(
  data: Uint8Array,
  glyphId: number,
  glyfBase: number,
  glyphOffsets: Uint32Array,
  depth = 0
): GlyphPoint[][] {
  const start = glyphOffsets[glyphId];
  const end = glyphOffsets[glyphId + 1];
  if (end - start < 10 || depth > MAX_COMPOSITE_DEPTH) {
    return []; // empty glyph (e.g. space), or a composite that nests too deep
  }

  const offset = glyfBase + start;
  const numberOfContours = i16(data, offset);

  if (numberOfContours >= 0) {
    return parseSimpleGlyph(data, offset, numberOfContours);
  }
  return parseCompositeGlyph(data, offset, glyfBase, glyphOffsets, depth);
}

// =============================================================================
// Contour to line segments (flattening quadratic B-splines)
// =============================================================================

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Flatten a contour (with on-curve and off-curve points) into line segments.
 * TrueType uses quadratic B-splines: between two consecutive off-curve
 * points an implicit on-curve midpoint is inserted.
 */
function flattenContour(contour: GlyphPoint[]): Segment[] {
  if (contour.length < 2) {
    return [];
  }

  const segments: Segment[] = [];
  const n = contour.length;

  // Find first on-curve point (or synthesize one)
  let startIdx = 0;
  let startPt: { x: number; y: number };
  if (contour[0].onCurve) {
    startPt = contour[0];
    startIdx = 1;
  } else if (contour[n - 1].onCurve) {
    startPt = contour[n - 1];
    startIdx = 0;
  } else {
    // Both first and last are off-curve; start at midpoint
    startPt = {
      x: (contour[0].x + contour[n - 1].x) / 2,
      y: (contour[0].y + contour[n - 1].y) / 2
    };
    startIdx = 0;
  }

  let cur = startPt;

  for (let i = startIdx; i < n; i++) {
    const pt = contour[i];
    if (pt.onCurve) {
      segments.push({ x1: cur.x, y1: cur.y, x2: pt.x, y2: pt.y });
      cur = pt;
    } else {
      // Off-curve: find next on-curve (or implicit midpoint)
      let nextOn: { x: number; y: number };
      const nextIdx = (i + 1) % n;
      const next = contour[nextIdx];
      if (next.onCurve) {
        nextOn = next;
        i++; // skip next since we consumed it
        if (nextIdx === 0) {
          // We've wrapped around; use startPt
          nextOn = startPt;
          i = n; // exit loop after this
        }
      } else {
        // Implicit on-curve at midpoint
        nextOn = { x: (pt.x + next.x) / 2, y: (pt.y + next.y) / 2 };
      }
      // Subdivide quadratic bezier: cur, pt(control), nextOn
      subdivideQuadratic(cur.x, cur.y, pt.x, pt.y, nextOn.x, nextOn.y, segments);
      cur = nextOn;
    }
  }

  // Close the contour
  if (cur.x !== startPt.x || cur.y !== startPt.y) {
    segments.push({ x1: cur.x, y1: cur.y, x2: startPt.x, y2: startPt.y });
  }

  return segments;
}

function subdivideQuadratic(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  segments: Segment[]
): void {
  // Adaptive subdivision based on flatness
  const steps = 8; // fixed subdivision — good enough for chart labels
  let prevX = x0;
  let prevY = y0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const nx = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const ny = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    segments.push({ x1: prevX, y1: prevY, x2: nx, y2: ny });
    prevX = nx;
    prevY = ny;
  }
}

// =============================================================================
// =============================================================================
// Public API
// =============================================================================

/**
 * Parse a TTF font file into a RasterFont that can render glyphs to pixels.
 *
 * `collectionIndex` selects a face inside a `.ttc`, matching `parseTtf` in
 * `@pdf/font/ttf-parser`. It is not a detail that can be defaulted away: macOS
 * keeps `Songti SC` at Black in face 0 of `Songti.ttc`, with Bold, Light and
 * Regular after it, so always reading face 0 rasterises a heavier weight than the
 * one that was chosen — and the picture disagrees with the PDF that embeds the
 * same family.
 *
 * An index past the end of the collection falls back to face 0 rather than
 * throwing, because this module degrades instead of failing: its callers draw
 * inside a loop and have nowhere to put an exception.
 */
export function parseRasterFont(data: Uint8Array, collectionIndex = 0): RasterFont {
  const sfVersion = u32(data, 0);
  if (sfVersion === 0x74746366) {
    // 'ttcf' header — a collection, whose face offsets follow the count.
    const numFonts = u32(data, 8);
    const inRange =
      Number.isInteger(collectionIndex) && collectionIndex >= 0 && collectionIndex < numFonts;
    const index = inRange ? collectionIndex : 0;
    // Table offsets inside a collection are absolute, so the whole file is kept
    // and only the directory is read at the face's offset.
    const tables = parseTableDirectoryTTC(data, u32(data, 12 + index * 4));
    return buildRasterFont(data, tables);
  }

  const tables = parseTableDirectory(data);
  return buildRasterFont(data, tables);
}

function parseTableDirectoryTTC(data: Uint8Array, fontOffset: number): Map<string, TableEntry> {
  const numTables = u16(data, fontOffset + 4);
  const tables = new Map<string, TableEntry>();
  for (let i = 0; i < numTables; i++) {
    const rec = fontOffset + 12 + i * 16;
    const t = tag(data, rec);
    tables.set(t, { offset: u32(data, rec + 8), length: u32(data, rec + 12) });
  }
  return tables;
}

function buildRasterFont(data: Uint8Array, tables: Map<string, TableEntry>): RasterFont {
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const maxp = tables.get("maxp");
  const cmapTable = tables.get("cmap");
  const hmtxTable = tables.get("hmtx");
  const locaTable = tables.get("loca");
  const glyfTable = tables.get("glyf");

  if (!head || !hhea || !maxp || !cmapTable || !hmtxTable || !locaTable || !glyfTable) {
    // Return a dummy font if tables are missing
    return { unitsPerEm: 1000, ascent: 800, descent: -200, getOutline: () => undefined };
  }

  const unitsPerEm = u16(data, head.offset + 18);
  const indexToLocFormat = i16(data, head.offset + 50);
  const ascent = i16(data, hhea.offset + 4);
  const descent = i16(data, hhea.offset + 6);
  const numHMetrics = u16(data, hhea.offset + 34);
  const numGlyphs = u16(data, maxp.offset + 4);

  const cmap = parseCmap(data, cmapTable);
  const { advanceWidths, leftSideBearings } = parseHmtx(data, hmtxTable, numHMetrics, numGlyphs);
  const glyphOffsets = parseLoca(
    data,
    locaTable,
    numGlyphs,
    indexToLocFormat !== 0,
    glyfTable.length
  );
  const glyfBase = glyfTable.offset;

  function buildOutline(codePoint: number): GlyphOutline | undefined {
    const gid = cmap.get(codePoint);
    if (gid === undefined || gid === 0) {
      return undefined;
    }
    // The glyph a composite borrows its metrics from, which is the glyph
    // itself unless a component claims them with USE_MY_METRICS.
    const metricsGid = metricsGlyphId(data, gid, glyfBase, glyphOffsets);
    const advanceWidth = advanceWidths[metricsGid];

    const contours = getGlyphContours(data, gid, glyfBase, glyphOffsets);
    if (contours.length === 0) {
      // No ink, but a real advance: a space has to move the pen by what the
      // font says, not by a guess.
      return { contours, advanceWidth };
    }
    // Outline coordinates start at the glyph's own `xMin`, but the ink belongs
    // at `pen + lsb`: a rasterizer translates the outline by `lsb - xMin`
    // (FreeType does it unconditionally, so every mainstream renderer agrees).
    // The two values match in a well-formed font and the shift is nothing, yet
    // ~0.4% of glyphs in shipped fonts disagree — by up to 0.35 em in Times
    // New Roman Italic — and those have to land where a PDF viewer would put
    // them, or a chart label drifts away from the text beside it.
    const shift = leftSideBearings[metricsGid] - i16(data, glyfBase + glyphOffsets[metricsGid] + 2);
    return {
      contours:
        shift === 0
          ? contours
          : contours.map(contour => contour.map(pt => ({ ...pt, x: pt.x + shift }))),
      advanceWidth
    };
  }

  // One outline object per code point, so callers that rasterize the same glyph
  // twice — measuring a label and then drawing it — get the same object and can
  // key a cache on it.
  const outlines = new Map<number, GlyphOutline | undefined>();

  return {
    unitsPerEm,
    ascent,
    descent,
    getOutline(codePoint: number): GlyphOutline | undefined {
      if (!outlines.has(codePoint)) {
        outlines.set(codePoint, buildOutline(codePoint));
      }
      return outlines.get(codePoint);
    }
  };
}

/**
 * Rasterize a single glyph into an alpha bitmap with 4x supersampled
 * anti-aliasing for smooth edges.
 *
 * @param outline - Glyph outline from RasterFont.getOutline()
 * @param fontSize - Target font size in pixels
 * @param unitsPerEm - Font's unitsPerEm
 * @returns { width, height, offsetX, offsetY, pixels }
 *   offsetX/offsetY are pixel offsets from the pen position (left of baseline)
 *   to the top-left of the bitmap.  pixels values are 0–255 (coverage).
 */
export function rasterizeGlyph(
  outline: GlyphOutline,
  fontSize: number,
  unitsPerEm: number
): { width: number; height: number; offsetX: number; offsetY: number; pixels: Uint8Array } {
  const scale = fontSize / unitsPerEm;

  // Supersample factor — render at Nx resolution then downsample
  const SS = 4;
  const ssScale = scale * SS;

  // Scale all contour points to hi-res pixel space, flipping Y
  const scaledContours: GlyphPoint[][] = outline.contours.map(contour =>
    contour.map(pt => ({
      x: pt.x * ssScale,
      y: -pt.y * ssScale,
      onCurve: pt.onCurve
    }))
  );

  // Find bounding box in hi-res pixel space
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of scaledContours) {
    for (const pt of contour) {
      if (pt.x < minX) {
        minX = pt.x;
      }
      if (pt.x > maxX) {
        maxX = pt.x;
      }
      if (pt.y < minY) {
        minY = pt.y;
      }
      if (pt.y > maxY) {
        maxY = pt.y;
      }
    }
  }

  if (!Number.isFinite(minX)) {
    return {
      width: Math.ceil(outline.advanceWidth * scale),
      height: Math.ceil(fontSize),
      offsetX: 0,
      offsetY: 0,
      pixels: new Uint8Array(0)
    };
  }

  // Output bitmap dimensions (in final 1x pixels)
  const pad = 1;
  const bmpW = Math.ceil((maxX - minX) / SS) + pad * 2;
  const bmpH = Math.ceil((maxY - minY) / SS) + pad * 2;

  if (bmpW <= 0 || bmpH <= 0) {
    return {
      width: Math.ceil(outline.advanceWidth * scale),
      height: Math.ceil(fontSize),
      offsetX: 0,
      offsetY: 0,
      pixels: new Uint8Array(0)
    };
  }

  // Hi-res bitmap dimensions
  const hiW = bmpW * SS;
  const hiH = bmpH * SS;

  // Translate contours so that minX,minY maps to (pad*SS, pad*SS) in hi-res space
  const txOff = -minX + pad * SS;
  const tyOff = -minY + pad * SS;

  // Flatten contours into line segments (in hi-res pixel coordinates)
  const allSegments: Segment[] = [];
  for (const contour of scaledContours) {
    const translated = contour.map(pt => ({
      x: pt.x + txOff,
      y: pt.y + tyOff,
      onCurve: pt.onCurve
    }));
    allSegments.push(...flattenContour(translated));
  }

  // Scan-line fill at hi-res
  const hiBuf = new Uint8Array(hiW * hiH);
  for (let row = 0; row < hiH; row++) {
    const scanY = row + 0.5;

    const intersections: number[] = [];
    for (const seg of allSegments) {
      const y1 = seg.y1;
      const y2 = seg.y2;
      if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
        const t = (scanY - y1) / (y2 - y1);
        intersections.push(seg.x1 + t * (seg.x2 - seg.x1));
      }
    }

    intersections.sort((a, b) => a - b);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.ceil(intersections[i]));
      const xEnd = Math.min(hiW - 1, Math.floor(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        hiBuf[row * hiW + x] = 1;
      }
    }
  }

  // Downsample: average SS×SS blocks → 0–255 coverage
  const pixels = new Uint8Array(bmpW * bmpH);
  const ss2 = SS * SS;
  for (let py = 0; py < bmpH; py++) {
    for (let px = 0; px < bmpW; px++) {
      let count = 0;
      const hiBaseY = py * SS;
      const hiBaseX = px * SS;
      for (let sy = 0; sy < SS; sy++) {
        const hiRow = hiBaseY + sy;
        if (hiRow >= hiH) {
          break;
        }
        for (let sx = 0; sx < SS; sx++) {
          const hiCol = hiBaseX + sx;
          if (hiCol >= hiW) {
            break;
          }
          count += hiBuf[hiRow * hiW + hiCol];
        }
      }
      if (count > 0) {
        pixels[py * bmpW + px] = Math.round((count / ss2) * 255);
      }
    }
  }

  return {
    width: bmpW,
    height: bmpH,
    offsetX: Math.floor(minX / SS) - pad,
    offsetY: Math.floor(minY / SS) - pad,
    pixels
  };
}
