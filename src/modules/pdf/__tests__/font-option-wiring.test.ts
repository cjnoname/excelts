import { addChart, getCharts } from "@excel/core/worksheet";
import { Workbook, Worksheet } from "@excel/index";
import { buildTtfWithCmap } from "@pdf/__tests__/ttf-test-utils";
import { PdfDocumentBuilder } from "@pdf/builder/document-builder";
import { chartToPdf, excelToPdf } from "@pdf/excel-bridge";
import { findSystemFontForCodePoints, resetFontDiscoveryCache } from "@pdf/font/system-fonts";
import { pdf } from "@pdf/pdf";
import { docxToPdf } from "@pdf/word-bridge";
import type { CjkLanguage } from "@utils/cjk";
import type { DocxDocument } from "@word/types";
/**
 * The font options have to reach the face that is actually embedded.
 *
 * Both bridges built their own `PdfDocumentBuilder` and passed only `fonts`, so
 * `preferSystemFonts` and `textLanguage` were accepted, documented, applied during
 * *layout* — and then discarded. `build()` ran its own font discovery from its own
 * code points and its own language tally, which meant a document could be measured
 * with one typeface and drawn with another.
 *
 * These are end-to-end: they read the `/FontName` out of the finished PDF, so they
 * fail if the option stops reaching the embedded font for any reason.
 *
 * They therefore need the host to *have* the faces they name, which a CI runner may
 * not: an Ubuntu image ships DejaVu, Liberation and Noto Color Emoji and no CJK face
 * at all. Each test states the face it requires and is reported as skipped when it is
 * absent, rather than failing for a reason that has nothing to do with the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";

/** The subset name of the first embedded face, or `(none)`. */
function embeddedFace(bytes: Uint8Array): string {
  const m = /\/FontName\s*\/([^\s/>\]]+)/.exec(new TextDecoder("latin1").decode(bytes));
  return m ? m[1].replace(/-Subset$/, "") : "(none)";
}

const PROBE_CPS = new Set([..."中文报表"].map(c => c.codePointAt(0)!));

/**
 * Whether this host can supply a face for `family`.
 *
 * Memoised, and evaluated while the suite is collected, so the `afterEach` reset
 * below cannot interfere with it.
 */
const familyProbe = new Map<string, boolean>();
function hasFamily(family: string): boolean {
  let hit = familyProbe.get(family);
  if (hit === undefined) {
    hit = findSystemFontForCodePoints(PROBE_CPS, [family])?.familyName === family;
    familyProbe.set(family, hit);
    resetFontDiscoveryCache();
  }
  return hit;
}

/** Whether a face whose name matches `expect` is reachable for `language`. */
const languageProbe = new Map<string, boolean>();
function hasLanguageFace(language: CjkLanguage, matcher: RegExp): boolean {
  const key = `${language}:${matcher.source}`;
  let hit = languageProbe.get(key);
  if (hit === undefined) {
    const found = findSystemFontForCodePoints(PROBE_CPS, [], language);
    hit = found !== null && matcher.test(found.postScriptName ?? found.familyName);
    languageProbe.set(key, hit);
    resetFontDiscoveryCache();
  }
  return hit;
}

/** A face covering `text`, for tests that only need *some* CJK font. */
function hasCoverageFor(text: string): boolean {
  const cps = new Set([...text].map(c => c.codePointAt(0)!));
  const found = findSystemFontForCodePoints(cps, []);
  resetFontDiscoveryCache();
  return found !== null;
}

const CHINESE_DOC: DocxDocument = {
  body: [
    { type: "paragraph", children: [{ content: [{ type: "text", text: "中文报表楷体测试" }] }] }
  ]
};

afterEach(() => {
  resetFontDiscoveryCache();
});

