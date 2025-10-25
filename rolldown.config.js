import { defineConfig } from "rolldown";
import fs from "fs";
import { visualizer } from "rollup-plugin-visualizer";
import nodePolyfills from "node-stdlib-browser";

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
const banner = `/*!
 * ${pkg.name} v${pkg.version}
 * ${pkg.description}
 * (c) ${new Date().getFullYear()} ${pkg.author.name}
 * Released under the ${pkg.license} License
 */`;

const browserPolyfills = {
  ...nodePolyfills,
  vm: false
};

const createAnalyzePlugin = (filename, open = false) =>
  process.env.ANALYZE
    ? [
        visualizer({
          filename,
          open,
          gzipSize: true,
          brotliSize: true
        })
      ]
    : [];

// Common config shared by both builds
const commonConfig = {
  input: "./src/index.browser.ts",
  external: ["@aws-sdk/client-s3"],
  platform: "browser",
  tsconfig: "./tsconfig.json",
  resolve: {
    alias: browserPolyfills
  },
  transform: {
    inject: {
      Buffer: ["buffer", "Buffer"],
      process: "process"
    }
  }
};

const copyLicensePlugin = {
  name: "copy-license",
  writeBundle() {
    if (!fs.existsSync("./dist")) {
      fs.mkdirSync("./dist", { recursive: true });
    }
    fs.copyFileSync("./LICENSE", "./dist/LICENSE");
  }
};

export default defineConfig([
  // Browser: excelts.iife.js (for development/debugging with <script> tag)
  {
    ...commonConfig,
    output: {
      dir: "./dist/browser",
      format: "iife",
      name: "ExcelTS",
      sourcemap: true,
      banner,
      exports: "named",
      entryFileNames: "excelts.iife.js"
    },
    plugins: [copyLicensePlugin, ...createAnalyzePlugin("./dist/stats-iife.html")]
  },
  // Browser: excelts.iife.min.js (for production with <script> tag)
  {
    ...commonConfig,
    output: {
      dir: "./dist/browser",
      format: "iife",
      name: "ExcelTS",
      sourcemap: false,
      banner,
      exports: "named",
      minify: true,
      entryFileNames: "excelts.iife.min.js"
    },
    plugins: createAnalyzePlugin("./dist/stats-iife-min.html", true)
  }
]);
