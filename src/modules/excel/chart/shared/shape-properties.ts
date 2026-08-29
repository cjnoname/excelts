/**
 * Shape property (spPr) and text property (txPr) utilities.
 *
 * During chart parsing, spPr and txPr elements are captured as raw XML strings
 * for perfect round-trip fidelity. These utilities provide structured read/write
 * access to the most commonly used properties:
 *
 * - Fill color (solid sRGB / theme)
 * - Line/outline color and width
 * - Font size, bold, italic, color, family
 *
 * The approach: parse raw XML on demand using regex extraction (no full DOM),
 * and generate raw XML from structured models when creating new properties.
 */

import type {
  ShapeProperties,
  ChartTextProperties,
  ChartColor,
  ChartFill,
  ChartLine,
  CustomGeometry,
  CustomGeometryCommand,
  CustomGeometryPath,
  EffectList,
  PresetGeometry,
  Shadow,
  Scene3D,
  ShapeProperties3D,
  ShapeTransform,
  Bevel
} from "@excel/chart/model/types";

// ============================================================================
// Raw XML access helpers
// ============================================================================

/** Get the raw XML string if the object was captured as raw XML. */
function getRawXml(obj: { _rawXml?: string } | undefined): string | undefined {
  return obj?._rawXml;
}

/**
 * Check if the object is purely a raw XML capture — `_rawXml` is set
 * and NO structured fields have been populated. The parser produces
 * dual-state objects (both `_rawXml` and structured) from raw bytes so
 * downstream consumers get the best of both worlds: cheap byte-perfect
 * round-trip PLUS typed access. Getters (`getSpPrFillColor` et al.)
 * must prefer structured when present; setters must NOT reparse from
 * `_rawXml` because doing so wipes any prior structured mutation.
 *
 * Writers must ALSO consult this predicate before short-circuiting to
 * the raw bytes: if the model has been mutated through a direct
 * property assignment (`spPr.fill = {...}` without routing through
 * `setSpPrFill`), the raw bytes are stale and the structured path
 * must win. Exported for use by `_renderSpPr` in both the classic
 * chart-space xform and the ChartEx renderer.
 *
 * Previously `isRawXml` returned `true` whenever `_rawXml` was a
 * string, which caused `setSpPrFill` → `parseSpPr` to re-read from
 * raw and discard pending `line.width` / `fill.solid` assignments.
 */
export function isRawXmlShape(obj: { _rawXml?: string } | undefined): boolean {
  return isRawXml(obj);
}

/**
 * Whether a `ChartTextProperties` object is a pure raw-XML capture
 * with no structured fields set. Analogous to {@link isRawXmlShape}
 * for shape properties: when a caller directly assigns `txPr.color`,
 * `txPr.size`, etc., the stale `_rawXml` must NOT win — the writer
 * should fall through to the structured rendering path.
 */
export function isRawXmlTxPr(obj: { _rawXml?: string } | undefined): boolean {
  if (!obj || typeof obj._rawXml !== "string") {
    return false;
  }
  const structuredKeys = [
    "size",
    "bold",
    "italic",
    "underline",
    "strike",
    "color",
    "fontFamily",
    "eastAsianFamily",
    "complexScriptFamily",
    "rotation",
    "baseline",
    "kern",
    "spacing",
    "cap",
    "lang"
  ] as const;
  for (const key of structuredKeys) {
    if ((obj as Record<string, unknown>)[key] !== undefined) {
      return false;
    }
  }
  return true;
}

function isRawXml(obj: { _rawXml?: string } | undefined): boolean {
  if (!obj || typeof obj._rawXml !== "string") {
    return false;
  }
  // "Purely raw" when no structured field is present. Enumerate the
  // fields we care about so adding new structured slots to
  // `ShapeProperties` doesn't require touching this predicate —
  // anything absent from this list is either raw-bytes-only (like
  // `extLst`) or part of the raw payload itself.
  const structuredKeys = [
    "fill",
    "line",
    "effectList",
    "scene3d",
    "sp3d",
    "transform",
    "presetGeometry",
    "customGeometry"
  ] as const;
  for (const key of structuredKeys) {
    if ((obj as Record<string, unknown>)[key] !== undefined) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Color parsing from raw XML
// ============================================================================

// Pre-compiled regexes for parseColorFromXml (always called with "a" prefix)
const SRGB_CLR_RE = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/i;
const SCHEME_CLR_RE = /<a:schemeClr\s+val="([^"]+)"/i;

// Pre-compiled regexes for parseShadowElement
const OUTER_SHDW_RE = /<a:outerShdw\s+([^>]*)>([\s\S]*?)<\/a:outerShdw>/;
const INNER_SHDW_RE = /<a:innerShdw\s+([^>]*)>([\s\S]*?)<\/a:innerShdw>/;
const SHADOW_RES: Record<string, RegExp> = {
  "a:outerShdw": OUTER_SHDW_RE,
  "a:innerShdw": INNER_SHDW_RE
};

/**
 * Extract a region from `xml` between the opening tag match and the corresponding
 * closing tag (or a reasonable fallback for self-closing elements).
 */
function extractColorRegion(xml: string, openMatch: RegExpExecArray, closeTag: string): string {
  const endIdx = xml.indexOf(closeTag, openMatch.index);
  if (endIdx >= 0) {
    // Stop at the close tag's `>` so the region never spills into the
    // next sibling (which could itself have a colour element whose
    // modifiers would then be misattributed).
    const closeGt = xml.indexOf(">", endIdx);
    return xml.slice(openMatch.index, closeGt >= 0 ? closeGt + 1 : endIdx + closeTag.length);
  }
  // No close tag — the element is self-closing (`<a:srgbClr val="FF0000"/>`)
  // or truncated. DrawingML never nests modifiers inside a self-closing
  // colour token, so return just the opening fragment up to the first
  // `>` to avoid picking up modifiers that belong to a sibling colour.
  const openEnd = xml.indexOf(">", openMatch.index);
  return xml.slice(
    openMatch.index,
    openEnd >= 0 ? openEnd + 1 : openMatch.index + openMatch[0].length
  );
}

/**
 * Parse all DrawingML color modifiers from a region of XML.
 * Handles: alpha, tint, shade, satMod, lumMod, lumOff.
 *
 * Regexes accept `-?\d+(?:\.\d+)?` — negative and fractional values
 * are legal in third-party exports (e.g. `<a:tint val="-5000"/>`,
 * `<a:satMod val="123456.7"/>`); `\d+` alone dropped them silently.
 * `parseFloat` with rounding preserves the intended semantics.
 */
function parseColorModifiers(region: string, color: ChartColor): void {
  const parseModifierValue = (m: RegExpExecArray | null): number | undefined =>
    m ? Math.round(parseFloat(m[1])) : undefined;
  const alphaMatch = /<a:alpha\s+val="(-?\d+(?:\.\d+)?)"/.exec(region);
  const alphaVal = parseModifierValue(alphaMatch);
  if (alphaVal !== undefined) {
    color.alpha = alphaVal;
  }
  const tintMatch = /<a:tint\s+val="(-?\d+(?:\.\d+)?)"/.exec(region);
  if (tintMatch) {
    color.tint = parseFloat(tintMatch[1]) / 100000;
  }
  const shadeMatch = /<a:shade\s+val="(-?\d+(?:\.\d+)?)"/.exec(region);
  const shadeVal = parseModifierValue(shadeMatch);
  if (shadeVal !== undefined) {
    color.shade = shadeVal;
  }
  const satModMatch = /<a:satMod\s+val="(-?\d+(?:\.\d+)?)"/.exec(region);
  const satModVal = parseModifierValue(satModMatch);
  if (satModVal !== undefined) {
    color.satMod = satModVal;
  }
  const lumModMatch = /<a:lumMod\s+val="(-?\d+(?:\.\d+)?)"/.exec(region);
  const lumModVal = parseModifierValue(lumModMatch);
  if (lumModVal !== undefined) {
    color.lumMod = lumModVal;
  }
  const lumOffMatch = /<a:lumOff\s+val="(-?\d+(?:\.\d+)?)"/.exec(region);
  const lumOffVal = parseModifierValue(lumOffMatch);
  if (lumOffVal !== undefined) {
    color.lumOff = lumOffVal;
  }
}

