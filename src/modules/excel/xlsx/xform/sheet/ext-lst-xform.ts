import { renderSparklineGroups, parseSparklineGroups } from "@excel/core/sparkline";
import type { SparklineGroup } from "@excel/core/sparkline";
import type { BaseXform } from "@excel/xlsx/xform/base-xform";
import { CompositeXform } from "@excel/xlsx/xform/composite-xform";
import { PreservedSubtreeXform } from "@excel/xlsx/xform/preserved-xml-xform";
import { ConditionalFormattingsExtXform } from "@excel/xlsx/xform/sheet/cf-ext/conditional-formattings-ext-xform";
import type { XmlSink } from "@xml/types";

/** The worksheet `<extLst>` model: conditional-formatting and sparkline extensions. */
interface ExtLstModel {
  conditionalFormattings?: unknown;
  sparklineGroups?: SparklineGroup[];
}

class ExtXform extends CompositeXform {
  declare public map: Record<string, BaseXform>;
  declare public model: ExtLstModel;
  declare private conditionalFormattings: ConditionalFormattingsExtXform;
  declare private sparklineGroups: PreservedSubtreeXform;

  constructor() {
    super();
    this.map = {
      "x14:conditionalFormattings": (this.conditionalFormattings =
        new ConditionalFormattingsExtXform()),
      // **The reader half of the sparkline extension.** Only `x14:conditionalFormattings` was registered here,
      // so a `<x14:sparklineGroups>` child of an `<ext>` reached no xform and was discarded — every sparkline
      // in an XLSX was written correctly and lost on read. `SparklineExtXform.parse` existed and was covered by
      // tests, but nothing in production called it: it takes an XML *string*, and the SAX map dispatches
      // events, so it could not be registered even in principle. It read as a finished feature.
      //
      // Captured as a preserved subtree and handed to the same `parseSparklineGroups` the tests exercise,
      // rather than given a second SAX-based parser. Two parsers for one grammar is how the two drift.
      "x14:sparklineGroups": (this.sparklineGroups = new PreservedSubtreeXform())
    };
  }

  get tag(): string {
    return "ext";
  }

  hasContent(model: ExtLstModel): boolean {
    return this.conditionalFormattings.hasContent(model.conditionalFormattings);
  }

  prepare(model: ExtLstModel): void {
    this.conditionalFormattings.prepare(model.conditionalFormattings);
  }

  render(xmlStream: XmlSink, model: ExtLstModel): void {
    xmlStream.openNode("ext", {
      uri: "{78C0D931-6437-407d-A8EE-F0AAD7539E65}",
      "xmlns:x14": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
    });

    this.conditionalFormattings.render(xmlStream, model.conditionalFormattings);

    xmlStream.closeNode();
  }

  createNewModel(): ExtLstModel {
    return {};
  }

  onParserClose(name: string, parser: BaseXform): void {
    if (name === "x14:sparklineGroups") {
      // The raw subtree, turned into groups by the parser the model already had. An unparseable block leaves
      // the field absent rather than setting an empty array, so "no sparklines" and "sparklines this reader
      // could not understand" stay distinguishable.
      const groups = parseSparklineGroups(String(parser.model ?? ""));
      if (groups.length > 0) {
        this.model.sparklineGroups = groups;
      }
      return;
    }
    (this.model as Record<string, unknown>)[name] = parser.model;
  }
}

/**
 * Lightweight xform for the sparkline extension block.
 * Renders/captures `<ext uri="{05C60535-...}">` containing x14:sparklineGroups.
 */
class SparklineExtXform {
  get tag(): string {
    return "ext";
  }

  hasContent(sparklineGroups: unknown): boolean {
    return Array.isArray(sparklineGroups) && sparklineGroups.length > 0;
  }

  render(xmlStream: XmlSink, sparklineGroups: SparklineGroup[]): void {
    if (!this.hasContent(sparklineGroups)) {
      return;
    }
    // The canonical Microsoft-registered extension uri for
    // `x14:sparklineGroups` is
    //   {05C60535-1F16-4fd2-B633-F4F36F0B64E0}
    // as emitted by Excel 2010 through Excel 365. Earlier
    // revisions of this file used the WRONG uri
    // `{05C60535-1F16-4fd2-B633-F4F36F0041E1}` (a typo that
    // looked plausible but doesn't match any registered
    // extension). Excel's MC processor — which is designed to
    // silently skip unknown extension uris — dropped the whole
    // `<ext>` element on load, erasing every sparkline the
    // workbook defined. Verified against a Microsoft Excel 2021
    // sparkline reference (`tmp/ccccc.xlsx`); switching to the
    // correct uri restored sparkline rendering.
    xmlStream.openNode("ext", {
      uri: "{05C60535-1F16-4fd2-B633-F4F36F0B64E0}",
      "xmlns:x14": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
    });
    xmlStream.writeRaw(renderSparklineGroups(sparklineGroups));
    xmlStream.closeNode();
  }

  parse(xml: string): SparklineGroup[] {
    return parseSparklineGroups(xml);
  }
}

class ExtLstXform extends CompositeXform {
  declare public map: Record<string, BaseXform>;
  declare public model: ExtLstModel;
  declare private ext: ExtXform;
  declare private sparklineExt: SparklineExtXform;

  constructor() {
    super();
    this.sparklineExt = new SparklineExtXform();

    this.map = {
      ext: (this.ext = new ExtXform())
    };
  }

  get tag(): string {
    return "extLst";
  }

  prepare(model: ExtLstModel, _options?: unknown): void {
    this.ext.prepare(model);
  }

  hasContent(model: ExtLstModel): boolean {
    return this.ext.hasContent(model) || this.sparklineExt.hasContent(model?.sparklineGroups);
  }

  render(xmlStream: XmlSink, model: ExtLstModel): void {
    if (!this.hasContent(model)) {
      return;
    }

    xmlStream.openNode("extLst");
    if (this.ext.hasContent(model)) {
      this.ext.render(xmlStream, model);
    }
    if (this.sparklineExt.hasContent(model?.sparklineGroups)) {
      this.sparklineExt.render(xmlStream, model.sparklineGroups!);
    }
    xmlStream.closeNode();
  }

  createNewModel(): ExtLstModel {
    return {};
  }

  onParserClose(_name: string, parser: BaseXform): void {
    // **Merged, not keyed by the child's tag.** Every child here is an `<ext>`, so keying by `_name` put each
    // one at `model.ext` — which meant two things at once: the extension names never appeared at this level,
    // and a second `<ext>` sibling overwrote the first. `worksheet-xform` reads
    // `extLst.model["x14:conditionalFormattings"]`, so that lookup had always been `undefined` and the
    // conditional-formatting extension block was parsed and discarded exactly like the sparkline one; and a
    // worksheet carrying both extensions kept whichever came last. Merging the child's own keys upward makes
    // the level report what it contains rather than how it was nested, and is what makes both lookups work.
    Object.assign(this.model as Record<string, unknown>, parser.model);
  }
}

export { ExtLstXform };
