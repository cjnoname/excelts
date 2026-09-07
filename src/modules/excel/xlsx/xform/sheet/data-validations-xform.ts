import type { DataValidationRule, DataValidationWithFormulae } from "@excel/types";
import { colCache } from "@excel/utils/col-cache";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { deepEqual } from "@utils/object";
import { parseBoolean, dateToExcel, excelToDate, parseOoxmlDate } from "@utils/utils";
import type { ParseOpenTag, XmlSink } from "@xml/types";

/** A validation stored in the model, optionally with a serialised range key. */
type StoredValidation = DataValidationRule;
/**
 * The data-validations model: a map of cell address (or `range:` key) → validation.
 *
 * **The value is optional, because the map is sparse.** Removing a validation leaves the key with an
 * `undefined` value rather than deleting it, and `optimiseDataValidations` has always filtered those holes a
 * few lines below. The type said otherwise, which is why a later pass over the same map read `.type` off a
 * hole and threw while writing a workbook that had merely once had a validation.
 */
type DataValidationModel = Record<string, StoredValidation | undefined>;
/** A validation ready to render: the validation plus the sqref it applies to. */
type RenderedValidation = DataValidationRule & { sqref: string };

function assign(
  target: Record<string, unknown>,
  attributes: Record<string, string>,
  name: string,
  defaultValue?: unknown
): void {
  const value = attributes[name];
  if (value !== undefined) {
    target[name] = value;
  } else if (defaultValue !== undefined) {
    target[name] = defaultValue;
  }
}

function assignBool(
  target: Record<string, unknown>,
  attributes: Record<string, string>,
  name: string,
  defaultValue?: unknown
): void {
  const value = attributes[name];
  if (value !== undefined) {
    target[name] = parseBoolean(value);
  } else if (defaultValue !== undefined) {
    target[name] = defaultValue;
  }
}

function optimiseDataValidations(model: DataValidationModel | undefined): RenderedValidation[] {
  // Squeeze alike data validations together into rectangular ranges
  // to reduce file size and speed up Excel load time
  if (!model) {
    return [];
  }

  // First, handle range: prefixed keys directly (large ranges stored during parsing)
  const rangeValidations: RenderedValidation[] = [];
  const regularModel: DataValidationModel = {};

  for (const [key, value] of Object.entries(model)) {
    // Skip undefined/null values (removed validations)
    if (value === undefined || value === null) {
      continue;
    }
    if (key.startsWith("range:")) {
      // Large range stored during parsing - output directly
      const rangeStr = key.slice(6); // Remove "range:" prefix
      const { sqref: _sqref, ...rest } = value as DataValidationRule & { sqref?: string };
      rangeValidations.push({
        ...rest,
        sqref: rangeStr
      } as RenderedValidation);
    } else {
      regularModel[key] = value;
    }
  }

  // If no regular entries, just return range validations
  if (Object.keys(regularModel).length === 0) {
    return rangeValidations;
  }

  const dvList = Object.entries(regularModel)
    .map(([address, dataValidation]) => ({
      address,
      dataValidation,
      marked: false
    }))
    .sort((a, b) => colCache.compareAddress(a.address, b.address));
  const dvMap = Object.fromEntries(dvList.map(dv => [dv.address, dv]));
  const matchCol = (
    addr: { row: number; col: number; address: string },
    height: number,
    col: number
  ): boolean => {
    for (let i = 0; i < height; i++) {
      const otherAddress = colCache.encodeAddress(addr.row + i, col);
      if (
        !regularModel[otherAddress] ||
        !deepEqual(regularModel[addr.address], regularModel[otherAddress])
      ) {
        return false;
      }
    }
    return true;
  };
  const optimized = dvList
    .map(dv => {
      if (!dv.marked) {
        const addr = colCache.decodeEx(dv.address) as {
          row: number;
          col: number;
          address: string;
          dimensions?: string;
        };
        if (addr.dimensions) {
          dvMap[addr.dimensions].marked = true;
          return {
            ...dv.dataValidation,
            sqref: dv.address
          } as RenderedValidation;
        }

        // iterate downwards - finding matching cells
        let height = 1;
        let otherAddress = colCache.encodeAddress(addr.row + height, addr.col);
        while (
          regularModel[otherAddress] &&
          deepEqual(dv.dataValidation, regularModel[otherAddress])
        ) {
          height++;
          otherAddress = colCache.encodeAddress(addr.row + height, addr.col);
        }

        // iterate rightwards...

        let width = 1;
        while (matchCol(addr, height, addr.col + width)) {
          width++;
        }

        // mark all included addresses
        for (let i = 0; i < height; i++) {
          for (let j = 0; j < width; j++) {
            otherAddress = colCache.encodeAddress(addr.row + i, addr.col + j);
            dvMap[otherAddress].marked = true;
          }
        }

        if (height > 1 || width > 1) {
          const bottom = addr.row + (height - 1);
          const right = addr.col + (width - 1);
          return {
            ...dv.dataValidation,
            sqref: `${dv.address}:${colCache.encodeAddress(bottom, right)}`
          } as RenderedValidation;
        }
        return {
          ...dv.dataValidation,
          sqref: dv.address
        } as RenderedValidation;
      }
      return null;
    })
    .filter((v): v is RenderedValidation => v !== null);

  return [...rangeValidations, ...optimized];
}

