/**
 * DOCX Writers - Run Properties & Run Content
 *
 * Renders w:rPr and run-level content (w:t, w:br, w:tab, w:drawing, etc.)
 */

import { isEastAsianTypeface } from "@utils/cjk-typefaces";
import { NS_A, NS_PIC, URI_PIC, NS_ASVG, GUID_SVG } from "@word/constants";
import { DocxRawXmlPolicyError } from "@word/errors";
import type {
  RunProperties,
  RunContent,
  Run,
  FontSpec,
  Shading,
  InlineImageContent,
  FieldContent,
  FormField,
  Border,
  UnderlineSpec,
  ColorSpec
} from "@word/types";
import type { RenderHelpers } from "@word/writer/render-context";
import type { XmlSink } from "@xml/types";

/** Render a single border element. */
export function renderBorderElement(xml: XmlSink, tagName: string, border: Border): void {
  const attrs: Record<string, string> = { "w:val": border.style };
  if (border.size !== undefined) {
    attrs["w:sz"] = String(border.size);
  }
  if (border.space !== undefined) {
    // `w:space` is ST_PointMeasure — a whole number of points. Callers work in
    // real points (a CSS length converted to pt is rarely integral), so round
    // here at the schema boundary rather than emitting `w:space="12.571…"`,
    // which strict consumers reject.
    attrs["w:space"] = String(Math.max(0, Math.round(border.space)));
  }
  if (border.color) {
    attrs["w:color"] = border.color;
  }
  if (border.themeColor) {
    attrs["w:themeColor"] = border.themeColor;
  }
  if (border.shadow) {
    attrs["w:shadow"] = "1";
  }
  if (border.frame) {
    attrs["w:frame"] = "1";
  }
  // Artistic border (page borders only)
  if (border.art) {
    attrs["w:art"] = border.art;
  }
  xml.leafNode(tagName, attrs);
}

/** Render w:rPr (run properties). Element order follows ECMA-376 CT_RPr schema. */
export function renderRunProperties(
  xml: XmlSink,
  rPr: RunProperties,
  insidePropertyChange = false
): void {
  xml.openNode("w:rPr");
  renderRunPropertiesContents(xml, rPr, insidePropertyChange);
  xml.closeNode();
}

/**
 * Render the **contents** of a w:rPr element (without the w:rPr wrapper).
 *
 * Use this when you need to inject additional siblings (like w:ins/w:del for
 * paragraph mark revisions) into the same w:rPr element. Otherwise prefer
 * {@link renderRunProperties} which manages the wrapper for you.
 */
