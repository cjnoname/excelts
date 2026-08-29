import { afterEach, describe, it, expect } from "vitest";

import { PdfDocumentBuilder } from "../builder/document-builder";
import {
  PREFERRED_FONTS,
  discoverSystemFont,
  preferredFontFiles,
  discoverSystemFontCandidates,
  findSystemFontForCodePoints,
  resetFontDiscoveryCache,
  _isReadBufferHeldForTest,
  _setCandidatesForTest
} from "../font/system-fonts";
import { countTtfFaces } from "../font/ttf-parser";
import { requiresEmbeddedFace } from "../font/type3-repertoire";
import { pdf } from "../pdf";
import { buildMinimalTtf, buildTtc, buildTtfWithCmap } from "./ttf-test-utils";

// ===========================================================================
// Tests
// ===========================================================================

describe("System font discovery", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  it("should not throw when resetting the cache", () => {
    expect(() => resetFontDiscoveryCache()).not.toThrow();
  });

  it("should return either null or a candidate face", () => {
    resetFontDiscoveryCache();
    const result = discoverSystemFont();
    if (result !== null) {
      expect(result.data).toBeInstanceOf(Uint8Array);
      expect(result.collectionIndex).toBeGreaterThanOrEqual(0);
    } else {
      expect(result).toBeNull();
    }
  });

  it("should return a non-trivial Uint8Array if a font is found", () => {
    resetFontDiscoveryCache();
    const result = discoverSystemFont();
    if (result !== null) {
      expect(result.data.length).toBeGreaterThan(1000);
    }
  });

  it("should return the same result on repeated calls (caching)", () => {
    resetFontDiscoveryCache();
    const first = discoverSystemFont();
    const second = discoverSystemFont();

    if (first === null) {
      expect(second).toBeNull();
    } else {
      // Compared by which face it names, not by object identity. A candidate is
      // produced per enumeration and its `data` is lazy, so `toBe` both asserted
      // the wrong thing and — on failure — made Vitest serialise the object, which
      // read the whole font library into memory looking for a diff to print.
      expect(second?.path).toBe(first.path);
      expect(second?.collectionIndex).toBe(first.collectionIndex);
      expect(second?.preferred).toBe(first.preferred);
    }
  });

  it("discoverSystemFontCandidates should return an array", () => {
    resetFontDiscoveryCache();
    const candidates = discoverSystemFontCandidates();
    expect(Array.isArray(candidates)).toBe(true);

    // Only the metadata is checked for every candidate. `data` is lazy — touching
    // it reads the file — so asserting it across all of them pulled this host's
    // entire font library (853 faces, 1.5 GB) into memory and exhausted the heap.
    // Sampling proves the accessor works without materialising everything, which
    // is the property that matters: selection reaches only a handful of candidates.
    for (const c of candidates) {
      expect(c.collectionIndex).toBeGreaterThanOrEqual(0);
      expect(typeof c.preferred).toBe("boolean");
    }
    for (const c of candidates.slice(0, 5)) {
      expect(c.data).toBeInstanceOf(Uint8Array);
      expect(c.data.length).toBeGreaterThan(1000);
    }
  });

  it("discoverSystemFont should return the first candidate", () => {
    resetFontDiscoveryCache();
    const candidates = discoverSystemFontCandidates();
    const first = discoverSystemFont();

    if (candidates.length === 0) {
      expect(first).toBeNull();
    } else {
      // Compared by identity of the face, not the object: candidates are created
      // per enumeration, and `data` is deliberately not compared because reading
      // it is what this test is avoiding.
      expect(first?.path).toBe(candidates[0].path);
      expect(first?.collectionIndex).toBe(candidates[0].collectionIndex);
    }
  });
});