/**
 * Every `type: "date"` rule in a model, as the shape that carries formulae.
 *
 * Shared by `prepare` and `reconcile` so the two passes cannot come to disagree about which rules are dates —
 * this file is otherwise a case study in exactly that.
 */
function* dateRules(model: DataValidationModel | undefined): Generator<DataValidationWithFormulae> {
  for (const entry of Object.values(model ?? {})) {
    // The model is sparse: removing a validation leaves the key with an `undefined` value rather than deleting
    // it, so `Object.values` yields holes. `optimiseDataValidations` filters them a few lines below for the
    // same reason.
    if (entry === null || entry === undefined) {
      continue;
    }
    const rule = entry as DataValidationRule;
    if (rule.type === "date" && Array.isArray((rule as DataValidationWithFormulae).formulae)) {
      yield rule as DataValidationWithFormulae;
    }
  }
}

class DataValidationsXform extends BaseXform<DataValidationModel> {
  declare private _address: string;
  declare private _dataValidation: DataValidationRule;
  declare private _formula: string[] | undefined;

  get tag(): string {
    return "dataValidations";
  }

  /**
   * Turn the raw serials `parseClose` kept into `Date`s, now that the workbook's epoch is known.
   *
   * **A bound is a serial like any other cell value, and this was being converted against a hard-coded 1900
   * epoch.** A 1904 workbook therefore declared `<workbookPr date1904="1">` and then stated its date validations
   * 1,462 days away from where its cells were — so a rule reading "on or after 2020-01-15" rejected that very
   * date. The write half had the mirror-image omission, which is why a round trip through this library agreed
   * with itself and hid it entirely.
   *
   * The reconcile pass runs on the very instance that parsed, so this may use its options directly. The write
   * half cannot — see `render`.
   */
  reconcile(model: DataValidationModel | undefined, options?: { date1904?: boolean }): void {
    const date1904 = options?.date1904 === true;
    for (const rule of dateRules(model)) {
      rule.formulae = rule.formulae.map(formula =>
        typeof formula === "number" ? excelToDate(formula, date1904) : formula
      );
    }
  }

  /**
   * @param date1904 - The workbook's date system, for a `type: "date"` bound's serial.
   *
   * **Passed in rather than read off the rule.** An earlier fix stamped `date1904` onto each validation during
   * `prepare`, which worked but left the field on the objects `Cell.getValidation` returns — so merely writing a
   * workbook mutated the caller's model, and the stray field then took part in the `deepEqual` that merges
   * identical validations into one range. A serialiser's plumbing does not belong in the domain model.
   */
  render(xmlStream: XmlSink, model?: DataValidationModel, date1904 = false): void {
    const optimizedModel = optimiseDataValidations(model);
    if (optimizedModel.length) {
      xmlStream.openNode("dataValidations", { count: optimizedModel.length });

      optimizedModel.forEach(value => {
        xmlStream.openNode("dataValidation");

        if (value.type !== "any") {
          xmlStream.addAttribute("type", value.type);

          if (value.operator && value.type !== "list" && value.operator !== "between") {
            xmlStream.addAttribute("operator", value.operator);
          }
          if (value.allowBlank) {
            xmlStream.addAttribute("allowBlank", "1");
          }
        }
        if (value.showInputMessage) {
          xmlStream.addAttribute("showInputMessage", "1");
        }
        if (value.promptTitle) {
          xmlStream.addAttribute("promptTitle", value.promptTitle);
        }
        if (value.prompt) {
          xmlStream.addAttribute("prompt", value.prompt);
        }
        if (value.showErrorMessage) {
          xmlStream.addAttribute("showErrorMessage", "1");
        }
        if (value.errorStyle) {
          xmlStream.addAttribute("errorStyle", value.errorStyle);
        }
        if (value.errorTitle) {
          xmlStream.addAttribute("errorTitle", value.errorTitle);
        }
        if (value.error) {
          xmlStream.addAttribute("error", value.error);
        }
        xmlStream.addAttribute("sqref", value.sqref);
        const formulae = value.type !== "any" ? (value.formulae ?? []) : [];
        formulae.forEach((formula, index) => {
          xmlStream.openNode(`formula${index + 1}`);
          if (value.type === "date") {
            // `dateToExcel` reads the *UTC* fields, which is the library's convention for a `Date` carrying a
            // calendar value. A string is routed through `parseOoxmlDate` rather than `new Date`, so an
            // unsuffixed `2020-01-15T00:00:00` is not read as local time — the same defect the strict-format
            // `t="d"` cell branch had.
            const when =
              formula instanceof Date
                ? formula
                : typeof formula === "string"
                  ? parseOoxmlDate(formula)
                  : excelToDate(formula, date1904);
            xmlStream.writeText(dateToExcel(when, date1904));
          } else {
            xmlStream.writeText(typeof formula === "string" ? formula : String(formula));
          }
          xmlStream.closeNode();
        });
        xmlStream.closeNode();
      });
      xmlStream.closeNode();
    }
  }

