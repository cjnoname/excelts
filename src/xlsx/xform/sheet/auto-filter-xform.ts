import { colCache } from "../../../utils/col-cache.js";
import { BaseXform } from "../base-xform.js";

class AutoFilterXform extends BaseXform {
  declare public model: any;

  get tag(): string {
    return "autoFilter";
  }

  render(xmlStream: any, model: any): void {
    if (model) {
      if (typeof model === "string") {
        // assume range
        xmlStream.leafNode("autoFilter", { ref: model });
      } else {
        const getAddress = function (addr: any): string {
          if (typeof addr === "string") {
            return addr;
          }
          return colCache.getAddress(addr.row, addr.column).address;
        };

        const firstAddress = getAddress(model.from);
        const secondAddress = getAddress(model.to);
        if (firstAddress && secondAddress) {
          xmlStream.leafNode("autoFilter", { ref: `${firstAddress}:${secondAddress}` });
        }
      }
    }
  }

  parseOpen(node: any): void {
    if (node.name === "autoFilter") {
      this.model = node.attributes.ref;
    }
  }
}

export { AutoFilterXform };
