import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { parseXsdBoolean } from "@excel/xlsx/xform/xsd-values";
import type { ParseOpenTag, XmlSink } from "@xml/types";

function booleanToXml(model: boolean): string | undefined {
  return model ? "1" : undefined;
}
function pageOrderToXml(model: string): string | undefined {
  switch (model) {
    case "overThenDown":
      return model;
    default:
      return undefined;
  }
}
function cellCommentsToXml(model: string): string | undefined {
  switch (model) {
    case "atEnd":
    case "asDisplyed":
      return model;
    default:
      return undefined;
  }
}
function errorsToXml(model: string): string | undefined {
  switch (model) {
    case "dash":
    case "blank":
    case "NA":
      return model;
    default:
      return undefined;
  }
}
function pageSizeToModel(value: string): number | undefined {
  return value !== undefined ? parseInt(value, 10) : undefined;
}

interface PageSetupModel {
  paperSize?: number;
  orientation?: string;
  horizontalDpi?: number;
  verticalDpi?: number;
  pageOrder?: string;
  blackAndWhite?: boolean;
  draft?: boolean;
  cellComments?: string;
  errors?: string;
  scale?: number;
  fitToWidth?: number;
  fitToHeight?: number;
  firstPageNumber?: number;
  useFirstPageNumber?: boolean;
  usePrinterDefaults?: boolean;
  copies?: number;
  /**
   * `r:id` of the printer-settings part, when the source sheet had one.
   *
   * Not a modelled page-setup property — it is the only thing that connects the
   * sheet to a preserved `xl/printerSettings/printerSettingsN.bin`. Dropping it
   * while preserving the part and its relationship produces a package that
   * carries printer settings no sheet refers to, which is the same as not having
   * preserved them at all. The writer re-emits whatever id that relationship
   * ended up with, since a preserved id can collide with a freshly allocated one.
   */
  rId?: string;
}

/**
 * A DPI attribute as a number, or `undefined` when the file does not state one.
 *
 * **Two ways a file says nothing, and both mean `undefined`.** The attribute may be missing, or it may be
 * present holding 4294967295 — which is `0xFFFFFFFF`, the value Excel and older versions of this library write
 * to mean "unset" rather than a resolution of four billion dots per inch. `_dpiToXml` below has always dropped
 * it on the way out, so an XLSX round trip was already treating it as absence; letting it into the model meant
 * only the XLSX writer knew that, and the XLSB writer put it into `BrtPageSetup` verbatim where the schema's
 * default is 600.
 *
 * Fixing only the missing-attribute case left the asymmetry in place for any file that states the sentinel
 * explicitly — `examples/data/test.xlsx` is one, and it was the single remaining offender out of 221
 * `BrtPageSetup` records once the examples were regenerated. One rule, applied wherever the value comes from.
 */
function parseDpi(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed === DPI_UNSET) {
    return undefined;
  }
  return parsed;
}

/** `0xFFFFFFFF` — what a file writes into a DPI attribute when nothing chose one. */
const DPI_UNSET = 4294967295;

class PageSetupXform extends BaseXform {
  get tag(): string {
    return "pageSetup";
  }

  private _dpiToXml(value: number | undefined): number | undefined {
    // Excel commonly omits these attributes. 4294967295 is used as a sentinel default
    // when parsing missing values; it should never be serialized back out.
    if (value === undefined) {
      return undefined;
    }
    if (!Number.isFinite(value)) {
      return undefined;
    }
    if (value === 4294967295) {
      return undefined;
    }
    return value;
  }

