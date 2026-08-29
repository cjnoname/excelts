import { PdfFontError } from "@pdf/errors";
import { parseTtf } from "@pdf/font/ttf-parser";
import type { TtfFont } from "@pdf/font/ttf-parser";

/**
 * TrueType font bytes, or one face selected from a TrueType Collection (TTC).
 * A bare `Uint8Array` is equivalent to `{ data, collectionIndex: 0 }`.
 */
export type PdfFontSource =
  | Uint8Array
  | {
      readonly data: Uint8Array;
      readonly collectionIndex?: number;
    };

/** Style faces for one family. `regular` is required and substitutes for omitted styles. */
export interface PdfFontFaces {
  readonly regular: PdfFontSource;
  readonly bold?: PdfFontSource;
  readonly italic?: PdfFontSource;
  readonly boldItalic?: PdfFontSource;
}

/** A selectable font family and its case-insensitive alternative names. */
export interface PdfNamedFontFamily {
  /** Family name used by source content and text drawing APIs. */
  readonly name: string;
  /** Additional names that resolve to this family, matched case-insensitively. */
  readonly aliases?: readonly string[];
  /** TrueType sources for the family's regular and optional styled faces. */
  readonly faces: PdfFontFaces;
}

/**
 * Embedded font-family configuration shared by PDF exporters and the builder.
 *
 * Font selection is deterministic. An unrecognized or omitted family name uses
 * `default`, followed by `fallbackFamilies`. For a recognized family the chain is
 * the requested family, `fallbackFamilies`, then `default`. Selection preserves
 * the requested style across the whole chain first; only when no family has that
 * style and glyph coverage does it degrade the style (for example bold → regular)
 * across the same chain. Fallback keeps each Unicode grapheme on one face; it does
 * not split a grapheme across fonts.
 *
 * The renderer does not perform OpenType shaping (GSUB/GPOS), bidi reordering,
 * or color-emoji rendering.
 */
export interface PdfFontConfig {
  /** Faces used when no configured family name matches. */
  readonly default: PdfFontFaces;
  /** Named families selectable through `name` or any `aliases` entry. */
  readonly families?: readonly PdfNamedFontFamily[];
  /** Ordered names or aliases from `families` used for missing-glyph fallback. */
  readonly fallbackFamilies?: readonly string[];
}

export interface CompiledPdfFontFace {
  readonly data: Uint8Array;
  readonly collectionIndex: number;
  readonly font: TtfFont;
}

export interface CompiledPdfFontFaces {
  readonly regular: CompiledPdfFontFace;
  readonly bold?: CompiledPdfFontFace;
  readonly italic?: CompiledPdfFontFace;
  readonly boldItalic?: CompiledPdfFontFace;
}

export interface CompiledPdfNamedFontFamily {
  readonly name: string;
  readonly normalizedName: string;
  readonly aliases: readonly string[];
  readonly normalizedAliases: readonly string[];
  readonly faces: CompiledPdfFontFaces;
}

export interface CompiledPdfFontConfig {
  readonly default: CompiledPdfFontFaces;
  readonly families: readonly CompiledPdfNamedFontFamily[];
  readonly fallbackFamilies: readonly CompiledPdfNamedFontFamily[];
}

