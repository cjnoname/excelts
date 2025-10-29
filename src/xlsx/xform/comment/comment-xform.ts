import { RichTextXform } from "../strings/rich-text-xform.js";
import { BaseXform } from "../base-xform.js";

interface NoteText {
  font?: any;
  text: string;
}

interface CommentNote {
  texts: NoteText[];
}

interface CommentModel {
  type: string;
  note: CommentNote;
  ref: string;
  authorId?: number;
}

class CommentXform extends BaseXform {
  declare public model: CommentModel;
  declare public parser: any;
  declare private _richTextXform?: RichTextXform;

  constructor(model?: CommentModel) {
    super();
    this.model = model || { type: "note", note: { texts: [] }, ref: "" };
  }

  get tag(): string {
    return "r";
  }

  get richTextXform(): RichTextXform {
    if (!this._richTextXform) {
      this._richTextXform = new RichTextXform();
    }
    return this._richTextXform;
  }

  render(xmlStream: any, model?: CommentModel): void {
    const renderModel = model || this.model;

    xmlStream.openNode("comment", {
      ref: renderModel.ref,
      authorId: 0
    });
    xmlStream.openNode("text");
    if (renderModel && renderModel.note && renderModel.note.texts) {
      renderModel.note.texts.forEach(text => {
        this.richTextXform.render(xmlStream, text);
      });
    }
    xmlStream.closeNode();
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "comment":
        this.model = {
          type: "note",
          note: {
            texts: []
          },
          ...node.attributes
        };
        return true;
      case "r":
        this.parser = this.richTextXform;
        this.parser.parseOpen(node);
        return true;
      default:
        return false;
    }
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    switch (name) {
      case "comment":
        return false;
      case "r":
        this.model.note.texts.push(this.parser.model);
        this.parser = undefined;
        return true;
      default:
        if (this.parser) {
          this.parser.parseClose(name);
        }
        return true;
    }
  }
}

export { CommentXform };
