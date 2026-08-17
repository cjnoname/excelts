/**
 * DOCX Writers - Paragraph Properties & Paragraph
 *
 * Renders w:pPr and w:p elements including numbering, tabs, borders, etc.
 */

import { isRun } from "@word/core/text-utils";
import { DocxRawXmlPolicyError } from "@word/errors";
import type {
  ParagraphProperties,
  Paragraph,
  ParagraphChild,
  Hyperlink,
  BookmarkStart,
  BookmarkEnd,
  Border,
  ParagraphBorders,
  TabStop,
  CommentRangeStart,
  CommentRangeEnd,
  CommentReference,
  InsertedRun,
  DeletedRun,
  MovedFromRun,
  MovedToRun,
  ParagraphFrame
} from "@word/types";
import type { RenderHelpers } from "@word/writer/render-context";
import {
  renderBorderElement,
  renderRun,
  renderRunProperties,
  renderRunPropertiesContents,
  renderShading
} from "@word/writer/run-writer";
import { renderSectionProperties } from "@word/writer/section-writer";
import type { XmlSink } from "@xml/types";

/** Render a single border element. */
export function renderBorder(xml: XmlSink, tagName: string, border: Border): void {
  renderBorderElement(xml, tagName, border);
}

/** Render paragraph borders. */
function renderParagraphBorders(xml: XmlSink, borders: ParagraphBorders): void {
  xml.openNode("w:pBdr");
  if (borders.top) {
    renderBorder(xml, "w:top", borders.top);
  }
  if (borders.left) {
    renderBorder(xml, "w:left", borders.left);
  }
  if (borders.bottom) {
    renderBorder(xml, "w:bottom", borders.bottom);
  }
  if (borders.right) {
    renderBorder(xml, "w:right", borders.right);
  }
  if (borders.between) {
    renderBorder(xml, "w:between", borders.between);
  }
  if (borders.bar) {
    renderBorder(xml, "w:bar", borders.bar);
  }
  xml.closeNode();
}

/** Render tab stops. */
function renderTabs(xml: XmlSink, tabs: readonly TabStop[]): void {
  xml.openNode("w:tabs");
  for (const tab of tabs) {
    const attrs: Record<string, string> = {
      "w:val": tab.type,
      "w:pos": String(tab.position)
    };
    if (tab.leader) {
      attrs["w:leader"] = tab.leader;
    }
    xml.leafNode("w:tab", attrs);
  }
  xml.closeNode();
}

/** Render paragraph frame properties (w:framePr). */
function renderFrame(xml: XmlSink, frame: ParagraphFrame): void {
  const attrs: Record<string, string> = {};
  if (frame.dropCap) {
    attrs["w:dropCap"] = frame.dropCap;
  }
  if (frame.lines !== undefined) {
    attrs["w:lines"] = String(frame.lines);
  }
  if (frame.width !== undefined) {
    attrs["w:w"] = String(frame.width);
  }
  if (frame.height !== undefined) {
    attrs["w:h"] = String(frame.height);
  }
  if (frame.hSpace !== undefined) {
    attrs["w:hSpace"] = String(frame.hSpace);
  }
  if (frame.vSpace !== undefined) {
    attrs["w:vSpace"] = String(frame.vSpace);
  }
  if (frame.wrap) {
    attrs["w:wrap"] = frame.wrap;
  }
  if (frame.hAnchor) {
    attrs["w:hAnchor"] = frame.hAnchor;
  }
  if (frame.vAnchor) {
    attrs["w:vAnchor"] = frame.vAnchor;
  }
  if (frame.x !== undefined) {
    attrs["w:x"] = String(frame.x);
  }
  if (frame.xAlign) {
    attrs["w:xAlign"] = frame.xAlign;
  }
  if (frame.y !== undefined) {
    attrs["w:y"] = String(frame.y);
  }
  if (frame.yAlign) {
    attrs["w:yAlign"] = frame.yAlign;
  }
  xml.leafNode("w:framePr", attrs);
}

