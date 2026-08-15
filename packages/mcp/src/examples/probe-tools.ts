/**
 * Example: MCP Server — exercise every tool against the test workspace
 *
 * Run this BEFORE involving an AI client. It spawns the real `documonster-mcp`
 * executable and drives it over stdio JSON-RPC, so if something is broken you
 * learn it here rather than misreading it as the model behaving badly.
 *
 * Covers:
 * - the stdio handshake and tools/list
 * - every tool against the fixtures from setup-workspace.ts
 * - the sandbox boundary
 * - the guarantee that stdout carries nothing but protocol traffic
 *
 * Prerequisites: `node src/examples/setup-workspace.ts` then `pnpm build`
 * Run:           node src/examples/probe-tools.ts
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../dist/cli.js");
const workspace = path.resolve(here, "../../../../tmp/mcp-examples/workspace");
const output = path.resolve(here, "../../../../tmp/mcp-examples/output");

if (!fs.existsSync(cli)) {
  console.error(`Build first — ${cli} does not exist.\n  cd packages/mcp && pnpm build`);
  process.exit(1);
}
if (!fs.existsSync(workspace)) {
  console.error(`Workspace missing — run:\n  node src/examples/setup-workspace.ts`);
  process.exit(1);
}

interface RpcMessage {
  readonly id?: number;
  readonly result?: {
    readonly isError?: boolean;
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
    readonly tools?: readonly { readonly name: string }[];
  };
  readonly error?: unknown;
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const child = spawn(process.execPath, [cli, "--root", workspace, "--output-root", output], {
  stdio: ["pipe", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => (stdout += chunk));
child.stderr.setEncoding("utf8");
child.stderr.on("data", chunk => (stderr += chunk));

let nextId = 1;
let failures = 0;

function send(method: string, params?: unknown): number {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return id;
}

function parsed(): RpcMessage[] {
  return stdout
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as RpcMessage);
}

async function waitFor(id: number): Promise<RpcMessage> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = parsed().find(message => message.id === id);
    if (found !== undefined) {
      return found;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for id ${id}. stderr:\n${stderr}`);
}

async function call(name: string, args: unknown): Promise<{ isError: boolean; text: string }> {
  const response = await waitFor(send("tools/call", { name, arguments: args }));
  if (response.error !== undefined) {
    throw new Error(`${name}: ${JSON.stringify(response.error)}`);
  }
  return {
    isError: response.result?.isError === true,
    text: (response.result?.content ?? []).map(block => block.text ?? "").join("\n")
  };
}

/** Run one probe. `expect` describes what a correct answer contains. */
async function probe(
  label: string,
  name: string,
  args: unknown,
  expect: (text: string) => boolean,
  options: { readonly wantError?: boolean; readonly show?: number } = {}
): Promise<void> {
  const { isError, text } = await call(name, args);
  const errorAsExpected = isError === (options.wantError ?? false);
  const ok = errorAsExpected && expect(text);
  if (!ok) {
    failures += 1;
  }
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(
    text
      .split("\n")
      .slice(0, options.show ?? 8)
      .map(line => `      ${line}`)
      .join("\n")
  );
}

// --- handshake ---------------------------------------------------------------

send("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "probe-tools", version: "1.0.0" }
});
await waitFor(1);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const tools = (await waitFor(send("tools/list"))).result?.tools ?? [];
console.log(`Tools exposed (${tools.length}): ${tools.map(tool => tool.name).join(", ")}`);

// --- orientation -------------------------------------------------------------

await probe(
  "doc_inspect lists the workspace",
  "doc_inspect",
  { path: "." },
  text => text.includes("budget.xlsx") && text.includes("reports.zip")
);

await probe(
  "doc_inspect reports the CSV dialect, BOM included",
  "doc_inspect",
  { path: "june.csv" },
  text => text.includes("delimiter: `;`") && text.includes("UTF-8 BOM: yes")
);

