/**
 * Shared helpers for the chart preview renderers.
 *
 * Both `chart-renderer.ts` (classic `c:chart`) and
 * `chart-ex-renderer.ts` (ChartEx `cx:chart`) used to carry their own
 * copies of the same handful of math / colour / formatting helpers. The
 * duplicates had drifted over time — subtle differences in NaN guards,
 * hex normalisation, theme palettes, etc. — so a fix in one file
 * silently left the other buggy. This module is the single authoritative
 * home for the helpers shared between the two renderers (plus a few
 * internals — `escapeXml`, `escapeXmlAttr` — that had identical copies
 * scattered across the chart pipeline).
 *
 * Design constraints:
 *
 *   - **Zero dependencies on chart-renderer / chart-ex-renderer** so
 *     this module sits below them in the import graph and does not
 *     create cycles. Types-only imports from `@excel/chart/model/types` are fine.
 *   - **Behaviour-preserving** compared with the consolidated
 *     implementations. The old files had two classes of helper:
 *     (1) strictly identical duplicates and (2) near-duplicates where
 *     one version was more defensive than the other. For the latter we
 *     kept the defensive variant — graceful degradation on malformed
 *     input is always the safer choice for a preview path.
 *   - **Structural rect typing**. The renderers use two different
 *     concrete rect types (`ChartSceneRect` in chart-renderer,
 *     `SvgRect` in chart-ex-renderer) that share the same shape.
 *     Helpers here take structural `{ x: number; y: number; width:
 *     number; height: number }` so both renderers can call them
 *     directly without adapters.
 */

import { measureText } from "@draw/text";
import type { ChartColor, ChartFill, ChartLine } from "@excel/chart/model/types";
import { CHART_THEME_PALETTE, DEFAULT_OFFICE_THEME } from "@utils/theme-colors";
import { emuToPt } from "@utils/units";
import { stripXmlIllegalChars as sharedStripXmlIllegalChars } from "@xml/encode";

// ============================================================================
// Types
// ============================================================================

/**
 * RGB(A) colour triple used by the chart PDF bridge. `a` is optional and
 * defaults to 1 (fully opaque); surfaces that implement transparency
 * (e.g. `@pdf/builder` `PdfPageBuilder`) materialise `a < 1` as an
 * `/ExtGState` resource and emit the corresponding `gs` operator. Older
 * surfaces that ignore `a` render as opaque, which matches the
 * pre-alpha behaviour exactly.
 *
 * Lives in `chart-utils.ts` so both renderers can produce values
 * independently; `chart-renderer.ts` re-exports the type to keep the
 * public surface (`@excel/chart` index / external consumers) stable.
 */
export interface PdfColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/**
 * Structural rect type for helper functions. Both `ChartSceneRect`
 * (chart-renderer.ts) and the ChartEx renderer's private `SvgRect`
 * are assignable to this.
 */
export interface ChartRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ============================================================================
// Shared render constants
// ============================================================================

/** Default SVG / PNG / PDF canvas width when the caller omits `options.width`. */
export const DEFAULT_WIDTH = 640;
/** Default SVG / PNG / PDF canvas height when the caller omits `options.height`. */
export const DEFAULT_HEIGHT = 360;

/**
 * Default series colour rotation. Matches the Excel 2019+ Office theme
 * accent1..accent6 palette so a brand-new workbook with no theme XML
 * still renders with the colours Excel would have used. Derived from the
 * shared {@link DEFAULT_OFFICE_THEME} so it stays in sync with the rest of
 * the toolkit's default-theme colours.
 */
export const COLORS = [
  `#${DEFAULT_OFFICE_THEME.accent1}`,
  `#${DEFAULT_OFFICE_THEME.accent2}`,
  `#${DEFAULT_OFFICE_THEME.accent3}`,
  `#${DEFAULT_OFFICE_THEME.accent4}`,
  `#${DEFAULT_OFFICE_THEME.accent5}`,
  `#${DEFAULT_OFFICE_THEME.accent6}`
];

/** Dark grey for axis lines / frame strokes. */
export const AXIS_COLOR = "#444444";
/** Light grey for gridlines. */
export const GRID_COLOR = "#D9D9D9";

/**
 * Baseline advance between the paragraphs of one text node, as a multiple of
 * the font size.
 *
 * Shared by every backend so a multi-paragraph title lands in the same place in
 * all of them: the SVG paths emit it as `<tspan dy>`, the PDF paths step the
 * baseline by it, and the raster fallback re-reads it out of the `dy`. It used
 * to be an inline `1.2` in four places, which is exactly how the backends drift
 * apart.
 */
export const TEXT_LINE_HEIGHT_EM = 1.2;

/**
 * Split a text node into its paragraphs.
 *
 * Accepts both LF and CRLF: a Windows-authored title that round-trips through a
 * Buffer or a raw-XML reader arrives with `\r\n`, and leaving the `\r` attached
 * leaks a literal carriage return into the output.
 *
 * Single-line text — the overwhelmingly common case — returns one entry, so no
 * backend pays for the multi-line path.
 */