// Pre-compiled regexes for sysClr / prstClr
const SYS_CLR_RE = /<a:sysClr\s+val="([^"]+)"/i;
const PRST_CLR_RE = /<a:prstClr\s+val="([^"]+)"/i;

function parseColorFromXml(xml: string): ChartColor | undefined {
  // Try srgbClr
  const srgbMatch = SRGB_CLR_RE.exec(xml);
  if (srgbMatch) {
    const color: ChartColor = { srgb: srgbMatch[1].toUpperCase() };
    const region = extractColorRegion(xml, srgbMatch, `</a:srgbClr`);
    parseColorModifiers(region, color);
    return color;
  }
  // Try schemeClr (theme)
  const schemeMatch = SCHEME_CLR_RE.exec(xml);
  if (schemeMatch) {
    // Theme index → canonical scheme name. `tx1/bg1/tx2/bg2` are
    // "slide"-style aliases of `dk1/lt1/dk2/lt2` defined in ECMA-376
    // §20.1.2.3.29, so we fold them into the same indices rather than
    // dropping them as "unknown theme" (which used to silently return
    // index 0 / `dk1` and corrupt the colour on round-trip).
    const themeMap: Record<string, number> = {
      dk1: 0,
      tx1: 0,
      lt1: 1,
      bg1: 1,
      dk2: 2,
      tx2: 2,
      lt2: 3,
      bg2: 3,
      accent1: 4,
      accent2: 5,
      accent3: 6,
      accent4: 7,
      accent5: 8,
      accent6: 9,
      hlink: 10,
      folHlink: 11
    };
    const raw = schemeMatch[1];
    const idx = themeMap[raw];
    // When we can't map the name to a theme index (e.g. `phClr` — the
    // DrawingML "placeholder colour" token — or a future addition),
    // preserve it as a scheme-name token under `schemeName` so the
    // writer re-emits `<a:schemeClr val="…">` on round-trip. The old
    // code stored the raw token under `sysClr`, which caused the
    // writer to emit `<a:sysClr>` instead — silently changing the
    // DrawingML element type and breaking theme placeholder semantics.
    const color: ChartColor = idx !== undefined ? { theme: idx } : { schemeName: raw };
    const region = extractColorRegion(xml, schemeMatch, `</a:schemeClr`);
    parseColorModifiers(region, color);
    return color;
  }
  // Try sysClr (system color)
  const sysMatch = SYS_CLR_RE.exec(xml);
  if (sysMatch) {
    const color: ChartColor = { sysClr: sysMatch[1] };
    const region = extractColorRegion(xml, sysMatch, `</a:sysClr`);
    parseColorModifiers(region, color);
    return color;
  }
  // Try prstClr (preset color)
  const prstMatch = PRST_CLR_RE.exec(xml);
  if (prstMatch) {
    const color: ChartColor = { prstClr: prstMatch[1] };
    const region = extractColorRegion(xml, prstMatch, `</a:prstClr`);
    parseColorModifiers(region, color);
    return color;
  }
  return undefined;
}

// ============================================================================
// Gradient / pattern fill parsing from raw XML
// ============================================================================

function parseGradientFill(xml: string): ChartFill | undefined {
  const gradStart = xml.indexOf("<a:gradFill");
  const gradEnd = xml.indexOf("</a:gradFill");
  if (gradStart < 0 || gradEnd < 0) {
    return undefined;
  }
  const region = xml.slice(gradStart, gradEnd + 20);

  // Parse gradient stops. OOXML `<a:gs pos="N">` encodes `N` as
  // hundredths of a percent (0–100000), NOT thousandths. The
  // previous implementation divided by 1000 — producing `stop.position`
  // values that were 100× too large (e.g. a 50% stop decoded as 50
  // instead of 0.5). Paired with the equally-wrong writer multiplier
  // of ×1000, round-trip byte-compared equal but any freshly-built
  // gradient rendered in Excel at a wildly wrong position. See the
  // companion fix in `chart-ex-renderer.ts:renderSpPr` gradient path.
  const stops: Array<{ position: number; color: ChartColor }> = [];
  // Find each <a:gs pos="..."> ... </a:gs>
  const gsListStart = region.indexOf("<a:gsLst");
  const gsListEnd = region.indexOf("</a:gsLst");
  if (gsListStart >= 0 && gsListEnd >= 0) {
    const gsListRegion = region.slice(gsListStart, gsListEnd + 12);
    // OOXML `ST_PositiveFixedPercentage` is `xsd:int` in [0, 100000]
    // — integer by schema — but third-party authors sometimes emit
    // fractional values (e.g. `pos="33333.33"`) that readers tolerate.
    // The previous `\d+`-only regex silently dropped stops with
    // fractional positions, truncating the whole gradient on parse.
    // Match fractional too so we at least preserve the author's intent.
    const gsPosRegex = /<a:gs\s+pos="(-?\d+(?:\.\d+)?)"/g;
    let match: RegExpExecArray | null;
    const positions: Array<{ pos: number; startIdx: number }> = [];
    while ((match = gsPosRegex.exec(gsListRegion)) !== null) {
      positions.push({ pos: parseFloat(match[1]), startIdx: match.index });
    }
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i].startIdx;
      const end = i + 1 < positions.length ? positions[i + 1].startIdx : gsListRegion.length;
      const gsRegion = gsListRegion.slice(start, end);
      const color = parseColorFromXml(gsRegion);
      if (color) {
        stops.push({ position: positions[i].pos / 100000, color });
      }
    }
  }

  // A legal gradient requires at least two stops — `CT_GradientStopList`
  // declares `minOccurs="2"`. Reject single-stop gradients at parse so
  // the writer (which gates `g.stops.length >= 2`) doesn't silently
  // drop the entire `<a:gradFill>` block on round-trip, producing a
  // shape with no fill attribute at all. A user authoring a malformed
  // single-stop gradient is better served by a missing fill that
  // surfaces in testing than by silent truncation at save.
  if (stops.length < 2) {
    return undefined;
  }

  // Parse angle from <a:lin ang="..."> — OOXML stores 60000ths of a
  // degree. The attribute is an xsd:int but we accept fractional
  // values too so libraries that emit millidegrees don't lose data.
  // `scaled` is a sibling boolean attribute on the same element; we
  // capture it only when authored so a default-scaled gradient doesn't
  // round-trip as an explicit `scaled="1"` (matching Excel's emission,
  // which omits the attribute when the implicit default applies).
  let angle: number | undefined;
  let scaled: boolean | undefined;
  let type: "linear" | "circle" | "rect" | "shape" | undefined;
  const linMatch = /<a:lin\b([^/>]*)\/?>/.exec(region);
  if (linMatch) {
    const linAttrs = linMatch[1];
    const angMatch = /\bang="(-?\d+(?:\.\d+)?)"/.exec(linAttrs);
    if (angMatch) {
      angle = parseFloat(angMatch[1]) / 60000;
    }
    const scaledMatch = /\bscaled="(1|true|0|false)"/.exec(linAttrs);
    if (scaledMatch) {
      scaled = scaledMatch[1] === "1" || scaledMatch[1] === "true";
    }
    type = "linear";
  }
  // Check for path gradient — `<a:path path="circle|rect|shape">`
  // optionally wrapping `<a:fillToRect l t r b/>` focal rectangle
  // (each component in hundredths of a percent).
  const pathMatch = /<a:path\s+path="([^"]+)"/.exec(region);
  let fillToRect: { left?: number; top?: number; right?: number; bottom?: number } | undefined;
  if (pathMatch) {
    type = pathMatch[1] as typeof type;
    const fillRectMatch = /<a:fillToRect\b([^/>]*)/.exec(region);
    if (fillRectMatch) {
      const attrs = fillRectMatch[1];
      const pick = (name: string): number | undefined => {
        const m = new RegExp(`\\b${name}="(-?\\d+(?:\\.\\d+)?)"`).exec(attrs);
        return m ? parseFloat(m[1]) / 100000 : undefined;
      };
      fillToRect = {
        left: pick("l"),
        top: pick("t"),
        right: pick("r"),
        bottom: pick("b")
      };
      // Drop the object entirely when every component is missing so we
      // don't carry an all-undefined placeholder through the model.
      if (
        fillToRect.left === undefined &&
        fillToRect.top === undefined &&
        fillToRect.right === undefined &&
        fillToRect.bottom === undefined
      ) {
        fillToRect = undefined;
      }
    }
  }

  return {
    gradient: {
      stops,
      angle,
      type,
      ...(scaled !== undefined ? { scaled } : {}),
      ...(fillToRect ? { fillToRect } : {})
    }
  };
}