/** Render w:pPr (paragraph properties). */
export function renderParagraphProperties(
  xml: XmlSink,
  pPr: ParagraphProperties,
  insidePropertyChange = false
): void {
  xml.openNode("w:pPr");

  if (pPr.style) {
    xml.leafNode("w:pStyle", { "w:val": pPr.style });
  }

  if (pPr.keepNext) {
    xml.leafNode("w:keepNext");
  }
  if (pPr.keepLines) {
    xml.leafNode("w:keepLines");
  }
  if (pPr.pageBreakBefore) {
    xml.leafNode("w:pageBreakBefore");
  }

  // Frame
  if (pPr.frame) {
    renderFrame(xml, pPr.frame);
  }

  if (pPr.widowControl !== undefined) {
    xml.leafNode("w:widowControl", !pPr.widowControl ? { "w:val": "0" } : undefined);
  }

  if (pPr.suppressLineNumbers) {
    xml.leafNode("w:suppressLineNumbers");
  }

  if (pPr.borders) {
    renderParagraphBorders(xml, pPr.borders);
  }

  if (pPr.shading) {
    renderShading(xml, pPr.shading);
  }

  if (pPr.suppressAutoHyphens) {
    xml.leafNode("w:suppressAutoHyphens");
  }

  if (pPr.tabs && pPr.tabs.length > 0) {
    renderTabs(xml, pPr.tabs);
  }

  if (pPr.spacing) {
    const attrs: Record<string, string> = {};
    if (pPr.spacing.before !== undefined) {
      attrs["w:before"] = String(pPr.spacing.before);
    }
    if (pPr.spacing.after !== undefined) {
      attrs["w:after"] = String(pPr.spacing.after);
    }
    if (pPr.spacing.line !== undefined) {
      attrs["w:line"] = String(pPr.spacing.line);
    }
    if (pPr.spacing.lineRule) {
      attrs["w:lineRule"] = pPr.spacing.lineRule;
    }
    if (pPr.spacing.beforeAutoSpacing) {
      attrs["w:beforeAutospacing"] = "1";
    }
    if (pPr.spacing.afterAutoSpacing) {
      attrs["w:afterAutospacing"] = "1";
    }
    xml.leafNode("w:spacing", attrs);
  }

  if (pPr.indent) {
    const attrs: Record<string, string> = {};
    if (pPr.indent.left !== undefined) {
      attrs["w:left"] = String(pPr.indent.left);
    }
    if (pPr.indent.right !== undefined) {
      attrs["w:right"] = String(pPr.indent.right);
    }
    if (pPr.indent.hanging !== undefined) {
      attrs["w:hanging"] = String(pPr.indent.hanging);
    }
    if (pPr.indent.firstLine !== undefined) {
      attrs["w:firstLine"] = String(pPr.indent.firstLine);
    }
    if (pPr.indent.start !== undefined) {
      attrs["w:start"] = String(pPr.indent.start);
    }
    if (pPr.indent.end !== undefined) {
      attrs["w:end"] = String(pPr.indent.end);
    }
    xml.leafNode("w:ind", attrs);
  }

  if (pPr.contextualSpacing) {
    xml.leafNode("w:contextualSpacing");
  }

  if (pPr.mirrorIndents) {
    xml.leafNode("w:mirrorIndents");
  }

  if (pPr.alignment) {
    xml.leafNode("w:jc", { "w:val": pPr.alignment });
  }

  if (pPr.textAlignment) {
    xml.leafNode("w:textAlignment", { "w:val": pPr.textAlignment });
  }

  if (pPr.outlineLevel !== undefined) {
    xml.leafNode("w:outlineLvl", { "w:val": String(pPr.outlineLevel) });
  }

  if (pPr.numbering) {
    xml.openNode("w:numPr");
    xml.leafNode("w:ilvl", { "w:val": String(pPr.numbering.level ?? 0) });
    xml.leafNode("w:numId", { "w:val": String(pPr.numbering.numId) });
    xml.closeNode();
  }

  if (pPr.bidi) {
    xml.leafNode("w:bidi");
  }

  if (pPr.wordWrap !== undefined) {
    xml.leafNode("w:wordWrap", !pPr.wordWrap ? { "w:val": "0" } : undefined);
  }

  if (pPr.overflowPunctuation !== undefined) {
    xml.leafNode("w:overflowPunct", !pPr.overflowPunctuation ? { "w:val": "0" } : undefined);
  }

  if (pPr.topLinePunctuation !== undefined) {
    xml.leafNode("w:topLinePunct", !pPr.topLinePunctuation ? { "w:val": "0" } : undefined);
  }

  if (pPr.kinsoku !== undefined) {
    xml.leafNode("w:kinsoku", !pPr.kinsoku ? { "w:val": "0" } : undefined);
  }

  if (pPr.autoSpaceEastAsianText !== undefined) {
    xml.leafNode("w:autoSpaceDE", !pPr.autoSpaceEastAsianText ? { "w:val": "0" } : undefined);
  }

  if (pPr.autoSpaceEastAsianDigit !== undefined) {
    xml.leafNode("w:autoSpaceDN", !pPr.autoSpaceEastAsianDigit ? { "w:val": "0" } : undefined);
  }

  if (pPr.snapToGrid !== undefined) {
    xml.leafNode("w:snapToGrid", !pPr.snapToGrid ? { "w:val": "0" } : undefined);
  }

  if (pPr.textDirection) {
    xml.leafNode("w:textDirection", { "w:val": pPr.textDirection });
  }

  // A thematic break is drawn as a bottom border. Only synthesise one when the
  // paragraph has no borders of its own: `w:pPr` permits a single `w:pBdr`, and
  // emitting a second produced invalid XML whose duplicate element made readers
  // drop the paragraph's real border settings.
  if (pPr.thematicBreak && !pPr.borders) {
    xml.openNode("w:pBdr");
    xml.leafNode("w:bottom", {
      "w:val": "single",
      "w:sz": "6",
      "w:space": "1",
      "w:color": "auto"
    });
    xml.closeNode();
  }

  if (pPr.sectionProperties) {
    renderSectionProperties(xml, pPr.sectionProperties);
  }

  // Conditional formatting style mask (must come before rPr per schema)
  if (pPr.cnfStyle) {
    xml.leafNode("w:cnfStyle", { "w:val": pPr.cnfStyle });
  }

  // Paragraph property change revision — NOT recursed into when rendering previousProperties
  if (!insidePropertyChange && pPr.propertyChange) {
    xml.openNode("w:pPrChange", {
      "w:id": String(pPr.propertyChange.revision.id),
      "w:author": pPr.propertyChange.revision.author,
      ...(pPr.propertyChange.revision.date ? { "w:date": pPr.propertyChange.revision.date } : {})
    });
    if (pPr.propertyChange.previousProperties) {
      renderParagraphProperties(xml, pPr.propertyChange.previousProperties, true);
    }
    xml.closeNode();
  }

  // Paragraph mark properties (w:rPr inside w:pPr).
  //
  // ECMA-376 17.3.1.27 (CT_PPrBase) only allows ONE `w:rPr` child here. We
  // therefore merge `paragraphInsertion` / `paragraphDeletion` (track-changes
  // markers for the paragraph mark) into the same `w:rPr` as
  // `markRunProperties`. Inside this single w:rPr, the schema requires
  // w:ins/w:del/w:moveFrom/w:moveTo to come BEFORE the run-property children
  // (per CT_ParaRPr).
  const hasInsDel = !!(pPr.paragraphInsertion || pPr.paragraphDeletion);
  if (hasInsDel || pPr.markRunProperties) {
    xml.openNode("w:rPr");
    if (pPr.paragraphInsertion) {
      const insAttrs: Record<string, string> = {
        "w:id": String(pPr.paragraphInsertion.id),
        "w:author": pPr.paragraphInsertion.author
      };
      if (pPr.paragraphInsertion.date) {
        insAttrs["w:date"] = pPr.paragraphInsertion.date;
      }
      xml.leafNode("w:ins", insAttrs);
    }
    if (pPr.paragraphDeletion) {
      const delAttrs: Record<string, string> = {
        "w:id": String(pPr.paragraphDeletion.id),
        "w:author": pPr.paragraphDeletion.author
      };
      if (pPr.paragraphDeletion.date) {
        delAttrs["w:date"] = pPr.paragraphDeletion.date;
      }
      xml.leafNode("w:del", delAttrs);
    }
    if (pPr.markRunProperties) {
      renderRunPropertiesContents(xml, pPr.markRunProperties);
    }
    xml.closeNode(); // w:rPr
  }

  xml.closeNode();
}

