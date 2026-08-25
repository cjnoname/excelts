/**
 * Emphasis conformance — CommonMark 0.30 §6.2.
 *
 * The importer used to match emphasis by scanning forward from a delimiter for
 * a closing one and recursing on what lay between. That cannot express the cases
 * the spec is careful about, and could not be patched into doing so: the length
 * an opener contributes is not known until its partner is, and a closer has to
 * take the *nearest* opener rather than the first one that happens to be open.
 * `processEmphasis` implements the spec's delimiter stack instead, and this file
 * is the evidence.
 *
 * **Comparison is on flattened formatting, not on tree shape.** Word has no
 * nesting: a run carries `bold` and `italic` flags, so `<em><em>x</em></em>` and
 * `<em>x</em>` are the same document. Both sides are therefore reduced to
 * per-character formatting before being compared, which is also why the
 * expectations can be written as the spec's own HTML.
 */
import { describe, it, expect } from "vitest";

import { markdownToDocx } from "../convert/markdown/markdown-import";
import type { Paragraph, ParagraphChild } from "../types";

interface Piece {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

/** Group a character stream by formatting, so `[i]foo[bi]bar` reads at a glance. */
function normalise(pieces: readonly Piece[]): string {
  const out: string[] = [];
  let current = "";
  let key = "\u0000";
  for (const piece of pieces) {
    const k = `${piece.bold ? "b" : ""}${piece.italic ? "i" : ""}`;
    for (const ch of piece.text) {
      if (k !== key) {
        if (current.length > 0) {
          out.push(`[${key}]${current}`);
        }
        current = "";
        key = k;
      }
      current += ch;
    }
  }
  if (current.length > 0) {
    out.push(`[${key}]${current}`);
  }
  return out.join("");
}

/** The reference HTML, reduced to per-character formatting. */
function flattenHtml(html: string): string {
  const pieces: Piece[] = [];
  const open: string[] = [];
  let i = 0;
  while (i < html.length) {
    const tag = /^<(\/?)(em|strong)>/.exec(html.slice(i));
    if (tag) {
      if (tag[1] === "/") {
        open.pop();
      } else {
        open.push(tag[2]);
      }
      i += tag[0].length;
      continue;
    }
    pieces.push({
      text: html[i],
      bold: open.includes("strong"),
      italic: open.includes("em")
    });
    i++;
  }
  return normalise(pieces);
}

/** The converted paragraph, reduced the same way. */
async function flattenMarkdown(markdown: string): Promise<string> {
  const doc = await markdownToDocx(markdown);
  const block = doc.body[0];
  if (block === undefined || block.type !== "paragraph") {
    return "";
  }
  const pieces: Piece[] = [];
  const walk = (children: readonly ParagraphChild[]): void => {
    for (const child of children) {
      if ("type" in child && child.type === "hyperlink") {
        walk(child.children);
        continue;
      }
      if (!("content" in child)) {
        continue;
      }
      pieces.push({
        text: child.content.map(c => (c.type === "text" ? c.text : "")).join(""),
        bold: child.properties?.bold === true,
        italic: child.properties?.italic === true
      });
    }
  };
  walk((block satisfies Paragraph).children);
  return normalise(pieces);
}

/**
 * Input → the reference rendering.
 *
 * Inputs are deliberately free of block-level ambiguity: `* a *` is a list and
 * `***` a thematic break, so neither says anything about emphasis.
 */
const EXAMPLES: ReadonlyArray<readonly [string, string]> = [
  // Rule 1 — `*` opens when left-flanking.
  ["*foo bar*", "<em>foo bar</em>"],
  ["a * foo bar*", "a * foo bar*"],
  ['a*"foo"*', 'a*"foo"*'],
  ["foo*bar*", "foo<em>bar</em>"],
  ["5*6*78", "5<em>6</em>78"],
  // Rule 2 — `_` opens only outside a word.
  ["_foo bar_", "<em>foo bar</em>"],
  ["_ foo bar_", "_ foo bar_"],
  ['a_"foo"_', 'a_"foo"_'],
  ["foo_bar_", "foo_bar_"],
  ["5_6_78", "5_6_78"],
  ['aa_"bb"_cc', 'aa_"bb"_cc'],
  ["foo-_(bar)_", "foo-<em>(bar)</em>"],
  // Rule 3 — `*` closes when right-flanking.
  ["_foo*", "_foo*"],
  ["*foo bar *", "*foo bar *"],
  ["*(*foo)", "*(*foo)"],
  ["*(*foo*)*", "<em>(<em>foo</em>)</em>"],
  ["*foo*bar", "<em>foo</em>bar"],
  // Rule 4 — `_` closes only outside a word.
  ["_foo bar _", "_foo bar _"],
  ["_(_foo)", "_(_foo)"],
  ["_(_foo_)_", "<em>(<em>foo</em>)</em>"],
  ["_foo_bar", "_foo_bar"],
  ["_foo_bar_baz_", "<em>foo_bar_baz</em>"],
  ["_(bar)_.", "<em>(bar)</em>."],
  // Rules 5–8 — the same four for strong emphasis.
  ["**foo bar**", "<strong>foo bar</strong>"],
  ["** foo bar**", "** foo bar**"],
  ['a**"foo"**', 'a**"foo"**'],
  ["foo**bar**", "foo<strong>bar</strong>"],
  ["__foo bar__", "<strong>foo bar</strong>"],
  ["__ foo bar__", "__ foo bar__"],
  ['a__"foo"__', 'a__"foo"__'],
  ["foo__bar__", "foo__bar__"],
  ["5__6__78", "5__6__78"],
  ["__foo, __bar__, baz__", "<strong>foo, <strong>bar</strong>, baz</strong>"],
  ["foo-__(bar)__", "foo-<strong>(bar)</strong>"],
  ["**foo bar **", "**foo bar **"],
  ["**(**foo)", "**(**foo)"],
  // Rule 9/10 — a closer takes the nearest opener, and the two runs need not be
  // the same length. Every one of these was wrong before the delimiter stack.
  ["*(**foo**)*", "<em>(<strong>foo</strong>)</em>"],
  ["**foo*", "*<em>foo</em>"],
  ["*foo**", "<em>foo</em>*"],
  ["***foo**", "*<strong>foo</strong>"],
  ["***foo*", "**<em>foo</em>"],
  ["**foo***", "<strong>foo</strong>*"],
  ["*foo****", "<em>foo</em>***"],
  ["*bar***", "<em>bar</em>**"],
  ["*foo**bar**baz*", "<em>foo<strong>bar</strong>baz</em>"],
  ["*foo**bar*", "<em>foo**bar</em>"],
  ["*foo**bar***", "<em>foo<strong>bar</strong></em>"],
  ["***foo* bar**", "<strong><em>foo</em> bar</strong>"],
  ["***foo** bar*", "<em><strong>foo</strong> bar</em>"],
  ["**foo *bar***", "<strong>foo <em>bar</em></strong>"],
  ["*foo **bar** baz*", "<em>foo <strong>bar</strong> baz</em>"],
  ["*foo _bar* baz_", "<em>foo _bar</em> baz_"],
  // Runs longer than two, consumed two at a time.
  ["****foo****", "<strong><strong>foo</strong></strong>"],
  ["____foo____", "<strong><strong>foo</strong></strong>"],
  ["***foo***", "<em><strong>foo</strong></em>"],
  ["_____foo_____", "<em><strong><strong>foo</strong></strong></em>"],
  ["foo***bar***baz", "foo<em><strong>bar</strong></em>baz"],
  ["foo******bar*********baz", "foo<strong><strong><strong>bar</strong></strong></strong>***baz"],
  // Unmatched delimiters survive as text.
  ["**", "**"],
  ["*a*", "<em>a</em>"],
  // Other inlines inside emphasis.
  ["*foo [bar](/url)*", "<em>foo bar</em>"],
  ["**foo `bar`**", "<strong>foo bar</strong>"],
  // The document that started this: `__` preceded by a letter and followed by
  // punctuation can neither open nor close, so all four stay literal.
  ["processed__, registration__", "processed__, registration__"],
  ["snake_case_name", "snake_case_name"]
];

describe("emphasis (CommonMark §6.2)", () => {
  for (const [input, reference] of EXAMPLES) {
    it(`renders ${JSON.stringify(input)}`, async () => {
      expect(await flattenMarkdown(input)).toBe(flattenHtml(reference));
    });
  }
});

describe("emphasis edge cases", () => {
  it("does not treat a delimiter as an inline boundary when it stays literal", async () => {
    // `isInlineSpecial` used to exempt a delimiter in the last position, which is
    // where a closer most often sits.
    expect(await flattenMarkdown("*a*")).toBe("[i]a");
    expect(await flattenMarkdown("a*")).toBe("[]a*");
    expect(await flattenMarkdown("a_")).toBe("[]a_");
  });

  it("keeps an escaped delimiter out of the stack", async () => {
    expect(await flattenMarkdown("\\*not emphasis\\*")).toBe("[]*not emphasis*");
    expect(await flattenMarkdown("\\*\\*not strong\\*\\*")).toBe("[]**not strong**");
  });

  it("terminates on long delimiter runs", async () => {
    // The pair-and-retry loop consumes one or two characters per round; a bug
    // there hangs the converter rather than mis-rendering it.
    const long = "*".repeat(60);
    expect(await flattenMarkdown(`${long}foo${long}`)).toContain("foo");
  });
});