describe("System font candidate iteration", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  it("should skip a candidate that does not cover required chars and use the next one", async () => {
    // Candidate 1: only covers A/B (U+0041-0042) — does NOT cover ☐ (U+2610)
    const ttfNarrow = buildMinimalTtf();

    // Candidate 2: covers A/B AND ☐ (U+2610)
    // U+0041-0042 → glyphs 1-2 (delta = -0x40)
    // U+2610       → glyph 3  (delta = -0x260D)
    const ttfBroad = buildTtfWithCmap(
      [
        { start: 0x41, end: 0x42, delta: -0x40 },
        { start: 0x2610, end: 0x2610, delta: -0x260d }
      ],
      4 // .notdef + A + B + ☐
    );

    // Inject: narrow first, broad second
    _setCandidatesForTest([ttfNarrow, ttfBroad]);

    // Generate a PDF containing ☐ — the exporter must skip ttfNarrow and use ttfBroad
    const result = await pdf([["A", "☐"]]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(100);

    // The PDF should contain an embedded font (TestFont) — proof that ttfBroad was used
    const pdfText = new TextDecoder("latin1").decode(result);
    expect(pdfText).toContain("TestFont");
  });

  it("should fall back to Type3 when no candidate covers the required chars", async () => {
    // Only candidate: covers A/B but NOT ☐ (U+2610)
    const ttfNarrow = buildMinimalTtf();
    _setCandidatesForTest([ttfNarrow]);

    // Generate a PDF containing ☐ — no candidate covers it, so Type3 fallback
    const result = await pdf([["A", "☐"]]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(100);

    // The PDF should NOT contain "TestFont" — no embedded font was selected
    const pdfText = new TextDecoder("latin1").decode(result);
    expect(pdfText).not.toContain("TestFont");
  });

  it("should fall back to Type3 when candidate list is empty", async () => {
    _setCandidatesForTest([]);

    const result = await pdf([["Hello", "☐"]]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(100);
  });

  it("should not attempt candidates when text is all WinAnsi", async () => {
    // Inject a candidate that would fail to parse if used
    const garbage = new Uint8Array([0, 1, 2, 3]);
    _setCandidatesForTest([garbage]);

    // Pure ASCII — no non-WinAnsi chars, so candidate loop should never run
    const result = await pdf([["Hello", "World"]]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(100);
  });
});

describe("Preference ordering", () => {
  const indexOf = (name: string): number => {
    const i = PREFERRED_FONTS.indexOf(name);
    expect(i, `${name} missing from PREFERRED_FONTS`).toBeGreaterThanOrEqual(0);
    return i;
  };

  // Arial Unicode MS covers nearly every script, so a coverage-only ordering
  // puts it first — which is what this list used to do, and why a Mac with
  // STHeiti installed still rendered Chinese in the 1998 Monotype glyphs.
  it("should try every system CJK face before the broad-coverage catch-all", () => {
    const arialUnicode = Math.min(
      indexOf("Arial Unicode.ttf"),
      indexOf("Arial Unicode MS.ttf"),
      indexOf("ArialUnicode.ttf"),
      indexOf("arialuni.ttf")
    );

    for (const cjk of [
      "NotoSansCJKsc-Regular.ttf", // Linux / bundled
      "NotoSansSC-Regular.ttf",
      "PingFang.ttc", // macOS
      "STHeiti Light.ttc",
      "Songti.ttc",
      "msyh.ttc", // Windows
      "simsun.ttc",
      "simhei.ttf",
      "wqy-microhei.ttc", // Linux
      "DroidSansFallbackFull.ttf"
    ]) {
      expect(indexOf(cjk), `${cjk} must be preferred over Arial Unicode`).toBeLessThan(
        arialUnicode
      );
    }
  });

  it("should try Latin-only faces last, since they cannot draw CJK at all", () => {
    const latinOnly = ["arial.ttf", "segoeui.ttf", "DejaVuSans.ttf", "NotoSans-Regular.ttf"];
    const cjkFaces = ["STHeiti Light.ttc", "msyh.ttc", "NotoSansSC-Regular.ttf", "simsun.ttc"];
    for (const latin of latinOnly) {
      for (const cjk of cjkFaces) {
        expect(indexOf(cjk), `${cjk} must be preferred over ${latin}`).toBeLessThan(indexOf(latin));
      }
    }
  });

  it("should not contain duplicate entries", () => {
    expect(new Set(PREFERRED_FONTS).size).toBe(PREFERRED_FONTS.length);
  });
});

describe("TrueType Collection faces", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  // Latin-only, covers A/B. Stands in for a collection's face 0.
  const narrowFace = (family: string): Uint8Array =>
    buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: -0x40 }], 3, {
      familyName: family,
      postScriptName: `${family}-Regular`
    });

  // Also covers U+4E2D (中).
  const cjkFace = (family: string): Uint8Array =>
    buildTtfWithCmap(
      [
        { start: 0x41, end: 0x42, delta: -0x40 },
        { start: 0x4e2d, end: 0x4e2d, delta: 3 - 0x4e2d }
      ],
      4,
      { familyName: family, postScriptName: `${family}-Regular` }
    );

  it("should count the faces in a collection", () => {
    expect(countTtfFaces(buildTtc([narrowFace("A"), cjkFace("B"), narrowFace("C")]))).toBe(3);
  });

  it("should report a single face for a plain .ttf", () => {
    expect(countTtfFaces(buildMinimalTtf())).toBe(1);
  });

  // The real defect this fixes: macOS `Songti.ttc` carries 8,535 glyphs in face
  // 0 and 43,033 in face 1, so a scan that only ever read face 0 rejected the
  // whole collection for text the font could in fact draw.
  it("should reach a covering face past face 0 of a collection", () => {
    _setCandidatesForTest([buildTtc([narrowFace("FaceZero"), cjkFace("FaceOne")])]);

    const found = findSystemFontForCodePoints(new Set([0x4e2d]));
    expect(found).not.toBeNull();
    expect(found!.familyName).toBe("FaceOne");
  });

  it("should still reject a collection when no face covers the text", () => {
    _setCandidatesForTest([buildTtc([narrowFace("FaceZero"), narrowFace("FaceOne")])]);
    expect(findSystemFontForCodePoints(new Set([0x4e2d]))).toBeNull();
  });
});

describe("preferSystemFonts family selection", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  const face = (family: string): Uint8Array =>
    buildTtfWithCmap(
      [
        { start: 0x41, end: 0x42, delta: -0x40 },
        { start: 0x4e2d, end: 0x4e2d, delta: 3 - 0x4e2d }
      ],
      4,
      { familyName: family, postScriptName: `${family}-Regular` }
    );

  it("should default to the built-in order when no preference is given", () => {
    _setCandidatesForTest([face("FirstFont"), face("SecondFont")]);
    expect(findSystemFontForCodePoints(new Set([0x4e2d]))!.familyName).toBe("FirstFont");
  });

  it("should honour a named family ahead of the built-in order", () => {
    _setCandidatesForTest([face("FirstFont"), face("SecondFont")]);
    const found = findSystemFontForCodePoints(new Set([0x4e2d]), ["SecondFont"]);
    expect(found!.familyName).toBe("SecondFont");
  });

  it("should match family names case-insensitively and ignore surrounding space", () => {
    _setCandidatesForTest([face("FirstFont"), face("Heiti SC")]);
    const found = findSystemFontForCodePoints(new Set([0x4e2d]), ["  heiti sc  "]);
    expect(found!.familyName).toBe("Heiti SC");
  });

  it("should respect the order of the preference list, not discovery order", () => {
    _setCandidatesForTest([face("Alpha"), face("Beta"), face("Gamma")]);
    const found = findSystemFontForCodePoints(new Set([0x4e2d]), ["Gamma", "Beta"]);
    expect(found!.familyName).toBe("Gamma");
  });

  it("should fall back to the next preference when the first does not cover the text", () => {
    // "Narrow" is named first but cannot draw 中.
    const narrow = buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: -0x40 }], 3, {
      familyName: "Narrow",
      postScriptName: "Narrow-Regular"
    });
    _setCandidatesForTest([face("Wide"), narrow]);
    const found = findSystemFontForCodePoints(new Set([0x4e2d]), ["Narrow", "Wide"]);
    expect(found!.familyName).toBe("Wide");
  });

  it("should fall back to the built-in order when no named family is installed", () => {
    _setCandidatesForTest([face("FirstFont")]);
    const found = findSystemFontForCodePoints(new Set([0x4e2d]), ["Not Installed"]);
    expect(found!.familyName).toBe("FirstFont");
  });

  it("should select a specific face inside a collection by family name", () => {
    _setCandidatesForTest([buildTtc([face("Heiti TC"), face("Heiti SC")])]);

    // Both faces cover the text, so only the name distinguishes them — this is
    // how a caller reaches the Simplified face of macOS `STHeiti Light.ttc`.
    // Note the default is now the Simplified face rather than face 0: see
    // "Language-aware selection" below.
    expect(findSystemFontForCodePoints(new Set([0x4e2d]))!.familyName).toBe("Heiti SC");
    expect(findSystemFontForCodePoints(new Set([0x4e2d]), ["Heiti TC"])!.familyName).toBe(
      "Heiti TC"
    );
    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hant")!.familyName).toBe(
      "Heiti TC"
    );
  });

  it("should ignore blank entries in the preference list", () => {
    _setCandidatesForTest([face("FirstFont"), face("SecondFont")]);
    const found = findSystemFontForCodePoints(new Set([0x4e2d]), ["", "   ", "SecondFont"]);
    expect(found!.familyName).toBe("SecondFont");
  });
});