function parsePatternFill(xml: string): ChartFill | undefined {
  const pattMatch = /<a:pattFill\s+prst="([^"]+)"/.exec(xml);
  if (!pattMatch) {
    return undefined;
  }
  const preset = pattMatch[1];
  const pattStart = pattMatch.index;
  const pattEnd = xml.indexOf("</a:pattFill", pattStart);
  const region = xml.slice(pattStart, pattEnd > 0 ? pattEnd + 15 : undefined);

  // Slice each colour region by pair-of-tags OR by the range from the
  // current open up to the next known child — matches what a real XML
  // parser would do, and doesn't over-read into the sibling colour
  // when the element happens to be self-closing.
  const sliceChildRegion = (open: string, close: string, stopBefore: string): string => {
    const start = region.indexOf(open);
    if (start < 0) {
      return "";
    }
    const end = region.indexOf(close, start);
    if (end >= 0) {
      return region.slice(start, end + close.length + 1);
    }
    // No close tag — element is self-closing or malformed. Stop at
    // the next recognised sibling child so the slice never walks into
    // the neighbouring colour block.
    const nextSibling = region.indexOf(stopBefore, start + open.length);
    return region.slice(start, nextSibling > 0 ? nextSibling : undefined);
  };

  const fgRegion = sliceChildRegion("<a:fgClr", "</a:fgClr", "<a:bgClr");
  const bgRegion = sliceChildRegion("<a:bgClr", "</a:bgClr", "<a:fgClr");
  const foreground = fgRegion ? parseColorFromXml(fgRegion) : undefined;
  const background = bgRegion ? parseColorFromXml(bgRegion) : undefined;

  return { pattern: { preset, foreground, background } };
}

/**
 * Remove the FIRST matching `<tag …>…</tag>` (or self-closing
 * `<tag …/>`) block from the input XML, returning the remainder. Used
 * by {@link parseSpPr} to isolate shape-level children (fill / effects)
 * from decorative children that nest inside `<a:ln>` — the line's own
 * `<a:solidFill>` / `<a:noFill/>` / `<a:gradFill>` should not be
 * harvested as the shape's fill.
 *
 * Strips ALL occurrences of `tag` (both self-closing and paired) in
 * one pass. A previous version returned after the earliest match,
 * which failed on inputs like `<a:ln/>…<a:ln>…</a:ln>` — the paired
 * block survived and its inner `<a:solidFill>` was then mistakenly
 * parsed as the shape's fill.
 *
 * Not a general-purpose XML tool — does not handle same-named nested
 * occurrences. Sufficient for DrawingML spPr, where `<a:ln>` never
 * nests another `<a:ln>`.
 */
function stripOuterElement(xml: string, tag: string): string {
  const selfCloseRe = new RegExp(`<${tag}\\b[^>]*/>`);
  const openRe = new RegExp(`<${tag}\\b[^>]*(?<!/)>`);
  const closeRe = new RegExp(`</${tag}>`);

  let current = xml;
  // Strip up to 8 occurrences. DrawingML spPr never has more than one
  // `<a:ln>`, so the loop normally exits after the first iteration;
  // the ceiling guards against pathological input causing infinite
  // loops without changing the happy path.
  for (let i = 0; i < 8; i++) {
    const selfCloseMatch = selfCloseRe.exec(current);
    const openMatch = openRe.exec(current);
    const selfCloseIndex = selfCloseMatch ? selfCloseMatch.index : Infinity;
    const openIndex = openMatch ? openMatch.index : Infinity;

    if (selfCloseIndex === Infinity && openIndex === Infinity) {
      break;
    }

    if (selfCloseIndex < openIndex && selfCloseMatch) {
      current =
        current.slice(0, selfCloseMatch.index) +
        current.slice(selfCloseMatch.index + selfCloseMatch[0].length);
      continue;
    }
    if (openMatch) {
      // Find the close tag that pairs with this open — start searching
      // after the open's end to avoid capturing `</tag>` that belongs
      // to a prior unrelated (e.g. self-closing lookalike) open.
      const openEnd = openMatch.index + openMatch[0].length;
      const closeMatch = closeRe.exec(current.slice(openEnd));
      if (!closeMatch) {
        // Malformed — stop stripping to avoid further mutation of
        // input we don't understand.
        break;
      }
      const closeStart = openEnd + closeMatch.index;
      const closeEnd = closeStart + closeMatch[0].length;
      current = current.slice(0, openMatch.index) + current.slice(closeEnd);
      continue;
    }
    break;
  }
  return current;
}

// ============================================================================
// spPr: Read structured properties from raw XML
// ============================================================================

/**
 * Extract structured fill and line properties from a raw spPr XML string.
 * Returns the structured ShapeProperties if extraction succeeds.
 */