export function renderRunPropertiesContents(
  xml: XmlSink,
  rPr: RunProperties,
  insidePropertyChange = false
): void {
  // 1. rStyle
  if (rPr.style) {
    xml.leafNode("w:rStyle", { "w:val": rPr.style });
  }

  // 2. rFonts
  if (rPr.font) {
    if (typeof rPr.font === "string") {
      // A bare string names the East Asian slot only when the typeface can
      // actually draw East Asian text.
      //
      // `w:ascii`/`w:hAnsi` cover only ASCII and High ANSI, so `{ font: "宋体" }`
      // used to leave ideographs resolving through docDefaults and the requested
      // typeface never reached a single Chinese character. Setting the slot
      // unconditionally fixed that but broke the opposite case: the built-in
      // heading styles pass `"Calibri Light"` and HTML import passes
      // `"Courier New"`, neither of which has CJK glyphs, so Chinese headings and
      // Chinese code spans were pointed at a face that cannot draw them and fell
      // back to whatever the host chose — worse than the inherited East Asian
      // face they had before.
      //
      // A Latin-only name therefore leaves `w:eastAsia` alone, preserving
      // inheritance. Callers needing exact control over each slot pass the object
      // form.
      const attrs: Record<string, string> = {
        "w:ascii": rPr.font,
        "w:hAnsi": rPr.font
      };
      if (isEastAsianTypeface(rPr.font)) {
        attrs["w:eastAsia"] = rPr.font;
      }
      xml.leafNode("w:rFonts", attrs);
    } else {
      const f: FontSpec = rPr.font;
      const attrs: Record<string, string> = {};
      if (f.ascii) {
        attrs["w:ascii"] = f.ascii;
      }
      if (f.hAnsi) {
        attrs["w:hAnsi"] = f.hAnsi;
      }
      if (f.eastAsia) {
        attrs["w:eastAsia"] = f.eastAsia;
      }
      if (f.cs) {
        attrs["w:cs"] = f.cs;
      }
      if (f.hint) {
        attrs["w:hint"] = f.hint;
      }
      if (f.asciiTheme) {
        attrs["w:asciiTheme"] = f.asciiTheme;
      }
      if (f.hAnsiTheme) {
        attrs["w:hAnsiTheme"] = f.hAnsiTheme;
      }
      if (f.eastAsiaTheme) {
        attrs["w:eastAsiaTheme"] = f.eastAsiaTheme;
      }
      if (f.cstheme) {
        attrs["w:cstheme"] = f.cstheme;
      }
      xml.leafNode("w:rFonts", attrs);
    }
  }

  // 3. b, bCs
  if (rPr.bold !== undefined) {
    xml.leafNode("w:b", !rPr.bold ? { "w:val": "0" } : undefined);
  }
  if (rPr.boldCs !== undefined) {
    xml.leafNode("w:bCs", !rPr.boldCs ? { "w:val": "0" } : undefined);
  }

  // 4. i, iCs
  if (rPr.italic !== undefined) {
    xml.leafNode("w:i", !rPr.italic ? { "w:val": "0" } : undefined);
  }
  if (rPr.italicCs !== undefined) {
    xml.leafNode("w:iCs", !rPr.italicCs ? { "w:val": "0" } : undefined);
  }

  // 5. caps, smallCaps
  if (rPr.caps) {
    xml.leafNode("w:caps");
  }
  if (rPr.smallCaps) {
    xml.leafNode("w:smallCaps");
  }

  // 6. strike, dstrike
  if (rPr.strike) {
    xml.leafNode("w:strike");
  }
  if (rPr.doubleStrike) {
    xml.leafNode("w:dstrike");
  }

  // 7. outline, shadow, emboss, imprint (outline effects)
  if (rPr.outline) {
    xml.leafNode("w:outline");
  }
  if (rPr.shadow) {
    xml.leafNode("w:shadow");
  }
  if (rPr.emboss) {
    xml.leafNode("w:emboss");
  }
  if (rPr.imprint) {
    xml.leafNode("w:imprint");
  }

  // 8. noProof
  if (rPr.noProof) {
    xml.leafNode("w:noProof");
  }

  // 9. snapToGrid
  if (rPr.snapToGrid !== undefined) {
    xml.leafNode("w:snapToGrid", !rPr.snapToGrid ? { "w:val": "0" } : undefined);
  }

  // 10. vanish, webHidden
  if (rPr.vanish) {
    xml.leafNode("w:vanish");
  }
  if (rPr.webHidden) {
    xml.leafNode("w:webHidden");
  }

  // 11. color
  if (rPr.color) {
    if (typeof rPr.color === "string") {
      xml.leafNode("w:color", { "w:val": rPr.color });
    } else {
      const spec = rPr.color as ColorSpec;
      const attrs: Record<string, string> = { "w:val": spec.val };
      if (spec.themeColor) {
        attrs["w:themeColor"] = spec.themeColor;
      }
      if (spec.themeTint) {
        attrs["w:themeTint"] = spec.themeTint;
      }
      if (spec.themeShade) {
        attrs["w:themeShade"] = spec.themeShade;
      }
      xml.leafNode("w:color", attrs);
    }
  }

  // 12. spacing, w (scale), kern, position
  if (rPr.spacing !== undefined) {
    xml.leafNode("w:spacing", { "w:val": String(rPr.spacing) });
  }
  if (rPr.scale !== undefined) {
    xml.leafNode("w:w", { "w:val": String(rPr.scale) });
  }
  if (rPr.kern !== undefined) {
    xml.leafNode("w:kern", { "w:val": String(rPr.kern) });
  }
  if (rPr.position !== undefined) {
    xml.leafNode("w:position", { "w:val": String(rPr.position) });
  }

  // 13. sz, szCs
  if (rPr.size !== undefined) {
    xml.leafNode("w:sz", { "w:val": String(rPr.size) });
  }
  if (rPr.sizeCs !== undefined) {
    xml.leafNode("w:szCs", { "w:val": String(rPr.sizeCs) });
  }

  // 14. highlight
  if (rPr.highlight) {
    xml.leafNode("w:highlight", { "w:val": rPr.highlight });
  }

  // 15. u (underline)
  if (rPr.underline !== undefined) {
    if (typeof rPr.underline === "boolean") {
      xml.leafNode("w:u", { "w:val": rPr.underline ? "single" : "none" });
    } else if (typeof rPr.underline === "string") {
      xml.leafNode("w:u", { "w:val": rPr.underline });
    } else {
      const spec = rPr.underline as UnderlineSpec;
      const attrs: Record<string, string> = { "w:val": spec.style };
      if (spec.color) {
        attrs["w:color"] = spec.color;
      }
      xml.leafNode("w:u", attrs);
    }
  }

  // 16. effect (text animation)
  if (rPr.effect) {
    xml.leafNode("w:effect", { "w:val": rPr.effect });
  }

  // 17. bdr (character border)
  if (rPr.border) {
    renderBorderElement(xml, "w:bdr", rPr.border);
  }

  // 18. shd
  if (rPr.shading) {
    renderShading(xml, rPr.shading);
  }

  // 19. fitText
  if (rPr.fitText) {
    const attrs: Record<string, string> = { "w:val": String(rPr.fitText.val) };
    if (rPr.fitText.id !== undefined) {
      attrs["w:id"] = String(rPr.fitText.id);
    }
    xml.leafNode("w:fitText", attrs);
  }

  // 20. vertAlign
  if (rPr.vertAlign) {
    xml.leafNode("w:vertAlign", { "w:val": rPr.vertAlign });
  }

  // 21. rtl
  if (rPr.rightToLeft) {
    xml.leafNode("w:rtl");
  }

  // 22. cs (complex script toggle)
  if (rPr.complexScript) {
    xml.leafNode("w:cs");
  }

  // 23. em (emphasis mark)
  if (rPr.emphasisMark) {
    xml.leafNode("w:em", { "w:val": rPr.emphasisMark });
  }

  // 24. lang
  if (rPr.language) {
    const attrs: Record<string, string> = {};
    if (rPr.language.val) {
      attrs["w:val"] = rPr.language.val;
    }
    if (rPr.language.eastAsia) {
      attrs["w:eastAsia"] = rPr.language.eastAsia;
    }
    if (rPr.language.bidi) {
      attrs["w:bidi"] = rPr.language.bidi;
    }
    xml.leafNode("w:lang", attrs);
  }

  // 25. eastAsianLayout (ECMA-376 §17.3.2.10)
  if (rPr.eastAsianLayout) {
    const ea = rPr.eastAsianLayout;
    const attrs: Record<string, string> = {};
    if (ea.id != null) {
      attrs["w:id"] = String(ea.id);
    }
    if (ea.combine) {
      attrs["w:combine"] = "1";
    }
    if (ea.combineBrackets) {
      attrs["w:combineBrackets"] = ea.combineBrackets;
    }
    if (ea.vert) {
      attrs["w:vert"] = "1";
    }
    if (ea.vertCompress) {
      attrs["w:vertCompress"] = "1";
    }
    if (Object.keys(attrs).length > 0) {
      xml.leafNode("w:eastAsianLayout", attrs);
    }
  }

  // 26. specVanish
  if (rPr.specVanish) {
    xml.leafNode("w:specVanish");
  }

  // 27. oMath
  if (rPr.math) {
    xml.leafNode("w:oMath");
  }

  // 28. rPrChange (track changes) — always last; NOT recursed into when rendering previousProperties
  if (!insidePropertyChange && rPr.propertyChange) {
    const rev = rPr.propertyChange.revision;
    const attrs: Record<string, string> = {
      "w:id": String(rev.id),
      "w:author": rev.author
    };
    if (rev.date) {
      attrs["w:date"] = rev.date;
    }
    xml.openNode("w:rPrChange", attrs);
    if (rPr.propertyChange.previousProperties) {
      renderRunProperties(xml, rPr.propertyChange.previousProperties, true);
    } else {
      xml.openNode("w:rPr");
      xml.closeNode();
    }
    xml.closeNode();
  }
}

