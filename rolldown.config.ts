import fs from "node:fs";

import { defineConfig } from "rolldown";
import { visualizer } from "rollup-plugin-visualizer";

import { preferBrowserFilesPlugin } from "./src/utils/browser";

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
const banner = `/*!
 * ${pkg.name} v${pkg.version}
 * ${pkg.description}
 * (c) ${new Date().getFullYear()} ${pkg.author.name}
 * Released under the ${pkg.license} License
 */`;

// One IIFE bundle per public module. Each exposes its module namespace under
// a shared `Documonster` global (e.g. `Documonster.Excel.Workbook.create()`),
// so CDN consumers load only the script(s) they need — there is no
// whole-family bundle. Browser version has NO Node.js polyfills.
//
// `input` points at each module's browser entry when it has one, else its
// Node entry (pure modules resolve identically in the browser). The
// `preferBrowserFilesPlugin` swaps `*.browser.ts` variants at bundle time.
interface ModuleBundle {
  /** Global namespace member under `Documonster`. */
  global: string;
  /** Bundle file basename (without extension). */
  file: string;
  /** Entry module. */
  input: string;
}

const MODULES: ModuleBundle[] = [
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
  MODULES.flatMap(({ global, file, input }, i) => {
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
          exports: "named" as const,
          minify: true,
          entryFileNames: `documonster.${file}.iife.min.js`
        },
        plugins: [...common(input).plugins, copyLicensePlugin]
      }
    ];
  })
);
