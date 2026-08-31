/**
 * BIFF12 package validation.
 *
 * Answers the question a writer needs answered before its output is trusted: would
 * Excel refuse this file, or offer to repair it? That question is otherwise
 * unanswerable during development, because Excel's own diagnostic is "we found a
 * problem with some content" — no part, no offset, no reason. A binary format
 * without this is developed by bisecting bytes.
 *
 * ## Order matters
 *
 * As in `ooxml-validator/index.ts`, the sequence is part of the contract:
 *
 *  1. **Package** first. There is nothing to say about record streams inside
 *     something that is not a workbook, and its failures are terminal.
 *  2. **Framing** next, per part. Every later check reads records, and a part whose
 *     record boundaries cannot be found yields records that are bytes from the
 *     middle of other records — so a part that fails framing is excluded from the
 *     rest rather than generating a cascade of invented problems.
 *  3. **Counts** before **indexes**, because an index is only out of range relative
 *     to a collection declared in a different part.
 *  4. **Scopes**, **ordering**, **coordinates** and **indexes** last, in any order —
 *     they are independent.
 *
 * ## What it does not do
 *
 * It does not decode formulas, styles or strings into a model. It is a structural
 * audit, and the boundary is deliberate: everything here can be checked from the
 * record table plus a handful of payload prefixes, which is what keeps it honest
 * about the difference between "this is malformed" and "this library has not
 * modelled that yet".
 */

import { checkCoordinates } from "@excel/utils/xlsb-validator/check-coordinates";
import { checkFraming, type FramedPart } from "@excel/utils/xlsb-validator/check-framing";
import {
  checkIndexes,
  readCollectionCounts,
  type CollectionCounts
} from "@excel/utils/xlsb-validator/check-indexes";
import { checkOrdering } from "@excel/utils/xlsb-validator/check-ordering";
import { checkPackage } from "@excel/utils/xlsb-validator/check-package";
import { checkScopes } from "@excel/utils/xlsb-validator/check-scopes";
import { XlsbReporter } from "@excel/utils/xlsb-validator/reporter";
import { guessPartRoleFromPath, type XlsbPartRole } from "@excel/utils/xlsb-validator/roles";
import type { XlsbValidateOptions, XlsbValidationReport } from "@excel/utils/xlsb-validator/types";

export async function validateXlsbBuffer(
  bytes: Uint8Array,
  options: XlsbValidateOptions = {}
): Promise<XlsbValidationReport> {
  const reporter = new XlsbReporter({
    maxProblems: options.maxProblems ?? 100,
    includeWarnings: options.includeWarnings ?? false
  });

  const pkg = await checkPackage(bytes, reporter);
  if (!pkg.usable) {
    return report(reporter, { partCount: pkg.entries.size, binaryPartCount: 0 }, []);
  }

  // Only the parts that really are record streams. Their roles came from the content
  // types, not from their paths — see `roles.ts` for why that distinction is the whole
  // difficulty.
  const framed: FramedPart[] = [];
  const roles = new Map<string, XlsbPartRole>();
  for (const part of pkg.recordStreams) {
    if (reporter.capped) {
      break;
    }
    roles.set(part.path, part.role);
    framed.push(checkFraming(part.bytes, part.path, reporter));
  }

  const usable = framed.filter(part => part.complete);
  const counts = options.checkIndexes === false ? {} : readCollectionCounts(usable, reporter);

  for (const part of usable) {
    if (reporter.capped) {
      break;
    }
    const role = roles.get(part.part) ?? "unknownRecordStream";
    if (options.checkScopes !== false) {
      checkScopes(part, reporter);
    }
    if (options.checkOrdering !== false) {
      checkOrdering(part, role, reporter);
    }
    if (options.checkCoordinates !== false && role === "worksheet") {
      checkCoordinates(part, reporter);
    }
    if (options.checkIndexes !== false && role === "worksheet") {
      checkIndexes(part, counts, reporter);
    }
  }

  return report(
    reporter,
    { partCount: pkg.entries.size, binaryPartCount: pkg.recordStreams.length },
    framed
  );
}

function report(
  reporter: XlsbReporter,
  sizes: { partCount: number; binaryPartCount: number },
  framed: readonly FramedPart[]
): XlsbValidationReport {
  return {
    ok: !reporter.hasErrors,
    problems: reporter.problems,
    capped: reporter.capped,
    stats: {
      ...sizes,
      recordCount: framed.reduce((total, part) => total + part.records.length, 0),
      unknownRecordCount: framed.reduce((total, part) => total + part.unknownRecordCount, 0)
    }
  };
}

export interface XlsbValidatePartOptions extends XlsbValidateOptions {
  /**
   * Collection sizes from the parts that declare them.
   *
   * An index is only out of range relative to a collection in a *different* part, so a
   * part checked on its own has nothing to compare against unless the caller supplies
   * it. Passing the counts explicitly is what makes that honest: the alternative —
   * scavenging them from whatever happens to be in the same stream — would have the
   * check quietly pass whenever the collection is elsewhere, and would only work in a
   * test if the test built a part that could not exist.
   */
  readonly counts?: CollectionCounts;
  /**
   * What the part is.
   *
   * Defaults to a guess from the path, which is only sound because there is no package
   * here to declare it — the package entry point uses content types precisely because
   * path patterns cannot tell a worksheet from Excel's row index.
   */
  readonly role?: XlsbPartRole;
}

/**
 * Validate one `.bin` part in isolation.
 *
 * The package-level entry point needs a whole workbook; a unit test for a single
 * checker needs one part and no ZIP. Keeping both means the negative cases can be
 * hand-built record streams, which is what makes them readable.
 */
export function validateXlsbPart(
  bytes: Uint8Array,
  part: string,
  options: XlsbValidatePartOptions = {}
): XlsbValidationReport {
  const reporter = new XlsbReporter({
    maxProblems: options.maxProblems ?? 100,
    includeWarnings: options.includeWarnings ?? false
  });

  const framed = checkFraming(bytes, part, reporter);
  if (framed.complete) {
    const role = options.role ?? guessPartRoleFromPath(part);
    if (options.checkScopes !== false) {
      checkScopes(framed, reporter);
    }
    if (options.checkOrdering !== false) {
      checkOrdering(framed, role, reporter);
    }
    if (options.checkCoordinates !== false && role === "worksheet") {
      checkCoordinates(framed, reporter);
    }
    if (options.checkIndexes !== false) {
      // A part that declares a collection is still checked against itself — that is
      // where the count-versus-items mismatch lives — and anything supplied by the
      // caller wins, since it comes from the part that really owns the collection.
      const own = readCollectionCounts([framed], reporter);
      checkIndexes(framed, { ...own, ...options.counts }, reporter);
    }
  }

  return report(reporter, { partCount: 1, binaryPartCount: 1 }, [framed]);
}

export type {
  XlsbProblem,
  XlsbProblemKind,
  XlsbSeverity,
  XlsbValidateOptions,
  XlsbValidationReport
} from "@excel/utils/xlsb-validator/types";
