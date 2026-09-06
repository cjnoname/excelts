import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

interface CalcPropertiesModel {
  fullCalcOnLoad?: boolean;
  iterate?: boolean;
  iterateCount?: number;
  iterateDelta?: number;
}

/**
 * `<calcPr>` — how the consumer should recalculate.
 *
 * ## Why `fullCalcOnLoad` is set unconditionally
 *
 * Neither writer here produces a `calcChain`, which is the part that records the order Excel evaluated the
 * formulas in. That is a defensible omission — it is a cache, and Excel rebuilds it — but only if the file
 * also says the values are not Excel's. Without `fullCalcOnLoad` a workbook claims a cached result for every
 * formula while giving Excel no chain to check it against, so Excel displays whatever this library computed
 * (or, for a formula it declined to evaluate, a zero) and does not recalculate until something is edited.
 *
 * `fullCalcOnLoad="1"` is how a writer says "these values are mine, please redo them", and it is what every
 * generator that skips the chain has to say. Excel's own files carry `0` because they *do* ship a chain.
 *
 * The model can still ask for it explicitly; what changed is that leaving it unset no longer means "no".
 */
class WorkbookCalcPropertiesXform extends BaseXform {
  render(xmlStream: XmlSink, model: CalcPropertiesModel): void {
    xmlStream.leafNode("calcPr", {
      calcId: 171027,
      fullCalcOnLoad: model.fullCalcOnLoad === false ? undefined : 1,
      iterate: model.iterate ? 1 : undefined,
      iterateCount: model.iterateCount !== undefined ? model.iterateCount : undefined,
      iterateDelta: model.iterateDelta !== undefined ? model.iterateDelta : undefined
    });
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (node.name === "calcPr") {
      const attrs = node.attributes ?? {};
      this.model = {
        // Read as written. A file that says `0` — or omits it, as Excel's do — keeps that answer, so a
        // read-modify-write of an Excel file does not silently start asking for a full recalculation.
        fullCalcOnLoad: attrs.fullCalcOnLoad === "1",
        iterate: attrs.iterate === "1" ? true : undefined,
        iterateCount:
          attrs.iterateCount !== undefined ? parseInt(attrs.iterateCount, 10) : undefined,
        iterateDelta: attrs.iterateDelta !== undefined ? parseFloat(attrs.iterateDelta) : undefined
      };
      return true;
    }
    return false;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { WorkbookCalcPropertiesXform };
