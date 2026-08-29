/**
 * The IIFE bundle table — one entry per public module.
 *
 * This lives here rather than inside `rolldown.config.ts` so that something other
 * than the bundler can read it. Two classes of bug came from nothing being able to.
 *
 * Documentation drifted: an `unpkg` URL in the excel README named
 * `documonster.iife.min.js`, a whole-family bundle that has never existed, and the
 * snippet beneath it read `Workbook` off the root global instead of `Documonster.Excel`.
 * Both sat in an `html` fence, which `verify-doc-examples.ts` deliberately does not read
 * — it checks `ts` fences, because its mechanism is handing imports to `tsc`.
 *
 * And coverage drifted: `draw` and `mermaid` were published in `exports` with no bundle
 * of their own, so a script-tag consumer had no way to reach them at all, and nothing
 * recorded whether that was a decision or an oversight. It was an oversight.
 *
 * Two tests read this table:
 *
 * - `src/test/__tests__/iife-cdn-docs.node.test.ts` — every documented CDN URL names a
 *   bundle that exists, at the published version.
 * - `src/test/__tests__/iife-coverage.node.test.ts` — every top-level `exports` subpath
 *   has a bundle or an entry in {@link IIFE_EXEMPT_SUBPATHS}.
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
  { global: "Stream", file: "stream", input: "./src/modules/stream/index.browser.ts" },
  { global: "Draw", file: "draw", input: "./src/modules/draw/index.ts" },
  { global: "Mermaid", file: "mermaid", input: "./src/modules/mermaid/index.ts" }
];

/**
 * Public subpaths that deliberately ship no bundle of their own, and why.
 *
 * `src/test/__tests__/iife-coverage.node.test.ts` requires every top-level `exports`
 * subpath to appear either in {@link IIFE_BUNDLES} or here. Without that, a new module
 * simply never gets a script-tag path and nothing says whether that was a decision — which
 * is how `draw` and `mermaid` came to be public for several releases with no way to load
 * them without a bundler.
 *
 * Keep this list to subpaths a script-tag consumer can genuinely still reach. It is not a
 * place to park a module nobody got round to bundling.
 */
export const IIFE_EXEMPT_SUBPATHS: readonly { readonly subpath: string; readonly why: string }[] = [
  {
    subpath: "./chart",
    why: "the chart engine is excel's; its namespace already ships inside documonster.excel.iife.min.js as Documonster.Excel.Chart, so a second bundle would duplicate it"
  }
];
