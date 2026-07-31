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
}

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
        copies: model.copies
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
          horizontalDpi: parseInt(node.attributes.horizontalDpi ?? "4294967295", 10),
          verticalDpi: parseInt(node.attributes.verticalDpi ?? "4294967295", 10),
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
          copies: parseInt(node.attributes.copies ?? "1", 10)
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