/** Render a hyperlink. */
function renderHyperlink(xml: XmlSink, link: Hyperlink, helpers?: RenderHelpers): void {
  const attrs: Record<string, string> = {};
  // Resolve the relationship id: prefer the packager-provided WeakMap (so we
  // never need the model to carry the rId), fall back to whatever the model
  // already had (e.g. round-tripped DOCX where the reader populated rId).
  // Resolve r:id. Prefer the packager-assigned rId from the helpers map
  // (it's the only one guaranteed to exist in the rebuilt .rels file).
  // Fall back to the model's `rId` only when no packager-assigned id is
  // present — this happens for purely model-internal references such as
  // anchor-only hyperlinks.
  const resolvedRId = helpers?.hyperlinkRIds?.get(link) ?? (link.url ? undefined : link.rId);
  if (resolvedRId) {
    attrs["r:id"] = resolvedRId;
  }
  if (link.anchor) {
    attrs["w:anchor"] = link.anchor;
  }
  // CT_Hyperlink (ECMA-376 §17.16.22) requires r:id OR w:anchor — when
  // neither is present, emit the children as bare runs to avoid a schema
  // violation that some validators flag.
  if (!resolvedRId && !link.anchor) {
    for (const run of link.children) {
      renderRun(xml, run, helpers);
    }
    return;
  }
  if (link.tooltip) {
    attrs["w:tooltip"] = link.tooltip;
  }
  if (link.history) {
    attrs["w:history"] = "1";
  }
  if (link.tgtFrame) {
    attrs["w:tgtFrame"] = link.tgtFrame;
  }
  if (link.docLocation) {
    attrs["w:docLocation"] = link.docLocation;
  }
  xml.openNode("w:hyperlink", attrs);
  for (const run of link.children) {
    renderRun(xml, run, helpers);
  }
  xml.closeNode();
}