export function splitTextLines(text: string): { index: number; text: string }[] {
  if (!/[\r\n]/.test(text)) {
    return [{ index: 0, text }];
  }
  // Split on CRLF, a lone CR and a lone LF. Matching only `\r?\n` left an
  // old-Mac-style lone `\r` attached to its line, so the carriage return
  // leaked into the SVG/PDF output as an unrenderable character.
  return text.split(/\r\n|[\r\n]/).map((line, index) => ({ index, text: line }));
}

/**
 * Flatten a label that must occupy exactly one line.
 *
 * Legend entries and similar fixed-height rows measure the whole string for
 * their column width, so a `\n` (an Alt+Enter category cell, or a series name
 * carrying one) has nowhere to go. Every backend used to mishandle it
 * differently — SVG collapsed it to a space per XML whitespace rules, the PDF
 * surface received a raw newline it has no contract for, and the raster path ran
 * the halves together. Collapse it at the source so all of them agree.
 */
export function singleLineLabel(label: string): string {
  return /[\r\n]/.test(label) ? label.split(/\r\n|[\r\n]/).join(" ") : label;
}

/**
 * Preview-grade DrawingML theme palette in `CT_ColorMapping` order, sourced
 * from the shared default Office theme ({@link CHART_THEME_PALETTE}). The
 * renderer only consults this when a chart references a theme colour but no
 * `<a:clrScheme>` has been resolved — the full theme lookup chain requires the
 * workbook's `theme.xml`, which the preview path deliberately does not load.
 * Authors who need exact theme-accurate colours should rasterise with a tool
 * that resolves the theme.
 */
const THEME_PREVIEW_PALETTE: readonly string[] = Object.freeze(
  CHART_THEME_PALETTE.map(hex => `#${hex}`)
);

/**
 * DrawingML theme slot names in the canonical order used by
 * `CT_ColorMapping` (ECMA-376 §20.1.2.3.29). Both parser and writer
 * use this single list so every round-trip picks the same variant of
 * the dk/tx and lt/bg alias pairs (we canonicalise to `dk…` / `lt…`).
 *
 * The parser folds `tx1/bg1/tx2/bg2` into the same indices as
 * `dk1/lt1/dk2/lt2` (they are aliases in the OOXML colour-mapping
 * schema) — see `shape-properties.ts:parseColorFromXml`. The output
 * form therefore uses `dk1/lt1/dk2/lt2`, which is semantically
 * identical to the input.
 */
const THEME_NAMES: readonly string[] = Object.freeze([
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink"
]);

/**
 * Convert a theme-palette index (`ChartColor.theme`) back to its
 * DrawingML `schemeClr` token. Out-of-range indices fall back to
 * `"dk1"` so a malformed model still produces parseable XML Excel
 * renders as the first theme slot rather than XML that contains an
 * `undefined` literal.
 */
export function themeIndexToName(index: number): string {
  return THEME_NAMES[index] ?? "dk1";
}

// ============================================================================
// Math helpers
// ============================================================================

/**
 * Clamp to the closed interval `[0, 1]`. Non-finite input collapses to
 * `0` rather than propagating `NaN` — downstream callers use the
 * result as an interpolation parameter where `NaN` would paint black.
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * Map a data-space value onto the plot area's y coordinate space (SVG
 * y grows downward, so large `value` ends up near the top of the
 * plot). Guards against `max === min` — a single-point dataset or a
 * range that collapsed for any reason would otherwise produce `NaN`.
 */
export function valueToY(
  value: number,
  min: number,
  max: number,
  plot: { y: number; height: number }
): number {
  const span = max - min;
  if (!Number.isFinite(span) || span === 0) {
    return plot.y + plot.height / 2;
  }
  return plot.y + plot.height - ((value - min) / span) * plot.height;
}

/**
 * Map a data-space value onto the plot area's x coordinate space. Same
 * `max === min` guard as {@link valueToY}.
 */
export function valueToX(
  value: number,
  min: number,
  max: number,
  plot: { x: number; width: number }
): number {
  const span = max - min;
  if (!Number.isFinite(span) || span === 0) {
    return plot.x + plot.width / 2;
  }
  return plot.x + ((value - min) / span) * plot.width;
}

