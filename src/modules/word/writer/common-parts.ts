/**
 * DOCX Module - Common Auxiliary Parts Builder
 *
 * Shared logic for generating auxiliary XML parts (styles, settings, numbering,
 * fontTable, theme, core properties, app properties, custom properties).
 *
 * Both the buffered packager and streaming writer use this to avoid duplicating
 * the same rendering logic.
 */

import { PartPath } from "@word/constants";
import type {
  AbstractNumbering,
  AppProperties,
  CoreProperties,
  CustomProperty,
  DocDefaults,
  DocumentSettings,
  DocumentTheme,
  EndnoteDef,
  FontDef,
  FootnoteDef,
  NumPicBullet,
  NumberingInstance,
  StyleDef
} from "@word/types";
import { renderXml } from "@word/writer/docx-packager";
import { renderFootnotes, renderEndnotes } from "@word/writer/footnote-writer";
import { renderNumbering } from "@word/writer/numbering-writer";
import {
  renderSettings,
  renderFontTable,
  renderCoreProperties,
  renderAppProperties,
  renderCustomProperties,
  renderTheme
} from "@word/writer/parts-writer";
import type { RenderHelpers } from "@word/writer/render-context";
import { renderStyles } from "@word/writer/styles-writer";

// =============================================================================
// Types
// =============================================================================

/** Input options for building common auxiliary parts. */
export interface AuxiliaryPartsInput {
  readonly docDefaults?: DocDefaults;
  readonly styles?: readonly StyleDef[];
  readonly settings?: DocumentSettings;
  readonly fonts?: readonly FontDef[];
  readonly theme?: DocumentTheme;
  readonly abstractNumberings?: readonly AbstractNumbering[];
  readonly numberingInstances?: readonly NumberingInstance[];
  readonly numPicBullets?: readonly NumPicBullet[];
  readonly coreProperties?: CoreProperties;
  readonly appProperties?: AppProperties;
  readonly customProperties?: readonly CustomProperty[];
  readonly footnotes?: readonly FootnoteDef[];
  readonly endnotes?: readonly EndnoteDef[];
  /**
   * Optional render helpers passed to footnote/endnote rendering so in-note
   * hyperlinks/images resolve to the rIds the caller has registered against
   * the per-part .rels. Defaults to `{}`, meaning no remap and no
   * hyperlink rIds — sufficient for documents without notes that contain
   * external links or remapped images.
   */
  readonly notesHelpers?: RenderHelpers;
  /**
   * Raw XML output policy. When `"strip"` or `"reject"`, opaque rawXml
   * fields on settings/theme/numbering are skipped or cause an error
   * respectively. Defaults to `"preserve"`.
   */
  readonly rawXmlPolicy?: "preserve" | "strip" | "reject";
}

/** A rendered XML part ready to be written to ZIP. */
export interface RenderedPart {
  readonly path: string;
  readonly content: string;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Build all common auxiliary XML parts that are shared between
 * the buffered packager and streaming writer.
 *
 * Returns an array of rendered parts (path + XML string).
 * Does NOT include: document.xml, images, headers/footers, comments,
 * charts, custom XML, embedded fonts, opaque parts, watermarks.
 * Those are handled by the respective packager/streaming-writer because
 * they require relationship ID coordination.
 */
export function buildCommonAuxiliaryParts(input: AuxiliaryPartsInput): RenderedPart[] {
  const parts: RenderedPart[] = [];

  // styles.xml (always written)
  parts.push({
    path: PartPath.Styles,
    content: renderXml(xml => renderStyles(xml, input.docDefaults, input.styles))
  });

  // settings.xml
  parts.push({
    path: PartPath.Settings,
    content: renderXml(xml => renderSettings(xml, input.settings, input.rawXmlPolicy))
  });

  // fontTable.xml
  parts.push({
    path: PartPath.FontTable,
    content: renderXml(xml => renderFontTable(xml, input.fonts))
  });

  // theme/theme1.xml
  parts.push({
    path: PartPath.Theme,
    content: renderXml(xml => renderTheme(xml, input.theme, input.rawXmlPolicy))
  });

  // numbering.xml (conditional)
  const hasNumbering =
    (input.abstractNumberings && input.abstractNumberings.length > 0) ||
    (input.numberingInstances && input.numberingInstances.length > 0);
  if (hasNumbering) {
    parts.push({
      path: PartPath.Numbering,
      content: renderXml(xml =>
        renderNumbering(
          xml,
          input.abstractNumberings,
          input.numberingInstances,
          input.numPicBullets,
          input.rawXmlPolicy
        )
      )
    });
  }

  // footnotes.xml (conditional)
  if (input.footnotes && input.footnotes.length > 0) {
    parts.push({
      path: PartPath.Footnotes,
      content: renderXml(xml => renderFootnotes(xml, input.footnotes!, input.notesHelpers))
    });
  }

  // endnotes.xml (conditional)
  if (input.endnotes && input.endnotes.length > 0) {
    parts.push({
      path: PartPath.Endnotes,
      content: renderXml(xml => renderEndnotes(xml, input.endnotes!, input.notesHelpers))
    });
  }

  // docProps/core.xml
  parts.push({
    path: PartPath.CoreProps,
    content: renderXml(xml => renderCoreProperties(xml, input.coreProperties))
  });

  // docProps/app.xml
  parts.push({
    path: PartPath.AppProps,
    content: renderXml(xml => renderAppProperties(xml, input.appProperties))
  });

  // docProps/custom.xml (conditional)
  if (input.customProperties && input.customProperties.length > 0) {
    parts.push({
      path: PartPath.CustomProps,
      content: renderXml(xml => renderCustomProperties(xml, input.customProperties!))
    });
  }

  return parts;
}

// =============================================================================
// Internal
// =============================================================================
