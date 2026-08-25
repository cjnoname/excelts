/**
 * Where a line is allowed to break.
 *
 * The wrapper used to walk *segments*: a run that did not fit closed the line
 * wherever it happened to start, so every run boundary was a break opportunity
 * whether or not there was whitespace at it. Markdown, which turns every inline
 * code span into its own run, showed it constantly — an orphaned comma at the
 * head of a line, an opening parenthesis stranded at the end of one.
 *
 * The measurements here are exact rather than approximate: every run is Courier,
 * whose advance is 600/1000 em for every character, so at the default 11pt each
 * character is 6.6pt and a 132pt measure holds exactly twenty of them. A test
 * that only *probably* fills the line would stop reproducing the defect the
 * moment a metric changed.
 */
import { describe, it, expect } from "vitest";

import { layoutDocumentFull } from "../layout/layout-full";
import type { DocxDocument, Paragraph, Run, RunProperties, SectionProperties } from "../types";

/** Courier's advance at the default 11pt, in points. */
const CHAR = 6.6;
/** Characters that fit the measure below. */
const COLUMN_CHARS = 20;

/**
 * A page whose content measure is exactly `COLUMN_CHARS` Courier characters:
 * 5520 twips wide (276pt) less two 72pt margins leaves 132pt.
 */
const NARROW: SectionProperties = {
  pageSize: { width: 5520, height: 15840 },
  margins: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
};

const MONO: RunProperties = { font: "Courier New" };

const run = (text: string, properties: RunProperties = MONO): Run => ({
  properties,
  content: [{ type: "text", text }]
});

const paragraphOf = (...children: Paragraph["children"]): DocxDocument => ({
  body: [{ type: "paragraph", children }],
  sectionProperties: NARROW
});

/** The text of each laid-out line, runs joined. */
function linesOf(doc: DocxDocument): string[] {
  const layout = layoutDocumentFull(doc);
  const out: string[] = [];
  for (const page of layout.pages) {
    for (const block of page.content) {
      if (block.type !== "paragraph") {
        continue;
      }
      for (const line of block.lines) {
        out.push(line.runs.map(item => (item.type === "image" ? "" : item.text)).join(""));
      }
    }
  }
  return out;
}

describe("break opportunities", () => {
  it("exercises the intended measure", () => {
    // If this fails the arithmetic below is measuring something else and the
    // tests that follow have stopped reproducing what they were written for.
    expect(linesOf(paragraphOf(run("x".repeat(COLUMN_CHARS))))).toEqual(["x".repeat(COLUMN_CHARS)]);
    expect(linesOf(paragraphOf(run("x".repeat(COLUMN_CHARS + 1))))).toHaveLength(2);
    expect(COLUMN_CHARS * CHAR).toBe(132);
  });

  it("keeps a code span and the punctuation after it on one line", () => {
    // `\`sybase.tsx\`,` is two runs and one word. The line fills exactly at the
    // end of the span, so the comma — a new run, with no whitespace before it —
    // used to be the thing that did not fit, and started the next line alone.
    const lines = linesOf(
      paragraphOf(run("aaaa aaaa "), run("sybase.tsx"), run(", and more text"))
    );
    expect(lines).toEqual(["aaaa aaaa", "sybase.tsx, and more", "text"]);
    for (const line of lines) {
      expect(line).not.toMatch(/^\s*,/);
    }
  });

  it("does not strand an opening bracket at the end of a line", () => {
    // Same shape, the other way round: the bracket fits and the code span it
    // opened does not, so the break fell between them.
    const lines = linesOf(paragraphOf(run("aaaa aaaa aaaa ("), run("bcp.ts) and more")));
    expect(lines[0]).toBe("aaaa aaaa aaaa");
    expect(lines[1]).toBe("(bcp.ts) and more".slice(0, COLUMN_CHARS));
    for (const line of lines) {
      expect(line.trimEnd()).not.toMatch(/\($/);
    }
  });

  it("still breaks at whitespace between runs of different formatting", () => {
    // The fix must not glue everything together: a space is a break opportunity
    // even when the runs on either side of it differ.
    const lines = linesOf(
      paragraphOf(run("aaaa aaaa aaaa "), run("bbbb", { ...MONO, bold: true }), run(" cccc"))
    );
    expect(lines).toEqual(["aaaa aaaa aaaa bbbb", "cccc"]);
  });

  it("breaks inside a cluster that cannot fit a line by itself", () => {
    // CSS `overflow-wrap: break-word`. A cluster wider than the measure has to
    // break somewhere, and refusing to would run it off the right edge.
    const lines = linesOf(paragraphOf(run("x".repeat(50))));
    expect(lines).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(10)]);
  });

  it("breaks a cluster spanning runs rather than dropping or overflowing it", () => {
    // The cluster is the whole line here, so there is nothing to retreat over:
    // it breaks at the boundary already reached, and every character survives.
    const lines = linesOf(paragraphOf(run("y".repeat(30)), run("z".repeat(30))));
    expect(lines.join("")).toBe("y".repeat(30) + "z".repeat(30));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(COLUMN_CHARS);
    }
  });

  it("keeps the author's whitespace after a hard break", () => {
    // A wrapped line drops the space the break consumed; a hard break does not,
    // because that whitespace is a code block's indentation.
    const lines = linesOf(
      paragraphOf({
        properties: MONO,
        content: [
          { type: "text", text: "first" },
          { type: "break" },
          { type: "text", text: "    indented" }
        ]
      })
    );
    expect(lines).toEqual(["first", "    indented"]);
  });

  it("loses no text when a line ends exactly at a run boundary", () => {
    // Reassembly hazard: a line's pieces are regrouped by source run, and an
    // off-by-one there drops text silently rather than misplacing it visibly.
    const parts = ["alpha ", "beta ", "gamma ", "delta ", "epsilon ", "zeta"];
    const doc = paragraphOf(
      ...parts.map((part, i) => run(part, i % 2 === 0 ? MONO : { ...MONO, bold: true }))
    );
    expect(linesOf(doc).join(" ")).toBe(parts.join("").trim());
  });
});
