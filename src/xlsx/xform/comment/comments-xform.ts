import { XmlStream } from "../../../utils/xml-stream.js";
import { BaseXform } from "../base-xform.js";
import { CommentXform } from "./comment-xform.js";

interface CommentsModel {
  comments: any[];
}

class CommentsXform extends BaseXform {
  declare public map: { [key: string]: CommentXform };
  declare public parser: any;
  declare public model: CommentsModel;

  constructor() {
    super();
    this.map = {
      comment: new CommentXform()
    };
    this.model = { comments: [] };
  }

  render(xmlStream: any, model?: CommentsModel): void {
    const renderModel = model || this.model;
    xmlStream.openXml(XmlStream.StdDocAttributes);
    xmlStream.openNode("comments", CommentsXform.COMMENTS_ATTRIBUTES);

    // authors
    // TODO: support authors properly
    xmlStream.openNode("authors");
    xmlStream.leafNode("author", null, "Author");
    xmlStream.closeNode();

    // comments
    xmlStream.openNode("commentList");
    renderModel.comments.forEach(comment => {
      this.map.comment.render(xmlStream, comment);
    });
    xmlStream.closeNode();
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "commentList":
        this.model = {
          comments: []
        };
        return true;
      case "comment":
        this.parser = this.map.comment;
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
      case "commentList":
        return false;
      case "comment":
        this.model.comments.push(this.parser.model);
        this.parser = undefined;
        return true;
      default:
        if (this.parser) {
          this.parser.parseClose(name);
        }
        return true;
    }
  }

  static COMMENTS_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  };
}

export { CommentsXform };
