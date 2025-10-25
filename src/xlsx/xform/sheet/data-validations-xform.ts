import { BaseXform } from "../base-xform.js";
import { Range } from "../../../doc/range.js";
import { parseBoolean, dateToExcel, excelToDate } from "../../../utils/utils.js";
import { colCache } from "../../../utils/col-cache.js";
import { isEqual } from "../../../utils/under-dash.js";

function assign(definedName: any, attributes: any, name: string, defaultValue?: any): void {
  const value = attributes[name];
  if (value !== undefined) {
    definedName[name] = value;
  } else if (defaultValue !== undefined) {
    definedName[name] = defaultValue;
  }
}

function assignBool(definedName: any, attributes: any, name: string, defaultValue?: any): void {
  const value = attributes[name];
  if (value !== undefined) {
    definedName[name] = parseBoolean(value);
  } else if (defaultValue !== undefined) {
    definedName[name] = defaultValue;
  }
}

function optimiseDataValidations(model: any): any[] {
  // Squeeze alike data validations together into rectangular ranges
  // to reduce file size and speed up Excel load time
  if (!model) {
    return [];
  }
  const dvList = Object.entries(model)
    .map(([address, dataValidation]: [string, any]) => ({
      address,
      dataValidation,
      marked: false
    }))
    .sort((a: any, b: any) => a.address.localeCompare(b.address));
  const dvMap = Object.fromEntries(dvList.map(dv => [dv.address, dv]));
  const matchCol = (addr: any, height: number, col: number): boolean => {
    for (let i = 0; i < height; i++) {
      const otherAddress = colCache.encodeAddress(addr.row + i, col);
      if (!model[otherAddress] || !isEqual(model[addr.address], model[otherAddress])) {
        return false;
      }
    }
    return true;
  };
  return dvList
    .map(dv => {
      if (!dv.marked) {
        const addr: any = colCache.decodeEx(dv.address);
        if (addr.dimensions) {
          dvMap[addr.dimensions].marked = true;
          return {
            ...dv.dataValidation,
            sqref: dv.address
          };
        }

        // iterate downwards - finding matching cells
        let height = 1;
        let otherAddress = colCache.encodeAddress(addr.row + height, addr.col);
        while (model[otherAddress] && isEqual(dv.dataValidation, model[otherAddress])) {
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
          };
        }
        return {
          ...dv.dataValidation,
          sqref: dv.address
        };
      }
      return null;
    })
    .filter(Boolean);
}

class DataValidationsXform extends BaseXform {
  declare private _address: string;
  declare private _dataValidation: any;
  declare private _formula: string[];

  get tag(): string {
    return "dataValidations";
  }

  render(xmlStream: any, model: any): void {
    const optimizedModel = optimiseDataValidations(model);
    if (optimizedModel.length) {
      xmlStream.openNode("dataValidations", { count: optimizedModel.length });

      optimizedModel.forEach((value: any) => {
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
        (value.formulae || []).forEach((formula: any, index: number) => {
          xmlStream.openNode(`formula${index + 1}`);
          if (value.type === "date") {
            xmlStream.writeText(dateToExcel(new Date(formula)));
          } else {
            xmlStream.writeText(formula);
          }
          xmlStream.closeNode();
        });
        xmlStream.closeNode();
      });
      xmlStream.closeNode();
    }
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case "dataValidations":
        this.model = {};
        return true;

      case "dataValidation": {
        this._address = node.attributes.sqref;
        const dataValidation: any = { type: node.attributes.type || "any", formulae: [] };

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

        this._dataValidation = dataValidation;
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
        if (!this._dataValidation.formulae || !this._dataValidation.formulae.length) {
          delete this._dataValidation.formulae;
          delete this._dataValidation.operator;
        }
        // The four known cases: 1. E4:L9 N4:U9  2.E4 L9  3. N4:U9  4. E4
        const list = this._address.split(/\s+/g) || [];
        list.forEach((addr: string) => {
          if (addr.includes(":")) {
            const range = new Range(addr);
            range.forEachAddress((address: string) => {
              this.model[address] = this._dataValidation;
            });
          } else {
            this.model[addr] = this._dataValidation;
          }
        });
        return true;
      }
      case "formula1":
      case "formula2": {
        let formula: any = this._formula.join("");
        switch (this._dataValidation.type) {
          case "whole":
          case "textLength":
            formula = parseInt(formula, 10);
            break;
          case "decimal":
            formula = parseFloat(formula);
            break;
          case "date":
            formula = excelToDate(parseFloat(formula));
            break;
          default:
            break;
        }
        this._dataValidation.formulae.push(formula);
        this._formula = undefined as any;
        return true;
      }
      default:
        return true;
    }
  }
}

export { DataValidationsXform };
