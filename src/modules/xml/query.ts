/**
 * XML Path Query Engine
 *
 * Simplified path expressions for querying XML DOM trees.
 * Covers the most common query patterns without the complexity of full XPath.
 *
 * Supported syntax:
 * - `a/b/c`         — match child `a`, then child `b`, then child `c`
 * - `a/b[@id='1']`  — match child `b` with attribute `id` equal to `"1"`
 * - `a/*`            — wildcard: any element name at that level; valid in any step
 * - `a//c`           — recursive descent: `c` at any depth under `a`
 * - `a/b[0]`         — index: first matching `b` under each parent `a`
 *
 * Functions:
 * - `query(el, path)`    — first match or undefined
 * - `queryAll(el, path)` — all matches
 */

import type { XmlElement } from "@xml/types";

// =============================================================================
// Path Parsing
// =============================================================================

interface PathStep {
  /** Element name to match, or "*" for wildcard. */
  name: string;
  /** If true, match at any depth (recursive descent `//`). */
  recursive: boolean;
  /** Attribute filter: `[@key='value']`. */
  attrFilter?: { key: string; value: string };
  /** Index filter: `[N]`. */
  index?: number;
}

/**
 * Parse a simplified path expression into steps.
 *
 * Examples:
 *   "a/b/c"            → [a, b, c]
 *   "a//c"             → [a, c(recursive)]
 *   "a/b[@id='1']"     → [a, b(attr:id=1)]
 *   "a/b[0]"           → [a, b(index:0)]
 */
function parsePath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  const parts = path.split("/");

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];

    // Handle "//" — produces an empty string between two slashes
    // Also handles leading "//" (path starts with "//")
    if (part === "" && i + 1 < parts.length && parts[i + 1] !== "") {
      i++;
      steps.push(parseStep(parts[i], true));
      i++;
      continue;
    }

    if (part === "") {
      i++;
      continue;
    }

    steps.push(parseStep(part, false));
    i++;
  }

  return steps;
}

const STEP_RE = /^([^[]+)(?:\[@([\w:.-]+)='([^']*)'\]|\[(\d+)\])?$/;

function parseStep(raw: string, recursive: boolean): PathStep {
  const m = STEP_RE.exec(raw);
  if (!m) {
    return { name: raw, recursive };
  }

  const step: PathStep = { name: m[1], recursive };

  if (m[2] !== undefined) {
    // Attribute filter: [@key='value']
    step.attrFilter = { key: m[2], value: m[3] };
  } else if (m[4] !== undefined) {
    // Index filter: [N]
    step.index = parseInt(m[4], 10);
  }

  return step;
}

// =============================================================================
// Step Matching
// =============================================================================

function matchesName(el: XmlElement, name: string): boolean {
  if (name === "*") {
    return true;
  }
  return el.name === name;
}

function matchesFilter(el: XmlElement, step: PathStep): boolean {
  if (!matchesName(el, step.name)) {
    return false;
  }
  if (step.attrFilter) {
    return el.attributes[step.attrFilter.key] === step.attrFilter.value;
  }
  return true;
}

/** Get direct child elements matching a step (no index applied). */
function matchChildren(el: XmlElement, step: PathStep): XmlElement[] {
  const results: XmlElement[] = [];
  for (const child of el.children) {
    if (child.type === "element" && matchesFilter(child, step)) {
      results.push(child);
    }
  }
  return results;
}

/** Get all descendant elements matching a step (recursive descent, document order). */
function matchDescendants(el: XmlElement, step: PathStep): XmlElement[] {
  const results: XmlElement[] = [];
  function recurse(node: XmlElement): void {
    for (const child of node.children) {
      if (child.type === "element") {
        if (matchesFilter(child, step)) {
          results.push(child);
        }
        recurse(child);
      }
    }
  }
  recurse(el);
  return results;
}

/** Apply a single step to a set of context elements, returning the next set. */
function applyStep(contexts: XmlElement[], step: PathStep): XmlElement[] {
  let results: XmlElement[] = [];

  if (step.index !== undefined) {
    // Per-parent index: for each context, find the Nth match among its children/descendants.
    const idx = step.index;
    for (const ctx of contexts) {
      const matches = step.recursive ? matchDescendants(ctx, step) : matchChildren(ctx, step);
      if (idx >= 0 && idx < matches.length) {
        results.push(matches[idx]);
      }
    }
  } else {
    for (const ctx of contexts) {
      if (step.recursive) {
        results = results.concat(matchDescendants(ctx, step));
      } else {
        results = results.concat(matchChildren(ctx, step));
      }
    }
  }

  return results;
}

// =============================================================================
// Public API
// =============================================================================

/** Internal: run a parsed path against a root element, return all matches. */
function runQuery(element: XmlElement, path: string): XmlElement[] {
  const steps = parsePath(path);
  let contexts: XmlElement[] = [element];

  for (const step of steps) {
    contexts = applyStep(contexts, step);
    if (contexts.length === 0) {
      return contexts;
    }
  }

  return contexts;
}

/**
 * Find the first element matching a path expression.
 *
 * @param element - The context element to search from.
 * @param path - Simplified path expression.
 * @returns The first matching element, or undefined.
 *
 * @example
 * ```ts
 * const cell = query(doc.root, "sheetData/row/c[@r='A1']");
 * const value = query(doc.root, "sheetData/row/c/v");
 * const any = query(doc.root, "sheetData//v");  // recursive descent
 * ```
 */
function query(element: XmlElement, path: string): XmlElement | undefined {
  return runQuery(element, path)[0];
}

/**
 * Find all elements matching a path expression.
 *
 * @param element - The context element to search from.
 * @param path - Simplified path expression.
 * @returns Array of all matching elements (may be empty).
 *
 * @example
 * ```ts
 * const rows = queryAll(doc.root, "sheetData/row");
 * const cells = queryAll(doc.root, "sheetData/row/c");
 * const allValues = queryAll(doc.root, "sheetData//v");
 * ```
 */
function queryAll(element: XmlElement, path: string): XmlElement[] {
  return runQuery(element, path);
}

export { query, queryAll };