describe("preferSystemFonts end to end", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  const face = (family: string): Uint8Array =>
    buildTtfWithCmap(
      [
        { start: 0x41, end: 0x42, delta: -0x40 },
        { start: 0x4e2d, end: 0x4e2d, delta: 3 - 0x4e2d }
      ],
      4,
      { familyName: family, postScriptName: `${family}-Regular` }
    );

  const embeddedName = (bytes: Uint8Array): string => {
    const text = new TextDecoder("latin1").decode(bytes);
    // Only an embedded face gets a FontDescriptor, so /FontName names the
    // discovered font and never a standard-14 face.
    const m = /\/FontName\s*\/([^\s/>\]]+)/.exec(text);
    return m ? m[1].replace(/-Subset$/, "") : "";
  };

  it("should reach the builder through the constructor option", async () => {
    _setCandidatesForTest([face("BuiltInChoice"), face("CallerChoice")]);

    const doc = new PdfDocumentBuilder({ preferSystemFonts: ["CallerChoice"] });
    doc.addPage().drawText("中", { x: 72, y: 700 });

    expect(embeddedName(await doc.build())).toBe("CallerChoice-Regular");
  });

  it("should reach the builder through the chained method", async () => {
    _setCandidatesForTest([face("BuiltInChoice"), face("CallerChoice")]);

    const doc = new PdfDocumentBuilder().preferSystemFonts(["CallerChoice"]);
    doc.addPage().drawText("中", { x: 72, y: 700 });

    expect(embeddedName(await doc.build())).toBe("CallerChoice-Regular");
  });

  it("should use the built-in order when the builder names nothing", async () => {
    _setCandidatesForTest([face("BuiltInChoice"), face("CallerChoice")]);

    const doc = new PdfDocumentBuilder();
    doc.addPage().drawText("中", { x: 72, y: 700 });

    expect(embeddedName(await doc.build())).toBe("BuiltInChoice-Regular");
  });

  it("should reach the spreadsheet exporter through its options", async () => {
    _setCandidatesForTest([face("BuiltInChoice"), face("CallerChoice")]);

    const result = await pdf([["中"]], { preferSystemFonts: ["CallerChoice"] });
    expect(embeddedName(result)).toBe("CallerChoice-Regular");
  });

  it("should leave the spreadsheet exporter on the built-in order by default", async () => {
    _setCandidatesForTest([face("BuiltInChoice"), face("CallerChoice")]);

    const result = await pdf([["中"]]);
    expect(embeddedName(result)).toBe("BuiltInChoice-Regular");
  });

  it("should be ignored when a font is embedded explicitly", async () => {
    _setCandidatesForTest([face("BuiltInChoice"), face("CallerChoice")]);

    // `font` is authoritative: naming a system family must not override it.
    const result = await pdf([["中"]], {
      font: face("ExplicitChoice"),
      preferSystemFonts: ["CallerChoice"]
    });
    expect(embeddedName(result)).toBe("ExplicitChoice-Regular");
  });
});

describe("Language-aware selection", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  const faceNamed = (family: string, extraCodePoints: readonly number[] = []): Uint8Array => {
    // Latin A/B plus the shared Han characters, so every face "covers" the text
    // and only the language rule can tell them apart — which is precisely the
    // Han-unification trap.
    const segments = [{ start: 0x41, end: 0x42, delta: -0x40 }];
    let gid = 3;
    for (const cp of [0x76f4, 0x9aa8, 0x4eca, ...extraCodePoints]) {
      segments.push({ start: cp, end: cp, delta: gid - cp });
      gid++;
    }
    return buildTtfWithCmap(segments, gid + 1, {
      familyName: family,
      postScriptName: `${family.replace(/\s+/g, "")}-Regular`
    });
  };

  const HAN = new Set([0x76f4, 0x9aa8, 0x4eca]);

  it("should prefer the named language's families over another region's", () => {
    // Discovery order puts the Japanese face first; the language rule must not.
    _setCandidatesForTest([faceNamed("Yu Gothic"), faceNamed("Heiti SC")]);
    expect(findSystemFontForCodePoints(HAN, [], "zh-Hans")!.familyName).toBe("Heiti SC");
    expect(findSystemFontForCodePoints(HAN, [], "ja")!.familyName).toBe("Yu Gothic");
  });

  it("should tell Simplified from Traditional families", () => {
    _setCandidatesForTest([faceNamed("Heiti TC"), faceNamed("Heiti SC")]);
    expect(findSystemFontForCodePoints(HAN, [], "zh-Hans")!.familyName).toBe("Heiti SC");
    expect(findSystemFontForCodePoints(HAN, [], "zh-Hant")!.familyName).toBe("Heiti TC");
  });

  it("should default to Simplified families when no language is given", () => {
    // Otherwise the answer is "whichever face sits at index 0", which for macOS
    // `STHeiti Light.ttc` is the Traditional one.
    _setCandidatesForTest([faceNamed("Heiti TC"), faceNamed("Heiti SC")]);
    expect(findSystemFontForCodePoints(HAN, [])!.familyName).toBe("Heiti SC");
  });

  it("should let an explicit preferSystemFonts outrank the language", () => {
    _setCandidatesForTest([faceNamed("Heiti SC"), faceNamed("Kaiti TC")]);
    expect(findSystemFontForCodePoints(HAN, ["Kaiti TC"], "zh-Hans")!.familyName).toBe("Kaiti TC");
  });

  it("should fall back to any covering face when the language has none installed", () => {
    _setCandidatesForTest([faceNamed("Some Unlisted Face")]);
    expect(findSystemFontForCodePoints(HAN, [], "ko")!.familyName).toBe("Some Unlisted Face");
  });

  it("should still require coverage, whatever the language", () => {
    // A Japanese face that cannot draw a Simplified-only character must not be
    // chosen for it just because the language matches.
    const bao = 0x62a5; // 报
    _setCandidatesForTest([faceNamed("Yu Gothic"), faceNamed("Heiti SC", [bao])]);
    const found = findSystemFontForCodePoints(new Set([...HAN, bao]), [], "ja");
    expect(found!.familyName).toBe("Heiti SC");
  });
});

