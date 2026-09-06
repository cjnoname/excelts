import type {
  Color,
  ConditionalFormattingOptions,
  ConditionalFormattingRule,
  Style
} from "@excel/types";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { ConditionalFormattingXform } from "@excel/xlsx/xform/sheet/cf/conditional-formatting-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

/** A CF rule as carried through (de)serialisation: it gains a transient dxfId. */
type SerializedCfRule = ConditionalFormattingRule & {
  dxfId?: number;
  cfvo?: { type: string }[];
  color?: Partial<Color>;
};

/** The style-manager surface the CF xform needs from the shared writer options. */
interface CfStyleManager {
  addDxfStyle(style: Partial<Style>): number;
  getDxfStyle(id: number): Partial<Style> | undefined;
}
interface CfPrepareOptions {
  styles: object;
}

class ConditionalFormattingsXform extends BaseXform<ConditionalFormattingOptions[]> {
  cfXform: ConditionalFormattingXform;
  parser?: BaseXform;

  constructor() {
    super();

    this.cfXform = new ConditionalFormattingXform();
  }

  get tag(): string {
    return "conditionalFormatting";
  }

  reset(): void {
    this.model = [];
  }

  prepare(model: ConditionalFormattingOptions[], options: CfPrepareOptions): void {
    const styles = options.styles as CfStyleManager;
    // ensure each rule has a priority value
    let nextPriority = model.reduce(
      (p: number, cf) => Math.max(p, ...cf.rules.map(rule => rule.priority ?? 0)),
      1
    );
    model.forEach(cf => {
      cf.rules.forEach(ruleModel => {
        const rule = ruleModel as SerializedCfRule;
        if (!rule.priority) {
          rule.priority = nextPriority++;
        }

        if (rule.style) {
          rule.dxfId = styles.addDxfStyle(rule.style);
        }

        // Ensure dataBar rules have required cfvo and color properties
        if (rule.type === "dataBar") {
          if (!rule.cfvo || rule.cfvo.length < 2) {
            rule.cfvo = [{ type: "min" }, { type: "max" }];
          }
          if (!rule.color) {
            // An empty colour *is* the automatic colour: `ColorXform` writes `auto="1"` when no rgb, theme or
            // indexed value is present, and `encodeColor(undefined)` produces the same thing in BIFF12.
            rule.color = {};
          }
          // **A missing colour becomes the *automatic* colour, and it used to become a concrete blue.**
          //
          // `color` is required by `CT_DataBar`, so something has to be written — the first attempt at this fix removed
          // the fill-in entirely and produced a bar with no colour element at all. What goes there is the question, and
          // the comment here used to answer it with `FF638EC6`, "same as Excel's default". That is the colour Excel's
          // *UI* offers when you create a data bar; it is not what Excel writes for a bar that has none of its own. The
          // reference file for the oracle's `03-conditional-formats` carries `<color auto="1"/>`, and Excel's binary
          // save of it carries the automatic colour rather than any RGB.
          //
          // The difference matters beyond one file: substituting a concrete blue turns "let the application choose"
          // into a choice, and that choice then survives every round trip and every container change.
        }
      });
    });
  }

  render(xmlStream: XmlSink, model?: ConditionalFormattingOptions[]): void {
    (model ?? []).forEach(cf => {
      this.cfXform.render(xmlStream, cf);
    });
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }

    switch (node.name) {
      case "conditionalFormatting":
        this.parser = this.cfXform;
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
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.model!.push(this.parser.model as ConditionalFormattingOptions);
        this.parser = undefined;
        return false;
      }
      return true;
    }
    return false;
  }

  reconcile(model: ConditionalFormattingOptions[], options: CfPrepareOptions): void {
    const styles = options.styles as CfStyleManager;
    model.forEach(cf => {
      cf.rules.forEach(ruleModel => {
        const rule = ruleModel as SerializedCfRule;
        if (rule.dxfId !== undefined) {
          rule.style = styles.getDxfStyle(rule.dxfId);
          delete rule.dxfId;
        }
      });
    });
  }
}

export { ConditionalFormattingsXform };