describe("Word → PDF", () => {
  it.skipIf(!hasFamily("Kaiti SC") || !hasFamily("Songti SC"))(
    "should embed the family named by preferSystemFonts",
    async () => {
      // These three faces all cover the text, so only the option distinguishes them.
      const kaiti = embeddedFace(await docxToPdf(CHINESE_DOC, { preferSystemFonts: ["Kaiti SC"] }));
      const songti = embeddedFace(
        await docxToPdf(CHINESE_DOC, { preferSystemFonts: ["Songti SC"] })
      );
      expect(kaiti).not.toBe(songti);
      expect(kaiti.toLowerCase()).toContain("kaiti");
      expect(songti.toLowerCase()).toContain("songti");
    }
  );

  it.skipIf(!hasLanguageFace("zh-Hans", /SC/) || !hasLanguageFace("zh-Hant", /TC/))(
    "should embed a face matching textLanguage",
    async () => {
      const hans = embeddedFace(await docxToPdf(CHINESE_DOC, { textLanguage: "zh-Hans" }));
      const hant = embeddedFace(await docxToPdf(CHINESE_DOC, { textLanguage: "zh-Hant" }));
      expect(hans).not.toBe(hant);
      expect(hans).toMatch(/SC/);
      expect(hant).toMatch(/TC/);
    }
  );

  it.skipIf(!hasFamily("Songti SC"))(
    "should embed a regular weight, not whichever face came first",
    async () => {
      // macOS `Songti.ttc` lists `Songti SC` Black before its Regular.
      const name = embeddedFace(await docxToPdf(CHINESE_DOC, { preferSystemFonts: ["Songti SC"] }));
      expect(name).not.toMatch(/Black|Bold/i);
    }
  );
});