/** Render w:shd element. */
export function renderShading(xml: XmlSink, shd: Shading): void {
  xml.leafNode("w:shd", {
    "w:val": shd.pattern ?? "clear",
    "w:color": shd.color ?? "auto",
    "w:fill": shd.fill
  });
}

/** Render an inline image (w:drawing > wp:inline). */
function renderInlineImage(
  xml: XmlSink,
  img: InlineImageContent,
  imageRemap?: ReadonlyMap<string, string>,
  nextDocPrId?: () => number
): void {
  const drawingId = nextDocPrId?.() ?? img.drawingId ?? 1;
  const name = img.name ?? "Picture";

  // Resolve the relationship id used in r:embed: prefer a packager-provided
  // remap (used when the model rId clashed with an existing relationship in
  // the same .rels file), otherwise emit the model rId verbatim. We never
  // mutate the model itself.
  const embedRId = imageRemap?.get(img.rId) ?? img.rId;
  const svgEmbedRId = img.svgRId ? (imageRemap?.get(img.svgRId) ?? img.svgRId) : undefined;

  xml.openNode("w:drawing");
  xml.openNode("wp:inline", {
    distT: "0",
    distB: "0",
    distL: "0",
    distR: "0"
  });

  xml.leafNode("wp:extent", { cx: String(img.width), cy: String(img.height) });
  xml.leafNode("wp:effectExtent", { l: "0", t: "0", r: "0", b: "0" });
  xml.leafNode("wp:docPr", {
    id: String(drawingId),
    name,
    ...(img.altText ? { descr: img.altText } : {})
  });

  xml.openNode("wp:cNvGraphicFramePr");
  xml.leafNode("a:graphicFrameLocks", { "xmlns:a": NS_A, noChangeAspect: "1" });
  xml.closeNode();

  xml.openNode("a:graphic", { "xmlns:a": NS_A });
  xml.openNode("a:graphicData", { uri: URI_PIC });

  xml.openNode("pic:pic", { "xmlns:pic": NS_PIC });

  // nvPicPr
  xml.openNode("pic:nvPicPr");
  xml.leafNode("pic:cNvPr", { id: String(drawingId), name });
  xml.leafNode("pic:cNvPicPr");
  xml.closeNode();

  // blipFill
  xml.openNode("pic:blipFill");
  if (img.svgRId) {
    xml.openNode("a:blip", { "r:embed": embedRId });
    xml.openNode("a:extLst");
    xml.openNode("a:ext", { uri: GUID_SVG });
    xml.leafNode("asvg:svgBlip", {
      "xmlns:asvg": NS_ASVG,
      "r:embed": svgEmbedRId!
    });
    xml.closeNode(); // a:ext
    xml.closeNode(); // a:extLst
    xml.closeNode(); // a:blip
  } else {
    xml.leafNode("a:blip", { "r:embed": embedRId });
  }
  // Source rectangle (crop)
  if (img.srcRect) {
    const sr = img.srcRect;
    const srAttrs: Record<string, string> = {};
    if (sr.l !== undefined) {
      srAttrs["l"] = String(sr.l);
    }
    if (sr.t !== undefined) {
      srAttrs["t"] = String(sr.t);
    }
    if (sr.r !== undefined) {
      srAttrs["r"] = String(sr.r);
    }
    if (sr.b !== undefined) {
      srAttrs["b"] = String(sr.b);
    }
    xml.leafNode("a:srcRect", srAttrs);
  }
  xml.openNode("a:stretch");
  xml.leafNode("a:fillRect");
  xml.closeNode();
  xml.closeNode();

  // spPr
  xml.openNode("pic:spPr");

  // Transform with optional rotation/flip
  const xfrmAttrs: Record<string, string> = {};
  if (img.rotation) {
    xfrmAttrs["rot"] = String(img.rotation);
  }
  if (img.flipHorizontal) {
    xfrmAttrs["flipH"] = "1";
  }
  if (img.flipVertical) {
    xfrmAttrs["flipV"] = "1";
  }
  xml.openNode("a:xfrm", Object.keys(xfrmAttrs).length > 0 ? xfrmAttrs : undefined);
  xml.leafNode("a:off", { x: "0", y: "0" });
  xml.leafNode("a:ext", { cx: String(img.width), cy: String(img.height) });
  xml.closeNode();

  xml.openNode("a:prstGeom", { prst: "rect" });
  xml.leafNode("a:avLst");
  xml.closeNode();

  // Outline
  if (img.outline) {
    const lnAttrs: Record<string, string> = {};
    if (img.outline.width !== undefined) {
      lnAttrs["w"] = String(img.outline.width);
    }
    xml.openNode("a:ln", Object.keys(lnAttrs).length > 0 ? lnAttrs : undefined);
    if (img.outline.color) {
      xml.openNode("a:solidFill");
      xml.leafNode("a:srgbClr", { val: img.outline.color });
      xml.closeNode();
    }
    xml.closeNode();
  }

  xml.closeNode(); // pic:spPr

  xml.closeNode(); // pic:pic
  xml.closeNode(); // a:graphicData
  xml.closeNode(); // a:graphic
  xml.closeNode(); // wp:inline
  xml.closeNode(); // w:drawing
}

