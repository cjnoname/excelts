import { isInternalLink } from "@excel/core/hyperlink";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

interface HyperlinkModel {
  address: string;
  rId?: string;
  tooltip?: string;
  target?: string;
}

class HyperlinkXform extends BaseXform {
  get tag(): string {
    return "hyperlink";
  }

  render(xmlStream: XmlSink, model: HyperlinkModel): void {
    if (model.target && isInternalLink(model.target)) {
      // Internal link: use location attribute only (no relationship)
      // Strip the leading "#" — OOXML location attribute is without "#"
      xmlStream.leafNode("hyperlink", {
        ref: model.address,
        tooltip: model.tooltip,
        location: model.target.slice(1)
      });
    } else {
      // External link: use r:id relationship reference
      xmlStream.leafNode("hyperlink", {
        ref: model.address,
        "r:id": model.rId,
        tooltip: model.tooltip
      });
    }
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (node.name === "hyperlink") {
      this.model = {
        address: node.attributes.ref,
        rId: node.attributes["r:id"],
        tooltip: node.attributes.tooltip
      };

      // Internal link: location attribute stores the target without "#"
      // Normalize: always store as "#Location" in the model regardless of
      // whether the source had a leading "#" (our old buggy output) or not
      // (correct OOXML from Excel or the fixed writer).
      if (node.attributes.location) {
        const loc = node.attributes.location;
        this.model.target = loc.startsWith("#") ? loc : `#${loc}`;
      }
      return true;
    }
    return false;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { HyperlinkXform, isInternalLink };