describe("chart → PDF", () => {
  const chineseChart = () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["第一季度", 10],
      ["第二季度", 20]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        title: "中文图表标题营业额毛利率",
        series: [{ name: "销售额", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    return getCharts(ws)[0];
  };

  it.skipIf(!hasFamily("Kaiti SC") || !hasFamily("Songti SC"))(
    "should honour preferSystemFonts",
    async () => {
      // A standalone chart's labels are text like any other, and this was the one
      // entry point with no way to ask for a regional face.
      const { chartToPdf } = await import("@pdf/excel-bridge");
      const chart = chineseChart();
      const kaiti = embeddedFace(await chartToPdf(chart, { preferSystemFonts: ["Kaiti SC"] }));
      const songti = embeddedFace(await chartToPdf(chart, { preferSystemFonts: ["Songti SC"] }));
      expect(kaiti).not.toBe(songti);
      expect(kaiti.toLowerCase()).toContain("kaiti");
    }
  );

  it.skipIf(!hasLanguageFace("zh-Hans", /SC/) || !hasLanguageFace("zh-Hant", /TC/))(
    "should honour textLanguage",
    async () => {
      const { chartToPdf } = await import("@pdf/excel-bridge");
      const chart = chineseChart();
      expect(embeddedFace(await chartToPdf(chart, { textLanguage: "zh-Hant" }))).toMatch(/TC/);
      expect(embeddedFace(await chartToPdf(chart, { textLanguage: "zh-Hans" }))).toMatch(/SC/);
    }
  );
});

describe("shared font engine", () => {
  // Sharing the engine stopped the builder from discovering a *second* time, which
  // is what kept measurement and drawing on one face. But it also meant a face
  // chosen for the body was never reconsidered — and a chart paints its own axis
  // and category labels straight onto the page, so they are not in the layout model
  // the bridge measured. `龦` exists in Heiti SC and not in Kaiti SC, so a document
  // pinned to Kaiti SC lost it to a `.notdef` box.
  const LATE = "龦";

  it.skipIf(!hasFamily("Kaiti SC") || !hasCoverageFor(`中文报表${LATE}`))(
    "should widen a shared fallback face that cannot draw everything",
    async () => {
      const { FontManager } = await import("@pdf/font/font-manager");
      const { PdfDocumentBuilder } = await import("@pdf/builder/document-builder");
      const { findSystemFontForCodePoints } = await import("@pdf/font/system-fonts");

      const shared = new FontManager();
      const narrow = findSystemFontForCodePoints(
        new Set([..."中文报表"].map(c => c.codePointAt(0)!)),
        ["Kaiti SC"]
      );
      expect(narrow?.familyName).toBe("Kaiti SC");
      shared.registerFallbackFont(narrow!);

      const doc = new PdfDocumentBuilder({ fontManager: shared });
      doc.addPage().drawText(`中文报表${LATE}`, { x: 40, y: 700, fontSize: 12 });
      const bytes = await doc.build();

      // A face covering the whole repertoire is embedded, and nothing is left to Type3.
      expect(embeddedFace(bytes)).not.toMatch(/Kaiti/i);
      expect(new TextDecoder("latin1").decode(bytes)).not.toMatch(/\/Subtype\s*\/Type3/);
    }
  );

  it.skipIf(!hasFamily("Kaiti SC"))(
    "should not reconsider a face the caller embedded explicitly",
    async () => {
      // `embedFont` is a statement about the document, not a best-effort guess.
      const { FontManager } = await import("@pdf/font/font-manager");
      const { PdfDocumentBuilder } = await import("@pdf/builder/document-builder");
      const { findSystemFontForCodePoints } = await import("@pdf/font/system-fonts");

      const shared = new FontManager();
      const chosen = findSystemFontForCodePoints(
        new Set([..."中文报表"].map(c => c.codePointAt(0)!)),
        ["Kaiti SC"]
      );
      shared.registerEmbeddedFont(chosen!);

      const doc = new PdfDocumentBuilder({ fontManager: shared });
      doc.addPage().drawText(`中文报表${LATE}`, { x: 40, y: 700, fontSize: 12 });
      expect(embeddedFace(await doc.build())).toMatch(/Kaiti/i);
    }
  );

  it.skipIf(!hasFamily("Songti SC"))(
    "should keep honouring preferSystemFonts through the shared engine",
    async () => {
      // Text the named family fully covers must still use it: the widening path must
      // not be triggered spuriously, and the request has to survive being handed to
      // the builder along with the engine.
      const bytes = await docxToPdf(
        {
          body: [
            { type: "paragraph", children: [{ content: [{ type: "text", text: "中文报表" }] }] }
          ]
        },
        { preferSystemFonts: ["Songti SC"] }
      );
      expect(embeddedFace(bytes).toLowerCase()).toContain("songti");
    }
  );

  it.skipIf(!hasFamily("Songti SC") || !hasCoverageFor(`中文报表${LATE}`))(
    "should fall back past a named family that cannot draw the text",
    async () => {
      // `Songti SC` has no 龦. Naming it steers the search; it does not override
      // coverage, so a face that can draw everything wins — which is the same rule
      // that applies without a shared engine.
      const bytes = await docxToPdf(
        {
          body: [
            {
              type: "paragraph",
              children: [{ content: [{ type: "text", text: `中文报表${LATE}` }] }]
            }
          ]
        },
        { preferSystemFonts: ["Songti SC"] }
      );
      expect(embeddedFace(bytes).toLowerCase()).not.toContain("songti");
      expect(new TextDecoder("latin1").decode(bytes)).not.toMatch(/\/Subtype\s*\/Type3/);
    }
  );
});

describe("auto-embedding a host font is reported by every entry point", () => {
  // The warning existed at the one discovery site inside `PdfDocumentBuilder.build()`,
  // so `Pdf.create`, `Pdf.fromExcel` and `Pdf.fromDocx` — which discover in their own
  // pipelines — embedded a face off the host and said nothing. Those are the entry
  // points most likely to be producing a golden file, and the output stops being
  // reproducible the moment it happens. It is now noted on the `FontManager` and
  // raised by `reportDiagnostics`, which every pipeline calls.
  const ZH = "报表汇总";
  const autoWarning = (messages: readonly string[]): string | undefined =>
    messages.find(m => m.includes("Auto-embedded system font"));

  const cjkWorkbook = (): Workbook.Handle => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [[ZH]]);
    return wb;
  };

  it.each([
    ["Pdf.create", (w: (m: string) => void) => pdf({ name: "s", data: [[ZH]] }, { onWarning: w })],
    ["Pdf.fromExcel", (w: (m: string) => void) => excelToPdf(cjkWorkbook(), { onWarning: w })],
    [
      "Pdf.fromDocx",
      (w: (m: string) => void) =>
        docxToPdf(
          { body: [{ type: "paragraph", children: [{ content: [{ type: "text", text: ZH }] }] }] },
          { onWarning: w }
        )
    ]
  ])("should report it through %s", async (_label, run) => {
    const messages: string[] = [];
    const bytes = await run(m => messages.push(m));
    // Only meaningful on a host that actually has a CJK face to find.
    if (embeddedFace(bytes) === "(none)") {
      return;
    }
    expect(autoWarning(messages)).toBeDefined();
  });

  it("should stay silent when the caller supplied the font", async () => {
    // `embedFont` / `fonts` is a statement about the document, not a guess, so there
    // is nothing to report.
    const codePoints = [...new Set([...ZH])].map(c => c.codePointAt(0)!);
    const face = buildTtfWithCmap(
      codePoints.map((cp, i) => ({ start: cp, end: cp, delta: 10 + i - cp })),
      40,
      { familyName: "MyFace", postScriptName: "MyFace-Regular" }
    );
    const messages: string[] = [];
    await excelToPdf(cjkWorkbook(), {
      fonts: { default: { regular: face } },
      onWarning: m => messages.push(m)
    });
    expect(autoWarning(messages)).toBeUndefined();
  });
});