/** Convert polar `(radius, angle)` to Cartesian around `(cx, cy)`. */
export function polar(
  cx: number,
  cy: number,
  radius: number,
  angle: number
): { x: number; y: number } {
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

/**
 * Shrink a rect by `amount` on each side (uniform inset). Non-finite
 * inputs collapse to zero on all four components rather than
 * propagating `NaN` — `Math.max(0, NaN)` returns `NaN` per ECMAScript,
 * and a `NaN` width feeding downstream math (e.g. `valueToX`) cascades
 * into every rendered coordinate.
 */
export function insetRect<T extends ChartRect>(rect: T, amount: number): ChartRect {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const x = Number.isFinite(rect.x) ? rect.x + safeAmount : 0;
  const y = Number.isFinite(rect.y) ? rect.y + safeAmount : 0;
  const w = Number.isFinite(rect.width) ? rect.width - safeAmount * 2 : 0;
  const h = Number.isFinite(rect.height) ? rect.height - safeAmount * 2 : 0;
  return {
    x,
    y,
    width: w > 0 ? w : 0,
    height: h > 0 ? h : 0
  };
}

// ============================================================================
// Number formatting
// ============================================================================

/**
 * Format a number for SVG attribute values and inline XML. Two-decimal
 * precision with trailing `.00` stripped (`1.00 → "1"`, `1.50 →
 * "1.50"` — we intentionally keep the second zero to avoid widening the
 * diff against Excel's own byte output on round-trips). Non-finite
 * input returns `"0"` — `Number.toFixed(NaN)` produces the literal
 * string `"NaN"`, which is invalid inside SVG attribute values and
 * breaks downstream parsers.
 */
export function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return value.toFixed(2).replace(/\.00$/, "");
}

/**
 * Format a numeric attribute value for XML emission. Returns an empty
 * string for `undefined` / `NaN` / `±Infinity` — non-finite values would
 * otherwise serialise as literal `"NaN"` / `"Infinity"` text, which no
 * XSD validator accepts as `xsd:double` and downstream parsers reject.
 * Emit an empty string so the caller's attribute-inclusion guard
 * (`if (attrs.length > 0)` or explicit `!== undefined` check) drops
 * the attribute entirely rather than stamping garbage into the wire
 * format.
 *
 * Uses JavaScript's default `toString()` which is round-trip-safe per
 * IEEE 754 (no precision drift) for both integer and fractional input.
 */
export function fmtNumAttr(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "";
  }
  return String(value);
}

/**
 * Format a numeric text-node value. Same semantics as {@link fmtNumAttr},
 * but for use inside element content (e.g. `<cx:pt>42.5</cx:pt>`).
 * Non-finite values become `"0"` — a text node must be non-empty to
 * keep the element well-formed, and `0` is the least-surprising
 * fallback for a blank / error cell (matches how most OOXML readers
 * treat empty numeric `<c:v>`).
 */
export function fmtNumText(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return String(value);
}

/**
 * Format a number for user-visible axis tick labels.
 *
 *   - Integer values → plain digits (`42` → `"42"`).
 *   - `|value| < 0.01` but non-zero → scientific notation with three
 *     significant figures (`1.00e-3`). Two-decimal mantissa keeps the
 *     label compact while preserving enough precision that tick values
 *     remain distinguishable; a single-digit mantissa would collapse
 *     consecutive ticks like `1.1e-3` and `1.4e-3` to the same label.
 *   - Otherwise → single decimal (`toFixed(1)`).
 *   - Non-finite input → `""` (tick position still drawn without
 *     label, keeping the chart legible while flagging the upstream
 *     computation bug on inspection).
 *
 * This is the "axis-label" formatter — it's intentionally compact and
 * does not apply OOXML number formats. Callers that need the authored
 * format code should resolve it upstream.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.01) {
    return value.toExponential(2);
  }
  return value.toFixed(1);
}

// ============================================================================
// XML escaping
// ============================================================================
//
// Split into two distinct helpers with different semantics:
//
//   - `escapeXml` (text content) — escapes `&<>` only. Excel itself
//     writes apostrophes and double-quotes unescaped inside text
//     content (see Excel-authored pivot source names like
//     `<c:name>'Sheet'!Pivot1</c:name>`), so escaping them would make
//     our output diverge visibly at the byte level and break string
//     consumers that do literal matches on quoted sheet names.
//
//   - `escapeXmlAttr` (attribute values) — full `xmlEncodeAttr` from
//     `@xml/encode`: escapes `&<>"'`, strips C0/C1 control chars and
//     lone surrogates, and encodes `\t\n\r` as numeric character
//     references so attribute round-trip preserves whitespace (XML 1.0
//     §3.3.3 attribute-value normalisation would otherwise flatten
//     them to a single space).
//
// chart-renderer, chart-ex-renderer, chart-ex-parser, chart-sidecar
// and the chart-space xform previously carried five subtly-different
// local copies; this module is now the single authoritative home for
// both helpers.

/**
 * Escape XML text content — `&`, `<`, `>` become `&amp;`, `&lt;`,
 * `&gt;` respectively. XML-illegal characters are stripped up front
 * via the shared {@link stripXmlIllegalChars} helper — that covers
 * the forbidden C0 controls (`0x00-0x08 | 0x0B | 0x0C | 0x0E-0x1F`),
 * DEL (`0x7F`, project-policy strip despite being technically legal
 * XML), lone UTF-16 surrogate halves, and the `0xFFFE` / `0xFFFF`
 * noncharacters.
 *
 * Apostrophe and double-quote pass through unescaped — both are legal
 * inside text content and leaving them alone preserves Excel's byte
 * output (`<c:name>'Sheet'!Pivot1</c:name>` with literal quotes).
 *
 * We keep this separate from {@link xmlEncode} in `@xml/encode`
 * because that helper escapes all five reserved entities; the chart
 * module prefers byte-level parity with Excel's own output, which
 * leaves `'` / `"` alone in text context.
 */
