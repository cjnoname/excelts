/**
 * Framing check: is this a readable record stream at all?
 *
 * Runs before every other check, because none of them mean anything on a part whose
 * record boundaries cannot be found. A payload length that overruns the part does
 * not just corrupt that record — it desynchronises the walk, so every "record" after
 * it is bytes read from the middle of something else, and a scope or index check
 * would then report a cascade of invented problems.
 */

import { XlsbParseError } from "@excel/errors";
import type { XlsbReporter } from "@excel/utils/xlsb-validator/reporter";
import { iterateInterpretableRecords, type BiffRecord } from "@excel/xlsb/binary";
import { OBSERVED_PAYLOAD_SIZES, recordSpec } from "@excel/xlsb/spec/records";

export interface FramedPart {
  readonly part: string;
  readonly records: readonly BiffRecord[];
  /** False when the walk stopped early; later checks then skip this part. */
  readonly complete: boolean;
  readonly unknownRecordCount: number;
}

/**
 * Walk a part, reporting the first framing failure and stopping there.
 *
 * Stopping is deliberate. Once a length is wrong the reader is no longer aligned to
 * a record boundary, so continuing produces noise that buries the one real problem.
 */
export function checkFraming(bytes: Uint8Array, part: string, reporter: XlsbReporter): FramedPart {
  if (bytes.length === 0) {
    reporter.error("framing-empty-part", "part is empty", { part });
    return { part, records: [], complete: false, unknownRecordCount: 0 };
  }

  const records: BiffRecord[] = [];
  let unknownRecordCount = 0;
  try {
    for (const record of iterateInterpretableRecords(bytes, part)) {
      records.push(record);
      const spec = recordSpec(record.id);
      if (!spec) {
        unknownRecordCount++;
        continue;
      }
      // A record of the wrong length is perfectly consistent with itself, which is why every other
      // check here is blind to it — and three such records shipped, each producing a package this
      // validator accepted and Excel refused. The lengths come from Excel's own output, and only
      // for the records whose length never varies there.
      const expected = OBSERVED_PAYLOAD_SIZES.get(spec.name);
      if (expected !== undefined && record.payload.length !== expected) {
        reporter.error(
          "framing-unexpected-payload-size",
          `${spec.name} is ${record.payload.length} byte(s); every Excel-authored one is ${expected}`,
          { part, offset: record.offset }
        );
      }
    }
  } catch (cause) {
    if (!(cause instanceof XlsbParseError)) {
      throw cause;
    }
    const offset = records.length > 0 ? lastRecordEnd(records[records.length - 1]!, bytes) : 0;
    const kind = /truncated record (id|length)/.test(cause.message)
      ? "framing-truncated-header"
      : "framing-payload-overrun";
    reporter.error(kind, cause.message, { part, offset });
    return { part, records, complete: false, unknownRecordCount };
  }

  return { part, records, complete: true, unknownRecordCount };
}

function lastRecordEnd(record: BiffRecord, bytes: Uint8Array): number {
  return record.payload.byteOffset - bytes.byteOffset + record.payload.length;
}
