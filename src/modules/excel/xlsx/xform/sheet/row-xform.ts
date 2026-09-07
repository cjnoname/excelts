import { MaxItemsExceededError } from "@excel/errors";
import type { Style } from "@excel/types";
import { colCache } from "@excel/utils/col-cache";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { CellXform } from "@excel/xlsx/xform/sheet/cell-xform";
import { parseBoolean } from "@utils/utils";
import type { ParseOpenTag, XmlSink } from "@xml/types";

interface RowXformOptions {
  maxItems?: number;
  /** Collapse styled blank cells instead of materialising them — see the call site. */
  blankCells?: "keep" | "collapse";
  /** Called for each collapsed cell, with zero-based row and column. */
  collectStyledBlank?: (row: number, column: number, styleId: number) => void;
}

/**
 * Write/parse options threaded through the sheet xform tree. The style
 * manager is carried loosely (the stream writer types it as `object`); row
 * xform narrows it to the style-manager surface at the call site.
 */
interface StyleManagerLike {
  addStyleModel(model: Partial<Style>): number;
  getStyleModel(id: number): Style | null;
}
interface RowXformPrepareOptions {
  styles: object;
  /**
   * Whether the workbook counts days from 1904.
   *
   * Not read here — it is forwarded whole to `CellXform.prepare`, which stamps it onto every date cell so that
   * `toXml` converts against the right epoch. Declared anyway, because it *was* travelling through this object
   * undeclared: the streaming writer simply did not put it in, and nothing said it was missing. A field a type
   * does not mention is a field a caller cannot be told to supply.
   */
  date1904?: boolean;
}

interface RowModel {
  number: number;
  min?: number;
  max?: number;
  cells: unknown[];
  styleId?: number;
  hidden?: boolean;
  bestFit?: boolean;
  height?: number;
  customHeight?: boolean;
  outlineLevel?: number;
  collapsed?: boolean;
  style?: Partial<Style>;
  dyDescent?: number;
}

/**
 * Whether a parsed cell carries formatting and nothing else.
 *
 * A style and no value. A cell with a formula, a hyperlink or a comment is not blank however empty its value looks —
 * `null` is a value a formula can produce — so all of those are checked rather than only the value.
 */
function isStyledBlank(cell: {
  readonly value?: unknown;
  readonly type?: number;
  readonly formula?: unknown;
  readonly sharedFormula?: unknown;
  readonly hyperlink?: unknown;
  readonly comment?: unknown;
  readonly styleId?: number;
}): boolean {
  return (
    cell.styleId !== undefined &&
    cell.value === undefined &&
    cell.formula === undefined &&
    cell.sharedFormula === undefined &&
    cell.hyperlink === undefined &&
    cell.comment === undefined
  );
}

class RowXform extends BaseXform<RowModel> {
  declare private maxItems?: number;
  declare private options?: RowXformOptions;
  declare public map: Record<string, BaseXform>;
  declare public parser?: BaseXform;
  declare private numRowsSeen: number;
  declare private lastCellCol: number;

  constructor(options?: RowXformOptions) {
    super();

    this.maxItems = options && options.maxItems;
    this.options = options;
    this.map = {
      c: new CellXform()
    };
  }

  get tag(): string {
    return "row";
  }

  reset(): void {
    super.reset();
    this.numRowsSeen = 0;
    this.lastCellCol = 0;
  }

  prepare(model: RowModel, options: RowXformPrepareOptions): void {
    const styles = options.styles as StyleManagerLike;
    const styleId = styles.addStyleModel(model.style ?? {});
    if (styleId) {
      model.styleId = styleId;
    }
    const cellXform = this.map.c as CellXform;
    model.cells.forEach(cellModel => {
      cellXform.prepare(cellModel, options);
    });
  }

