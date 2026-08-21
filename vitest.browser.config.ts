import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { preferBrowserFilesPlugin } from "./src/utils/browser.js";

export default defineConfig({
  plugins: [preferBrowserFilesPlugin()],
  resolve: {
    tsconfigPaths: true
  },
  define: {
    global: "globalThis"
  },
  test: {
    globals: true,
    testTimeout: 30000,
    setupFiles: ["./src/test/browser/setup.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [
        {
          browser: "chromium"
        }
      ]
    },
    include: [
      // Platform/runtime browser tests (IIFE smoke, archive/stream native APIs).
      "src/modules/**/__tests__/browser/**/*.test.ts",
      "src/utils/__tests__/browser/**/*.test.ts",
      // Pure-computation modules: their node test suites are free of Node-only
      // APIs and disk fixtures, so we re-run them in a real browser to prove
      // the shipped logic behaves identically there. Node-stream / fixture
      // dependent files are excluded below.
      // `draw` is the shared drawing engine: display-list maths and string
      // building, with no platform API at all, so the browser must agree with
      // Node exactly.
      "src/modules/draw/**/__tests__/**/*.test.ts",
      "src/modules/xml/__tests__/**/*.test.ts",
      "src/modules/markdown/__tests__/**/*.test.ts",
      "src/modules/formula/**/__tests__/**/*.test.ts",
      "src/modules/word/**/__tests__/**/*.test.ts",
      // Excel in-memory suites (Workbook.toBuffer/read, styling, charts,
      // formulas, …). Tests that genuinely need the Node platform — disk I/O
      // (`Workbook.readFile`), Node `Buffer`/streams, the `getXlsxIo` Node
      // binding, system-font PNG rendering, the fileURLToPath-based validator
      // oracle — are named `*.node.test.ts` and skipped by the exclude below.
      "src/modules/excel/**/__tests__/**/*.test.ts"
    ],
    exclude: [
      // Formula's Excel-oracle reference suite reads fixture files from disk
      // (Node `fs`), so it cannot run in the browser.
      "src/modules/formula/__tests__/reference/**",
      // Node-only suites are marked with the `.node.test.ts` suffix.
      "src/modules/**/__tests__/**/*.node.test.ts",
      // Mixed files: mostly browser-safe but with a few individual Node-only
      // tests (system-font PNG, the `readFile` surface member, Node-stream XML
      // buffering). Run in Node only to avoid those few failures.
      "src/modules/excel/chart/__tests__/chart-builder-p1-p2.test.ts",
      "src/modules/excel/surface/__tests__/namespace-surface.test.ts",
      "src/modules/excel/stream/__tests__/worksheet-writer.test.ts"
    ]
  }
});
