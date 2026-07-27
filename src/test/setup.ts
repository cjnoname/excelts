/**
 * Vitest global setup.
 *
 * Nothing to wire up: the toolkit has no install / registration steps.
 *
 * - Defined-name classification (formula vs. opaque) during XLSX load uses the
 *   built-in tokenizer+parser probe in `@excel/defined-names` directly.
 * - Formula evaluation: import `calculateFormulas` from `@excel/bridge/formula`.
 * - Chart support: the chart implementation is imported statically by the
 *   high-level chart APIs and tree-shaken out of builds that never use it.
 */

export {};