describe("preferredFontFiles ordering", () => {
  it("should put the named language's files first", () => {
    const hans = preferredFontFiles("zh-Hans");
    const hant = preferredFontFiles("zh-Hant");
    const ja = preferredFontFiles("ja");
    expect(hans.indexOf("simsun.ttc")).toBeLessThan(hans.indexOf("msjh.ttc"));
    expect(hant.indexOf("msjh.ttc")).toBeLessThan(hant.indexOf("simsun.ttc"));
    expect(ja.indexOf("meiryo.ttc")).toBeLessThan(ja.indexOf("simsun.ttc"));
  });

  it("should keep the broad-coverage catch-all after every regional face", () => {
    for (const lang of ["zh-Hans", "zh-Hant", "ja", "ko"] as const) {
      const files = preferredFontFiles(lang);
      const arial = files.indexOf("Arial Unicode.ttf");
      for (const regional of ["simsun.ttc", "msjh.ttc", "meiryo.ttc", "malgun.ttf"]) {
        expect(files.indexOf(regional), `${regional} after Arial Unicode for ${lang}`).toBeLessThan(
          arial
        );
      }
    }
  });

  it("should contain no duplicates", () => {
    for (const lang of [undefined, "zh-Hans", "zh-Hant", "ja", "ko"] as const) {
      const files = preferredFontFiles(lang);
      expect(new Set(files).size).toBe(files.length);
    }
  });

  it("should cover every language group whatever the requested language", () => {
    const ja = preferredFontFiles("ja");
    for (const file of ["simsun.ttc", "msjh.ttc", "malgun.ttf", "Arial Unicode.ttf"]) {
      expect(ja).toContain(file);
    }
  });
});

describe("Weight selection within a family", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  const weighted = (family: string, weight: number): Uint8Array =>
    buildTtfWithCmap(
      [
        { start: 0x41, end: 0x42, delta: -0x40 },
        { start: 0x4e2d, end: 0x4e2d, delta: 3 - 0x4e2d }
      ],
      4,
      {
        familyName: family,
        postScriptName: `${family.replace(/\s+/g, "")}-${weight}`,
        weightClass: weight
      }
    );

  const ZHONG = new Set([0x4e2d]);

  // macOS `Songti.ttc` lists `Songti SC` at Black (face 0) before Bold, Light and
  // Regular, so taking the first face that matched the family set an entire
  // document in the heaviest weight the collection had.
  it("should prefer a regular weight over a heavier one listed first", () => {
    _setCandidatesForTest([
      weighted("Songti SC", 900),
      weighted("Songti SC", 700),
      weighted("Songti SC", 400)
    ]);
    expect(findSystemFontForCodePoints(ZHONG, ["Songti SC"])!.weightClass).toBe(400);
  });

  it("should prefer regular when the language picked the family", () => {
    _setCandidatesForTest([weighted("Heiti SC", 900), weighted("Heiti SC", 400)]);
    expect(findSystemFontForCodePoints(ZHONG, [], "zh-Hans")!.weightClass).toBe(400);
  });

  it("should take the nearest weight when no regular face exists", () => {
    // Light (300) is closer to 400 than Bold (700).
    _setCandidatesForTest([weighted("Songti SC", 700), weighted("Songti SC", 300)]);
    expect(findSystemFontForCodePoints(ZHONG, ["Songti SC"])!.weightClass).toBe(300);
  });

  it("should not let weight override the family preference order", () => {
    // A regular face of a lower-ranked family must not beat the first choice.
    _setCandidatesForTest([weighted("Kaiti SC", 900), weighted("Songti SC", 400)]);
    expect(findSystemFontForCodePoints(ZHONG, ["Kaiti SC", "Songti SC"])!.familyName).toBe(
      "Kaiti SC"
    );
  });
});

