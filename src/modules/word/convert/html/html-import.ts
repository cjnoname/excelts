/**
 * DOCX Module - HTML to DOCX Converter
 *
 * Converts an HTML string into DOCX document body content (paragraphs, tables, etc.).
 * Handles common HTML elements: p, h1-h6, strong, em, a, ul, ol, li, table, img, br, span.
 *
 * This is NOT a full HTML rendering engine — it covers the structural elements
 * that map cleanly to WordprocessingML concepts.
 *
 * @example
 * ```ts
 * import { htmlToDocxBody } from "documonster/word/html";
 * import { Document, Io } from "documonster/word";
 *
 * const body = htmlToDocxBody("<h1>Hello</h1><p>World</p>");
 * const h = Document.create();
 * for (const block of body) {
 *   Document.addContent(h, block);
 * }
 * const buffer = await Io.toBuffer(Document.build(h));
 * ```
 */

import { isEastAsianTypeface } from "@utils/cjk-typefaces";
import { base64ToUint8Array } from "@utils/utils";
import { sanitizeUrl } from "@word/core/internal-utils";
import type {
  BodyContent,
  Hyperlink,
  ImageDef,
  ImageMediaType,
  InlineImageContent,
  Paragraph,
  ParagraphChild,
  ParagraphProperties,
  Run,
  RunProperties,
  Table,
  TableBorders,
  TableCell,
  TableCellProperties,
  TableProperties,
  TableRow,
  TableWidth
} from "@word/types";
import { EMU_PER_PX } from "@word/units";

/** Options for HTML to DOCX conversion. */
export interface HtmlImportOptions {
  /** Default font size in half-points (default: 24 = 12pt). */
  readonly defaultFontSize?: number;
  /** Default font family. */
  readonly defaultFont?: string;
  /** Map of CSS class names to inline style strings. Matched classes are merged with element styles. */
  readonly classStyles?: Record<string, string>;
}

/**
 * Convert an HTML string into an array of DOCX body content blocks.
 *
 * Supported elements:
 * - Block: p, div, h1-h6, blockquote, pre, hr
 * - List: ul, ol, li
 * - Table: table, thead, tbody, tr, th, td (colspan, rowspan, border styles)
 * - Inline: strong/b, em/i, u, s/strike/del, a, br, span, sub, sup, code
 * - Images: img (base64 data URLs as InlineImageContent, http(s) as placeholder)
 * - Page break: div with style="page-break-before: always" or class="page-break"
 * - CSS inline styles: font-family, font-size, color, background-color, font-weight,
 *   font-style, text-decoration, text-align
 *
 * @param html - The HTML string to convert.
 * @param options - Optional conversion settings.
 * @returns Array of BodyContent blocks.
 */
export function htmlToDocxBody(html: string, options?: HtmlImportOptions): BodyContent[] {
  const blocks: BodyContent[] = [];
  const tokens = tokenize(html);
  // Extract <style> rules and merge with user-provided classStyles
  const extractedStyles = extractStyleRules(tokens);
  const classStyles = mergeClassStyles(extractedStyles, options?.classStyles ?? {});

  // Seed the inline context with the caller-supplied defaults so plain text
  // runs actually carry the requested font/size. Without this the options
  // were effectively ignored.
  const initialCtx: InlineContext = {};
  if (options?.defaultFont) {
    initialCtx.fontFamily = options.defaultFont;
  }
  if (options?.defaultFontSize !== undefined) {
    initialCtx.fontSize = options.defaultFontSize;
  }

  parseBlocks(tokens, 0, blocks, initialCtx, classStyles);
  return blocks;
}

/** Result of {@link htmlToDocx}: body content plus the images it references. */
export interface HtmlToDocxResult {
  /** Parsed body content blocks. */
  readonly body: BodyContent[];
  /**
   * Images decoded from base64 `data:` URLs in the HTML, each with a unique
   * rId already referenced by the matching image run in `body`. Merge these
   * into the document model's `images` array so the pictures are embedded as
   * real media in the package instead of dropped as placeholders.
   */
  readonly images: ImageDef[];
}

/**
 * Convert an HTML string into DOCX body content **and** embedded images.
 *
 * Unlike {@link htmlToDocxBody}, this decodes base64 `data:` image URLs into
 * real {@link ImageDef}s and assigns each a unique rId that the emitted image
 * runs reference. Merge the returned `images` into your document model so the
 * pictures are embedded rather than dropped as placeholders.
 *
 * @example
 * ```ts
 * const { body, images } = htmlToDocx(html);
 * const doc = Document.create();
 * for (const item of body) Document.addContent(doc, item);
 * const built = Document.build(doc);
 * const final = { ...built, images: [...(built.images ?? []), ...images] };
 * const bytes = await toBuffer(final);
 * ```
 */
export function htmlToDocx(html: string, options?: HtmlImportOptions): HtmlToDocxResult {
  const blocks: BodyContent[] = [];
  const tokens = tokenize(html);
  const extractedStyles = extractStyleRules(tokens);
  const classStyles = mergeClassStyles(extractedStyles, options?.classStyles ?? {});

  const images: ImageDef[] = [];
  const initialCtx: InlineContext = { imageSink: images };
  if (options?.defaultFont) {
    initialCtx.fontFamily = options.defaultFont;
  }
  if (options?.defaultFontSize !== undefined) {
    initialCtx.fontSize = options.defaultFontSize;
  }

  parseBlocks(tokens, 0, blocks, initialCtx, classStyles);
  return { body: blocks, images };
}

// =============================================================================
// Tokenizer (simple HTML → token stream)
// =============================================================================

interface TagToken {
  type: "open" | "close" | "selfclose";
  tag: string;
  attrs: Record<string, string>;
}
interface TextToken {
  type: "text";
  value: string;
}
type Token = TagToken | TextToken;

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  // Strip HTML comments, doctype declarations and SGML processing
  // instructions before tokenising — none of them should appear as text
  // in the document body. The previous regex treated `<!doctype html>`
  // as a text node containing `"!doctype html>"`.
  //
  // We use a single linear scan rather than chained `.replace()` calls so
  // we are immune to two CodeQL findings:
  //   - Incomplete multi-character sanitization: chained replaces let
  //     payloads such as `<!--<!--x-->-->` leak through (each pass only
  //     removes one layer, leaving `-->` behind).
  //   - Polynomial regular expression on uncontrolled data: lazy
  //     quantifiers like `<!--[\s\S]*?-->` exhibit catastrophic
  //     backtracking on adversarial input.
  const stripped = stripSgmlNoise(html);

  // The tokenizer is implemented as a linear index scan rather than a
  // global regex (`/<\/?…(?:\s+[^>]*?)?\/?\s*>|((?:[^<]|…)+)/g`). The
  // previous regex form combined an optional lazy attribute span with
  // an optional `\/?` and optional trailing whitespace, which CodeQL
  // flagged as polynomial-redos: an adversarial payload such as
  // `<a` followed by many spaces but no closing `>` triggered
  // catastrophic backtracking.
  //
  // The scan below is strictly O(n):
  //   - At every position we either advance one character or jump
  //     forward to the next `<` / `>` via a single `indexOf`.
  //   - Attribute parsing is delegated to `parseHtmlAttrs`, which is
  //     itself a linear scanner.
  const n = stripped.length;
  let i = 0;
  while (i < n) {
    // Scan a text run: everything up to the next position that begins
    // a tag (`<` followed by a letter, or `</` followed by a letter).
    // Bare `<` characters and unfinished tag-like fragments are kept
    // inside the text run so that input such as `1 < 2`, `a<b<c`,
    // `<<<<` or `<unfinished` (with no closing `>` anywhere) is not
    // shattered into a stream of single-character runs.
    if (stripped.charCodeAt(i) !== 0x3c /* '<' */ || !isTagStart(stripped, i)) {
      const textEnd = scanTextEnd(stripped, i);
      const raw = stripped.slice(i, textEnd);
      const text = decodeHtmlEntities(raw);
      if (text) {
        tokens.push({ type: "text", value: text });
      }
      i = textEnd;
      if (i >= n) {
        break;
      }
      // Fall through: position `i` is now at a real tag start.
    }

    // We are at '<' that introduces a tag (guaranteed by the
    // `isTagStart` check above).
    const next = stripped.charCodeAt(i + 1);
    const isClose = next === 0x2f; /* '/' */
    const nameStart = isClose ? i + 2 : i + 1;
    // Defensive: the loop guard above should already ensure this, but
    // keep the check so a future refactor cannot silently turn a bare
    // `<` into an attempted tag parse.
    if (!isAsciiAlpha(stripped.charCodeAt(nameStart))) {
      tokens.push({ type: "text", value: "<" });
      i++;
      continue;
    }

    // Read the tag name: [A-Za-z][A-Za-z0-9]*.
    let p = nameStart + 1;
    while (p < n) {
      const c = stripped.charCodeAt(p);
      if (!isAsciiAlpha(c) && !isAsciiDigit(c)) {
        break;
      }
      p++;
    }
    const tagName = stripped.slice(nameStart, p).toLowerCase();

    // Find the closing '>' of the tag. We have to be careful not to
    // mistake a '>' inside a quoted attribute value for the tag end.
    const tagEnd = findTagEnd(stripped, p);
    if (tagEnd < 0) {
      // No closing '>' — the rest of the input is malformed; treat the
      // remainder as text. (Original regex would simply not match and
      // leave the same characters as text via the alternation.)
      const text = decodeHtmlEntities(stripped.slice(i));
      if (text) {
        tokens.push({ type: "text", value: text });
      }
      // `break` exits the loop directly; no need to assign `i = n`
      // first (CodeQL js/useless-assignment-to-local).
      break;
    }

    // Inside [p, tagEnd) lie attributes (and possibly a trailing '/').
    let inner = stripped.slice(p, tagEnd);
    // Detect self-close: trailing '/'. Strip it so it is not parsed as
    // an attribute name.
    let selfClose = false;
    // Trim trailing whitespace, then a single '/'.
    let innerEnd = inner.length;
    while (innerEnd > 0 && isHtmlSpace(inner.charCodeAt(innerEnd - 1))) {
      innerEnd--;
    }
    if (innerEnd > 0 && inner.charCodeAt(innerEnd - 1) === 0x2f) {
      selfClose = true;
      innerEnd--;
    }
    inner = inner.slice(0, innerEnd);

    if (isClose) {
      tokens.push({ type: "close", tag: tagName, attrs: {} });
      i = tagEnd + 1;
      continue;
    }

    const attrs = parseHtmlAttrs(inner);
    const isVoidElement = VOID_ELEMENTS.has(tagName);
    if (selfClose || isVoidElement) {
      tokens.push({ type: "selfclose", tag: tagName, attrs });
      i = tagEnd + 1;
      continue;
    }

    tokens.push({ type: "open", tag: tagName, attrs });
    i = tagEnd + 1;

    // Raw-text elements: their body must not be parsed as markup.
    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      const closeIdx = findRawTextClose(stripped, i, tagName);
      if (closeIdx === null) {
        // No closing tag — discard the rest of the input for this
        // raw-text element to avoid emitting markup as text.
        i = n;
      } else {
        const body = stripped.slice(i, closeIdx.bodyEnd);
        if (RAW_TEXT_PRESERVE_BODY.has(tagName)) {
          tokens.push({ type: "text", value: body });
        }
        tokens.push({ type: "close", tag: tagName, attrs: {} });
        i = closeIdx.next;
      }
    }
  }
  return tokens;
}

function isAsciiAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isAsciiDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isHtmlSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;
}

/**
 * Scan forward from `from` to the position of the next '<' that
 * introduces a tag (i.e. is followed by `[a-zA-Z]` or `/[a-zA-Z]`).
 * A bare '<' (e.g. in `1 < 2`) is included in the text run.
 */
function scanTextEnd(s: string, from: number): number {
  const n = s.length;
  let i = from;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      return n;
    }
    if (isTagStart(s, lt)) {
      return lt;
    }
    // Bare '<' or `</` not followed by a letter — keep scanning.
    i = lt + 1;
  }
  return n;
}

/**
 * Return true if position `pos` in `s` is `<` followed by a letter
 * (open tag) or `</` followed by a letter (close tag). Used to
 * distinguish "real" tag starts from literal `<` characters.
 */
function isTagStart(s: string, pos: number): boolean {
  if (s.charCodeAt(pos) !== 0x3c /* '<' */) {
    return false;
  }
  const next = s.charCodeAt(pos + 1);
  if (isAsciiAlpha(next)) {
    return true;
  }
  if (next === 0x2f /* '/' */ && isAsciiAlpha(s.charCodeAt(pos + 2))) {
    return true;
  }
  return false;
}

/**
 * Find the index of the '>' that closes the tag opened just before
 * `from`. Honours quoted attribute values so that `<a href="x>y">`
 * does not stop at the '>' inside quotes.
 *
 * Returns -1 if no closing '>' is found before EOF.
 */
function findTagEnd(s: string, from: number): number {
  const n = s.length;
  let i = from;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x22 /* '"' */ || c === 0x27 /* "'" */) {
      const close = s.indexOf(c === 0x22 ? '"' : "'", i + 1);
      if (close < 0) {
        return -1;
      }
      i = close + 1;
      continue;
    }
    if (c === 0x3e /* '>' */) {
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Find the closing tag for a raw-text element (e.g. `</script>`),
 * starting at `from`. Returns the position immediately after the
 * close tag (`next`) plus the position where the body ends (`bodyEnd`,
 * i.e. the start of the close-tag literal).
 *
 * Implemented with a linear scan (no dynamic `RegExp`) so that
 * adversarial bodies cannot trigger super-linear runtime.
 */
function findRawTextClose(
  s: string,
  from: number,
  tagName: string
): { bodyEnd: number; next: number } | null {
  const n = s.length;
  let i = from;
  while (i < n) {
    const lt = s.indexOf("</", i);
    if (lt < 0) {
      return null;
    }
    const after = lt + 2;
    // Compare tag name case-insensitively.
    let ok = true;
    for (let k = 0; k < tagName.length; k++) {
      const a = s.charCodeAt(after + k);
      const aLower = a >= 0x41 && a <= 0x5a ? a + 0x20 : a;
      if (aLower !== tagName.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      i = after;
      continue;
    }
    // Skip any trailing whitespace before '>'.
    let p = after + tagName.length;
    while (p < n && isHtmlSpace(s.charCodeAt(p))) {
      p++;
    }
    if (p < n && s.charCodeAt(p) === 0x3e /* '>' */) {
      return { bodyEnd: lt, next: p + 1 };
    }
    i = after;
  }
  return null;
}

/**
 * Strip HTML comments, doctype declarations, CDATA sections and SGML
 * processing instructions in a single linear scan.
 *
 * A linear scan (vs. chained `String.prototype.replace` with regular
 * expressions) is required for two reasons:
 *
 * 1. **Incomplete multi-character sanitization** — chained replaces are
 *    each one pass; an attacker can nest the syntax (e.g.
 *    `<!--<!--x-->-->`) so the outer marker survives after the inner
 *    one is removed.
 * 2. **Catastrophic backtracking** — lazy quantifiers such as
 *    `<!--[\s\S]*?-->` are polynomial-time on adversarial input
 *    (very long unterminated comments).
 *
 * The scan is O(n) in the input length and removes nested constructs by
 * not advancing past the closing marker into already-emitted text.
 */
function stripSgmlNoise(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    if (input.charCodeAt(i) !== 0x3c /* '<' */) {
      out += input[i];
      i++;
      continue;
    }
    // Comment: <!-- ... -->
    // If the closing `-->` is missing the input is malformed. The
    // previous regex (`/<!--[\s\S]*?-->/g`) simply did not match in that
    // case and left the text in place; we preserve that behaviour rather
    // than swallowing the rest of the document, which would silently
    // change the parse for legitimate inputs that happen to contain a
    // stray `<!--`.
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      if (end < 0) {
        out += "<";
        i++;
        continue;
      }
      i = end + 3;
      continue;
    }
    // CDATA: <![CDATA[ ... ]]>
    if (input.startsWith("<![CDATA[", i)) {
      const end = input.indexOf("]]>", i + 9);
      if (end < 0) {
        out += "<";
        i++;
        continue;
      }
      i = end + 3;
      continue;
    }
    // Doctype: <!doctype ...> (case-insensitive)
    if (
      input.charCodeAt(i + 1) === 0x21 /* '!' */ &&
      input.slice(i + 2, i + 9).toLowerCase() === "doctype"
    ) {
      const end = input.indexOf(">", i + 9);
      if (end < 0) {
        out += "<";
        i++;
        continue;
      }
      i = end + 1;
      continue;
    }
    // Processing instruction: <? ... ?>
    if (input.charCodeAt(i + 1) === 0x3f /* '?' */) {
      const end = input.indexOf("?>", i + 2);
      if (end < 0) {
        out += "<";
        i++;
        continue;
      }
      i = end + 2;
      continue;
    }
    // Not an SGML noise construct — emit the '<' literally and continue.
    out += "<";
    i++;
  }
  return out;
}

/**
 * HTML elements whose body is not parsed as markup. Their content is either
 * preserved (style) for downstream processing or discarded entirely.
 */
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "noframes",
  "textarea",
  "title"
]);

/** Subset of RAW_TEXT_ELEMENTS whose body is kept (as a single text token). */
const RAW_TEXT_PRESERVE_BODY = new Set(["style"]);

const VOID_ELEMENTS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "col",
  "area",
  "base",
  "link",
  "meta",
  "source",
  "wbr"
]);

/**
 * Extract simple class rules from `<style>` tokens in the token stream.
 * Only supports simple selectors: `.className { property: value; ... }`
 * Does not support nested rules, media queries, pseudo-classes, combinators, etc.
 * Returns a map of className → inline style string.
 */
function extractStyleRules(tokens: Token[]): Record<string, string> {
  const result: Record<string, string> = {};
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === "open" && tok.tag === "style") {
      // Collect text content until </style>
      let cssText = "";
      i++;
      while (i < tokens.length) {
        const inner = tokens[i];
        if (inner.type === "close" && inner.tag === "style") {
          i++;
          break;
        }
        if (inner.type === "text") {
          cssText += inner.value;
        }
        i++;
      }
      // Parse simple class rules: .className { ... }
      const ruleRe = /\.([a-zA-Z_][\w-]*)\s*\{([^}]*)\}/g;
      let ruleMatch: RegExpExecArray | null;
      while ((ruleMatch = ruleRe.exec(cssText)) !== null) {
        const className = ruleMatch[1];
        const body = ruleMatch[2].trim();
        if (body && !result[className]) {
          result[className] = body;
        }
      }
      continue;
    }
    i++;
  }
  return result;
}

/**
 * Merge two class→style maps. For classes present in both, the declarations
 * are concatenated (extracted `<style>` rules first, caller-supplied overrides
 * last) so the later source wins per CSS cascade while still preserving
 * properties only declared by the other source. A plain `{ ...a, ...b }`
 * would discard the extracted rule entirely whenever the caller supplies the
 * same class name, silently dropping e.g. `font-style`/`color` from `<style>`.
 */
function mergeClassStyles(
  extracted: Record<string, string>,
  overrides: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = { ...extracted };
  for (const [name, style] of Object.entries(overrides)) {
    const existing = merged[name];
    merged[name] = existing ? `${existing}; ${style}` : style;
  }
  return merged;
}

/**
 * Parse HTML-style attributes from the inside of a start tag, e.g.
 * `class="x" id='y' disabled href=foo`.
 *
 * Implemented as a linear scan rather than the previous global regex
 * `/([a-zA-Z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g` so
 * adversarial start-tag content cannot trigger polynomial-redos
 * (CodeQL js/polynomial-redos). Behaviour matches the regex form on
 * well-formed inputs:
 *   - Attribute names lower-cased.
 *   - Double-quoted, single-quoted and unquoted values supported.
 *   - Boolean attributes (no `=`) yield an empty string value.
 */