describe("disableFontAutoDiscovery", () => {
  // The scan is what turns CJK text into glyphs instead of `.notdef` boxes, but it
  // also makes the output a function of the host: the same workbook embeds Heiti SC
  // on a Mac and nothing on a bare container. `PdfDocumentBuilder` could opt out;
  // the four bridge entry points could not, so a caller who needed reproducible
  // bytes had no way to ask for them — and no way to tell that a scan had happened.
  //
  // These assert the *absence* of a scan rather than the absence of a particular
  // font, which is the only host-independent form: on a runner with no CJK face the
  // default path also embeds nothing, so comparing embedded names would pass for
  // the wrong reason.
  const ZH = "中文报表销售数据";

  const cjkWorkbook = (): Workbook.Handle => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [[ZH]]);
    return wb;
  };

  const docxDoc: DocxDocument = {
    body: [{ type: "paragraph", children: [{ content: [{ type: "text", text: ZH }] }] }]
  };

  const type3Count = (bytes: Uint8Array): number =>
    (new TextDecoder("latin1").decode(bytes).match(/\/Subtype\s*\/Type3/g) ?? []).length;

  it.each([
    ["Pdf.create", () => pdf({ name: "s", data: [[ZH]] }, { disableFontAutoDiscovery: true })],
    ["Pdf.fromExcel", () => excelToPdf(cjkWorkbook(), { disableFontAutoDiscovery: true })],
    ["Pdf.fromDocx", () => docxToPdf(docxDoc, { disableFontAutoDiscovery: true })]
  ])("should embed no discovered face through %s", async (_label, run) => {
    const bytes = await run();
    expect(embeddedFace(bytes)).toBe("(none)");
    // The characters are still there for copy and search; only glyphs are lost.
    expect(type3Count(bytes)).toBeGreaterThan(0);
  });

  it("should embed no discovered face through Pdf.fromChart", async () => {
    // A standalone chart draws its own labels straight onto the page, so it is a
    // separate pipeline from the workbook exporter and needed the option too.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Worksheet.addRows(ws, [
      ["第一季度", 10],
      ["第二季度", 20]
    ]);
    addChart(
      ws,
      {
        type: "bar",
        title: "中文图表标题",
        series: [{ name: "销售额", categories: "Sheet1!$A$1:$A$2", values: "Sheet1!$B$1:$B$2" }]
      },
      "D1:J10"
    );
    const bytes = await chartToPdf(getCharts(ws)[0], { disableFontAutoDiscovery: true });
    expect(embeddedFace(bytes)).toBe("(none)");
    expect(type3Count(bytes)).toBeGreaterThan(0);
  });

  it("should be accepted as a builder option, not only as a method", async () => {
    // The bridges forward a whole options object; a chained call is easy to forget,
    // which is how the option came to be honoured unevenly.
    const viaOption = new PdfDocumentBuilder({ disableFontAutoDiscovery: true });
    viaOption.addPage().drawText(ZH, { x: 40, y: 700, fontSize: 12 });
    expect(embeddedFace(await viaOption.build())).toBe("(none)");

    const viaMethod = new PdfDocumentBuilder().disableFontAutoDiscovery();
    viaMethod.addPage().drawText(ZH, { x: 40, y: 700, fontSize: 12 });
    expect(embeddedFace(await viaMethod.build())).toBe("(none)");
  });

  it("should still embed a font the caller supplied explicitly", async () => {
    // The flag disables *discovery*, not embedding — otherwise the deterministic
    // path could not produce readable CJK at all.
    const codePoints = [...new Set([...ZH])].map(c => c.codePointAt(0)!);
    const custom = buildTtfWithCmap(
      codePoints.map((cp, i) => ({ start: cp, end: cp, delta: 10 + i - cp })),
      40,
      { familyName: "MyFace", postScriptName: "MyFace-Regular" }
    );
    const bytes = await excelToPdf(cjkWorkbook(), {
      disableFontAutoDiscovery: true,
      fonts: { default: { regular: custom } }
    });
    expect(embeddedFace(bytes)).toContain("MyFace");
    expect(type3Count(bytes)).toBe(0);
  });

  it("should produce identical bytes across runs", async () => {
    // The point of the option: no dependence on what the host has installed.
    const first = await excelToPdf(cjkWorkbook(), { disableFontAutoDiscovery: true });
    const second = await excelToPdf(cjkWorkbook(), { disableFontAutoDiscovery: true });
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
  });

  it("should still report what could not be drawn", async () => {
    // Turning the scan off must not turn the diagnostic off with it, or the caller
    // trades a host dependency for a silent one.
    const warnings: string[] = [];
    await pdf(
      { name: "s", data: [[ZH]] },
      { disableFontAutoDiscovery: true, onWarning: m => warnings.push(m) }
    );
    expect(warnings.some(m => m.includes("no glyph in any available font"))).toBe(true);
  });
});

