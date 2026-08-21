/**
 * Lexical helpers for the SVG subsets this library both emits and re-reads.
 *
 * Three consumers used to carry their own copies of this code:
 *
 * - the Excel chart Node PNG fallback, which re-parses the SVG it just emitted
 *   (`@excel/chart/render/chart-renderer`);
 * - `PdfPageBuilder.drawSvg`, which imports a small SVG subset into a PDF page;
 * - and, for colours, several OOXML paths.
 *
 * The attribute parser was a byte-for-byte duplicate, the point tokeniser was a
 * near-duplicate, and the colour parsers had *opposite* readings of an 8-digit
 * hex: the Excel one followed CSS (`#RRGGBBAA`) while the PDF one delegated to
 * the OOXML helper (`#AARRGGBB`), so `#FF000080` rasterised as translucent red
 * but landed in a PDF as opaque dark blue.
 *
 * This module owns the SVG/CSS reading of those tokens. It deliberately does
 * *not* try to be an SVG engine: no DOM, no inheritance, no CSS cascade — just
 * the token-level parsing that every consumer needs to agree on.
 *
 * Note for OOXML callers: `<a:srgbClr val="…">` is *not* CSS. Its 8-digit form
 * is `AARRGGBB`. Keep using `hexToRgb01` from `./theme-colors` for that; do not
 * reach for {@link parseCssColor} because the byte order differs.
 */

/** An RGBA colour with every channel normalised to 0..1. */
export interface Rgba01 {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 1 when the source specified no alpha. */
  readonly a: number;
}

/** A point in SVG user units. */
export interface SvgPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Parse the attributes out of a start-tag body.
 *
 * Accepts both `"` and `'` quoting and whitespace around `=`, which plain XML
 * permits and which the previous hand-rolled copies silently dropped — a
 * legitimate `<rect fill = 'red'/>` produced no attributes at all. Written as a
 * manual scan rather than a regex so uncontrolled input cannot backtrack.
 *
 * @param raw - Either a whole start tag (`<rect x="1"/>`) or just its attribute
 *   section. Leading `<name` is skipped naturally because a bare name without
 *   `=` is discarded.
 */
export function parseSvgAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const len = raw.length;
  let i = 0;
  while (i < len) {
    while (i < len && !isSvgNameChar(raw.charCodeAt(i))) {
      i++;
    }
    if (i >= len) {
      break;
    }
    const nameStart = i;
    while (i < len && isSvgNameChar(raw.charCodeAt(i))) {
      i++;
    }
    const name = raw.slice(nameStart, i);
    // Optional whitespace, then `=`.
    let cursor = i;
    while (cursor < len && isSvgSpace(raw.charCodeAt(cursor))) {
      cursor++;
    }
    if (cursor >= len || raw.charCodeAt(cursor) !== 0x3d /* = */) {
      // A valueless name (e.g. the tag name itself, or `/`): keep scanning from
      // just past the name so we do not re-read it forever.
      continue;
    }
    cursor++;
    while (cursor < len && isSvgSpace(raw.charCodeAt(cursor))) {
      cursor++;
    }
    const quote = raw.charCodeAt(cursor);
    if (quote !== 0x22 /* " */ && quote !== 0x27 /* ' */) {
      i = cursor;
      continue;
    }
    cursor++;
    const valueStart = cursor;
    while (cursor < len && raw.charCodeAt(cursor) !== quote) {
      cursor++;
    }
    attrs[name] = raw.slice(valueStart, cursor);
    i = cursor < len ? cursor + 1 : cursor;
  }
  return attrs;
}

/** Whether a char code may appear in an SVG/XML attribute name. */
function isSvgNameChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f || // _
    code === 0x3a || // :
    code === 0x2d // -
  );
}

/** XML whitespace. */
function isSvgSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Tokenise a whitespace/comma separated number list, dropping anything that is
 * not finite. Exponent forms (`1e3`) survive because `Number` accepts them.
 */
export function parseSvgNumberList(value: string | undefined): number[] {
  if (!value) {
    return [];
  }
  const out: number[] = [];
  for (const token of value.trim().split(/[\s,]+/)) {
    if (token === "") {
      continue;
    }
    const num = Number(token);
    if (Number.isFinite(num)) {
      out.push(num);
    }
  }
  return out;
}

/**
 * Read a `points="x,y x,y …"` list. A trailing odd value is discarded, matching
 * the SVG error-handling rule that an incomplete coordinate pair is dropped.
 */