export function parseSpPr(spPr: ShapeProperties): ShapeProperties {
  const rawXml = getRawXml(spPr);
  if (!rawXml) {
    return spPr; // already structured
  }

  const result: ShapeProperties = {};

  // The fill parser searches for `<a:solidFill>` at the top level — but
  // `<a:ln>…<a:solidFill>…</a:solidFill></a:ln>` is a common DrawingML
  // pattern where the line itself carries a solid colour. Previously
  // `rawXml.includes("<a:solidFill")` matched the line's inner fill,
  // picked up its colour as `result.fill.solid`, and the writer then
  // emitted a phantom `<a:solidFill>` as a shape fill — silently
  // painting the entire chart area with the border colour on re-save.
  // Excise any `<a:ln>…</a:ln>` block before searching for the shape
  // fill. The line block is parsed separately below, so nothing is
  // lost. Gradient / pattern / noFill have the same issue with respect
  // to `<a:ln>/<a:noFill/>`.
  const fillSearchXml = stripOuterElement(rawXml, "a:ln");

  // Parse fill
  //
  // The open/close tag search must be done defensively: `indexOf` on a
  // missing close tag returns `-1`, so the naïve
  // `fillSearchXml.slice(openIdx, fillSearchXml.indexOf("</a:solidFill") + 20)`
  // picks up position `19` as the upper bound — either truncating the
  // slice to garbage or producing an empty string. Both shapes
  // silently corrupted the fill parser when a `<a:solidFill/>` was
  // self-closed or when the close tag was missing.
  //
  // Prefer the open-tag-or-self-closing form, then only try to capture
  // a close tag when we've seen a proper open tag. If we do not find a
  // valid solid-fill region, fall through to the other fill branches
  // so a `<a:gradFill>` that coexists with a malformed solidFill still
  // gets picked up.
  let fillMatched = false;
  const solidFillSelfClose = /<a:solidFill\s*\/>/.exec(fillSearchXml);
  const solidFillOpenIdx = fillSearchXml.indexOf("<a:solidFill");
  const solidFillNonSelfClose = solidFillOpenIdx >= 0 && !solidFillSelfClose;
  if (solidFillNonSelfClose) {
    const closeIdx = fillSearchXml.indexOf("</a:solidFill>", solidFillOpenIdx);
    if (closeIdx >= 0) {
      const color = parseColorFromXml(
        fillSearchXml.slice(solidFillOpenIdx, closeIdx + "</a:solidFill>".length)
      );
      if (color) {
        result.fill = { solid: color };
        fillMatched = true;
      }
    }
    // else: malformed solidFill (no close tag) — fall through below.
  } else if (solidFillSelfClose) {
    // `<a:solidFill/>` has no child colour; DrawingML schema does not
    // allow this, but some legacy exports emit it. Treat as "unknown
    // fill, do not record" and fall through.
  }
  if (!fillMatched) {
    if (fillSearchXml.includes("<a:noFill")) {
      result.fill = { noFill: true };
    } else if (fillSearchXml.includes("<a:gradFill")) {
      result.fill = parseGradientFill(fillSearchXml);
    } else if (fillSearchXml.includes("<a:pattFill")) {
      result.fill = parsePatternFill(fillSearchXml);
    }
  }

  // Parse line
  //
  // Anchor the regex on a real `<a:ln ...>` / `<a:ln>` / `<a:ln/>` — the
  // lookahead `(?=[\s/>])` ensures we don't match a neighbouring element
  // like `<a:lnRef>` or `<a:lnB>` (both appear in DrawingML theme /
  // styleLst blocks) and silently walk the wrong region when extracting
  // the stroke colour. We then parse `w` / other attributes separately
  // from the captured opening-tag body — the old `(?:\s+w="(\d+)")?`
  // inline group only captured `w` when it was the FIRST attribute
  // after `<a:ln`, so `<a:ln cap="flat" w="12700">` silently dropped
  // the width.
  const lnMatch = /<a:ln(?=[\s/>])([^>]*)/.exec(rawXml);
  if (lnMatch) {
    // Distinguish `<a:ln/>` (self-closing, no body) from `<a:ln …>…</a:ln>`.
    // The greedy `[^>]*` in the regex captures everything up to (but not
    // including) the closing `>`. For `<a:ln w="12700"/>` the captured
    // group is ` w="12700"/` — the `/` is THE self-close marker. Earlier
    // code walked `rawXml[tokenEnd]` looking for `/`, but `tokenEnd` points
    // at `>`, not `/`, so `selfClosing` was always false and the parser
    // fell through to `indexOf("</a:ln", …)` (which returns -1 for a
    // self-closing tag). That made `lnRegion` span to the end of the
    // rawXml, causing the shape's own `<a:solidFill>` to be picked up as
    // the line colour. Detect self-close by inspecting what the regex
    // already captured — ignore trailing whitespace before the `/`.
    const selfClosing = /\/\s*$/.test(lnMatch[1]);
    const tokenEnd = lnMatch.index + lnMatch[0].length;
    // The match stopped at the byte BEFORE the closing `>`; advance one
    // character so the close-tag-aware slice below includes the `>`.
    const openTagEnd = tokenEnd + 1;
    // Use the full `</a:ln>` terminator (with the trailing `>`) instead
    // of the old `</a:ln` prefix — the prefix also matches `</a:lnRef>`
    // and `</a:lnB>` inside DrawingML styleLst blocks, which would
    // cause the region to stop short of the real line close.
    const lnEnd = selfClosing ? -1 : rawXml.indexOf("</a:ln>", lnMatch.index);
    const lnRegion = selfClosing
      ? rawXml.slice(lnMatch.index, openTagEnd)
      : lnEnd >= 0
        ? rawXml.slice(lnMatch.index, lnEnd + "</a:ln>".length)
        : // Malformed (open tag with no matching close) — clip to the
          // open tag only so we don't walk into unrelated XML. Previous
          // behaviour sliced to `undefined` (rest of the document), which
          // was the root of this bug.
          rawXml.slice(lnMatch.index, openTagEnd);

    const line: ChartLine = {};
    const widthMatch = /\bw="(\d+)"/.exec(lnMatch[1]);
    if (widthMatch) {
      line.width = parseInt(widthMatch[1], 10);
    }
    if (lnRegion.includes("<a:noFill")) {
      line.noFill = true;
    } else if (lnRegion.includes("<a:solidFill")) {
      // Scope the colour search to the `<a:solidFill>` body so a line
      // that also carries a gradient / pattern fill (rare but legal —
      // `<a:ln><a:gradFill>…</a:gradFill></a:ln>`) doesn't pollute
      // `parseColorFromXml` with the gradient's first stop colour. The
      // previous code passed the whole `lnRegion` — if the line had
      // both fills `parseColorFromXml` picked up whichever colour it
      // found first in document order, silently mis-rendering the
      // line. For pure-solid lines the result is identical.
      const solidFillMatch = /<a:solidFill>([\s\S]*?)<\/a:solidFill>/.exec(lnRegion);
      line.color = parseColorFromXml(solidFillMatch ? solidFillMatch[1] : lnRegion);
    }
    const dashMatch = /<a:prstDash\s+val="([^"]+)"/.exec(lnRegion);
    if (dashMatch) {
      line.dash = dashMatch[1] as ChartLine["dash"];
    }
    result.line = line;
  }

  // Parse effect list
  if (rawXml.includes("<a:effectLst") || rawXml.includes("<a:effectDag")) {
    const effects = parseEffectList(rawXml);
    if (effects) {
      result.effectList = effects;
    }
  }

  // Parse 3D scene and shape properties
  if (rawXml.includes("<a:scene3d")) {
    const scene = parseScene3D(rawXml);
    if (scene) {
      result.scene3d = scene;
    }
  }
  if (rawXml.includes("<a:sp3d")) {
    const sp3d = parseSp3D(rawXml);
    if (sp3d) {
      result.sp3d = sp3d;
    }
  }

  // Transform (`a:xfrm`) — position, size, rotation, flips. The regex
  // approach is a deliberate trade-off: a full XML walk would be more
  // robust but also ~4x the code for a field Excel writes in a very
  // constrained shape. If Excel ever nests `a:xfrm` with variants the
  // round-trip raw-XML path still carries them.
  if (rawXml.includes("<a:xfrm")) {
    const transform = parseXfrm(rawXml);
    if (transform) {
      result.transform = transform;
    }
  }

  if (rawXml.includes("<a:prstGeom")) {
    const prst = parsePrstGeom(rawXml);
    if (prst) {
      result.presetGeometry = prst;
    }
  }

  if (rawXml.includes("<a:custGeom")) {
    const cust = parseCustGeom(rawXml);
    if (cust) {
      result.customGeometry = cust;
    }
  }

  return result;
}

// ============================================================================
// Effect list parsing
// ============================================================================

// ============================================================================

/**
 * Parse a single `<a:xfrm>` element out of the shape-properties raw
 * XML blob. Returns `undefined` when the element is absent so callers
 * can simply drop the result into a structural field.
 *
 * Shape: `<a:xfrm rot="…" flipH="1" flipV="1"><a:off x="…" y="…"/><a:ext cx="…" cy="…"/></a:xfrm>`.
 * All five attributes and both children are optional; Excel omits
 * `a:off`/`a:ext` when a shape inherits its parent's automatic
 * layout.
 */