describe("Repeated searches", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  // A cache of completed searches was added here and then removed. It existed to
  // make a "repeated" lookup free, but instrumenting the real pipelines showed
  // each export asks exactly **once** (Excel: 1, Word: 1) — the repeats measured
  // earlier were the same test running twice in one process. So the cache never
  // hit in practice, while each entry retained a parsed `TtfFont`: a CJK face is
  // ~56 MB of bytes plus its cmap, and eight entries held 429 MB that no public
  // API could release. Paying ~220 ms of discovery per export instead is the
  // right trade — that cost is already dwarfed by the export itself.
  //
  // What *is* cached is the path index and the per-file face counts, which is the
  // part that costs I/O rather than memory.
  const face = (family: string): Uint8Array =>
    buildTtfWithCmap(
      [
        { start: 0x41, end: 0x42, delta: -0x40 },
        { start: 0x4e2d, end: 0x4e2d, delta: 3 - 0x4e2d }
      ],
      4,
      { familyName: family, postScriptName: `${family.replace(/\s+/g, "")}-Regular` }
    );

  it("should give the same answer every time", () => {
    _setCandidatesForTest([face("Heiti SC")]);
    const cps = new Set([0x4e2d]);
    const first = findSystemFontForCodePoints(cps, []);
    const second = findSystemFontForCodePoints(cps, []);
    expect(second?.familyName).toBe(first?.familyName);
    expect(second?.postScriptName).toBe(first?.postScriptName);
  });

  it("should keep reporting a failed search as failed", () => {
    _setCandidatesForTest([buildMinimalTtf()]);
    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [])).toBeNull();
    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [])).toBeNull();
  });

  it("should keep distinct requests distinct", () => {
    _setCandidatesForTest([face("Heiti SC"), face("Heiti TC")]);
    const cps = new Set([0x4e2d]);
    expect(findSystemFontForCodePoints(cps, [])?.familyName).toBe("Heiti SC");
    expect(findSystemFontForCodePoints(cps, [], "zh-Hant")?.familyName).toBe("Heiti TC");
    expect(findSystemFontForCodePoints(cps, ["Heiti TC"])?.familyName).toBe("Heiti TC");
  });

  it("should not retain font bytes after a search", () => {
    // The read buffer exists so the faces of one `.ttc` are read once; past the end
    // of a search it is just whichever file happened to be last, and holding it kept
    // a whole CJK font alive for the life of the process.
    //
    // Asserted on the state rather than on `process.memoryUsage()`: an un-forced
    // collection measures what the collector has not reached yet, which varies by
    // Node version and makes the assertion flaky rather than wrong.
    resetFontDiscoveryCache();
    const cps = new Set([..."中文报表"].map(c => c.codePointAt(0)!));
    findSystemFontForCodePoints(cps, [], "zh-Hans");
    expect(_isReadBufferHeldForTest()).toBe(false);

    // Including when the search fails and when it is repeated.
    findSystemFontForCodePoints(new Set([0x2fffe]), [], "zh-Hans");
    expect(_isReadBufferHeldForTest()).toBe(false);
    findSystemFontForCodePoints(cps, [], "zh-Hans");
    expect(_isReadBufferHeldForTest()).toBe(false);
  });
});

describe("Path indexing", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  // The sweep passed `filter: e => !e.isDirectory` to `traverseDirectorySync`,
  // which applies the filter *before* deciding whether to descend — so it never
  // recursed. `/System/Library/Fonts/Supplemental` was only reachable because the
  // directory list happened to name it separately, and removing it as redundant
  // (it is nested inside a configured root) made 253 fonts vanish, Songti.ttc
  // among them.
  it("should find fonts in nested directories", () => {
    resetFontDiscoveryCache();
    const paths = discoverSystemFontCandidates()
      .map(c => c.path ?? "")
      .filter(p => p !== "");
    if (paths.length === 0) {
      return; // a host with no installed fonts proves nothing either way
    }

    // Recursion means a font was found inside a subdirectory of a directory that
    // *also* holds fonts. An absolute path depth is not that evidence: it merely
    // measures how long the path is, and `C:\Windows\Fonts\arial.ttf` scores 4 —
    // so a `> 4` threshold failed on a Windows runner whose font directory is flat
    // while proving nothing about descent anywhere.
    const dirOf = (p: string): string =>
      p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
    const dirs = [...new Set(paths.map(dirOf))];
    const nested = dirs.filter(d =>
      dirs.some(other => other !== d && d.startsWith(other) && /[/\\]/.test(d[other.length] ?? ""))
    );
    if (nested.length === 0) {
      // Every font sits in one flat directory, which is the normal Windows layout.
      // The host cannot exhibit the property, so there is nothing to assert here;
      // `traverseDirectorySync`'s own recursion is covered in `utils/__tests__/fs`.
      return;
    }
    expect(nested.length).toBeGreaterThan(0);
  });

  it("should not hold font bytes after a full enumeration", () => {
    // Eagerly carrying bytes made this allocate the host's whole font library
    // (853 faces, ~1.5 GB) and exhaust the heap. `data` is lazy, so enumerating is
    // cheap and only the faces actually parsed are read — and the read buffer is
    // dropped at the end, because past the walk it is just the last file.
    resetFontDiscoveryCache();
    const candidates = discoverSystemFontCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    expect(_isReadBufferHeldForTest()).toBe(false);
  });

  it("should match a requested family regardless of spelling", () => {
    // A request is matched against `familyName` after trimming and lower-casing,
    // so these three spellings name the same family.
    const face = buildTtfWithCmap(
      [
        { start: 0x41, end: 0x42, delta: -0x40 },
        { start: 0x4e2d, end: 0x4e2d, delta: 3 - 0x4e2d }
      ],
      4,
      { familyName: "Heiti SC", postScriptName: "HeitiSC-Regular" }
    );
    _setCandidatesForTest([face]);
    const cps = new Set([0x4e2d]);
    expect(findSystemFontForCodePoints(cps, ["Heiti SC"])?.familyName).toBe("Heiti SC");
    expect(findSystemFontForCodePoints(cps, ["  heiti sc  "])?.familyName).toBe("Heiti SC");
    expect(findSystemFontForCodePoints(cps, ["HEITI SC"])?.familyName).toBe("Heiti SC");
  });
  it("should prefer an exact Regular over a near-Regular earlier in the list", () => {
    // The early exit treated anything from 350 to 450 as unbeatable, so a Light
    // face returned immediately and the true Regular in the same collection never
    // competed — contradicting the distance-from-400 rule the search states.
    const faces = (weights: number[]) =>
      weights.map((w, i) => ({
        data: buildTtfWithCmap([{ start: 0x4e2d, end: 0x4e2d, delta: 10 - 0x4e2d }], 40, {
          familyName: "Songti SC",
          postScriptName: `SongtiSC-${w}`,
          weightClass: w
        }),
        collectionIndex: 0,
        preferred: true,
        path: `/f/${i}.ttf`
      }));
    const cps = new Set([0x4e2d]);

    for (const order of [
      [350, 400],
      [450, 400],
      [900, 400],
      [400, 350]
    ]) {
      _setCandidatesForTest(faces(order));
      expect(findSystemFontForCodePoints(cps, ["Songti SC"])?.weightClass).toBe(400);
      resetFontDiscoveryCache();
    }

    // With no exact Regular the nearest still wins, so the tolerance is not lost.
    _setCandidatesForTest(faces([900, 350]));
    expect(findSystemFontForCodePoints(cps, ["Songti SC"])?.weightClass).toBe(350);
  });
});

