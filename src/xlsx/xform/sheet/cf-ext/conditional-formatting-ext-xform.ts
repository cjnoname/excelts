import { CompositeXform } from "../../composite-xform.js";
import { SqrefExtXform } from "./sqref-ext-xform.js";
import { CfRuleExtXform } from "./cf-rule-ext-xform.js";

class ConditionalFormattingExtXform extends CompositeXform {
  sqRef: SqrefExtXform;
  cfRule: CfRuleExtXform;

  constructor() {
    super();

    this.map = {
      "xm:sqref": (this.sqRef = new SqrefExtXform()),
      "x14:cfRule": (this.cfRule = new CfRuleExtXform())
    };
  }

  get tag() {
    return "x14:conditionalFormatting";
  }

  prepare(model) {
    model.rules.forEach(rule => {
      this.cfRule.prepare(rule);
    });
  }

  render(xmlStream, model) {
    if (!model.rules.some(CfRuleExtXform.isExt)) {
      return;
    }

    xmlStream.openNode(this.tag, {
      "xmlns:xm": "http://schemas.microsoft.com/office/excel/2006/main"
    });

    model.rules.filter(CfRuleExtXform.isExt).forEach(rule => this.cfRule.render(xmlStream, rule));

    // for some odd reason, Excel needs the <xm:sqref> node to be after the rules
    this.sqRef.render(xmlStream, model.ref);

    xmlStream.closeNode();
  }

  createNewModel() {
    return {
      rules: []
    };
  }

  onParserClose(name, parser) {
    switch (name) {
      case "xm:sqref":
        this.model.ref = parser.model;
        break;

      case "x14:cfRule":
        this.model.rules.push(parser.model);
        break;
    }
  }
}

export { ConditionalFormattingExtXform };