export function escapeXml(value: string): string {
  // Fast path: most chart text is plain ASCII / BMP with no control
  // chars. A quick scan tells us whether to enter the slow path or
  // just run the cheap three-replace chain. Valid surrogate pairs
  // (any emoji / non-BMP CJK character) must be skipped intact — a
  // naive "any high surrogate triggers strip" would force the slow
  // path on every string containing one, defeating the fast-path.
  let needsStrip = false;
  const len = value.length;
  for (let i = 0; i < len; i++) {
    const code = value.charCodeAt(i);
    if (code < 32) {
      if (code !== 9 && code !== 10 && code !== 13) {
        needsStrip = true;
        break;
      }
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < len ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Valid surrogate pair — consume both halves.
        i++;
      } else {
        needsStrip = true;
        break;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate.
      needsStrip = true;
      break;
    } else if (code === 0x7f || code === 0xfffe || code === 0xffff) {
      needsStrip = true;
      break;
    }
  }
  const sanitised = needsStrip ? stripXmlIllegalChars(value) : value;
  return sanitised.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Strip characters that can't appear in XML 1.0 content or attribute
 * values. Re-exported from `@xml/encode` so the chart module and the
 * XML module share a single source of truth; previously each carried a
 * local copy with comment-level disagreements (one called DEL a C1
 * control, the other called it "XML-forbidden" — both inaccurate).
 * See {@link stripXmlIllegalChars} in `@xml/encode` for the canonical
 * rules.
 */
function stripXmlIllegalChars(value: string): string {
  return sharedStripXmlIllegalChars(value);
}

export { xmlEncodeAttr as escapeXmlAttr } from "@xml/encode";

// ============================================================================
// Hex colour helpers
// ============================================================================

/**
 * Normalise any supported hex input to a 6-digit uppercase value
 * (without the leading `#`). Accepts:
 *
 *   - 3-digit shorthand `#FFF` → `FFFFFF` (each nibble duplicated).
 *   - 4-digit shorthand `#FFFA` with alpha → `FFFFFF` (alpha dropped;
 *     renderer encodes alpha separately).
 *   - 6-digit `#112233`.
 *   - 8-digit `#11223344` with alpha → `112233` (alpha dropped).
 *
 * Returns `undefined` when the input cannot be coerced — lets callers
 * fall back to a default colour rather than emit `#NaNNaNNaN`.
 */
export function normalizeHex6(hex: string | undefined): string | undefined {
  if (!hex) {
    return undefined;
  }
  const clean = hex.replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(clean)) {
    return clean.slice(0, 6);
  }
  if (/^[0-9A-F]{3}([0-9A-F])?$/.test(clean)) {
    return clean
      .slice(0, 3)
      .split("")
      .map(ch => ch + ch)
      .join("");
  }
  return undefined;
}

/**
 * Extract the alpha channel from a hex colour string (if present) as
 * a fraction in `[0, 1]`. Accepts `#RGBA` and `#RRGGBBAA`; the 3-
 * and 6-digit forms have no alpha and return `undefined`.
 */
function hexAlpha(hex: string | undefined): number | undefined {
  if (!hex) {
    return undefined;
  }
  const clean = hex.replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{8}$/.test(clean)) {
    return parseInt(clean.slice(6, 8), 16) / 255;
  }
  if (/^[0-9A-F]{4}$/.test(clean)) {
    const aNibble = clean[3];
    return parseInt(aNibble + aNibble, 16) / 255;
  }
  return undefined;
}

/**
 * White-blend `hex` by `alpha` — a cheap opacity approximation for
 * SVG surfaces that don't support per-element `fill-opacity`. Accepts
 * 3/4/6/8-digit hex; returns the input untouched for anything else
 * rather than emit `"#NaNNaNNaN"`.
 */
export function withAlpha(hex: string, alpha: number): string {
  const body = normalizeHex6(hex);
  if (!body) {
    return hex;
  }
  const safeAlpha = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  const mix = (component: string): string => {
    const value = parseInt(component, 16);
    return Math.round(value * safeAlpha + 255 * (1 - safeAlpha))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  };
  return `#${mix(body.slice(0, 2))}${mix(body.slice(2, 4))}${mix(body.slice(4, 6))}`;
}

/**
 * Linearly interpolate between two hex colours. `t` is clamped to
 * `[0, 1]`; non-finite `t` falls back to `0`. Malformed hex inputs
 * degrade gracefully (prefer the end colour when `t >= 0.5`; prefer
 * the start colour otherwise) so one bad input channel never produces
 * `"#NaNNaNNaN"`.
 */
