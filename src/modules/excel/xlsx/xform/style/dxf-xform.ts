import type { Alignment, Borders, Fill, Font, NumFmt, Protection } from "@excel/types";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { AlignmentXform } from "@excel/xlsx/xform/style/alignment-xform";
import { BorderXform } from "@excel/xlsx/xform/style/border-xform";
import { FillXform } from "@excel/xlsx/xform/style/fill-xform";
import { FontXform } from "@excel/xlsx/xform/style/font-xform";
import { NumFmtXform } from "@excel/xlsx/xform/style/numfmt-xform";
import { ProtectionXform } from "@excel/xlsx/xform/style/protection-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

// <xf numFmtId="[numFmtId]" fontId="[fontId]" fillId="[fillId]" borderId="[xf.borderId]" xfId="[xfId]">
//   Optional <alignment>
//   Optional <protection>
// </xf>

interface DxfModel {
  alignment?: Partial<Alignment>;
  border?: Partial<Borders>;
  fill?: Fill;
  font?: Partial<Font>;
  /**
   * Either the format code (what the writer is handed) or the parsed
   * `{ id, formatCode }` pair (what {@link DxfXform.parseClose} produces when a
   * `dxf` is read back from a file). {@link DxfXform.render} accepts both —
   * before that it stringified the object into `formatCode="[object Object]"`,
   * corrupting the number format of every conditional format on re-save.
   */
  numFmt?: string | NumFmt;
  numFmtId?: number;
  protection?: Partial<Protection>;
}

// Style assists translation from style model to/from xlsx
class DxfXform extends BaseXform {
  declare public map: Record<string, BaseXform>;
  declare public parser?: BaseXform;

  constructor() {
    super();

    this.map = {
      alignment: new AlignmentXform(),
      border: new BorderXform(),
      fill: new FillXform(),
      font: new FontXform(),
      numFmt: new NumFmtXform(),
      protection: new ProtectionXform()
    };
  }

  get tag(): string {
    return "dxf";
  }

  // how do we generate dxfid?

  render(xmlStream: XmlSink, model: DxfModel): void {
    xmlStream.openNode(this.tag);

    if (model.font) {
      this.map.font.render(xmlStream, model.font);
    }
    if (model.numFmt && model.numFmtId) {
      const formatCode = typeof model.numFmt === "string" ? model.numFmt : model.numFmt.formatCode;
      this.map.numFmt.render(xmlStream, { id: model.numFmtId, formatCode });
    }
    if (model.fill) {
      this.map.fill.render(xmlStream, model.fill);
    }
    if (model.alignment) {
      this.map.alignment.render(xmlStream, model.alignment);
    }
    if (model.border) {
      this.map.border.render(xmlStream, model.border);
    }
    if (model.protection) {
      this.map.protection.render(xmlStream, model.protection);
    }

    xmlStream.closeNode();
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }

    switch (node.name) {
      case this.tag:
        // this node is often repeated. Need to reset children
        this.reset();
        return true;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.parseOpen(node);
        }
        return true;
    }
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.parser = undefined;
      }
      return true;
    }
    if (name === this.tag) {
      this.model = {
        alignment: this.map.alignment.model,
        border: this.map.border.model,
        fill: this.map.fill.model,
        font: this.map.font.model,
        numFmt: this.map.numFmt.model,
        protection: this.map.protection.model
      };
      return false;
    }

    return true;
  }
}

export { DxfXform };