function parseHtmlAttrs(str: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const n = str.length;
  let i = 0;
  while (i < n) {
    // Skip whitespace.
    while (i < n && isHtmlSpace(str.charCodeAt(i))) {
      i++;
    }
    if (i >= n) {
      break;
    }
    // Read attribute name: [A-Za-z_][\w-]*.
    const nameStart = i;
    const first = str.charCodeAt(i);
    if (!isAsciiAlpha(first) && first !== 0x5f /* '_' */) {
      // Not a valid attribute-name start — skip one char and resync.
      i++;
      continue;
    }
    i++;
    while (i < n) {
      const c = str.charCodeAt(i);
      if (isAsciiAlpha(c) || isAsciiDigit(c) || c === 0x5f /* '_' */ || c === 0x2d /* '-' */) {
        i++;
        continue;
      }
      break;
    }
    const name = str.slice(nameStart, i).toLowerCase();

    // Optional `\s*=\s*` then a value.
    let j = i;
    while (j < n && isHtmlSpace(str.charCodeAt(j))) {
      j++;
    }
    if (j >= n || str.charCodeAt(j) !== 0x3d /* '=' */) {
      // Boolean attribute.
      attrs[name] = "";
      continue;
    }
    j++; // past '='
    while (j < n && isHtmlSpace(str.charCodeAt(j))) {
      j++;
    }
    if (j >= n) {
      attrs[name] = "";
      i = j;
      continue;
    }
    const q = str.charCodeAt(j);
    if (q === 0x22 /* '"' */ || q === 0x27 /* "'" */) {
      const close = str.indexOf(q === 0x22 ? '"' : "'", j + 1);
      if (close < 0) {
        // Unterminated quoted value — take whatever is left and stop.
        attrs[name] = str.slice(j + 1);
        break;
      }
      attrs[name] = str.slice(j + 1, close);
      i = close + 1;
      continue;
    }
    // Unquoted value: run of non-whitespace.
    const valStart = j;
    while (j < n && !isHtmlSpace(str.charCodeAt(j))) {
      j++;
    }
    attrs[name] = str.slice(valStart, j);
    i = j;
  }
  return attrs;
}

function decodeHtmlEntities(text: string): string {
  // Decode every entity in a single pass. Chaining `.replace()` calls
  // (first `&amp;` → `&`, then `&lt;` → `<`, …) re-runs the later
  // replacements over the output of the earlier ones, so input like
  // `&amp;lt;` would round-trip to `<` instead of the intended `&lt;`.
  // CodeQL flags this as "Double escaping or unescaping". A single
  // alternation guarantees each source position is decoded at most once.
  return text.replace(
    /&(?:#(\d+)|#[xX]([a-fA-F0-9]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec !== undefined) {
        return safeFromCodePoint(parseInt(dec, 10));
      }
      if (hex !== undefined) {
        return safeFromCodePoint(parseInt(hex, 16));
      }
      if (name !== undefined) {
        const replacement = HTML_ENTITIES[name];
        return replacement ?? match;
      }
      return match;
    }
  );
}

/**
 * Convert a numeric character reference to a string. Uses fromCodePoint so
 * astral characters (e.g. emoji like &#128512;) are encoded as a proper
 * surrogate pair instead of a single invalid UTF-16 unit. Out-of-range or
 * non-finite values fall back to the Unicode replacement character.
 */
function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
    return "\uFFFD";
  }
  // Surrogate halves are not valid scalar values.
  if (cp >= 0xd800 && cp <= 0xdfff) {
    return "\uFFFD";
  }
  return String.fromCodePoint(cp);
}

/** Common HTML named entities mapped to their Unicode characters. */
const HTML_ENTITIES: Record<string, string> = {
  // Core XML/HTML entities — these used to be handled as standalone
  // chained `.replace()` calls in `decodeHtmlEntities`. They must live
  // in this table so the single-pass decoder can resolve them without
  // re-running over already-decoded output (CodeQL "double unescaping").
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",

  // Punctuation & Typography
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  laquo: "\u00AB",
  raquo: "\u00BB",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  sbquo: "\u201A",
  bdquo: "\u201E",
  bull: "\u2022",
  middot: "\u00B7",
  prime: "\u2032",
  Prime: "\u2033",
  oline: "\u203E",
  iquest: "\u00BF",
  iexcl: "\u00A1",
  sect: "\u00A7",
  para: "\u00B6",
  dagger: "\u2020",
  Dagger: "\u2021",
  permil: "\u2030",

  // Symbols & Legal
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",

  // Math & Science
  deg: "\u00B0",
  plusmn: "\u00B1",
  times: "\u00D7",
  divide: "\u00F7",
  minus: "\u2212",
  lowast: "\u2217",
  radic: "\u221A",
  infin: "\u221E",
  sum: "\u2211",
  prod: "\u220F",
  int: "\u222B",
  part: "\u2202",
  nabla: "\u2207",
  ne: "\u2260",
  equiv: "\u2261",
  asymp: "\u2248",
  le: "\u2264",
  ge: "\u2265",
  sub: "\u2282",
  sup: "\u2283",
  nsub: "\u2284",
  sube: "\u2286",
  supe: "\u2287",
  oplus: "\u2295",
  otimes: "\u2297",
  perp: "\u22A5",
  and: "\u2227",
  or: "\u2228",
  not: "\u00AC",
  exist: "\u2203",
  forall: "\u2200",
  empty: "\u2205",
  isin: "\u2208",
  notin: "\u2209",
  ni: "\u220B",
  there4: "\u2234",
  sim: "\u223C",
  cong: "\u2245",
  prop: "\u221D",

  // Currency
  euro: "\u20AC",
  pound: "\u00A3",
  yen: "\u00A5",
  cent: "\u00A2",
  curren: "\u00A4",
  fnof: "\u0192",

  // Greek letters (lowercase)
  alpha: "\u03B1",
  beta: "\u03B2",
  gamma: "\u03B3",
  delta: "\u03B4",
  epsilon: "\u03B5",
  zeta: "\u03B6",
  eta: "\u03B7",
  theta: "\u03B8",
  iota: "\u03B9",
  kappa: "\u03BA",
  lambda: "\u03BB",
  mu: "\u03BC",
  nu: "\u03BD",
  xi: "\u03BE",
  omicron: "\u03BF",
  pi: "\u03C0",
  rho: "\u03C1",
  sigma: "\u03C3",
  tau: "\u03C4",
  upsilon: "\u03C5",
  phi: "\u03C6",
  chi: "\u03C7",
  psi: "\u03C8",
  omega: "\u03C9",

  // Greek letters (uppercase)
  Alpha: "\u0391",
  Beta: "\u0392",
  Gamma: "\u0393",
  Delta: "\u0394",
  Epsilon: "\u0395",
  Zeta: "\u0396",
  Eta: "\u0397",
  Theta: "\u0398",
  Iota: "\u0399",
  Kappa: "\u039A",
  Lambda: "\u039B",
  Mu: "\u039C",
  Nu: "\u039D",
  Xi: "\u039E",
  Omicron: "\u039F",
  Pi: "\u03A0",
  Rho: "\u03A1",
  Sigma: "\u03A3",
  Tau: "\u03A4",
  Upsilon: "\u03A5",
  Phi: "\u03A6",
  Chi: "\u03A7",
  Psi: "\u03A8",
  Omega: "\u03A9",

  // Arrows
  larr: "\u2190",
  uarr: "\u2191",
  rarr: "\u2192",
  darr: "\u2193",
  harr: "\u2194",
  lArr: "\u21D0",
  uArr: "\u21D1",
  rArr: "\u21D2",
  dArr: "\u21D3",
  hArr: "\u21D4",
  crarr: "\u21B5",

  // Fractions
  frac12: "\u00BD",
  frac14: "\u00BC",
  frac34: "\u00BE",
  frac13: "\u2153",
  frac23: "\u2154",
  frac15: "\u2155",
  frac18: "\u215B",
  frac38: "\u215C",
  frac58: "\u215D",
  frac78: "\u215E",

  // Spaces
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200C",
  zwj: "\u200D",
  lrm: "\u200E",
  rlm: "\u200F",

  // Misc Symbols
  spades: "\u2660",
  clubs: "\u2663",
  hearts: "\u2665",
  diams: "\u2666",
  loz: "\u25CA",
  circ: "\u02C6",
  tilde: "\u02DC",
  shy: "\u00AD",
  macr: "\u00AF",
  acute: "\u00B4",
  cedil: "\u00B8",
  micro: "\u00B5",
  sup1: "\u00B9",
  sup2: "\u00B2",
  sup3: "\u00B3",
  ordf: "\u00AA",
  ordm: "\u00BA"
};

// =============================================================================
// CSS Inline Style Parser
// =============================================================================

interface ParsedCssStyle {
  fontFamily?: string;
  fontSize?: number; // half-points
  color?: string; // hex without #
  backgroundColor?: string; // hex without #
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  lineThrough?: boolean;
  textAlign?: "left" | "center" | "right" | "both";
  pageBreakBefore?: boolean;
  marginLeft?: number; // twips
  lineHeight?: number; // 240ths of a line (auto rule) — 240=single, 360=1.5, 480=double
  borderWidth?: number; // eighths of a point
  borderStyle?: string; // CSS border style keyword
  borderColor?: string; // hex without #
  width?: number; // twips (for table/cell width)
}