export function interpolateColor(a: string, b: string, t: number): string {
  const ca = normalizeHex6(a);
  const cb = normalizeHex6(b);
  const clamped = clamp01(t);
  if (!ca || !cb) {
    return `#${clamped >= 0.5 ? (cb ?? ca ?? "000000") : (ca ?? cb ?? "000000")}`;
  }
  const mix = (i: number): string => {
    // `ca` / `cb` have been normalised to exactly 6 hex digits by
    // `normalizeHex6`, so `parseInt(..., 16)` on a 2-char slice cannot
    // produce `NaN`. We rely on that invariant — don't add a
    // defensive-looking guard that masks a real upstream regression.
    const av = parseInt(ca.slice(i, i + 2), 16);
    const bv = parseInt(cb.slice(i, i + 2), 16);
    return Math.round(av + (bv - av) * clamped)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  };
  return `#${mix(0)}${mix(2)}${mix(4)}`;
}

/**
 * Convert a hex colour string to a {@link PdfColor}. Preserves an
 * explicit alpha byte when the caller supplied 4- or 8-digit hex —
 * PDF surfaces that honour `PdfColor.a` (notably `PdfPageBuilder` via
 * `/ExtGState`) then produce real translucency. Malformed input
 * degrades to opaque black rather than producing `NaN` channels, which
 * would emit broken PDF content.
 */
export function hexToPdfColor(hex: string): PdfColor {
  const clean = normalizeHex6(hex);
  if (!clean) {
    return { r: 0, g: 0, b: 0 };
  }
  const alpha = hexAlpha(hex);
  const base: PdfColor = {
    r: parseInt(clean.slice(0, 2), 16) / 255,
    g: parseInt(clean.slice(2, 4), 16) / 255,
    b: parseInt(clean.slice(4, 6), 16) / 255
  };
  return alpha !== undefined ? { ...base, a: alpha } : base;
}

/**
 * Like {@link hexToPdfColor} but attaches an explicit alpha value.
 * Callers use this to mirror the SVG path's `withAlpha(color, 0.35)`
 * pattern on the PDF bridge: the hex itself stays opaque, `a` carries
 * the transparency the SVG would paint by white-blending.
 */
export function hexToPdfColorWithAlpha(hex: string, alpha: number): PdfColor {
  return { ...hexToPdfColor(hex), a: clamp01(alpha) };
}

// ============================================================================
// Shape-properties preview helpers
// ============================================================================

/**
 * Resolve a {@link ChartColor} into a preview-grade hex colour. Accepts
 * every DrawingML colour variant Excel emits — `srgb`, `theme` (looked
 * up in {@link THEME_PREVIEW_PALETTE}), `sysClr` (the two Excel keeps
 * meaningful in the preview — `windowText` / `window`), and `prstClr`
 * (the ~140-entry {@link PRESET_COLOR_HEX_TABLE}). Returns `undefined`
 * when the colour is absent or references something this preview cannot
 * resolve (an unknown preset / sysClr, or a theme index outside the
 * 12-entry palette). Callers that need a default coalesce with `??`.
 *
 * Shared by fill, line, and text-property resolvers so a file that
 * sets, say, a gridline colour via `<a:schemeClr val="accent3"/>`
 * paints the correct accent-3 hex — previously the line/text paths
 * only honoured `srgbClr` and silently fell back to the renderer's
 * default grey.
 *
 * Colour modifiers (`tint`, `shade`, `lumMod`, `lumOff`, `alpha`,
 * `satMod`) are intentionally NOT applied — the preview path doesn't
 * model the DrawingML blend pipeline, and approximating one component
 * in isolation produces visibly-wrong results. Authors who need
 * exact theme-derived colours should rasterise with a full DrawingML
 * renderer.
 */
