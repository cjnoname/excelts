/**
 * DOCX Module - Template Engine
 *
 * A template engine for DOCX documents supporting:
 * - Variable interpolation: {{name}}, {{user.name}}
 * - Conditionals: {{#if cond}}...{{/if}}, {{#if cond}}...{{else}}...{{/if}}
 * - Loops: {{#each items}}...{{/each}} with {{.}}, {{.prop}}, {{@index}}
 * - Table row loops: auto-duplicates table rows when {{#each}} is in a row
 * - Table column loops: {{#cols items}}...{{/cols}} duplicates columns
 * - Image placeholders: {{%image}} resolves to an inline image
 * - RichText placeholders: {{&richText}} resolves to paragraph children
 * - Sub-document insertion: {{>subDoc}} resolves to body content blocks
 * - Chart placeholders: {{^chart}} resolves to chart content
 *
 * Handles cross-run placeholders (Word often splits {{name}} across runs).
 */

import { isForbiddenKey } from "@utils/object";
import { utf8Encoder } from "@word/core/internal-utils";
import { isRun } from "@word/core/text-utils";
import { TemplateError } from "@word/errors";
import type {
  DocxDocument,
  BodyContent,
  Paragraph,
  ParagraphChild,
  Run,
  RunProperties,
  Table,
  TableRow,
  TableCell,
  ImageDef,
  InlineImageContent,
  Chart,
  ChartContent,
  AltChunk,
  StructuredDocumentTag
} from "@word/types";

// =============================================================================
// Public Types
// =============================================================================

/** Options for the template engine. */
export interface TemplateOptions {
  /** Custom delimiters (default: ["{{", "}}"]). */
  readonly delimiters?: readonly [string, string];
  /**
   * If true (default), throw `TemplateError` when a placeholder cannot be
   * resolved. If false, unresolved variables render as the empty string and
   * unresolved control directives are skipped silently.
   */
  readonly strict?: boolean;
}

/** An image value to be inserted by the template engine. */
export interface TemplateImage {
  /** Image definition (data, fileName, mediaType). */
  readonly image: ImageDef;
  /** Width in EMU. */
  readonly width: number;
  /** Height in EMU. */
  readonly height: number;
  /** Optional alt text. */
  readonly altText?: string;
}

/** Rich text value: an array of runs to insert. */
export type TemplateRichText = readonly Run[];

/** Sub-document content: body blocks to insert. */
export type TemplateSubDocument = readonly BodyContent[];

/** Chart value to be inserted by the template engine. */
export interface TemplateChart {
  readonly chart: Chart;
  readonly altText?: string;
  readonly name?: string;
}

/** HTML chunk value to be inserted as an altChunk body content. */
export interface TemplateHtmlChunk {
  /** HTML content string. */
  readonly html: string;
  /** Optional content type (default: "text/html"). */
  readonly contentType?: string;
}

/** Information about a template tag found in the document. */
export interface TemplateTag {
  /** The raw tag expression (e.g. "name", "#each items", "%image"). */
  readonly expression: string;
  /** Tag type. */
  readonly type:
    | "variable"
    | "image"
    | "richText"
    | "subDocument"
    | "chart"
    | "htmlChunk"
    | "ifOpen"
    | "ifClose"
    | "else"
    | "eachOpen"
    | "eachClose"
    | "colsOpen"
    | "colsClose";
  /** Location hint (e.g. "body paragraph 3", "header"). */
  readonly location: string;
}

// =============================================================================
// Token Types (internal)
// =============================================================================

const enum TokenType {
  Text = 0,
  Variable = 1,
  IfOpen = 2,
  Else = 3,
  IfClose = 4,
  EachOpen = 5,
  EachClose = 6
}

interface TextToken {
  readonly type: TokenType.Text;
  readonly value: string;
}

interface VariableToken {
  readonly type: TokenType.Variable;
  readonly path: string;
}

interface IfOpenToken {
  readonly type: TokenType.IfOpen;
  readonly condition: string;
}

interface ElseToken {
  readonly type: TokenType.Else;
}

interface IfCloseToken {
  readonly type: TokenType.IfClose;
}

interface EachOpenToken {
  readonly type: TokenType.EachOpen;
  readonly collection: string;
}

interface EachCloseToken {
  readonly type: TokenType.EachClose;
}

type Token =
  | TextToken
  | VariableToken
  | IfOpenToken
  | ElseToken
  | IfCloseToken
  | EachOpenToken
  | EachCloseToken;

// =============================================================================
// Core: fillTemplate
// =============================================================================

/**
 * Fill a DOCX template document with data.
 *
 * Processes all body content, headers, footers, footnotes, and endnotes.
 * Operates on the document model in-place and returns it.
 *
 * @param doc - The parsed DocxDocument model.
 * @param data - Data to fill into the template.
 * @param options - Optional template settings.
 * @returns The same DocxDocument with placeholders resolved.
 */
export function fillTemplate(
  doc: DocxDocument,
  data: Record<string, unknown>,
  options?: TemplateOptions
): DocxDocument {
  const open = options?.delimiters?.[0] ?? "{{";
  const close = options?.delimiters?.[1] ?? "}}";
  const strict = options?.strict ?? true;

  const ctx: TemplateContext = { open, close, strict, data };

  // Process body
  const newBody = processBodyContent(doc.body as BodyContent[], ctx, "body");
  (doc as { body: readonly BodyContent[] }).body = newBody;

  // Process headers
  if (doc.headers) {
    for (const [key, headerDef] of doc.headers) {
      const newChildren = processBlockList(
        headerDef.content.children as (Paragraph | Table)[],
        ctx,
        `header:${key}`
      );
      (headerDef.content as { children: readonly (Paragraph | Table)[] }).children = newChildren;
    }
  }

  // Process footers
  if (doc.footers) {
    for (const [key, footerDef] of doc.footers) {
      const newChildren = processBlockList(
        footerDef.content.children as (Paragraph | Table)[],
        ctx,
        `footer:${key}`
      );
      (footerDef.content as { children: readonly (Paragraph | Table)[] }).children = newChildren;
    }
  }

  // Process footnotes
  if (doc.footnotes) {
    for (const note of doc.footnotes) {
      if (note.id <= 0) {
        continue;
      }
      const processed = processBlockList(note.content as Paragraph[], ctx, `footnote:${note.id}`);
      (note as { content: readonly Paragraph[] }).content = processed as Paragraph[];
    }
  }

  // Process endnotes
  if (doc.endnotes) {
    for (const note of doc.endnotes) {
      if (note.id <= 0) {
        continue;
      }
      const processed = processBlockList(note.content as Paragraph[], ctx, `endnote:${note.id}`);
      (note as { content: readonly Paragraph[] }).content = processed as Paragraph[];
    }
  }

  return doc;
}

// =============================================================================
// Internal Context
// =============================================================================

