/**
 * Example: MCP Server — build a test workspace for a real AI client
 *
 * The other modules' examples produce a document. This one produces a
 * *workspace*: a directory of deliberately awkward files, plus the client
 * configuration needed to point an AI assistant at it. The thing being
 * exercised is not an API but a model's ability to drive the tools correctly.
 *
 * Covers, as probes:
 * - reports.zip        — archive entry point, nested paths, selective extraction
 * - budget.xlsx        — multi-sheet, formulas, merges, number formats, an empty sheet
 * - budget.xlsx "Eng"  — 340 rows, to force pagination rather than a full read
 * - inventory.csv      — 5 000 generated rows, large enough that reading it all is wrong
 * - june.csv           — semicolon-delimited, CRLF, UTF-8 BOM: dialect detection
 * - export.xlsx        — actually a CSV: extension-mismatch detection
 * - legacy.doc         — CFB container: the ambiguous legacy/encrypted case
 * - spec.docx          — a real Word file with NO tool to read it, on purpose:
 *                        probes whether the model admits the gap instead of guessing
 *
 * Output: tmp/mcp-examples/workspace/
 * Run:    node src/examples/setup-workspace.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ArchiveFile } from "documonster/archive";
import { Csv } from "documonster/csv";
import { Cell, Workbook, Worksheet } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";
import { Pdf } from "documonster/pdf";
import { Build, Document, Io } from "documonster/word";
import { markdownToDocx } from "documonster/word/markdown";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/mcp-examples/workspace"
);
const output = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/mcp-examples/output"
);

fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(output, { recursive: true, mode: 0o700 });

// =============================================================================
// 1. Monthly CSVs inside a ZIP — semicolon separated, CRLF, with a BOM.
//
// This is what a European or Chinese Windows export actually looks like, and
// getting the delimiter wrong collapses every row into a single column. The
// model has to call doc_inspect to find out rather than assuming a comma.
// =============================================================================

function monthlyCsv(rows: readonly (readonly [string, number, number])[]): string {
  const header = "region;units;price\r\n";
  const body = rows.map(([region, units, price]) => `${region};${units};${price}`).join("\r\n");
  return `\uFEFF${header}${body}\r\n`;
}

const months = {
  "2026-06": monthlyCsv([
    ["APAC", 10, 25.5],
    ["EMEA", 4, 30],
    ["AMER", 7, 19.75]
  ]),
  "2026-07": monthlyCsv([
    ["APAC", 12, 25.5],
    ["EMEA", 9, 30],
    ["AMER", 5, 21]
  ]),
  "2026-08": monthlyCsv([
    ["APAC", 8, 26],
    ["EMEA", 11, 29.5],
    ["AMER", 14, 20.25]
  ])
};

const zip = new ArchiveFile();
for (const [month, csv] of Object.entries(months)) {
  // Note the argument order: addText(content, entryName).
  zip.addText(csv, `reports/${month}.csv`);
}
zip.addText("Monthly regional sales exports. Semicolon separated.\n", "reports/README.txt");
await zip.writeToFile(path.join(workspace, "reports.zip"));

// A loose copy as well, so a prompt can skip the archive step.
fs.writeFileSync(path.join(workspace, "june.csv"), months["2026-06"]);

// =============================================================================
// 2. A multi-sheet workbook with real structure.
//
// Summary carries formulas that reference other sheets, a merged title, and
// number formats — so `sheet_read` in "values" mode and "formulas" mode give
// visibly different answers. "Eng" is long enough that reading it whole is the
// wrong move, and "Archive" is empty, which used to crash the range logic.
// =============================================================================

const budget = Workbook.create();

const summary = Workbook.addWorksheet(budget, "Summary");
Worksheet.addAoa(summary, [
  ["Q3 Budget vs Actual"],
  [],
  ["Department", "Budget", "Actual", "Variance"],
  ["Engineering", 450_000, null, null],
  ["Sales", 280_000, null, null],
  ["Operations", 95_000, null, null],
  [],
  ["Total", null, null, null]
]);
Worksheet.merge(summary, "A1:D1");
Cell.setFont(summary, "A1", { bold: true, size: 14 });
Cell.setFont(summary, "A3", { bold: true });

// Actuals come from the detail sheets, so "formulas" mode is genuinely useful.
Cell.setValue(summary, "C4", { formula: "SUM(Eng!C2:C341)" });
Cell.setValue(summary, "C5", { formula: "SUM(Sales!C2:C89)" });
Cell.setValue(summary, "C6", { formula: "SUM(Ops!C2:C46)" });
for (const row of [4, 5, 6]) {
  Cell.setValue(summary, `D${row}`, { formula: `C${row}-B${row}` });
}
Cell.setValue(summary, "B8", { formula: "SUM(B4:B6)" });
Cell.setValue(summary, "C8", { formula: "SUM(C4:C6)" });
Cell.setValue(summary, "D8", { formula: "SUM(D4:D6)" });
Cell.setFont(summary, "A8", { bold: true });

for (const column of ["B", "C", "D"]) {
  for (const row of [4, 5, 6, 8]) {
    Cell.setNumFmt(summary, `${column}${row}`, "#,##0");
  }
}
Worksheet.setColumns(summary, [{ width: 16 }, { width: 12 }, { width: 12 }, { width: 12 }]);
summary.views = [{ state: "frozen", ySplit: 3 }];

/** A detail sheet with `count` line items. Engineering is deliberately long. */
function addDetail(name: string, count: number, seed: number): void {
  const ws = Workbook.addWorksheet(budget, name);
  const rows: (string | number)[][] = [["date", "item", "amount"]];
  for (let index = 0; index < count; index += 1) {
    const day = (index % 28) + 1;
    rows.push([
      `2026-0${(index % 3) + 7}-${String(day).padStart(2, "0")}`,
      `${name} line item ${index + 1}`,
      Math.round((Math.sin(index + seed) * 0.5 + 0.5) * 4000 + 200)
    ]);
  }
  Worksheet.addAoa(ws, rows);
  Cell.setFont(ws, "A1", { bold: true });
  Cell.setFont(ws, "B1", { bold: true });
  Cell.setFont(ws, "C1", { bold: true });
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

addDetail("Eng", 340, 1);
addDetail("Sales", 88, 2);
addDetail("Ops", 45, 3);

// An empty sheet: a real shape that reports a zero-based dimension.
Workbook.addWorksheet(budget, "Archive");

calculateFormulas(budget);
await Workbook.writeFile(budget, path.join(workspace, "budget.xlsx"));

// =============================================================================
// 3. A large CSV, generated rather than hand-written.
//
// 5 000 rows is past the point where dumping the file into a reply is sensible,
// so it tests whether the model reaches for `fromCsv` instead of copying data.
// =============================================================================

const inventory = Csv.generate({
  columns: [
    { name: "sku", type: "hex", length: 8 },
    { name: "product", type: "word" },
    { name: "warehouse", type: "string", values: ["SIN", "FRA", "IAD", "NRT"] },
    { name: "qty", type: "int", min: 0, max: 900 },
    { name: "unit_cost", type: "float", min: 0.5, max: 240 },
    {
      name: "restock_due",
      type: "date",
      dateFrom: new Date("2026-09-01"),
      dateTo: new Date("2027-03-31")
    }
  ],
  rows: 5000
});
fs.writeFileSync(path.join(workspace, "inventory.csv"), inventory.csv);

// =============================================================================
// 4. Files whose names lie.
//
// export.xlsx is a CSV; legacy.doc is a CFB container. Both exist to check that
// the model trusts doc_inspect's content detection over the extension.
// =============================================================================

fs.writeFileSync(
  path.join(workspace, "export.xlsx"),
  "order_id,customer,total\n1001,Acme,2500\n1002,Globex,1780\n"
);

// CFB/OLE2 magic: either a legacy binary Office file or an encrypted OOXML one.
const cfbHeader = new Uint8Array(512);
cfbHeader.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
fs.writeFileSync(path.join(workspace, "legacy.doc"), cfbHeader);

// =============================================================================
// 5. A real Word document, now readable — probes structure-aware reading.
//
// Headings plus a table, so `doc_read` should return Markdown with both, and
// `outline: true` should return just the two headings.
// =============================================================================

const spec = Document.create();
Document.addHeading(spec, "Pricing Policy 2026", 1);
Document.addParagraph(
  spec,
  "List prices increase by 8% across all regions effective 2026-09-01. APAC keeps existing contract pricing until renewal."
);
Document.addHeading(spec, "Exceptions", 2);
Document.addParagraph(spec, "Education customers are exempt from the increase.");
Document.addBulletList(spec, ["Universities", "Registered schools", "Public libraries"]);
await Io.writeFile(Document.build(spec), path.join(workspace, "spec.docx"));

// =============================================================================
// 6. A Word TEMPLATE — the best-shaped task in the whole server.
//
// The model should call template_inspect, read the JSON shape it prints, and
// fill it. It never needs to know anything about the document's internals, and
// it cannot break the styling. A missing field is an error, not a blank.
//
// Deliberately includes a field (`client.abn`) that a model is likely to forget,
// to see whether it reacts to the error by adding data or by thrashing.
// =============================================================================

const template = Document.create();
Document.addHeading(template, "Invoice {{invoice.number}}", 1);
Document.addParagraph(template, "Date: {{invoice.date}}");
Document.addParagraph(template, "Client: {{client.name}}");
Document.addParagraph(template, "ABN: {{client.abn}}");
Document.addParagraph(
  template,
  "{{#if overdue}}PAYMENT OVERDUE{{else}}Thank you for your business.{{/if}}"
);
Document.addHeading(template, "Line items", 2);
Document.addParagraph(template, "{{#each items}}{{.description}} — {{.amount}}{{/each}}");
Document.addParagraph(template, "Total: {{invoice.total}}");
await Io.writeFile(Document.build(template), path.join(workspace, "invoice-template.docx"));

// =============================================================================
// 7. A PDF with extractable text, and a note about what has no tool.
//
// Generated from Markdown through the Word layout engine, so `doc_read` gets
// real text and real page numbers.
// =============================================================================

const brief = await markdownToDocx(
  [
    "# Q3 Board Brief",
    "",
    "Revenue reached 513.25 for June across three regions.",
    "",
    "## Risks",
    "",
    "- FX exposure in EMEA",
    "- Single-supplier dependency in APAC",
    "",
    "| region | units | price |",
    "| --- | --- | --- |",
    "| APAC | 10 | 25.5 |",
    "| EMEA | 4 | 30 |",
    "| AMER | 7 | 19.75 |"
  ].join("\n")
);
fs.writeFileSync(path.join(workspace, "brief.pdf"), await Pdf.fromDocx(brief));

// =============================================================================
// 8. Fillable forms — one Word, one PDF.
//
// Same self-describing shape as the template: `form_fill` with no `values`
// lists the fields, so the model has nothing to guess. The PDF exists to cover
// a specific trap — AcroForm values survive only an incremental save, so a
// filled PDF that reads back empty means the tool took the wrong save path.
// =============================================================================

const wordForm = Document.create();
Document.addHeading(wordForm, "Leave Request", 1);
Document.addContent(wordForm, {
  type: "paragraph",
  children: [Build.text("Employee: "), Build.formTextField({ name: "employeeName", default: "" })]
});
Document.addContent(wordForm, {
  type: "paragraph",
  children: [Build.text("Days requested: "), Build.formTextField({ name: "days", default: "" })]
});
Document.addContent(wordForm, {
  type: "paragraph",
  children: [
    Build.text("Manager approved: "),
    Build.formCheckboxField({ name: "approved", default: false })
  ]
});
await Io.writeFile(Document.build(wordForm), path.join(workspace, "leave-request.docx"));

const pdfForm = new Pdf.Builder();
const formPage = pdfForm.addPage();
formPage.drawText("Expense Claim", { x: 60, y: 740, fontSize: 18 });
formPage.drawText("Claimant:", { x: 60, y: 700, fontSize: 11 });
formPage.addFormField({ type: "text", name: "claimant", rect: [140, 694, 380, 716] });
formPage.drawText("Amount:", { x: 60, y: 660, fontSize: 11 });
formPage.addFormField({ type: "text", name: "amount", rect: [140, 654, 260, 676] });
formPage.drawText("Receipts attached:", { x: 60, y: 620, fontSize: 11 });
formPage.addFormField({ type: "checkbox", name: "receipts", rect: [200, 618, 216, 634] });
fs.writeFileSync(path.join(workspace, "expense-claim.pdf"), await pdfForm.build());

// =============================================================================
// 9. Two contract versions, and one with tracked changes.
//
// Contract review is the document task where a model's help is worth most, and
// the two shapes need different tools: two files → compare, one file with
// redlines → review revisions. doc_inspect should route to doc_review for the
// tracked-changes copy.
// =============================================================================

async function writeContract(name: string, clauses: readonly string[]): Promise<void> {
  const doc = Document.create();
  Document.addHeading(doc, "Services Agreement", 1);
  for (const clause of clauses) {
    Document.addParagraph(doc, clause);
  }
  await Io.writeFile(Document.build(doc), path.join(workspace, name));
}

const baseClauses = [
  "Payment is due within 30 days of invoice.",
  "This agreement is governed by the law of New South Wales.",
  "Confidentiality survives termination for three years."
];

await writeContract("contract-v1.docx", baseClauses);
await writeContract("contract-v2.docx", [
  "Payment is due within 14 days of invoice.",
  "This agreement is governed by the law of New South Wales.",
  "Confidentiality survives termination for three years.",
  "Either party may terminate with 60 days written notice."
]);

const redlined = Document.create();
Document.addHeading(redlined, "Services Agreement", 1);
Document.addContent(redlined, {
  type: "paragraph",
  children: [
    Build.text("Payment is due within "),
    Build.deletedRun(Build.text("30"), {
      author: "Alice Chen",
      date: "2026-08-01T09:00:00Z",
      id: 1
    }),
    Build.insertedRun(Build.text("14"), {
      author: "Alice Chen",
      date: "2026-08-01T09:00:00Z",
      id: 2
    }),
    Build.text(" days of invoice.")
  ]
});
Document.addParagraph(redlined, "This agreement is governed by the law of New South Wales.");
await Io.writeFile(Document.build(redlined), path.join(workspace, "contract-redlined.docx"));

// =============================================================================
// Report + ready-to-paste client configuration
// =============================================================================

const listing = fs
  .readdirSync(workspace)
  .toSorted()
  .map(name => {
    const stats = fs.statSync(path.join(workspace, name));
    return `  ${name.padEnd(16)} ${String(stats.size).padStart(8)} bytes`;
  })
  .join("\n");

console.log(`Workspace ready at:\n  ${workspace}\n\nFiles:\n${listing}`);

console.log(`
Point an MCP client at it.

Claude Desktop — claude_desktop_config.json:

{
  "mcpServers": {
    "documonster": {
      "command": "npx",
      "args": ["-y", "@documonster/mcp", "--root", "${workspace}", "--output-root", "${output}"]
    }
  }
}

opencode — opencode.json:

{
  "mcp": {
    "documonster": {
      "type": "local",
      "command": ["npx", "-y", "@documonster/mcp", "--root", "${workspace}", "--output-root", "${output}"],
      "enabled": true
    }
  }
}

Running from this repo instead of npm (after \`pnpm build\` in packages/mcp):

{
  "mcpServers": {
    "documonster": {
      "command": "node",
      "args": [
        "${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/cli.js")}",
        "--root",
        "${workspace}",
        "--output-root",
        "${output}"
      ]
    }
  }
}

Then work through src/examples/prompts.md.
Add --readonly to the args to test that write tools disappear from the model's view.
`);