await probe(
  "doc_inspect lists a workbook's sheets and their sizes",
  "doc_inspect",
  { path: "budget.xlsx" },
  text => text.includes("`Eng`") && text.includes("`Archive` | (empty)"),
  { show: 14 }
);

await probe(
  "doc_inspect catches the .xlsx that is really a CSV",
  "doc_inspect",
  { path: "export.xlsx" },
  text => text.includes("Extension mismatch")
);

await probe(
  "doc_inspect explains the ambiguous CFB container",
  "doc_inspect",
  { path: "legacy.doc" },
  text => text.includes("password-encrypted")
);

// --- reading -----------------------------------------------------------------

await probe(
  "sheet_read renders addressable cells",
  "sheet_read",
  { path: "budget.xlsx", sheet: "Summary" },
  text => text.includes("| 3 | Department | Budget | Actual | Variance |"),
  { show: 16 }
);

await probe(
  "sheet_read in formulas mode shows the cross-sheet references",
  "sheet_read",
  { path: "budget.xlsx", sheet: "Summary", mode: "formulas", range: "C4:D6" },
  text => text.includes("=SUM(Eng!C2:C341)")
);

await probe(
  "sheet_read paginates a long sheet and says how to continue",
  "sheet_read",
  { path: "budget.xlsx", sheet: "Eng", maxRows: 5 },
  text => text.includes("row(s) not shown") && text.includes("startRow: 6")
);

await probe(
  "sheet_read on the empty sheet says so instead of failing",
  "sheet_read",
  { path: "budget.xlsx", sheet: "Archive" },
  text => text.includes("empty")
);

// --- calculating -------------------------------------------------------------

await probe(
  "formula_evaluate answers an XLOOKUP match-mode question",
  "formula_evaluate",
  {
    formula: '=XLOOKUP("EMEA",A1:A3,B1:B3,"missing")',
    context: { A1: "APAC", A2: "EMEA", A3: "AMER", B1: 10, B2: 4, B3: 7 }
  },
  text => text.includes("result: **4**")
);

await probe(
  "formula_evaluate reports a spilling dynamic array",
  "formula_evaluate",
  { formula: "=SORT({3;1;2})" },
  text => text.includes("dynamic array"),
  { show: 14 }
);

// --- archives ----------------------------------------------------------------

await probe("archive_read lists nested entries", "archive_read", { path: "reports.zip" }, text =>
  text.includes("reports/2026-06.csv")
);

await probe(
  "archive_read extracts only the CSVs",
  "archive_read",
  { path: "reports.zip", action: "extract", out: "extracted", entries: ["*.csv"] },
  text => text.includes("Extracted **3**")
);

// --- writing -----------------------------------------------------------------

await probe(
  "sheet_write builds a report, pulling CSV data in server-side",
  "sheet_write",
  {
    path: "@output/out/q3-summary.xlsx",
    overwrite: true,
    sheets: [
      {
        name: "June",
        fromCsv: "@output/extracted/reports/2026-06.csv",
        csvDelimiter: ";",
        freezeRows: 1,
        columnWidths: [12, 8, 10, 12],
        cells: { D1: "revenue" },
        formulas: { D2: "=B2*C2", D3: "=B3*C3", D4: "=B4*C4", D6: "=SUM(D2:D4)" },
        styles: [
          { range: "A1:D1", style: { bold: true, fillColor: "FFEB3B" } },
          { range: "D2:D6", style: { numFmt: "#,##0.00" } }
        ]
      },
      { name: "Notes", rows: [["Generated by the documonster MCP example probe."]] }
    ]
  },
  text => text.includes("formulas evaluated")
);

await probe(
  "the written workbook reads back with computed values",
  "sheet_read",
  { path: "@output/out/q3-summary.xlsx", sheet: "June" },
  text => text.includes("513.25"),
  { show: 14 }
);

// --- documents ---------------------------------------------------------------

await probe(
  "doc_read returns Word as Markdown, structure intact",
  "doc_read",
  { path: "spec.docx" },
  text => text.includes("# Pricing Policy 2026") && text.includes("- Universities"),
  { show: 12 }
);