/** Parse a CSS inline style string into structured values. */
function parseCssStyle(styleStr: string | undefined): ParsedCssStyle {
  const result: ParsedCssStyle = {};
  if (!styleStr) {
    return result;
  }

  const declarations = styleStr.split(";");
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(":");
    if (colonIdx < 0) {
      continue;
    }
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const value = decl
      .slice(colonIdx + 1)
      .trim()
      .toLowerCase();

    switch (prop) {
      case "font-family":
        result.fontFamily = parseFontFamily(value);
        break;
      case "font-size":
        result.fontSize = parseFontSize(value);
        break;
      case "color":
        result.color = parseCssColor(value);
        break;
      case "background-color":
        result.backgroundColor = parseCssColor(value);
        break;
      case "font-weight":
        if (value === "bold" || value === "bolder" || parseInt(value, 10) >= 700) {
          result.bold = true;
        }
        break;
      case "font-style":
        if (value === "italic" || value === "oblique") {
          result.italic = true;
        }
        break;
      case "text-decoration":
      case "text-decoration-line":
        if (value.includes("underline")) {
          result.underline = true;
        }
        if (value.includes("line-through")) {
          result.lineThrough = true;
        }
        break;
      case "text-align":
        if (value === "left" || value === "start") {
          result.textAlign = "left";
        } else if (value === "center") {
          result.textAlign = "center";
        } else if (value === "right" || value === "end") {
          result.textAlign = "right";
        } else if (value === "justify") {
          result.textAlign = "both";
        }
        break;
      case "page-break-before":
        if (value === "always") {
          result.pageBreakBefore = true;
        }
        break;
      case "margin-left": {
        const twips = parseLengthToTwips(value);
        if (twips !== undefined) {
          result.marginLeft = twips;
        }
        break;
      }
      case "line-height": {
        const spacing = parseLineHeight(value);
        if (spacing !== undefined) {
          result.lineHeight = spacing;
        }
        break;
      }
      case "border": {
        // Shorthand: border: 1px solid black
        const parts = value.split(/\s+/);
        for (const part of parts) {
          if (/^\d/.test(part)) {
            result.borderWidth = parseBorderWidth(part);
          } else if (isBorderStyleKeyword(part)) {
            result.borderStyle = part;
          } else {
            const c = parseCssColor(part);
            if (c) {
              result.borderColor = c;
            }
          }
        }
        break;
      }
      case "border-style":
        result.borderStyle = value.split(/\s+/)[0];
        break;
      case "border-width":
        result.borderWidth = parseBorderWidth(value.split(/\s+/)[0]);
        break;
      case "border-color": {
        const c = parseCssColor(value.split(/\s+/)[0]);
        if (c) {
          result.borderColor = c;
        }
        break;
      }
      case "width": {
        const twips = parseLengthToTwips(value);
        if (twips !== undefined) {
          result.width = twips;
        }
        break;
      }
    }
  }
  return result;
}

/** Extract the first font-family name from a CSS font-family value. */
function parseFontFamily(value: string): string {
  // Take the original (non-lowercased) value for font names — but our parser
  // already lowered it. We'll capitalize for common fonts. Instead, let's
  // just strip quotes and return as-is (already lowered).
  // Actually we need the original casing. Let's re-parse from the raw value.
  // Since we already lowercased, we'll just clean it up:
  const first = value.split(",")[0].trim();
  // Remove quotes
  const cleaned = first.replace(/["']/g, "").trim();
  // Capitalize each word for display
  return cleaned
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Parse CSS font-size into half-points. */
function parseFontSize(value: string): number | undefined {
  // Support px, pt, em, rem
  const match = /^([\d.]+)\s*(px|pt|em|rem)?$/.exec(value);
  if (!match) {
    return undefined;
  }
  const num = parseFloat(match[1]);
  const unit = match[2] || "px";

  switch (unit) {
    case "pt":
      return Math.round(num * 2); // half-points
    case "px":
      // 1px ≈ 0.75pt
      return Math.round(num * 0.75 * 2);
    case "em":
    case "rem":
      // Assume 1em = 12pt = 24 half-points
      return Math.round(num * 24);
    default:
      return undefined;
  }
}

/** Parse a CSS color value into a 6-digit hex string (without #). */
function parseCssColor(value: string): string | undefined {
  // #RGB or #RRGGBB
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      return hex
        .split("")
        .map(c => c + c)
        .join("")
        .toUpperCase();
    }
    if (hex.length === 6) {
      return hex.toUpperCase();
    }
    return undefined;
  }
  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (rgbMatch) {
    const r = Math.min(255, parseInt(rgbMatch[1], 10));
    const g = Math.min(255, parseInt(rgbMatch[2], 10));
    const b = Math.min(255, parseInt(rgbMatch[3], 10));
    return (
      r.toString(16).padStart(2, "0") +
      g.toString(16).padStart(2, "0") +
      b.toString(16).padStart(2, "0")
    ).toUpperCase();
  }
  // Named colors (common subset)
  const named = CSS_NAMED_COLORS[value];
  if (named) {
    return named;
  }
  return undefined;
}

/** Common CSS named colors mapped to hex. */
const CSS_NAMED_COLORS: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  yellow: "FFFF00",
  cyan: "00FFFF",
  magenta: "FF00FF",
  gray: "808080",
  grey: "808080",
  silver: "C0C0C0",
  maroon: "800000",
  olive: "808000",
  lime: "00FF00",
  aqua: "00FFFF",
  teal: "008080",
  navy: "000080",
  fuchsia: "FF00FF",
  purple: "800080",
  orange: "FFA500",
  pink: "FFC0CB",
  brown: "A52A2A",
  coral: "FF7F50",
  crimson: "DC143C",
  darkblue: "00008B",
  darkgreen: "006400",
  darkred: "8B0000",
  gold: "FFD700",
  indigo: "4B0082",
  ivory: "FFFFF0",
  khaki: "F0E68C",
  lavender: "E6E6FA",
  lightblue: "ADD8E6",
  lightgray: "D3D3D3",
  lightgrey: "D3D3D3",
  lightgreen: "90EE90",
  lightyellow: "FFFFE0",
  darkgray: "A9A9A9",
  darkgrey: "A9A9A9",
  dimgray: "696969",
  dimgrey: "696969",
  tomato: "FF6347",
  violet: "EE82EE",
  wheat: "F5DEB3"
};

/** Parse a CSS length value (px, pt, in, cm, mm) into twips. 1 inch = 1440 twips. */
function parseLengthToTwips(value: string): number | undefined {
  const match = /^([\d.]+)\s*(px|pt|in|cm|mm|em|rem)?$/.exec(value);
  if (!match) {
    return undefined;
  }
  const num = parseFloat(match[1]);
  const unit = match[2] || "px";

  switch (unit) {
    case "pt":
      return Math.round(num * 20); // 1pt = 20 twips
    case "px":
      return Math.round(num * 15); // 1px ≈ 0.75pt ≈ 15 twips
    case "in":
      return Math.round(num * 1440); // 1in = 1440 twips
    case "cm":
      return Math.round(num * 567); // 1cm ≈ 567 twips
    case "mm":
      return Math.round(num * 56.7); // 1mm ≈ 56.7 twips
    case "em":
    case "rem":
      // Assume 1em = 12pt = 240 twips
      return Math.round(num * 240);
    default:
      return undefined;
  }
}

/** Parse CSS line-height into 240ths of a line for WordprocessingML spacing. */
function parseLineHeight(value: string): number | undefined {
  // Unitless number: e.g., "1.5" means 1.5 lines → 360 (240 * 1.5)
  const unitlessMatch = /^([\d.]+)$/.exec(value);
  if (unitlessMatch) {
    const num = parseFloat(unitlessMatch[1]);
    return Math.round(num * 240);
  }
  // Percentage: e.g., "150%" means 1.5 lines → 360
  const percentMatch = /^([\d.]+)%$/.exec(value);
  if (percentMatch) {
    const num = parseFloat(percentMatch[1]);
    return Math.round((num / 100) * 240);
  }
  // With units (px, pt): convert to twips and use "exact" style — but the "auto" rule
  // uses 240ths of a line, so we approximate with the unitless conversion
  const unitMatch = /^([\d.]+)\s*(px|pt|em|rem)$/.exec(value);
  if (unitMatch) {
    const num = parseFloat(unitMatch[1]);
    const unit = unitMatch[2];
    switch (unit) {
      case "pt":
        // Convert pt to 240ths of a line: 12pt = 240 (single line)
        return Math.round((num / 12) * 240);
      case "px":
        // 1px ≈ 0.75pt; 16px ≈ 12pt = single
        return Math.round(((num * 0.75) / 12) * 240);
      case "em":
      case "rem":
        return Math.round(num * 240);
    }
  }
  return undefined;
}

// =============================================================================
// Block parser
// =============================================================================

interface InlineContext {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  color?: string;
  backgroundColor?: string;
  hyperlink?: string;
  code?: boolean;
  fontFamily?: string;
  fontSize?: number;
  /**
   * Collector for embedded images discovered during parsing. When present,
   * base64 `data:` image sources are decoded and pushed here as ImageDefs;
   * the emitted InlineImageContent references the same rId. Shared by
   * reference across the (shallow-copied) inline contexts so a single sink
   * accumulates every image in the document.
   */
  imageSink?: ImageDef[];
}

const _BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "li",
  "dt",
  "dd",
  "dl",
  "section",
  "article",
  "main",
  "aside",
  "header",
  "footer",
  "figure",
  "figcaption",
  "details",
  "summary",
  "address"
]);