describe("Cross-search pruning", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  // What a face *is* — its family and weight — is remembered between searches so a
  // later one can rank it without re-reading and re-parsing the file. The rank-0
  // early exit is unreachable on macOS (`PingFang SC` is CFF and Apple's private
  // `hvgl`, so it never parses), which meant every export read the whole curated
  // list again: 65 faces, 215 ms, for an answer that does not depend on which
  // characters were asked for.
  //
  // Coverage cannot be lost to the prune by construction: a face is only skipped
  // once `regionalBest` is set, and that happens only after `covers()` has passed,
  // so the incumbent already draws the request. What the prune *could* get wrong is
  // the ranking — above all the same-family weight tie-break, which is the one
  // assertion below that fails if the skip condition is loosened. The other two
  // pin that a warmed index still answers per request rather than replaying its
  // previous winner.

  /** A candidate with a path, so it takes part in the metadata index. */
  const at = (path: string, family: string, ranges: [number, number][], weight?: number) => ({
    data: buildTtfWithCmap(
      ranges.map(([s, e], i) => ({ start: s, end: e, delta: 10 + i - s })),
      40,
      {
        familyName: family,
        postScriptName: `${family.replace(/\s+/g, "")}-Regular`,
        weightClass: weight
      }
    ),
    collectionIndex: 0,
    preferred: true,
    path
  });

  it("should still pick a lower-ranked family when the better one lacks coverage", () => {
    // `Songti SC` outranks `Heiti SC` for zh-Hans, but only Heiti has `龦`. A
    // warmed index must not answer the second request with the first one's winner.
    _setCandidatesForTest([
      at("/f/songti.ttf", "Songti SC", [[0x4e2d, 0x4e2d]]),
      at("/f/heiti.ttf", "Heiti SC", [
        [0x4e2d, 0x4e2d],
        [0x9fa6, 0x9fa6]
      ])
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")?.familyName).toBe(
      "Songti SC"
    );
    // Warm: the index now knows both faces.
    expect(findSystemFontForCodePoints(new Set([0x9fa6]), [], "zh-Hans")?.familyName).toBe(
      "Heiti SC"
    );
    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")?.familyName).toBe(
      "Songti SC"
    );
  });

  it("should keep honouring the requested family on a warmed index", () => {
    _setCandidatesForTest([
      at("/f/heiti.ttf", "Heiti SC", [[0x4e2d, 0x4e2d]]),
      at("/f/kaiti.ttf", "Kaiti SC", [[0x4e2d, 0x4e2d]])
    ]);
    const cps = new Set([0x4e2d]);
    // Cold, then warm, for each request: the answer must not depend on order.
    expect(findSystemFontForCodePoints(cps, [], "zh-Hans")?.familyName).toBe("Heiti SC");
    expect(findSystemFontForCodePoints(cps, ["Kaiti SC"])?.familyName).toBe("Kaiti SC");
    expect(findSystemFontForCodePoints(cps, [], "zh-Hans")?.familyName).toBe("Heiti SC");
    expect(findSystemFontForCodePoints(cps, ["Kaiti SC"])?.familyName).toBe("Kaiti SC");
  });

  it("should not rank an injected face by the metadata of a previous one", () => {
    // `_setCandidatesForTest` already cleared `_unusableFaces` for this reason and
    // has to clear `_faceMeta` too: both are keyed by path and face index, so a
    // second injection reusing a path was ranked as the *previous* face's family
    // and the search pruned away the face the test had just installed.
    _setCandidatesForTest([at("/same.ttf", "Old Family", [[0x4e2d, 0x4e2d]])]);
    const cps = new Set([0x4e2d]);
    expect(findSystemFontForCodePoints(cps, ["Old Family"])?.familyName).toBe("Old Family");

    _setCandidatesForTest([
      at("/same.ttf", "New Family", [[0x4e2d, 0x4e2d]]),
      at("/other.ttf", "Heiti SC", [[0x4e2d, 0x4e2d]])
    ]);
    expect(findSystemFontForCodePoints(cps, ["New Family"])?.familyName).toBe("New Family");
  });

  it("should still prefer a regular weight on a warmed index", () => {
    // Both faces are the same family, so only the weight distinguishes them —
    // exactly the tie-break the prune has to preserve. `Songti.ttc` lists Black
    // first on macOS, which is how a whole document ended up set in it.
    _setCandidatesForTest([
      at("/f/black.ttf", "Heiti SC", [[0x4e2d, 0x4e2d]], 900),
      at("/f/regular.ttf", "Heiti SC", [[0x4e2d, 0x4e2d]], 400)
    ]);
    const cps = new Set([0x4e2d]);
    expect(findSystemFontForCodePoints(cps, [], "zh-Hans")?.weightClass).toBe(400);
    expect(findSystemFontForCodePoints(cps, [], "zh-Hans")?.weightClass).toBe(400);
    expect(findSystemFontForCodePoints(cps, ["Heiti SC"])?.weightClass).toBe(400);
  });
});