interface TemplateContext {
  readonly open: string;
  readonly close: string;
  readonly strict: boolean;
  readonly data: Record<string, unknown>;
}

// =============================================================================
// Cross-run text merging
// =============================================================================

/**
 * Merge all text content from a paragraph's runs into a single string.
 * This is intentionally simple — only extracts raw text from runs (no hyperlinks,
 * no tracked changes) as template placeholders only exist in direct run content.
 */
function extractParagraphText(para: Paragraph): string {
  let result = "";
  for (const child of para.children) {
    if (!isRun(child)) {
      continue;
    }
    for (const c of child.content) {
      if (c.type === "text" && "text" in c) {
        result += (c as { type: "text"; text: string }).text;
      }
    }
  }
  return result;
}

// =============================================================================
// Tokenizer
// =============================================================================

function tokenize(text: string, open: string, close: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < text.length) {
    const startIdx = text.indexOf(open, pos);
    if (startIdx === -1) {
      tokens.push({ type: TokenType.Text, value: text.slice(pos) });
      break;
    }

    if (startIdx > pos) {
      tokens.push({ type: TokenType.Text, value: text.slice(pos, startIdx) });
    }

    const endIdx = text.indexOf(close, startIdx + open.length);
    if (endIdx === -1) {
      // Unclosed delimiter — treat rest as text
      tokens.push({ type: TokenType.Text, value: text.slice(startIdx) });
      break;
    }

    const expr = text.slice(startIdx + open.length, endIdx).trim();
    pos = endIdx + close.length;

    if (expr.startsWith("#if ")) {
      tokens.push({ type: TokenType.IfOpen, condition: expr.slice(4).trim() });
    } else if (expr === "else") {
      tokens.push({ type: TokenType.Else });
    } else if (expr === "/if") {
      tokens.push({ type: TokenType.IfClose });
    } else if (expr.startsWith("#each ")) {
      tokens.push({ type: TokenType.EachOpen, collection: expr.slice(6).trim() });
    } else if (expr === "/each") {
      tokens.push({ type: TokenType.EachClose });
    } else {
      tokens.push({ type: TokenType.Variable, path: expr });
    }
  }

  return tokens;
}

// =============================================================================
// Value resolution
// =============================================================================

function resolvePath(data: unknown, path: string): unknown {
  if (path === ".") {
    // In loop context, "." refers to the current item stored at key "."
    if (data != null && typeof data === "object" && Object.hasOwn(data as object, ".")) {
      return (data as Record<string, unknown>)["."];
    }
    return data;
  }
  const startPath = path.startsWith(".") ? path.slice(1) : path;
  const parts = startPath.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    // Use Object.hasOwn so a template path can never traverse prototype
    // properties (`{{constructor}}`, `{{__proto__.something}}`, …) and
    // surface JS internals into the rendered document. Arrays are
    // handled the same way — numeric indices are own properties.
    if (!Object.hasOwn(current as object, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return !!value;
}

function valueToString(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

// =============================================================================
// Processing body content (handles block-level #each and #if)
// =============================================================================

function processBodyContent(
  blocks: BodyContent[],
  ctx: TemplateContext,
  location: string
): BodyContent[] {
  const result: BodyContent[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];

    if (block.type === "paragraph") {
      const text = extractParagraphText(block);

      // Check if this paragraph starts a block-level #each
      if (hasBlockDirective(text, ctx.open, ctx.close, "#each ")) {
        const collectionExpr = extractDirectiveArg(text, ctx.open, ctx.close, "#each ");
        const endIdx = findClosingBlock(blocks, i, ctx, "#each ", "/each");
        if (endIdx === -1) {
          throw new TemplateError(
            `Unclosed {{#each ${collectionExpr}}}`,
            `#each ${collectionExpr}`,
            location,
            {
              tagName: `#each ${collectionExpr}`,
              paragraphIndex: i,
              sectionPath: location
            }
          );
        }

        const innerBlocks = blocks.slice(i + 1, endIdx);
        const items = resolvePath(ctx.data, collectionExpr);

        if (Array.isArray(items)) {
          for (let idx = 0; idx < items.length; idx++) {
            const itemData = buildLoopData(items[idx], idx, ctx.data);
            const innerCtx: TemplateContext = { ...ctx, data: itemData };
            const processed = processBodyContent(
              cloneBlocks(innerBlocks),
              innerCtx,
              `${location}[${idx}]`
            );
            result.push(...processed);
          }
        } else if (ctx.strict && items !== undefined && items !== null) {
          throw new TemplateError(
            `{{#each ${collectionExpr}}} expects an array, got ${typeof items}`,
            `#each ${collectionExpr}`,
            location,
            {
              tagName: `#each ${collectionExpr}`,
              paragraphIndex: i,
              sectionPath: location
            }
          );
        }

        i = endIdx + 1;
        continue;
      }

      // Check if this paragraph starts a block-level #if
      if (hasBlockDirective(text, ctx.open, ctx.close, "#if ")) {
        const condExpr = extractDirectiveArg(text, ctx.open, ctx.close, "#if ");
        const { elseIdx, endIdx } = findIfBlock(blocks, i, ctx);
        if (endIdx === -1) {
          throw new TemplateError(`Unclosed {{#if ${condExpr}}}`, `#if ${condExpr}`, location, {
            tagName: `#if ${condExpr}`,
            paragraphIndex: i,
            sectionPath: location
          });
        }

        const condValue = resolvePath(ctx.data, condExpr);
        let innerBlocks: BodyContent[];
        if (isTruthy(condValue)) {
          innerBlocks = blocks.slice(i + 1, elseIdx !== -1 ? elseIdx : endIdx);
        } else {
          innerBlocks = elseIdx !== -1 ? blocks.slice(elseIdx + 1, endIdx) : [];
        }

        const processed = processBodyContent(cloneBlocks(innerBlocks), ctx, location);
        result.push(...processed);

        i = endIdx + 1;
        continue;
      }

      // Regular paragraph — process inline templates
      try {
        const processed = processParagraph(block, ctx, `${location} para ${i}`);
        result.push(processed);
      } catch (err) {
        if (err instanceof TemplateError && err.tagName === undefined) {
          throw new TemplateError(err.message, err.placeholder, err.location, {
            cause: err.cause,
            tagName: err.placeholder,
            paragraphIndex: i,
            sectionPath: location
          });
        }
        throw err;
      }
      i++;
    } else if (block.type === "table") {
      const processed = processTable(block, ctx, `${location} table ${i}`);
      result.push(processed);
      i++;
    } else if (block.type === "sdt") {
      // Recursively process SDT content (StructuredDocumentTag)
      const sdt = block as StructuredDocumentTag;
      const processedContent = processBodyContent(
        sdt.content as BodyContent[],
        ctx,
        `${location} sdt ${i}`
      );
      result.push({
        ...sdt,
        content: processedContent as readonly (Paragraph | Run | Table)[]
      });
      i++;
    } else {
      result.push(block);
      i++;
    }
  }

  return result;
}

function processBlockList(
  blocks: (Paragraph | Table)[],
  ctx: TemplateContext,
  location: string
): (Paragraph | Table)[] {
  // Reuse body content processing, filtering to Paragraph | Table
  return processBodyContent(blocks as BodyContent[], ctx, location) as (Paragraph | Table)[];
}

// =============================================================================
// Paragraph processing (inline variable substitution)
// =============================================================================

function processParagraph(para: Paragraph, ctx: TemplateContext, location: string): Paragraph {
  // Merge all run text, resolve inline variables, then rebuild runs
  const fullText = extractParagraphText(para);

  // Quick check: does this paragraph contain any delimiters?
  if (!fullText.includes(ctx.open)) {
    return para;
  }

  // Tokenize and evaluate inline expressions
  const tokens = tokenize(fullText, ctx.open, ctx.close);
  const resolved = evaluateInlineTokens(tokens, ctx, location);

  // If the text didn't change, return as-is
  if (resolved === fullText) {
    return para;
  }

  // Rebuild the paragraph runs with the resolved text
  return rebuildParagraphText(para, resolved);
}

/**
 * Evaluate inline tokens (only variables and inline if/each within a single paragraph line).
 * For simplicity, inline conditionals and loops are evaluated as text.
 */
function evaluateInlineTokens(tokens: Token[], ctx: TemplateContext, location: string): string {
  let result = "";
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    switch (token.type) {
      case TokenType.Text:
        result += token.value;
        i++;
        break;

      case TokenType.Variable: {
        const path = token.path;
        let value: unknown;
        if (path === "@index") {
          value = resolvePath(ctx.data, "@index");
        } else {
          value = resolvePath(ctx.data, path);
        }
        if (value === undefined && ctx.strict) {
          throw new TemplateError(`Unresolved variable: {{${path}}}`, path, location, {
            tagName: path,
            sectionPath: location
          });
        }
        result += valueToString(value);
        i++;
        break;
      }

      case TokenType.IfOpen: {
        // Inline if: collect tokens until matching /if
        const condValue = resolvePath(ctx.data, token.condition);
        const { trueBranch, falseBranch, endIndex } = collectInlineIf(tokens, i);
        if (endIndex === -1) {
          throw new TemplateError(
            `Unclosed inline {{#if ${token.condition}}}`,
            `#if ${token.condition}`,
            location,
            { tagName: `#if ${token.condition}`, sectionPath: location }
          );
        }

        if (isTruthy(condValue)) {
          result += evaluateInlineTokens(trueBranch, ctx, location);
        } else {
          result += evaluateInlineTokens(falseBranch, ctx, location);
        }
        i = endIndex + 1;
        break;
      }

      case TokenType.EachOpen: {
        // Inline each: collect tokens until matching /each
        const items = resolvePath(ctx.data, token.collection);
        const { body, endIndex } = collectInlineEach(tokens, i);
        if (endIndex === -1) {
          throw new TemplateError(
            `Unclosed inline {{#each ${token.collection}}}`,
            `#each ${token.collection}`,
            location,
            { tagName: `#each ${token.collection}`, sectionPath: location }
          );
        }

        if (Array.isArray(items)) {
          for (let idx = 0; idx < items.length; idx++) {
            const itemData = buildLoopData(items[idx], idx, ctx.data);
            const innerCtx: TemplateContext = { ...ctx, data: itemData };
            result += evaluateInlineTokens(body, innerCtx, location);
          }
        }
        i = endIndex + 1;
        break;
      }

      default:
        // Stray else/close tokens — skip
        i++;
        break;
    }
  }

  return result;
}

function collectInlineIf(
  tokens: Token[],
  startIdx: number
): {
  trueBranch: Token[];
  falseBranch: Token[];
  /** Index of the matching `{{/if}}` token, or -1 if no closing tag exists. */
  endIndex: number;
} {
  let depth = 0;
  const trueBranch: Token[] = [];
  const falseBranch: Token[] = [];
  let inElse = false;
  let endIndex = -1;

  for (let i = startIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === TokenType.IfOpen) {
      depth++;
      (inElse ? falseBranch : trueBranch).push(t);
    } else if (t.type === TokenType.IfClose) {
      if (depth === 0) {
        endIndex = i;
        break;
      }
      depth--;
      (inElse ? falseBranch : trueBranch).push(t);
    } else if (t.type === TokenType.Else && depth === 0) {
      inElse = true;
    } else {
      (inElse ? falseBranch : trueBranch).push(t);
    }
  }

  return { trueBranch, falseBranch, endIndex };
}

