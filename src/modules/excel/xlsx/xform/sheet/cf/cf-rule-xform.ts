// The derived formulas live in `core/conditional-formula.ts` so the XLSB writer can reach them too — it
// emitted these rules with no formula at all while this one had them, which is a rule that never fires.
import {
  textRuleFormula as getTextFormula,
  timePeriodRuleFormula as getTimePeriodFormula
} from "@excel/core/conditional-formula";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { CompositeXform } from "@excel/xlsx/xform/composite-xform";
import { ColorScaleXform } from "@excel/xlsx/xform/sheet/cf/color-scale-xform";
import { DatabarXform } from "@excel/xlsx/xform/sheet/cf/databar-xform";
import { ExtLstRefXform } from "@excel/xlsx/xform/sheet/cf/ext-lst-ref-xform";
import { FormulaXform } from "@excel/xlsx/xform/sheet/cf/formula-xform";
import { IconSetXform } from "@excel/xlsx/xform/sheet/cf/icon-set-xform";
import type { ParseOpenTag } from "@xml/types";

const extIcons = {
  "3Triangles": true,
  "3Stars": true,
  "5Boxes": true
};

function opType(attributes) {
  const { type, operator } = attributes;
  switch (type) {
    case "containsText":
    case "containsBlanks":
    case "notContainsBlanks":
    case "containsErrors":
    case "notContainsErrors":
      return {
        type: "containsText",
        operator: type
      };

    default:
      return { type, operator };
  }
}

class CfRuleXform extends CompositeXform {
  databarXform: DatabarXform;
  extLstRefXform: ExtLstRefXform;
  formulaXform: FormulaXform;
  colorScaleXform: ColorScaleXform;
  iconSetXform: IconSetXform;

  constructor() {
    super();

    this.map = {
      dataBar: (this.databarXform = new DatabarXform()),
      extLst: (this.extLstRefXform = new ExtLstRefXform()),
      formula: (this.formulaXform = new FormulaXform()),
      colorScale: (this.colorScaleXform = new ColorScaleXform()),
      iconSet: (this.iconSetXform = new IconSetXform())
    };
  }

  get tag() {
    return "cfRule";
  }

  static isPrimitive(rule) {
    // is this rule primitive?
    if (rule.type === "iconSet") {
      if (rule.custom || extIcons[rule.iconSet]) {
        return false;
      }
    }
    return true;
  }

  render(xmlStream, model) {
    switch (model.type) {
      case "expression":
        this.renderExpression(xmlStream, model);
        break;
      case "cellIs":
        this.renderCellIs(xmlStream, model);
        break;
      case "top10":
        this.renderTop10(xmlStream, model);
        break;
      case "aboveAverage":
        this.renderAboveAverage(xmlStream, model);
        break;
      case "dataBar":
        this.renderDataBar(xmlStream, model);
        break;
      case "colorScale":
        this.renderColorScale(xmlStream, model);
        break;
      case "iconSet":
        this.renderIconSet(xmlStream, model);
        break;
      case "containsText":
        this.renderText(xmlStream, model);
        break;
      case "timePeriod":
        this.renderTimePeriod(xmlStream, model);
        break;
    }
  }

  renderExpression(xmlStream, model) {
    xmlStream.openNode(this.tag, {
      type: "expression",
      dxfId: model.dxfId,
      priority: model.priority
    });

    this.formulaXform.render(xmlStream, model.formulae[0]);

    xmlStream.closeNode();
  }

  renderCellIs(xmlStream, model) {
    xmlStream.openNode(this.tag, {
      type: "cellIs",
      dxfId: model.dxfId,
      priority: model.priority,
      operator: model.operator
    });

    model.formulae.forEach(formula => {
      this.formulaXform.render(xmlStream, formula);
    });

    xmlStream.closeNode();
  }

  renderTop10(xmlStream, model) {
    xmlStream.leafNode(this.tag, {
      type: "top10",
      dxfId: model.dxfId,
      priority: model.priority,
      percent: BaseXform.toBoolAttribute(model.percent, false),
      bottom: BaseXform.toBoolAttribute(model.bottom, false),
      rank: BaseXform.toIntValue(model.rank, 10)
    });
  }