function parseXfrm(xml: string): ShapeTransform | undefined {
  const match = /<a:xfrm\b([^>]*)(?:\/>|>([\s\S]*?)<\/a:xfrm>)/.exec(xml);
  if (!match) {
    return undefined;
  }
  const attrs = match[1] ?? "";
  const inner = match[2] ?? "";
  const result: ShapeTransform = {};
  const rotAttr = /\brot="(-?\d+)"/.exec(attrs);
  if (rotAttr) {
    result.rotation = parseInt(rotAttr[1], 10);
  }
  if (/\bflipH="1"/.test(attrs)) {
    result.flipHorizontal = true;
  }
  if (/\bflipV="1"/.test(attrs)) {
    result.flipVertical = true;
  }
  const off = /<a:off\b([^/>]*)\/>/.exec(inner);
  if (off) {
    const x = /\bx="(-?\d+)"/.exec(off[1]);
    const y = /\by="(-?\d+)"/.exec(off[1]);
    if (x) {
      result.offsetX = parseInt(x[1], 10);
    }
    if (y) {
      result.offsetY = parseInt(y[1], 10);
    }
  }
  const ext = /<a:ext\b([^/>]*)\/>/.exec(inner);
  if (ext) {
    const cx = /\bcx="(\d+)"/.exec(ext[1]);
    const cy = /\bcy="(\d+)"/.exec(ext[1]);
    if (cx) {
      result.width = parseInt(cx[1], 10);
    }
    if (cy) {
      result.height = parseInt(cy[1], 10);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse `<a:prstGeom prst="…"><a:avLst>…</a:avLst></a:prstGeom>`.
 * The `preset` name is mandatory; `adjustments` come from the
 * optional `<a:avLst>` container whose children are `<a:gd name fmla>`
 * triples. We read the raw `fmla` strings because they're a small
 * OOXML sub-language (`"val 10000"` etc.) that callers rarely edit
 * and would need a dedicated parser to structure further.
 */
function parsePrstGeom(xml: string): PresetGeometry | undefined {
  const match = /<a:prstGeom\b([^>]*)(?:\/>|>([\s\S]*?)<\/a:prstGeom>)/.exec(xml);
  if (!match) {
    return undefined;
  }
  const attrs = match[1] ?? "";
  const inner = match[2] ?? "";
  const prstMatch = /\bprst="([^"]+)"/.exec(attrs);
  if (!prstMatch) {
    return undefined;
  }
  const result: PresetGeometry = { preset: prstMatch[1] };
  const adjustments = parseAdjustmentList(inner);
  if (adjustments.length > 0) {
    result.adjustments = adjustments;
  }
  return result;
}

/**
 * Parse `<a:custGeom>` into a {@link CustomGeometry}. The path-data
 * parser is the focal effort: `<a:pathLst><a:path w h fill stroke>…</a:path></a:pathLst>`
 * children enumerate moveTo / lnTo / arcTo / cubicBezTo / quadBezTo /
 * close commands in OOXML's drawing-language flavour.
 */
function parseCustGeom(xml: string): CustomGeometry | undefined {
  const match = /<a:custGeom\b[^>]*>([\s\S]*?)<\/a:custGeom>/.exec(xml);
  if (!match) {
    return undefined;
  }
  const body = match[1];
  const result: CustomGeometry = {};
  const adjustments = parseAdjustmentList(body);
  if (adjustments.length > 0) {
    result.adjustments = adjustments;
  }
  const paths: CustomGeometryPath[] = [];
  const pathRe = /<a:path\b([^>]*)>([\s\S]*?)<\/a:path>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pathRe.exec(body)) !== null) {
    const pAttrs = pm[1] ?? "";
    const pBody = pm[2] ?? "";
    const path: CustomGeometryPath = { commands: [] };
    const wMatch = /\bw="(\d+)"/.exec(pAttrs);
    const hMatch = /\bh="(\d+)"/.exec(pAttrs);
    if (wMatch) {
      path.w = parseInt(wMatch[1], 10);
    }
    if (hMatch) {
      path.h = parseInt(hMatch[1], 10);
    }
    const fillMatch = /\bfill="([^"]+)"/.exec(pAttrs);
    if (fillMatch) {
      path.fill = fillMatch[1] as CustomGeometryPath["fill"];
    }
    if (/\bstroke="1"/.test(pAttrs)) {
      path.stroke = true;
    } else if (/\bstroke="0"/.test(pAttrs)) {
      path.stroke = false;
    }
    path.commands = parseCustGeomCommands(pBody);
    paths.push(path);
  }
  if (paths.length > 0) {
    result.paths = paths;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseAdjustmentList(xml: string): Array<{ name: string; fmla: string }> {
  const avMatch = /<a:avLst\b[^>]*>([\s\S]*?)<\/a:avLst>/.exec(xml);
  if (!avMatch) {
    return [];
  }
  const out: Array<{ name: string; fmla: string }> = [];
  const gdRe = /<a:gd\b[^>]*\bname="([^"]+)"[^>]*\bfmla="([^"]+)"[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = gdRe.exec(avMatch[1])) !== null) {
    out.push({ name: m[1], fmla: m[2] });
  }
  return out;
}

function parseCustGeomCommands(body: string): CustomGeometryCommand[] {
  const commands: CustomGeometryCommand[] = [];
  // Walk commands in order — each `<a:moveTo>`/`<a:lnTo>`/… carries
  // one or two `<a:pt x y>` children; `<a:arcTo>` carries explicit
  // attributes instead. A greedy regex + lookahead captures the
  // command block including the closing tag.
  const cmdRe =
    /<a:(moveTo|lnTo|cubicBezTo|quadBezTo|arcTo|close)\b([^/>]*)(?:\/>|>([\s\S]*?)<\/a:\1>)/g;
  let cm: RegExpExecArray | null;
  while ((cm = cmdRe.exec(body)) !== null) {
    const kind = cm[1] as CustomGeometryCommand["type"];
    const cmdAttrs = cm[2] ?? "";
    const cmdBody = cm[3] ?? "";
    if (kind === "close") {
      commands.push({ type: "close" });
      continue;
    }
    if (kind === "arcTo") {
      const wR = /\bwR="(-?\d+)"/.exec(cmdAttrs)?.[1];
      const hR = /\bhR="(-?\d+)"/.exec(cmdAttrs)?.[1];
      const stAng = /\bstAng="(-?\d+)"/.exec(cmdAttrs)?.[1];
      const swAng = /\bswAng="(-?\d+)"/.exec(cmdAttrs)?.[1];
      if (wR && hR && stAng && swAng) {
        commands.push({
          type: "arcTo",
          arcParams: {
            wR: parseInt(wR, 10),
            hR: parseInt(hR, 10),
            stAng: parseInt(stAng, 10),
            swAng: parseInt(swAng, 10)
          }
        });
      }
      continue;
    }
    const points: Array<{ x: number; y: number }> = [];
    // Parse `<a:pt x="…" y="…"/>` without requiring a specific
    // attribute order — some authors / writers emit
    // `<a:pt y="100" x="200"/>` or interleave other attributes between
    // `x` and `y`. The previous regex required `x` first, then only
    // whitespace, then `y`, silently dropping all points on a
    // legitimately-authored geometry that used the reversed order.
    const ptRe = /<a:pt\b([^/>]*)\/>/g;
    let pt: RegExpExecArray | null;
    while ((pt = ptRe.exec(cmdBody)) !== null) {
      const attrs = pt[1];
      const xAttr = /\bx="(-?\d+)"/.exec(attrs);
      const yAttr = /\by="(-?\d+)"/.exec(attrs);
      if (xAttr && yAttr) {
        points.push({ x: parseInt(xAttr[1], 10), y: parseInt(yAttr[1], 10) });
      }
    }
    commands.push({ type: kind, points });
  }
  return commands;
}

function parseEffectList(xml: string): EffectList | undefined {
  const effStart = xml.indexOf("<a:effectLst");
  const effEnd = xml.indexOf("</a:effectLst");
  if (effStart < 0 || effEnd < 0) {
    return undefined;
  }
  const region = xml.slice(effStart, effEnd + "</a:effectLst>".length);
  const result: EffectList = {};

  // Blur
  const blurMatch = /<a:blur(\s+[^/>]*)?\s*\/>/.exec(region);
  if (blurMatch) {
    const attrs = parseAttrs(blurMatch[0]);
    result.blur = {};
    if (attrs.rad) {
      result.blur.radius = parseInt(attrs.rad, 10);
    }
    if (attrs.grow === "1") {
      result.blur.grow = true;
    }
  }

  // Outer shadow
  const outerShadow = parseShadowElement(region, "a:outerShdw");
  if (outerShadow) {
    result.outerShadow = outerShadow;
  }

  // Inner shadow
  const innerShadow = parseShadowElement(region, "a:innerShdw");
  if (innerShadow) {
    result.innerShadow = innerShadow;
  }

  // Preset shadow
  const prstMatch = /<a:prstShdw\s+([^>]*)>([\s\S]*?)<\/a:prstShdw>/.exec(region);
  if (prstMatch) {
    const attrs = parseAttrs(prstMatch[0]);
    const color = parseColorFromXml(prstMatch[2]);
    if (attrs.prst && color) {
      result.presetShadow = { preset: attrs.prst, color };
      if (attrs.dist) {
        result.presetShadow.distance = parseInt(attrs.dist, 10);
      }
      if (attrs.dir) {
        result.presetShadow.direction = parseInt(attrs.dir, 10);
      }
    }
  }

  // Glow
  const glowMatch = /<a:glow\s+([^>]*)>([\s\S]*?)<\/a:glow>/.exec(region);
  if (glowMatch) {
    const attrs = parseAttrs(glowMatch[0]);
    const color = parseColorFromXml(glowMatch[2]);
    if (attrs.rad && color) {
      result.glow = { radius: parseInt(attrs.rad, 10), color };
    }
  }

  // Soft edge
  const softEdgeMatch = /<a:softEdge\s+([^/>]*)\s*\/>/.exec(region);
  if (softEdgeMatch) {
    const attrs = parseAttrs(softEdgeMatch[0]);
    if (attrs.rad) {
      result.softEdge = { radius: parseInt(attrs.rad, 10) };
    }
  }

  // Reflection
  const reflMatch = /<a:reflection\s+([^/>]*)\s*\/>/.exec(region);
  if (reflMatch) {
    const attrs = parseAttrs(reflMatch[0]);
    const r: NonNullable<EffectList["reflection"]> = {};
    if (attrs.blurRad) {
      r.blurRadius = parseInt(attrs.blurRad, 10);
    }
    if (attrs.stA) {
      r.startOpacity = parseInt(attrs.stA, 10);
    }
    if (attrs.stPos) {
      r.startPosition = parseInt(attrs.stPos, 10);
    }
    if (attrs.endA) {
      r.endOpacity = parseInt(attrs.endA, 10);
    }
    if (attrs.endPos) {
      r.endPosition = parseInt(attrs.endPos, 10);
    }
    if (attrs.dist) {
      r.distance = parseInt(attrs.dist, 10);
    }
    if (attrs.dir) {
      r.direction = parseInt(attrs.dir, 10);
    }
    if (attrs.fadeDir) {
      r.fadeDirection = parseInt(attrs.fadeDir, 10);
    }
    if (attrs.sx) {
      r.scaleHorizontal = parseInt(attrs.sx, 10);
    }
    if (attrs.sy) {
      r.scaleVertical = parseInt(attrs.sy, 10);
    }
    if (attrs.kx) {
      r.skewHorizontal = parseInt(attrs.kx, 10);
    }
    if (attrs.ky) {
      r.skewVertical = parseInt(attrs.ky, 10);
    }
    if (attrs.algn) {
      r.alignment = attrs.algn as NonNullable<typeof r.alignment>;
    }
    if (attrs.rotWithShape === "1") {
      r.rotateWithShape = true;
    }
    result.reflection = r;
  }

  if (Object.keys(result).length === 0) {
    return undefined;
  }
  return result;
}