function collectInlineEach(
  tokens: Token[],
  startIdx: number
): {
  body: Token[];
  /** Index of the matching `{{/each}}` token, or -1 if no closing tag exists. */
  endIndex: number;
} {
  let depth = 0;
  const body: Token[] = [];
  let endIndex = -1;

  for (let i = startIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === TokenType.EachOpen) {
      depth++;
      body.push(t);
    } else if (t.type === TokenType.EachClose) {
      if (depth === 0) {
        endIndex = i;
        break;
      }
      depth--;
      body.push(t);
    } else {
      body.push(t);
    }
  }

  return { body, endIndex };
}

// =============================================================================
// Rebuild paragraph with new text content
// =============================================================================

/**
 * Rebuild a paragraph's run text content with a new resolved string.
 * Preserves the formatting of the first text run.
 */
function rebuildParagraphText(para: Paragraph, newText: string): Paragraph {
  // Find the first run with text content to use as formatting reference
  let refProperties: RunProperties | undefined;
  for (const child of para.children) {
    if (!isRun(child)) {
      continue;
    }
    for (const c of child.content) {
      if (c.type === "text") {
        refProperties = child.properties;
        break;
      }
    }
    if (refProperties !== undefined) {
      break;
    }
  }

  // If no text runs found, get properties from first run
  if (refProperties === undefined) {
    for (const child of para.children) {
      if (isRun(child)) {
        refProperties = child.properties;
        break;
      }
    }
  }

  // Build new children:
  //   - replace the first Run we see with `newRun` (carrying the resolved text);
  //   - drop every other Run (their text was already concatenated into newText);
  //   - keep non-Run children (bookmarkStart / bookmarkEnd / commentRangeStart /
  //     commentRangeEnd / hyperlink / insertedRun / movedToRun / etc.) at
  //     their original index. Reordering these silently miswires bookmark and
  //     comment ranges, since the start/end markers stop bracketing the
  //     intended content.
  const newRun: Run = {
    properties: refProperties,
    content: [{ type: "text", text: newText }]
  };

  const newChildren: ParagraphChild[] = [];
  let runReplaced = false;
  for (const child of para.children) {
    if (isRun(child)) {
      if (!runReplaced) {
        newChildren.push(newRun);
        runReplaced = true;
      }
      // Subsequent runs are absorbed into newRun's text — drop them.
    } else {
      newChildren.push(child);
    }
  }
  // If the paragraph had no runs at all (rare — typically all bookmark
  // markers), append newRun at the end so the rendered text still appears.
  if (!runReplaced) {
    newChildren.push(newRun);
  }

  return {
    ...para,
    children: newChildren
  };
}

