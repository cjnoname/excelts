/**
 * `Range` namespace surface — geometric range helpers plus range reads.
 *
 * `import { Range } from "documonster/excel"` → `Range.create("A1:B2")`,
 * `Range.contains(r, "A1")`, `Range.getValues(ws, "G7:H19")`.
 */
export {
  rangeCreate as create,
  rangeContains as contains,
  rangeContainsEx as containsCell,
  rangeIntersects as intersects,
  rangeForEachAddress as forEachAddress,
  rangeExpand as expand,
  rangeExpandToAddress as expandToAddress,
  rangeToString as toString,
  rangeCount as count
} from "@excel/core/range";

export { getRangeValues as getValues } from "@excel/core/worksheet-core";

/** A range handle. */
export type { RangeData as Handle } from "@excel/core/range";