function parseShadowElement(xml: string, tag: string): Shadow | undefined {
  const re = SHADOW_RES[tag] ?? new RegExp(`<${tag}\\s+([^>]*)>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(xml);
  if (!m) {
    return undefined;
  }
  const attrs = parseAttrs(m[0]);
  const color = parseColorFromXml(m[2]);
  if (!color) {
    return undefined;
  }
  const shadow: Shadow = { color };
  if (attrs.blurRad) {
    shadow.blurRadius = parseInt(attrs.blurRad, 10);
  }
  if (attrs.dist) {
    shadow.distance = parseInt(attrs.dist, 10);
  }
  if (attrs.dir) {
    shadow.direction = parseInt(attrs.dir, 10);
  }
  if (attrs.algn) {
    shadow.alignment = attrs.algn as NonNullable<typeof shadow.alignment>;
  }
  if (attrs.rotWithShape === "1") {
    shadow.rotateWithShape = true;
  }
  if (attrs.sx) {
    shadow.scaleHorizontal = parseInt(attrs.sx, 10);
  }
  if (attrs.sy) {
    shadow.scaleVertical = parseInt(attrs.sy, 10);
  }
  if (attrs.kx) {
    shadow.skewHorizontal = parseInt(attrs.kx, 10);
  }
  if (attrs.ky) {
    shadow.skewVertical = parseInt(attrs.ky, 10);
  }
  return shadow;
}

function parseScene3D(xml: string): Scene3D | undefined {
  const sceneStart = xml.indexOf("<a:scene3d");
  const sceneEnd = xml.indexOf("</a:scene3d");
  if (sceneStart < 0 || sceneEnd < 0) {
    return undefined;
  }
  const region = xml.slice(sceneStart, sceneEnd + 13);
  const result: Scene3D = {};

  const cameraMatch = /<a:camera\s+([^>]*)(?:\/|>[\s\S]*?<\/a:camera)>/.exec(region);
  if (cameraMatch) {
    const attrs = parseAttrs(cameraMatch[0]);
    if (attrs.prst) {
      result.camera = { preset: attrs.prst };
      if (attrs.fov) {
        result.camera.fov = parseInt(attrs.fov, 10);
      }
      if (attrs.zoom) {
        result.camera.zoom = parseInt(attrs.zoom, 10);
      }
      const rotMatch = /<a:rot\s+([^/>]*)\s*\/>/.exec(cameraMatch[0]);
      if (rotMatch) {
        const ra = parseAttrs(rotMatch[0]);
        if (ra.lat && ra.lon && ra.rev) {
          result.camera.rotation = {
            lat: parseInt(ra.lat, 10),
            lon: parseInt(ra.lon, 10),
            rev: parseInt(ra.rev, 10)
          };
        }
      }
    }
  }
  const lightRigMatch = /<a:lightRig\s+([^>]*)(?:\/|>[\s\S]*?<\/a:lightRig)>/.exec(region);
  if (lightRigMatch) {
    const attrs = parseAttrs(lightRigMatch[0]);
    if (attrs.rig && attrs.dir) {
      result.lightRig = { rig: attrs.rig, direction: attrs.dir };
    }
  }
  if (!result.camera && !result.lightRig) {
    return undefined;
  }
  return result;
}

function parseSp3D(xml: string): ShapeProperties3D | undefined {
  const spStart = xml.indexOf("<a:sp3d");
  if (spStart < 0) {
    return undefined;
  }
  // Determine the tag extent using indexOf (no backtracking risk).
  const selfCloseEnd = xml.indexOf("/>", spStart);
  const openTagEnd = xml.indexOf(">", spStart);
  const isSelfClose = selfCloseEnd >= 0 && (openTagEnd < 0 || selfCloseEnd < openTagEnd);
  let region: string;
  if (isSelfClose) {
    region = xml.slice(spStart, selfCloseEnd + 2);
  } else if (openTagEnd >= 0) {
    const closeTag = "</a:sp3d>";
    const closeIdx = xml.indexOf(closeTag, openTagEnd);
    region =
      closeIdx >= 0
        ? xml.slice(spStart, closeIdx + closeTag.length)
        : xml.slice(spStart, openTagEnd + 1);
  } else {
    region = xml.slice(spStart);
  }

  // Only parse attributes from the opening tag itself — NOT from child
  // elements (e.g. `<a:bevelT w="..." h="..."/>`) which would pollute
  // the attribute dict with unrelated keys.
  const firstClose = region.indexOf(">");
  const openTag = firstClose >= 0 ? region.slice(0, firstClose + 1) : region;
  const attrs = parseAttrs(openTag);
  const result: ShapeProperties3D = {};
  if (attrs.z) {
    result.z = parseInt(attrs.z, 10);
  }
  if (attrs.extrusionH) {
    result.extrusionHeight = parseInt(attrs.extrusionH, 10);
  }
  if (attrs.contourW) {
    result.contourWidth = parseInt(attrs.contourW, 10);
  }
  if (attrs.prstMaterial) {
    result.material = attrs.prstMaterial;
  }
  // Bevels — use indexOf to find the self-closing tags within the region
  const bevelTStart = region.indexOf("<a:bevelT");
  if (bevelTStart >= 0) {
    const bevelTEnd = region.indexOf("/>", bevelTStart);
    if (bevelTEnd >= 0) {
      result.bevelTop = parseBevelAttrs(region.slice(bevelTStart, bevelTEnd + 2));
    }
  }
  const bevelBStart = region.indexOf("<a:bevelB");
  if (bevelBStart >= 0) {
    const bevelBEnd = region.indexOf("/>", bevelBStart);
    if (bevelBEnd >= 0) {
      result.bevelBottom = parseBevelAttrs(region.slice(bevelBStart, bevelBEnd + 2));
    }
  }
  // Extrusion / contour colours — only present in open-close form
  if (!isSelfClose) {
    const extOpen = "<a:extrusionClr>";
    const extClose = "</a:extrusionClr>";
    const extStart = region.indexOf(extOpen);
    if (extStart >= 0) {
      const extEnd = region.indexOf(extClose, extStart);
      if (extEnd >= 0) {
        const c = parseColorFromXml(region.slice(extStart + extOpen.length, extEnd));
        if (c) {
          result.extrusionColor = c;
        }
      }
    }
    const contOpen = "<a:contourClr>";
    const contClose = "</a:contourClr>";
    const contStart = region.indexOf(contOpen);
    if (contStart >= 0) {
      const contEnd = region.indexOf(contClose, contStart);
      if (contEnd >= 0) {
        const c = parseColorFromXml(region.slice(contStart + contOpen.length, contEnd));
        if (c) {
          result.contourColor = c;
        }
      }
    }
  }
  return result;
}

function parseBevelAttrs(tag: string): Bevel {
  const attrs = parseAttrs(tag);
  const bevel: Bevel = {};
  if (attrs.w) {
    bevel.width = parseInt(attrs.w, 10);
  }
  if (attrs.h) {
    bevel.height = parseInt(attrs.h, 10);
  }
  if (attrs.prst) {
    bevel.preset = attrs.prst;
  }
  return bevel;
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Manual parser avoids regex backtracking on uncontrolled input.
  let i = 0;
  const len = tag.length;
  while (i < len) {
    // Skip non-word characters
    while (i < len && !isWordChar(tag.charCodeAt(i))) {
      i++;
    }
    if (i >= len) {
      break;
    }
    // Read attribute name (word chars only)
    const nameStart = i;
    while (i < len && isWordChar(tag.charCodeAt(i))) {
      i++;
    }
    const name = tag.slice(nameStart, i);
    // Expect `="`
    if (i >= len || tag.charCodeAt(i) !== 61 /* = */) {
      continue;
    }
    i++;
    if (i >= len || tag.charCodeAt(i) !== 34 /* " */) {
      continue;
    }
    i++;
    // Read attribute value until closing quote
    const valStart = i;
    while (i < len && tag.charCodeAt(i) !== 34) {
      i++;
    }
    attrs[name] = tag.slice(valStart, i);
    if (i < len) {
      i++; // skip closing quote
    }
  }
  return attrs;
}