// =============================================================================
// Table processing (row-level loops)
// =============================================================================

function processTable(table: Table, ctx: TemplateContext, location: string): Table {
  const newRows: TableRow[] = [];

  let i = 0;
  while (i < table.rows.length) {
    const row = table.rows[i];
    const rowText = extractRowText(row);

    // Check if this row contains a #each directive
    if (rowText.includes(ctx.open + "#each ") || rowText.includes(ctx.open + " #each ")) {
      const collectionExpr = extractDirectiveFromText(rowText, ctx.open, ctx.close, "#each ");

      if (collectionExpr) {
        // Find the closing row
        const endRowIdx = findClosingTableRow(table.rows, i, ctx);
        if (endRowIdx === -1) {
          throw new TemplateError(
            `Unclosed {{#each ${collectionExpr}}} in table row`,
            `#each ${collectionExpr}`,
            location,
            {
              tagName: `#each ${collectionExpr}`,
              paragraphIndex: i,
              sectionPath: location
            }
          );
        }

        const items = resolvePath(ctx.data, collectionExpr);

        if (Array.isArray(items)) {
          // If the loop is on a single row (open and close on same row)
          if (endRowIdx === i) {
            for (let idx = 0; idx < items.length; idx++) {
              const itemData = buildLoopData(items[idx], idx, ctx.data);
              const innerCtx: TemplateContext = { ...ctx, data: itemData };
              const clonedRow = cloneRow(row);
              const processedRow = processTableRow(clonedRow, innerCtx, location);
              // Strip the #each and /each tags from the row
              const cleanedRow = stripDirectivesFromRow(processedRow, ctx, "#each ", "/each");
              newRows.push(cleanedRow);
            }
          } else {
            // Multi-row loop: duplicate all rows between open and close
            const templateRows = table.rows.slice(i, endRowIdx + 1);
            for (let idx = 0; idx < items.length; idx++) {
              const itemData = buildLoopData(items[idx], idx, ctx.data);
              const innerCtx: TemplateContext = { ...ctx, data: itemData };
              for (const templateRow of templateRows) {
                const clonedRow = cloneRow(templateRow);
                const processedRow = processTableRow(clonedRow, innerCtx, location);
                const cleanedRow = stripDirectivesFromRow(processedRow, ctx, "#each ", "/each");
                newRows.push(cleanedRow);
              }
            }
          }
        }

        i = endRowIdx + 1;
        continue;
      }
    }

    // Regular row: process inline templates in each cell
    const processedRow = processTableRow(row, ctx, location);
    newRows.push(processedRow);
    i++;
  }

  return {
    ...table,
    rows: newRows
  };
}

function processTableRow(row: TableRow, ctx: TemplateContext, location: string): TableRow {
  const newCells: TableCell[] = [];
  for (const cell of row.cells) {
    const newContent: (Paragraph | Table)[] = [];
    for (const block of cell.content) {
      if (block.type === "paragraph") {
        newContent.push(processParagraph(block, ctx, location));
      } else if (block.type === "table") {
        newContent.push(processTable(block, ctx, location));
      } else {
        newContent.push(block as Paragraph | Table);
      }
    }
    newCells.push({ ...cell, content: newContent });
  }
  return { ...row, cells: newCells };
}

function extractRowText(row: TableRow): string {
  let text = "";
  for (const cell of row.cells) {
    for (const block of cell.content) {
      if (block.type === "paragraph") {
        text += extractParagraphText(block);
      }
    }
  }
  return text;
}

function findClosingTableRow(
  rows: readonly TableRow[],
  startIdx: number,
  ctx: TemplateContext
): number {
  // We start AFTER having seen exactly one `{{#each ...}}` token, so the
  // virtual depth at the boundary into row `startIdx` is 1. Each row can
  // contain any mix of `{{#each ...}}` opens and `{{/each}}` closes; we
  // increment the depth by `opens` and decrement by `closes`. The first
  // row where depth hits zero is the closing row.
  //
  // A previous implementation lumped both adjustments together and
  // returned as soon as `depth === 0 && closes > 0`, which mis-handled
  // rows containing two opens and one close (depth ends at 1, but the
  // intermediate calculation hit a transient zero).
  let depth = 1;
  for (let i = startIdx; i < rows.length; i++) {
    const text = extractRowText(rows[i]);
    let opens = countOccurrences(text, ctx.open + "#each ");
    const closes = countOccurrences(text, ctx.open + "/each" + ctx.close);
    // The opening `{{#each ...}}` of the current loop is in row
    // startIdx; don't count it as opening a new nested loop.
    if (i === startIdx && opens > 0) {
      opens--;
    }

    // Walk the row token-by-token in opens-then-closes order. We don't
    // know the actual interleave from raw counts, so we apply opens
    // first, then closes — opens always come before their matching
    // close in valid templates, and a row that closes more than it
    // opens (other than the top-level close in this very row) is
    // malformed input we should still terminate on.
    depth += opens;
    if (depth <= 0 && opens === 0 && closes === 0) {
      // Defensive: should never happen because we entered with depth=1.
      return -1;
    }
    if (closes >= depth) {
      // Consume `depth` worth of closes in this row; the remainder, if
      // any, is malformed but stops the search here.
      return i;
    }
    depth -= closes;
  }
  return -1;
}

function stripDirectivesFromRow(
  row: TableRow,
  ctx: TemplateContext,
  openDir: string,
  closeDir: string
): TableRow {
  const newCells: TableCell[] = [];
  for (const cell of row.cells) {
    const newContent: (Paragraph | Table)[] = [];
    for (const block of cell.content) {
      if (block.type === "paragraph") {
        const text = extractParagraphText(block);
        // Remove directive tags
        const openPattern = ctx.open + openDir;
        const closePattern = ctx.open + closeDir + ctx.close;

        if (text.includes(openPattern) || text.includes(closePattern)) {
          let cleaned = text;
          // Remove the entire {{#each ...}} tag
          const eachOpenRegex = new RegExp(
            escapeRegex(ctx.open) +
              "\\s*" +
              escapeRegex(openDir) +
              "[^" +
              escapeRegex(ctx.close.charAt(0)) +
              "]*" +
              escapeRegex(ctx.close),
            "g"
          );
          cleaned = cleaned.replace(eachOpenRegex, "");
          // Remove {{/each}}
          const eachCloseRegex = new RegExp(
            escapeRegex(ctx.open) +
              "\\s*" +
              escapeRegex(closeDir) +
              "\\s*" +
              escapeRegex(ctx.close),
            "g"
          );
          cleaned = cleaned.replace(eachCloseRegex, "");
          cleaned = cleaned.trim();

          if (cleaned.length > 0) {
            newContent.push(rebuildParagraphText(block, cleaned));
          } else {
            // Keep at least one paragraph in a cell
            newContent.push(rebuildParagraphText(block, ""));
          }
        } else {
          newContent.push(block);
        }
      } else {
        newContent.push(block);
      }
    }
    newCells.push({
      ...cell,
      content:
        newContent.length > 0 ? newContent : [{ type: "paragraph", children: [] } as Paragraph]
    });
  }
  return { ...row, cells: newCells };
}

