import { colCache } from "../utils/col-cache.js";
import { Anchor } from "./anchor.js";

interface ImageHyperlinks {
  [key: string]: any;
}

interface ImageExt {
  width?: number;
  height?: number;
}

interface ImageRange {
  tl: Anchor;
  br?: Anchor;
  ext?: ImageExt;
  editAs?: string;
  hyperlinks?: ImageHyperlinks;
}

interface BackgroundModel {
  type: "background";
  imageId: string;
}

interface ImageModel {
  type: "image";
  imageId: string;
  hyperlinks?: ImageHyperlinks;
  range: {
    tl: any;
    br?: any;
    ext?: ImageExt;
    editAs?: string;
  };
}

type Model = BackgroundModel | ImageModel;

interface ModelInput {
  type: string;
  imageId: string;
  range?: string | any;
  hyperlinks?: ImageHyperlinks;
}

class Image {
  worksheet: any;
  type?: string;
  imageId?: string;
  range?: ImageRange;

  constructor(worksheet: any, model?: ModelInput) {
    this.worksheet = worksheet;
    if (model) {
      this.model = model;
    }
  }

  get model(): Model {
    switch (this.type) {
      case "background":
        return {
          type: this.type,
          imageId: this.imageId!
        };
      case "image":
        return {
          type: this.type,
          imageId: this.imageId!,
          hyperlinks: this.range!.hyperlinks,
          range: {
            tl: this.range!.tl.model,
            br: this.range!.br && this.range!.br.model,
            ext: this.range!.ext,
            editAs: this.range!.editAs
          }
        };
      default:
        throw new Error("Invalid Image Type");
    }
  }

  set model({ type, imageId, range, hyperlinks }: ModelInput) {
    this.type = type;
    this.imageId = imageId;

    if (type === "image") {
      if (typeof range === "string") {
        const decoded = colCache.decode(range) as any;
        this.range = {
          tl: new Anchor(this.worksheet, { col: decoded.left, row: decoded.top }, -1),
          br: new Anchor(this.worksheet, { col: decoded.right, row: decoded.bottom }, 0),
          editAs: "oneCell"
        };
      } else {
        this.range = {
          tl: new Anchor(this.worksheet, range.tl, 0),
          br: range.br && new Anchor(this.worksheet, range.br, 0),
          ext: range.ext,
          editAs: range.editAs,
          hyperlinks: hyperlinks || range.hyperlinks
        };
      }
    }
  }
}

export { Image };
