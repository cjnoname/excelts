/**
 * Turning a record name into a record.
 *
 * One function, and it is the only way a record is created in this directory. That is the whole
 * point: the id comes from the spec table, so a field written anywhere here cannot disagree with the
 * field the disassembler and the validator read. A numeric id at the call site would let a writer emit
 * something the spec table does not describe — the one way a part can be malformed that neither the
 * validator nor the disassembler could then explain.
 */
import { requireRecordSpec } from "@excel/xlsb/spec/records";

/** A record on its way into a part: an id resolved from the spec table, and its payload. */
export interface Emitted {
  readonly id: number;
  readonly payload?: Uint8Array;
}

/** Resolve a record name to its id and pair it with a payload. */
export function record(name: string, payload?: Uint8Array): Emitted {
  const spec = requireRecordSpec(name);
  return payload === undefined ? { id: spec.id } : { id: spec.id, payload };
}