  render(xmlStream: XmlSink, model?: RowModel, _options?: unknown): void {
    if (!model) {
      return;
    }
    xmlStream.openNode("row");
    xmlStream.addAttribute("r", model.number);
    if (model.height != null && model.height > 0) {
      xmlStream.addAttribute("ht", model.height);
      if (model.customHeight !== false) {
        xmlStream.addAttribute("customHeight", "1");
      }
    } else if (model.height === 0) {
      // height=0 signals auto-height: write a minimal ht hint without
      // customHeight so Excel recalculates the row height on open.
      xmlStream.addAttribute("ht", 1);
    }
    if (model.hidden) {
      xmlStream.addAttribute("hidden", "1");
    }
    if (model.min! > 0 && model.max! > 0 && model.min! <= model.max!) {
      xmlStream.addAttribute("spans", `${model.min}:${model.max}`);
    }
    if (model.styleId) {
      xmlStream.addAttribute("s", model.styleId);
      xmlStream.addAttribute("customFormat", "1");
    }
    // Output dyDescent if present (MS extension for font descent)
    if (model.dyDescent !== undefined) {
      xmlStream.addAttribute("x14ac:dyDescent", model.dyDescent);
    }
    if (model.outlineLevel) {
      xmlStream.addAttribute("outlineLevel", model.outlineLevel);
    }
    if (model.collapsed) {
      xmlStream.addAttribute("collapsed", "1");
    }

    const cellXform = this.map.c as CellXform;
    model.cells.forEach(cellModel => {
      // CellXform.render takes (xmlStream, model); the row's `options` is not
      // consumed by it (it was silently ignored under the previous any typing).
      cellXform.render(xmlStream, cellModel);
    });

    xmlStream.closeNode();
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    if (node.name === "row") {
      this.numRowsSeen += 1;
      // Reset lastCellCol for each new row
      this.lastCellCol = 0;
      const spans = node.attributes.spans;
      let spanMin: number | undefined;
      let spanMax: number | undefined;
      if (spans) {
        const colonIdx = spans.indexOf(":");
        spanMin = parseInt(spans, 10); // parses up to non-digit
        spanMax = colonIdx > -1 ? parseInt(spans.substring(colonIdx + 1), 10) : undefined;
      }
      // If r attribute is missing, use numRowsSeen as the row number
      const rowNumber = node.attributes.r ? parseInt(node.attributes.r, 10) : this.numRowsSeen;
      const model: RowModel = (this.model = {
        number: rowNumber,
        min: spanMin,
        max: spanMax,
        cells: []
      });
      if (node.attributes.s) {
        model.styleId = parseInt(node.attributes.s, 10);
      }
      if (parseBoolean(node.attributes.hidden)) {
        model.hidden = true;
      }
      if (parseBoolean(node.attributes.bestFit)) {
        model.bestFit = true;
      }
      if (node.attributes.ht) {
        model.height = parseFloat(node.attributes.ht);
      }
      if (parseBoolean(node.attributes.customHeight)) {
        model.customHeight = true;
      }
      if (node.attributes.outlineLevel) {
        model.outlineLevel = parseInt(node.attributes.outlineLevel, 10);
      }
      if (parseBoolean(node.attributes.collapsed)) {
        model.collapsed = true;
      }
      if (node.attributes["x14ac:dyDescent"] !== undefined) {
        model.dyDescent = parseFloat(node.attributes["x14ac:dyDescent"]);
      }
      return true;
    }

    this.parser = this.map[node.name];
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    return false;
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        const cellModel = this.parser.model;
        // If cell has address, extract column number from it
        // Otherwise, calculate address based on position
        if (cellModel.address) {
          this.lastCellCol = colCache.decodeCol(cellModel.address);
        } else {
          // No r attribute, calculate address from position
          this.lastCellCol += 1;
          cellModel.address = colCache.encodeAddress(this.model!.number, this.lastCellCol);
        }
        // **A styled cell with no value is collapsed rather than materialised.**
        //
        // `<c r="A9" s="3"/>` is what Excel writes for formatting applied past the data, one per cell — 62,400 of them
        // for an eight-column region against 200 rows of actual data, costing 36.8 MB retained and reporting 8,000
        // physical rows where there are 200. The binary container has the identical shape and the identical cost.
        //
        // **Collapsed, not dropped.** The run is handed to `collectStyledBlank`, which accumulates rectangles into the
        // same `styledBlankRanges` the XLSB reader fills and both writers expand again — so a formatted region survives
        // a round trip through either container and nothing is owed to a fidelity report. That shared field is why this
        // is not the lossy sibling of a lossless option: making them differ would have been the worse API.
        if (this.options?.blankCells === "collapse" && isStyledBlank(cellModel)) {
          this.options.collectStyledBlank?.(
            this.model!.number - 1,
            colCache.decodeCol(cellModel.address) - 1,
            cellModel.styleId ?? 0
          );
        } else {
          this.model!.cells.push(cellModel);
        }
        if (this.maxItems && this.model!.cells.length > this.maxItems) {
          throw new MaxItemsExceededError("column", this.maxItems);
        }
        this.parser = undefined;
      }
      return true;
    }
    return false;
  }

  reconcile(model: RowModel, options: RowXformPrepareOptions): void {
    const styles = options.styles as StyleManagerLike;
    model.style =
      model.styleId !== undefined ? (styles.getStyleModel(model.styleId) ?? undefined) : {};
    if (model.styleId !== undefined) {
      model.styleId = undefined;
    }

    const cellXform = this.map.c as CellXform;
    model.cells.forEach(cellModel => {
      cellXform.reconcile(cellModel, options);
    });
  }
}

export { RowXform };