/** Render w:ffData element for legacy form fields. */
function renderFfData(xml: XmlSink, ff: FormField): void {
  xml.openNode("w:ffData");

  if (ff.name) {
    xml.leafNode("w:name", { "w:val": ff.name });
  }
  if (ff.type !== "checkBox" && ff.enabled !== undefined) {
    xml.leafNode("w:enabled", ff.enabled ? undefined : { "w:val": "0" });
  }

  if (ff.type === "text") {
    xml.openNode("w:textInput");
    if (ff.default !== undefined) {
      xml.leafNode("w:default", { "w:val": ff.default });
    }
    if (ff.maxLength !== undefined) {
      xml.leafNode("w:maxLength", { "w:val": String(ff.maxLength) });
    }
    if (ff.format) {
      xml.leafNode("w:format", { "w:val": ff.format });
    }
    xml.closeNode();
    if (ff.helpText) {
      xml.leafNode("w:helpText", { "w:type": "text", "w:val": ff.helpText });
    }
    if (ff.statusText) {
      xml.leafNode("w:statusText", { "w:type": "text", "w:val": ff.statusText });
    }
  } else if (ff.type === "checkBox") {
    xml.openNode("w:checkBox");
    if (ff.size !== undefined) {
      xml.leafNode("w:size", { "w:val": String(ff.size) });
    } else {
      xml.leafNode("w:sizeAuto");
    }
    if (ff.default !== undefined) {
      xml.leafNode("w:default", { "w:val": ff.default ? "1" : "0" });
    }
    if (ff.checked !== undefined) {
      xml.leafNode("w:checked", { "w:val": ff.checked ? "1" : "0" });
    }
    xml.closeNode();
  } else if (ff.type === "dropDown") {
    xml.openNode("w:ddList");
    if (ff.default !== undefined) {
      xml.leafNode("w:default", { "w:val": String(ff.default) });
    }
    if (ff.entries) {
      for (const entry of ff.entries) {
        // Word rejects FORMDROPDOWN list entries with an empty value
        // ("Word experienced an error trying to open the file"). Substitute a
        // single space so an intended blank/placeholder item still renders and
        // the entry indices (and `w:default`) stay aligned.
        xml.leafNode("w:listEntry", { "w:val": entry === "" ? " " : entry });
      }
    }
    xml.closeNode();
    if (ff.helpText) {
      xml.leafNode("w:helpText", { "w:type": "text", "w:val": ff.helpText });
    }
    if (ff.statusText) {
      xml.leafNode("w:statusText", { "w:type": "text", "w:val": ff.statusText });
    }
  }

  xml.closeNode(); // ffData
}

