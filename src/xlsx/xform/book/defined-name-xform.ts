import { BaseXform } from "../base-xform.js";
import { colCache } from "../../../utils/col-cache.js";

interface DefinedNameModel {
  name: string;
  ranges: string[];
  localSheetId?: number;
}

class DefinedNamesXform extends BaseXform {
  declare private _parsedName?: string;
  declare private _parsedLocalSheetId?: string;
  declare private _parsedText: string[];

  constructor() {
    super();
    this._parsedText = [];
  }

  render(xmlStream: any, model: DefinedNameModel): void {
    // <definedNames>
    //   <definedName name="name">name.ranges.join(',')</definedName>
    //   <definedName name="_xlnm.Print_Area" localSheetId="0">name.ranges.join(',')</definedName>
    // </definedNames>
    xmlStream.openNode("definedName", {
      name: model.name,
      localSheetId: model.localSheetId
    });
    xmlStream.writeText(model.ranges.join(","));
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case "definedName":
        this._parsedName = node.attributes.name;
        this._parsedLocalSheetId = node.attributes.localSheetId;
        this._parsedText = [];
        return true;
      default:
        return false;
    }
  }

  parseText(text: string): void {
    this._parsedText.push(text);
  }

  parseClose(): boolean {
    this.model = {
      name: this._parsedName!,
      ranges: extractRanges(this._parsedText.join(""))
    };
    if (this._parsedLocalSheetId !== undefined) {
      this.model.localSheetId = parseInt(this._parsedLocalSheetId, 10);
    }
    return false;
  }
}

function isValidRange(range: string): boolean {
  try {
    colCache.decodeEx(range);
    return true;
  } catch {
    return false;
  }
}

function extractRanges(parsedText: string): string[] {
  const ranges: string[] = [];
  let quotesOpened = false;
  let last = "";
  parsedText.split(",").forEach(item => {
    if (!item) {
      return;
    }
    const quotes = (item.match(/'/g) || []).length;

    if (!quotes) {
      if (quotesOpened) {
        last += `${item},`;
      } else if (isValidRange(item)) {
        ranges.push(item);
      }
      return;
    }
    const quotesEven = quotes % 2 === 0;

    if (!quotesOpened && quotesEven && isValidRange(item)) {
      ranges.push(item);
    } else if (quotesOpened && !quotesEven) {
      quotesOpened = false;
      if (isValidRange(last + item)) {
        ranges.push(last + item);
      }
      last = "";
    } else {
      quotesOpened = true;
      last += `${item},`;
    }
  });
  return ranges;
}

export { DefinedNamesXform };