function parseBlocks(
  tokens: Token[],
  start: number,
  blocks: BodyContent[],
  parentCtx: InlineContext,
  classStyles: Record<string, string>
): number {
  let i = start;
  let pendingInline: { runs: ParagraphChild[]; ctx: InlineContext } | undefined;

  const flushPending = () => {
    if (pendingInline && pendingInline.runs.length > 0) {
      blocks.push({
        type: "paragraph",
        children: pendingInline.runs
      });
    }
    pendingInline = undefined;
  };

  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok.type === "close") {
      flushPending();
      return i + 1; // consumed the close tag
    }

    if (tok.type === "text") {
      // In block context, text nodes that are pure inter-element whitespace
      // (the newlines/indentation between block tags in pretty-printed HTML)
      // carry no content and must be ignored — otherwise every gap between
      // <p>/<table>/<div> tags would emit a spurious empty paragraph (and
      // the contained newline would be rendered as a <w:br/> soft break).
      // Whitespace that sits between inline runs is preserved by the inline
      // parser, which handles it separately.
      if (tok.value.trim() === "") {
        i++;
        continue;
      }
      if (!pendingInline) {
        pendingInline = { runs: [], ctx: parentCtx };
      }
      const run = makeRun(tok.value, parentCtx);
      pendingInline.runs.push(run);
      i++;
      continue;
    }

    // Open or self-close tag
    const tag = tok.type === "open" || tok.type === "selfclose" ? tok.tag : "";

    // Document scaffolding (<html>, <body>) is transparent — descend into
    // its children. <head> and its leaf children carry no body-text and
    // are skipped entirely so their whitespace/newlines don't leak as
    // empty paragraphs into the document.
    if (tag === "html" || tag === "body") {
      if (tok.type === "open") {
        flushPending();
        i = parseBlocks(tokens, i + 1, blocks, parentCtx, classStyles);
        continue;
      }
      i++;
      continue;
    }
    if (tag === "head") {
      // Fast-forward to </head>; ignore everything in between (titles,
      // meta, link, etc.). <style> bodies were already extracted by
      // tokenize+extractStyleRules and stripped from the token stream
      // through RAW_TEXT_ELEMENTS handling.
      if (tok.type === "open") {
        let depth = 1;
        i++;
        while (i < tokens.length && depth > 0) {
          const t = tokens[i];
          if (t.type === "open" && t.tag === "head") {
            depth++;
          } else if (t.type === "close" && t.tag === "head") {
            depth--;
          }
          i++;
        }
        continue;
      }
      i++;
      continue;
    }
    if (tag === "title" || tag === "meta" || tag === "link" || tag === "base") {
      // Should never reach here because <head> handler swallows them, but
      // guard against malformed HTML where they appear at body level.
      if (tok.type === "open") {
        let depth = 1;
        i++;
        while (i < tokens.length && depth > 0) {
          const t = tokens[i];
          if (t.type === "open" && t.tag === tag) {
            depth++;
          } else if (t.type === "close" && t.tag === tag) {
            depth--;
          }
          i++;
        }
        continue;
      }
      i++;
      continue;
    }

    if (tag === "br") {
      if (!pendingInline) {
        pendingInline = { runs: [], ctx: parentCtx };
      }
      pendingInline.runs.push({ content: [{ type: "break" }] } as Run);
      i++;
      continue;
    }

    if (tag === "hr") {
      flushPending();
      blocks.push({
        type: "paragraph",
        properties: {
          borders: {
            bottom: { style: "single", size: 6, space: 1, color: "auto" }
          }
        },
        children: []
      } as Paragraph);
      i++;
      continue;
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      flushPending();
      const level = parseInt(tag[1], 10);
      const style = parseCssStyle(resolveEffectiveStyle((tok as TagToken).attrs, classStyles));
      const children: ParagraphChild[] = [];
      const headingCtx: InlineContext = { ...parentCtx, bold: true };
      applyCssToInlineContext(headingCtx, style);
      i = parseInlines(tokens, i + 1, children, headingCtx, tag, classStyles);
      const props: Record<string, unknown> = {
        style: `Heading${level}`,
        ...(style.textAlign ? { alignment: style.textAlign } : {})
      };
      if (style.marginLeft !== undefined) {
        props.indent = { left: style.marginLeft };
      }
      if (style.lineHeight !== undefined) {
        props.spacing = { line: style.lineHeight, lineRule: "auto" };
      }
      blocks.push({
        type: "paragraph",
        properties: props as ParagraphProperties,
        children
      });
      continue;
    }

    // Page-break detection: <div style="page-break-before: always"> or <div class="page-break">
    if (tag === "div" && tok.type === "open") {
      const attrs = (tok as TagToken).attrs;
      const style = parseCssStyle(resolveEffectiveStyle(attrs, classStyles));
      const hasPageBreakClass = (attrs["class"] || "").split(/\s+/).includes("page-break");

      if (style.pageBreakBefore || hasPageBreakClass) {
        flushPending();
        // Emit a page break paragraph
        blocks.push({
          type: "paragraph",
          children: [{ content: [{ type: "break", breakType: "page" }] } as Run]
        });
        // Continue parsing the div's children as normal content
        i = parseBlocks(tokens, i + 1, blocks, parentCtx, classStyles);
        continue;
      }
    }

    // Paragraph-like blocks
    if (tag === "p" || tag === "div" || tag === "blockquote" || tag === "pre" || tag === "aside") {
      flushPending();
      const attrs = (tok as TagToken).attrs;
      const style = parseCssStyle(resolveEffectiveStyle(attrs, classStyles));
      const children: ParagraphChild[] = [];
      const ctx: InlineContext = tag === "pre" ? { ...parentCtx, code: true } : { ...parentCtx };
      applyCssToInlineContext(ctx, style);
      i = parseInlines(tokens, i + 1, children, ctx, tag, classStyles);
      const props: Record<string, unknown> = {};
      if (tag === "blockquote" || tag === "aside") {
        props.indent = { left: 720 }; // 0.5 inch indent
      }
      if (style.marginLeft !== undefined) {
        // margin-left → paragraph indentation (merges with blockquote indent)
        const existing = (props.indent as Record<string, unknown>) || {};
        props.indent = { ...existing, left: style.marginLeft };
      }
      if (style.textAlign) {
        props.alignment = style.textAlign;
      }
      if (style.lineHeight !== undefined) {
        props.spacing = { line: style.lineHeight, lineRule: "auto" };
      }
      blocks.push({
        type: "paragraph",
        ...(Object.keys(props).length > 0 ? { properties: props as ParagraphProperties } : {}),
        children
      });
      continue;
    }

    // Container elements: figure, details — recurse into children
    if (tag === "figure" || tag === "details") {
      flushPending();
      i = parseBlocks(tokens, i + 1, blocks, parentCtx, classStyles);
      continue;
    }

    // figcaption — paragraph with Caption style
    if (tag === "figcaption") {
      flushPending();
      const attrs = (tok as TagToken).attrs;
      const style = parseCssStyle(resolveEffectiveStyle(attrs, classStyles));
      const children: ParagraphChild[] = [];
      const ctx: InlineContext = { ...parentCtx };
      applyCssToInlineContext(ctx, style);
      i = parseInlines(tokens, i + 1, children, ctx, tag, classStyles);
      blocks.push({
        type: "paragraph",
        properties: { style: "Caption" } as ParagraphProperties,
        children
      });
      continue;
    }

    // summary — bold paragraph
    if (tag === "summary") {
      flushPending();
      const children: ParagraphChild[] = [];
      const ctx: InlineContext = { ...parentCtx, bold: true };
      i = parseInlines(tokens, i + 1, children, ctx, tag, classStyles);
      blocks.push({
        type: "paragraph",
        children
      });
      continue;
    }

    // Definition list: dl is a container, dt is bold, dd is indented
    if (tag === "dl") {
      flushPending();
      i = parseBlocks(tokens, i + 1, blocks, parentCtx, classStyles);
      continue;
    }

    if (tag === "dt") {
      flushPending();
      const children: ParagraphChild[] = [];
      const ctx: InlineContext = { ...parentCtx, bold: true };
      i = parseInlines(tokens, i + 1, children, ctx, tag, classStyles);
      blocks.push({
        type: "paragraph",
        children
      });
      continue;
    }

    if (tag === "dd") {
      flushPending();
      const children: ParagraphChild[] = [];
      const ctx: InlineContext = { ...parentCtx };
      i = parseInlines(tokens, i + 1, children, ctx, tag, classStyles);
      blocks.push({
        type: "paragraph",
        properties: { indent: { left: 720 } } as ParagraphProperties,
        children
      });
      continue;
    }

    // address — italic paragraph
    if (tag === "address") {
      flushPending();
      const children: ParagraphChild[] = [];
      const ctx: InlineContext = { ...parentCtx, italic: true };
      i = parseInlines(tokens, i + 1, children, ctx, tag, classStyles);
      blocks.push({
        type: "paragraph",
        children
      });
      continue;
    }

    // Lists
    if (tag === "ul" || tag === "ol") {
      flushPending();
      i = parseList(tokens, i + 1, blocks, parentCtx, tag === "ol", 0, tag, classStyles);
      continue;
    }

    // Tables
    if (tag === "table") {
      flushPending();
      const table = parseTable(tokens, i + 1, (tok as TagToken).attrs, classStyles);
      blocks.push(table.table);
      i = table.endIdx;
      continue;
    }

    // Inline elements treated at block level (wrap in paragraph)
    if (INLINE_TAGS.has(tag) || tok.type === "selfclose") {
      if (!pendingInline) {
        pendingInline = { runs: [], ctx: parentCtx };
      }
      i = parseInlineTag(tokens, i, pendingInline.runs, parentCtx, classStyles);
      continue;
    }

    // Unknown block: recurse
    if (tok.type === "open") {
      flushPending();
      i = parseBlocks(tokens, i + 1, blocks, parentCtx, classStyles);
      continue;
    }

    i++;
  }

  flushPending();
  return i;
}

const INLINE_TAGS = new Set([
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "strike",
  "del",
  "a",
  "span",
  "code",
  "sub",
  "sup",
  "mark",
  "small",
  "abbr",
  "q",
  "cite",
  "time",
  "kbd",
  "var",
  "samp",
  "img"
]);

// =============================================================================
// Inline parser
// =============================================================================

