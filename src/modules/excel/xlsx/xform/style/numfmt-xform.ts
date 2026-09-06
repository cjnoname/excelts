import { defaultNumFormats } from "@excel/xlsx/defaultnumformats";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

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
let _defaultFmtHash: { [key: string]: number } | null = null;
function getDefaultFmtHash(): { [key: string]: number } {
  if (!_defaultFmtHash) {
    _defaultFmtHash = hashDefaultFormats();
  }
  return _defaultFmtHash;
}

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

  render(xmlStream: XmlSink, model: NumFmtModel): void {
    xmlStream.leafNode("numFmt", { numFmtId: model.id, formatCode: model.formatCode });
  }

  parseOpen(node: ParseOpenTag): boolean {
    switch (node.name) {
      case "numFmt":
        this.model = {
          id: parseInt(node.attributes.numFmtId, 10),
          // **The code is kept verbatim, backslashes included.** This stripped every `\x` escape on the way in
          // while `render` writes the code back unchanged — a one-way loss. `\-` became `-`, so the code no
          // longer matched the built-in table (`getDefaultFmtId` looks up the *escaped* form, which is what
          // Excel writes), the format was re-registered as a custom id 164+, and Excel answered
          // `Removed Records: Style from /xl/styles.bin`.
          //
          // A backslash in a number format is an escape for the character after it and is part of the code's
          // meaning, not decoration around it: `\-` is a literal minus sign. Unescaping here also changed what
          // the code *means* to any consumer reading the model.
          formatCode: node.attributes.formatCode
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
    return getDefaultFmtHash()[formatCode];
  }

  static getDefaultFmtCode(numFmtId: number): string | undefined {
    return defaultNumFormats[numFmtId] && defaultNumFormats[numFmtId].f;
  }
}

export { NumFmtXform };
