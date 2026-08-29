/**
 * DOCX Module - Packager
 *
 * Assembles a DocxDocument model into a DOCX ZIP package using the
 * archive and XML modules. Supports all parts including comments,
 * custom properties, document background, hyperlink relationships,
 * and per-header/footer relationship files.
 */

import { zip } from "@archive/create-archive";
import { ContentType, RelType, PartPath, STD_DOC_ATTRIBUTES } from "@word/constants";
import type { Mutable } from "@word/core/internal-utils";
import { sanitizeMediaFileName, sanitizeUrl } from "@word/core/internal-utils";
import { getFileExt, getPartRelsPath } from "@word/core/opc-paths";
import { isRun } from "@word/core/text-utils";
import { walkBlocks } from "@word/core/walker";
import { DocxWriteError } from "@word/errors";
import type { WordSecurityPolicy } from "@word/security/policy";
import { resolveSecurityPolicy } from "@word/security/policy";
import type {
  DocxDocument,
  BodyContent,
  Paragraph,
  ParagraphChild,
  Table,
  Hyperlink,
  HeaderFooterContent,
  HeaderFooterRef,
  Run,
  RunContent,
  FloatingImage,
  InlineImageContent,
  ChartContent,
  ChartExContent,
  AltChunk,
  EmbeddedFont,
  ImageDef,
  SectionProperties
} from "@word/types";
import { renderChartPart } from "@word/writer/chart-writer";
import { renderComments, renderCommentsExtended } from "@word/writer/comment-writer";
import {
  createContentTypes,
  addContentTypeDefault,
  addContentTypeOverride,
  addImageContentTypeDefaults,
  renderContentTypes
} from "@word/writer/content-types";
import { renderDocument } from "@word/writer/document-writer";
import { renderFootnotes, renderEndnotes } from "@word/writer/footnote-writer";
import { renderGlossaryDocument } from "@word/writer/glossary-writer";
import {
  renderHeader,
  renderFooter,
  renderWatermarkHeader
} from "@word/writer/header-footer-writer";
import { renderNumbering } from "@word/writer/numbering-writer";
import {
  renderSettings,
  renderFontTable,
  renderCoreProperties,
  renderAppProperties,
  renderCustomProperties,
  renderWebSettings,
  renderPeople,
  renderTheme
} from "@word/writer/parts-writer";
import {
  collectChartsFromHeaderFooter,
  collectHyperlinksFromHeaderFooter,
  collectImageRidsFromContent,
  scanChildrenForHyperlinks,
  scanChildrenForImages
} from "@word/writer/reference-scanners";
import {
  createRelationships,
  addRelationship,
  addRelationshipWithId,
  getRelationshipCount,
  renderRelationships
} from "@word/writer/relationships";
import type { RelationshipsState } from "@word/writer/relationships";
import { createIdGenerators, createRenderContext } from "@word/writer/render-context";
import { renderStyles } from "@word/writer/styles-writer";
import { XmlWriter } from "@xml/writer";

/** Render XML to string using XmlWriter. */
export function renderXml(renderFn: (xml: XmlWriter) => void): string {
  const writer = new XmlWriter();
  renderFn(writer);
  return writer.xml;
}

/**
 * Walk the document and return the highest `id` used on any
 * `StructuredDocumentTag`. Used to seed the SDT id generator so that
 * auto-assigned ids start strictly above any author-supplied ones — a
 * collision would silently break repeating-section / data-binding linkage
 * because Word matches SDTs by id.
 */
function scanMaxSdtId(doc: DocxDocument): number {
  let max = 0;
  const visit = (blocks: readonly BodyContent[]): void => {
    for (const block of blocks) {
      if (block.type === "sdt") {
        const id = block.properties?.id;
        if (typeof id === "number" && Number.isFinite(id) && id > max) {
          max = id;
        }
        // SDT.content is (Paragraph | Run | Table)[]. Recurse into its
        // tables to find nested SDTs.
        for (const c of block.content) {
          if ((c as { type?: string }).type === "table") {
            visit([c as Table]);
          }
        }
      } else if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            visit(cell.content as readonly BodyContent[]);
          }
        }
      }
    }
  };
  visit(doc.body);
  if (doc.headers) {
    for (const [, h] of doc.headers) {
      visit(h.content.children as readonly BodyContent[]);
    }
  }
  if (doc.footers) {
    for (const [, f] of doc.footers) {
      visit(f.content.children as readonly BodyContent[]);
    }
  }
  return max;
}

/**
 * Recursively collect hyperlinks with a URL (no `rId` yet) from body content.
 */
function collectHyperlinks(body: readonly BodyContent[]): Hyperlink[] {
  const links: Hyperlink[] = [];
  walkBlocks(body, {
    enterParagraph(p) {
      scanChildrenForHyperlinks(p.children, links);
    }
  });
  return links;
}

/**
 * A minimal valid 1×1 transparent PNG.
 *
 * Used as an automatic raster fallback for SVG images that ship without an
 * explicit `fallbackData`. In OOXML, `a:blip/@r:embed` must reference a raster
 * image — Microsoft Word does not rasterize an SVG referenced directly by
 * `a:blip`, so an SVG without a raster fallback renders as a broken/empty
 * picture. By always pairing the SVG (`asvg:svgBlip`) with a raster blip we
 * guarantee the drawing is renderable everywhere: SVG-aware Word shows the
 * vector, older readers show the raster placeholder.
 */
const SVG_RASTER_FALLBACK_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00,
  0x00, 0x05, 0x00, 0x01, 0xe2, 0x26, 0x05, 0x9b, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
]);

/** Infer a content type for an opaque part based on its file extension. */
function inferContentType(ext: string): string | undefined {
  const map: Record<string, string> = {
    xml: "application/xml",
    rels: "application/vnd.openxmlformats-package.relationships+xml",
    png: "image/png",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    tif: "image/tiff",
    svg: "image/svg+xml",
    webp: "image/webp",
    emf: "image/x-emf",
    wmf: "image/x-wmf",
    odttf: "application/vnd.openxmlformats-officedocument.obfuscatedFont",
    ttf: "application/x-font-ttf",
    otf: "application/x-font-otf",
    bin: "application/vnd.openxmlformats-officedocument.oleObject",
    vml: "application/vnd.openxmlformats-officedocument.vmlDrawing"
  };
  return map[ext];
}

/** Resolve the main document part content type based on docType. */
function resolveDocumentContentType(doc: DocxDocument): string {
  switch (doc.docType) {
    case "template":
      return ContentType.Template;
    case "macroEnabledDocument":
      return ContentType.DocumentMacroEnabled;
    case "macroEnabledTemplate":
      return ContentType.TemplateMacroEnabled;
    default:
      return ContentType.Document;
  }
}

/**
 * Options accepted by `packageDocx`.
 *
 * For backwards compatibility the second positional argument may also be a
 * raw number, in which case it is interpreted as `compressionLevel` with the
 * default security policy.
 */
export interface PackageDocxOptions {
  /** ZIP compression level (0-9). Default: backend-specific (typically 6). */
  readonly compressionLevel?: number;
  /**
   * Security policy controlling rawXmlPolicy, OLE/signature handling, etc.
   * Defaults to {@link DEFAULT_SECURITY_POLICY}.
   */
  readonly securityPolicy?: WordSecurityPolicy;
}

/**
 * Package a DocxDocument model into a DOCX ZIP file.
 * Returns the ZIP bytes as Uint8Array.
 *
 * This function does NOT modify the input `doc` object. Internally it creates
 * shallow copies of mutable structures (images, headers, footers, etc.) to
 * assign relationship IDs without polluting the caller's model.
 */
export async function packageDocx(
  doc: DocxDocument,
  options?: PackageDocxOptions
): Promise<Uint8Array> {
  const opts: PackageDocxOptions = options ?? {};
  // Create a working copy so we never mutate the caller's doc
  const workDoc = shallowCopyDocForPackaging(doc);
  return _packageDocxInner(workDoc, opts);
}

/**
 * Create a shallow working copy of the document parts that packageDocx still
 * mutates (header/footer/altChunk/hyperlink rId injection). Binary data
 * (Uint8Array) is shared, not cloned. The image table is intentionally NOT
 * cloned: packaging never rewrites image rIds anymore — collisions are now
 * handled via a render-context remap (see `imageRemap` below).
 */
