interface ValidationModel {
  [address: string]: any;
}

class DataValidations {
  model: ValidationModel;

  constructor(model?: ValidationModel) {
    this.model = model || {};
  }

  add(address: string, validation: any): any {
    return (this.model[address] = validation);
  }

  find(address: string): any {
    return this.model[address];
  }

  remove(address: string): void {
    this.model[address] = undefined;
  }
}

export { DataValidations };