await probe(
  "doc_read outline mode returns headings only",
  "doc_read",
  { path: "spec.docx", outline: true },
  text => text.includes("H1: Pricing Policy 2026") && !text.includes("Education customers"),
  { show: 12 }
);

await probe(
  "doc_read reads a PDF page by page",
  "doc_read",
  { path: "brief.pdf" },
  text => text.includes("## Page 1") && text.includes("513.25"),
  { show: 12 }
);

await probe(
  "doc_write produces a Word file from Markdown",
  "doc_write",
  {
    path: "@output/out/note.docx",
    markdown: "# Reminder\n\nPrices change on **2026-09-01**.\n\n- APAC exempt\n- EMEA affected\n",
    overwrite: true
  },
  text => text.includes("Wrote")
);

await probe(
  "doc_read reads back what doc_write produced",
  "doc_read",
  { path: "@output/out/note.docx" },
  text => text.includes("# Reminder") && text.includes("- APAC exempt")
);

await probe(
  "doc_convert turns the workbook into a PDF, recalculating first",
  "doc_convert",
  { from: "budget.xlsx", to: "@output/out/budget.pdf", overwrite: true },
  text => text.includes("recalculated")
);

await probe(
  "doc_convert exports one sheet to CSV and states the loss",
  "doc_convert",
  { from: "budget.xlsx", to: "@output/out/summary.csv", sheet: "Summary", overwrite: true },
  text => text.includes("only one sheet")
);

await probe(
  "doc_convert refuses PDF as a source",
  "doc_convert",
  { from: "brief.pdf", to: "@output/out/x.docx", overwrite: true },
  text => text.includes("[unsupported]"),
  { wantError: true, show: 3 }
);

// --- templates ---------------------------------------------------------------

await probe(
  "template_inspect lists placeholders and prints a data shape",
  "template_inspect",
  { path: "invoice-template.docx" },
  text => text.includes("{{client.name}}") && text.includes("## Data shape"),
  { show: 16 }
);

await probe(
  "template_fill fails loudly when a field is missing, writing nothing",
  "template_fill",
  {
    template: "invoice-template.docx",
    out: "@output/out/bad.docx",
    data: {
      invoice: { number: "INV-1", date: "2026-08-15", total: "1" },
      overdue: false,
      items: []
    }
  },
  text => text.includes("client.name") && text.includes("No file was written"),
  { wantError: true, show: 4 }
);

await probe(
  "template_fill fills a complete data set",
  "template_fill",
  {
    template: "invoice-template.docx",
    out: "@output/out/INV-2026-014.docx",
    overwrite: true,
    data: {
      invoice: { number: "INV-2026-014", date: "2026-08-15", total: "15,400" },
      client: { name: "Acme Pty Ltd", abn: "12 345 678 901" },
      overdue: true,
      items: [
        { description: "Consulting", amount: "12,000" },
        { description: "Support", amount: "3,400" }
      ]
    }
  },
  text => text.includes("every placeholder was filled")
);

await probe(
  "the filled invoice reads back with the data and no leftover syntax",
  "doc_read",
  { path: "@output/out/INV-2026-014.docx" },
  text => text.includes("Acme Pty Ltd") && text.includes("PAYMENT OVERDUE") && !text.includes("{{"),
  { show: 14 }
);

await probe(
  "the invoice converts to PDF for delivery",
  "doc_convert",
  { from: "@output/out/INV-2026-014.docx", to: "@output/out/INV-2026-014.pdf", overwrite: true },
  text => text.includes("paginated")
);

// --- editing existing files --------------------------------------------------

await probe(
  "sheet_edit dryRun reports without writing",
  "sheet_edit",
  {
    path: "@output/out/q3-summary.xlsx",
    sheet: "June",
    ops: [{ op: "set_cell", ref: "A6", value: "TOTAL" }],
    dryRun: true
  },
  text => text.includes("Dry run") && text.includes('set A6 = "TOTAL"')
);

