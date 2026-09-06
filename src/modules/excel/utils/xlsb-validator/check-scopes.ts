/**
 * Scope check: are the `Begin`/`End` delimiters balanced and correctly nested?
 *
 * This is the most basic structural invariant in BIFF12 and the one most worth
 * checking, because it is cheap to get wrong and expensive to diagnose. A writer
 * that omits one `BrtEndSheetData` produces a file Excel refuses with "we found a
 * problem with some content", naming neither the part nor the offset — and every
 * record after the missing delimiter is still perfectly well-framed, so nothing
 * else notices.
 *
 * The check is a stack, and the three ways it can fail are worth distinguishing
 * rather than reporting as one "unbalanced" problem: an unclosed scope means the
 * writer forgot an `End`, an unopened one means it emitted an `End` twice or in the
 * wrong place, and a mismatch means the nesting crossed over — three different bugs
 * with three different fixes.
 */

import type { FramedPart } from "@excel/utils/xlsb-validator/check-framing";
import type { XlsbReporter } from "@excel/utils/xlsb-validator/reporter";
import { recordSpec, type BiffRecordSpec } from "@excel/xlsb/spec/records";

/**
 * Delimiters that may wrap anything, at any depth.
 *
 * `BrtFRTBegin` and `BrtACBegin` are how the format carries
 * things a given consumer may not understand, so they legitimately appear inside
 * records that are not otherwise containers. Treating them like structural scopes
 * would make every file that uses a newer feature look mis-nested.
 */
const TRANSPARENT_SCOPES = new Set(["BrtFRTBegin", "BrtACBegin"]);

export interface ScopeResult {
  /** The outermost scope's name, e.g. `Sheet`, or undefined when there was none. */
  readonly root?: string;
  readonly balanced: boolean;
}

export function checkScopes(framed: FramedPart, reporter: XlsbReporter): ScopeResult {
  const stack: { spec: BiffRecordSpec; offset: number }[] = [];
  let root: string | undefined;
  let balanced = true;

  for (const record of framed.records) {
    if (reporter.capped) {
      break;
    }
    const spec = recordSpec(record.id);
    if (!spec?.scope) {
      continue;
    }

    if (spec.scope === "begin") {
      if (stack.length === 0 && !TRANSPARENT_SCOPES.has(spec.name)) {
        root ??= spec.name.replace(/^BrtBegin/, "");
      }
      stack.push({ spec, offset: record.offset });
      continue;
    }

    const open = stack.pop();
    if (!open) {
      balanced = false;
      reporter.error("scope-unopened", `${spec.name} closes a scope that was never opened`, {
        part: framed.part,
        offset: record.offset
      });
      continue;
    }
    if (open.spec.pairsWith !== spec.name) {
      balanced = false;
      reporter.error(
        "scope-mismatched",
        `${spec.name} closes ${open.spec.name}, which expects ${open.spec.pairsWith}`,
        { part: framed.part, offset: record.offset }
      );
    }
  }

  for (const unclosed of stack.reverse()) {
    balanced = false;
    reporter.error(
      "scope-unclosed",
      `${unclosed.spec.name} is never closed by ${unclosed.spec.pairsWith}`,
      { part: framed.part, offset: unclosed.offset }
    );
  }

  return { root, balanced };
}