/**
 * Emit a UTF-8 text payload as one or more `<w:t>` elements separated by
 * `<w:br/>` whenever the source contains a newline. OOXML's CT_Text
 * forbids `\n` / `\r` inside its value — Word silently rejects packages
 * that contain them. Used by both run text content and field cached
 * values.
 */
function writeTextWithBreaks(xml: XmlSink, value: string): void {
  if (value.indexOf("\n") < 0 && value.indexOf("\r") < 0) {
    xml.openNode("w:t", { "xml:space": "preserve" });
    xml.writeText(value);
    xml.closeNode();
    return;
  }
  const segments = value.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].length > 0) {
      xml.openNode("w:t", { "xml:space": "preserve" });
      xml.writeText(segments[i]);
      xml.closeNode();
    }
    if (i < segments.length - 1) {
      xml.leafNode("w:br");
    }
  }
}

/** Render a field code (PAGE, NUMPAGES, etc.). Inherits run properties from the containing run. */
function renderField(xml: XmlSink, field: FieldContent, rPr?: RunProperties): void {
  // Helper to emit inherited rPr in each field sub-run
  const emitRPr = (): void => {
    if (rPr) {
      renderRunProperties(xml, rPr);
    }
  };

  // Begin
  xml.openNode("w:r");
  emitRPr();
  if (field.formField) {
    xml.openNode("w:fldChar", { "w:fldCharType": "begin" });
    renderFfData(xml, field.formField);
    xml.closeNode();
  } else {
    xml.leafNode("w:fldChar", { "w:fldCharType": "begin" });
  }
  xml.closeNode();

  // Instruction
  xml.openNode("w:r");
  emitRPr();
  xml.openNode("w:instrText", { "xml:space": "preserve" });
  xml.writeText(field.instruction);
  xml.closeNode();
  xml.closeNode();

  // Separate
  xml.openNode("w:r");
  emitRPr();
  xml.leafNode("w:fldChar", { "w:fldCharType": "separate" });
  xml.closeNode();

  // Cached value
  if (field.cachedValue !== undefined) {
    xml.openNode("w:r");
    emitRPr();
    writeTextWithBreaks(xml, field.cachedValue);
    xml.closeNode();
  }

  // End
  xml.openNode("w:r");
  emitRPr();
  xml.leafNode("w:fldChar", { "w:fldCharType": "end" });
  xml.closeNode();
}