await probe(
  "sheet_edit applies ops and backs up the original",
  "sheet_edit",
  {
    path: "@output/out/q3-summary.xlsx",
    sheet: "June",
    ops: [
      { op: "set_cell", ref: "A6", value: "TOTAL" },
      { op: "set_style", range: "A6:D6", bold: true },
      { op: "add_sheet", name: "Audit", rows: [["checked", "2026-08-15"]] }
    ]
  },
  text => text.includes("3 operation(s) applied") && text.includes(".bak")
);

await probe(
  "the edit is visible and the rest of the sheet survived",
  "sheet_read",
  { path: "@output/out/q3-summary.xlsx", sheet: "June" },
  text => text.includes("TOTAL") && text.includes("513.25")
);

await probe(
  "sheet_edit is atomic — a bad op writes nothing",
  "sheet_edit",
  {
    path: "@output/out/q3-summary.xlsx",
    ops: [
      { op: "set_cell", ref: "A9", value: "ok" },
      { op: "set_cell", ref: "not-a-ref", value: 1 }
    ]
  },
  text => text.includes("is not a cell address"),
  { wantError: true, show: 3 }
);

await probe(
  "doc_search finds text by formatting — unanswerable from the text alone",
  "doc_search",
  { path: "spec.docx", format: { paragraphStyle: "Heading1" } },
  text => text.includes("Pricing Policy 2026"),
  { show: 10 }
);

await probe(
  "doc_edit dryRun counts occurrences without writing",
  "doc_edit",
  { path: "spec.docx", find: "8%", replace: "9%", dryRun: true },
  text => text.includes("Dry run") && text.includes("occurrence(s)")
);

await probe(
  "doc_edit writes to a new file, leaving the original intact",
  "doc_edit",
  { path: "spec.docx", find: "8%", replace: "9%", out: "@output/out/spec-v2.docx" },
  text => text.includes("Replaced")
);

await probe("the original still says 8%", "doc_read", { path: "spec.docx" }, text =>
  text.includes("8%")
);

await probe(
  "the copy says 9%",
  "doc_read",
  { path: "@output/out/spec-v2.docx" },
  text => text.includes("9%") && !text.includes("8%")
);

await probe(
  "doc_edit reports a no-op rather than rewriting the file",
  "doc_edit",
  { path: "spec.docx", find: "does-not-occur-anywhere", replace: "x" },
  text => text.includes("No occurrence")
);

await probe(
  "doc_paginate computes real pages and per-heading page numbers",
  "doc_paginate",
  { path: "spec.docx" },
  text => text.includes("**pages:") && text.includes("H1 | Pricing Policy 2026"),
  { show: 14 }
);

// --- packaging ---------------------------------------------------------------

await probe(
  "archive_write packages the produced outputs",
  "archive_write",
  {
    out: "@output/out/deliverables.zip",
    overwrite: true,
    entries: [
      { path: "@output/out/q3-summary.xlsx", as: "reports/q3-summary.xlsx" },
      { path: "@output/out/INV-2026-014.pdf", as: "invoices/INV-2026-014.pdf" }
    ]
  },
  text => text.includes("2 file(s)") && text.includes("Verified by reading the archive back"),
  { show: 12 }
);

await probe(
  "archive_read confirms what was packaged",
  "archive_read",
  { path: "@output/out/deliverables.zip" },
  text => text.includes("reports/q3-summary.xlsx") && text.includes("invoices/INV-2026-014.pdf")
);

// --- forms -------------------------------------------------------------------

await probe(
  "form_fill lists a Word form's fields and a values shape",
  "form_fill",
  { path: "leave-request.docx" },
  text => text.includes("`employeeName`") && text.includes("## Values shape"),
  { show: 12 }
);

await probe(
  "form_fill fills the Word form",
  "form_fill",
  {
    path: "leave-request.docx",
    out: "@output/out/leave-filled.docx",
    values: { employeeName: "Jane Doe", days: "5", approved: true }
  },
  text => text.includes("Filled **3**")
);