/** Check if a char code is a word character [A-Za-z0-9_]. */
function isWordChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    (c >= 48 && c <= 57) || // 0-9
    c === 95 // _
  );
}

/**
 * Extract a single attribute value from the first occurrence of `<tagName ...>`
 * in `xml`. Uses indexOf to locate the tag (no backtracking risk) then a simple
 * attribute regex on the bounded tag substring.
 */
function findTagAttr(xml: string, tagName: string, attrName: string): string | undefined {
  const tagStart = xml.indexOf(`<${tagName}`);
  if (tagStart < 0) {
    return undefined;
  }
  const tagEnd = xml.indexOf(">", tagStart);
  if (tagEnd < 0) {
    return undefined;
  }
  const tag = xml.slice(tagStart, tagEnd + 1);
  const re = new RegExp(`${attrName}="([^"]*)"`);
  const m = re.exec(tag);
  return m ? m[1] : undefined;
}

/**
 * Get the solid fill color from a ShapeProperties object.
 * Works for both raw XML and structured models.
 */
export function getSpPrFillColor(spPr: ShapeProperties): ChartColor | undefined {
  const parsed = isRawXml(spPr) ? parseSpPr(spPr) : spPr;
  return parsed.fill?.solid;
}

/**
 * Get the complete fill (solid / gradient / pattern / noFill) from a
 * ShapeProperties object. Works for both raw XML and structured models.
 * Prefer this over {@link getSpPrFillColor} when the caller needs to
 * distinguish between "no fill", "gradient", etc. — the color-only
 * accessor collapses all three to `undefined`.
 */
export function getSpPrFill(spPr: ShapeProperties): ChartFill | undefined {
  const parsed = isRawXml(spPr) ? parseSpPr(spPr) : spPr;
  return parsed.fill;
}

/**
 * Get the line/outline properties from a ShapeProperties object.
 */
export function getSpPrLine(spPr: ShapeProperties): ChartLine | undefined {
  const parsed = isRawXml(spPr) ? parseSpPr(spPr) : spPr;
  return parsed.line;
}

/**
 * Get the gradient fill from a ShapeProperties object.
 */
export function getSpPrGradient(spPr: ShapeProperties): ChartFill["gradient"] | undefined {
  const parsed = isRawXml(spPr) ? parseSpPr(spPr) : spPr;
  return parsed.fill?.gradient;
}

/**
 * Get the pattern fill from a ShapeProperties object.
 */
export function getSpPrPattern(spPr: ShapeProperties): ChartFill["pattern"] | undefined {
  const parsed = isRawXml(spPr) ? parseSpPr(spPr) : spPr;
  return parsed.fill?.pattern;
}

// ============================================================================
// txPr: Read structured properties from raw XML
// ============================================================================

/**
 * Extract structured text properties from a raw txPr XML string.
 *
 * Parses the fields the structured {@link ChartTextProperties} model
 * declares:
 *   - `size`, `bold`, `italic`, `underline`, `strike`, `cap`, `baseline`,
 *     `kern`, `spacing`, `lang` (from the first `<a:defRPr>` / `<a:rPr>`)
 *   - `color` (from `<a:solidFill>` inside the same element)
 *   - `fontFamily`, `eastAsianFamily`, `complexScriptFamily`
 *     (from `<a:latin>` / `<a:ea>` / `<a:cs>` children)
 *   - `rotation` (from `<a:bodyPr/@rot>`)
 *
 * Callers that want to preserve every attribute OOXML might carry
 * (e.g. `spc="100"`, `u="sng"`, `baseline="30000"`) must not rely on
 * this function round-tripping via structured fields alone — keep the
 * `_rawXml` on the txPr. This parser is a best-effort structural view
 * for consumers that want to READ the common properties; `_rawXml`
 * remains authoritative for write-side fidelity.
 */
