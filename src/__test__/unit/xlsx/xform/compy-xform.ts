import { BaseXform } from "../../../../xlsx/xform/base-xform.js";

interface CompyXformOptions {
  tag: string;
  attrs?: any;
  children: Array<{
    name?: string;
    tag?: string;
    xform: any;
  }>;
}

class CompyXform extends BaseXform {
  declare public tag: string;
  declare public attrs?: any;
  declare public children: Array<{ name: string; tag: string; xform: any }>;
  declare public parser?: { name: string; tag: string; xform: any };
  declare public model: any;

  constructor(options: CompyXformOptions) {
    super();

    this.tag = options.tag;
    this.attrs = options.attrs;
    this.children = options.children as any;
    this.map = this.children.reduce((map: any, child: any) => {
      const name = child.name || child.tag;
      const tag = child.tag || child.name;
      map[tag] = child;
      child.name = name;
      child.tag = tag;
      return map;
    }, {});
  }

  prepare(model: any, options?: any) {
    this.children.forEach(child => {
      child.xform.prepare(model[child.tag], options);
    });
  }

  render(xmlStream: any, model: any) {
    xmlStream.openNode(this.tag, this.attrs);
    this.children.forEach(child => {
      child.xform.render(xmlStream, model[child.name]);
    });
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.xform.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case this.tag:
        this.model = {};
        return true;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.xform.parseOpen(node);
          return true;
        }
    }
    return false;
  }

  parseText(text: string) {
    if (this.parser) {
      this.parser.xform.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.xform.parseClose(name)) {
        this.model[this.parser.name] = this.parser.xform.model;
        this.parser = undefined;
      }
      return true;
    }
    return false;
  }

  reconcile(model: any, options?: any) {
    this.children.forEach(child => {
      child.xform.prepare(model[child.tag], options);
    });
  }
}

export { CompyXform };