// =============================================================================
// Block-level directive helpers
// =============================================================================

function hasBlockDirective(text: string, open: string, close: string, directive: string): boolean {
  // Block-level directives must occupy the *entire* paragraph (modulo
  // surrounding whitespace). A paragraph like "Hello {{#if x}}A{{/if}}"
  // contains an *inline* directive and must not be re-classified as a block
  // directive — otherwise the engine tries to find the block close on
  // following paragraphs and emits "Unclosed {{#if x}}" errors.
  const trimmed = text.trim();
  const opener = open + directive;
  if (!trimmed.startsWith(opener)) {
    return false;
  }
  // The opener tag must close before any other text follows. e.g. valid:
  //   "{{#if x}}"          → block
  //   "{{#if x}}\n"        → block
  //   "{{#if x}}foo"       → inline (has trailing content on same paragraph)
  const tagEnd = trimmed.indexOf(close, opener.length);
  if (tagEnd === -1) {
    return false;
  }
  const afterTag = trimmed.slice(tagEnd + close.length).trim();
  return afterTag.length === 0;
}

function extractDirectiveArg(text: string, open: string, close: string, directive: string): string {
  const startIdx = text.indexOf(open + directive);
  if (startIdx === -1) {
    // Try with space variations
    const idx = text.indexOf(open + " " + directive);
    if (idx === -1) {
      return "";
    }
    const argStart = idx + open.length + 1 + directive.length;
    const endIdx = text.indexOf(close, argStart);
    if (endIdx === -1) {
      return "";
    }
    return text.slice(argStart, endIdx).trim();
  }
  const argStart = startIdx + open.length + directive.length;
  const endIdx = text.indexOf(close, argStart);
  if (endIdx === -1) {
    return "";
  }
  return text.slice(argStart, endIdx).trim();
}

function extractDirectiveFromText(
  text: string,
  open: string,
  close: string,
  directive: string
): string | null {
  const pattern = open + directive;
  const idx = text.indexOf(pattern);
  if (idx === -1) {
    return null;
  }
  const argStart = idx + pattern.length;
  const endIdx = text.indexOf(close, argStart);
  if (endIdx === -1) {
    return null;
  }
  return text.slice(argStart, endIdx).trim();
}

function findClosingBlock(
  blocks: readonly BodyContent[],
  startIdx: number,
  ctx: TemplateContext,
  openDir: string,
  closeDir: string
): number {
  let depth = 0;
  for (let i = startIdx + 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "paragraph") {
      continue;
    }
    const text = extractParagraphText(block as Paragraph);
    if (hasBlockDirective(text, ctx.open, ctx.close, openDir)) {
      depth++;
    }
    if (
      text.includes(ctx.open + closeDir + ctx.close) ||
      text.includes(ctx.open + " " + closeDir + " " + ctx.close)
    ) {
      if (depth === 0) {
        return i;
      }
      depth--;
    }
  }
  return -1;
}

function findIfBlock(
  blocks: readonly BodyContent[],
  startIdx: number,
  ctx: TemplateContext
): { elseIdx: number; endIdx: number } {
  let depth = 0;
  let elseIdx = -1;

  for (let i = startIdx + 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "paragraph") {
      continue;
    }
    const text = extractParagraphText(block as Paragraph);

    // A single paragraph can legitimately contain both `{{#if cond}}` and
    // `{{/if}}` (an inline if). Count opens and closes independently so the
    // pairing logic stays correct in that case — the previous else-if chain
    // would advance `depth` and then skip the close, leaving the block
    // permanently unterminated.
    const openCount = countOccurrences(text, ctx.open + "#if ");
    const closeCount =
      countOccurrences(text, ctx.open + "/if" + ctx.close) +
      countOccurrences(text, ctx.open + " /if " + ctx.close);

    if (closeCount > 0) {
      // Account for inline opens first, then balance closes against the
      // outstanding depth.
      depth += openCount;
      for (let c = 0; c < closeCount; c++) {
        if (depth === 0) {
          return { elseIdx, endIdx: i };
        }
        depth--;
      }
    } else if (openCount > 0) {
      depth += openCount;
    } else if (
      depth === 0 &&
      (text.trim() === ctx.open + "else" + ctx.close ||
        text.includes(ctx.open + "else" + ctx.close))
    ) {
      elseIdx = i;
    }
  }

  return { elseIdx, endIdx: -1 };
}

// =============================================================================
// Loop data construction
// =============================================================================

function buildLoopData(
  item: unknown,
  index: number,
  parentData: Record<string, unknown>
): Record<string, unknown> {
  // Build the loop context on a null-prototype object so that an item
  // like `{ "__proto__": { injected: "X" } }` (which JSON.parse will
  // produce as an own enumerable data property — a known
  // prototype-pollution vector) cannot retarget the result's prototype
  // and leak hidden fields into the rendered document.
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(parentData)) {
    if (isForbiddenKey(key)) {
      // Skip dangerous keys at the parent level too.
      continue;
    }
    result[key] = parentData[key];
  }
  result["@index"] = index;
  result["."] = item;

  // If item is an object, spread its OWN properties so {{.name}} and
  // {{name}} both work. Skip the same dangerous key set defensively.
  if (item != null && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (isForbiddenKey(key)) {
        continue;
      }
      // Object.hasOwn ensures we never copy something that came from the
      // prototype (Object.keys already returns only own enumerables, but
      // belt-and-braces).
      if (Object.hasOwn(obj, key)) {
        result[key] = obj[key];
      }
    }
  }

  return result;
}

// =============================================================================
// Cloning helpers
// =============================================================================

function cloneBlocks(blocks: BodyContent[]): BodyContent[] {
  return structuredClone(blocks);
}

function cloneRow(row: TableRow): TableRow {
  return structuredClone(row);
}

// =============================================================================
// Utility
// =============================================================================

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(search, pos);
    if (idx === -1) {
      break;
    }
    count++;
    pos = idx + search.length;
  }
  return count;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// Tag Listing: discover all template placeholders in a document
// =============================================================================

/**
 * List all template tags found in a document.
 *
 * Scans body, headers, footers, footnotes, and endnotes for template
 * placeholders. Useful for validating data objects against templates.
 *
 * @param doc - The parsed DocxDocument model.
 * @param options - Optional settings (custom delimiters).
 * @returns Array of all discovered template tags.
 */