  render(xmlStream: XmlSink, model: PageSetupModel): void {
    if (model) {
      const useFirstPageNumber = model.useFirstPageNumber ?? model.firstPageNumber !== undefined;
      const attributes = {
        paperSize: model.paperSize,
        orientation: model.orientation,
        horizontalDpi: this._dpiToXml(model.horizontalDpi),
        verticalDpi: this._dpiToXml(model.verticalDpi),
        pageOrder: pageOrderToXml(model.pageOrder!),
        blackAndWhite: booleanToXml(model.blackAndWhite!),
        draft: booleanToXml(model.draft!),
        cellComments: cellCommentsToXml(model.cellComments!),
        errors: errorsToXml(model.errors!),
        // Only output non-default values (matches Excel behavior)
        scale: model.scale !== 100 ? model.scale : undefined,
        fitToWidth: model.fitToWidth !== 1 ? model.fitToWidth : undefined,
        fitToHeight: model.fitToHeight !== 1 ? model.fitToHeight : undefined,
        firstPageNumber: useFirstPageNumber ? model.firstPageNumber : undefined,
        useFirstPageNumber: booleanToXml(useFirstPageNumber),
        usePrinterDefaults: booleanToXml(model.usePrinterDefaults!),
        // `copies` belongs to the same "only non-default values" policy as the three above and was the one
        // attribute missing from it. The reader supplies 1 when the file states nothing, so a read-modify-write
        // grew a `copies="1"` the original did not have — a no-op edit produced a diff, which is how this was
        // found: an unrelated sparkline round-trip check reported the sheet 11 bytes larger.
        //
        // Fixed here rather than in the reader. The reader fabricates defaults for `verticalDpi`, `pageOrder`,
        // `cellComments`, `errors`, `scale`, `fitToWidth` and `fitToHeight` too, and that is the deeper wart —
        // `firstPageNumber` shows the right shape, reporting `undefined` when the attribute is absent. But those
        // are suppressed on the way out, so they change no file today, and making the reader stop inventing them
        // changes what every consumer of `pageSetup` sees. That is a decision worth taking on its own.
        copies: model.copies !== 1 ? model.copies : undefined,
        "r:id": model.rId
      };
      if (Object.values(attributes).some((value: unknown) => value !== undefined)) {
        xmlStream.leafNode(this.tag, attributes);
      }
    }
  }

  parseOpen(node: ParseOpenTag): boolean {
    switch (node.name) {
      case this.tag:
        this.model = {
          paperSize: pageSizeToModel(node.attributes.paperSize),
          orientation: node.attributes.orientation ?? "portrait",
          // **Absent is `undefined`, not a sentinel.** These used to parse to 4294967295 when the attribute was
          // missing, and `_dpiToXml` below knew to strip that on the way back out — which made an XLSX round
          // trip correct and left every other writer holding a value that means "absent" while looking like a
          // number. The XLSB writer duly wrote 0xFFFFFFFF into `BrtPageSetup` where the schema's default is
          // 600, so a sheet with no stated resolution printed at the consumer's resolution rather than the
          // author's. One representation of absence, and no writer needs to know about a magic number.
          horizontalDpi: parseDpi(node.attributes.horizontalDpi),
          verticalDpi: parseDpi(node.attributes.verticalDpi),
          pageOrder: node.attributes.pageOrder ?? "downThenOver",
          blackAndWhite: node.attributes.blackAndWhite === "1",
          draft: node.attributes.draft === "1",
          cellComments: node.attributes.cellComments ?? "None",
          errors: node.attributes.errors ?? "displayed",
          scale: parseInt(node.attributes.scale ?? "100", 10),
          fitToWidth: parseInt(node.attributes.fitToWidth ?? "1", 10),
          fitToHeight: parseInt(node.attributes.fitToHeight ?? "1", 10),
          firstPageNumber:
            node.attributes.firstPageNumber !== undefined
              ? parseInt(node.attributes.firstPageNumber, 10)
              : undefined,
          useFirstPageNumber: parseXsdBoolean(node.attributes.useFirstPageNumber) ?? false,
          usePrinterDefaults: node.attributes.usePrinterDefaults === "1",
          copies: parseInt(node.attributes.copies ?? "1", 10),
          rId: node.attributes["r:id"]
        };
        return true;
      default:
        return false;
    }
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { PageSetupXform };