describe("Type3 widths are loaded before layout", () => {
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  /**
   * `U+2003` EM SPACE is one em in the Type3 tables and `U+200B` ZERO WIDTH SPACE is
   * zero, so either one exposes the difference between measuring at the 600 default and
   * measuring at the real width.
   */
  const EM_SPACE = "\u2003";

  /** Whether the host has a Chinese face that lacks the Type3 spaces, as macOS does. */
  const incompleteFallback = (): boolean => {
    resetFontDiscoveryCache();
    const face = findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans");
    return face !== null && !face.cmap.has(0x2003);
  };

  it.skipIf(!incompleteFallback())(
    "measures a Type3 space at its real width once a regional face is registered",
    async () => {
      // The defect: registering an incomplete fallback made `hasEmbeddedFont()` true, so
      // the exporter skipped seeding the repertoire and loading Type3 widths. Layout then
      // measured `U+2003` at 600/1000 em while the page drew it at 1000/1000 — 40% of an
      // em per character, enough to move a line break or a page boundary.
      const { FontManager } = await import("@pdf/font/font-manager");
      const face = findSystemFontForCodePoints(new Set([0x4e2d]), [], "zh-Hans")!;

      const manager = new FontManager();
      manager.registerFallbackFont(face);
      const resource = manager.resolveFont("Helvetica", false, false);
      manager.trackText(EM_SPACE, resource);
      await manager.prepare();

      // One em at 100pt, not 0.6 em.
      expect(manager.measureText(EM_SPACE, resource, 100)).toBeCloseTo(100, 3);
    }
  );
});