/** Render a bookmark start. */
function renderBookmarkStart(xml: XmlSink, bm: BookmarkStart): void {
  const attrs: Record<string, string> = {
    "w:id": String(bm.id),
    "w:name": bm.name
  };
  if (bm.colFirst !== undefined) {
    attrs["w:colFirst"] = String(bm.colFirst);
  }
  if (bm.colLast !== undefined) {
    attrs["w:colLast"] = String(bm.colLast);
  }
  if (bm.displacedByCustomXml) {
    attrs["w:displacedByCustomXml"] = bm.displacedByCustomXml;
  }
  xml.leafNode("w:bookmarkStart", attrs);
}

/** Render a bookmark end. */
function renderBookmarkEnd(xml: XmlSink, bm: BookmarkEnd): void {
  xml.leafNode("w:bookmarkEnd", { "w:id": String(bm.id) });
}

/** Render comment range start. */
function renderCommentRangeStart(xml: XmlSink, cr: CommentRangeStart): void {
  xml.leafNode("w:commentRangeStart", { "w:id": String(cr.id) });
}

/** Render comment range end. */
function renderCommentRangeEnd(xml: XmlSink, cr: CommentRangeEnd): void {
  xml.leafNode("w:commentRangeEnd", { "w:id": String(cr.id) });
}

/** Render comment reference (inside a run). */
function renderCommentReference(xml: XmlSink, cr: CommentReference): void {
  xml.openNode("w:r");
  xml.leafNode("w:commentReference", { "w:id": String(cr.id) });
  xml.closeNode();
}

/** Render an inserted run (track changes). */
function renderInsertedRun(xml: XmlSink, ins: InsertedRun, helpers?: RenderHelpers): void {
  const attrs: Record<string, string> = {
    "w:id": String(ins.revision.id),
    "w:author": ins.revision.author
  };
  if (ins.revision.date) {
    attrs["w:date"] = ins.revision.date;
  }
  xml.openNode("w:ins", attrs);
  renderRun(xml, ins.run, helpers);
  xml.closeNode();
}

/** Render a deleted run (track changes). */
function renderDeletedRun(xml: XmlSink, del: DeletedRun): void {
  const attrs: Record<string, string> = {
    "w:id": String(del.revision.id),
    "w:author": del.revision.author
  };
  if (del.revision.date) {
    attrs["w:date"] = del.revision.date;
  }
  xml.openNode("w:del", attrs);
  // Deleted runs use w:delText instead of w:t
  xml.openNode("w:r");
  if (del.run.properties) {
    renderRunProperties(xml, del.run.properties);
  }
  for (const content of del.run.content) {
    if (content.type === "text") {
      xml.openNode("w:delText", { "xml:space": "preserve" });
      xml.writeText(content.text);
      xml.closeNode();
    } else if (content.type === "break") {
      const brAttrs: Record<string, string> = {};
      if (content.breakType) {
        brAttrs["w:type"] = content.breakType;
      }
      xml.leafNode("w:br", Object.keys(brAttrs).length > 0 ? brAttrs : undefined);
    } else if (content.type === "tab") {
      xml.leafNode("w:tab");
    } else if (content.type === "carriageReturn") {
      xml.leafNode("w:cr");
    } else if (content.type === "noBreakHyphen") {
      xml.leafNode("w:noBreakHyphen");
    } else if (content.type === "softHyphen") {
      xml.leafNode("w:softHyphen");
    }
  }
  xml.closeNode();
  xml.closeNode();
}

