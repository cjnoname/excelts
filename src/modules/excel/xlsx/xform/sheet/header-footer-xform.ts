import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { parseXsdBoolean } from "@excel/xlsx/xform/xsd-values";
import type { ParseOpenTag, XmlSink } from "@xml/types";

export interface HeaderFooterModel {
  differentFirst?: boolean;
  differentOddEven?: boolean;
  scaleWithDoc?: boolean;
  alignWithMargins?: boolean;
  oddHeader?: string | null;
  oddFooter?: string | null;
  evenHeader?: string | null;
  evenFooter?: string | null;
  firstHeader?: string | null;
  firstFooter?: string | null;
}

class HeaderFooterXform extends BaseXform {
  declare private currentNode?: string;

  get tag(): string {
    return "headerFooter";
  }

  render(xmlStream: XmlSink, model?: HeaderFooterModel): void {
    if (!model) {
      return;
    }
    // Collect attributes and children first, only write if any exist
    const attrs: Record<string, string> = {};
    const children: Array<{ name: string; text: string }> = [];

    if (model.differentFirst) {
      attrs.differentFirst = "1";
    }
    if (model.differentOddEven) {
      attrs.differentOddEven = "1";
    }
    if (model.scaleWithDoc === false) {
      attrs.scaleWithDoc = "0";
    }
    if (model.alignWithMargins === false) {
      attrs.alignWithMargins = "0";
    }
    if (model.oddHeader && typeof model.oddHeader === "string") {
      children.push({ name: "oddHeader", text: model.oddHeader });
    }
    if (model.oddFooter && typeof model.oddFooter === "string") {
      children.push({ name: "oddFooter", text: model.oddFooter });
    }
    if (model.evenHeader && typeof model.evenHeader === "string") {
      children.push({ name: "evenHeader", text: model.evenHeader });
    }
    if (model.evenFooter && typeof model.evenFooter === "string") {
      children.push({ name: "evenFooter", text: model.evenFooter });
    }
    if (model.firstHeader && typeof model.firstHeader === "string") {
      children.push({ name: "firstHeader", text: model.firstHeader });
    }
    if (model.firstFooter && typeof model.firstFooter === "string") {
      children.push({ name: "firstFooter", text: model.firstFooter });
    }

    if (Object.keys(attrs).length > 0 || children.length > 0) {
      xmlStream.openNode("headerFooter", attrs);
      for (const child of children) {
        xmlStream.leafNode(child.name, undefined, child.text);
      }
      xmlStream.closeNode();
    }
  }

  parseOpen(node: ParseOpenTag): boolean {
    switch (node.name) {
      case "headerFooter":
        this.model = {};
        if (node.attributes.differentFirst) {
          this.model.differentFirst = parseXsdBoolean(node.attributes.differentFirst) ?? false;
        }
        if (node.attributes.differentOddEven) {
          this.model.differentOddEven = parseXsdBoolean(node.attributes.differentOddEven) ?? false;
        }
        if (node.attributes.scaleWithDoc !== undefined) {
          this.model.scaleWithDoc = parseXsdBoolean(node.attributes.scaleWithDoc) ?? true;
        }
        if (node.attributes.alignWithMargins !== undefined) {
          this.model.alignWithMargins = parseXsdBoolean(node.attributes.alignWithMargins) ?? true;
        }
        return true;

      case "oddHeader":
        this.currentNode = "oddHeader";
        return true;

      case "oddFooter":
        this.currentNode = "oddFooter";
        return true;

      case "evenHeader":
        this.currentNode = "evenHeader";
        return true;

      case "evenFooter":
        this.currentNode = "evenFooter";
        return true;

      case "firstHeader":
        this.currentNode = "firstHeader";
        return true;

      case "firstFooter":
        this.currentNode = "firstFooter";
        return true;

      default:
        return false;
    }
  }

  parseText(text: string): void {
    switch (this.currentNode) {
      case "oddHeader":
        this.model.oddHeader = (this.model.oddHeader ?? "") + text;
        break;

      case "oddFooter":
        this.model.oddFooter = (this.model.oddFooter ?? "") + text;
        break;

      case "evenHeader":
        this.model.evenHeader = (this.model.evenHeader ?? "") + text;
        break;

      case "evenFooter":
        this.model.evenFooter = (this.model.evenFooter ?? "") + text;
        break;

      case "firstHeader":
        this.model.firstHeader = (this.model.firstHeader ?? "") + text;
        break;

      case "firstFooter":
        this.model.firstFooter = (this.model.firstFooter ?? "") + text;
        break;

      default:
        break;
    }
  }

  parseClose(): boolean {
    switch (this.currentNode) {
      case "oddHeader":
      case "oddFooter":
      case "evenHeader":
      case "evenFooter":
      case "firstHeader":
      case "firstFooter":
        this.currentNode = undefined;
        return true;

      default:
        return false;
    }
  }
}

export { HeaderFooterXform };
