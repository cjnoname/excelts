// Type-only regression test for the browser-entry workbook shape.
//
// Both `excelToPdf` and `excelToDocx` are exposed under the browser entry. They
// must accept the *browser* `Workbook` (the public class browser users get from
// `import { Workbook } from "documonster/excel"`). Before the fix the
// bridge files imported `Workbook` from the Node alias `@excel/workbook`, so
// the parameter type required Node-only `xlsx.readFile` / `writeFile` and
// browser callers got the mismatch:
//
//     workbook.browser.Workbook is not assignable to workbook.Workbook
//     XLSX missing readFile, writeFile
//
// This file is typechecked by `pnpm type` (tsgo) but is NOT executed by Vitest.

import type { Workbook as NodeWorkbook } from "@excel/core/workbook";
import type { Workbook as BrowserWorkbook } from "@excel/core/workbook.browser";
import { excelToPdf } from "@pdf/excel-bridge";
import { excelToDocx } from "@word/bridge/excel-bridge";

declare const browserWb: BrowserWorkbook;
declare const nodeWb: NodeWorkbook;

// Browser users (BrowserWorkbook) must be accepted directly by both bridges.
// If either bridge regresses to importing Workbook from `@excel/workbook`,
// the `xlsx` property's `XLSX` vs `XLSX<Workbook>` shape mismatch surfaces
// here as a TS2345 error.
void excelToPdf(browserWb);
void excelToDocx(browserWb);

// Node users (NodeWorkbook) must keep working — the Node subclass extends
// the browser base, so passing a Node Workbook to a browser-typed parameter
// is plain Liskov substitution.
void excelToPdf(nodeWb);
void excelToDocx(nodeWb);