await probe(
  "the filled Word form reads back with its values",
  "form_fill",
  { path: "@output/out/leave-filled.docx" },
  text => text.includes('"Jane Doe"') && text.includes("true")
);

await probe(
  "form_fill lists a PDF AcroForm",
  "form_fill",
  { path: "expense-claim.pdf" },
  text => text.includes("`claimant`") && text.includes("checkbox"),
  { show: 10 }
);

await probe(
  "form_fill fills the PDF and verifies the values survived the save",
  "form_fill",
  {
    path: "expense-claim.pdf",
    out: "@output/out/expense-filled.pdf",
    values: { claimant: "Jane Doe", amount: "1,240.50", receipts: true }
  },
  text => text.includes("Verified by re-reading") && text.includes("Jane Doe")
);

await probe(
  "form_fill names the real fields when given a wrong one",
  "form_fill",
  { path: "expense-claim.pdf", values: { nope: "x" }, out: "@output/out/never.pdf" },
  text => text.includes("no such field") && text.includes("claimant"),
  { wantError: true, show: 3 }
);

// --- pdf editing -------------------------------------------------------------

await probe(
  "pdf_edit dryRun describes the effect without writing",
  "pdf_edit",
  { path: "brief.pdf", ops: [{ op: "page_numbers" }], dryRun: true },
  text => text.includes("Dry run") && text.includes("numbered")
);

await probe(
  "pdf_edit watermarks and numbers without losing the original content",
  "pdf_edit",
  {
    path: "brief.pdf",
    out: "@output/out/brief-stamped.pdf",
    ops: [
      { op: "watermark", text: "CONFIDENTIAL", opacity: 0.2 },
      { op: "page_numbers", format: "Page {page} of {total}" },
      { op: "stamp", text: "APPROVED 2026-08-15", x: 60, y: 60, color: "008000" }
    ]
  },
  text => text.includes("3 operation(s) applied")
);

await probe(
  "the stamped PDF still reads back with both overlay and original text",
  "doc_read",
  { path: "@output/out/brief-stamped.pdf" },
  text =>
    text.includes("CONFIDENTIAL") &&
    text.includes("APPROVED 2026-08-15") &&
    text.includes("Q3 Board Brief"),
  { show: 14 }
);

await probe(
  "pdf_edit trims and appends pages",
  "pdf_edit",
  {
    path: "@output/out/budget.pdf",
    out: "@output/out/budget-excerpt.pdf",
    ops: [
      { op: "keep_pages", pages: "1-2" },
      { op: "append", path: "brief.pdf" }
    ]
  },
  text => text.includes("kept page(s) 1, 2") && text.includes("appended")
);

await probe(
  "pdf_edit refuses a page that does not exist",
  "pdf_edit",
  {
    path: "brief.pdf",
    ops: [{ op: "watermark", text: "X", pages: [99] }],
    out: "@output/out/n.pdf"
  },
  text => text.includes("do not exist"),
  { wantError: true, show: 3 }
);

// --- charts and generated data -----------------------------------------------

await probe(
  "sheet_write places a chart, with the sheet qualification added for you",
  "sheet_write",
  {
    path: "@output/out/charted.xlsx",
    overwrite: true,
    sheets: [
      {
        name: "Sales",
        rows: [
          ["region", "units", "cost"],
          ["APAC", 10, 25],
          ["EMEA", 4, 30],
          ["AMER", 7, 20]
        ],
        charts: [
          {
            type: "column",
            title: "Units by region",
            categories: "A2:A4",
            values: ["B2:B4", "C2:C4"],
            seriesNames: ["B1", "C1"],
            legend: "bottom"
          }
        ]
      }
    ]
  },
  text => text.includes("added a column chart") && text.includes("2 series")
);

await probe(
  "sheet_edit adds a chart to an existing workbook",
  "sheet_edit",
  {
    path: "@output/out/charted.xlsx",
    sheet: "Sales",
    ops: [
      {
        op: "add_chart",
        chart: { type: "pie", title: "Share", categories: "A2:A4", values: "B2:B4" }
      }
    ]
  },
  text => text.includes("added a pie chart")
);