function shallowCopyDocForPackaging(doc: DocxDocument): DocxDocument {
  // Shallow-copy body so we can wrap floating images / altChunks without
  // touching the caller's array.
  const body = doc.body.map(item => {
    if (item.type === "floatingImage" || item.type === "altChunk") {
      return { ...item };
    }
    return item;
  });

  // Shallow-copy headers/footers maps (their `rId` is still assigned in place
  // for backward compatibility with downstream relationship lookups).
  const headers = doc.headers
    ? new Map(Array.from(doc.headers.entries()).map(([k, v]) => [k, { ...v }]))
    : undefined;
  const footers = doc.footers
    ? new Map(Array.from(doc.footers.entries()).map(([k, v]) => [k, { ...v }]))
    : undefined;

  // Sanitize media/font file names. The fileName attribute eventually
  // becomes a ZIP entry name (`word/media/...`, `word/fonts/...`); a
  // hostile DOCX read in via `readDocx` could carry a fileName like
  // `../../etc/passwd.png`, which without sanitisation would produce a
  // ZIP entry that escapes the package root when consumers naively
  // unpack it (zipslip). Allocate fresh leaf names that are unique
  // within their respective collections so two attacker-supplied names
  // sanitising to the same string don't collide and silently overwrite
  // each other.
  const sanitizeImages = (
    images: readonly ImageDef[] | undefined
  ): readonly ImageDef[] | undefined => {
    if (!images || images.length === 0) {
      return images;
    }
    const usedNames = new Set<string>();
    let mutated = false;
    const result = images.map(img => {
      const safe = uniqueSanitizedName(img.fileName, usedNames, "image.bin");
      if (safe !== img.fileName) {
        mutated = true;
        return { ...img, fileName: safe };
      }
      return img;
    });
    return mutated ? result : images;
  };
  const sanitizeFonts = (
    fonts: readonly EmbeddedFont[] | undefined
  ): readonly EmbeddedFont[] | undefined => {
    if (!fonts || fonts.length === 0) {
      return fonts;
    }
    const usedNames = new Set<string>();
    let mutated = false;
    const result = fonts.map(ef => {
      const safe = uniqueSanitizedName(ef.fileName, usedNames, "font.bin");
      if (safe !== ef.fileName) {
        mutated = true;
        return { ...ef, fileName: safe };
      }
      return ef;
    });
    return mutated ? result : fonts;
  };

  return {
    ...doc,
    body,
    headers,
    footers,
    images: sanitizeImages(doc.images),
    embeddedFonts: sanitizeFonts(doc.embeddedFonts)
  } as DocxDocument;
}

/**
 * Returns the sanitised leaf name. If the cleaned form would collide
 * with an entry already in `used`, a numeric suffix is appended until
 * unique. The chosen name is added to `used`.
 */