  renderAboveAverage(xmlStream, model) {
    xmlStream.leafNode(this.tag, {
      type: "aboveAverage",
      dxfId: model.dxfId,
      priority: model.priority,
      aboveAverage: BaseXform.toBoolAttribute(model.aboveAverage, true)
    });
  }

  renderDataBar(xmlStream, model) {
    xmlStream.openNode(this.tag, {
      type: "dataBar",
      priority: model.priority
    });

    this.databarXform.render(xmlStream, model);
    this.extLstRefXform.render(xmlStream, model);

    xmlStream.closeNode();
  }

  renderColorScale(xmlStream, model) {
    xmlStream.openNode(this.tag, {
      type: "colorScale",
      priority: model.priority
    });

    this.colorScaleXform.render(xmlStream, model);

    xmlStream.closeNode();
  }

  renderIconSet(xmlStream, model) {
    // iconset is all primitive or all extLst
    if (!CfRuleXform.isPrimitive(model)) {
      return;
    }

    xmlStream.openNode(this.tag, {
      type: "iconSet",
      priority: model.priority
    });

    this.iconSetXform.render(xmlStream, model);

    xmlStream.closeNode();
  }

  renderText(xmlStream, model) {
    // Per ECMA-376 (CT_CfRule / ST_ConditionalFormattingOperator), only the
    // genuine `type="containsText"` rule carries an `operator` attribute, and
    // its sole valid value there is "containsText". The four sibling rule
    // types this xform collapses onto the same `renderText` path —
    // containsBlanks / notContainsBlanks / containsErrors / notContainsErrors
    // (see `opType()`) — never take an operator. Emitting one unconditionally
    // produced invalid markup like `type="containsBlanks" operator="containsBlanks"`,
    // where "containsBlanks" is not a member of the operator enum, which made
    // strict readers reject the whole worksheet.
    const ruleType = model.operator;
    const carriesText = ruleType === "containsText" || ruleType === "notContainsText";
    xmlStream.openNode(this.tag, {
      type: ruleType,
      dxfId: model.dxfId,
      priority: model.priority,
      operator: ruleType === "containsText" ? "containsText" : undefined,
      // **The search string itself.** CT_CfRule carries it on `text`; the `<formula>` written below is the
      // *evaluation* of the rule, not its statement, and Excel reads the attribute rather than the formula.
      // Omitting it made Excel discard the rule outright — converting a workbook written here to XLSB kept
      // four of five rules and dropped this one — so the rule looked fine in this library and did not exist
      // once Excel had seen it.
      //
      // Only the two "contains text" spellings have a string; the blanks and errors variants share this path
      // (see `opType`) and have none.
      text: carriesText ? model.text : undefined
    });

    const formula = getTextFormula(model);
    if (formula) {
      this.formulaXform.render(xmlStream, formula);
    }

    xmlStream.closeNode();
  }

  renderTimePeriod(xmlStream, model) {
    xmlStream.openNode(this.tag, {
      type: "timePeriod",
      dxfId: model.dxfId,
      priority: model.priority,
      timePeriod: model.timePeriod
    });

    const formula = getTimePeriodFormula(model);
    if (formula) {
      this.formulaXform.render(xmlStream, formula);
    }

    xmlStream.closeNode();
  }

  createNewModel({ attributes }: ParseOpenTag) {
    return {
      ...opType(attributes),
      dxfId: BaseXform.toIntValue(attributes.dxfId),
      priority: BaseXform.toIntValue(attributes.priority),
      timePeriod: attributes.timePeriod,
      percent: BaseXform.toBoolValue(attributes.percent),
      bottom: BaseXform.toBoolValue(attributes.bottom),
      rank: BaseXform.toIntValue(attributes.rank),
      aboveAverage: BaseXform.toBoolValue(attributes.aboveAverage)
    };
  }

  onParserClose(name, parser) {
    switch (name) {
      case "dataBar":
      case "extLst":
      case "colorScale":
      case "iconSet":
        // merge parser model with ours
        Object.assign(this.model, parser.model);
        break;

      case "formula":
        // except - formula is a string and appends to formulae
        this.model.formulae = this.model.formulae ?? [];
        this.model.formulae.push(parser.model);
        break;
    }
  }
}

export { CfRuleXform };