export function listTemplateTags(
  doc: DocxDocument,
  options?: Pick<TemplateOptions, "delimiters">
): TemplateTag[] {
  const open = options?.delimiters?.[0] ?? "{{";
  const close = options?.delimiters?.[1] ?? "}}";
  const tags: TemplateTag[] = [];

  function scanBlocks(blocks: readonly BodyContent[], location: string): void {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === "paragraph") {
        scanParagraph(block, `${location} paragraph ${i}`);
      } else if (block.type === "table") {
        scanTable(block, `${location} table ${i}`);
      }
    }
  }

  function scanParagraph(para: Paragraph, location: string): void {
    const text = extractParagraphText(para);
    scanText(text, location);
  }

  function scanTable(table: Table, location: string): void {
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r];
      for (let c = 0; c < row.cells.length; c++) {
        const cell = row.cells[c];
        for (let b = 0; b < cell.content.length; b++) {
          const block = cell.content[b];
          if (block.type === "paragraph") {
            scanParagraph(block as Paragraph, `${location} row ${r} cell ${c}`);
          } else if (block.type === "table") {
            scanTable(block as Table, `${location} row ${r} cell ${c}`);
          }
        }
      }
    }
  }

  function scanText(text: string, location: string): void {
    let pos = 0;
    while (pos < text.length) {
      const startIdx = text.indexOf(open, pos);
      if (startIdx === -1) {
        break;
      }
      const endIdx = text.indexOf(close, startIdx + open.length);
      if (endIdx === -1) {
        break;
      }
      const expr = text.slice(startIdx + open.length, endIdx).trim();
      pos = endIdx + close.length;

      if (expr.startsWith("#if ")) {
        tags.push({ expression: expr, type: "ifOpen", location });
      } else if (expr === "else") {
        tags.push({ expression: expr, type: "else", location });
      } else if (expr === "/if") {
        tags.push({ expression: expr, type: "ifClose", location });
      } else if (expr.startsWith("#each ")) {
        tags.push({ expression: expr, type: "eachOpen", location });
      } else if (expr === "/each") {
        tags.push({ expression: expr, type: "eachClose", location });
      } else if (expr.startsWith("#cols ")) {
        tags.push({ expression: expr, type: "colsOpen", location });
      } else if (expr === "/cols") {
        tags.push({ expression: expr, type: "colsClose", location });
      } else if (expr.startsWith("%")) {
        tags.push({ expression: expr, type: "image", location });
      } else if (expr.startsWith("&")) {
        tags.push({ expression: expr, type: "richText", location });
      } else if (expr.startsWith(">")) {
        tags.push({ expression: expr, type: "subDocument", location });
      } else if (expr.startsWith("^")) {
        tags.push({ expression: expr, type: "chart", location });
      } else if (expr.startsWith("!")) {
        tags.push({ expression: expr, type: "htmlChunk", location });
      } else {
        tags.push({ expression: expr, type: "variable", location });
      }
    }
  }

  // Scan body
  scanBlocks(doc.body, "body");

  // Scan headers
  if (doc.headers) {
    for (const [key, headerDef] of doc.headers) {
      scanBlocks(headerDef.content.children as BodyContent[], `header:${key}`);
    }
  }

  // Scan footers
  if (doc.footers) {
    for (const [key, footerDef] of doc.footers) {
      scanBlocks(footerDef.content.children as BodyContent[], `footer:${key}`);
    }
  }

  // Scan footnotes
  if (doc.footnotes) {
    for (const note of doc.footnotes) {
      if (note.id <= 0) {
        continue;
      }
      scanBlocks(note.content as BodyContent[], `footnote:${note.id}`);
    }
  }

  // Scan endnotes
  if (doc.endnotes) {
    for (const note of doc.endnotes) {
      if (note.id <= 0) {
        continue;
      }
      scanBlocks(note.content as BodyContent[], `endnote:${note.id}`);
    }
  }

  return tags;
}

// =============================================================================
// Enhanced value resolution for image/richText/subDocument
// =============================================================================

function isTemplateImage(v: unknown): v is TemplateImage {
  return v != null && typeof v === "object" && "image" in v && "width" in v && "height" in v;
}

function isTemplateRichText(v: unknown): v is TemplateRichText {
  if (!Array.isArray(v)) {
    return false;
  }
  // Check that it looks like an array of Run objects (has .content array)
  return v.length > 0 && "content" in v[0] && Array.isArray(v[0].content);
}

function isTemplateSubDocument(v: unknown): v is TemplateSubDocument {
  if (!Array.isArray(v)) {
    return false;
  }
  // Check that it looks like body content blocks (has .type)
  return v.length > 0 && "type" in v[0];
}

export function isTemplateChart(v: unknown): v is TemplateChart {
  return v != null && typeof v === "object" && "chart" in v && !("type" in v);
}

function isTemplateHtmlChunk(v: unknown): v is TemplateHtmlChunk {
  return (
    v != null &&
    typeof v === "object" &&
    "html" in v &&
    typeof (v as TemplateHtmlChunk).html === "string"
  );
}

/**
 * Enhanced fillTemplate that supports image (%img), richText (&rt),
 * subDocument (>sub), and chart (^chart) placeholders in addition to the
 * standard variable, conditional, and loop directives.
 *
 * Image placeholder: {{%imagePath}} — value must be a TemplateImage object.
 * RichText placeholder: {{&richPath}} — value must be TemplateRichText (Run[]).
 * SubDocument placeholder: {{>subPath}} — value must be TemplateSubDocument (BodyContent[]).
 * Chart placeholder: {{^chartPath}} — value must be a TemplateChart object.
 */