  parseOpen(node: ParseOpenTag): boolean {
    switch (node.name) {
      case "dataValidations":
        this.model = {};
        return true;

      case "dataValidation": {
        this._address = node.attributes.sqref;
        const dataValidation: Record<string, unknown> = {
          type: node.attributes.type ?? "any",
          formulae: []
        };

        if (node.attributes.type) {
          assignBool(dataValidation, node.attributes, "allowBlank");
        }
        assignBool(dataValidation, node.attributes, "showInputMessage");
        assignBool(dataValidation, node.attributes, "showErrorMessage");

        switch (dataValidation.type) {
          case "any":
          case "list":
          case "custom":
            break;
          default:
            assign(dataValidation, node.attributes, "operator", "between");
            break;
        }
        assign(dataValidation, node.attributes, "promptTitle");
        assign(dataValidation, node.attributes, "prompt");
        assign(dataValidation, node.attributes, "errorStyle");
        assign(dataValidation, node.attributes, "errorTitle");
        assign(dataValidation, node.attributes, "error");

        this._dataValidation = dataValidation as unknown as DataValidationRule;
        return true;
      }

      case "formula1":
      case "formula2":
        this._formula = [];
        return true;

      default:
        return false;
    }
  }

  parseText(text: string): void {
    if (this._formula) {
      this._formula.push(text);
    }
  }

  parseClose(name: string): boolean {
    switch (name) {
      case "dataValidations":
        return false;
      case "dataValidation": {
        const dv = this._dataValidation as DataValidationRule & {
          formulae?: (string | number | Date)[];
          operator?: unknown;
        };
        if (!dv.formulae || !dv.formulae.length) {
          delete dv.formulae;
          delete dv.operator;
        }
        // The four known cases: 1. E4:L9 N4:U9  2.E4 L9  3. N4:U9  4. E4
        const list = this._address.split(/\s+/g);
        list.forEach((addr: string) => {
          if (addr.includes(":")) {
            // Store ranges directly to avoid expanding large (or many) validations.
            // The key format "range:A1:Z100" allows DataValidations.find() to detect it.
            this.model![`range:${addr}`] = this._dataValidation;
          } else {
            this.model![addr] = this._dataValidation;
          }
        });
        return true;
      }
      case "formula1":
      case "formula2": {
        const dv = this._dataValidation as DataValidationWithFormulae;
        let formula: string | number | Date = this._formula!.join("");
        switch (dv.type) {
          case "whole":
          case "textLength":
            formula = parseInt(formula, 10);
            break;
          case "decimal":
            formula = parseFloat(formula);
            break;
          case "date":
            // Left as the raw serial. The epoch is not known while the sheet is being tokenised — it lives in the
            // workbook part — so the conversion happens in `reconcile`, which is where `CellXform` does the same
            // thing for the same reason. Converting here is what made a date bound read against a hard-coded 1900
            // epoch regardless of the workbook's own.
            formula = parseFloat(formula);
            break;
          default:
            break;
        }
        dv.formulae.push(formula);
        this._formula = undefined;
        return true;
      }
      default:
        return true;
    }
  }
}

export { DataValidationsXform };
