/**
 * DOCX Writers - Styles
 *
 * Renders word/styles.xml including document defaults, style definitions,
 * and table style conditional formats.
 */

import { NS_W, NS_R, STD_DOC_ATTRIBUTES } from "@word/constants";
import type { DocDefaults, StyleDef, TableStyleConditionalFormat, TableBorders } from "@word/types";
import { renderParagraphProperties } from "@word/writer/paragraph-writer";
import { renderRunProperties, renderShading } from "@word/writer/run-writer";
import type { XmlSink } from "@xml/types";

/** Render document defaults. */
function renderDocDefaults(xml: XmlSink, defaults: DocDefaults): void {
  xml.openNode("w:docDefaults");

  if (defaults.runProperties) {
    xml.openNode("w:rPrDefault");
    renderRunProperties(xml, defaults.runProperties);
    xml.closeNode();
  }

  if (defaults.paragraphProperties) {
    xml.openNode("w:pPrDefault");
    renderParagraphProperties(xml, defaults.paragraphProperties);
    xml.closeNode();
  }

  xml.closeNode();
}

/** Map table style condition type to OOXML value. */
const CONDITION_TYPE_MAP: Record<string, string> = {
  firstRow: "firstRow",
  lastRow: "lastRow",
  firstColumn: "firstCol",
  lastColumn: "lastCol",
  oddRowBanding: "band1Horz",
  evenRowBanding: "band2Horz",
  oddColumnBanding: "band1Vert",
  evenColumnBanding: "band2Vert",
  topLeftCell: "nwCell",
  topRightCell: "neCell",
  bottomLeftCell: "swCell",
  bottomRightCell: "seCell"
};

/** Render table style conditional format (w:tblStylePr). */
function renderTableStyleCondition(xml: XmlSink, condition: TableStyleConditionalFormat): void {
  const typeVal = CONDITION_TYPE_MAP[condition.type] ?? condition.type;
  xml.openNode("w:tblStylePr", { "w:type": typeVal });

  if (condition.paragraphProperties) {
    renderParagraphProperties(xml, condition.paragraphProperties);
  }
  if (condition.runProperties) {
    renderRunProperties(xml, condition.runProperties);
  }
  if (condition.tableProperties) {
    xml.openNode("w:tblPr");
    // Simplified table props for conditional format
    if (condition.tableProperties.borders) {
      renderTableBordersInStyle(xml, condition.tableProperties.borders);
    }
    xml.closeNode();
  }
  if (condition.cellProperties) {
    xml.openNode("w:tcPr");
    if (condition.cellProperties.shading) {
      renderShading(xml, condition.cellProperties.shading);
    }
    if (condition.cellProperties.borders) {
      renderCellBordersInStyle(xml, condition.cellProperties.borders);
    }
    xml.closeNode();
  }

  xml.closeNode();
}

/**
 * Render cell borders inside a style definition (w:tcBorders).
 * Cell-level border container is `w:tcBorders`, not `w:tblBorders` — using
 * the wrong wrapper produces invalid styles.xml that Word silently ignores.
 */
function renderCellBordersInStyle(xml: XmlSink, borders: TableBorders): void {
  xml.openNode("w:tcBorders");
  for (const side of [
    "top",
    "left",
    "bottom",
    "right",
    "insideH",
    "insideV",
    "start",
    "end",
    "tl2br",
    "tr2bl"
  ] as const) {
    const b = borders[side];
    if (b) {
      xml.leafNode(`w:${side}`, {
        "w:val": b.style,
        "w:sz": String(b.size ?? 4),
        "w:space": String(Math.max(0, Math.round(b.space ?? 0))),
        "w:color": b.color ?? "auto"
      });
    }
  }
  xml.closeNode();
}

/** Render table borders inside a style definition. */
function renderTableBordersInStyle(xml: XmlSink, borders: TableBorders): void {
  xml.openNode("w:tblBorders");
  for (const side of ["top", "left", "bottom", "right", "insideH", "insideV"] as const) {
    const b = borders[side];
    if (b) {
      xml.leafNode(`w:${side}`, {
        "w:val": b.style,
        "w:sz": String(b.size ?? 4),
        "w:space": String(Math.max(0, Math.round(b.space ?? 0))),
        "w:color": b.color ?? "auto"
      });
    }
  }
  xml.closeNode();
}