export function parseSvgPointPairs(value: string | undefined): SvgPoint[] {
  const nums = parseSvgNumberList(value);
  const points: SvgPoint[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    points.push({ x: nums[i], y: nums[i + 1] });
  }
  return points;
}

/**
 * Parse a colour the way CSS and SVG define it.
 *
 * Supported: `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb(…)`, `rgba(…)` with
 * 0..255 or percentage channels, plus the `none` / `transparent` keywords which
 * return `undefined` so callers can distinguish "no paint" from "black".
 *
 * The 4- and 8-digit hex forms put alpha **last**, per CSS Color 4. This is the
 * opposite of OOXML's `AARRGGBB`; see the module note.
 */
export function parseCssColor(value: string | undefined): Rgba01 | undefined {
  if (!value) {
    return undefined;
  }
  const text = value.trim();
  if (text === "" || text === "none" || text === "transparent") {
    return undefined;
  }

  const fn = /^rgba?\(([^)]*)\)$/i.exec(text);
  if (fn) {
    return parseRgbFunction(fn[1]);
  }

  const hex = text.startsWith("#") ? text.slice(1) : text;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return undefined;
  }
  const nib = (index: number): number => Number.parseInt(hex[index] + hex[index], 16) / 255;
  const pair = (index: number): number => Number.parseInt(hex.slice(index, index + 2), 16) / 255;
  switch (hex.length) {
    case 3:
      return { r: nib(0), g: nib(1), b: nib(2), a: 1 };
    case 4:
      return { r: nib(0), g: nib(1), b: nib(2), a: nib(3) };
    case 6:
      return { r: pair(0), g: pair(2), b: pair(4), a: 1 };
    case 8:
      return { r: pair(0), g: pair(2), b: pair(4), a: pair(6) };
    default:
      return undefined;
  }
}

/** Parse the argument list of `rgb()` / `rgba()`. */
function parseRgbFunction(args: string): Rgba01 | undefined {
  const tokens = args
    .trim()
    .split(/[\s,/]+/)
    .filter(token => token !== "");
  // Exactly three or four components. Accepting extras silently let
  // `rgb(1,2,3,4,5)` through as a colour, where a browser rejects it.
  if (tokens.length < 3 || tokens.length > 4) {
    return undefined;
  }
  const channel = (token: string): number | undefined => {
    const num = Number.parseFloat(token);
    if (!Number.isFinite(num)) {
      return undefined;
    }
    // A percentage is 0..100 of full intensity; a bare number is 0..255.
    return clamp01(token.endsWith("%") ? num / 100 : num / 255);
  };
  const r = channel(tokens[0]);
  const g = channel(tokens[1]);
  const b = channel(tokens[2]);
  if (r === undefined || g === undefined || b === undefined) {
    return undefined;
  }
  let a = 1;
  if (tokens.length === 4) {
    const raw = Number.parseFloat(tokens[3]);
    if (!Number.isFinite(raw)) {
      // An unreadable alpha invalidates the whole colour rather than quietly
      // becoming opaque — `rgba(255,0,0,junk)` is not red.
      return undefined;
    }
    // Alpha is 0..1 by spec, or a percentage.
    a = clamp01(tokens[3].endsWith("%") ? raw / 100 : raw);
  }
  return { r, g, b, a };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Parse the `rotate(angle [cx cy])` form of a `transform` attribute.
 *
 * Only this one form is recognised: it is what the chart emitters produce for
 * rotated axis titles and labels, and guessing at a general transform list
 * would let unsupported input render in the wrong place silently.
 */
export function parseSvgRotate(
  transform: string | undefined
): { angle: number; cx: number; cy: number } | undefined {
  if (!transform) {
    return undefined;
  }
  const match = /rotate\(([^)]*)\)/i.exec(transform);
  if (!match) {
    return undefined;
  }
  const nums = parseSvgNumberList(match[1]);
  if (nums.length === 0) {
    return undefined;
  }
  return { angle: nums[0], cx: nums[1] ?? 0, cy: nums[2] ?? 0 };
}

/** One baseline run inside an SVG `<text>` element. */
export interface SvgTextRun {
  /** Text content with XML entities already decoded. */
  readonly text: string;
  /** Absolute `x` when the run overrode it, in user units. */
  readonly x?: number;
  /**
   * Cumulative baseline offset from the `<text>` origin, in **user units**.
   *
   * Resolved at parse time because `dy` may carry a unit: `em` (and `%`) scale
   * with the font size while a bare number or `px` is already in user units.
   * Reporting a raw number and calling it `em` meant `dy="12"` displaced the
   * line by twelve *ems*.
   */
  readonly dy: number;
}

