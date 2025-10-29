class SharedStrings {
  declare private _values: any[];
  declare private _totalRefs: number;
  declare private _hash: Record<string, number>;

  constructor() {
    this._values = [];
    this._totalRefs = 0;
    this._hash = Object.create(null);
  }

  get count(): number {
    return this._values.length;
  }

  get values(): any[] {
    return this._values;
  }

  get totalRefs(): number {
    return this._totalRefs;
  }

  getString(index: number): any {
    return this._values[index];
  }

  add(value: any): number {
    let index = this._hash[value];
    if (index === undefined) {
      index = this._hash[value] = this._values.length;
      this._values.push(value);
    }
    this._totalRefs++;
    return index;
  }
}

export { SharedStrings };
