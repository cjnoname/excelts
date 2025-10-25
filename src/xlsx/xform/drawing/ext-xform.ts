import { BaseXform } from "../base-xform.js";

/** https://en.wikipedia.org/wiki/Office_Open_XML_file_formats#DrawingML */
const EMU_PER_PIXEL_AT_96_DPI = 9525;

interface ExtModel {
  width: number;
  height: number;
}

class ExtXform extends BaseXform {
  declare private tag: string;
  declare public map: { [key: string]: any };
  declare public model: ExtModel;

  constructor(options: { tag: string }) {
    super();

    this.tag = options.tag;
    this.map = {};
    this.model = { width: 0, height: 0 };
  }

  render(xmlStream: any, model: ExtModel): void {
    xmlStream.openNode(this.tag);

    const width = Math.floor(model.width * EMU_PER_PIXEL_AT_96_DPI);
    const height = Math.floor(model.height * EMU_PER_PIXEL_AT_96_DPI);

    xmlStream.addAttribute("cx", width);
    xmlStream.addAttribute("cy", height);

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (node.name === this.tag) {
      this.model = {
        width: parseInt(node.attributes.cx || "0", 10) / EMU_PER_PIXEL_AT_96_DPI,
        height: parseInt(node.attributes.cy || "0", 10) / EMU_PER_PIXEL_AT_96_DPI
      };
      return true;
    }
    return false;
  }

  parseText(_text?: string): void {}

  parseClose(_name?: string): boolean {
    return false;
  }
}

export { ExtXform };