function parseInlines(
  tokens: Token[],
  start: number,
  runs: ParagraphChild[],
  ctx: InlineContext,
  untilClose: string,
  classStyles: Record<string, string>
): number {
  let i = start;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === "close" && tok.tag === untilClose) {
      return i + 1;
    }
    if (tok.type === "text") {
      runs.push(makeRun(tok.value, ctx));
      i++;
    } else if (tok.type === "close") {
      // Mismatched close tag, just skip
      return i + 1;
    } else {
      i = parseInlineTag(tokens, i, runs, ctx, classStyles);
    }
  }
  return i;
}

function parseInlineTag(
  tokens: Token[],
  idx: number,
  runs: ParagraphChild[],
  ctx: InlineContext,
  classStyles: Record<string, string>
): number {
  const tok = tokens[idx] as TagToken;
  const tag = tok.tag;

  if (tok.type === "selfclose" || tag === "br") {
    if (tag === "br") {
      runs.push({ content: [{ type: "break" }] } as Run);
    } else if (tag === "img") {
      const imgContent = buildImageContent(tok.attrs, ctx);
      if (imgContent) {
        runs.push({ content: [imgContent] } as Run);
      } else {
        // Fallback placeholder text
        const alt = tok.attrs["alt"] || "image";
        runs.push(makeRun(`[Image: ${alt}]`, ctx));
      }
    }
    return idx + 1;
  }

  // Open tags
  const newCtx = { ...ctx };
  const style = parseCssStyle(resolveEffectiveStyle(tok.attrs, classStyles));
  applyCssToInlineContext(newCtx, style);

  if (tag === "strong" || tag === "b") {
    newCtx.bold = true;
  } else if (tag === "em" || tag === "i") {
    newCtx.italic = true;
  } else if (tag === "u") {
    newCtx.underline = true;
  } else if (tag === "s" || tag === "strike" || tag === "del") {
    newCtx.strikethrough = true;
  } else if (tag === "sub") {
    newCtx.subscript = true;
  } else if (tag === "sup") {
    newCtx.superscript = true;
  } else if (tag === "mark") {
    if (!newCtx.backgroundColor) {
      newCtx.backgroundColor = "FFFF00"; // default highlight
    }
  } else if (tag === "cite") {
    newCtx.italic = true;
  } else if (tag === "small") {
    // 80% of default font size (default 24 half-points = 12pt)
    const baseSize = newCtx.fontSize || 24;
    newCtx.fontSize = Math.round(baseSize * 0.8);
  } else if (tag === "code" || tag === "kbd" || tag === "samp") {
    newCtx.code = true;
  } else if (tag === "a") {
    // Collect inner runs and wrap them in a Hyperlink
    const innerRuns: Run[] = [];
    // Drop unsafe schemes (javascript:/vbscript:/...) silently — the link
    // text is still preserved as plain runs.
    const safeHref = sanitizeUrl(tok.attrs["href"]);
    let i = idx + 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === "close" && t.tag === tag) {
        const hyperlink: Hyperlink = {
          type: "hyperlink",
          url: safeHref ?? "",
          children: innerRuns
        };
        runs.push(hyperlink);
        return i + 1;
      }
      if (t.type === "text") {
        innerRuns.push(makeRun(t.value, { ...ctx }));
        i++;
      } else if (t.type === "close") {
        // Mismatched close tag — close the hyperlink here but do NOT
        // consume the token; let the caller handle the block boundary.
        const hyperlink: Hyperlink = {
          type: "hyperlink",
          url: safeHref ?? "",
          children: innerRuns
        };
        runs.push(hyperlink);
        return i;
      } else {
        const childRuns: ParagraphChild[] = [];
        i = parseInlineTag(tokens, i, childRuns, { ...ctx }, classStyles);
        for (const r of childRuns) {
          if ("content" in r && !("type" in r)) {
            innerRuns.push(r as Run);
          } else if ("type" in r && r.type === "hyperlink") {
            // Flatten nested hyperlink children
            for (const c of (r as Hyperlink).children) {
              innerRuns.push(c);
            }
          }
        }
      }
    }
    // EOF fallback: tokens ran out without a matching `</a>`. Use the
    // already-sanitized href so an unclosed `<a href="javascript:...">`
    // can't smuggle a dangerous URL into the model.
    const hyperlink: Hyperlink = {
      type: "hyperlink",
      url: safeHref ?? "",
      children: innerRuns
    };
    runs.push(hyperlink);
    return i;
  }

  // Parse inner content
  let i = idx + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "close" && t.tag === tag) {
      return i + 1;
    }
    if (t.type === "text") {
      runs.push(makeRun(t.value, newCtx));
      i++;
    } else if (t.type === "close") {
      // Mismatched close tag (e.g. </p> while inside an unclosed <strong>).
      // Do NOT consume it — return the current index so the caller can
      // handle it. Consuming a block-level close here would swallow the
      // parent paragraph boundary and pull all following block content
      // into this run, breaking page breaks, tables, etc.
      return i;
    } else {
      i = parseInlineTag(tokens, i, runs, newCtx, classStyles);
    }
  }
  return i;
}

// =============================================================================
// List parser
// =============================================================================

function parseList(
  tokens: Token[],
  start: number,
  blocks: BodyContent[],
  ctx: InlineContext,
  ordered: boolean,
  level: number,
  untilClose: string,
  classStyles: Record<string, string>
): number {
  let i = start;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === "close" && tok.tag === untilClose) {
      return i + 1;
    }
    if (tok.type === "open" && tok.tag === "li") {
      i = parseListItem(tokens, i + 1, blocks, ctx, ordered, level, classStyles);
    } else if (tok.type === "open" && (tok.tag === "ul" || tok.tag === "ol")) {
      // Nested list directly under ul/ol (without li wrapper) — increase level
      i = parseList(tokens, i + 1, blocks, ctx, tok.tag === "ol", level + 1, tok.tag, classStyles);
    } else {
      i++;
    }
  }
  return i;
}

/** Parse contents of a single `<li>`, handling nested `<ul>/<ol>` inside it. */
function parseListItem(
  tokens: Token[],
  start: number,
  blocks: BodyContent[],
  ctx: InlineContext,
  ordered: boolean,
  level: number,
  classStyles: Record<string, string>
): number {
  const children: ParagraphChild[] = [];
  let i = start;
  let hasEmittedContent = false;

  while (i < tokens.length) {
    const tok = tokens[i];

    // End of this <li>
    if (tok.type === "close" && tok.tag === "li") {
      // Only emit a paragraph if there's content, or if we haven't emitted any paragraph for this item yet
      if (children.length > 0 || !hasEmittedContent) {
        blocks.push({
          type: "paragraph",
          properties: {
            numbering: {
              numId: ordered ? 2 : 1,
              level: level
            }
          },
          children
        });
      }
      return i + 1;
    }

    // Nested list inside <li>: emit current inline content as paragraph, then recurse
    if (tok.type === "open" && (tok.tag === "ul" || tok.tag === "ol")) {
      // Emit any collected inline content as the list item paragraph first
      if (children.length > 0 || !hasEmittedContent) {
        blocks.push({
          type: "paragraph",
          properties: {
            numbering: {
              numId: ordered ? 2 : 1,
              level: level
            }
          },
          children: [...children]
        });
        children.length = 0;
        hasEmittedContent = true;
      }
      // Parse the nested list at the next level
      const nestedOrdered = tok.tag === "ol";
      i = parseList(tokens, i + 1, blocks, ctx, nestedOrdered, level + 1, tok.tag, classStyles);
      continue;
    }

    // Text content
    if (tok.type === "text") {
      // Skip structural whitespace: the indentation/newlines that sit between
      // a nested <ul>/<ol> and the closing </li> (or at the very start of the
      // item) are not real content. Emitting them as runs would otherwise
      // produce a spurious empty list-item paragraph. Whitespace *between*
      // real inline content is preserved because `children` is non-empty then.
      if (tok.value.trim() === "" && children.length === 0) {
        i++;
        continue;
      }
      children.push(makeRun(tok.value, ctx));
      i++;
      continue;
    }

    // Inline tags
    if (tok.type === "open" || tok.type === "selfclose") {
      if (INLINE_TAGS.has(tok.tag) || tok.type === "selfclose") {
        i = parseInlineTag(tokens, i, children, ctx, classStyles);
      } else if (tok.tag === "br") {
        children.push({ content: [{ type: "break" }] } as Run);
        i++;
      } else {
        // Some other block-level tag inside <li> (e.g., <p>, <div>) — treat as inline
        i = parseInlineTag(tokens, i, children, ctx, classStyles);
      }
      continue;
    }

    // Mismatched close tag
    if (tok.type === "close") {
      // Emit what we have and stop
      blocks.push({
        type: "paragraph",
        properties: {
          numbering: {
            numId: ordered ? 2 : 1,
            level: level
          }
        },
        children
      });
      return i + 1;
    }

    i++;
  }

  // Ran out of tokens without seeing </li> — emit what we have
  if (children.length > 0) {
    blocks.push({
      type: "paragraph",
      properties: {
        numbering: {
          numId: ordered ? 2 : 1,
          level: level
        }
      },
      children
    });
  }
  return i;
}

// =============================================================================
// Table parser
// =============================================================================

function parseTable(
  tokens: Token[],
  start: number,
  tableAttrs: Record<string, string>,
  classStyles: Record<string, string>
): { table: Table; endIdx: number } {
  const rows: TableRow[] = [];
  let i = start;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === "close" && tok.tag === "table") {
      i++;
      break;
    }
    if (
      tok.type === "open" &&
      (tok.tag === "thead" || tok.tag === "tbody" || tok.tag === "tfoot")
    ) {
      i++;
      continue;
    }
    if (
      tok.type === "close" &&
      (tok.tag === "thead" || tok.tag === "tbody" || tok.tag === "tfoot")
    ) {
      i++;
      continue;
    }
    if (tok.type === "open" && tok.tag === "tr") {
      const row = parseTableRow(tokens, i + 1, classStyles);
      rows.push(row.row);
      i = row.endIdx;
      continue;
    }
    i++;
  }

  // Apply rowspan: insert vMerge "continue" cells in subsequent rows
  applyRowSpan(rows);

  // Parse table border style from attributes
  const tableBorders = parseTableBorders(tableAttrs);

  // Parse table width from style
  const tableStyle = parseCssStyle(tableAttrs["style"]);
  const tableProps: Record<string, unknown> = {};
  if (tableBorders) {
    tableProps.borders = tableBorders;
  }
  if (tableStyle.width) {
    tableProps.width = { value: tableStyle.width, type: "dxa" } satisfies TableWidth;
  }

  return {
    table: {
      type: "table",
      ...(Object.keys(tableProps).length > 0 ? { properties: tableProps as TableProperties } : {}),
      rows
    },
    endIdx: i
  };
}

