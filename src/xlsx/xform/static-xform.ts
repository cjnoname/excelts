import { BaseXform } from "./base-xform.js";
import { XmlStream } from "../../utils/xml-stream.js";

interface StaticModel {
  tag: string;
  $?: any;
  c?: StaticModel[];
  t?: string;
}

// const model = {
//   tag: 'name',
//   $: {attr: 'value'},
//   c: [
//     { tag: 'child' }
//   ],
//   t: 'some text'
// };

function build(xmlStream: any, model: StaticModel): void {
  xmlStream.openNode(model.tag, model.$);
  if (model.c) {
    model.c.forEach(child => {
      build(xmlStream, child);
    });
  }
  if (model.t) {
    xmlStream.writeText(model.t);
  }
  xmlStream.closeNode();
}

class StaticXform extends BaseXform {
  declare private _model: StaticModel;
  declare private _xml?: string;

  constructor(model: StaticModel) {
    super();

    // This class is an optimisation for static (unimportant and unchanging) xml
    // It is stateless - apart from its static model and so can be used as a singleton
    // Being stateless - it will only track entry to and exit from it's root xml tag during parsing and nothing else
    // Known issues:
    //    since stateless - parseOpen always returns true. Parent xform must know when to start using this xform
    //    if the root tag is recursive, the parsing will behave unpredictably
    this._model = model;
  }

  render(xmlStream: any): void {
    if (!this._xml) {
      const stream = new XmlStream();
      build(stream, this._model);
      this._xml = stream.xml;
    }
    xmlStream.writeXml(this._xml);
  }

  parseOpen(): boolean {
    return true;
  }

  parseText(): void {}

  parseClose(name: string): boolean {
    switch (name) {
      case this._model.tag:
        return false;
      default:
        return true;
    }
  }
}

export { StaticXform };
