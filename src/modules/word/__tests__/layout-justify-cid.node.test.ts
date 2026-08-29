/**
 * Justification with an embedded CIDFont.
 *
 * `.node` because it inflates the PDF content stream to read the operators, and
 * `node:zlib` is not available in the browser suite.
 */
import { inflateSync } from "node:zlib";

import { buildTtfWithCmap } from "@pdf/__tests__/ttf-test-utils";
import { docxToPdf } from "@pdf/word-bridge";
import { describe, it, expect } from "vitest";

import type { DocxDocument } from "../types";

describe("justified Latin with an embedded CIDFont", () => {
  // `Tw` cannot deliver word spacing to a composite font: PDF 32000-1 §9.3.3
  // applies it to a single-byte code 32 only and "shall not apply to occurrences
  // of the byte value 32 in multiple-byte codes". Every code in an `Identity-H`
  // CIDFont is two bytes, so the operator matched nothing — a justified Latin line
  // fell 11–17pt short of a 468pt column (measured by rasterising) while the layout
  // believed it had filled it, and any underline drawn from `run.width` overshot by
  // the same amount. The gap is opened with an explicit `TJ` adjustment instead.
  const LATIN =
    "The quick brown fox jumps over the lazy dog and keeps on running along the road ".repeat(4);

  const justified: DocxDocument = {
    body: [
      {
        type: "paragraph",
        properties: { alignment: "both" },
        children: [{ content: [{ type: "text", text: LATIN }] }]
      }
    ]
  };

  const inflatedStreams = (bytes: Uint8Array): string => {
    const raw = Buffer.from(bytes).toString("latin1");
    const out: string[] = [];
    const re = /stream\r?\n([\s\S]*?)endstream/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      try {
        out.push(inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"));
      } catch {
        // not a deflate stream
      }
    }
    return out.join("\n");
  };

  it("should open the word gaps with TJ, not with Tw alone", async () => {
    const codePoints = [...new Set([...LATIN])].map(c => c.codePointAt(0)!);
    const face = buildTtfWithCmap(
      codePoints.map((cp, i) => ({ start: cp, end: cp, delta: 10 + i - cp })),
      codePoints.length + 20,
      {
        familyName: "CidJustify",
        postScriptName: "CidJustify-Regular",
        advanceWidths: [500, ...codePoints.map(() => 500)]
      }
    );

    const bytes = await docxToPdf(justified, { fonts: { default: { regular: face } } });
    const pdf = Buffer.from(bytes).toString("latin1");
    const content = inflatedStreams(bytes);

    // Precondition: this really is the two-byte encoding that `Tw` cannot reach.
    expect(pdf).toMatch(/\/Encoding\s*\/Identity-H/);

    // The stretched lines carry negative TJ adjustments — one per word gap.
    const adjustments = [...content.matchAll(/\[([^\]]*)\]\s*TJ/g)].flatMap(m =>
      [...m[1].matchAll(/(-[\d.]+)/g)].map(n => Number(n[1]))
    );
    expect(adjustments.length).toBeGreaterThan(0);
    expect(adjustments.every(n => n < 0)).toBe(true);
  });

  it("should leave a simple font to Tw", async () => {
    // No embedded font: Helvetica is a simple font with a single-byte code 32, so
    // `Tw` is exactly the right mechanism and must still be used.
    const content = inflatedStreams(await docxToPdf(justified));
    expect(content).toMatch(/[\d.]+\s+Tw/);
    expect(content).not.toMatch(/\]\s*TJ/);
  });
});
