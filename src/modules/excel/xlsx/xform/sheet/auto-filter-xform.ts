import type { AutoFilterCriteria } from "@excel/core/worksheet-core";
import type { AutoFilter } from "@excel/types";
import { colCache } from "@excel/utils/col-cache";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";
import { XmlWriter } from "@xml/writer";

/**
 * Filter criteria captured from a worksheet's `<autoFilter>`, together with the
 * range they were captured for.
 *
 * The public `autoFilter` model is only a range, so the criteria (`filterColumn`
 * entries, `sortState`, extensions) are kept as XML instead. `ref` is retained
 * alongside so the criteria can be discarded when the range is changed —
 * re-emitting column filters against a different range would filter the wrong
 * columns.
 */
function resolveAutoFilterRef(model: AutoFilter): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  const getAddress = (addr: string | { row: number; col: number }): string =>
    typeof addr === "string" ? addr : colCache.getAddress(addr.row, addr.col).address;

  const firstAddress = getAddress(model.from);
  const secondAddress = getAddress(model.to);
  return firstAddress && secondAddress ? `${firstAddress}:${secondAddress}` : undefined;
}

class AutoFilterXform extends BaseXform<AutoFilter> {
  declare private depth: number;
  declare private writer?: XmlWriter;
  declare private namespaceAttributes?: Record<string, string>;
  /** Criteria captured during the last parse, consumed by `WorksheetXform`. */
  declare public criteria?: AutoFilterCriteria;

  constructor() {
    super();
    this.depth = 0;
  }

  get tag(): string {
    return "autoFilter";
  }

  render(xmlStream: XmlSink, model?: AutoFilter, criteria?: AutoFilterCriteria): void {
    if (!model) {
      return;
    }
    const ref = resolveAutoFilterRef(model);
    if (!ref) {
      return;
    }
    // Only replay criteria that still describe this range.
    if (criteria && criteria.ref === ref && criteria.xml) {
      xmlStream.openNode(this.tag, { ...criteria.namespaceAttributes, ref });
      xmlStream.writeRaw(criteria.xml);
      xmlStream.closeNode();
      return;
    }
    xmlStream.leafNode(this.tag, { ref });
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (node.name === this.tag) {
      this.model = node.attributes.ref;
      this.criteria = undefined;
      this.namespaceAttributes = Object.fromEntries(
        Object.entries(node.attributes).filter(
          ([key]) => key.startsWith("xmlns:") || key === "mc:Ignorable"
        )
      ) as Record<string, string>;
      this.depth = 0;
      this.writer = undefined;
      return true;
    }
    // Child criteria: capture the whole subtree verbatim.
    if (!this.writer) {
      this.writer = new XmlWriter();
    }
    this.writer.openNode(node.name, node.attributes);
    this.depth += 1;
    return true;
  }

  parseText(text: string): void {
    if (this.writer && this.depth > 0) {
      this.writer.writeText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.depth > 0) {
      this.writer!.closeNode();
      this.depth -= 1;
      return true;
    }
    if (name === this.tag) {
      if (this.writer && typeof this.model === "string" && this.model) {
        this.criteria = {
          ref: this.model,
          xml: this.writer.xml,
          ...(this.namespaceAttributes && Object.keys(this.namespaceAttributes).length > 0
            ? { namespaceAttributes: this.namespaceAttributes }
            : {})
        };
      }
      this.writer = undefined;
      this.namespaceAttributes = undefined;
      return false;
    }
    return true;
  }

  reset(): void {
    super.reset();
    this.depth = 0;
    this.writer = undefined;
    this.criteria = undefined;
    this.namespaceAttributes = undefined;
  }
}

export { AutoFilterXform, resolveAutoFilterRef };