export function fillTemplateEnhanced(
  doc: DocxDocument,
  data: Record<string, unknown>,
  options?: TemplateOptions
): DocxDocument {
  const open = options?.delimiters?.[0] ?? "{{";
  const close = options?.delimiters?.[1] ?? "}}";
  const strict = options?.strict ?? true;

  // First pass: handle image / richText / subDocument in body
  const collectedImages: ImageDef[] = [];
  const newBody = processEnhancedBody(
    doc.body as BodyContent[],
    data,
    open,
    close,
    strict,
    collectedImages
  );

  // Second pass: standard fillTemplate. Note that `fillTemplate` mutates
  // its input doc in place (it edits `headerDef.content.children` and the
  // body array directly), so we hand it a deep-cloned wrapper to avoid
  // sneaking edits back into the caller's doc through shared references
  // (`modifiedDoc.headers === doc.headers` would otherwise propagate
  // mutations into `doc`).
  // Built before the images are merged, because the header and footer passes below
  // append to `collectedImages` while this object literal is being evaluated — so
  // the merge has to read it afterwards.
  const modifiedDoc: DocxDocument = {
    ...doc,
    body: newBody,
    // Headers and footers get the enhanced pass too, not just the clone. A logo in
    // a header is the case a template author is most likely to reach for, and
    // running only the basic fill there left `{{%logo}}` in the document as literal
    // text — or, under `strict`, failed the whole fill over a placeholder that had
    // been supplied correctly.
    ...(doc.headers
      ? {
          headers: new Map(
            Array.from(doc.headers, ([k, h]) => [
              k,
              {
                ...h,
                content: {
                  ...h.content,
                  children: processEnhancedBody(
                    h.content.children as BodyContent[],
                    data,
                    open,
                    close,
                    strict,
                    collectedImages
                  ) as readonly (Paragraph | Table)[]
                }
              }
            ])
          )
        }
      : {}),
    ...(doc.footers
      ? {
          footers: new Map(
            Array.from(doc.footers, ([k, f]) => [
              k,
              {
                ...f,
                content: {
                  ...f.content,
                  children: processEnhancedBody(
                    f.content.children as BodyContent[],
                    data,
                    open,
                    close,
                    strict,
                    collectedImages
                  ) as readonly (Paragraph | Table)[]
                }
              }
            ])
          )
        }
      : {}),
    ...(doc.footnotes
      ? { footnotes: doc.footnotes.map(fn => ({ ...fn, content: [...fn.content] })) }
      : {}),
    ...(doc.endnotes
      ? { endnotes: doc.endnotes.map(en => ({ ...en, content: [...en.content] })) }
      : {})
  };

  // Merged now, not while `modifiedDoc` was built: the header and footer passes above
  // append to `collectedImages`, so reading it any earlier would drop every picture
  // that came from one. Duplicates are avoided by file name, which is why a caller
  // supplying two images must give them distinct names.
  const images = doc.images ? [...doc.images] : [];
  for (const img of collectedImages) {
    if (!images.some(existing => existing.fileName === img.fileName)) {
      images.push(img);
    }
  }

  return fillTemplate(
    { ...modifiedDoc, images: images.length > 0 ? images : undefined },
    data,
    options
  );
}

function processEnhancedBody(
  blocks: readonly BodyContent[],
  data: Record<string, unknown>,
  open: string,
  close: string,
  strict: boolean,
  collectedImages: ImageDef[]
): BodyContent[] {
  const result: BodyContent[] = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (block.type === "paragraph") {
      const text = extractParagraphText(block);
      // Check for HTML chunk placeholder ({{!htmlPath}})
      const htmlMatch = matchSinglePlaceholder(text, open, close, "!");
      if (htmlMatch) {
        const value = resolvePath(data, htmlMatch);
        if (isTemplateHtmlChunk(value)) {
          const seq = nextAltChunkSeq();
          const altChunk: AltChunk = {
            type: "altChunk",
            // Use a process-monotonic sequence so two `fillTemplate`
            // calls on the same template don't collide on rId or path.
            rId: `rId_altchunk_${seq}`,
            contentType: value.contentType ?? "text/html",
            data: utf8Encoder.encode(value.html),
            fileName: `afchunk${seq}.html`
          };
          result.push(altChunk);
          continue;
        }
      }
      // Check for sub-document placeholder (entire paragraph is the placeholder)
      const subMatch = matchSinglePlaceholder(text, open, close, ">");
      if (subMatch) {
        const value = resolvePath(data, subMatch);
        if (isTemplateSubDocument(value)) {
          result.push(...value);
          continue;
        }
      }
      // Check for image placeholder (with optional conditional prefix)
      const imgMatch = matchSinglePlaceholder(text, open, close, "%");
      if (imgMatch) {
        // Check for conditional image: {{%?condPath.imagePath}}
        if (imgMatch.startsWith("?")) {
          const rest = imgMatch.slice(1); // remove leading '?'
          const dotIdx = rest.indexOf(".");
          if (dotIdx !== -1) {
            const condPath = rest.slice(0, dotIdx);
            const imagePath = rest.slice(dotIdx + 1);
            const condValue = resolvePath(data, condPath);
            if (!isTruthy(condValue)) {
              // Condition is falsy — skip, don't insert anything
              continue;
            }
            // Condition is truthy — resolve the image
            const value = resolvePath(data, imagePath);
            if (isTemplateImage(value)) {
              const safeFileName = sanitizeTemplateImageFileName(value.image.fileName);
              const rId = value.image.rId ?? `rId_tpl_${nextTemplateImageSeq()}`;
              const imgContent: InlineImageContent = {
                type: "image",
                rId,
                width: value.width,
                height: value.height,
                altText: value.altText ?? safeFileName,
                name: safeFileName
              };
              const newPara: Paragraph = {
                type: "paragraph",
                properties: block.properties,
                children: [{ content: [imgContent] } as Run]
              };
              result.push(newPara);
              collectedImages.push({ ...value.image, rId, fileName: safeFileName } as ImageDef);
              continue;
            }
          }
        }
        // Standard image placeholder (no conditional)
        const value = resolvePath(data, imgMatch);
        if (isTemplateImage(value)) {
          const safeFileName = sanitizeTemplateImageFileName(value.image.fileName);
          const rId = value.image.rId ?? `rId_tpl_${nextTemplateImageSeq()}`;
          const imgContent: InlineImageContent = {
            type: "image",
            rId,
            width: value.width,
            height: value.height,
            altText: value.altText ?? safeFileName,
            name: safeFileName
          };
          const newPara: Paragraph = {
            type: "paragraph",
            properties: block.properties,
            children: [{ content: [imgContent] } as Run]
          };
          result.push(newPara);
          // Register image for packaging
          collectedImages.push({ ...value.image, rId, fileName: safeFileName } as ImageDef);
          continue;
        }
      }
      // Check for richText placeholder
      const rtMatch = matchSinglePlaceholder(text, open, close, "&");
      if (rtMatch) {
        const value = resolvePath(data, rtMatch);
        if (isTemplateRichText(value)) {
          const newPara: Paragraph = {
            type: "paragraph",
            properties: block.properties,
            children: [...value] as ParagraphChild[]
          };
          result.push(newPara);
          continue;
        }
      }
      // Check for chart placeholder
      const chartMatch = matchSinglePlaceholder(text, open, close, "^");
      if (chartMatch) {
        const value = resolvePath(data, chartMatch);
        if (isTemplateChart(value)) {
          const chartContent: ChartContent = {
            type: "chart",
            chart: value.chart,
            altText: value.altText,
            name: value.name
          };
          result.push(chartContent);
          continue;
        }
      }
      result.push(block);
    } else if (block.type === "table") {
      // Process table column loops, then the enhanced placeholders inside each
      // cell. A cell holds the same block list a body does, so the same pass
      // applies — and a picture in a table cell is how a great many templates lay
      // out a letterhead, so not descending here made the commonest placement the
      // one that could not be filled.
      const processed = processTableColumnLoop(block, data, open, close, strict);
      result.push(processEnhancedTable(processed, data, open, close, strict, collectedImages));
    } else if (block.type === "sdt") {
      // Recursively process SDT content
      const sdt = block as StructuredDocumentTag;
      const processedContent = processEnhancedBody(
        sdt.content as BodyContent[],
        data,
        open,
        close,
        strict,
        collectedImages
      );
      result.push({
        ...sdt,
        content: processedContent as readonly (Paragraph | Run | Table)[]
      });
    } else {
      result.push(block);
    }
  }
  return result;
}

