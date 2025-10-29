import { defaultNumFormats } from "../../defaultnumformats.js";
import { BaseXform } from "../base-xform.js";

interface NumFmtModel {
  id: number;
  formatCode: string;
}

function hashDefaultFormats(): { [key: string]: number } {
  const hash: { [key: string]: number } = {};
  Object.entries(defaultNumFormats).forEach(([id, dnf]) => {
    if (dnf.f) {
      hash[dnf.f] = parseInt(id, 10);
    }
    // at some point, add the other cultures here...
  });
  return hash;
}
const defaultFmtHash = hashDefaultFormats();

// NumFmt encapsulates translation between number format and xlsx
class NumFmtXform extends BaseXform {
  declare private id?: number;
  declare private formatCode?: string;

  constructor(id?: number, formatCode?: string) {
    super();

    this.id = id;
    this.formatCode = formatCode;
  }

  get tag(): string {
    return "numFmt";
  }

  render(xmlStream: any, model: NumFmtModel): void {
    xmlStream.leafNode("numFmt", { numFmtId: model.id, formatCode: model.formatCode });
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case "numFmt":
        this.model = {
          id: parseInt(node.attributes.numFmtId, 10),
          formatCode: node.attributes.formatCode.replace(/[\\](.)/g, "$1")
        };
        return true;
      default:
        return false;
    }
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }

  static getDefaultFmtId(formatCode: string): number | undefined {
    return defaultFmtHash[formatCode];
  }

  static getDefaultFmtCode(numFmtId: number): string | undefined {
    return defaultNumFormats[numFmtId] && defaultNumFormats[numFmtId].f;
  }
}

export { NumFmtXform };
