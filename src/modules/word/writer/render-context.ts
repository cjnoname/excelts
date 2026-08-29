/**
 * Unified rendering context for DOCX XML serialization.
 * Passed to all writer functions to provide shared state.
 */

import type { WordSecurityPolicy } from "@word/security/policy";
import { DEFAULT_SECURITY_POLICY } from "@word/security/policy";

/**
 * A fully-qualified part name within the package (e.g. "/word/document.xml").
 * Type alias kept for documentation; functionally identical to `string`.
 */
type PartName = string;

/** ID generators for various document elements. */
export interface IdGenerators {
  nextDrawingId(): number;
  nextSdtId(): number;
  nextBookmarkId(): number;
  nextDocPrId(): number;
  nextChartId(): number;
  nextImagePartId(): number;
}

/**
 * Lightweight, content-renderer-facing subset of WordRenderContext.
 *
 * Most leaf renderers (run/paragraph/table/image) only need the rId remap and
 * the hyperlink rId map; passing the full WordRenderContext would couple them
 * to chartRIds/securityPolicy/etc. They take this `RenderHelpers` instead.
 */
export interface RenderHelpers {
  /** See WordRenderContext.imageRIdRemap. */
  readonly imageRemap?: ReadonlyMap<string, string>;
  /** See WordRenderContext.hyperlinkRIds. */
  readonly hyperlinkRIds?: ReadonlyWeakMap<object, string>;
  /**
   * Allocates the next document-wide unique drawing object id, used for
   * `wp:docPr/@id` (and the matching `pic:cNvPr/@id` / `wps:cNvPr/@id`).
   *
   * Word requires every drawing object id to be a unique positive integer
   * across the entire document — including body, headers, footers, footnotes,
   * endnotes, comments and text boxes. The packager seeds a single counter on
   * the render context and exposes it here so every drawing renderer draws
   * from the same id space, regardless of what (possibly duplicate or unset)
   * `drawingId` the model carries.
   *
   * When undefined (e.g. a standalone renderer call without a context),
   * renderers fall back to the model's `drawingId` or `1`.
   */
  readonly nextDocPrId?: () => number;
  /**
   * Raw XML output policy. Controls how preserved/opaque rawXml fragments
   * (opaqueRun, opaqueParagraphChild, opaqueDrawing, _advancedFillXml, …)
   * are emitted. Defaults to `"preserve"` when undefined for backwards
   * compatibility with callers that built helpers without a context.
   */
  readonly rawXmlPolicy?: "preserve" | "strip" | "reject";
}

/**
 * Read-only WeakMap projection.
 * (TS lib doesn't ship one; we mirror the readonly subset of WeakMap.)
 */
interface ReadonlyWeakMap<K extends WeakKey, V> {
  get(key: K): V | undefined;
  has(key: K): boolean;
}

/** Render context passed to all writer functions. */
export interface WordRenderContext {
  /** Current part being rendered. */
  readonly partName: PartName;
  /** Security policy controlling raw XML, external targets, etc. */
  readonly securityPolicy: WordSecurityPolicy;
  /** ID generators (shared across all parts for a single document render). */
  readonly ids: IdGenerators;
  /** Raw XML output policy. If "reject", opaque content throws instead of being written. */
  readonly rawXmlPolicy: "preserve" | "strip" | "reject";
  /** Chart/ChartEx object → rId mapping. Populated by packager before rendering. */
  readonly chartRIds: Map<object, string>;
  /**
   * Optional remap for image relationship IDs that the packager had to rewrite
   * (e.g. when the model's image rId collided with a non-image relationship in
   * the same .rels file). Writers that emit `r:embed` look up this map first
   * and fall back to the original rId stored on the model. The map is keyed by
   * the original (model-side) rId.
   */
  readonly imageRIdRemap: Map<string, string>;
  /**
   * External hyperlink object → rId mapping. The packager registers a
   * relationship for each hyperlink with a `url` and stores the assigned rId
   * here, keyed by the hyperlink object identity. The paragraph writer reads
   * this when emitting `<w:hyperlink r:id="...">` so the model itself is
   * never mutated.
   */
  readonly hyperlinkRIds: WeakMap<object, string>;
  /**
   * AltChunk object → rId mapping. Populated by the packager when registering
   * the relationship for each `w:altChunk`. Renderers prefer this map over
   * `AltChunk.rId` so the caller's model is never mutated, including when
   * the altChunk is nested inside a table cell or SDT and was therefore not
   * cloned by the shallow body copy.
   */
  readonly altChunkRIds: WeakMap<object, string>;
}

/** Create ID generators with given starting values. */
export function createIdGenerators(startValues?: {
  drawingId?: number;
  sdtId?: number;
  bookmarkId?: number;
  docPrId?: number;
  chartId?: number;
  imagePartId?: number;
}): IdGenerators {
  let drawingId = startValues?.drawingId ?? 1;
  let sdtId = startValues?.sdtId ?? 1;
  let bookmarkId = startValues?.bookmarkId ?? 0;
  let docPrId = startValues?.docPrId ?? 1;
  let chartId = startValues?.chartId ?? 1;
  let imagePartId = startValues?.imagePartId ?? 1;

  return {
    nextDrawingId: () => drawingId++,
    nextSdtId: () => sdtId++,
    nextBookmarkId: () => bookmarkId++,
    nextDocPrId: () => docPrId++,
    nextChartId: () => chartId++,
    nextImagePartId: () => imagePartId++
  };
}

/** Create a default render context. */
export function createRenderContext(options?: {
  partName?: PartName;
  securityPolicy?: WordSecurityPolicy;
  chartRIds?: Map<object, string>;
  imageRIdRemap?: Map<string, string>;
  hyperlinkRIds?: WeakMap<object, string>;
  altChunkRIds?: WeakMap<object, string>;
  /**
   * Pre-built ID generators. When provided, the caller is responsible for
   * seeding them (e.g. with the maximum existing SDT id in the document so
   * auto-assigned IDs don't collide with author-supplied ones).
   */
  ids?: IdGenerators;
}): WordRenderContext {
  const securityPolicy = options?.securityPolicy ?? DEFAULT_SECURITY_POLICY;

  return {
    partName: options?.partName ?? "/word/document.xml",
    securityPolicy,
    ids: options?.ids ?? createIdGenerators(),
    rawXmlPolicy: securityPolicy.rawXmlPolicy ?? "preserve",
    chartRIds: options?.chartRIds ?? new Map(),
    imageRIdRemap: options?.imageRIdRemap ?? new Map(),
    hyperlinkRIds: options?.hyperlinkRIds ?? new WeakMap(),
    altChunkRIds: options?.altChunkRIds ?? new WeakMap()
  };
}