export function parseTxPr(txPr: ChartTextProperties): ChartTextProperties {
  const rawXml = getRawXml(txPr);
  if (!rawXml) {
    return txPr; // already structured
  }

  const result: ChartTextProperties = {};

  // Font size (a:sz) — search defRPr first, then rPr
  const szVal = findTagAttr(rawXml, "a:defRPr", "sz") ?? findTagAttr(rawXml, "a:rPr", "sz");
  if (szVal) {
    result.size = parseInt(szVal, 10);
  }

  // Bold — accept `"1"` / `"true"` per XSD `xsd:boolean`. Previously
  // only `"1"` was recognised, so LibreOffice-authored files (which
  // emit `b="true"`) silently round-tripped bold text as regular.
  // An explicit `b="0"` / `b="false"` is preserved as `false` rather
  // than dropped — semantically distinct from the attribute being
  // absent (which leaves the field undefined so downstream writers
  // know not to force a value).
  const bVal = findTagAttr(rawXml, "a:defRPr", "b") ?? findTagAttr(rawXml, "a:rPr", "b");
  if (bVal) {
    result.bold = bVal === "1" || bVal === "true";
  }

  // Italic — same lenient boolean handling as `b` above.
  const iVal = findTagAttr(rawXml, "a:defRPr", "i") ?? findTagAttr(rawXml, "a:rPr", "i");
  if (iVal) {
    result.italic = iVal === "1" || iVal === "true";
  }

  // Underline style (a:rPr/@u). Values are the DrawingML `ST_TextUnderlineType`
  // enum: "none" | "sng" | "dbl" | "heavy" | "dotted" | "dottedHeavy" |
  // "dash" | "dashHeavy" | "dashLong" | "dashLongHeavy" | "dotDash" |
  // "dotDashHeavy" | "dotDotDash" | "dotDotDashHeavy" | "wavy" |
  // "wavyHeavy" | "wavyDbl".
  const uVal = findTagAttr(rawXml, "a:defRPr", "u") ?? findTagAttr(rawXml, "a:rPr", "u");
  if (uVal) {
    result.underline = uVal as ChartTextProperties["underline"];
  }

  // Strike-through (a:rPr/@strike). Values: "noStrike" | "sngStrike" |
  // "dblStrike".
  const strikeVal =
    findTagAttr(rawXml, "a:defRPr", "strike") ?? findTagAttr(rawXml, "a:rPr", "strike");
  if (strikeVal) {
    result.strike = strikeVal as ChartTextProperties["strike"];
  }

  // Capitalisation (a:rPr/@cap). Values: "none" | "small" | "all".
  const capVal = findTagAttr(rawXml, "a:defRPr", "cap") ?? findTagAttr(rawXml, "a:rPr", "cap");
  if (capVal) {
    result.cap = capVal as ChartTextProperties["cap"];
  }

  // Baseline offset (a:rPr/@baseline) — percentage * 1000 per OOXML
  // (signed; positive = superscript, negative = subscript).
  const baselineVal =
    findTagAttr(rawXml, "a:defRPr", "baseline") ?? findTagAttr(rawXml, "a:rPr", "baseline");
  if (baselineVal) {
    result.baseline = parseInt(baselineVal, 10);
  }

  // Character kerning cut-off (a:rPr/@kern) — hundredths of a point.
  const kernVal = findTagAttr(rawXml, "a:defRPr", "kern") ?? findTagAttr(rawXml, "a:rPr", "kern");
  if (kernVal) {
    result.kern = parseInt(kernVal, 10);
  }

  // Character spacing (a:rPr/@spc) — hundredths of a point.
  const spcVal = findTagAttr(rawXml, "a:defRPr", "spc") ?? findTagAttr(rawXml, "a:rPr", "spc");
  if (spcVal) {
    result.spacing = parseInt(spcVal, 10);
  }

  // Language (a:rPr/@lang) — BCP 47 language tag (e.g. "en-US", "ja-JP").
  // Wider character class than `\w+` because tags can include hyphens
  // and digits ("zh-Hant-TW").
  const langVal = findTagAttr(rawXml, "a:defRPr", "lang") ?? findTagAttr(rawXml, "a:rPr", "lang");
  if (langVal) {
    result.lang = langVal;
  }

  // Font color. Try the paragraph-level default (`<a:defRPr>…`) first,
  // then fall back to the first run-property block (`<a:rPr>…`). Chart
  // titles / data-label rich text often carry colour on `<a:rPr>` (per
  // run), not on `<a:defRPr>` — the old implementation only checked the
  // former and silently dropped colour on round-trip.
  const extractColorFrom = (openTag: string, closeTag: string): ChartColor | undefined => {
    const start = rawXml.indexOf(openTag);
    if (start < 0) {
      return undefined;
    }
    const end = rawXml.indexOf(closeTag, start);
    const region = rawXml.slice(start, end > 0 ? end + closeTag.length : undefined);
    if (!region.includes("<a:solidFill")) {
      return undefined;
    }
    return parseColorFromXml(region);
  };
  result.color =
    extractColorFrom("<a:defRPr", "</a:defRPr>") ?? extractColorFrom("<a:rPr", "</a:rPr>");

  // Latin font family (a:latin/@typeface) — structured default.
  const latinMatch = /<a:latin\s+typeface="([^"]+)"/.exec(rawXml);
  if (latinMatch) {
    result.fontFamily = latinMatch[1];
  }

  // East Asian font family (a:ea/@typeface) — used for CJK characters
  // when the primary Latin font doesn't cover them. Dropping this
  // field on round-trip made CJK-labelled charts reflow on reload.
  const eaMatch = /<a:ea\s+typeface="([^"]+)"/.exec(rawXml);
  if (eaMatch) {
    result.eastAsianFamily = eaMatch[1];
  }

  // Complex-script font family (a:cs/@typeface) — used for Arabic /
  // Hebrew / Thai fallbacks.
  const csMatch = /<a:cs\s+typeface="([^"]+)"/.exec(rawXml);
  if (csMatch) {
    result.complexScriptFamily = csMatch[1];
  }

  // Rotation (on bodyPr)
  const rotVal = findTagAttr(rawXml, "a:bodyPr", "rot");
  if (rotVal) {
    result.rotation = parseInt(rotVal, 10);
  }

  return result;
}

/**
 * Get font size from a ChartTextProperties object (returns points, e.g. 10).
 */
export function getTxPrFontSize(txPr: ChartTextProperties): number | undefined {
  const parsed = isRawXml(txPr) ? parseTxPr(txPr) : txPr;
  return parsed.size !== undefined ? parsed.size / 100 : undefined;
}

/**
 * Get font color from a ChartTextProperties object.
 */
export function getTxPrColor(txPr: ChartTextProperties): ChartColor | undefined {
  const parsed = isRawXml(txPr) ? parseTxPr(txPr) : txPr;
  return parsed.color;
}

// ============================================================================
// Build structured spPr / txPr models
// ============================================================================
//
// Previously this module also produced raw DrawingML XML for spPr / txPr via
// a `colorToXml` helper. That path was removed because the chart writer
// (`chart-space-xform._renderSpPr` / `_renderTxPr` / `_renderColor`) emits
// the XML directly from structured data, and returning raw XML here forced
// callers to rebuild `buildTxPr` after every mutation. The helper was dead
// code and has been deleted — see the note on `buildTxPr` below.

/**
 * Build a structured ShapeProperties object, preserving every field that
 * `parseSpPr` can produce (fill, line, effectList, scene3d, sp3d, transform,
 * presetGeometry, customGeometry, bwMode).
 *
 * Previous versions only copied a five-field subset, which caused
 * `setSpPrFill` / `setSpPrLine` to silently strip `xfrm` / `prstGeom` /
 * `custGeom` off the returned spPr whenever the input had been parsed from
 * raw XML. The earlier `_rawXml` round-trip path was dropped because it lost
 * effectList/scene3d/sp3d; we now keep all structured fields and intentionally
 * omit `_rawXml` so that `_renderSpPr` (chart-space-xform) re-emits the spPr
 * from the structured data.
 */
export function buildSpPr(props: ShapeProperties): ShapeProperties {
  const result: ShapeProperties = {};
  if (props.fill) {
    result.fill = props.fill;
  }
  if (props.line) {
    result.line = props.line;
  }
  if (props.effectList) {
    result.effectList = props.effectList;
  }
  if (props.scene3d) {
    result.scene3d = props.scene3d;
  }
  if (props.sp3d) {
    result.sp3d = props.sp3d;
  }
  if (props.transform) {
    result.transform = props.transform;
  }
  if (props.presetGeometry) {
    result.presetGeometry = props.presetGeometry;
  }
  if (props.customGeometry) {
    result.customGeometry = props.customGeometry;
  }
  return result;
}

/**
 * Build a structured {@link ChartTextProperties} object.
 *
 * Returns a plain structured copy (no `_rawXml`) so downstream mutations
 * (`props.size = 1400`) take effect when the txPr is later serialised.
 * The writer (`_renderTxPr` / `_renderRunProperties` in
 * `chart-space-xform.ts`) fully supports structured txPr data and only
 * falls back to raw XML pass-through when `_rawXml` is present; returning
 * `_rawXml` here would freeze the txPr and silently discard subsequent
 * edits, which is a trap API.
 */
export function buildTxPr(props: ChartTextProperties): ChartTextProperties {
  const result: ChartTextProperties = {};
  if (props.size !== undefined) {
    result.size = props.size;
  }
  if (props.bold !== undefined) {
    result.bold = props.bold;
  }
  if (props.italic !== undefined) {
    result.italic = props.italic;
  }
  if (props.underline !== undefined) {
    result.underline = props.underline;
  }
  if (props.strike !== undefined) {
    result.strike = props.strike;
  }
  if (props.rotation !== undefined) {
    result.rotation = props.rotation;
  }
  if (props.baseline !== undefined) {
    result.baseline = props.baseline;
  }
  if (props.kern !== undefined) {
    result.kern = props.kern;
  }
  if (props.spacing !== undefined) {
    result.spacing = props.spacing;
  }
  if (props.cap !== undefined) {
    result.cap = props.cap;
  }
  if (props.lang !== undefined) {
    result.lang = props.lang;
  }
  if (props.color) {
    result.color = props.color;
  }
  if (props.fontFamily) {
    result.fontFamily = props.fontFamily;
  }
  if (props.eastAsianFamily) {
    result.eastAsianFamily = props.eastAsianFamily;
  }
  if (props.complexScriptFamily) {
    result.complexScriptFamily = props.complexScriptFamily;
  }
  return result;
}

/**
 * Modify a property on an existing spPr (raw or structured).
 * Returns a new ShapeProperties object with the modification applied.
 */
export function setSpPrFill(spPr: ShapeProperties | undefined, fill: ChartFill): ShapeProperties {
  const parsed = spPr && isRawXml(spPr) ? parseSpPr(spPr) : (spPr ?? {});
  return buildSpPr({ ...parsed, fill });
}

/**
 * Modify line properties on an existing spPr.
 */
export function setSpPrLine(spPr: ShapeProperties | undefined, line: ChartLine): ShapeProperties {
  const parsed = spPr && isRawXml(spPr) ? parseSpPr(spPr) : (spPr ?? {});
  return buildSpPr({ ...parsed, line });
}