export function resolveChartColor(color: ChartColor | undefined): string | undefined {
  if (!color) {
    return undefined;
  }
  if (typeof color.srgb === "string") {
    // Validate: OOXML `ST_HexBinary3` is a 6-digit hex (RGB) but we
    // tolerate a leading `#` for backward compatibility. Also honour
    // the 8-digit `RRGGBBAA` form Excel uses when encoding alpha
    // inside the hex — drop the alpha for the preview (alpha is
    // surfaced separately as `color.alpha` on the structured model).
    //
    // If `srgb` is set but malformed, return `undefined` rather than
    // falling through to `theme` / `sysClr` / `prstClr`. Legitimate
    // DrawingML colours set exactly one of those fields, so a
    // fall-through only ever helps malformed data — and when it does,
    // it silently substitutes a different colour source than the
    // author wrote, which is worse than coalescing to a default.
    const clean = color.srgb.replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(clean)) {
      return `#${clean.toUpperCase()}`;
    }
    if (/^[0-9a-fA-F]{8}$/.test(clean)) {
      return `#${clean.slice(0, 6).toUpperCase()}`;
    }
    return undefined;
  }
  if (typeof color.theme === "number") {
    // `Number.isInteger` guards against `NaN`, `Infinity`, fractional
    // values, and negative indices — any of which would slip past
    // `typeof === "number"` but produce `undefined` on index access,
    // silently skipping the sysClr / prstClr fallbacks below. On a
    // malformed or out-of-range theme index, fall through so the
    // caller's default resolution still runs.
    if (
      Number.isInteger(color.theme) &&
      color.theme >= 0 &&
      color.theme < THEME_PREVIEW_PALETTE.length
    ) {
      return THEME_PREVIEW_PALETTE[color.theme];
    }
  }
  if (typeof color.schemeName === "string") {
    // `schemeName` carries a DrawingML scheme token that couldn't be
    // mapped onto a theme slot. The preview has no concept of
    // placeholder colours (e.g. `phClr`), so fall back to `undefined`
    // — caller coalesces to a default. Returning `undefined` here is
    // preferable to guessing a theme colour that may not match the
    // author's intent on a real `<a:clrScheme>` resolver.
    return undefined;
  }
  if (typeof color.sysClr === "string") {
    if (color.sysClr === "windowText") {
      return "#000000";
    }
    if (color.sysClr === "window") {
      return "#FFFFFF";
    }
    return undefined;
  }
  if (typeof color.prstClr === "string") {
    const hex = PRESET_COLOR_HEX_TABLE[color.prstClr];
    return hex ? `#${hex}` : undefined;
  }
  return undefined;
}

/**
 * Resolve a {@link ChartFill} into a preview-grade hex colour. Recognises
 * the four `<a:solidFill>` children Excel writes (`srgbClr`, `schemeClr`,
 * `sysClr`, `prstClr`) via the shared {@link resolveChartColor} resolver
 * and the {@link THEME_PREVIEW_PALETTE} / {@link PRESET_COLOR_HEX_TABLE}
 * lookup tables for the theme / preset variants.
 *
 * When the fill cannot be resolved (no fill set, empty `solidFill`,
 * unknown preset / system colour), returns `fallback`. Callers that
 * want `undefined` for misses should pass `undefined` as the fallback;
 * callers that want a palette rotation entry should resolve the
 * fallback themselves and pass it in. This unifies what used to be
 * two almost-identical helpers (`colorFromShapeFill` in
 * chart-renderer.ts and `shapeFillColor` in chart-ex-renderer.ts).
 */
export function previewShapeFillColor<F extends string | undefined>(
  fill: ChartFill | undefined,
  fallback: F
): F | string {
  return resolveChartColor(fill?.solid) ?? fallback;
}

/**
 * Resolve a {@link ShapeProperties.ln} stroke colour to a preview-grade
 * hex string. Honours every DrawingML colour variant on the line's own
 * `<a:solidFill>` via {@link resolveChartColor} — previously only
 * `srgbClr` was read, which silently reverted every theme / preset /
 * sysClr line colour (gridlines, axes, trendlines, error bars) to the
 * renderer's default grey on load.
 */
export function previewShapeLineColor(line: ChartLine | undefined): string | undefined {
  return resolveChartColor(line?.color);
}

/**
 * Resolve a {@link ShapeProperties.ln} stroke width (OOXML EMU) to a
 * preview pixel width. OOXML stores line widths in EMU (1 pt = 12 700
 * EMU); the preview clamps to a minimum of 0.5 px so a tiny authored
 * width still renders as a visible stroke.
 */
export function previewShapeLineWidthPx(line: ChartLine | undefined): number | undefined {
  return typeof line?.width === "number" ? Math.max(0.5, emuToPt(line.width)) : undefined;
}

// ============================================================================
// Preset colours (DrawingML `ST_PresetColorVal`)
// ============================================================================

/**
 * DrawingML preset colour table (`ST_PresetColorVal` from the OOXML
 * schema). ~140 named colours — superset of HTML's X11 palette. The
 * renderers resolve `<a:prstClr val="…"/>` through this table so
 * template-built workbooks with preset colour references (`darkRed`,
 * `navy`, `forestGreen`, …) render with the correct hex instead of
 * rotating through the default series palette.
 *
 * Previously this lived on `chart-renderer.ts` and was imported by
 * `chart-ex-renderer.ts`. Moved here so it sits below both renderers
 * in the import graph.
 */