/** Compile and validate a font configuration into an isolated immutable snapshot. */
export function compilePdfFontConfig(config: PdfFontConfig): CompiledPdfFontConfig {
  if (config === null || typeof config !== "object") {
    throw new PdfFontError("PDF font config must be an object");
  }

  const defaultFaces = compileFaces(config.default, "default");
  const inputFamilies = config.families ?? [];
  if (!Array.isArray(inputFamilies)) {
    throw new PdfFontError("PDF font families must be an array");
  }

  const claimedNames = new Map<string, string>();
  const familyLookup = new Map<string, CompiledPdfNamedFontFamily>();
  const families = inputFamilies.map((family, index) => {
    if (family === null || typeof family !== "object") {
      throw new PdfFontError(`PDF font family at index ${index} must be an object`);
    }
    const name = cleanFamilyName(family.name, `family at index ${index}`);
    const normalizedName = normalizeFamilyName(name);
    claimFamilyName(claimedNames, normalizedName, name);

    const inputAliases = family.aliases ?? [];
    if (!Array.isArray(inputAliases)) {
      throw new PdfFontError(`Aliases for PDF font family '${name}' must be an array`);
    }
    const aliases = inputAliases.map((alias, aliasIndex) =>
      cleanFamilyName(alias, `alias ${aliasIndex} for family '${name}'`)
    );
    const normalizedAliases = aliases.map(alias => normalizeFamilyName(alias));
    for (let i = 0; i < aliases.length; i++) {
      claimFamilyName(claimedNames, normalizedAliases[i], aliases[i]);
    }

    const compiled = Object.freeze({
      name,
      normalizedName,
      aliases: Object.freeze(aliases),
      normalizedAliases: Object.freeze(normalizedAliases),
      faces: compileFaces(family.faces, `family '${name}'`)
    });
    familyLookup.set(normalizedName, compiled);
    for (const alias of normalizedAliases) {
      familyLookup.set(alias, compiled);
    }
    return compiled;
  });

  const inputFallbacks = config.fallbackFamilies ?? [];
  if (!Array.isArray(inputFallbacks)) {
    throw new PdfFontError("PDF fallback font families must be an array");
  }
  const fallbackFamilies = inputFallbacks.map((fallback, index) => {
    const name = cleanFamilyName(fallback, `fallback family at index ${index}`);
    const family = familyLookup.get(normalizeFamilyName(name));
    if (!family) {
      throw new PdfFontError(`Fallback font family '${name}' is not configured`);
    }
    return family;
  });
  return Object.freeze({
    default: defaultFaces,
    families: Object.freeze(families),
    fallbackFamilies: Object.freeze(fallbackFamilies)
  });
}

function compileFaces(faces: PdfFontFaces, label: string): CompiledPdfFontFaces {
  if (faces === null || typeof faces !== "object") {
    throw new PdfFontError(`PDF font faces for ${label} must be an object`);
  }
  if (faces.regular === undefined) {
    throw new PdfFontError(`PDF font faces for ${label} must define regular`);
  }
  return Object.freeze({
    regular: compileFace(faces.regular, `${label}.regular`),
    ...(faces.bold === undefined ? {} : { bold: compileFace(faces.bold, `${label}.bold`) }),
    ...(faces.italic === undefined ? {} : { italic: compileFace(faces.italic, `${label}.italic`) }),
    ...(faces.boldItalic === undefined
      ? {}
      : { boldItalic: compileFace(faces.boldItalic, `${label}.boldItalic`) })
  });
}

/**
 * Compile one face, failing on any font this writer cannot embed.
 *
 * Every supplied face is required to parse, including the optional ones: `bold?`
 * means the caller may omit it, not that a broken file is acceptable. Silently
 * dropping an unusable face would produce a document whose bold runs are quietly
 * drawn in regular, which the caller has no way to detect and no way to turn
 * back into an error. Failing here keeps both options open — a caller that
 * genuinely wants the degraded output can catch this and omit the face.
 *
 * `parseTtf` reports what is wrong with the font but knows nothing about where
 * it came from, so its message is wrapped with the face's position in the
 * config (`default.bold`, `family 'Song'.italic`) and chained as `cause`.
 */
function compileFace(source: PdfFontSource, label: string): CompiledPdfFontFace {
  const direct = source instanceof Uint8Array;
  if (!direct && (source === null || typeof source !== "object")) {
    throw new PdfFontError(`PDF font source for ${label} must contain Uint8Array data`);
  }
  const sourceData = direct ? source : source.data;
  const collectionIndex = direct ? 0 : (source.collectionIndex ?? 0);
  if (!(sourceData instanceof Uint8Array)) {
    throw new PdfFontError(`PDF font source for ${label} must contain Uint8Array data`);
  }
  const data = sourceData.slice();
  try {
    return Object.freeze({ data, collectionIndex, font: parseTtf(data, collectionIndex) });
  } catch (error) {
    throw new PdfFontError(
      `PDF font face ${label} could not be parsed: ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error }
    );
  }
}

function cleanFamilyName(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PdfFontError(`PDF font ${label} name must be a string`);
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new PdfFontError(`PDF font ${label} name must not be empty`);
  }
  return name;
}

function normalizeFamilyName(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

function claimFamilyName(claimed: Map<string, string>, normalized: string, display: string): void {
  const previous = claimed.get(normalized);
  if (previous !== undefined) {
    throw new PdfFontError(`PDF font name '${display}' conflicts with '${previous}'`);
  }
  claimed.set(normalized, display);
}