/** Render a single style definition. */
function renderStyle(xml: XmlSink, style: StyleDef): void {
  const attrs: Record<string, string> = {
    "w:type": style.type,
    "w:styleId": style.styleId
  };
  if (style.isDefault) {
    attrs["w:default"] = "1";
  }
  if (style.customStyle) {
    attrs["w:customStyle"] = "1";
  }
  xml.openNode("w:style", attrs);

  xml.leafNode("w:name", { "w:val": style.name });

  if (style.basedOn) {
    xml.leafNode("w:basedOn", { "w:val": style.basedOn });
  }
  if (style.next) {
    xml.leafNode("w:next", { "w:val": style.next });
  }
  if (style.link) {
    xml.leafNode("w:link", { "w:val": style.link });
  }
  if (style.autoRedefine) {
    xml.leafNode("w:autoRedefine");
  }
  if (style.hidden) {
    xml.leafNode("w:hidden");
  }
  if (style.uiPriority !== undefined) {
    xml.leafNode("w:uiPriority", { "w:val": String(style.uiPriority) });
  }
  if (style.semiHidden) {
    xml.leafNode("w:semiHidden");
  }
  if (style.unhideWhenUsed) {
    xml.leafNode("w:unhideWhenUsed");
  }
  if (style.qFormat) {
    xml.leafNode("w:qFormat");
  }
  if (style.locked) {
    xml.leafNode("w:locked");
  }

  if (style.outlineLevel !== undefined) {
    xml.leafNode("w:outlineLvl", { "w:val": String(style.outlineLevel) });
  }

  if (style.paragraphProperties) {
    renderParagraphProperties(xml, style.paragraphProperties);
  }

  if (style.runProperties) {
    renderRunProperties(xml, style.runProperties);
  }

  // For table styles
  if (style.tableProperties) {
    xml.openNode("w:tblPr");
    // Per CT_TblPrBase order, band sizes precede w:tblW.
    if (style.tableProperties.rowBandSize !== undefined) {
      xml.leafNode("w:tblStyleRowBandSize", {
        "w:val": String(style.tableProperties.rowBandSize)
      });
    }
    if (style.tableProperties.colBandSize !== undefined) {
      xml.leafNode("w:tblStyleColBandSize", {
        "w:val": String(style.tableProperties.colBandSize)
      });
    }
    if (style.tableProperties.width) {
      xml.leafNode("w:tblW", {
        "w:w": String(style.tableProperties.width.value),
        "w:type": style.tableProperties.width.type
      });
    }
    if (style.tableProperties.alignment) {
      xml.leafNode("w:jc", { "w:val": style.tableProperties.alignment });
    }
    if (style.tableProperties.indent !== undefined) {
      xml.leafNode("w:tblInd", {
        "w:w": String(style.tableProperties.indent),
        "w:type": "dxa"
      });
    }
    if (style.tableProperties.layout) {
      xml.leafNode("w:tblLayout", { "w:type": style.tableProperties.layout });
    }
    if (style.tableProperties.borders) {
      renderTableBordersInStyle(xml, style.tableProperties.borders);
    }
    if (style.tableProperties.cellMargins) {
      xml.openNode("w:tblCellMar");
      for (const side of ["top", "left", "bottom", "right"] as const) {
        const m = style.tableProperties.cellMargins[side];
        if (m) {
          xml.leafNode(`w:${side}`, { "w:w": String(m.value), "w:type": m.type });
        }
      }
      xml.closeNode();
    }
    if (style.tableProperties.cellSpacing) {
      xml.leafNode("w:tblCellSpacing", {
        "w:w": String(style.tableProperties.cellSpacing.value),
        "w:type": style.tableProperties.cellSpacing.type
      });
    }
    if (style.tableProperties.shading) {
      const shd = style.tableProperties.shading;
      const shdAttrs: Record<string, string> = {
        "w:val": shd.pattern ?? "clear",
        "w:fill": shd.fill ?? "auto"
      };
      if (shd.color) {
        shdAttrs["w:color"] = shd.color;
      }
      xml.leafNode("w:shd", shdAttrs);
    }
    if (style.tableProperties.look) {
      const look = style.tableProperties.look;
      const lookAttrs: Record<string, string> = {};
      if (look.firstRow !== undefined) {
        lookAttrs["w:firstRow"] = look.firstRow ? "1" : "0";
      }
      if (look.lastRow !== undefined) {
        lookAttrs["w:lastRow"] = look.lastRow ? "1" : "0";
      }
      if (look.firstColumn !== undefined) {
        lookAttrs["w:firstColumn"] = look.firstColumn ? "1" : "0";
      }
      if (look.lastColumn !== undefined) {
        lookAttrs["w:lastColumn"] = look.lastColumn ? "1" : "0";
      }
      if (look.noHBand !== undefined) {
        lookAttrs["w:noHBand"] = look.noHBand ? "1" : "0";
      }
      if (look.noVBand !== undefined) {
        lookAttrs["w:noVBand"] = look.noVBand ? "1" : "0";
      }
      xml.leafNode("w:tblLook", lookAttrs);
    }
    if (style.tableProperties.visuallyRightToLeft) {
      xml.leafNode("w:bidiVisual");
    }
    xml.closeNode();
  }

  // Table style conditional formats
  if (style.tableStyleConditions) {
    for (const cond of style.tableStyleConditions) {
      renderTableStyleCondition(xml, cond);
    }
  }

  xml.closeNode();
}

/** Render word/styles.xml. */
export function renderStyles(
  xml: XmlSink,
  docDefaults?: DocDefaults,
  styles?: readonly StyleDef[]
): void {
  xml.openXml(STD_DOC_ATTRIBUTES);
  xml.openNode("w:styles", {
    "xmlns:w": NS_W,
    "xmlns:r": NS_R
  });

  if (docDefaults) {
    renderDocDefaults(xml, docDefaults);
  }

  if (styles) {
    for (const style of styles) {
      renderStyle(xml, style);
    }
  }

  xml.closeNode();
}