export const PRESET_COLOR_HEX_TABLE: Readonly<Record<string, string>> = Object.freeze({
  aliceBlue: "F0F8FF",
  antiqueWhite: "FAEBD7",
  aqua: "00FFFF",
  aquamarine: "7FFFD4",
  azure: "F0FFFF",
  beige: "F5F5DC",
  bisque: "FFE4C4",
  black: "000000",
  blanchedAlmond: "FFEBCD",
  blue: "0000FF",
  blueViolet: "8A2BE2",
  brown: "A52A2A",
  burlyWood: "DEB887",
  cadetBlue: "5F9EA0",
  chartreuse: "7FFF00",
  chocolate: "D2691E",
  coral: "FF7F50",
  cornflowerBlue: "6495ED",
  cornsilk: "FFF8DC",
  crimson: "DC143C",
  cyan: "00FFFF",
  darkBlue: "00008B",
  darkCyan: "008B8B",
  darkGoldenrod: "B8860B",
  darkGray: "A9A9A9",
  darkGreen: "006400",
  darkGrey: "A9A9A9",
  darkKhaki: "BDB76B",
  darkMagenta: "8B008B",
  darkOliveGreen: "556B2F",
  darkOrange: "FF8C00",
  darkOrchid: "9932CC",
  darkRed: "8B0000",
  darkSalmon: "E9967A",
  darkSeaGreen: "8FBC8F",
  darkSlateBlue: "483D8B",
  darkSlateGray: "2F4F4F",
  darkSlateGrey: "2F4F4F",
  darkTurquoise: "00CED1",
  darkViolet: "9400D3",
  deepPink: "FF1493",
  deepSkyBlue: "00BFFF",
  dimGray: "696969",
  dimGrey: "696969",
  dkBlue: "00008B",
  dkCyan: "008B8B",
  dkGoldenrod: "B8860B",
  dkGray: "A9A9A9",
  dkGreen: "006400",
  dkGrey: "A9A9A9",
  dkKhaki: "BDB76B",
  dkMagenta: "8B008B",
  dkOliveGreen: "556B2F",
  dkOrange: "FF8C00",
  dkOrchid: "9932CC",
  dkRed: "8B0000",
  dkSalmon: "E9967A",
  dkSeaGreen: "8FBC8F",
  dkSlateBlue: "483D8B",
  dkSlateGray: "2F4F4F",
  dkSlateGrey: "2F4F4F",
  dkTurquoise: "00CED1",
  dkViolet: "9400D3",
  dodgerBlue: "1E90FF",
  firebrick: "B22222",
  floralWhite: "FFFAF0",
  forestGreen: "228B22",
  fuchsia: "FF00FF",
  gainsboro: "DCDCDC",
  ghostWhite: "F8F8FF",
  gold: "FFD700",
  goldenrod: "DAA520",
  gray: "808080",
  green: "008000",
  greenYellow: "ADFF2F",
  grey: "808080",
  honeydew: "F0FFF0",
  hotPink: "FF69B4",
  indianRed: "CD5C5C",
  indigo: "4B0082",
  ivory: "FFFFF0",
  khaki: "F0E68C",
  lavender: "E6E6FA",
  lavenderBlush: "FFF0F5",
  lawnGreen: "7CFC00",
  lemonChiffon: "FFFACD",
  lightBlue: "ADD8E6",
  lightCoral: "F08080",
  lightCyan: "E0FFFF",
  lightGoldenrodYellow: "FAFAD2",
  lightGray: "D3D3D3",
  lightGreen: "90EE90",
  lightGrey: "D3D3D3",
  lightPink: "FFB6C1",
  lightSalmon: "FFA07A",
  lightSeaGreen: "20B2AA",
  lightSkyBlue: "87CEFA",
  lightSlateGray: "778899",
  lightSlateGrey: "778899",
  lightSteelBlue: "B0C4DE",
  lightYellow: "FFFFE0",
  ltBlue: "ADD8E6",
  ltCoral: "F08080",
  ltCyan: "E0FFFF",
  ltGoldenrodYellow: "FAFAD2",
  ltGray: "D3D3D3",
  ltGreen: "90EE90",
  ltGrey: "D3D3D3",
  ltPink: "FFB6C1",
  ltSalmon: "FFA07A",
  ltSeaGreen: "20B2AA",
  ltSkyBlue: "87CEFA",
  ltSlateGray: "778899",
  ltSlateGrey: "778899",
  ltSteelBlue: "B0C4DE",
  ltYellow: "FFFFE0",
  lime: "00FF00",
  limeGreen: "32CD32",
  linen: "FAF0E6",
  magenta: "FF00FF",
  maroon: "800000",
  medAquamarine: "66CDAA",
  medBlue: "0000CD",
  medOrchid: "BA55D3",
  medPurple: "9370DB",
  medSeaGreen: "3CB371",
  medSlateBlue: "7B68EE",
  medSpringGreen: "00FA9A",
  medTurquoise: "48D1CC",
  medVioletRed: "C71585",
  mediumAquamarine: "66CDAA",
  mediumBlue: "0000CD",
  mediumOrchid: "BA55D3",
  mediumPurple: "9370DB",
  mediumSeaGreen: "3CB371",
  mediumSlateBlue: "7B68EE",
  mediumSpringGreen: "00FA9A",
  mediumTurquoise: "48D1CC",
  mediumVioletRed: "C71585",
  midnightBlue: "191970",
  mintCream: "F5FFFA",
  mistyRose: "FFE4E1",
  moccasin: "FFE4B5",
  navajoWhite: "FFDEAD",
  navy: "000080",
  oldLace: "FDF5E6",
  olive: "808000",
  oliveDrab: "6B8E23",
  orange: "FFA500",
  orangeRed: "FF4500",
  orchid: "DA70D6",
  paleGoldenrod: "EEE8AA",
  paleGreen: "98FB98",
  paleTurquoise: "AFEEEE",
  paleVioletRed: "DB7093",
  papayaWhip: "FFEFD5",
  peachPuff: "FFDAB9",
  peru: "CD853F",
  pink: "FFC0CB",
  plum: "DDA0DD",
  powderBlue: "B0E0E6",
  purple: "800080",
  red: "FF0000",
  rosyBrown: "BC8F8F",
  royalBlue: "4169E1",
  saddleBrown: "8B4513",
  salmon: "FA8072",
  sandyBrown: "F4A460",
  seaGreen: "2E8B57",
  seaShell: "FFF5EE",
  sienna: "A0522D",
  silver: "C0C0C0",
  skyBlue: "87CEEB",
  slateBlue: "6A5ACD",
  slateGray: "708090",
  slateGrey: "708090",
  snow: "FFFAFA",
  springGreen: "00FF7F",
  steelBlue: "4682B4",
  tan: "D2B48C",
  teal: "008080",
  thistle: "D8BFD8",
  tomato: "FF6347",
  turquoise: "40E0D0",
  violet: "EE82EE",
  wheat: "F5DEB3",
  white: "FFFFFF",
  whiteSmoke: "F5F5F5",
  yellow: "FFFF00",
  yellowGreen: "9ACD32"
});