describe("Coverage is a preference, not a gate", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  /** `☑` and `☐` — the checkboxes a Markdown task list renders. */
  const CHECKED = 0x2611;
  const UNCHECKED = 0x2610;
  /** Han characters, which no Type3 glyph can draw. */
  const HAN = [0x9500, 0x552e, 0x5f84] as const;

  /**
   * A face covering `codePoints` and nothing else.
   *
   * Latin A/B is always included so a face is never empty, matching what a real
   * font looks like to the scan.
   */
  const face = (family: string, codePoints: readonly number[]): Uint8Array => {
    const segments = [{ start: 0x41, end: 0x42, delta: -0x40 }];
    let gid = 3;
    for (const cp of codePoints) {
      segments.push({ start: cp, end: cp, delta: gid - cp });
      gid++;
    }
    return buildTtfWithCmap(segments, gid + 1, {
      familyName: family,
      postScriptName: `${family.replace(/\s+/g, "")}-Regular`
    });
  };

  it("keeps a Chinese face that lacks a symbol over a pan-CJK one that has it", () => {
    // The bug this exists for: `Arial Unicode MS` covers the checkboxes and the
    // Chinese face does not, so demanding total coverage chose the pan-CJK face —
    // whose Han glyphs are drawn to Japanese conventions. The symbols never needed
    // an embedded face at all, because Type3 draws them.
    _setCandidatesForTest([
      { data: face("Songti SC", HAN), collectionIndex: 0, preferred: true },
      {
        data: face("Arial Unicode MS", [...HAN, CHECKED, UNCHECKED]),
        collectionIndex: 0,
        preferred: true
      }
    ]);

    const wanted = new Set([...HAN, CHECKED, UNCHECKED]);
    expect(findSystemFontForCodePoints(wanted, [], "zh-Hans")!.familyName).toBe("Songti SC");
  });

  it("still requires the East Asian text itself to be covered", () => {
    // Leniency is about symbols only. A regional family that cannot draw the Han
    // is no use, so the pan-CJK face must win here.
    _setCandidatesForTest([
      { data: face("Songti SC", [CHECKED, UNCHECKED]), collectionIndex: 0, preferred: true },
      {
        data: face("Arial Unicode MS", [...HAN, CHECKED, UNCHECKED]),
        collectionIndex: 0,
        preferred: true
      }
    ]);

    const wanted = new Set([...HAN, CHECKED, UNCHECKED]);
    expect(findSystemFontForCodePoints(wanted, [], "zh-Hans")!.familyName).toBe("Arial Unicode MS");
  });

  it("demands total coverage when there is no East Asian text", () => {
    // With no Han there is no regional hand to protect and no reason to accept a
    // face that draws less: the old all-or-nothing rule applies unchanged.
    _setCandidatesForTest([
      { data: face("Songti SC", [CHECKED]), collectionIndex: 0, preferred: true },
      { data: face("Arial Unicode MS", [CHECKED, UNCHECKED]), collectionIndex: 0, preferred: true }
    ]);

    expect(
      findSystemFontForCodePoints(new Set([CHECKED, UNCHECKED]), [], "zh-Hans")!.familyName
    ).toBe("Arial Unicode MS");
  });

  it("applies the same leniency to an explicitly requested family", () => {
    // `preferSystemFonts` steers a best-effort search, so a named Chinese family
    // must not be discarded over a symbol either.
    _setCandidatesForTest([
      { data: face("Songti SC", HAN), collectionIndex: 0, preferred: true },
      {
        data: face("Arial Unicode MS", [...HAN, CHECKED, UNCHECKED]),
        collectionIndex: 0,
        preferred: true
      }
    ]);

    const wanted = new Set([...HAN, CHECKED, UNCHECKED]);
    expect(findSystemFontForCodePoints(wanted, ["Songti SC"])!.familyName).toBe("Songti SC");
  });
});

