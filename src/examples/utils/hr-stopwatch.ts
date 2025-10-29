export class HrStopwatch {
  private total: number = 0;
  private hrStart?: [number, number];

  start(): void {
    this.hrStart = process.hrtime();
  }

  stop(): void {
    if (this.hrStart) {
      this.total += this._span;
      delete this.hrStart;
    }
  }

  reset(): void {
    this.total = 0;
    delete this.hrStart;
  }

  get span(): number {
    if (this.hrStart) {
      return this.total + this._span;
    }
    return this.total;
  }

  private get _span(): number {
    const hrNow = process.hrtime();
    const start = this.hrStart![0] + this.hrStart![1] / 1e9;
    const finish = hrNow[0] + hrNow[1] / 1e9;
    return finish - start;
  }

  toString(format?: string): string {
    switch (format) {
      case "ms":
        return `${this.ms}ms`;
      case "microseconds":
        return `${this.microseconds}µs`;
      default:
        return `${this.span} seconds`;
    }
  }

  get ms(): number {
    return Math.round(this.span * 1000);
  }

  get microseconds(): number {
    return Math.round(this.span * 1000000);
  }
}