/**
 * Run the enhanced pass over every cell of a table.
 *
 * Rebuilt rather than mutated because `Table`, `TableRow` and `TableCell` are all
 * readonly, and a cell's content is the same `Paragraph | Table` list the body holds
 * — so nested tables are handled by the recursion rather than by a special case.
 */
function processEnhancedTable(
  table: Table,
  data: Record<string, unknown>,
  open: string,
  close: string,
  strict: boolean,
  collectedImages: ImageDef[]
): Table {
  return {
    ...table,
    rows: table.rows.map(row => ({
      ...row,
      cells: row.cells.map(cell => ({
        ...cell,
        content: processEnhancedBody(
          cell.content as BodyContent[],
          data,
          open,
          close,
          strict,
          collectedImages
        ) as readonly (Paragraph | Table)[]
      }))
    }))
  };
}

/** Match a single-placeholder paragraph: {{<prefix><path>}} */
function matchSinglePlaceholder(
  text: string,
  open: string,
  close: string,
  prefix: string
): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) {
    return null;
  }
  const inner = trimmed.slice(open.length, trimmed.length - close.length).trim();
  if (!inner.startsWith(prefix)) {
    return null;
  }
  return inner.slice(prefix.length).trim();
}

// =============================================================================
// Table Column Loop: {{#cols items}}...{{/cols}}
// =============================================================================

function processTableColumnLoop(
  table: Table,
  data: Record<string, unknown>,
  open: string,
  close: string,
  _strict: boolean
): Table {
  // Check if any cell in the first row contains a #cols directive
  if (table.rows.length === 0) {
    return table;
  }

  const firstRow = table.rows[0];
  let colsExpr: string | null = null;
  let templateColIdx = -1;

  for (let c = 0; c < firstRow.cells.length; c++) {
    const cell = firstRow.cells[c];
    for (const block of cell.content) {
      if (block.type === "paragraph") {
        const text = extractParagraphText(block as Paragraph);
        const pattern = open + "#cols ";
        if (text.includes(pattern)) {
          colsExpr = extractDirectiveFromText(text, open, close, "#cols ");
          templateColIdx = c;
          break;
        }
      }
    }
    if (colsExpr) {
      break;
    }
  }

  if (!colsExpr || templateColIdx === -1) {
    return table;
  }

  // Find closing {{/cols}} column
  let closeColIdx = templateColIdx;
  for (let c = templateColIdx; c < firstRow.cells.length; c++) {
    const cell = firstRow.cells[c];
    for (const block of cell.content) {
      if (block.type === "paragraph") {
        const text = extractParagraphText(block as Paragraph);
        if (text.includes(open + "/cols" + close) || text.includes(open + " /cols " + close)) {
          closeColIdx = c;
          break;
        }
      }
    }
  }

  const items = resolvePath(data, colsExpr);
  if (!Array.isArray(items)) {
    return table;
  }

  // For each row, duplicate the template columns for each item
  const newRows: TableRow[] = [];
  for (const row of table.rows) {
    const beforeCells = row.cells.slice(0, templateColIdx);
    const templateCells = row.cells.slice(templateColIdx, closeColIdx + 1);
    const afterCells = row.cells.slice(closeColIdx + 1);

    const expandedCells: TableCell[] = [...beforeCells];

    for (let idx = 0; idx < items.length; idx++) {
      for (const templateCell of templateCells) {
        const clonedCell: TableCell = structuredClone(templateCell);
        // Strip #cols and /cols directives from text
        for (let b = 0; b < clonedCell.content.length; b++) {
          const block = clonedCell.content[b];
          if (block.type === "paragraph") {
            const text = extractParagraphText(block as Paragraph);
            let cleaned = text;
            const colsOpenRegex = new RegExp(
              escapeRegex(open) +
                "\\s*#cols\\s+[^" +
                escapeRegex(close.charAt(0)) +
                "]*" +
                escapeRegex(close),
              "g"
            );
            cleaned = cleaned.replace(colsOpenRegex, "");
            const colsCloseRegex = new RegExp(
              escapeRegex(open) + "\\s*/cols\\s*" + escapeRegex(close),
              "g"
            );
            cleaned = cleaned.replace(colsCloseRegex, "");

            // Resolve item variables
            const itemData = buildLoopData(items[idx], idx, data);
            const tokens = tokenize(cleaned, open, close);
            const ctx: TemplateContext = { open, close, strict: false, data: itemData };
            const resolved = evaluateInlineTokens(tokens, ctx, "colLoop");
            if (resolved !== text) {
              (clonedCell.content as (Paragraph | Table)[])[b] = rebuildParagraphText(
                block as Paragraph,
                resolved
              );
            } else if (cleaned !== text) {
              (clonedCell.content as (Paragraph | Table)[])[b] = rebuildParagraphText(
                block as Paragraph,
                cleaned
              );
            }
          }
        }
        expandedCells.push(clonedCell);
      }
    }

    expandedCells.push(...afterCells);

    // Update grid (tblGrid) if needed: we'll leave that to the caller
    newRows.push({ ...row, cells: expandedCells });
  }

  return { ...table, rows: newRows };
}

// =============================================================================
// rId allocation helpers
// =============================================================================
//
// Template-generated parts (alt chunks, dynamic images) need stable but
// non-colliding rIds. Earlier versions of this module derived the rId
// from `blockIndex` or the image's `fileName`, which collided as soon as
// the same template was filled twice or two distinct images shared a
// file name. We now use module-level monotonic counters so each generated
// part gets a unique rId for the lifetime of the process.

let _altChunkSeq = 0;
let _templateImageSeq = 0;
function nextAltChunkSeq(): number {
  _altChunkSeq++;
  return _altChunkSeq;
}
function nextTemplateImageSeq(): number {
  _templateImageSeq++;
  return _templateImageSeq;
}

/**
 * Strip path-traversal segments and other unsafe characters from a
 * caller-supplied image file name so it can be safely used as a ZIP
 * entry path inside the package. Mirrors the equivalent helper in
 * `convert/odt/odt.ts`.
 */
function sanitizeTemplateImageFileName(raw: string | undefined): string {
  if (!raw) {
    return "image.bin";
  }
  const lastSep = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  let leaf = lastSep >= 0 ? raw.substring(lastSep + 1) : raw;
  while (leaf.startsWith(".")) {
    leaf = leaf.substring(1);
  }
  leaf = leaf.replace(/[^A-Za-z0-9._-]/g, "_");
  leaf = leaf.replace(/\.{2,}/g, ".");
  return leaf || "image.bin";
}