/** Render a moved-from or moved-to run (track changes). */
function renderMovedRun(
  xml: XmlSink,
  moved: MovedFromRun | MovedToRun,
  wrapperTag: string,
  helpers?: RenderHelpers
): void {
  const attrs: Record<string, string> = {
    "w:id": String(moved.revision.id),
    "w:author": moved.revision.author
  };
  if (moved.revision.date) {
    attrs["w:date"] = moved.revision.date;
  }
  xml.openNode(wrapperTag, attrs);
  renderRun(xml, moved.run, helpers);
  xml.closeNode();
}

/** Render a paragraph child element. */
function renderParagraphChild(xml: XmlSink, child: ParagraphChild, helpers?: RenderHelpers): void {
  if ("type" in child) {
    switch (child.type) {
      case "hyperlink":
        renderHyperlink(xml, child, helpers);
        return;
      case "bookmarkStart":
        renderBookmarkStart(xml, child);
        return;
      case "bookmarkEnd":
        renderBookmarkEnd(xml, child);
        return;
      case "commentRangeStart":
        renderCommentRangeStart(xml, child);
        return;
      case "commentRangeEnd":
        renderCommentRangeEnd(xml, child);
        return;
      case "commentReference":
        renderCommentReference(xml, child);
        return;
      case "insertedRun":
        renderInsertedRun(xml, child, helpers);
        return;
      case "deletedRun":
        renderDeletedRun(xml, child);
        return;
      case "movedFromRun":
        renderMovedRun(xml, child, "w:moveFrom", helpers);
        return;
      case "movedToRun":
        renderMovedRun(xml, child, "w:moveTo", helpers);
        return;
      case "moveFromRangeStart":
      case "moveFromRangeEnd":
      case "moveToRangeStart":
      case "moveToRangeEnd": {
        const moveAttrs: Record<string, string> = {
          "w:id": String(child.id)
        };
        if (child.author) {
          moveAttrs["w:author"] = child.author;
        }
        if (child.date) {
          moveAttrs["w:date"] = child.date;
        }
        if (child.name) {
          moveAttrs["w:name"] = child.name;
        }
        xml.leafNode(`w:${child.type}`, moveAttrs);
        return;
      }
      case "customXmlInsRangeStart":
      case "customXmlInsRangeEnd":
      case "customXmlDelRangeStart":
      case "customXmlDelRangeEnd":
      case "customXmlMoveFromRangeStart":
      case "customXmlMoveFromRangeEnd":
      case "customXmlMoveToRangeStart":
      case "customXmlMoveToRangeEnd": {
        const cmAttrs: Record<string, string> = {
          "w:id": String(child.id)
        };
        if (child.author) {
          cmAttrs["w:author"] = child.author;
        }
        if (child.date) {
          cmAttrs["w:date"] = child.date;
        }
        xml.leafNode(`w:${child.type}`, cmAttrs);
        return;
      }
      case "opaqueParagraphChild": {
        const policy = helpers?.rawXmlPolicy;
        if (policy === "reject") {
          throw new DocxRawXmlPolicyError("opaqueParagraphChild");
        }
        if (policy !== "strip") {
          xml.writeRaw(child.rawXml);
        }
        return;
      }
      default:
        break;
    }
  }
  if (isRun(child)) {
    renderRun(xml, child, helpers);
  }
}

/** Render a w:p element. */
export function renderParagraph(xml: XmlSink, para: Paragraph, helpers?: RenderHelpers): void {
  const pAttrs: Record<string, string> = {};
  if (para.paraId) {
    pAttrs["w14:paraId"] = para.paraId;
  }
  if (para.textId) {
    pAttrs["w14:textId"] = para.textId;
  }
  xml.openNode("w:p", Object.keys(pAttrs).length > 0 ? pAttrs : undefined);

  if (para.properties) {
    renderParagraphProperties(xml, para.properties);
  }

  for (const child of para.children) {
    renderParagraphChild(xml, child, helpers);
  }

  xml.closeNode();
}
