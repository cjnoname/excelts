import { XLSX } from "../xlsx/xlsx.js";

class ModelContainer {
  model: any;
  declare private _xlsx?: XLSX;

  constructor(model: any) {
    this.model = model;
  }

  get xlsx(): XLSX {
    if (!this._xlsx) {
      this._xlsx = new XLSX(this);
    }
    return this._xlsx;
  }
}

export { ModelContainer };