/**
 * Measure the rendered pixel width of a label using the Excel module's
 * built-in font metrics engine (`@excel/utils/text-metrics`). This replaces
 * the previous `text.length * fontSize * 0.55` approximation with a real
 * per-character advance-width lookup, which matters wherever the renderer
 * must allocate space for a label (legend width, title centring, PDF
 * anchoring). Chart labels default to Arial to match the SVG emit path
 * (`font-family="Arial"` in the SVG surface), and `bold`/`italic` are
 * forwarded when present — the Excel engine already knows how to degrade
 * to a category-average factor for unrecognised faces.
 */
export function estimateTextWidth(
  text: string,
  fontSize: number,
  options: { bold?: boolean; italic?: boolean; fontName?: string } = {}
): number {
  return measureText(text, {
    size: fontSize,
    family: options.fontName ?? "arial",
    ...(options.bold === undefined ? {} : { bold: options.bold }),
    ...(options.italic === undefined ? {} : { italic: options.italic })
  });
}

/**
 * Hard ceiling for sparse-array densification — prevents malicious or malformed XML
 * from allocating gigabyte-scale arrays via a bogus `<c:ptCount>` / `<cx:ptCount>`.
 * Excel's per-worksheet row limit is 1 048 576; doubling that gives a generous upper
 * bound that still fits comfortably in memory for legitimate workbooks.
 */
export const SPARSE_ARRAY_CEILING = 2_097_152;

/**
 * Reconstruct a dense array from OOXML's sparse `idx`-addressed point form.
 *
 * Both the classic (`<c:pt idx>`) and ChartEx (`<cx:pt idx>`) readers need this, and
 * writing it twice is how they came to disagree: the ChartEx copy sized the array from
 * `max(points.length, ptCount)` alone, so a point at `idx="3"` in a file that omits
 * `ptCount` fell outside its own array and was dropped — the series rendered empty
 * rather than sparse. The length has to cover `maxIdx + 1` as well, which is what this
 * one implementation does for both callers.
 *
 * @param points     Sparse records carrying an `index` and an optional `value`.
 * @param pointCount Slot count declared by `ptCount`, when present.
 * @param empty      Value for slots no point addresses.
 * @param coerce     Maps a raw value to the output type; used to reject non-finite
 *                   numbers and non-string categories to `empty`.
 */
export function densifySparsePoints<T, Raw>(
  points: readonly { index: number; value?: Raw }[],
  pointCount: number | undefined,
  empty: T,
  coerce: (raw: Raw | undefined) => T
): T[] {
  if (points.length === 0) {
    return [];
  }
  let maxIdx = -1;
  for (const p of points) {
    if (typeof p.index === "number" && Number.isFinite(p.index) && p.index > maxIdx) {
      maxIdx = p.index;
    }
  }
  const declaredCount = typeof pointCount === "number" ? pointCount : 0;
  const rawLength = Math.max(points.length, maxIdx + 1, declaredCount);
  const length = Math.min(rawLength, SPARSE_ARRAY_CEILING);
  const dense: T[] = new Array(length).fill(empty);
  for (const p of points) {
    const idx =
      typeof p.index === "number" && Number.isFinite(p.index) && p.index >= 0 ? p.index : -1;
    if (idx < 0 || idx >= length) {
      continue;
    }
    dense[idx] = coerce(p.value);
  }
  return dense;
}
