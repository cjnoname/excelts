import { CompositeXform } from "../../composite-xform.js";
import { CfRuleXform } from "./cf-rule-xform.js";

class ConditionalFormattingXform extends CompositeXform {
  constructor() {
    super();

    this.map = {
      cfRule: new CfRuleXform()
    };
  }

  get tag(): string {
    return "conditionalFormatting";
  }

  render(xmlStream: any, model: any): void {
    // if there are no primitive rules, exit now
    if (!model.rules.some(CfRuleXform.isPrimitive)) {
      return;
    }

    xmlStream.openNode(this.tag, { sqref: model.ref });

    model.rules.forEach((rule: any) => {
      if (CfRuleXform.isPrimitive(rule)) {
        rule.ref = model.ref;
        this.map.cfRule.render(xmlStream, rule);
      }
    });

    xmlStream.closeNode();
  }

  createNewModel({ attributes }: any): any {
    return {
      ref: attributes.sqref,
      rules: []
    };
  }

  onParserClose(name: string, parser: any): void {
    this.model.rules.push(parser.model);
  }
}

export { ConditionalFormattingXform };