/** Render a single piece of run content. Returns true if rendered inside a w:r, false if it creates its own runs. */
function renderRunContent(xml: XmlSink, content: RunContent, helpers?: RenderHelpers): boolean {
  switch (content.type) {
    case "text":
      // OOXML's <w:t> is a string with no embedded line breaks (the schema
      // forbids U+000A / U+000D inside its text node). Authors writing
      // multi-line cell labels conventionally pass `\n` in the source string;
      // we split those into multiple <w:t> + <w:br/> pairs so Word renders a
      // soft line break instead of rejecting the file.
      writeTextWithBreaks(xml, content.text);
      return true;

    case "break":
      if (content.breakType) {
        xml.leafNode("w:br", { "w:type": content.breakType });
      } else {
        xml.leafNode("w:br");
      }
      return true;

    case "tab":
      xml.leafNode("w:tab");
      return true;

    case "ptab": {
      const ptabAttrs: Record<string, string> = {
        "w:alignment": content.alignment,
        "w:relativeTo": content.relativeTo
      };
      if (content.leader) {
        ptabAttrs["w:leader"] = content.leader;
      }
      xml.leafNode("w:ptab", ptabAttrs);
      return true;
    }

    case "ruby": {
      xml.openNode("w:ruby");
      // Ruby properties
      if (content.properties) {
        xml.openNode("w:rubyPr");
        const p = content.properties;
        if (p.align) {
          xml.leafNode("w:rubyAlign", { "w:val": p.align });
        }
        if (p.fontSize !== undefined) {
          xml.leafNode("w:hps", { "w:val": String(p.fontSize) });
        }
        if (p.raise !== undefined) {
          xml.leafNode("w:hpsRaise", { "w:val": String(p.raise) });
        }
        if (p.baseFontSize !== undefined) {
          xml.leafNode("w:hpsBaseText", { "w:val": String(p.baseFontSize) });
        }
        if (p.language) {
          xml.leafNode("w:lid", { "w:val": p.language });
        }
        xml.closeNode();
      }
      // Ruby text (w:rt)
      xml.openNode("w:rt");
      for (const run of content.rubyText) {
        renderRun(xml, run, helpers);
      }
      xml.closeNode();
      // Base text (w:rubyBase)
      xml.openNode("w:rubyBase");
      for (const run of content.baseText) {
        renderRun(xml, run, helpers);
      }
      xml.closeNode();
      xml.closeNode(); // w:ruby
      return true;
    }

    case "symbol":
      xml.leafNode("w:sym", { "w:font": content.font, "w:char": content.char });
      return true;

    case "footnoteRef": {
      const attrs: Record<string, string> = { "w:id": String(content.id) };
      if (content.customMarkFollows) {
        attrs["w:customMarkFollows"] = "1";
      }
      xml.leafNode("w:footnoteReference", attrs);
      return true;
    }

    case "endnoteRef": {
      const attrs: Record<string, string> = { "w:id": String(content.id) };
      if (content.customMarkFollows) {
        attrs["w:customMarkFollows"] = "1";
      }
      xml.leafNode("w:endnoteReference", attrs);
      return true;
    }

    case "image":
      // Skip placeholder images (rId === ""). They originate from import
      // pipelines like html-import that don't register the underlying
      // ImageDef — emitting <w:drawing> with a missing r:embed produces a
      // dangling reference Word rejects.
      if (!content.rId) {
        if (content.altText) {
          xml.openNode("w:t", { "xml:space": "preserve" });
          xml.writeText(content.altText);
          xml.closeNode();
        }
        return true;
      }
      renderInlineImage(xml, content, helpers?.imageRemap, helpers?.nextDocPrId);
      return true;

    case "field":
      // Fields create their own runs — must be rendered outside the current run
      return false;

    case "carriageReturn":
      xml.leafNode("w:cr");
      return true;

    case "noBreakHyphen":
      xml.leafNode("w:noBreakHyphen");
      return true;

    case "softHyphen":
      xml.leafNode("w:softHyphen");
      return true;

    case "lastRenderedPageBreak":
      xml.leafNode("w:lastRenderedPageBreak");
      return true;

    case "annotationReference":
      xml.leafNode("w:annotationRef");
      return true;

    case "dateField":
      // Rendered as a field instruction
      return false;

    case "opaqueRun": {
      // Honor the rawXmlPolicy from the active security policy.
      const policy = helpers?.rawXmlPolicy;
      if (policy === "reject") {
        throw new DocxRawXmlPolicyError("opaqueRun");
      }
      if (policy !== "strip") {
        // "preserve" (default) — write verbatim.
        xml.writeRaw(content.rawXml);
      }
      return true;
    }

    default:
      return true;
  }
}

