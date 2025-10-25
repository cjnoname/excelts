import { v4 } from "uuid";
import { BaseXform } from "../../base-xform.js";
import { CompositeXform } from "../../composite-xform.js";
import { DatabarExtXform } from "./databar-ext-xform.js";
import { IconSetExtXform } from "./icon-set-ext-xform.js";

const extIcons = {
  "3Triangles": true,
  "3Stars": true,
  "5Boxes": true
};

class CfRuleExtXform extends CompositeXform {
  databarXform: DatabarExtXform;
  iconSetXform: IconSetExtXform;

  constructor() {
    super();

    this.map = {
      "x14:dataBar": (this.databarXform = new DatabarExtXform()),
      "x14:iconSet": (this.iconSetXform = new IconSetExtXform())
    };
  }

  get tag() {
    return "x14:cfRule";
  }

  static isExt(rule) {
    // is this rule primitive?
    if (rule.type === "dataBar") {
      return DatabarExtXform.isExt(rule);
    }
    if (rule.type === "iconSet") {
      if (rule.custom || extIcons[rule.iconSet]) {
        return true;
      }
    }
    return false;
  }

  prepare(model) {
    if (CfRuleExtXform.isExt(model)) {
      model.x14Id = `{${v4()}}`.toUpperCase();
    }
  }

  render(xmlStream, model) {
    if (!CfRuleExtXform.isExt(model)) {
      return;
    }

    switch (model.type) {
      case "dataBar":
        this.renderDataBar(xmlStream, model);
        break;
      case "iconSet":
        this.renderIconSet(xmlStream, model);
        break;
    }
  }

  renderDataBar(xmlStream, model) {
    xmlStream.openNode(this.tag, {
      type: "dataBar",
      id: model.x14Id
    });

    this.databarXform.render(xmlStream, model);

    xmlStream.closeNode();
  }

  renderIconSet(xmlStream, model) {
    xmlStream.openNode(this.tag, {
      type: "iconSet",
      priority: model.priority,
      id: model.x14Id || `{${v4()}}`
    });

    this.iconSetXform.render(xmlStream, model);

    xmlStream.closeNode();
  }

  createNewModel({ attributes }) {
    return {
      type: attributes.type,
      x14Id: attributes.id,
      priority: BaseXform.toIntValue(attributes.priority)
    };
  }

  onParserClose(name, parser) {
    Object.assign(this.model, parser.model);
  }
}

export { CfRuleExtXform };