function parseTableRow(
  tokens: Token[],
  start: number,
  classStyles: Record<string, string>
): { row: TableRow; endIdx: number } {
  const cells: TableCell[] = [];
  let i = start;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === "close" && tok.tag === "tr") {
      return { row: { cells }, endIdx: i + 1 };
    }
    if (tok.type === "open" && (tok.tag === "td" || tok.tag === "th")) {
      const isHeader = tok.tag === "th";
      const attrs = (tok as TagToken).attrs;
      const children: ParagraphChild[] = [];
      const cellCtx: InlineContext = isHeader ? { bold: true } : {};
      const style = parseCssStyle(resolveEffectiveStyle(attrs, classStyles));
      applyCssToInlineContext(cellCtx, style);
      i = parseInlines(tokens, i + 1, children, cellCtx, tok.tag, classStyles);

      // Build cell properties
      const cellProps = buildCellProperties(attrs, style);

      // Build paragraph properties for text-align
      const paraProps: Record<string, unknown> = {};
      if (style.textAlign) {
        paraProps.alignment = style.textAlign;
      }

      cells.push({
        ...(cellProps ? { properties: cellProps } : {}),
        content: [
          {
            type: "paragraph",
            ...(Object.keys(paraProps).length > 0
              ? { properties: paraProps as ParagraphProperties }
              : {}),
            children
          }
        ]
      });
      continue;
    }
    i++;
  }

  return { row: { cells }, endIdx: i };
}

/** Build TableCellProperties from HTML attributes (colspan, rowspan, borders). */
function buildCellProperties(
  attrs: Record<string, string>,
  style: ParsedCssStyle
): TableCellProperties | undefined {
  const props: Record<string, unknown> = {};

  // colspan → gridSpan
  const colspan = parseInt(attrs["colspan"], 10);
  if (colspan > 1) {
    props.gridSpan = colspan;
  }

  // rowspan → verticalMerge restart (the continuation cells need "continue")
  const rowspan = parseInt(attrs["rowspan"], 10);
  if (rowspan > 1) {
    props.verticalMerge = "restart";
    props.rowSpan = rowspan;
  }

  // Cell width from style or width attribute
  if (style.width) {
    props.width = { value: style.width, type: "dxa" } satisfies TableWidth;
  } else if (attrs["width"]) {
    const w = parseCellWidthAttr(attrs["width"]);
    if (w) {
      props.width = w;
    }
  }

  // Background color from style
  if (style.backgroundColor) {
    props.shading = { pattern: "clear", fill: style.backgroundColor };
  }

  // Cell borders from inline style
  const cellBorders = parseCellBordersFromStyle(attrs["style"]);
  if (cellBorders) {
    props.borders = cellBorders;
  }

  return Object.keys(props).length > 0 ? (props as TableCellProperties) : undefined;
}

/** Parse a cell width attribute value (number in px, percentage, or plain number). */
function parseCellWidthAttr(value: string): TableWidth | undefined {
  if (!value) {
    return undefined;
  }
  // Percentage: "50%" → pct (fiftieths of a percent: 50% = 2500)
  const pctMatch = /^([\d.]+)%$/.exec(value.trim());
  if (pctMatch) {
    return { value: Math.round(parseFloat(pctMatch[1]) * 50), type: "pct" };
  }
  // Numeric (pixels): "200" or "200px" → convert to twips
  const pxMatch = /^(\d+)(?:px)?$/.exec(value.trim());
  if (pxMatch) {
    return { value: parseInt(pxMatch[1], 10) * 15, type: "dxa" };
  }
  return undefined;
}

/**
 * Post-process rows to insert vMerge "continue" cells for rowspan.
 * Scans rows for cells with rowSpan > 1, then inserts placeholder cells
 * with verticalMerge: "continue" in the appropriate positions in subsequent rows.
 */
function applyRowSpan(rows: TableRow[]): void {
  // Track active rowspans: Map<column-index, remaining-rows>
  // Each entry also stores the gridSpan of the originating cell
  interface ActiveSpan {
    remaining: number;
    gridSpan: number;
  }

  const activeSpans: Map<number, ActiveSpan> = new Map();

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const newCells: TableCell[] = [];
    let cellIdx = 0; // index into original cells
    let colIdx = 0; // logical column position

    // Insert vMerge "continue" cells for active rowspans
    while (colIdx < 1000) {
      // safety limit
      const span = activeSpans.get(colIdx);
      if (span && span.remaining > 0) {
        // Insert a continuation cell
        const contCell: TableCell = {
          properties: {
            verticalMerge: "continue",
            ...(span.gridSpan > 1 ? { gridSpan: span.gridSpan } : {})
          },
          content: [{ type: "paragraph", children: [] }]
        };
        newCells.push(contCell);
        span.remaining--;
        if (span.remaining === 0) {
          activeSpans.delete(colIdx);
        }
        colIdx += span.gridSpan;
        continue;
      }

      // No active span at this column: use the next original cell
      if (cellIdx >= row.cells.length) {
        break;
      }

      const cell = row.cells[cellIdx];
      const cellGridSpan = cell.properties?.gridSpan || 1;
      const cellRowSpan = cell.properties?.rowSpan;

      // Register new rowspan
      if (cellRowSpan && cellRowSpan > 1) {
        activeSpans.set(colIdx, { remaining: cellRowSpan - 1, gridSpan: cellGridSpan });
      }

      newCells.push(cell);
      colIdx += cellGridSpan;
      cellIdx++;
    }

    // Replace the row's cells with the new array (including continuation cells)
    // We need to cast away readonly for mutation during this post-processing step
    (rows[rowIdx] as { cells: TableCell[] }).cells = newCells;
  }
}

/** Parse table-level borders from table attributes. */
function parseTableBorders(attrs: Record<string, string>): TableBorders | undefined {
  const style = parseCssStyle(attrs["style"]);
  const borderAttr = attrs["border"];

  // Check for border="1" attribute (common HTML table pattern)
  if (borderAttr && parseInt(borderAttr, 10) > 0) {
    const size = Math.max(4, parseInt(borderAttr, 10) * 4); // eighths of a point
    const border = { style: "single" as const, size, color: "000000" };
    return {
      top: border,
      left: border,
      bottom: border,
      right: border,
      insideH: border,
      insideV: border
    };
  }

  // Check style attribute for border
  const borderStyle = parseBorderStyleFromCss(attrs["style"]);
  if (borderStyle) {
    return {
      top: borderStyle,
      left: borderStyle,
      bottom: borderStyle,
      right: borderStyle,
      insideH: borderStyle,
      insideV: borderStyle
    };
  }

  // background-color at table level can influence shading (handled separately)
  void style;
  return undefined;
}

/** Parse border CSS shorthand to a Border object. */
function parseBorderStyleFromCss(
  styleStr: string | undefined
):
  | { style: "single" | "double" | "dotted" | "dashed" | "none"; size: number; color: string }
  | undefined {
  if (!styleStr) {
    return undefined;
  }

  // Match border: <width> <style> <color> or border-style, border-width, border-color
  const declarations = styleStr.split(";");
  let borderWidth: number | undefined;
  let borderStyleVal: string | undefined;
  let borderColor: string | undefined;

  for (const decl of declarations) {
    const colonIdx = decl.indexOf(":");
    if (colonIdx < 0) {
      continue;
    }
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const value = decl
      .slice(colonIdx + 1)
      .trim()
      .toLowerCase();

    if (prop === "border") {
      // Shorthand: border: 1px solid black
      const parts = value.split(/\s+/);
      for (const part of parts) {
        if (/^\d/.test(part)) {
          borderWidth = parseBorderWidth(part);
        } else if (isBorderStyleKeyword(part)) {
          borderStyleVal = part;
        } else {
          borderColor = parseCssColor(part) || borderColor;
        }
      }
    } else if (prop === "border-style") {
      borderStyleVal = value.split(/\s+/)[0];
    } else if (prop === "border-width") {
      borderWidth = parseBorderWidth(value.split(/\s+/)[0]);
    } else if (prop === "border-color") {
      borderColor = parseCssColor(value.split(/\s+/)[0]) || borderColor;
    }
  }

  if (borderStyleVal && borderStyleVal !== "none" && borderStyleVal !== "hidden") {
    return {
      style: mapCssBorderStyle(borderStyleVal),
      size: borderWidth || 4,
      color: borderColor || "000000"
    };
  }
  return undefined;
}

/** Parse cell-level borders from inline style string. */
function parseCellBordersFromStyle(styleStr: string | undefined): TableBorders | undefined {
  if (!styleStr) {
    return undefined;
  }
  const borderDef = parseBorderStyleFromCss(styleStr);
  if (!borderDef) {
    return undefined;
  }
  return {
    top: borderDef,
    left: borderDef,
    bottom: borderDef,
    right: borderDef
  };
}

function parseBorderWidth(value: string): number {
  const match = /^([\d.]+)\s*(px|pt)?$/.exec(value);
  if (!match) {
    return 4;
  }
  const num = parseFloat(match[1]);
  const unit = match[2] || "px";
  if (unit === "pt") {
    return Math.round(num * 8); // eighths of a point
  }
  // px: approximate 1px ≈ 0.75pt → 6 eighths
  return Math.round(num * 6);
}

