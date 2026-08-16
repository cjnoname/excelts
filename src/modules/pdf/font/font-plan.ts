/**
 * Build-local font selection and measurement.
 *
 * Planning deliberately does not perform shaping, script reordering, kerning,
 * or glyph substitution. Consumers that need those features must shape text
 * before PDF encoding; this planner only keeps grapheme clusters on one face.
 */

import type {
  CompiledPdfFontConfig,
  CompiledPdfFontFace,
  CompiledPdfFontFaces,
  CompiledPdfNamedFontFamily
} from "@pdf/font/font-config";
import { getCharWidth, getFontAscent, getFontDescent } from "@pdf/font/metrics";
import type { TtfFont } from "@pdf/font/ttf-parser";

export interface TextIntent {
  readonly text: string;
  readonly family?: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

export type FontPlanFaceKind = "ttf" | "type1" | "type3";

interface FontPlanFaceBase {
  readonly kind: FontPlanFaceKind;
  readonly ascent: number;
  readonly descent: number;
  readonly hasGlyph: (codePoint: number) => boolean;
  readonly width: (codePoint: number) => number;
}

export interface TtfFontPlanFace extends FontPlanFaceBase {
  readonly kind: "ttf";
  readonly font: TtfFont;
  readonly source?: CompiledPdfFontFace;
}

export interface Type1FontPlanFace extends FontPlanFaceBase {
  readonly kind: "type1";
  readonly fontName: string;
}

export interface Type3FontPlanFace extends FontPlanFaceBase {
  readonly kind: "type3";
}

export type FontPlanFaceInput = TtfFontPlanFace | Type1FontPlanFace | Type3FontPlanFace;

export interface FontPlanFaces {
  readonly regular: FontPlanFaceInput;
  readonly bold?: FontPlanFaceInput;
  readonly italic?: FontPlanFaceInput;
  readonly boldItalic?: FontPlanFaceInput;
}

export interface FontPlanFamily {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly faces: FontPlanFaces;
}

/** Generic input used by Type1/Type3 callers and tests. */
export interface FontPlanConfig {
  readonly default: FontPlanFaces;
  readonly families?: readonly FontPlanFamily[];
  readonly fallbackFamilies?: readonly string[];
}

export interface PlannedFontFace {
  readonly id: string;
  readonly kind: FontPlanFaceKind;
  readonly resourceName: string;
  readonly codepoints: ReadonlySet<number>;
  readonly source: FontPlanFaceInput;
}

export interface PlannedTextSegment {
  readonly intentIndex: number;
  readonly faceId: string;
  readonly kind: FontPlanFaceKind;
  readonly resourceName: string;
  readonly text: string;
  readonly codepoints: readonly number[];
  /** Advance, ascent, and descent are normalized to em units. */
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
}

export interface PlannedTextIntent {
  readonly intent: TextIntent;
  readonly segments: readonly PlannedTextSegment[];
}

export interface FinalizedFontPlan {
  readonly faces: readonly PlannedFontFace[];
  readonly intents: readonly PlannedTextIntent[];
  readonly segments: readonly PlannedTextSegment[];
}

export interface FontPlanBuilder {
  collect(intent: TextIntent): void;
  finalize(): FinalizedFontPlan;
}

interface InternalFamily {
  readonly id: string;
  readonly normalizedName: string;
  readonly normalizedAliases: readonly string[];
  readonly faces: FontPlanFaces;
}

interface InternalConfig {
  readonly defaultFamily: InternalFamily;
  readonly familyLookup: ReadonlyMap<string, InternalFamily>;
  readonly fallbackFamilies: readonly InternalFamily[];
}

interface SelectedCluster {
  readonly faceId: string;
  readonly face: FontPlanFaceInput;
  text: string;
  codepoints: number[];
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Create a planner from compiled TTF configuration, generic faces, or one legacy TTF face. */
export function buildFontPlan(
  input: CompiledPdfFontConfig | FontPlanConfig | CompiledPdfFontFace
): FontPlanBuilder {
  const config = normalizeConfig(input);
  const intents: TextIntent[] = [];
  let finalized: FinalizedFontPlan | undefined;

  return {
    collect(intent) {
      if (finalized) {
        throw new Error("Cannot collect text after the font plan is finalized");
      }
      intents.push(Object.freeze({ ...intent }));
    },
    finalize() {
      if (!finalized) {
        finalized = finalizePlan(config, intents);
      }
      return finalized;
    }
  };
}

/** Create a standard Type1 planning face without registering a PDF object. */
export function createType1FontPlanFace(
  fontName: string,
  hasGlyph: (codePoint: number) => boolean = isWinAnsiCodePoint
): Type1FontPlanFace {
  return Object.freeze({
    kind: "type1",
    fontName,
    ascent: getFontAscent(fontName, 1),
    descent: getFontDescent(fontName, 1),
    hasGlyph,
    width: codePoint => getCharWidth(codePoint, fontName) / 1000
  });
}

/** Create a lightweight Type3 planning face when exact glyph tables are not needed. */
export function createType3FontPlanFace(): Type3FontPlanFace {
  return Object.freeze({
    kind: "type3",
    ascent: 0.8,
    descent: -0.2,
    hasGlyph: () => true,
    width: () => 0.6
  });
}

function finalizePlan(config: InternalConfig, intents: readonly TextIntent[]): FinalizedFontPlan {
  const usedFaces = new Map<string, { face: FontPlanFaceInput; codepoints: Set<number> }>();
  const plannedIntents = intents.map((intent, intentIndex) => {
    const selected = selectSegments(config, intent);
    const segments = selected.map(cluster => {
      let used = usedFaces.get(cluster.faceId);
      if (!used) {
        used = { face: cluster.face, codepoints: new Set<number>() };
        usedFaces.set(cluster.faceId, used);
      }
      for (const codePoint of cluster.codepoints) {
        if (!isCoverageIgnorable(codePoint) || cluster.face.hasGlyph(codePoint)) {
          used.codepoints.add(codePoint);
        }
      }
      return { cluster, intentIndex };
    });
    return { intent, segments };
  });

  const resourceNames = new Map<string, string>();
  const faces = Array.from(usedFaces, ([id, value], index): PlannedFontFace => {
    const resourceName = `FP${index + 1}`;
    resourceNames.set(id, resourceName);
    return Object.freeze({
      id,
      kind: value.face.kind,
      resourceName,
      codepoints: value.codepoints,
      source: value.face
    });
  });
  const completedIntents = plannedIntents.map(({ intent, segments }): PlannedTextIntent =>
    Object.freeze({
      intent,
      segments: Object.freeze(
        segments.map(({ cluster, intentIndex }) =>
          completeSegment(cluster, intentIndex, resourceNames.get(cluster.faceId)!)
        )
      )
    })
  );
  const allSegments = completedIntents.flatMap(item => item.segments);
  return Object.freeze({
    faces: Object.freeze(faces),
    intents: Object.freeze(completedIntents),
    segments: Object.freeze(allSegments)
  });
}

function selectSegments(config: InternalConfig, intent: TextIntent): SelectedCluster[] {
  const families = familyCandidates(config, intent.family);
  const result: SelectedCluster[] = [];
  for (const part of segmenter.segment(intent.text)) {
    const codepoints = Array.from(part.segment, char => char.codePointAt(0)!);
    const selected = selectFace(families, codepoints, intent.bold, intent.italic);
    const previous = result[result.length - 1];
    if (previous?.faceId === selected.faceId) {
      previous.text += part.segment;
      previous.codepoints.push(...codepoints);
    } else {
      result.push({ ...selected, text: part.segment, codepoints });
    }
  }
  return result;
}

function selectFace(
  families: readonly InternalFamily[],
  codepoints: readonly number[],
  bold: boolean,
  italic: boolean
): { faceId: string; face: FontPlanFaceInput } {
  const slotOrder = requestedSlotOrder(bold, italic);
  for (const slot of slotOrder) {
    for (const family of families) {
      const face = family.faces[slot];
      if (!face) {
        continue;
      }
      if (clusterCovered(face, codepoints)) {
        return { faceId: `${family.id}:${slot}`, face };
      }
    }
  }
  const fallback = families[families.length - 1];
  const { slot, face } = faceCandidates(fallback.faces, bold, italic)[0];
  return { faceId: `${fallback.id}:${slot}`, face };
}

function requestedSlotOrder(bold: boolean, italic: boolean): Array<keyof FontPlanFaces> {
  return bold
    ? italic
      ? ["boldItalic", "bold", "italic", "regular"]
      : ["bold", "regular"]
    : italic
      ? ["italic", "regular"]
      : ["regular"];
}

function faceCandidates(
  faces: FontPlanFaces,
  bold: boolean,
  italic: boolean
): Array<{ slot: keyof FontPlanFaces; face: FontPlanFaceInput }> {
  const slots = requestedSlotOrder(bold, italic);
  const result: Array<{ slot: keyof FontPlanFaces; face: FontPlanFaceInput }> = [];
  for (const slot of slots) {
    const face = faces[slot];
    if (face && !result.some(candidate => candidate.face === face)) {
      result.push({ slot, face });
    }
  }
  return result;
}

function familyCandidates(config: InternalConfig, requested: string | undefined): InternalFamily[] {
  const named = requested ? config.familyLookup.get(normalizeName(requested)) : undefined;
  if (!named) {
    return [config.defaultFamily];
  }
  const result: InternalFamily[] = [];
  for (const family of [named, ...config.fallbackFamilies, config.defaultFamily]) {
    if (!result.includes(family)) {
      result.push(family);
    }
  }
  return result;
}

function clusterCovered(face: FontPlanFaceInput, codepoints: readonly number[]): boolean {
  return codepoints.every(codePoint => isCoverageIgnorable(codePoint) || face.hasGlyph(codePoint));
}

function completeSegment(
  selected: SelectedCluster,
  intentIndex: number,
  resourceName: string
): PlannedTextSegment {
  const width = selected.codepoints.reduce((sum, codePoint) => {
    if (isCoverageIgnorable(codePoint)) {
      return sum;
    }
    // TTF faces report their .notdef advance for uncovered code points. Using
    // zero here would make layout disagree with the /W entry the viewer uses.
    return sum + selected.face.width(codePoint);
  }, 0);
  return Object.freeze({
    intentIndex,
    faceId: selected.faceId,
    kind: selected.face.kind,
    resourceName,
    text: selected.text,
    codepoints: Object.freeze(selected.codepoints),
    width,
    ascent: selected.face.ascent,
    descent: selected.face.descent
  });
}

function normalizeConfig(
  input: CompiledPdfFontConfig | FontPlanConfig | CompiledPdfFontFace
): InternalConfig {
  if (isCompiledFace(input)) {
    return genericConfig({ default: { regular: ttfFace(input) } });
  }
  if (isCompiledConfig(input)) {
    const families = input.families.map(compiledFamily);
    const lookup = new Map(
      families.flatMap(family => familyNames(family).map(name => [name, family]))
    );
    const defaultFamily = internalFamily("default", "", [], compiledFaces(input.default));
    return {
      defaultFamily,
      familyLookup: lookup,
      fallbackFamilies: input.fallbackFamilies.map(family => lookup.get(family.normalizedName)!)
    };
  }
  return genericConfig(input);
}

function genericConfig(input: FontPlanConfig): InternalConfig {
  const families = (input.families ?? []).map((family, index) =>
    internalFamily(
      `family-${index}`,
      normalizeName(family.name),
      (family.aliases ?? []).map(normalizeName),
      family.faces
    )
  );
  const lookup = new Map(
    families.flatMap(family => familyNames(family).map(name => [name, family]))
  );
  const fallbackFamilies = (input.fallbackFamilies ?? []).map(name => {
    const family = lookup.get(normalizeName(name));
    if (!family) {
      throw new Error(`Fallback font family '${name}' is not configured`);
    }
    return family;
  });
  return {
    defaultFamily: internalFamily("default", "", [], input.default),
    familyLookup: lookup,
    fallbackFamilies
  };
}

function compiledFamily(family: CompiledPdfNamedFontFamily, index: number): InternalFamily {
  return internalFamily(
    `family-${index}`,
    family.normalizedName,
    family.normalizedAliases,
    compiledFaces(family.faces)
  );
}

function compiledFaces(faces: CompiledPdfFontFaces): FontPlanFaces {
  return {
    regular: ttfFace(faces.regular),
    ...(faces.bold ? { bold: ttfFace(faces.bold) } : {}),
    ...(faces.italic ? { italic: ttfFace(faces.italic) } : {}),
    ...(faces.boldItalic ? { boldItalic: ttfFace(faces.boldItalic) } : {})
  };
}

function ttfFace(source: CompiledPdfFontFace): TtfFontPlanFace {
  const { font } = source;
  return Object.freeze({
    kind: "ttf",
    font,
    source,
    ascent: font.ascent / font.unitsPerEm,
    descent: font.descent / font.unitsPerEm,
    hasGlyph: codePoint => font.cmap.has(codePoint),
    width: codePoint => {
      const glyphId = font.cmap.get(codePoint) ?? 0;
      // Match the integer 1/1000-em width written to PDF /W exactly. Segment
      // origins are positioned explicitly, so even sub-unit drift would create
      // gaps or overlaps at a fallback boundary.
      return Math.round(((font.advanceWidths[glyphId] ?? 0) * 1000) / font.unitsPerEm) / 1000;
    }
  });
}

function internalFamily(
  id: string,
  normalizedName: string,
  normalizedAliases: readonly string[],
  faces: FontPlanFaces
): InternalFamily {
  return { id, normalizedName, normalizedAliases, faces };
}

function familyNames(family: InternalFamily): string[] {
  return [family.normalizedName, ...family.normalizedAliases];
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function isCompiledFace(value: object): value is CompiledPdfFontFace {
  return "font" in value && "data" in value && "collectionIndex" in value;
}

function isCompiledConfig(value: object): value is CompiledPdfFontConfig {
  return "default" in value && "families" in value && "fallbackFamilies" in value;
}

function isCoverageIgnorable(codePoint: number): boolean {
  if (codePoint === 0x200c || codePoint === 0x200d) {
    return true;
  }
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return true;
  }
  // Combining marks are visible glyphs in this scalar renderer. Keeping the
  // grapheme together is not enough: the selected face must carry the mark or
  // the accent would silently disappear.
  return false;
}

function isWinAnsiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xff) ||
    [
      0x20ac, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
      0x17d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a,
      0x153, 0x17e, 0x178
    ].includes(codePoint)
  );
}
