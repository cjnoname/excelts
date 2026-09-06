/**
 * The formula a conditional-formatting rule needs when the caller did not write one.
 *
 * Several rule types are *specified* in terms of a formula that the file must carry even though the caller
 * expressed the intent some other way: `containsText` with a `text` attribute still needs
 * `NOT(ISERROR(SEARCH("…",A1)))` in the file, and every `timePeriod` rule needs the arithmetic that decides
 * what "last week" means. Excel writes these; a file without them has a rule that never fires.
 *
 * ## Why this is its own module
 *
 * It was inside `cf-rule-xform.ts`, reachable only from the XML writer, and the XLSB writer therefore emitted
 * those rules with `cbFmla1 = 0`. Excel's own `BrtBeginCFRule` for the same rule is 82 bytes against this
 * library's 50, and the 32 missing bytes are exactly the formula — so a `containsText` rule written to XLSB
 * looked complete, matched on nothing, and reported no loss.
 *
 * One list, two containers. A second copy of "what `lastWeek` means" is the shape of mistake this repository
 * has paid for repeatedly: the two would agree until one of them was edited.
 */
import { rangeCreate, rangeTl } from "@excel/core/range";

/** The fields a rule has to expose for its formula to be derived. */
export interface ConditionalRuleLike {
  readonly type?: string;
  readonly operator?: string;
  readonly text?: string;
  readonly timePeriod?: string;
  readonly ref?: string;
  readonly formulae?: readonly unknown[];
}

/** The rule's own formula, when it has one. */
function stated(rule: ConditionalRuleLike): string | undefined {
  const first = rule.formulae?.[0];
  return typeof first === "string" && first !== "" ? first : undefined;
}

/**
 * The top-left cell of the rule's range, which every derived formula is written relative to.
 *
 * Excel writes the formula against the first cell and applies it to the rest by offset, which is why the
 * binary form stores it as a relative `PtgRefN`.
 */
function topLeft(rule: ConditionalRuleLike): string | undefined {
  return rule.ref === undefined ? undefined : rangeTl(rangeCreate(rule.ref));
}

/** The formula for the text-matching family, or `undefined` when the operator has none. */
export function textRuleFormula(rule: ConditionalRuleLike): string | undefined {
  const own = stated(rule);
  if (own !== undefined) {
    return own;
  }
  const tl = topLeft(rule);
  if (tl === undefined) {
    return undefined;
  }
  switch (rule.operator) {
    case "containsText":
      return `NOT(ISERROR(SEARCH("${rule.text ?? ""}",${tl})))`;
    case "notContainsText":
      return `ISERROR(SEARCH("${rule.text ?? ""}",${tl}))`;
    case "beginsWith":
      return `LEFT(${tl},LEN("${rule.text ?? ""}"))="${rule.text ?? ""}"`;
    case "endsWith":
      return `RIGHT(${tl},LEN("${rule.text ?? ""}"))="${rule.text ?? ""}"`;
    case "containsBlanks":
      return `LEN(TRIM(${tl}))=0`;
    case "notContainsBlanks":
      return `LEN(TRIM(${tl}))>0`;
    case "containsErrors":
      return `ISERROR(${tl})`;
    case "notContainsErrors":
      return `NOT(ISERROR(${tl}))`;
    default:
      return undefined;
  }
}

/** The formula for a `timePeriod` rule, or `undefined` when the period has none. */
export function timePeriodRuleFormula(rule: ConditionalRuleLike): string | undefined {
  const own = stated(rule);
  if (own !== undefined) {
    return own;
  }
  const tl = topLeft(rule);
  if (tl === undefined) {
    return undefined;
  }
  switch (rule.timePeriod) {
    case "thisWeek":
      return `AND(TODAY()-ROUNDDOWN(${tl},0)<=WEEKDAY(TODAY())-1,ROUNDDOWN(${tl},0)-TODAY()<=7-WEEKDAY(TODAY()))`;
    case "lastWeek":
      return `AND(TODAY()-ROUNDDOWN(${tl},0)>=(WEEKDAY(TODAY())),TODAY()-ROUNDDOWN(${tl},0)<(WEEKDAY(TODAY())+7))`;
    case "nextWeek":
      return `AND(ROUNDDOWN(${tl},0)-TODAY()>(7-WEEKDAY(TODAY())),ROUNDDOWN(${tl},0)-TODAY()<(15-WEEKDAY(TODAY())))`;
    case "yesterday":
      return `FLOOR(${tl},1)=TODAY()-1`;
    case "today":
      return `FLOOR(${tl},1)=TODAY()`;
    case "tomorrow":
      return `FLOOR(${tl},1)=TODAY()+1`;
    case "last7Days":
      return `AND(TODAY()-FLOOR(${tl},1)<=6,FLOOR(${tl},1)<=TODAY())`;
    case "lastMonth":
      return `AND(MONTH(${tl})=MONTH(EDATE(TODAY(),0-1)),YEAR(${tl})=YEAR(EDATE(TODAY(),0-1)))`;
    case "thisMonth":
      return `AND(MONTH(${tl})=MONTH(TODAY()),YEAR(${tl})=YEAR(TODAY()))`;
    case "nextMonth":
      return `AND(MONTH(${tl})=MONTH(EDATE(TODAY(),0+1)),YEAR(${tl})=YEAR(EDATE(TODAY(),0+1)))`;
    default:
      return undefined;
  }
}

/**
 * The formula for any rule that derives one, or `undefined`.
 *
 * The `containsText` family arrives with `type` collapsed onto `containsText` and the real kind moved into
 * `operator` — that is what the XML writer's `opType` does — so both spellings are accepted here rather than
 * making each caller normalise first.
 */
export function derivedRuleFormula(rule: ConditionalRuleLike): string | undefined {
  const TEXT_KINDS = new Set([
    "containsText",
    "notContainsText",
    "beginsWith",
    "endsWith",
    "containsBlanks",
    "notContainsBlanks",
    "containsErrors",
    "notContainsErrors"
  ]);
  if (rule.type === "timePeriod") {
    return timePeriodRuleFormula(rule);
  }
  if (TEXT_KINDS.has(rule.type ?? "") || TEXT_KINDS.has(rule.operator ?? "")) {
    return textRuleFormula({
      ...rule,
      // When the kind is still in `type`, it is also the operator the switch above keys on.
      operator: TEXT_KINDS.has(rule.operator ?? "") ? rule.operator : rule.type
    });
  }
  return stated(rule);
}
