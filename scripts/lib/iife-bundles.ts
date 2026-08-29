/**
 * The IIFE bundle table — one entry per public module.
 *
 * This lives here rather than inside `rolldown.config.ts` so that something other
 * than the bundler can read it. Two documentation bugs came from nothing being able
 * to: an `unpkg` URL in the excel README named `documonster.iife.min.js`, a
 * whole-family bundle that has never existed, and the snippet beneath it read
 * `Workbook` off the root global instead of `Documonster.Excel`. Both sat in an
 * `html` fence, which `verify-doc-examples.ts` deliberately does not read — it
 * checks `ts` fences, because its mechanism is handing imports to `tsc`.
 *
 * `src/test/__tests__/iife-cdn-docs.node.test.ts` checks the documented URLs and
 * globals against this table, so a bundle that is renamed, added or removed fails
 * on the documents that still name the old one.
 */

export interface IifeBundle {
  /** Global namespace member under `Documonster`, e.g. `Documonster.Excel`. */
  readonly global: string;
  /** Bundle file basename, without extension or the `documonster.` prefix. */
  readonly file: string;
  /** Entry module — the browser entry where one exists, else the Node entry. */
  readonly input: string;
}

export const IIFE_BUNDLES: readonly IifeBundle[] = [
  { global: "Excel", file: "excel", input: "./src/modules/excel/index.browser.ts" },
  { global: "Word", file: "word", input: "./src/modules/word/index.ts" },
  { global: "Pdf", file: "pdf", input: "./src/modules/pdf/index.ts" },
  { global: "Csv", file: "csv", input: "./src/modules/csv/index.ts" },
  { global: "Markdown", file: "markdown", input: "./src/modules/markdown/index.ts" },
  { global: "Xml", file: "xml", input: "./src/modules/xml/index.ts" },
  { global: "Formula", file: "formula", input: "./src/modules/formula/index.ts" },
  { global: "Archive", file: "archive", input: "./src/modules/archive/index.browser.ts" },
  { global: "Stream", file: "stream", input: "./src/modules/stream/index.browser.ts" }
];