/**
 * Split the inner markup of an SVG `<text>` element into baseline runs.
 *
 * The chart emitters write one `<tspan>` per paragraph with `dy="1.2em"` on
 * every run after the first, so both the raster fallback and the PDF importer
 * have to walk those children. Without this the tags either survive into the
 * drawn string or get stripped and the paragraphs run together
 * ("QuarterlyRevenue").
 *
 * `dy` is only honoured in `em`, which is the unit the emitters use; a `dy` in
 * user units would need the caller's font metrics to convert and is treated as
 * `em` rather than guessed at.
 *
 * Text with no `<tspan>` — the common case — yields a single run.
 */
export function parseSvgTextRuns(inner: string, fontSize = 0): SvgTextRun[] {
  if (!inner.includes("<tspan")) {
    return [{ text: stripSvgMarkup(inner), dy: 0 }];
  }
  const runs: SvgTextRun[] = [];
  const tspanRe = /<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g;
  let match: RegExpExecArray | null;
  let dy = 0;
  let cursor = 0;
  const pushLiteral = (raw: string): void => {
    // Text sitting between (or before/after) the tspans is still part of the
    // element and used to be dropped entirely, so `Head<tspan>A</tspan>Tail`
    // rendered as just "A".
    const text = stripSvgMarkup(raw);
    if (text.trim() !== "") {
      runs.push({ text, dy });
    }
  };
  while ((match = tspanRe.exec(inner)) !== null) {
    pushLiteral(inner.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const attrs = parseSvgAttributes(match[1]);
    // `dy` accumulates: each value is relative to the previous baseline.
    dy += resolveSvgLength(attrs.dy, fontSize);
    const x = attrs.x === undefined ? Number.NaN : Number.parseFloat(attrs.x);
    runs.push({
      text: stripSvgMarkup(match[2]),
      ...(Number.isFinite(x) ? { x } : {}),
      dy
    });
  }
  pushLiteral(inner.slice(cursor));
  return runs.length > 0 ? runs : [{ text: stripSvgMarkup(inner), dy: 0 }];
}

/**
 * Resolve an SVG length to user units.
 *
 * `em` and `%` are relative to the supplied font size; a bare number, `px` and
 * `pt` are treated as user units (the chart emitters only ever produce `em`, and
 * a viewport-relative unit would need the viewport rather than the font size).
 */
function resolveSvgLength(raw: string | undefined, fontSize: number): number {
  if (raw === undefined) {
    return 0;
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return 0;
  }
  const trimmed = raw.trim();
  if (trimmed.endsWith("em")) {
    return value * fontSize;
  }
  if (trimmed.endsWith("%")) {
    return (value / 100) * fontSize;
  }
  return value;
}

/**
 * Remove markup and decode XML entities from text content.
 *
 * Single O(n) pass so nested or unterminated tags cannot cause the polynomial
 * blow-up that repeated regex replacement would.
 */
export function stripSvgMarkup(value: string): string {
  let stripped = "";
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x3c /* < */) {
      depth++;
    } else if (code === 0x3e /* > */) {
      if (depth > 0) {
        depth--;
      } else {
        stripped += ">";
      }
    } else if (depth === 0) {
      stripped += value[i];
    }
  }
  return decodeXmlEntities(stripped);
}

/** Decode the five predefined XML entities plus numeric character references. */
function decodeXmlEntities(value: string): string {
  if (!value.includes("&")) {
    return value;
  }
  return value.replace(
    /&(?:([A-Za-z]+)|#x([0-9A-Fa-f]+)|#(\d+));/g,
    (match, name?: string, hex?: string, dec?: string) => {
      if (name !== undefined) {
        switch (name) {
          case "amp":
            return "&";
          case "lt":
            return "<";
          case "gt":
            return ">";
          case "quot":
            return '"';
          case "apos":
            return "'";
          default:
            return match;
        }
      }
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec!, 10);
      // Surrogates are not valid standalone characters; decoding `&#xD800;`
      // would splice a lone surrogate into the output, which is ill-formed in
      // both XML and any text a PDF or PNG consumer will accept. Leave the
      // reference as written instead.
      const isSurrogate = code >= 0xd800 && code <= 0xdfff;
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !isSurrogate
        ? String.fromCodePoint(code)
        : match;
    }
  );
}