export function uniqueSanitizedName(
  raw: string | undefined,
  used: Set<string>,
  fallback: string
): string {
  let candidate = sanitizeMediaFileName(raw, fallback);
  if (used.has(candidate)) {
    const dot = candidate.lastIndexOf(".");
    const stem = dot >= 0 ? candidate.slice(0, dot) : candidate;
    const ext = dot >= 0 ? candidate.slice(dot) : "";
    let n = 2;
    while (used.has(`${stem}_${n}${ext}`)) {
      n++;
    }
    candidate = `${stem}_${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

async function _packageDocxInner(
  doc: DocxDocument,
  options: PackageDocxOptions
): Promise<Uint8Array> {
  const archive = zip({ level: options.compressionLevel ?? 6 });
  const securityPolicy = resolveSecurityPolicy(options.securityPolicy);
  const rawXmlPolicy = securityPolicy.rawXmlPolicy;

  // Managers
  const contentTypes = createContentTypes();
  const packageRels = createRelationships();
  const documentRels = createRelationships();

  // --- Package relationships ---
  addRelationship(packageRels, RelType.OfficeDocument, "word/document.xml");
  addRelationship(packageRels, RelType.CoreProperties, "docProps/core.xml");
  addRelationship(packageRels, RelType.ExtendedProperties, "docProps/app.xml");

  // Custom properties
  const hasCustomProps = doc.customProperties && doc.customProperties.length > 0;
  if (hasCustomProps) {
    addRelationship(packageRels, RelType.CustomProperties, "docProps/custom.xml");
  }

  // --- Document relationships ---
  addRelationship(documentRels, RelType.Styles, "styles.xml");
  addRelationship(documentRels, RelType.Settings, "settings.xml");
  addRelationship(documentRels, RelType.FontTable, "fontTable.xml");
  addRelationship(documentRels, RelType.Theme, "theme/theme1.xml");

  // Numbering
  const hasNumbering =
    (doc.abstractNumberings && doc.abstractNumberings.length > 0) ||
    (doc.numberingInstances && doc.numberingInstances.length > 0);
  if (hasNumbering) {
    addRelationship(documentRels, RelType.Numbering, "numbering.xml");
  }

  // Footnotes & Endnotes
  const hasFootnotes = doc.footnotes && doc.footnotes.length > 0;
  const hasEndnotes = doc.endnotes && doc.endnotes.length > 0;
  if (hasFootnotes) {
    addRelationship(documentRels, RelType.Footnotes, "footnotes.xml");
  }
  if (hasEndnotes) {
    addRelationship(documentRels, RelType.Endnotes, "endnotes.xml");
  }

  // Comments
  const hasComments = doc.comments && doc.comments.length > 0;
  if (hasComments) {
    addRelationship(documentRels, RelType.Comments, "comments.xml");
  }

  // Images
  //
  // The model's `image.rId` is the authoritative reference: it is what every
  // inline/floating drawing in the body uses, so the easiest way to keep
  // r:embed and the .rels file in sync is to register relationships under that
  // exact id. If a model rId happens to clash with a previously-registered
  // relationship in this same .rels file (e.g. styles → "rId1" while a model
  // image also asks for "rId1"), we fall back to allocating a fresh rId and
  // record the substitution in `imageRemap`. Writers consult that map via
  // ctx.imageRIdRemap when emitting r:embed so the body and the .rels file
  // stay consistent.
  //
  // For SVG with raster fallback, the model rId points at the PNG fallback
  // resource (so r:embed on a:blip targets a raster image — the legacy wire
  // shape Word readers expect). We additionally register the SVG itself
  // under a secondary rId. We then surface that secondary rId on the
  // inline/floating image's `svgRId` field — but only on shallow copies that
  // live inside the work doc, so the caller's input model is never mutated.
  const imageExtensions = new Set<string>();
  const imageRemap = new Map<string, string>(); // model rId -> registered rId (only set on collision)
  const imageByRid = new Map<string, ImageDef>(); // model rId -> ImageDef
  const svgFallbacks: { fallbackFileName: string; data: Uint8Array }[] = [];
  // For each main image rId that has a SVG fallback, the secondary rId
  // pointing at the SVG file. Used to populate svgRId on inline/floating
  // image content when the source model didn't already provide one.
  const imageSvgRIdMap = new Map<string, string>();
  if (doc.images) {
    for (const img of doc.images) {
      if (img.rId) {
        imageByRid.set(img.rId, img);
      }
      // Index alias rIds so that header/footer-local references resolve to
      // the same ImageDef. Aliases live in their own .rels id space, so when
      // we register them later we use the alias rId verbatim.
      if (img.aliasRIds) {
        for (const alias of img.aliasRIds) {
          if (!imageByRid.has(alias)) {
            imageByRid.set(alias, img);
          }
        }
      }
    }

    const registerImageRel = (modelRId: string | undefined, target: string): string => {
      if (!modelRId) {
        return addRelationship(documentRels, RelType.Image, target);
      }
      // OOXML / OPC permits any xs:ID as a Relationship Id, but
      // Microsoft Word enforces the conventional `rId<N>` shape and
      // rejects the package when it encounters anything else (e.g. the
      // `__img_<N>` placeholders our builders emit). Allocate a fresh
      // canonical rId whenever the model id departs from that pattern,
      // and remap content references through `imageRIdRemap`.
      const isCanonicalRId = /^rId\d+$/.test(modelRId);
      if (!isCanonicalRId || documentRels.hasId(modelRId)) {
        const newId = addRelationship(documentRels, RelType.Image, target);
        imageRemap.set(modelRId, newId);
        return newId;
      }
      addRelationshipWithId(documentRels, modelRId, RelType.Image, target);
      return modelRId;
    };

    for (const img of doc.images) {
      const oldRid = img.rId;

      if (img.mediaType === "svg") {
        // SVG must always be paired with a raster fallback that `a:blip`
        // references; Word cannot rasterize an SVG referenced directly by
        // a:blip. If the caller did not provide one, synthesize a minimal
        // transparent PNG so the drawing is still valid and renderable.
        const fallbackData = img.fallbackData ?? SVG_RASTER_FALLBACK_PNG;
        // Main rId points at the PNG fallback (the raster image consumed by
        // a:blip).
        const baseName = img.fileName.replace(/\.[^.]+$/, "");
        const fallbackFileName = `${baseName}_fallback.png`;
        registerImageRel(oldRid, `media/${fallbackFileName}`);
        imageExtensions.add("png");

        // Secondary rId for the actual SVG; auto-allocated.
        const svgRId = addRelationship(documentRels, RelType.Image, `media/${img.fileName}`);
        if (oldRid) {
          imageSvgRIdMap.set(oldRid, svgRId);
        }
        const ext = getFileExt(img.fileName);
        if (ext) {
          imageExtensions.add(ext);
        }

        svgFallbacks.push({ fallbackFileName, data: fallbackData });
      } else {
        registerImageRel(oldRid, `media/${img.fileName}`);
        const ext = getFileExt(img.fileName);
        if (ext) {
          imageExtensions.add(ext);
        }
      }
    }
  }

  // Populate svgRId on inline/floating image content nodes for SVG fallbacks.
  // We only mutate shallow copies inside the working doc — never the caller's
  // input. This is invisible to readers that already supplied svgRId.
  if (imageSvgRIdMap.size > 0) {
    const populateSvg = (target: { rId: string; svgRId?: string }): void => {
      if (target.svgRId) {
        return;
      }
      const svgRId = imageSvgRIdMap.get(target.rId);
      if (svgRId) {
        (target as { svgRId?: string }).svgRId = svgRId;
      }
    };
    // Walk the work-doc body. Floating images and altChunks were shallow-copied
    // by shallowCopyDocForPackaging; for paragraphs we lazily clone the run
    // content nodes that carry inline SVG references.
    const processBody = (blocks: readonly BodyContent[]): BodyContent[] => {
      return blocks.map(block => {
        if (block.type === "floatingImage") {
          if (imageSvgRIdMap.has(block.rId)) {
            populateSvg(block as Mutable<FloatingImage>);
          }
          return block;
        }
        if (block.type === "paragraph") {
          let paragraphCopied: Paragraph | null = null;
          let childrenCopied: ParagraphChild[] | null = null;
          for (let i = 0; i < block.children.length; i++) {
            const child = block.children[i];
            if (!isRun(child)) {
              continue;
            }
            const run = child;
            let runCopied: Run | null = null;
            let contentCopied: RunContent[] | null = null;
            for (let j = 0; j < run.content.length; j++) {
              const c = run.content[j];
              if (c.type !== "image" || !c.rId) {
                continue;
              }
              if (!imageSvgRIdMap.has(c.rId) || c.svgRId) {
                continue;
              }
              if (!contentCopied) {
                contentCopied = [...run.content];
              }
              const cloned: InlineImageContent = { ...(c as InlineImageContent) };
              populateSvg(cloned as Mutable<InlineImageContent>);
              contentCopied[j] = cloned;
            }
            if (contentCopied) {
              runCopied = { ...run, content: contentCopied };
              if (!childrenCopied) {
                childrenCopied = [...block.children];
              }
              childrenCopied[i] = runCopied as ParagraphChild;
            }
          }
          if (childrenCopied) {
            paragraphCopied = { ...block, children: childrenCopied };
            return paragraphCopied;
          }
          return block;
        }
        if (block.type === "table") {
          const newRows = block.rows.map(row => ({
            ...row,
            cells: row.cells.map(cell => ({
              ...cell,
              content: processBody(cell.content as readonly BodyContent[]) as readonly (
                | Paragraph
                | Table
              )[]
            }))
          }));
          return { ...block, rows: newRows } as Table;
        }
        return block;
      });
    };
    (doc as Mutable<DocxDocument>).body = processBody(doc.body);

    // Same treatment for header/footer content (each is essentially a body
    // fragment). headers/footers maps were shallow-copied by
    // shallowCopyDocForPackaging, so swapping `content.children` is safe.
    const rewriteHeaderFooter = <T extends { content: HeaderFooterContent }>(
      defs: ReadonlyMap<string, T> | undefined
    ): void => {
      if (!defs) {
        return;
      }
      for (const [, def] of defs) {
        const newChildren = processBody(
          def.content.children as readonly BodyContent[]
        ) as readonly (Paragraph | Table)[];
        if (newChildren !== def.content.children) {
          (def as { content: HeaderFooterContent }).content = {
            ...def.content,
            children: newChildren
          };
        }
      }
    };
    rewriteHeaderFooter(doc.headers);
    rewriteHeaderFooter(doc.footers);

    // Footnotes and endnotes carry their own paragraph lists.
    const rewriteNotes = (
      notes: readonly { id: number; content: readonly Paragraph[] }[] | undefined
    ): readonly { id: number; content: readonly Paragraph[] }[] | undefined => {
      if (!notes || notes.length === 0) {
        return notes;
      }
      let changed = false;
      const out = notes.map(note => {
        const newContent = processBody(
          note.content as readonly BodyContent[]
        ) as readonly Paragraph[];
        if (newContent === note.content) {
          return note;
        }
        changed = true;
        return { ...note, content: newContent };
      });
      return changed ? out : notes;
    };
    const newFootnotes = rewriteNotes(
      doc.footnotes as readonly { id: number; content: readonly Paragraph[] }[] | undefined
    );
    if (newFootnotes !== doc.footnotes) {
      (doc as Mutable<DocxDocument>).footnotes = newFootnotes as DocxDocument["footnotes"];
    }
    const newEndnotes = rewriteNotes(
      doc.endnotes as readonly { id: number; content: readonly Paragraph[] }[] | undefined
    );
    if (newEndnotes !== doc.endnotes) {
      (doc as Mutable<DocxDocument>).endnotes = newEndnotes as DocxDocument["endnotes"];
    }
  }

  // Hyperlinks (external).
  // We register relationships under the model's existing rId where possible,
  // and stash newly-allocated rIds on a WeakMap keyed by the Hyperlink object
  // so the renderer can look them up without us writing onto the caller's
  // model. The map lives on the render context.
  //
  // Body, footnotes, endnotes, headers and footers each render against a
  // *different* OPC part, so each part has its own .rels namespace. Using one
  // WeakMap is fine because Hyperlink objects are unique by identity, but the
  // **registration** has to happen against the correct rel manager — we register
  // body hyperlinks into documentRels here, and footnote/endnote/header/footer
  // hyperlinks into their own rel managers below.
  const hyperlinkRIds = new WeakMap<object, string>();
  const hyperlinks = collectHyperlinks(doc.body);
  for (const link of hyperlinks) {
    if (link.url) {
      // Sanitize: drop dangerous schemes (javascript:, vbscript:, data:, …)
      // before they reach document.xml.rels. The renderer will simply emit
      // the surrounding `<w:hyperlink>` without an `r:id`, which keeps the
      // inner runs but does not produce a clickable target.
      const safe = sanitizeUrl(link.url);
      if (!safe) {
        continue;
      }
      const rId = addRelationship(documentRels, RelType.Hyperlink, safe, "External");
      hyperlinkRIds.set(link, rId);
    }
  }

  // Footnotes/endnotes have independent .rels parts. Build them lazily so we
  // only emit a footnotes.xml.rels file when there's something to register.
  const footnoteRels = createRelationships();
  const endnoteRels = createRelationships();
  const registerNoteHyperlinks = (
    notes: readonly { content: readonly Paragraph[] }[] | undefined,
    rels: RelationshipsState
  ): void => {
    if (!notes) {
      return;
    }
    for (const note of notes) {
      const links: Hyperlink[] = [];
      for (const p of note.content) {
        scanChildrenForHyperlinks(p.children, links);
      }
      for (const link of links) {
        if (link.url) {
          const safe = sanitizeUrl(link.url);
          if (!safe) {
            continue;
          }
          const rId = addRelationship(rels, RelType.Hyperlink, safe, "External");
          hyperlinkRIds.set(link, rId);
        }
      }
    }
  };
  registerNoteHyperlinks(doc.footnotes, footnoteRels);
  registerNoteHyperlinks(doc.endnotes, endnoteRels);

  // Footnotes/endnotes may also reference images. Register those references
  // using the same model rId that the run content emits so footnotes.xml's
  // r:embed resolves locally.
  const registerNoteImages = (
    notes: readonly { content: readonly Paragraph[] }[] | undefined,
    rels: RelationshipsState
  ): void => {
    if (!notes || !doc.images) {
      return;
    }
    const seen = new Set<string>();
    for (const note of notes) {
      for (const p of note.content) {
        const rIds = new Set<string>();
        scanChildrenForImages(p.children, rIds);
        for (const oldRid of rIds) {
          if (seen.has(oldRid)) {
            continue;
          }
          seen.add(oldRid);
          const img = imageByRid.get(oldRid);
          if (img) {
            addRelationshipWithId(rels, oldRid, RelType.Image, `media/${img.fileName}`);
            // SVG fallback: also register the secondary svg rId locally if the
            // model knows it (or if we allocated it). For notes we look up the
            // already-allocated svgRId from imageSvgRIdMap if present.
            const svgRId = imageSvgRIdMap.get(oldRid);
            if (svgRId && !rels.hasId(svgRId)) {
              addRelationshipWithId(rels, svgRId, RelType.Image, `media/${img.fileName}`);
            }
          }
        }
      }
    }
  };
  registerNoteImages(doc.footnotes, footnoteRels);
  registerNoteImages(doc.endnotes, endnoteRels);

  // Comments have their own .rels part (word/_rels/comments.xml.rels).
  // Hyperlinks/images referenced from inside comment content must register
  // here, not in document.xml.rels — otherwise readers can't resolve them.
  const commentRels = createRelationships();
  if (doc.comments && doc.comments.length > 0) {
    const commentBodies = doc.comments.map(c => ({ content: c.content }));
    registerNoteHyperlinks(commentBodies, commentRels);
    registerNoteImages(commentBodies, commentRels);
  }

  // Process altChunk body items: register relationship and prepare data part.
  // We never mutate the chunk objects — the rId is published via a WeakMap
  // that the renderer reads through the WordRenderContext. This matters for
  // altChunks nested inside tables / SDTs which the shallow body copy did
  // not (and intentionally cannot cheaply) clone.
  const altChunkRIds = new WeakMap<object, string>();
  const altChunks: AltChunk[] = [];
  collectAltChunks(doc.body, altChunks);
  altChunks.forEach((chunk, i) => {
    const fileName = chunk.fileName ?? `afchunk${i + 1}.html`;
    // Register relationship for the alt chunk
    const rId = addRelationship(
      documentRels,
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk",
      fileName
    );
    altChunkRIds.set(chunk, rId);
    // Register content type
    const ct = chunk.contentType ?? "text/html";
    addContentTypeOverride(contentTypes, `/word/${fileName}`, ct);
    // Write data to archive
    if (chunk.data) {
      archive.add(`word/${fileName}`, chunk.data);
    }
  });

  // Headers
  //
  // For each header in the model we allocate a fresh document-level rId and
  // (re)write the rId on the header definition. Two maps are also produced
  // for later sectionProperties rewiring:
  //   - headerKeyToNewRid: keyed by the model's `headers` Map key (typically
  //     the original rId from a round-trip, or "default"/"first"/"even" from
  //     the builder).
  //   - headerOldRidToNewRid: keyed by any rId that previously identified
  //     this header (the map key, the value's pre-existing `rId` field) so
  //     references that still hold the old rId can be remapped.
  let headerIndex = 1;
  const headerRelManagers = new Map<string, RelationshipsState>();
  const headerKeyToNewRid = new Map<string, string>();
  const headerOldRidToNewRid = new Map<string, string>();
  // Map header `type` ("default" | "first" | "even") to its new rId, if the
  // model only has one header per type. Used to fill in references that
  // were created with a placeholder rId="" by callers that didn't yet know
  // the rId (typical builder usage).
  const headerTypeToNewRid = new Map<string, string>();
  if (doc.headers) {
    for (const [key, headerDef] of doc.headers) {
      const rId = addRelationship(documentRels, RelType.Header, `header${headerIndex}.xml`);
      const oldRid = (headerDef as { rId?: string }).rId;
      (headerDef as { rId?: string }).rId = rId;
      headerKeyToNewRid.set(key, rId);
      if (key) {
        headerOldRidToNewRid.set(key, rId);
      }
      if (oldRid && oldRid !== rId) {
        headerOldRidToNewRid.set(oldRid, rId);
      }
      // Heuristic: if the map key looks like a header type rather than an
      // rId, also expose it via headerTypeToNewRid so empty-rId references
      // ({ type: "default", rId: "" }) can be resolved by type.
      if (key === "default" || key === "first" || key === "even" || key === "odd") {
        // Last writer wins if the caller provided multiple headers with the
        // same type — that's already an ambiguous model.
        headerTypeToNewRid.set(key, rId);
      }

      // Create per-header relationship state for images and hyperlinks.
      // Header/footer .rels is its own id space, so we register images using
      // the model rId — that's also what the body XML emits via r:embed
      // (header/footer XML never goes through imageRemap because the local
      // .rels is independent from the document .rels).
      const hRels = createRelationships();
      const imgRids = collectImageRidsFromContent(headerDef.content);
      if (imgRids.size > 0 && doc.images) {
        for (const oldRid of imgRids) {
          const img = imageByRid.get(oldRid);
          if (img) {
            addRelationshipWithId(hRels, oldRid, RelType.Image, `media/${img.fileName}`);
            // SVG fallback: register the secondary svg rId locally too so
            // asvg:svgBlip in header XML resolves against this part's .rels.
            const svgRId = imageSvgRIdMap.get(oldRid);
            if (svgRId && !hRels.hasId(svgRId)) {
              addRelationshipWithId(hRels, svgRId, RelType.Image, `media/${img.fileName}`);
            }
          }
        }
      }
      // Hyperlinks in header
      const hLinks = collectHyperlinksFromHeaderFooter(headerDef.content);
      for (const link of hLinks) {
        if (link.url) {
          const safe = sanitizeUrl(link.url);
          if (!safe) {
            continue;
          }
          const linkRId = addRelationship(hRels, RelType.Hyperlink, safe, "External");
          hyperlinkRIds.set(link, linkRId);
        }
      }
      if (getRelationshipCount(hRels) > 0) {
        headerRelManagers.set(key, hRels);
      }

      headerIndex++;
    }
  }

  // Footers
  let footerIndex = 1;
  const footerRelManagers = new Map<string, RelationshipsState>();
  const footerKeyToNewRid = new Map<string, string>();
  const footerOldRidToNewRid = new Map<string, string>();
  const footerTypeToNewRid = new Map<string, string>();
  if (doc.footers) {
    for (const [key, footerDef] of doc.footers) {
      const rId = addRelationship(documentRels, RelType.Footer, `footer${footerIndex}.xml`);
      const oldRid = (footerDef as { rId?: string }).rId;
      (footerDef as { rId?: string }).rId = rId;
      footerKeyToNewRid.set(key, rId);
      if (key) {
        footerOldRidToNewRid.set(key, rId);
      }
      if (oldRid && oldRid !== rId) {
        footerOldRidToNewRid.set(oldRid, rId);
      }
      if (key === "default" || key === "first" || key === "even" || key === "odd") {
        footerTypeToNewRid.set(key, rId);
      }

      // Create per-footer relationship state for images and hyperlinks.
      const fRels = createRelationships();
      const imgRids = collectImageRidsFromContent(footerDef.content);
      if (imgRids.size > 0 && doc.images) {
        for (const oldRid of imgRids) {
          const img = imageByRid.get(oldRid);
          if (img) {
            addRelationshipWithId(fRels, oldRid, RelType.Image, `media/${img.fileName}`);
            // SVG fallback: register the secondary svg rId locally too.
            const svgRId = imageSvgRIdMap.get(oldRid);
            if (svgRId && !fRels.hasId(svgRId)) {
              addRelationshipWithId(fRels, svgRId, RelType.Image, `media/${img.fileName}`);
            }
          }
        }
      }
      // Hyperlinks in footer
      const fLinks = collectHyperlinksFromHeaderFooter(footerDef.content);
      for (const link of fLinks) {
        if (link.url) {
          const safe = sanitizeUrl(link.url);
          if (!safe) {
            continue;
          }
          const linkRId = addRelationship(fRels, RelType.Hyperlink, safe, "External");
          hyperlinkRIds.set(link, linkRId);
        }
      }
      if (getRelationshipCount(fRels) > 0) {
        footerRelManagers.set(key, fRels);
      }

      footerIndex++;
    }
  }

  // Watermark header (auto-generated if doc.watermark is set)
  let watermarkHeaderIndex: number | undefined;
  let watermarkHeaderRels: RelationshipsState | undefined;
  let watermarkHeaderRId: string | undefined;
  if (doc.watermark) {
    // Use next header index
    const wmHdrIdx = headerIndex;
    watermarkHeaderRId = addRelationship(documentRels, RelType.Header, `header${wmHdrIdx}.xml`);
    watermarkHeaderIndex = wmHdrIdx;

    // If image watermark, add image relationship in header .rels.
    // Watermark .rels live in their own id space, but Word still expects
    // the conventional `rId<N>` form. Allocate a fresh canonical id
    // (preferring an `addRelationship` auto-allocation) when the model
    // supplied a non-canonical id like `__img_1`.
    if (doc.watermark.type === "image") {
      const wmRels = createRelationships();
      const wmRId = doc.watermark.rId;
      const img = imageByRid.get(wmRId);
      if (img) {
        const isCanonical = /^rId\d+$/.test(wmRId);
        if (isCanonical) {
          addRelationshipWithId(wmRels, wmRId, RelType.Image, `media/${img.fileName}`);
        } else {
          // Allocate a fresh rId<N> in the header .rels and remap the
          // model id so the header writer emits the right r:embed.
          const allocated = addRelationship(wmRels, RelType.Image, `media/${img.fileName}`);
          imageRemap.set(wmRId, allocated);
        }
      }
      watermarkHeaderRels = wmRels;
    }
    headerIndex++;
  }

  // --- Content Types ---
  addImageContentTypeDefaults(contentTypes, imageExtensions);

  // Determine main document content type based on docType
  const mainDocContentType = resolveDocumentContentType(doc);
  addContentTypeOverride(contentTypes, PartPath.Document, mainDocContentType);
  addContentTypeOverride(contentTypes, PartPath.Styles, ContentType.Styles);
  addContentTypeOverride(contentTypes, PartPath.Settings, ContentType.Settings);
  addContentTypeOverride(contentTypes, PartPath.FontTable, ContentType.FontTable);
  addContentTypeOverride(contentTypes, PartPath.Theme, ContentType.Theme);

  if (hasNumbering) {
    addContentTypeOverride(contentTypes, PartPath.Numbering, ContentType.Numbering);
  }
  if (hasFootnotes) {
    addContentTypeOverride(contentTypes, PartPath.Footnotes, ContentType.Footnotes);
  }
  if (hasEndnotes) {
    addContentTypeOverride(contentTypes, PartPath.Endnotes, ContentType.Endnotes);
  }
  if (hasComments) {
    addContentTypeOverride(contentTypes, PartPath.Comments, ContentType.Comments);
  }

  headerIndex = 1;
  if (doc.headers) {
    for (const [,] of doc.headers) {
      addContentTypeOverride(contentTypes, PartPath.header(headerIndex), ContentType.Header);
      headerIndex++;
    }
  }

  footerIndex = 1;
  if (doc.footers) {
    for (const [,] of doc.footers) {
      addContentTypeOverride(contentTypes, PartPath.footer(footerIndex), ContentType.Footer);
      footerIndex++;
    }
  }

  if (watermarkHeaderIndex !== undefined) {
    addContentTypeOverride(contentTypes, PartPath.header(watermarkHeaderIndex), ContentType.Header);
  }

  addContentTypeOverride(contentTypes, PartPath.CoreProps, ContentType.CoreProperties);
  addContentTypeOverride(contentTypes, PartPath.AppProps, ContentType.ExtendedProperties);
  if (hasCustomProps) {
    addContentTypeOverride(contentTypes, PartPath.CustomProps, ContentType.CustomProperties);
  }

  // --- Generate & add parts to archive ---
  // Note: [Content_Types].xml and _rels/.rels are serialized LAST so that any
  // relationships/content types registered during content rendering (e.g.
  // thumbnails, chart parts, alt chunks) are included.
  // word/_rels/document.xml.rels is also deferred to include chart relationships.

  // Build an effective doc that:
  //  (a) rewires sectionProperties header/footer references so their rId
  //      values match the document.xml.rels entries we just generated; and
  //  (b) includes the auto-generated watermark header reference.
  // The caller's input doc is never mutated.
  //
  // Reference resolution order for each entry:
  //   1. If `rId` is already a registered document-level header/footer rId,
  //      keep it as-is.
  //   2. Otherwise try `headerOldRidToNewRid[rId]` (round-trip with the
  //      original rId still present, or the headers map keyed by old rId).
  //   3. Otherwise fall back to `headerTypeToNewRid[type]` — this covers the
  //      common builder pattern where users add a header by `type` and use
  //      `rId: ""` as a placeholder.
  // Same logic for footers.
  const allowedHeaderRids = new Set(headerKeyToNewRid.values());
  const allowedFooterRids = new Set(footerKeyToNewRid.values());

  function resolveHeaderRef(ref: HeaderFooterRef): HeaderFooterRef | null {
    if (ref.rId && allowedHeaderRids.has(ref.rId)) {
      return ref;
    }
    const remapped = ref.rId ? headerOldRidToNewRid.get(ref.rId) : undefined;
    if (remapped) {
      return { ...ref, rId: remapped };
    }
    const byType = headerTypeToNewRid.get(ref.type);
    if (byType) {
      return { ...ref, rId: byType };
    }
    // No header part matches this reference. Drop it rather than emit a
    // dangling r:id that no .rels entry resolves.
    return null;
  }

  function resolveFooterRef(ref: HeaderFooterRef): HeaderFooterRef | null {
    if (ref.rId && allowedFooterRids.has(ref.rId)) {
      return ref;
    }
    const remapped = ref.rId ? footerOldRidToNewRid.get(ref.rId) : undefined;
    if (remapped) {
      return { ...ref, rId: remapped };
    }
    const byType = footerTypeToNewRid.get(ref.type);
    if (byType) {
      return { ...ref, rId: byType };
    }
    return null;
  }

  function rewireSectionRefs(sect: SectionProperties): SectionProperties {
    let next: SectionProperties = sect;
    let mutated = false;
    if (sect.headers) {
      const resolved = sect.headers
        .map(resolveHeaderRef)
        .filter((r): r is HeaderFooterRef => r !== null);
      if (
        resolved.length !== sect.headers.length ||
        resolved.some((r, i) => r !== sect.headers![i])
      ) {
        next = { ...next, headers: resolved };
        mutated = true;
      }
    }
    if (sect.footers) {
      const resolved = sect.footers
        .map(resolveFooterRef)
        .filter((r): r is HeaderFooterRef => r !== null);
      if (
        resolved.length !== sect.footers.length ||
        resolved.some((r, i) => r !== sect.footers![i])
      ) {
        next = { ...next, footers: resolved };
        mutated = true;
      }
    }
    return mutated ? next : sect;
  }

  // Snapshot top-level sectionProperties (and apply rewiring). May be
  // undefined when the document has no top-level section properties — we
  // only synthesize one if there are headers/footers/watermark to reference.
  let topLevelSect: SectionProperties | undefined = doc.sectionProperties
    ? rewireSectionRefs(doc.sectionProperties)
    : undefined;

  // Auto-fill: if the model has headers/footers but no top-level reference
  // was authored at all, synthesize references for each header/footer type
  // so the section actually picks them up. This only fires when the section
  // has zero header (or zero footer) refs — explicit author intent ("only
  // first-page header is referenced") is preserved.
  if (
    doc.headers &&
    doc.headers.size > 0 &&
    (!topLevelSect?.headers || topLevelSect.headers.length === 0)
  ) {
    const synthesized: HeaderFooterRef[] = [];
    for (const [type, rId] of headerTypeToNewRid) {
      synthesized.push({ type: type as HeaderFooterRef["type"], rId });
    }
    if (synthesized.length > 0) {
      topLevelSect = { ...(topLevelSect ?? {}), headers: synthesized };
    }
  }
  if (
    doc.footers &&
    doc.footers.size > 0 &&
    (!topLevelSect?.footers || topLevelSect.footers.length === 0)
  ) {
    const synthesized: HeaderFooterRef[] = [];
    for (const [type, rId] of footerTypeToNewRid) {
      synthesized.push({ type: type as HeaderFooterRef["type"], rId });
    }
    if (synthesized.length > 0) {
      topLevelSect = { ...(topLevelSect ?? {}), footers: synthesized };
    }
  }

  // Apply watermark reference (added after rewiring so its rId is preserved).
  if (watermarkHeaderIndex !== undefined && watermarkHeaderRId) {
    const existingHeaders = topLevelSect?.headers ? [...topLevelSect.headers] : [];
    existingHeaders.push({ type: "default", rId: watermarkHeaderRId });
    topLevelSect = { ...(topLevelSect ?? {}), headers: existingHeaders };
  }

  // Rewire sectionProperties embedded in body paragraphs (mid-document
  // section breaks). Only rebuild the body array if any paragraph's section
  // properties were actually rewritten.
  const sectionRefRewriteNeeded = doc.body.some(
    item =>
      item.type === "paragraph" &&
      item.properties?.sectionProperties &&
      ((item.properties.sectionProperties.headers &&
        item.properties.sectionProperties.headers.length > 0) ||
        (item.properties.sectionProperties.footers &&
          item.properties.sectionProperties.footers.length > 0))
  );

  let effectiveBody = doc.body;
  if (sectionRefRewriteNeeded) {
    effectiveBody = doc.body.map(item => {
      if (item.type !== "paragraph" || !item.properties?.sectionProperties) {
        return item;
      }
      const rewired = rewireSectionRefs(item.properties.sectionProperties);
      if (rewired === item.properties.sectionProperties) {
        return item;
      }
      return {
        ...item,
        properties: { ...item.properties, sectionProperties: rewired }
      };
    });
  }

  // Always rebuild effectiveDoc when we rewired anything, otherwise keep the
  // original reference to avoid spurious shallow copies.
  const docNeedsCopy = topLevelSect !== doc.sectionProperties || effectiveBody !== doc.body;
  const effectiveDoc: DocxDocument = docNeedsCopy
    ? ({
        ...doc,
        ...(topLevelSect !== undefined ? { sectionProperties: topLevelSect } : {}),
        body: effectiveBody
      } as DocxDocument)
    : doc;

  // Collect charts and register relationships BEFORE rendering document.xml.
  // Body charts go into document.xml.rels; charts that live inside a header
  // or footer must be registered against THAT part's own .rels file (they
  // are referenced from header{N}.xml / footer{N}.xml, not document.xml).
  const charts: ChartContent[] = [];
  collectCharts(doc.body, charts);

  const chartRIds: string[] = [];
  const renderCtxChartRIds = new Map<object, string>();
  charts.forEach(chartContent => {
    const num = chartRIds.length + 1;
    const rId = addRelationship(documentRels, RelType.Chart, `charts/chart${num}.xml`);
    chartRIds.push(rId);
    renderCtxChartRIds.set(chartContent, rId);
  });

  // Register header charts against each header's own .rels.
  if (doc.headers) {
    for (const [key, headerDef] of doc.headers) {
      const headerCharts: ChartContent[] = [];
      collectChartsFromHeaderFooter(headerDef.content, headerCharts);
      if (headerCharts.length === 0) {
        continue;
      }
      const hRels = headerRelManagers.get(key) ?? createRelationships();
      for (const chartContent of headerCharts) {
        const num = chartRIds.length + 1;
        const rId = addRelationship(hRels, RelType.Chart, `charts/chart${num}.xml`);
        chartRIds.push(rId);
        renderCtxChartRIds.set(chartContent, rId);
        // Also push into the global charts[] so chart{num}.xml + .rels are
        // emitted later (chart parts themselves live under word/charts/, not
        // co-located with the header).
        charts.push(chartContent);
      }
      headerRelManagers.set(key, hRels);
    }
  }

  // Same for footers.
  if (doc.footers) {
    for (const [key, footerDef] of doc.footers) {
      const footerCharts: ChartContent[] = [];
      collectChartsFromHeaderFooter(footerDef.content, footerCharts);
      if (footerCharts.length === 0) {
        continue;
      }
      const fRels = footerRelManagers.get(key) ?? createRelationships();
      for (const chartContent of footerCharts) {
        const num = chartRIds.length + 1;
        const rId = addRelationship(fRels, RelType.Chart, `charts/chart${num}.xml`);
        chartRIds.push(rId);
        renderCtxChartRIds.set(chartContent, rId);
        charts.push(chartContent);
      }
      footerRelManagers.set(key, fRels);
    }
  }

  // Collect ChartEx items and register relationships
  const chartExItems: ChartExContent[] = [];
  collectChartExItems(doc.body, chartExItems);
  const chartExRIds: string[] = [];
  chartExItems.forEach(cxContent => {
    const num = chartExRIds.length + 1;
    const rId = addRelationship(documentRels, RelType.ChartEx, `charts/chartEx${num}.xml`);
    chartExRIds.push(rId);
    renderCtxChartRIds.set(cxContent, rId);
  });

  // Create render context for document serialization. The id generators
  // are seeded so any auto-assigned id (e.g. SDT) starts above the maximum
  // value the caller already used in the model — otherwise an SDT without
  // an explicit `id` would collide with an existing one and break
  // dataBinding / repeating section linkage.
  const renderCtx = createRenderContext({
    securityPolicy,
    chartRIds: renderCtxChartRIds,
    imageRIdRemap: imageRemap,
    hyperlinkRIds,
    altChunkRIds,
    ids: createIdGenerators({
      sdtId: scanMaxSdtId(doc) + 1
    })
  });

  // word/_rels/document.xml.rels — deferred until after all document-level
  // relationships have been registered (VBA, webSettings, people, charts, etc.)

  // word/document.xml
  archive.add(
    PartPath.Document,
    renderXml(xml => renderDocument(xml, effectiveDoc, renderCtx))
  );

  // word/styles.xml
  archive.add(
    PartPath.Styles,
    renderXml(xml => renderStyles(xml, doc.docDefaults, doc.styles))
  );

  // word/settings.xml
  // When the document defines a page background, Word only paints it if
  // <w:displayBackgroundShape/> is present in settings. Inject it
  // automatically so setBackground() actually shows up on screen.
  const settingsForRender =
    doc.background && !doc.settings?.displayBackgroundShape
      ? { ...(doc.settings ?? {}), displayBackgroundShape: true }
      : doc.settings;
  archive.add(
    PartPath.Settings,
    renderXml(xml => renderSettings(xml, settingsForRender, rawXmlPolicy))
  );

  // word/fontTable.xml
  archive.add(
    PartPath.FontTable,
    renderXml(xml => renderFontTable(xml, doc.fonts))
  );

  // word/fonts/*.odttf (embedded fonts)
  if (doc.embeddedFonts && doc.embeddedFonts.length > 0) {
    const fontTableRels = createRelationships();
    const usedRIds = new Set<string>();

    // Collect rIds referenced in fontTable
    if (doc.fonts) {
      for (const font of doc.fonts) {
        if (font.embedRegular) {
          usedRIds.add(font.embedRegular);
        }
        if (font.embedBold) {
          usedRIds.add(font.embedBold);
        }
        if (font.embedItalic) {
          usedRIds.add(font.embedItalic);
        }
        if (font.embedBoldItalic) {
          usedRIds.add(font.embedBoldItalic);
        }
      }
    }

    for (const ef of doc.embeddedFonts) {
      const partPath = `word/fonts/${ef.fileName}`;
      // De-dup: two EmbeddedFont entries with the same (rId, fileName) are
      // the same physical file (typical when callers reuse helpers like
      // `embedFontFamily` and store the same FontDef across runs). Skip
      // the duplicate to avoid an `archive.add` overwrite race and a
      // `Duplicate relationship ID` from `addRelationshipWithId`.
      if (fontTableRels.hasId(ef.rId)) {
        continue;
      }
      archive.add(partPath, ef.data);

      // Register relationship from fontTable.xml. We always emit the
      // relationship (even when no FontDef references it directly) so
      // the embedded font part doesn't end up orphaned in the package.
      addRelationshipWithId(fontTableRels, ef.rId, RelType.Font, `fonts/${ef.fileName}`);
      void usedRIds;

      // Register content type for .odttf / .ttf
      const ext = getFileExt(ef.fileName);
      if (ext === "odttf") {
        addContentTypeDefault(contentTypes, "odttf", ContentType.ObfuscatedFont);
      } else if (ext === "ttf") {
        addContentTypeDefault(contentTypes, "ttf", "application/x-font-ttf");
      } else if (ext === "otf") {
        addContentTypeDefault(contentTypes, "otf", "application/x-font-otf");
      }
    }

    // Write fontTable.xml.rels
    archive.add(
      "word/_rels/fontTable.xml.rels",
      renderXml(xml => renderRelationships(fontTableRels, xml))
    );
  }

  // Custom XML parts (for SDT data binding)
  if (doc.customXmlParts && doc.customXmlParts.length > 0) {
    doc.customXmlParts.forEach((part, i) => {
      const num = i + 1;
      const itemPath = `word/customXml/item${num}.xml`;
      const propsPath = `word/customXml/itemProps${num}.xml`;

      // Write the XML content
      archive.add(itemPath, part.xmlContent);

      // Write itemProps*.xml
      const propsXml = renderXml(xml => {
        xml.openXml(STD_DOC_ATTRIBUTES);
        xml.openNode("ds:datastoreItem", {
          "ds:itemID": `{${part.itemId}}`,
          "xmlns:ds": "http://schemas.openxmlformats.org/officeDocument/2006/customXml"
        });
        if (part.schemaReferences && part.schemaReferences.length > 0) {
          xml.openNode("ds:schemaRefs");
          for (const uri of part.schemaReferences) {
            xml.leafNode("ds:schemaRef", { "ds:uri": uri });
          }
          xml.closeNode();
        } else {
          xml.leafNode("ds:schemaRefs");
        }
        xml.closeNode();
      });
      archive.add(propsPath, propsXml);

      // Write item rels (links itemN.xml → itemPropsN.xml)
      const itemRels = createRelationships();
      addRelationship(itemRels, RelType.CustomXmlProps, `itemProps${num}.xml`);
      archive.add(
        `word/customXml/_rels/item${num}.xml.rels`,
        renderXml(xml => renderRelationships(itemRels, xml))
      );

      // Register content types
      addContentTypeOverride(
        contentTypes,
        `/word/customXml/itemProps${num}.xml`,
        "application/vnd.openxmlformats-officedocument.customXmlProperties+xml"
      );

      // Add to document rels
      addRelationship(documentRels, RelType.CustomXml, `customXml/item${num}.xml`);
    });
  }

  // word/theme/theme1.xml
  archive.add(
    PartPath.Theme,
    renderXml(xml => renderTheme(xml, doc.theme, rawXmlPolicy))
  );

  // word/numbering.xml
  if (hasNumbering) {
    archive.add(
      PartPath.Numbering,
      renderXml(xml =>
        renderNumbering(
          xml,
          doc.abstractNumberings,
          doc.numberingInstances,
          doc.numPicBullets,
          rawXmlPolicy
        )
      )
    );
  }

  // word/footnotes.xml + footnotes.xml.rels
  if (hasFootnotes) {
    archive.add(
      PartPath.Footnotes,
      // Footnotes are an independent OPC part — their r:id values must
      // resolve against word/_rels/footnotes.xml.rels, not document.xml.rels.
      renderXml(xml =>
        renderFootnotes(xml, doc.footnotes!, {
          imageRemap: new Map(),
          hyperlinkRIds,
          nextDocPrId: renderCtx.ids.nextDocPrId,
          rawXmlPolicy
        })
      )
    );
    if (getRelationshipCount(footnoteRels) > 0) {
      archive.add(
        "word/_rels/footnotes.xml.rels",
        renderXml(xml => renderRelationships(footnoteRels, xml))
      );
    }
  }

  // word/endnotes.xml + endnotes.xml.rels
  if (hasEndnotes) {
    archive.add(
      PartPath.Endnotes,
      renderXml(xml =>
        renderEndnotes(xml, doc.endnotes!, {
          imageRemap: new Map(),
          hyperlinkRIds,
          nextDocPrId: renderCtx.ids.nextDocPrId,
          rawXmlPolicy
        })
      )
    );
    if (getRelationshipCount(endnoteRels) > 0) {
      archive.add(
        "word/_rels/endnotes.xml.rels",
        renderXml(xml => renderRelationships(endnoteRels, xml))
      );
    }
  }

  // word/comments.xml + comments.xml.rels
  if (hasComments) {
    archive.add(
      PartPath.Comments,
      // Comments live in their own OPC part; pass helpers so embedded
      // hyperlinks/images render with the right r:id (the rels manager
      // below registered them under their model-original id).
      renderXml(xml =>
        renderComments(xml, doc.comments!, {
          imageRemap: new Map(),
          hyperlinkRIds,
          nextDocPrId: renderCtx.ids.nextDocPrId,
          rawXmlPolicy
        })
      )
    );

    if (getRelationshipCount(commentRels) > 0) {
      archive.add(
        "word/_rels/comments.xml.rels",
        renderXml(xml => renderRelationships(commentRels, xml))
      );
    }

    // word/commentsExtended.xml (for done/parentId)
    const hasExtended = doc.comments!.some(c => c.done !== undefined || c.parentId !== undefined);
    if (hasExtended) {
      const extXml = renderXml(xml => renderCommentsExtended(xml, doc.comments!));
      archive.add(PartPath.CommentsExtended, extXml);
      addRelationship(documentRels, RelType.CommentsExtended, "commentsExtended.xml");
      addContentTypeOverride(
        contentTypes,
        `/${PartPath.CommentsExtended}`,
        ContentType.CommentsExtended
      );
    }
  }

  // Headers
  headerIndex = 1;
  if (doc.headers) {
    let hIdx = 0;
    const keys = [...doc.headers.keys()];
    for (const [, headerDef] of doc.headers) {
      archive.add(
        PartPath.header(headerIndex),
        // Header .rels is independent from document .rels — pass an empty
        // imageRemap so we never rewrite r:embed against the document remap.
        renderXml(xml =>
          renderHeader(xml, headerDef.content, {
            imageRemap: new Map(),
            hyperlinkRIds,
            nextDocPrId: renderCtx.ids.nextDocPrId,
            rawXmlPolicy
          })
        )
      );
      // Header .rels file
      const hKey = keys[hIdx];
      const hRels = headerRelManagers.get(hKey);
      if (hRels && getRelationshipCount(hRels) > 0) {
        archive.add(
          `word/_rels/header${headerIndex}.xml.rels`,
          renderXml(xml => renderRelationships(hRels, xml))
        );
      }
      headerIndex++;
      hIdx++;
    }
  }

  // Footers
  footerIndex = 1;
  if (doc.footers) {
    let fIdx = 0;
    const keys = [...doc.footers.keys()];
    for (const [, footerDef] of doc.footers) {
      archive.add(
        PartPath.footer(footerIndex),
        // Footer .rels is independent from document .rels.
        renderXml(xml =>
          renderFooter(xml, footerDef.content, {
            imageRemap: new Map(),
            hyperlinkRIds,
            nextDocPrId: renderCtx.ids.nextDocPrId,
            rawXmlPolicy
          })
        )
      );
      // Footer .rels file
      const fKey = keys[fIdx];
      const fRels = footerRelManagers.get(fKey);
      if (fRels && getRelationshipCount(fRels) > 0) {
        archive.add(
          `word/_rels/footer${footerIndex}.xml.rels`,
          renderXml(xml => renderRelationships(fRels, xml))
        );
      }
      footerIndex++;
      fIdx++;
    }
  }

  // Watermark header
  if (watermarkHeaderIndex !== undefined && doc.watermark) {
    // For image watermarks the model rId may have been remapped onto a
    // canonical `rId<N>` form when registering the watermark .rels (so
    // Word accepts the package). Pass the remapped value through so the
    // VML shape's r:id attribute matches the .rels entry.
    const watermarkImageRId =
      doc.watermark.type === "image"
        ? (imageRemap.get(doc.watermark.rId) ?? doc.watermark.rId)
        : undefined;
    archive.add(
      PartPath.header(watermarkHeaderIndex),
      renderXml(xml => renderWatermarkHeader(xml, doc.watermark!, watermarkImageRId))
    );
    if (watermarkHeaderRels && getRelationshipCount(watermarkHeaderRels) > 0) {
      archive.add(
        `word/_rels/header${watermarkHeaderIndex}.xml.rels`,
        renderXml(xml => renderRelationships(watermarkHeaderRels!, xml))
      );
    }
  }

  // Media / images
  if (doc.images) {
    for (const img of doc.images) {
      archive.add(PartPath.media(img.fileName), img.data);
    }
  }

  // SVG fallback PNG files
  for (const fb of svgFallbacks) {
    archive.add(PartPath.media(fb.fallbackFileName), fb.data);
  }

  // docProps/core.xml
  archive.add(
    PartPath.CoreProps,
    renderXml(xml => renderCoreProperties(xml, doc.coreProperties))
  );

  // docProps/app.xml
  archive.add(
    PartPath.AppProps,
    renderXml(xml => renderAppProperties(xml, doc.appProperties))
  );

  // docProps/custom.xml
  if (hasCustomProps) {
    archive.add(
      PartPath.CustomProps,
      renderXml(xml => renderCustomProperties(xml, doc.customProperties!))
    );
  }

  // word/webSettings.xml
  if (doc.webSettings) {
    archive.add(
      PartPath.WebSettings,
      renderXml(xml => renderWebSettings(xml, doc.webSettings, rawXmlPolicy))
    );
    addRelationship(documentRels, RelType.WebSettings, "webSettings.xml");
    addContentTypeOverride(contentTypes, `/${PartPath.WebSettings}`, ContentType.WebSettings);
  }

  // word/people.xml
  if (doc.people && doc.people.length > 0) {
    archive.add(
      PartPath.People,
      renderXml(xml => renderPeople(xml, doc.people!))
    );
    addRelationship(documentRels, RelType.People, "people.xml");
    addContentTypeOverride(contentTypes, `/${PartPath.People}`, ContentType.People);
  }

  // docProps/thumbnail
  if (doc.thumbnail) {
    const ext =
      doc.thumbnail.contentType === "image/jpeg"
        ? "jpeg"
        : doc.thumbnail.contentType === "image/png"
          ? "png"
          : "wmf";
    const thumbPath = `docProps/thumbnail.${ext}`;
    archive.add(thumbPath, doc.thumbnail.data);
    // Package rels: target is relative to package root (docProps/thumbnail.jpeg)
    addRelationship(
      packageRels,
      "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail",
      thumbPath
    );
    addContentTypeDefault(contentTypes, ext, doc.thumbnail.contentType);
  }

  // word/vbaProject.bin (macro-enabled documents)
  if (doc.vbaProject) {
    archive.add("word/vbaProject.bin", doc.vbaProject);
    addRelationship(documentRels, RelType.VbaProject, "vbaProject.bin");
    addContentTypeOverride(contentTypes, "/word/vbaProject.bin", ContentType.VbaProject);
  }

  // OLE embedded objects (word/embeddings/*.bin + optional preview media).
  // Each object is registered with the *exact* rId referenced from the body
  // `<w:object r:id="…">` markup, so the reference always resolves. The
  // `preserveOleObjects` security policy can still strip the binaries below.
  if (doc.oleObjects && securityPolicy.preserveOleObjects) {
    for (const ole of doc.oleObjects) {
      archive.add(ole.path, ole.data);
      // Target is relative to word/ (document.xml lives in word/).
      const oleTarget = ole.path.replace(/^word\//, "");
      addRelationshipWithId(documentRels, ole.rId, RelType.Package, oleTarget);
      addContentTypeOverride(
        contentTypes,
        `/${ole.path}`,
        ole.contentType ?? ContentType.OleObject
      );
      if (ole.previewPath && ole.previewData && ole.previewRId) {
        archive.add(ole.previewPath, ole.previewData);
        addRelationshipWithId(
          documentRels,
          ole.previewRId,
          RelType.Image,
          ole.previewPath.replace(/^word\//, "")
        );
        if (ole.previewContentType) {
          addContentTypeOverride(contentTypes, `/${ole.previewPath}`, ole.previewContentType);
        } else {
          const ext = getFileExt(ole.previewPath);
          const inferred = ext ? inferContentType(ext) : undefined;
          if (inferred) {
            addContentTypeOverride(contentTypes, `/${ole.previewPath}`, inferred);
          }
        }
      }
    }
  }

  // word/glossary/document.xml (Building Blocks / AutoText / Quick Parts).
  //
  // A glossary is a self-contained sub-document: Word expects it to carry its
  // own styles / settings / webSettings / fontTable parts (referenced from
  // word/glossary/_rels/document.xml.rels) rather than sharing the main
  // document's. Omitting them makes Word discard the whole glossary on open.
  //
  //  - Round-tripped glossary (`rawParts` set): re-emit every captured
  //    word/glossary/** part verbatim (document.xml, its .rels, companions).
  //  - Freshly-built glossary: synthesise document.xml + the companion parts
  //    + the glossary's own .rels, reusing the main document's styles/fonts so
  //    block content (e.g. Heading1) resolves.
  if (doc.glossary && (doc.glossary.rawXml || doc.glossary.blocks.length > 0)) {
    addRelationship(documentRels, RelType.Glossary, "glossary/document.xml");

    if (doc.glossary.rawParts && doc.glossary.rawParts.size > 0) {
      for (const [path, data] of doc.glossary.rawParts) {
        archive.add(path, data);
        if (path.endsWith(".rels")) {
          continue; // .rels parts are typed by the Default rels content type
        }
        const ct =
          path === "word/glossary/document.xml"
            ? ContentType.Glossary
            : inferContentType(getFileExt(path));
        if (ct) {
          addContentTypeOverride(contentTypes, `/${path}`, ct);
        }
      }
    } else {
      archive.add("word/glossary/document.xml", renderGlossaryDocument(doc.glossary));
      addContentTypeOverride(contentTypes, "/word/glossary/document.xml", ContentType.Glossary);

      // Synthesise the companion sub-document parts + the glossary's own rels.
      const glossaryRels = createRelationships();
      addRelationshipWithId(glossaryRels, "rId1", RelType.Styles, "styles.xml");
      addRelationshipWithId(glossaryRels, "rId2", RelType.Settings, "settings.xml");
      addRelationshipWithId(glossaryRels, "rId3", RelType.WebSettings, "webSettings.xml");
      addRelationshipWithId(glossaryRels, "rId4", RelType.FontTable, "fontTable.xml");
      archive.add(
        "word/glossary/_rels/document.xml.rels",
        renderXml(xml => renderRelationships(glossaryRels, xml))
      );

      archive.add(
        "word/glossary/styles.xml",
        renderXml(xml => renderStyles(xml, doc.docDefaults, doc.styles))
      );
      archive.add(
        "word/glossary/settings.xml",
        renderXml(xml => renderSettings(xml, undefined, rawXmlPolicy))
      );
      archive.add(
        "word/glossary/webSettings.xml",
        renderXml(xml => renderWebSettings(xml, undefined, rawXmlPolicy))
      );
      archive.add(
        "word/glossary/fontTable.xml",
        renderXml(xml => renderFontTable(xml, doc.fonts))
      );

      addContentTypeOverride(contentTypes, "/word/glossary/styles.xml", ContentType.Styles);
      addContentTypeOverride(contentTypes, "/word/glossary/settings.xml", ContentType.Settings);
      addContentTypeOverride(
        contentTypes,
        "/word/glossary/webSettings.xml",
        ContentType.WebSettings
      );
      addContentTypeOverride(contentTypes, "/word/glossary/fontTable.xml", ContentType.FontTable);
    }
  }

  // Write opaque (unrecognized) parts for round-trip preservation.
  //
  // Opaque parts are written as-is into the ZIP. Their paths must not
  // collide with parts the packager itself produces — otherwise we either
  // emit a duplicate ZIP entry (Word may pick whichever it sees first, but
  // the produced package is no longer well-formed) or we silently overwrite
  // the semantic part. Round-trip via `readDocx` already excludes parts
  // that were consumed; collisions in practice come from callers that
  // construct opaqueParts by hand. Reject the most dangerous overlaps with
  // a clear error.
  if (doc.opaqueParts) {
    // Exact-path reservations: any well-known core part the packager always
    // emits, plus the parts we have already added during this run (headers,
    // footers, charts, embedded fonts, etc).
    const reservedExact = new Set<string>([
      PartPath.ContentTypes,
      PartPath.PackageRels,
      PartPath.Document,
      PartPath.DocumentRels,
      PartPath.Styles,
      "word/_rels/styles.xml.rels",
      PartPath.Settings,
      PartPath.FontTable,
      "word/_rels/fontTable.xml.rels",
      PartPath.Numbering,
      PartPath.Footnotes,
      "word/_rels/footnotes.xml.rels",
      PartPath.Endnotes,
      "word/_rels/endnotes.xml.rels",
      PartPath.Comments,
      "word/_rels/comments.xml.rels",
      PartPath.CommentsExtended,
      PartPath.People,
      PartPath.WebSettings,
      PartPath.Theme,
      PartPath.CoreProps,
      PartPath.AppProps,
      PartPath.CustomProps,
      PartPath.Thumbnail,
      "word/vbaProject.bin",
      "word/_rels/vbaProject.bin.rels",
      "word/glossary/document.xml",
      "word/glossary/_rels/document.xml.rels"
    ]);
    // Glossary sub-document parts (emitted either verbatim from rawParts or
    // synthesised); reserve them so opaqueParts can't collide.
    if (doc.glossary && (doc.glossary.rawXml || doc.glossary.blocks.length > 0)) {
      reservedExact.add("word/glossary/styles.xml");
      reservedExact.add("word/glossary/settings.xml");
      reservedExact.add("word/glossary/webSettings.xml");
      reservedExact.add("word/glossary/fontTable.xml");
      if (doc.glossary.rawParts) {
        for (const path of doc.glossary.rawParts.keys()) {
          reservedExact.add(path);
        }
      }
    }
    // Headers/footers we are emitting in this run.
    if (doc.headers) {
      let i = 1;
      for (const _entry of doc.headers) {
        void _entry;
        reservedExact.add(PartPath.header(i));
        reservedExact.add(PartPath.headerRels(i));
        i++;
      }
    }
    if (doc.footers) {
      let i = 1;
      for (const _entry of doc.footers) {
        void _entry;
        reservedExact.add(PartPath.footer(i));
        reservedExact.add(PartPath.footerRels(i));
        i++;
      }
    }
    // Charts emitted by this run.
    for (let i = 1; i <= charts.length; i++) {
      reservedExact.add(`word/charts/chart${i}.xml`);
      reservedExact.add(`word/charts/_rels/chart${i}.xml.rels`);
    }
    for (let i = 1; i <= chartExItems.length; i++) {
      reservedExact.add(`word/charts/chartEx${i}.xml`);
    }
    // Image media: each image has a deterministic media path.
    if (doc.images) {
      for (const img of doc.images) {
        if (img.fileName) {
          reservedExact.add(`word/media/${img.fileName}`);
        }
      }
    }
    // Embedded fonts.
    if (doc.embeddedFonts) {
      for (const ef of doc.embeddedFonts) {
        if (ef.fileName) {
          reservedExact.add(`word/fonts/${ef.fileName}`);
        }
      }
    }
    // OLE embedded objects emitted by this run.
    if (doc.oleObjects) {
      for (const ole of doc.oleObjects) {
        reservedExact.add(ole.path);
        if (ole.previewPath) {
          reservedExact.add(ole.previewPath);
        }
      }
    }

    for (const part of doc.opaqueParts) {
      if (reservedExact.has(part.path)) {
        throw new DocxWriteError(
          `Opaque part path "${part.path}" conflicts with a part the packager ` +
            `is emitting itself. Move the data into the corresponding model ` +
            `field (e.g. doc.styles, doc.headers, doc.images) or rename the ` +
            `opaque part.`
        );
      }
      // Honour `preserveOleObjects`: drop OLE binaries before they reach
      // the ZIP. The relationships that referenced them remain in the
      // owning part's .rels, but no payload will be written.
      if (
        !securityPolicy.preserveOleObjects &&
        (part.path.startsWith("word/embeddings/") ||
          (part.path.endsWith(".bin") && part.path.includes("embed")))
      ) {
        continue;
      }
      // Honour `dropSignaturesOnModify`: any digital-signature part lives
      // under `_xmlsignatures/`. Once the document has been re-serialised
      // the signature would no longer match the new bytes, so by default
      // we drop these parts entirely. The corresponding sigOrigin
      // relationship from `_rels/.rels` is also gone — packageRels is
      // rebuilt from scratch, so the dangling reference disappears too.
      if (securityPolicy.dropSignaturesOnModify && part.path.startsWith("_xmlsignatures/")) {
        continue;
      }
      archive.add(part.path, part.data);
      // Register content type: explicit > inferred by extension > skip
      const ext = getFileExt(part.path);
      if (part.contentType) {
        addContentTypeOverride(contentTypes, `/${part.path}`, part.contentType);
      } else if (ext) {
        // Infer from common extensions so [Content_Types].xml isn't incomplete
        const inferred = inferContentType(ext);
        if (inferred) {
          addContentTypeOverride(contentTypes, `/${part.path}`, inferred);
        }
      }
      // Write part relationships if any
      if (part.relationships && part.relationships.length > 0) {
        const partRels = createRelationships();
        for (const rel of part.relationships) {
          addRelationshipWithId(partRels, rel.id, rel.type, rel.target, rel.targetMode);
        }
        const relsPath = getPartRelsPath(part.path);
        archive.add(
          relsPath,
          renderXml(xml => renderRelationships(partRels, xml))
        );
      }
    }
  }

  // Write chart parts (rIds already registered earlier)
  const chartEmbedPromises: Promise<void>[] = [];
  charts.forEach((chartContent, i) => {
    const num = i + 1;
    const chartPath = `word/charts/chart${num}.xml`;

    // Register chart part
    archive.add(
      chartPath,
      renderXml(xml => renderChartPart(xml, chartContent.chart))
    );

    // Register content type
    addContentTypeOverride(contentTypes, `/word/charts/chart${num}.xml`, ContentType.Chart);

    // Embed xlsx workbook if requested
    if (chartContent.chart.embedWorkbook) {
      const xlsxPath = `word/embeddings/Microsoft_Excel_Worksheet${num}.xlsx`;

      // Create chart .rels file referencing the embedded xlsx
      const chartRels = createRelationships();
      addRelationship(
        chartRels,
        RelType.Package,
        `../embeddings/Microsoft_Excel_Worksheet${num}.xlsx`
      );
      archive.add(
        `word/charts/_rels/chart${num}.xml.rels`,
        renderXml(xml => renderRelationships(chartRels, xml))
      );

      // Register xlsx content type
      addContentTypeOverride(contentTypes, `/${xlsxPath}`, ContentType.Xlsx);

      // Generate and add xlsx asynchronously via Excel module (dynamic import)
      const promise = import("@word/bridge/excel-bridge").then(
        async ({ generateChartEmbeddedXlsx }) => {
          const xlsxData = await generateChartEmbeddedXlsx(chartContent.chart.series);
          archive.add(xlsxPath, xlsxData);
        }
      );
      chartEmbedPromises.push(promise);
    }
  });

  // Wait for all embedded xlsx files to be generated
  if (chartEmbedPromises.length > 0) {
    await Promise.all(chartEmbedPromises);
  }

  // Write ChartEx parts (cx:chartSpace XML)
  chartExItems.forEach((cxContent, i) => {
    const num = i + 1;
    const cxPath = `word/charts/chartEx${num}.xml`;
    archive.add(cxPath, cxContent.chartExXml);
    addContentTypeOverride(contentTypes, `/${cxPath}`, ContentType.ChartEx);
  });

  // LAST: Write [Content_Types].xml, _rels/.rels, and word/_rels/document.xml.rels
  // after all parts have registered their content types and relationships.

  // Validate relationships before serializing (catch duplicate IDs, missing TargetMode, etc.)
  const docRelErrors = documentRels.validate();
  const pkgRelErrors = packageRels.validate();
  if (docRelErrors.length > 0 || pkgRelErrors.length > 0) {
    const allErrors = [...pkgRelErrors, ...docRelErrors];
    throw new DocxWriteError(`OPC relationship validation failed:\n${allErrors.join("\n")}`);
  }

  archive.add(
    PartPath.DocumentRels,
    renderXml(xml => renderRelationships(documentRels, xml))
  );
  archive.add(
    PartPath.ContentTypes,
    renderXml(xml => renderContentTypes(contentTypes, xml))
  );
  archive.add(
    PartPath.PackageRels,
    renderXml(xml => renderRelationships(packageRels, xml))
  );

  return archive.bytes();
}

/** Recursively collect altChunks from body content. */
function collectAltChunks(body: readonly BodyContent[], out: AltChunk[]): void {
  walkBlocks(body, {
    visitAltChunk(chunk) {
      out.push(chunk);
    }
  });
}

/** Recursively collect chart contents from body content. */
function collectCharts(body: readonly BodyContent[], out: ChartContent[]): void {
  walkBlocks(body, {
    visitChart(chart) {
      out.push(chart);
    }
  });
}

/** Recursively collect ChartEx contents from body content. */
function collectChartExItems(body: readonly BodyContent[], out: ChartExContent[]): void {
  walkBlocks(body, {
    visitChartEx(chart) {
      out.push(chart);
    }
  });
}
