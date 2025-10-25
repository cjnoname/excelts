import { beforeAll } from "vitest";

beforeAll(async () => {
  const script = document.createElement("script");
  script.src = "/dist/browser/excelts.iife.min.js";

  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = e => {
      console.error("Failed to load ExcelTS:", e);
      reject(e);
    };
    document.head.appendChild(script);
  });

  console.log("ExcelTS loaded:", typeof (globalThis as any).ExcelTS);
});
