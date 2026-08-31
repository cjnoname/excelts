/**
 * BIFF12 validation as a vitest assertion.
 *
 * The counterpart to `expect-valid-xlsx.ts`, and it exists for the same reason: once a
 * writer exists, every test that produces bytes should assert they are structurally
 * sound, and that only happens if asserting it is one line. Without this, tests
 * hand-roll `report.ok` checks and the failure output is a boolean.
 *
 * Both entry points are wrapped, because the two are used at different times. A part
 * assertion is what a unit test for one record stream wants; a package assertion is
 * what a round-trip test wants.
 */

import { validateXlsbBuffer, validateXlsbPart } from "@excel/utils/xlsb-validator";
import type { XlsbValidateOptions, XlsbValidationReport } from "@excel/utils/xlsb-validator/types";
import { describeBiffStream } from "@test/biff-dump";
import { expect } from "vitest";

export interface ExpectValidXlsbOptions extends XlsbValidateOptions {
  /** Prefix for the failure message, when a test checks several packages. */
  readonly label?: string;
}

/** Assert that an XLSB package has no error-severity problems. */
export async function expectValidXlsb(
  buffer: ArrayBuffer | Uint8Array,
  options: ExpectValidXlsbOptions = {}
): Promise<void> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const { label, ...validateOptions } = options;
  report(await validateXlsbBuffer(bytes, { maxProblems: 50, ...validateOptions }), label);
}

/**
 * Assert that one `.bin` part has no error-severity problems.
 *
 * On failure the part is disassembled into the message. That is the whole reason the
 * disassembler was built first: a report saying "BrtBeginSheetData is never closed at
 * byte 41" is useful, and a report that also shows the record listing around it is
 * usually enough to fix the bug without opening a debugger.
 */
export function expectValidXlsbPart(
  bytes: Uint8Array,
  part: string,
  options: ExpectValidXlsbOptions = {}
): void {
  const { label, ...validateOptions } = options;
  report(
    validateXlsbPart(bytes, part, { maxProblems: 50, ...validateOptions }),
    label ?? part,
    bytes
  );
}

function report(result: XlsbValidationReport, label?: string, bytes?: Uint8Array): void {
  if (result.ok) {
    return;
  }
  const header = label ? `[${label}] BIFF12 validation failed:` : "BIFF12 validation failed:";
  const formatted = result.problems
    .map(
      (problem, index) =>
        `  ${index + 1}. [${problem.severity}] ${problem.kind} @ ` +
        `${problem.part ?? "<package>"}${problem.offset === undefined ? "" : `+${problem.offset}`}` +
        `\n     ${problem.message}`
    )
    .join("\n");

  let listing = "";
  if (bytes) {
    try {
      listing = `\n\nRecords:\n${indent(describeBiffStream(bytes))}`;
    } catch {
      // The stream is too broken to disassemble, which the problem list already says.
    }
  }

  expect.fail(`${header}\n${formatted}${listing}\n\nStats: ${JSON.stringify(result.stats)}`);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map(line => `  ${line}`)
    .join("\n");
}
