/**
 * Grapheme segmentation, native and fallback.
 *
 * `Intl.Segmenter` was constructed at module load, which crashed every import on
 * Firefox 102–124 — a supported target that only gained the API in 125. Feature
 * detection is therefore lazy, and the fallback has to agree with the native
 * algorithm on the boundaries this library depends on.
 */
import { afterEach, describe, expect, it } from "vitest";

import { _resetGraphemeSegmenterForTest, graphemeClusters } from "../grapheme";

/** Run `fn` with `Intl.Segmenter` hidden, as on Firefox 102–124. */
function withoutSegmenter<T>(fn: () => T): T {
  const intl = Intl as unknown as Record<string, unknown>;
  const original = intl.Segmenter;
  delete intl.Segmenter;
  _resetGraphemeSegmenterForTest();
  try {
    return fn();
  } finally {
    intl.Segmenter = original;
    _resetGraphemeSegmenterForTest();
  }
}

const CASES = [
  "",
  "plain ascii",
  "报表Report",
  "中\uFE0F文", // variation selector
  "中\u0301文", // combining mark
  "e\u0301", // combining acute
  "✈\uFE0F", // text-default emoji with VS16
  "👍🏽", // emoji + skin tone modifier
  "🇨🇳", // regional indicator pair
  "🇨🇳🇯🇵", // two flags
  "👩‍👩‍👧‍👦", // ZWJ sequence
  "a👍🏽b🇨🇳c",
  "中\u{E0100}文" // ideographic variation selector
];

describe("graphemeClusters", () => {
  afterEach(() => {
    _resetGraphemeSegmenterForTest();
  });

  it("should not throw when Intl.Segmenter is unavailable", () => {
    // Importing the module used to be enough to crash.
    expect(() => withoutSegmenter(() => graphemeClusters("中文"))).not.toThrow();
  });

  it("should agree with the native algorithm on every case", () => {
    const native = CASES.map(text => graphemeClusters(text));
    const fallback = withoutSegmenter(() => CASES.map(text => graphemeClusters(text)));
    for (const [i, text] of CASES.entries()) {
      expect(fallback[i], JSON.stringify(text)).toEqual(native[i]);
    }
  });

  it("should keep a base character with its marks and selectors", () => {
    for (const segment of [
      graphemeClusters,
      (t: string) => withoutSegmenter(() => graphemeClusters(t))
    ]) {
      expect(segment("中\uFE0F文")).toEqual(["中\uFE0F", "文"]);
      expect(segment("中\u0301文")).toEqual(["中\u0301", "文"]);
      expect(segment("中\u{E0100}文")).toEqual(["中\u{E0100}", "文"]);
    }
  });

  it("should keep emoji sequences whole", () => {
    for (const segment of [
      graphemeClusters,
      (t: string) => withoutSegmenter(() => graphemeClusters(t))
    ]) {
      expect(segment("👍🏽")).toEqual(["👍🏽"]);
      expect(segment("🇨🇳")).toEqual(["🇨🇳"]);
      expect(segment("🇨🇳🇯🇵")).toEqual(["🇨🇳", "🇯🇵"]);
      expect(segment("👩‍👩‍👧‍👦")).toEqual(["👩‍👩‍👧‍👦"]);
    }
  });

  it("should never lose or reorder input", () => {
    for (const text of CASES) {
      expect(graphemeClusters(text).join("")).toBe(text);
      expect(withoutSegmenter(() => graphemeClusters(text)).join("")).toBe(text);
    }
  });
});

describe("no module constructs Intl.Segmenter at load time", () => {
  // The failure mode this whole module exists for: a `new Intl.Segmenter(...)` at
  // module scope throws on *import*, before any call, so a consumer cannot guard
  // against it and the whole entry point is unusable on Firefox 102–124.
  // `pdf/font/font-plan.ts` still had one after `font-embedder` was fixed.
  const ENTRIES = [
    "@pdf/font/font-plan",
    "@pdf/font/font-embedder",
    "@pdf/font/font-manager",
    "@pdf/index",
    "@word/index",
    "@excel/index",
    "@draw/index"
  ];

  it.each(ENTRIES)("should import %s without Intl.Segmenter", async entry => {
    const intl = Intl as unknown as Record<string, unknown>;
    const original = intl.Segmenter;
    delete intl.Segmenter;
    _resetGraphemeSegmenterForTest();
    try {
      // A fresh specifier each time: a module already evaluated with the API
      // present would be served from the registry and prove nothing.
      await expect(import(`${entry}?withoutSegmenter=${Date.now()}`)).resolves.toBeDefined();
    } finally {
      intl.Segmenter = original;
      _resetGraphemeSegmenterForTest();
    }
  });
});
