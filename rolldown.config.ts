import fs from "node:fs";

import { defineConfig } from "rolldown";
import { visualizer } from "rollup-plugin-visualizer";

import { IIFE_BUNDLES } from "./scripts/lib/iife-bundles";
import { preferBrowserFilesPlugin } from "./src/utils/browser";

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf-8"));

/**
 * Repository inception year. Deliberately a constant, not `new Date()`: the
 * banner is part of every bundle's bytes, and a live year would make an
 * otherwise byte-reproducible build differ across a new year's eve.
 */
const COPYRIGHT_YEAR = 2025;

/**
 * `banner` opens an outer function and `footer` closes it with `.call(globalThis)`.
 *
 * The generated IIFE prelude installs the shared namespace as `this.Documonster`,
 * and `this` at the top level of a file is only the global object in a classic
 * `<script>` — it is `undefined` in an ES module and in any strict-mode host
 * (`import`ing the bundle through a tool, `new Function("'use strict'", …)`,
 * a module worker), where the bundle would throw before exporting anything.
 * Binding the wrapper's `this` makes the target explicit instead of ambient.
 * `globalThis` needs no fallback: every browser in the support matrix has it.
 */
const banner = `/*!
 * ${pkg.name} v${pkg.version}
 * ${pkg.description}
 * (c) ${COPYRIGHT_YEAR} ${pkg.author.name}
 * Released under the ${pkg.license} License
 */
(function () {`;
const footer = `}).call(globalThis);`;

// One IIFE bundle per public module. Each exposes its module namespace under
// a shared `Documonster` global (e.g. `Documonster.Excel.Workbook.create()`),
// so CDN consumers load only the script(s) they need — there is no
// whole-family bundle. Browser version has NO Node.js polyfills.
//
// The table itself lives in `scripts/lib/iife-bundles.ts` so the documentation
// gate can read it without loading the bundler; `input` points at each module's
// browser entry when it has one, else its Node entry (pure modules resolve
// identically in the browser). The `preferBrowserFilesPlugin` swaps
// `*.browser.ts` variants at bundle time.

const copyLicensePlugin = {
  name: "copy-license",
  writeBundle() {
    if (!fs.existsSync("./dist/iife")) {
      fs.mkdirSync("./dist/iife", { recursive: true });
    }
    fs.copyFileSync("./LICENSE", "./dist/iife/LICENSE");
    fs.copyFileSync("./THIRD_PARTY_NOTICES.md", "./dist/iife/THIRD_PARTY_NOTICES.md");
  }
};

const analyze = process.env.ANALYZE === "true";

const common = (input: string) => ({
  input,
  platform: "browser" as const,
  tsconfig: "./tsconfig.json",
  treeshake: {
    moduleSideEffects: false
  },
  plugins: [preferBrowserFilesPlugin()]
});

export default defineConfig(
  IIFE_BUNDLES.flatMap(({ global, file, input }, i) => {
    const analyzePlugins =
      analyze && i === 0
        ? [
            visualizer({
              filename: "./dist/stats.html",
              open: false,
              gzipSize: true,
              brotliSize: true,
              template: "treemap"
            })
          ]
        : [];
    return [
      {
        ...common(input),
        output: {
          dir: "./dist/iife",
          format: "iife" as const,
          name: `Documonster.${global}`,
          extend: true,
          sourcemap: true,
          banner,
          footer,
          exports: "named" as const,
          entryFileNames: `documonster.${file}.iife.js`
        },
        plugins: [...common(input).plugins, copyLicensePlugin, ...analyzePlugins]
      },
      {
        ...common(input),
        output: {
          dir: "./dist/iife",
          format: "iife" as const,
          name: `Documonster.${global}`,
          extend: true,
          sourcemap: false,
          banner,
          footer,
          exports: "named" as const,
          minify: true,
          entryFileNames: `documonster.${file}.iife.min.js`
        },
        plugins: [...common(input).plugins, copyLicensePlugin]
      }
    ];
  })
);