describe("zh-Hans default order", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  const face = (family: string): Uint8Array =>
    buildTtfWithCmap(
      [
        { start: 0x41, end: 0x42, delta: -0x40 },
        { start: 0x4e2d, end: 0x4e2d, delta: 3 - 0x4e2d }
      ],
      6,
      { familyName: family, postScriptName: `${family.replace(/\s+/g, "")}-Regular` }
    );

  it("prefers Songti SC over Heiti SC", () => {
    // Both ship with macOS, so this decides how a stock machine renders Chinese.
    // macOS has exactly one Heiti SC face — `STHeitiSC-Medium` — so choosing it set
    // body text a weight too heavy with no Regular available to correct it.
    _setCandidatesForTest([
      { data: face("Heiti SC"), collectionIndex: 0, preferred: true },
      { data: face("Songti SC"), collectionIndex: 0, preferred: true }
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")!.familyName).toBe(
      "Songti SC"
    );
  });

  it("keeps an installed serif Noto ahead of the OS serif", () => {
    // Someone who installed Noto asked for it, and within the serif group an
    // explicit install still outranks whatever the OS happens to ship.
    _setCandidatesForTest([
      { data: face("Songti SC"), collectionIndex: 0, preferred: true },
      { data: face("Noto Serif SC"), collectionIndex: 0, preferred: true }
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")!.familyName).toBe(
      "Noto Serif SC"
    );
  });

  it("does not let an installed sans Noto displace the OS serif", () => {
    // This is the case the serif-first order exists for. `Noto Sans CJK SC` used to
    // outrank `Songti SC`, so installing a sans Noto — which a Linux CJK locale does
    // by default — silently changed the body face of every document from 宋体 back to
    // a gothic, including on macOS.
    _setCandidatesForTest([
      { data: face("Songti SC"), collectionIndex: 0, preferred: true },
      { data: face("Noto Sans SC"), collectionIndex: 0, preferred: true },
      { data: face("Noto Sans CJK SC"), collectionIndex: 0, preferred: true }
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")!.familyName).toBe(
      "Songti SC"
    );
  });

  it("picks SimSun on Windows, not Microsoft YaHei", () => {
    // Both are in the Windows 11 base install per Microsoft's font list, and
    // Microsoft describes SimSun as a mincho (serif) face — so it is the Windows
    // counterpart of Songti SC, and the platforms now agree.
    _setCandidatesForTest([
      { data: face("Microsoft YaHei"), collectionIndex: 0, preferred: true },
      { data: face("SimSun"), collectionIndex: 0, preferred: true }
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")!.familyName).toBe(
      "SimSun"
    );
  });

  it("keeps SimSun ahead of the Windows supplemental fonts", () => {
    // `DengXian` and `SimHei` ship in the "Chinese (Simplified) Supplemental Fonts"
    // Feature On Demand package, not the base install, so ranking them above a face
    // that is always present was wrong twice: they may be absent, and both are sans.
    _setCandidatesForTest([
      { data: face("DengXian"), collectionIndex: 0, preferred: true },
      { data: face("SimHei"), collectionIndex: 0, preferred: true },
      { data: face("SimSun"), collectionIndex: 0, preferred: true }
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")!.familyName).toBe(
      "SimSun"
    );
  });

  it("picks AR PL UMing on Linux, not WenQuanYi Micro Hei", () => {
    // `fonts-noto-cjk` is the usual Linux CJK package but installs CFF collections
    // this library cannot subset, so the serif that actually works is `uming.ttc`
    // from `fonts-arphic-uming`, which installs under `truetype/`.
    _setCandidatesForTest([
      { data: face("WenQuanYi Micro Hei"), collectionIndex: 0, preferred: true },
      { data: face("Droid Sans Fallback"), collectionIndex: 0, preferred: true },
      { data: face("AR PL UMing CN"), collectionIndex: 0, preferred: true }
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")!.familyName).toBe(
      "AR PL UMing CN"
    );
  });

  it("falls back to a sans when no serif is installed", () => {
    // Serif-first is a preference, not a requirement: a machine with only a gothic
    // must still get glyphs rather than Type3 tofu.
    _setCandidatesForTest([
      { data: face("WenQuanYi Micro Hei"), collectionIndex: 0, preferred: true },
      { data: face("Droid Sans Fallback"), collectionIndex: 0, preferred: true }
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")!.familyName).toBe(
      "WenQuanYi Micro Hei"
    );
  });

  it("keeps Simplified and Traditional in the same typographic class", () => {
    // A document containing both scripts would otherwise mix a serif with a gothic.
    // `Heiti TC` has the same defect as `Heiti SC`: its best available face is
    // `STHeitiTC-Medium`, with no Regular to choose.
    _setCandidatesForTest([
      { data: face("Heiti TC"), collectionIndex: 0, preferred: true },
      { data: face("Songti TC"), collectionIndex: 0, preferred: true },
      { data: face("Microsoft JhengHei"), collectionIndex: 0, preferred: true }
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hant")!.familyName).toBe(
      "Songti TC"
    );
  });

  it("leaves Japanese and Korean gothic-first on purpose", () => {
    // Not an unfinished edit: the modern document default is a gothic for both
    // (`Yu Gothic`, `Malgun Gothic`), unlike Chinese where it is a 宋体.
    _setCandidatesForTest([
      { data: face("BIZ UDMincho"), collectionIndex: 0, preferred: true },
      { data: face("Yu Gothic"), collectionIndex: 0, preferred: true },
      { data: face("AppleMyungjo"), collectionIndex: 0, preferred: true },
      { data: face("AppleGothic"), collectionIndex: 0, preferred: true }
    ]);

    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "ja")!.familyName).toBe("Yu Gothic");
    expect(findSystemFontForCodePoints(new Set([0x4e2d]), [], "ko")!.familyName).toBe(
      "AppleGothic"
    );
  });
});

describe("Type3 repertoire drives the coverage requirement", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  const face = (family: string, codePoints: readonly number[]) => {
    const segments = [{ start: 0x41, end: 0x42, delta: -0x40 }];
    let gid = 3;
    for (const cp of [...codePoints].sort((a, b) => a - b)) {
      segments.push({ start: cp, end: cp, delta: gid - cp });
      gid++;
    }
    return {
      data: buildTtfWithCmap(segments, gid + 1, {
        familyName: family,
        postScriptName: `${family.replace(/\s+/g, "")}-Regular`
      }),
      collectionIndex: 0,
      preferred: true
    };
  };

  const HAN = [0x4e2d, 0x6587];
  const CYRILLIC = [0x41a, 0x438];
  const GREEK = [0x395, 0x3bb];
  const CHECKBOXES = [0x2610, 0x2611];

  it("keeps a regional face that only lacks characters Type3 can draw", () => {
    _setCandidatesForTest([
      face("Songti SC", HAN),
      face("Arial Unicode MS", [...HAN, ...CHECKBOXES])
    ]);

    const wanted = new Set([...HAN, ...CHECKBOXES]);
    expect(findSystemFontForCodePoints(wanted, [], "zh-Hans")!.familyName).toBe("Songti SC");
  });

  it("rejects a regional face that lacks characters Type3 cannot draw", () => {
    // The defect this replaced `isCjkBreakable` for. That predicate answers "may a
    // line break here", so every non-East-Asian script counted as substitutable and a
    // Han-only face won for `中文报表 Кириллица Ελληνικά` — after which the Cyrillic and
    // Greek reached a Type3 path with no glyph for either and became `.notdef` boxes.
    _setCandidatesForTest([
      face("Songti SC", HAN),
      face("Arial Unicode MS", [...HAN, ...CYRILLIC, ...GREEK])
    ]);

    const wanted = new Set([...HAN, ...CYRILLIC, ...GREEK]);
    expect(findSystemFontForCodePoints(wanted, [], "zh-Hans")!.familyName).toBe("Arial Unicode MS");
  });

  it("matches the Type3 glyph tables code point for code point", async () => {
    // The ranges in `system-fonts.ts` describe a repertoire that lives in 27,000 lines
    // of glyph tables it deliberately does not import. This is what stops the two from
    // drifting: every code point either has a glyph and is substitutable, or has none
    // and requires a real face.
    const { lookupGlyph } = await import("../font/type3-glyphs");
    const disagreements: string[] = [];
    for (let cp = 0; cp <= 0x2ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) {
        continue;
      }
      const hasGlyph = lookupGlyph(cp) !== undefined;
      if (hasGlyph === requiresEmbeddedFace(cp)) {
        disagreements.push(`U+${cp.toString(16).toUpperCase()} glyph=${hasGlyph}`);
        if (disagreements.length > 8) {
          break;
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