function isBorderStyleKeyword(value: string): boolean {
  return [
    "none",
    "hidden",
    "dotted",
    "dashed",
    "solid",
    "double",
    "groove",
    "ridge",
    "inset",
    "outset"
  ].includes(value);
}

function mapCssBorderStyle(cssStyle: string): "single" | "double" | "dotted" | "dashed" | "none" {
  switch (cssStyle) {
    case "solid":
    case "groove":
    case "ridge":
    case "inset":
    case "outset":
      return "single";
    case "double":
      return "double";
    case "dotted":
      return "dotted";
    case "dashed":
      return "dashed";
    case "none":
    case "hidden":
      return "none";
    default:
      return "single";
  }
}

// =============================================================================
// Image content builder
// =============================================================================

/** Build InlineImageContent from img attributes or return undefined if not applicable. */
function buildImageContent(
  attrs: Record<string, string>,
  ctx?: InlineContext
): InlineImageContent | undefined {
  const src = attrs["src"] || "";
  const alt = attrs["alt"] || "";

  // Parse width/height from attributes first, then fall back to style
  let width = parseImageDimension(attrs["width"]);
  let height = parseImageDimension(attrs["height"]);

  // Also check inline style for width/height
  if (!width || !height) {
    const styleDims = parseImageDimensionsFromStyle(attrs["style"]);
    if (!width && styleDims.width) {
      width = styleDims.width;
    }
    if (!height && styleDims.height) {
      height = styleDims.height;
    }
  }

  // Convert pixels to EMU
  const widthEmu = (width || 100) * EMU_PER_PX;
  const heightEmu = (height || 100) * EMU_PER_PX;

  // base64 data: URLs can be decoded and embedded as a real media file when
  // an image sink is provided (htmlToDocx path). The decoded bytes are
  // registered as an ImageDef and the run references the assigned rId.
  if (src.startsWith("data:") && ctx?.imageSink) {
    const decoded = decodeDataUrlImage(src);
    if (decoded) {
      const sink = ctx.imageSink;
      const index = sink.length;
      const rId = `htmlImg${index}`;
      const ext = decoded.mediaType === "jpeg" ? "jpg" : decoded.mediaType;
      sink.push({
        data: decoded.data,
        mediaType: decoded.mediaType,
        fileName: `image_html_${index}.${ext}`,
        rId
      });
      return {
        type: "image",
        rId,
        width: widthEmu,
        height: heightEmu,
        altText: alt || undefined,
        name: alt || `image${index}`
      };
    }
  }

  // No sink (htmlToDocxBody only returns BodyContent[] and cannot register
  // media) or an unsupported/remote source: emit a placeholder with an empty
  // rId. The renderer treats an empty rId as a placeholder; the original src
  // is surfaced in the alt text so callers can post-process if needed.
  if (src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://")) {
    return {
      type: "image",
      rId: "", // empty rId → renderer treats this as a placeholder
      width: widthEmu,
      height: heightEmu,
      altText: alt || `[Image placeholder: ${src.slice(0, 64)}${src.length > 64 ? "…" : ""}]`,
      name: alt || "image"
    };
  }

  return undefined;
}

/** Decode a `data:image/...;base64,...` URL into bytes + media type. */
function decodeDataUrlImage(
  src: string
): { data: Uint8Array; mediaType: ImageMediaType } | undefined {
  // data:image/png;base64,XXXX
  const match = /^data:image\/([a-z0-9.+-]+)\s*;\s*base64\s*,(.*)$/is.exec(src);
  if (!match) {
    return undefined;
  }
  const rawType = match[1].toLowerCase();
  const b64 = match[2].replace(/\s+/g, "");
  const mediaType = normalizeImageMediaType(rawType);
  if (!mediaType) {
    return undefined;
  }
  try {
    const data = base64ToUint8Array(b64);
    if (data.length === 0) {
      return undefined;
    }
    return { data, mediaType };
  } catch {
    return undefined;
  }
}

/** Map a data-URL image subtype to a supported ImageMediaType. */
function normalizeImageMediaType(subtype: string): ImageMediaType | undefined {
  switch (subtype) {
    case "png":
      return "png";
    case "jpeg":
    case "jpg":
      return "jpeg";
    case "gif":
      return "gif";
    case "bmp":
      return "bmp";
    case "tiff":
    case "tif":
      return "tiff";
    case "svg+xml":
    case "svg":
      return "svg";
    case "webp":
      return "webp";
    default:
      return undefined;
  }
}

/** Parse an image dimension from HTML attribute value (number or "Npx"). */
function parseImageDimension(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(\d+)(?:px)?$/.exec(value.trim());
  return match ? parseInt(match[1], 10) : undefined;
}

/** Parse width and height from an inline style string (for <img> elements). */
function parseImageDimensionsFromStyle(styleStr: string | undefined): {
  width?: number;
  height?: number;
} {
  const result: { width?: number; height?: number } = {};
  if (!styleStr) {
    return result;
  }
  const declarations = styleStr.split(";");
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(":");
    if (colonIdx < 0) {
      continue;
    }
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const value = decl
      .slice(colonIdx + 1)
      .trim()
      .toLowerCase();
    if (prop === "width") {
      const px = parseImageCssDimension(value);
      if (px !== undefined) {
        result.width = px;
      }
    } else if (prop === "height") {
      const px = parseImageCssDimension(value);
      if (px !== undefined) {
        result.height = px;
      }
    }
  }
  return result;
}

/** Parse a CSS dimension value for images into pixels. */
function parseImageCssDimension(value: string): number | undefined {
  const match = /^([\d.]+)\s*(px|pt|in|cm|mm)?$/.exec(value);
  if (!match) {
    return undefined;
  }
  const num = parseFloat(match[1]);
  const unit = match[2] || "px";
  switch (unit) {
    case "px":
      return Math.round(num);
    case "pt":
      // 1pt = 1.333px
      return Math.round(num * 1.333);
    case "in":
      // 1in = 96px
      return Math.round(num * 96);
    case "cm":
      // 1cm ≈ 37.8px
      return Math.round(num * 37.8);
    case "mm":
      // 1mm ≈ 3.78px
      return Math.round(num * 3.78);
    default:
      return undefined;
  }
}

// =============================================================================
// CSS → InlineContext helper
// =============================================================================

/** Apply parsed CSS styles to an InlineContext. */
function applyCssToInlineContext(ctx: InlineContext, style: ParsedCssStyle): void {
  if (style.bold) {
    ctx.bold = true;
  }
  if (style.italic) {
    ctx.italic = true;
  }
  if (style.underline) {
    ctx.underline = true;
  }
  if (style.lineThrough) {
    ctx.strikethrough = true;
  }
  if (style.color) {
    ctx.color = style.color;
  }
  if (style.backgroundColor) {
    ctx.backgroundColor = style.backgroundColor;
  }
  if (style.fontFamily) {
    ctx.fontFamily = style.fontFamily;
  }
  if (style.fontSize) {
    ctx.fontSize = style.fontSize;
  }
}

/**
 * Resolve the effective inline style string for an element by merging class-based styles
 * with inline styles. Inline styles take priority over class-based styles.
 */
function resolveEffectiveStyle(
  attrs: Record<string, string>,
  classStyles: Record<string, string>
): string | undefined {
  const classAttr = attrs["class"];
  let merged: string | undefined;

  if (classAttr) {
    const classNames = classAttr.split(/\s+/).filter(Boolean);
    const parts: string[] = [];
    for (const name of classNames) {
      const s = classStyles[name];
      if (s) {
        parts.push(s);
      }
    }
    if (parts.length > 0) {
      merged = parts.join("; ");
    }
  }

  const inlineStyle = attrs["style"];
  if (merged && inlineStyle) {
    // Inline style overrides: append after class-based style so later declarations win
    return merged + "; " + inlineStyle;
  }
  return inlineStyle || merged;
}

// =============================================================================
// Run builder
// =============================================================================

function makeRun(text: string, ctx: InlineContext): Run {
  // HTML whitespace handling: outside <pre>/<code>, runs of whitespace
  // (including the newlines/indentation from source-code line wrapping)
  // collapse to a single space. Inside <pre>/<code> whitespace is
  // significant and preserved verbatim.
  const value = ctx.code ? text : text.replace(/\s+/g, " ");

  const props: Record<string, unknown> = {};
  if (ctx.bold) {
    props.bold = true;
  }
  if (ctx.italic) {
    props.italic = true;
  }
  if (ctx.underline) {
    props.underline = "single";
  }
  if (ctx.strikethrough) {
    props.strike = true;
  }
  if (ctx.superscript) {
    props.vertAlign = "superscript";
  }
  if (ctx.subscript) {
    props.vertAlign = "subscript";
  }
  if (ctx.code) {
    // Courier New has no CJK glyphs, so it must not claim `w:eastAsia`: doing so
    // replaced the inherited East Asian face and left Chinese inside a `<code>`
    // span pointing at a typeface that cannot draw it.
    props.font = { ascii: "Courier New", hAnsi: "Courier New" };
  } else if (ctx.fontFamily) {
    // A CSS `font-family` naming a Chinese typeface has to reach the ideographs,
    // which are resolved through `w:eastAsia`; a Latin one must leave that slot
    // inherited.
    props.font = isEastAsianTypeface(ctx.fontFamily)
      ? { ascii: ctx.fontFamily, hAnsi: ctx.fontFamily, eastAsia: ctx.fontFamily }
      : { ascii: ctx.fontFamily, hAnsi: ctx.fontFamily };
  }
  if (ctx.fontSize) {
    props.size = ctx.fontSize;
  }
  if (ctx.color) {
    props.color = ctx.color;
  }
  if (ctx.backgroundColor) {
    props.shading = { pattern: "clear", fill: ctx.backgroundColor };
  }

  const run: Run = {
    ...(Object.keys(props).length > 0 ? { properties: props as RunProperties } : {}),
    content: [{ type: "text", text: value }]
  };

  return run;
}
