/**
 * Problem reporter for the BIFF12 validator.
 *
 * Same two responsibilities and same encounter-order guarantee as the OOXML
 * validator's reporter: filter warnings, stop at the cap, do not sort or dedupe.
 * Kept as a separate class rather than made generic over both problem vocabularies
 * — the shared part is twenty lines, and a type parameter threaded through every
 * checker signature to save them would make each checker harder to read than the
 * duplication costs.
 */

import type { XlsbProblem, XlsbProblemKind, XlsbSeverity } from "@excel/utils/xlsb-validator/types";

export interface XlsbReporterOptions {
  readonly maxProblems?: number;
  readonly includeWarnings?: boolean;
}

export interface ProblemLocation {
  readonly part?: string;
  readonly offset?: number;
}

export class XlsbReporter {
  readonly problems: XlsbProblem[] = [];
  private errorCount = 0;
  private readonly maxProblems: number;
  private readonly includeWarnings: boolean;

  constructor(options: XlsbReporterOptions = {}) {
    this.maxProblems = options.maxProblems ?? 100;
    this.includeWarnings = options.includeWarnings ?? false;
  }

  /** True once the cap is reached. Checkers consult this to stop early. */
  get capped(): boolean {
    return this.problems.length >= this.maxProblems;
  }

  get hasErrors(): boolean {
    return this.errorCount > 0;
  }

  error(kind: XlsbProblemKind, message: string, where: ProblemLocation = {}): void {
    this.push("error", kind, message, where);
  }

  warning(kind: XlsbProblemKind, message: string, where: ProblemLocation = {}): void {
    if (!this.includeWarnings) {
      return;
    }
    this.push("warning", kind, message, where);
  }

  private push(
    severity: XlsbSeverity,
    kind: XlsbProblemKind,
    message: string,
    where: ProblemLocation
  ): void {
    if (this.capped) {
      return;
    }
    if (severity === "error") {
      this.errorCount++;
    }
    this.problems.push({ severity, kind, message, ...where });
  }
}
