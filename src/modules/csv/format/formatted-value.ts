/**
 * Formatted value wrapper for controlling field-level quoting in CSV output.
 *
 * This module provides helper functions to override the global quoting behavior
 * for individual field values during CSV formatting.
 *
 * @module
 */

/**
 * Symbol to identify FormattedValue instances.
 * Using Symbol.for ensures reliable detection across module boundaries.
 */
const FORMATTED_VALUE_SYMBOL: unique symbol = Symbol.for("csv.FormattedValue");

/**
 * Wrapper type for CSV field values with explicit quoting control.
 * Created via `quoted()` and `unquoted()` helper functions.
 */
export interface FormattedValue {
  readonly [FORMATTED_VALUE_SYMBOL]: true;
  /** The string value to output */
  readonly value: string;
  /** Quoting control: true = force quote, false = prevent quote */
  readonly quote: boolean;
}

/**
 * Check if a value is a FormattedValue instance.
 */
export function isFormattedValue(value: unknown): value is FormattedValue {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<typeof FORMATTED_VALUE_SYMBOL, unknown>)[FORMATTED_VALUE_SYMBOL] === true
  );
}

/**
 * Mark a value to be output with quotes.
 *
 * Use this in a transform function to force quoting for specific fields,
 * regardless of the global `quoteColumns` setting.
 *
 * @param value - The string value to output
 * @returns A FormattedValue that will be quoted in the CSV output
 *
 * @example
 * ```ts
 * import { Csv } from "documonster/csv";
 *
 * formatCsv(data, {
 *   transform: {
 *     // Force quoting for code-like fields, and quote empty strings
 *     string: (v, ctx) => {
 *       if (ctx.column === "code") return Csv.quoted(v);
 *       if (v === "") return Csv.quoted(v);
 *       return v;
 *     }
 *   }
 * });
 * ```
 */
export function quoted(value: string): FormattedValue {
  return { [FORMATTED_VALUE_SYMBOL]: true, value, quote: true };
}

/**
 * Mark a value to be output without quotes.
 *
 * Use this in a transform function to prevent quoting for specific fields,
 * even when the value would normally be quoted (e.g., contains delimiter).
 *
 * WARNING: Using unquoted() with values containing delimiters or newlines
 * will produce invalid CSV. Use only when you need raw output like Excel formulas.
 *
 * @param value - The string value to output (will not be quoted or escaped)
 * @returns A FormattedValue that will NOT be quoted in the CSV output
 *
 * @example
 * ```ts
 * import { Csv } from "documonster/csv";
 *
 * formatCsv(data, {
 *   transform: {
 *     // Output Excel formula without outer quotes
 *     number: (v, ctx) => ctx.column === "id"
 *       ? Csv.unquoted(`="${v}"`)  // Outputs: ="7"
 *       : String(v)
 *   }
 * });
 * ```
 */
export function unquoted(value: string): FormattedValue {
  return { [FORMATTED_VALUE_SYMBOL]: true, value, quote: false };
}
