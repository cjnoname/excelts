import type { Color } from "@excel/types";
import { inferFontCharset } from "@excel/utils/font-charset";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { BooleanXform } from "@excel/xlsx/xform/simple/boolean-xform";
import { IntegerXform } from "@excel/xlsx/xform/simple/integer-xform";
import { StringXform } from "@excel/xlsx/xform/simple/string-xform";
import { ColorXform } from "@excel/xlsx/xform/style/color-xform";
import { UnderlineXform } from "@excel/xlsx/xform/style/underline-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

interface FontModel {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean | string;
  charset?: number;
  color?: Partial<Color>;
  condense?: boolean;
  extend?: boolean;
  family?: number;
  outline?: boolean;
  vertAlign?: string;
  scheme?: string;
  shadow?: boolean;
  strike?: boolean;
  size?: number;
  name?: string;
}

interface FontOptions {
  tagName: string;
  fontNameTag: string;
}

// Font encapsulates translation from font model to xlsx
class FontXform extends BaseXform {
  declare private options: FontOptions;
  declare public parser?: BaseXform;
  declare private renderOrder: string[];

  constructor(options?: FontOptions) {
    super();

    this.options = options || FontXform.OPTIONS;

    // Define properties in render order (Excel's expected order)
    const fontProperties = [
      { tag: "b", prop: "bold", xform: new BooleanXform({ tag: "b", attr: "val" }) },
      { tag: "i", prop: "italic", xform: new BooleanXform({ tag: "i", attr: "val" }) },
      { tag: "u", prop: "underline", xform: new UnderlineXform() },
      { tag: "strike", prop: "strike", xform: new BooleanXform({ tag: "strike", attr: "val" }) },
      {
        tag: "condense",
        prop: "condense",
        xform: new BooleanXform({ tag: "condense", attr: "val" })
      },
      { tag: "extend", prop: "extend", xform: new BooleanXform({ tag: "extend", attr: "val" }) },
      { tag: "outline", prop: "outline", xform: new BooleanXform({ tag: "outline", attr: "val" }) },
      { tag: "shadow", prop: "shadow", xform: new BooleanXform({ tag: "shadow", attr: "val" }) },
      { tag: "sz", prop: "size", xform: new IntegerXform({ tag: "sz", attr: "val" }) },
      { tag: "color", prop: "color", xform: new ColorXform() },
      {
        tag: this.options.fontNameTag,
        prop: "name",
        xform: new StringXform({ tag: this.options.fontNameTag, attr: "val" })
      },
      { tag: "family", prop: "family", xform: new IntegerXform({ tag: "family", attr: "val" }) },
      { tag: "scheme", prop: "scheme", xform: new StringXform({ tag: "scheme", attr: "val" }) },
      { tag: "charset", prop: "charset", xform: new IntegerXform({ tag: "charset", attr: "val" }) },
      {
        tag: "vertAlign",
        prop: "vertAlign",
        xform: new StringXform({ tag: "vertAlign", attr: "val" })
      }
    ];

    // Build map and renderOrder from single source of truth
    this.map = Object.fromEntries(
      fontProperties.map(p => [p.tag, { prop: p.prop, xform: p.xform }])
    );
    this.renderOrder = fontProperties.map(p => p.tag);
  }

  get tag(): string {
    return this.options.tagName;
  }

  render(xmlStream: XmlSink, model: FontModel): void {
    const { map, renderOrder } = this;

    // `<charset>` declares that a `<font>` is an East Asian face, and a consumer
    // uses it to substitute another East Asian face rather than a Latin one. Excel
    // always writes it — a Chinese Windows Excel stores
    // `name="等线" charset="134"` — while documonster only ever emitted one that
    // had been read back from a file, so a workbook authored from scratch
    // described 宋体 exactly as it described Calibri.
    //
    // This is applied to every font, including one that arrived without a charset
    // in a file someone else wrote. Two attempts to exempt those failed, and the
    // second failure is the more interesting one:
    //
    //  - An instance flag set by `parseOpen` could not work, because a workbook is
    //    parsed by one `StylesXform` and serialised by another.
    //  - Marking the parsed *model* could not work either: `StylesXform._addFont`
    //    re-serialises from the cell's own `font` object, which the style resolver
    //    built afresh, so nothing attached to the parsed model survives to the
    //    write. Carrying provenance through would mean threading it along the whole
    //    parse → style → cell → write chain.
    //
    // That work is not worth doing, because the exemption was protecting the wrong
    // thing. `charset="134"` on SimSun is not damage — it is the same value Excel
    // itself writes for that face, so supplying it makes the output *more*
    // faithful to the format, not less. Byte-identical round-tripping is already
    // not a property of this writer (it also adds `x14ac:knownFonts` and
    // normalises element order), and a charset that contradicted the font would be
    // a real bug, which is why `inferFontCharset` returns nothing for pan-CJK
    // families rather than guessing a region.
    const effective =
      model.charset === undefined && model.name !== undefined
        ? { ...model, charset: inferFontCharset(model.name) }
        : model;

    xmlStream.openNode(this.options.tagName);
    renderOrder.forEach(tag => {
      map![tag].xform.render(xmlStream, effective[map![tag].prop as keyof FontModel]);
    });
    xmlStream.closeNode();
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    if (this.map![node.name]) {
      const parser = this.map![node.name].xform;
      this.parser = parser;
      // The child xform reports whether it consumed the node (void → false).
      return parser.parseOpen(node) ?? false;
    }
    switch (node.name) {
      case this.options.tagName:
        this.model = {};
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
    if (this.parser && !this.parser.parseClose(name)) {
      const item = this.map![name];
      if (this.parser.model) {
        this.model[item.prop] = this.parser.model;
      }
      this.parser = undefined;
      return true;
    }
    switch (name) {
      case this.options.tagName:
        return false;
      default:
        return true;
    }
  }

  static OPTIONS: FontOptions = {
    tagName: "font",
    fontNameTag: "name"
  };
}

export { FontXform };