/** Render a w:r element. */
export function renderRun(xml: XmlSink, run: Run, helpers?: RenderHelpers): void {
  // Separate field content that needs its own runs
  const normalContent: RunContent[] = [];
  const fieldContent: (FieldContent | RunContent)[] = [];

  for (const c of run.content) {
    if (c.type === "field") {
      fieldContent.push(c);
    } else if (c.type === "dateField") {
      // Convert date field to field instruction.
      // Use the model's cachedValue if provided; otherwise leave empty (deterministic output).
      const fmt = c.format ?? "yyyy-MM-dd";
      const lang = c.language ?? "en-US";
      fieldContent.push({
        type: "field",
        instruction: ` DATE \\@ "${fmt}" \\l ${lang} `,
        cachedValue: c.cachedValue ?? ""
      });
    } else {
      normalContent.push(c);
    }
  }

  // Render normal content inside a single w:r
  if (normalContent.length > 0) {
    xml.openNode("w:r");
    if (run.properties) {
      renderRunProperties(xml, run.properties);
    }
    for (const content of normalContent) {
      renderRunContent(xml, content, helpers);
    }
    xml.closeNode();
  }

  // Render field content (each field creates multiple runs, inheriting this run's properties)
  for (const fc of fieldContent) {
    if (fc.type === "field") {
      renderField(xml, fc as FieldContent, run.properties);
    }
  }
}