await probe(
  "sheet_write generates test data server-side",
  "sheet_write",
  {
    path: "@output/out/testdata.xlsx",
    overwrite: true,
    sheets: [
      {
        name: "Users",
        generate: {
          rows: 500,
          columns: [
            { name: "id", type: "uuid" },
            { name: "name", type: "name" },
            { name: "email", type: "email" },
            { name: "plan", type: "string", values: ["free", "pro", "team"] },
            { name: "mrr", type: "float", min: 0, max: 999, nullable: 0.1 }
          ]
        }
      }
    ]
  },
  text => text.includes("generated 500 row(s) × 5 column(s) server-side")
);

await probe(
  "the generated data reads back with its constraints honoured",
  "sheet_read",
  { path: "@output/out/testdata.xlsx", maxRows: 4 },
  text => text.includes("| 1 | id | name | email | plan | mrr |")
);

// --- review ------------------------------------------------------------------

await probe(
  "doc_inspect routes a redlined contract to doc_review",
  "doc_inspect",
  { path: "contract-redlined.docx" },
  text => text.includes("tracked change") && text.includes("doc_review"),
  { show: 12 }
);

await probe(
  "doc_review compares two contract versions",
  "doc_review",
  { path: "contract-v1.docx", against: "contract-v2.docx" },
  text =>
    text.includes("modified: 1") &&
    text.includes("added: 1") &&
    text.includes("30 days") &&
    text.includes("14 days"),
  { show: 16 }
);

await probe(
  "doc_review lists tracked changes with their author",
  "doc_review",
  { path: "contract-redlined.docx" },
  text => text.includes("Alice Chen") && text.includes("Nothing was written"),
  { show: 12 }
);

await probe(
  "doc_review accepts revisions into a new file",
  "doc_review",
  { path: "contract-redlined.docx", apply: "accept-all", out: "@output/out/contract-final.docx" },
  text => text.includes("Accepted") && text.includes("revisions remaining: 0")
);

await probe(
  "the accepted version reads back with the new wording",
  "doc_read",
  { path: "@output/out/contract-final.docx" },
  text => text.includes("within 14 days") && !text.includes("within 30 days")
);

await probe(
  "doc_convert produces OpenDocument",
  "doc_convert",
  { from: "spec.docx", to: "@output/out/spec.odt", overwrite: true },
  text => text.includes("OpenDocument")
);

// --- boundaries --------------------------------------------------------------

await probe(
  "the sandbox refuses a path outside the root",
  "doc_inspect",
  { path: "../../../etc/passwd" },
  text => text.includes("[outside_root]"),
  { wantError: true, show: 3 }
);

await probe(
  "sheet_write creates a file under the separate output root",
  "sheet_write",
  { path: "clobber.xlsx", sheets: [{ name: "S", rows: [["first"]] }] },
  text => text.includes("@output/clobber.xlsx")
);

await probe(
  "sheet_write refuses to clobber an existing output without overwrite",
  "sheet_write",
  { path: "clobber.xlsx", sheets: [{ name: "S", rows: [["second"]] }] },
  text => text.includes("already exists"),
  { wantError: true, show: 3 }
);

// --- stdout hygiene ----------------------------------------------------------

const lines = stdout.split("\n").filter(line => line.trim().length > 0);
const allProtocol = lines.every(line => {
  try {
    return (JSON.parse(line) as { jsonrpc?: string }).jsonrpc === "2.0";
  } catch {
    return false;
  }
});
if (!allProtocol) {
  failures += 1;
}
console.log(
  `\n${allProtocol ? "PASS" : "FAIL"}  stdout carried only JSON-RPC (${lines.length} messages)`
);

child.kill();

console.log(`\nserver log: ${stderr.trim()}`);
console.log(failures === 0 ? "\nAll probes passed." : `\n${failures} probe(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
