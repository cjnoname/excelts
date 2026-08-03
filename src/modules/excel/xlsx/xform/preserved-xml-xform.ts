import { XlsxParseError } from "@excel/errors";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { ParseOpenTag } from "@xml/types";
import { XmlWriter } from "@xml/writer";

/** Preserves an attribute-only OOXML element while rejecting nested content. */
class PreservedLeafXform extends BaseXform {
  declare private readonly elementName: string;
  declare private writer?: XmlWriter;

  constructor(elementName: string) {
    super();
    this.elementName = elementName;
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (node.name !== this.elementName || this.writer) {
      throw new XlsxParseError(
        this.elementName,
        `Unexpected xml node in parseOpen: ${JSON.stringify(node)}`
      );
    }
    this.writer = new XmlWriter();
    this.writer.openNode(node.name, node.attributes);
    return true;
  }

  parseText(text: string): void {
    if (text.trim()) {
      throw new XlsxParseError(this.elementName, "Unexpected text content");
    }
  }

  parseClose(name: string): boolean {
    if (name !== this.elementName || !this.writer) {
      throw new XlsxParseError(this.elementName, `Unexpected xml node in parseClose: ${name}`);
    }
    this.writer.closeNode();
    this.model = this.writer.xml;
    this.writer = undefined;
    return false;
  }

  reset(): void {
    super.reset();
    this.writer = undefined;
  }
}

/** Preserves an OOXML subtree's XML semantics across read/write round trips. */
class PreservedSubtreeXform extends BaseXform {
  declare private depth: number;
  declare private writer?: XmlWriter;

  constructor() {
    super();
    this.depth = 0;
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (!this.writer) {
      this.writer = new XmlWriter();
    }
    this.writer.openNode(node.name, node.attributes);
    this.depth += 1;
    return true;
  }

  parseText(text: string): void {
    // CDATA arrives here too: `BaseXform.parseCdata` maps it onto `parseText`,
    // so the value is preserved as escaped text rather than a CDATA section.
    this.writer?.writeText(text);
  }

  parseClose(): boolean {
    this.writer!.closeNode();
    this.depth -= 1;
    if (this.depth > 0) {
      return true;
    }
    this.model = this.writer!.xml;
    this.writer = undefined;
    return false;
  }

  reset(): void {
    super.reset();
    this.depth = 0;
    this.writer = undefined;
  }
}

export { PreservedLeafXform, PreservedSubtreeXform };
