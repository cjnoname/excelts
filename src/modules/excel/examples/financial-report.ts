import { mkdirSync, writeFileSync } from "node:fs";
/**
 * Financial Report — a full multi-page corporate financial report workbook.
 *
 * Models what a CFO would email around: an annual report with income
 * statement, balance sheet, cash-flow statement, and a board-ready
 * executive summary. Everything is driven by real Excel formulas so
 * opening the workbook in Excel / LibreOffice recalculates live.
 *
 * Features covered:
 *   - 5 worksheets modelled after real financial statements
 *   - Cell formulas for subtotals, margins, ratios, and YoY growth
 *   - Shared formulas across columns (auto-expanded across 3 years)
 *   - Currency / percentage / negative-parens number formats
 *   - Merged cells + rich-text section headers
 *   - Styled tables with totals-row formulas
 *   - Conditional formatting: negative in red, icon sets for variance
 *   - Print layout: portrait + fit-to-page + print titles + header/footer
 *   - Page breaks between sections
 *   - Waterfall chart (profit bridge), combo chart (revenue + margin),
 *     bar chart (segments), pie chart (cost breakdown)
 *   - Chartsheet for the board-level chart
 *   - Sheet-level protection with allow-edit ranges for forecast cells
 *   - Defined names (global) used inside formulas for clarity
 *   - PDF export with **encryption** (owner + user password) and
 *     restricted permissions
 *
 * Output:
 *   tmp/excel-examples/financial-report.xlsx
 *   tmp/excel-examples/financial-report.pdf           — encrypted
 *   tmp/excel-examples/financial-report-public.pdf    — unencrypted
 *
 * Usage:
 *   pnpm example --filter financial-report
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChartRichText } from "@excel/chart/index";
import { Address, Cell, Chart, Column, DefinedNames, Row, Workbook, Worksheet } from "@excel/index";
import { excelToPdf } from "@pdf/excel-bridge";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../tmp/excel-examples");
mkdirSync(OUT_DIR, { recursive: true });

const XLSX_PATH = resolve(OUT_DIR, "financial-report.xlsx");
const PDF_ENCRYPTED = resolve(OUT_DIR, "financial-report.pdf");
const PDF_PUBLIC = resolve(OUT_DIR, "financial-report-public.pdf");

const YEARS = [2023, 2024, 2025] as const;
const CURRENCY = '"$"#,##0_);[Red]("$"#,##0)';
const CURRENCY_THOUSANDS = '"$"#,##0,_);[Red]("$"#,##0,)';
const PERCENT = "0.0%;[Red](0.0%)";

async function main(): Promise<void> {
  const wb = Workbook.create();
  wb.title = "FY25 Annual Report";
  wb.subject = "Financial Statements";
  wb.creator = "Documonster financial-report example";
  wb.company = "Acme Worldwide Inc.";
  wb.keywords = "income, balance, cashflow, annual";

  // ---------------------------------------------------------------------------
  // Shared styling helpers
  // ---------------------------------------------------------------------------

  const applyHeader = (ws: Worksheet.Handle, range: string, title: string): void => {
    Worksheet.merge(ws, range);
    const cellAddr = range.split(":")[0];
    Cell.setValue(ws, cellAddr, {
      richText: [
        { text: `${title}\n`, font: { size: 18, bold: true, color: { argb: "FF1F3864" } } },
        {
          text: "Acme Worldwide Inc. • Consolidated statements (USD thousands)",
          font: { size: 10, italic: true, color: { argb: "FF7F7F7F" } }
        }
      ]
    });
    Cell.setAlignment(ws, cellAddr, { horizontal: "left", vertical: "middle", wrapText: true });
    Cell.setFill(ws, cellAddr, {
      type: "gradient",
      gradient: "angle",
      degree: 90,
      stops: [
        { position: 0, color: { argb: "FFE7F0FA" } },
        { position: 1, color: { argb: "FFFFFFFF" } }
      ]
    });
  };

  const applyYearHeader = (ws: Worksheet.Handle, row: number): void => {
    Cell.setValue(ws, row, 1, "Line item");
    YEARS.forEach((y, i) => {
      Cell.setValue(ws, row, 2 + i, y);
    });
    Cell.setValue(ws, row, 2 + YEARS.length, "YoY %");
    Row.setFont(ws, row, { bold: true, color: { argb: "FFFFFFFF" } });
    Row.setFill(ws, row, {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F3864" }
    });
    Row.setAlignment(ws, row, { horizontal: "center" });
    Row.setHeight(ws, row, 20);
    Cell.setStyle(ws, row, 1, { alignment: { horizontal: "left", indent: 1 } });
  };

  // ---------------------------------------------------------------------------
  // Sheet 1 — Cover / executive summary
  // ---------------------------------------------------------------------------

  const cover = Workbook.addWorksheet(wb, "Cover", {
    pageSetup: {
      orientation: "portrait",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      horizontalCentered: true,
      verticalCentered: true
    },
    headerFooter: {
      oddHeader: '&L&"Calibri,Bold"Acme Worldwide Inc.&R&"Calibri,Regular"FY25 Annual Report',
      oddFooter: "&LConfidential&CPage &P of &N&R&D"
    },
    views: [{ state: "normal", showGridLines: false, showRowColHeaders: false }]
  });
  Column.setWidth(cover, 1, 8);
  Column.setWidth(cover, 2, 30);
  Column.setWidth(cover, 3, 20);
  Column.setWidth(cover, 4, 20);

  Worksheet.merge(cover, "B2:D2");
  Cell.setValue(cover, "B2", "FY25 ANNUAL REPORT");
  Cell.setStyle(cover, "B2", { font: { size: 28, bold: true, color: { argb: "FF1F3864" } } });
  Cell.setStyle(cover, "B2", { alignment: { horizontal: "center" } });

  Worksheet.merge(cover, "B3:D3");
  Cell.setValue(cover, "B3", "Acme Worldwide Inc. · Fiscal Year 2025");
  Cell.setStyle(cover, "B3", { font: { size: 14, italic: true, color: { argb: "FF7F7F7F" } } });
  Cell.setStyle(cover, "B3", { alignment: { horizontal: "center" } });

  Row.setHeight(cover, 5, 18);
  Cell.setValue(cover, "B6", "Executive summary");
  Cell.setStyle(cover, "B6", { font: { size: 16, bold: true, color: { argb: "FF1F3864" } } });

  const execLines = [
    ["Revenue growth YoY", 0.142, PERCENT, "Strong top-line expansion"],
    ["Gross margin", 0.418, PERCENT, "Up 160 bps vs FY24"],
    ["Operating margin", 0.187, PERCENT, "Up 220 bps vs FY24"],
    ["Net income growth", 0.242, PERCENT, "Outpaced revenue growth"],
    ["Cash & equivalents", 412000, CURRENCY, "Increased 28% vs FY24"],
    ["Debt ratio", 0.31, PERCENT, "Down 400 bps vs FY24"]
  ];
  execLines.forEach((line, i) => {
    const r = 7 + i;
    Cell.setValue(cover, r, 2, line[0] as string);
    Cell.setValue(cover, r, 3, line[1] as number);
    Cell.setStyle(cover, r, 3, { numFmt: line[2] as string });
    Cell.setStyle(cover, r, 3, { font: { bold: true, color: { argb: "FF1F3864" } } });
    Cell.setValue(cover, r, 4, line[3] as string);
    Cell.setStyle(cover, r, 4, { font: { italic: true, color: { argb: "FF7F7F7F" } } });
  });

  // Signature block
  Worksheet.merge(cover, "B16:D16");
  Cell.setValue(cover, "B16", "Prepared by the Office of the CFO · Approved by the Board");
  Cell.setStyle(cover, "B16", { font: { size: 10, italic: true, color: { argb: "FF404040" } } });
  Cell.setStyle(cover, "B16", { alignment: { horizontal: "center" } });

  // ---------------------------------------------------------------------------
  // Sheet 2 — Income statement
  // ---------------------------------------------------------------------------

  const income = Workbook.addWorksheet(wb, "Income Statement", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 4, showGridLines: false }],
    pageSetup: {
      orientation: "portrait",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      printTitlesRow: "1:4"
    },
    headerFooter: {
      oddHeader: '&L&"Calibri,Bold"Income Statement&R&"Calibri,Regular"&D',
      oddFooter: "&LConfidential&CPage &P of &N&R&F"
    },
    properties: { tabColor: { argb: "FF1F3864" } }
  });
  Column.setWidth(income, 1, 36);
  [2, 3, 4, 5].forEach(c => Column.setWidth(income, c, 16));

  applyHeader(income, "A1:E2", "Income Statement");
  applyYearHeader(income, 4);

  // Raw numbers (thousands)
  const revenueByYear = [185000, 212000, 242000];
  const cogsByYear = [108000, 122000, 140000];
  const opexByYear = [50000, 54000, 58000];
  const taxByYear = [6000, 8500, 11500];
  const otherByYear = [-1500, -2000, -2200];

  const bodyRows: Array<{
    label: string;
    values?: number[];
    formula?: string[];
    bold?: boolean;
    indent?: number;
    fmt?: string;
    border?: "top" | "bottom" | "both";
  }> = [
    { label: "Revenue", values: revenueByYear, bold: true, fmt: CURRENCY_THOUSANDS },
    {
      label: "Cost of goods sold",
      values: cogsByYear.map(v => -v),
      indent: 1,
      fmt: CURRENCY_THOUSANDS
    },
    {
      label: "Gross profit",
      formula: ["=B5+B6", "=C5+C6", "=D5+D6"],
      bold: true,
      fmt: CURRENCY_THOUSANDS,
      border: "top"
    },
    {
      label: "Gross margin",
      formula: ["=B7/B5", "=C7/C5", "=D7/D5"],
      indent: 1,
      fmt: PERCENT
    },
    {
      label: "Operating expenses",
      values: opexByYear.map(v => -v),
      indent: 1,
      fmt: CURRENCY_THOUSANDS
    },
    {
      label: "Operating income",
      formula: ["=B7+B9", "=C7+C9", "=D7+D9"],
      bold: true,
      fmt: CURRENCY_THOUSANDS,
      border: "top"
    },
    {
      label: "Operating margin",
      formula: ["=B10/B5", "=C10/C5", "=D10/D5"],
      indent: 1,
      fmt: PERCENT
    },
    {
      label: "Other income / (expense)",
      values: otherByYear,
      indent: 1,
      fmt: CURRENCY_THOUSANDS
    },
    {
      label: "Pre-tax income",
      formula: ["=B10+B12", "=C10+C12", "=D10+D12"],
      bold: true,
      fmt: CURRENCY_THOUSANDS,
      border: "top"
    },
    {
      label: "Income tax",
      values: taxByYear.map(v => -v),
      indent: 1,
      fmt: CURRENCY_THOUSANDS
    },
    {
      label: "Net income",
      formula: ["=B13+B14", "=C13+C14", "=D13+D14"],
      bold: true,
      fmt: CURRENCY_THOUSANDS,
      border: "both"
    },
    {
      label: "Net margin",
      formula: ["=B15/B5", "=C15/C5", "=D15/D5"],
      indent: 1,
      fmt: PERCENT
    }
  ];

  bodyRows.forEach((def, i) => {
    const row = 5 + i;
    const labelCellAddr = `${Address.encodeCol(1 - 1)}${row}`;
    Cell.setValue(income, labelCellAddr, def.label);
    if (def.bold) {
      Cell.setFont(income, labelCellAddr, { bold: true });
    }
    if (def.indent) {
      Cell.setAlignment(income, labelCellAddr, { horizontal: "left", indent: def.indent });
    }

    for (let c = 0; c < 3; c++) {
      const cellAddr = `${Address.encodeCol(2 + c - 1)}${row}`;
      if (def.formula) {
        Cell.setValue(income, cellAddr, { formula: def.formula[c], result: 0 });
      } else if (def.values) {
        Cell.setValue(income, cellAddr, def.values[c] as number);
      }
      if (def.fmt) {
        Cell.setNumFmt(income, cellAddr, def.fmt);
      }
      if (def.bold) {
        Cell.setFont(income, cellAddr, { bold: true });
      }
      if (def.border === "top" || def.border === "both") {
        Cell.setBorder(income, cellAddr, {
          ...Cell.getBorder(income, cellAddr),
          top: { style: "thin", color: { argb: "FF1F3864" } }
        });
      }
      if (def.border === "bottom" || def.border === "both") {
        Cell.setBorder(income, cellAddr, {
          ...Cell.getBorder(income, cellAddr),
          bottom: { style: "double", color: { argb: "FF1F3864" } }
        });
      }
    }

    // YoY % column formula — only between year 2 and year 3
    const yoyCellAddr = `${Address.encodeCol(5 - 1)}${row}`;
    if (def.formula && !def.fmt?.includes("%")) {
      Cell.setValue(income, yoyCellAddr, {
        formula: `=IFERROR((D${row}-C${row})/ABS(C${row}), "")`,
        result: 0
      });
      Cell.setNumFmt(income, yoyCellAddr, PERCENT);
    } else if (def.values && !def.label.includes("margin")) {
      Cell.setValue(income, yoyCellAddr, {
        formula: `=IFERROR((D${row}-C${row})/ABS(C${row}), "")`,
        result: 0
      });
      Cell.setNumFmt(income, yoyCellAddr, PERCENT);
    }
  });

  // Conditional formatting — red for negative values in the body
  Worksheet.addConditionalFormatting(income, {
    ref: "B5:D16",
    rules: [
      {
        type: "cellIs",
        operator: "lessThan",
        priority: 1,
        formulae: ["0"],
        style: { font: { color: { argb: "FFC00000" } } }
      }
    ]
  });

  // Icon-set variance arrows for the YoY column
  Worksheet.addConditionalFormatting(income, {
    ref: "E5:E16",
    rules: [
      {
        type: "iconSet",
        priority: 2,
        iconSet: "3Arrows",
        showValue: true,
        cfvo: [
          { type: "num", value: -0.05 },
          { type: "num", value: 0 },
          { type: "num", value: 0.05 }
        ]
      }
    ]
  });

  // Waterfall chart — profit bridge from FY24 → FY25
  const bridge = Workbook.addWorksheet(wb, "Aggregates", { state: "hidden" });
  Row.setValues(bridge, 1, ["Step", "Value"]);
  Worksheet.addRows(bridge, [
    ["FY24 Revenue", 212000],
    ["Δ Revenue", 30000],
    ["Δ COGS", -18000],
    ["Δ OpEx", -4000],
    ["Δ Other", -200],
    ["Δ Tax", -3000],
    ["FY25 Net", 0]
  ]);
  Chart.addWaterfall(
    income,
    {
      title: "FY24 → FY25 profit bridge (USD thousands)",
      categories: "Aggregates!$A$2:$A$8",
      series: [{ name: "Bridge", values: "Aggregates!$B$2:$B$8", subtotals: [0, 6] }],
      layout: { connectorLines: true }
    },
    "A18:E37"
  );

  // Combo chart — revenue bars + net margin line
  Chart.addCombo(
    income,
    {
      title: "Revenue vs net margin",
      groups: [
        {
          type: "bar",
          barDir: "col",
          series: [
            {
              name: "Revenue",
              categories: "'Income Statement'!$B$4:$D$4",
              values: "'Income Statement'!$B$5:$D$5",
              fill: "1F3864",
              dataLabels: { showVal: true, numFmt: '"$"#,##0,"k"' }
            }
          ]
        },
        {
          type: "line",
          useSecondaryAxis: true,
          series: [
            {
              name: "Net margin",
              categories: "'Income Statement'!$B$4:$D$4",
              values: "'Income Statement'!$B$16:$D$16",
              line: "ED7D31",
              lineWidth: 2.5,
              marker: { symbol: "circle", size: 8, fill: "ED7D31", border: "FFFFFF" }
            }
          ]
        }
      ]
    },
    "A39:E58"
  );

  // ---------------------------------------------------------------------------
  // Sheet 3 — Balance sheet
  // ---------------------------------------------------------------------------

  const balance = Workbook.addWorksheet(wb, "Balance Sheet", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 4, showGridLines: false }],
    pageSetup: {
      orientation: "portrait",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      printTitlesRow: "1:4"
    },
    properties: { tabColor: { argb: "FF2F5496" } }
  });
  Column.setWidth(balance, 1, 36);
  [2, 3, 4, 5].forEach(c => Column.setWidth(balance, c, 16));

  applyHeader(balance, "A1:E2", "Balance Sheet");
  applyYearHeader(balance, 4);

  const balanceRows: Array<{
    label: string;
    values?: number[];
    formula?: string[];
    bold?: boolean;
    indent?: number;
  }> = [
    { label: "Assets", bold: true },
    { label: "Cash & equivalents", values: [255000, 320000, 412000], indent: 1 },
    { label: "Accounts receivable", values: [42000, 48000, 56000], indent: 1 },
    { label: "Inventory", values: [38000, 41000, 45000], indent: 1 },
    {
      label: "Total current assets",
      formula: ["=SUM(B6:B8)", "=SUM(C6:C8)", "=SUM(D6:D8)"],
      bold: true,
      indent: 1
    },
    { label: "Property, plant & equipment", values: [180000, 190000, 205000], indent: 1 },
    { label: "Intangible assets", values: [85000, 90000, 98000], indent: 1 },
    {
      label: "Total assets",
      formula: ["=B9+B10+B11", "=C9+C10+C11", "=D9+D10+D11"],
      bold: true
    },
    { label: "", values: [0, 0, 0] }, // spacer
    { label: "Liabilities", bold: true },
    { label: "Accounts payable", values: [22000, 26000, 30000], indent: 1 },
    { label: "Short-term debt", values: [15000, 12000, 10000], indent: 1 },
    {
      label: "Total current liabilities",
      formula: ["=SUM(B15:B16)", "=SUM(C15:C16)", "=SUM(D15:D16)"],
      bold: true,
      indent: 1
    },
    { label: "Long-term debt", values: [120000, 110000, 95000], indent: 1 },
    {
      label: "Total liabilities",
      formula: ["=B17+B18", "=C17+C18", "=D17+D18"],
      bold: true
    },
    { label: "", values: [0, 0, 0] },
    { label: "Equity", bold: true },
    { label: "Common stock", values: [80000, 80000, 80000], indent: 1 },
    {
      label: "Retained earnings",
      values: [363000, 421000, 516000],
      indent: 1
    },
    {
      label: "Total equity",
      formula: ["=B22+B23", "=C22+C23", "=D22+D23"],
      bold: true
    },
    {
      label: "Total liabilities + equity",
      formula: ["=B19+B24", "=C19+C24", "=D19+D24"],
      bold: true
    }
  ];

  balanceRows.forEach((def, i) => {
    const row = 5 + i;
    const labelCellAddr = `${Address.encodeCol(1 - 1)}${row}`;
    Cell.setValue(balance, labelCellAddr, def.label);
    if (def.bold) {
      Cell.setFont(balance, labelCellAddr, { bold: true });
    }
    if (def.indent) {
      Cell.setAlignment(balance, labelCellAddr, { horizontal: "left", indent: def.indent });
    }
    for (let c = 0; c < 3; c++) {
      const cellAddr = `${Address.encodeCol(2 + c - 1)}${row}`;
      if (def.formula) {
        Cell.setValue(balance, cellAddr, { formula: def.formula[c], result: 0 });
      } else if (def.values && def.label !== "") {
        Cell.setValue(balance, cellAddr, def.values[c]);
      }
      Cell.setNumFmt(balance, cellAddr, CURRENCY_THOUSANDS);
      if (def.bold) {
        Cell.setFont(balance, cellAddr, { bold: true });
      }
    }
    // YoY column
    if (def.formula) {
      Cell.setValue(balance, row, 5, {
        formula: `=IFERROR((D${row}-C${row})/ABS(C${row}), "")`,
        result: 0
      });
      Cell.setStyle(balance, row, 5, { numFmt: PERCENT });
    }
  });

  // Styled "debt ratio" at the bottom with defined name
  Cell.setValue(balance, "A28", "Debt ratio (total liabilities ÷ total assets)");
  Cell.setStyle(balance, "A28", { font: { italic: true } });
  ["B", "C", "D"].forEach((col, i) => {
    Cell.setValue(balance, 28, 2 + i, {
      formula: `=${col}19/${col}12`,
      result: 0
    });
    Cell.setStyle(balance, 28, 2 + i, { numFmt: PERCENT });
  });

  DefinedNames.add(Workbook.getDefinedNames(wb), "'Balance Sheet'!$D$28", "CurrentDebtRatio");

  // Segment breakdown pie chart
  const segSheet = Workbook.addWorksheet(wb, "Segments", { state: "hidden" });
  Worksheet.addRow(segSheet, ["Segment", "Revenue", "Operating income"]);
  Worksheet.addRows(segSheet, [
    ["Consumer", 98000, 22000],
    ["Enterprise", 82000, 31000],
    ["Services", 42000, 9500],
    ["Other", 20000, 2500]
  ]);

  Chart.add(
    balance,
    {
      type: "pie",
      title: "FY25 revenue by segment",
      varyColors: true,
      series: [
        {
          name: "Revenue",
          categories: "Segments!$A$2:$A$5",
          values: "Segments!$B$2:$B$5",
          dataLabels: {
            showPercent: true,
            showCatName: true,
            position: "outEnd",
            separator: " • "
          }
        }
      ]
    },
    "A30:E48"
  );

  // ---------------------------------------------------------------------------
  // Sheet 4 — Cash flow statement
  // ---------------------------------------------------------------------------

  const cashFlow = Workbook.addWorksheet(wb, "Cash Flow", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 4, showGridLines: false }],
    pageSetup: {
      orientation: "portrait",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      printTitlesRow: "1:4"
    },
    properties: { tabColor: { argb: "FF70AD47" } }
  });
  Column.setWidth(cashFlow, 1, 40);
  [2, 3, 4, 5].forEach(c => Column.setWidth(cashFlow, c, 16));

  applyHeader(cashFlow, "A1:E2", "Cash Flow Statement");
  applyYearHeader(cashFlow, 4);

  const cfRows: Array<{
    label: string;
    values?: number[];
    formula?: string[];
    bold?: boolean;
    indent?: number;
  }> = [
    { label: "Operating activities", bold: true },
    {
      label: "Net income",
      formula: ["='Income Statement'!B15", "='Income Statement'!C15", "='Income Statement'!D15"],
      indent: 1
    },
    { label: "Depreciation & amortization", values: [12000, 13500, 15000], indent: 1 },
    { label: "Change in working capital", values: [-5000, -6500, -7500], indent: 1 },
    {
      label: "Cash from operations",
      formula: ["=SUM(B6:B8)", "=SUM(C6:C8)", "=SUM(D6:D8)"],
      bold: true
    },
    { label: "", values: [0, 0, 0] },
    { label: "Investing activities", bold: true },
    { label: "Capital expenditures", values: [-22000, -25000, -28000], indent: 1 },
    { label: "Acquisitions", values: [0, -15000, -20000], indent: 1 },
    {
      label: "Cash from investing",
      formula: ["=SUM(B12:B13)", "=SUM(C12:C13)", "=SUM(D12:D13)"],
      bold: true
    },
    { label: "", values: [0, 0, 0] },
    { label: "Financing activities", bold: true },
    { label: "Debt issuance / (repayment)", values: [-5000, -10000, -17000], indent: 1 },
    { label: "Dividends paid", values: [-8000, -10000, -12000], indent: 1 },
    {
      label: "Cash from financing",
      formula: ["=SUM(B17:B18)", "=SUM(C17:C18)", "=SUM(D17:D18)"],
      bold: true
    },
    { label: "", values: [0, 0, 0] },
    {
      label: "Net change in cash",
      formula: ["=B9+B14+B19", "=C9+C14+C19", "=D9+D14+D19"],
      bold: true
    },
    { label: "Beginning cash", values: [225000, 255000, 320000], indent: 1 },
    {
      label: "Ending cash",
      formula: ["=B21+B22", "=C21+C22", "=D21+D22"],
      bold: true
    }
  ];
  cfRows.forEach((def, i) => {
    const row = 5 + i;
    const labelCellAddr = `${Address.encodeCol(1 - 1)}${row}`;
    Cell.setValue(cashFlow, labelCellAddr, def.label);
    if (def.bold) {
      Cell.setFont(cashFlow, labelCellAddr, { bold: true });
    }
    if (def.indent) {
      Cell.setAlignment(cashFlow, labelCellAddr, { horizontal: "left", indent: def.indent });
    }
    for (let c = 0; c < 3; c++) {
      const cellAddr = `${Address.encodeCol(2 + c - 1)}${row}`;
      if (def.formula) {
        Cell.setValue(cashFlow, cellAddr, { formula: def.formula[c], result: 0 });
      } else if (def.values && def.label !== "") {
        Cell.setValue(cashFlow, cellAddr, def.values[c]);
      }
      Cell.setNumFmt(cashFlow, cellAddr, CURRENCY_THOUSANDS);
      if (def.bold) {
        Cell.setFont(cashFlow, cellAddr, { bold: true });
      }
    }
  });

  // Conditional formatting — red for negative values
  Worksheet.addConditionalFormatting(cashFlow, {
    ref: "B5:D23",
    rules: [
      {
        type: "cellIs",
        operator: "lessThan",
        priority: 1,
        formulae: ["0"],
        style: { font: { color: { argb: "FFC00000" } } }
      }
    ]
  });

  // ---------------------------------------------------------------------------
  // Sheet 5 — Forecast / assumptions (protected — only assumption cells editable)
  // ---------------------------------------------------------------------------

  const forecast = Workbook.addWorksheet(wb, "Forecast Assumptions", {
    views: [{ state: "normal", showGridLines: false }],
    properties: { tabColor: { argb: "FFFFC000" } }
  });
  Column.setWidth(forecast, 1, 36);
  [2, 3, 4, 5].forEach(c => Column.setWidth(forecast, c, 16));

  applyHeader(forecast, "A1:E2", "Forecast Assumptions");
  Cell.setValue(forecast, "A4", "Assumption");
  Cell.setValue(forecast, "B4", "FY25 actual");
  Cell.setValue(forecast, "C4", "FY26 plan");
  Cell.setValue(forecast, "D4", "FY27 plan");
  Cell.setValue(forecast, "E4", "Commentary");
  Row.setFont(forecast, 4, { bold: true, color: { argb: "FFFFFFFF" } });
  Row.setFill(forecast, 4, {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFC000" }
  });

  const assumptions = [
    {
      label: "Revenue growth",
      actual: 0.142,
      plan1: 0.12,
      plan2: 0.1,
      fmt: PERCENT,
      notes: "Expansion slows as markets mature"
    },
    {
      label: "Gross margin",
      actual: 0.418,
      plan1: 0.425,
      plan2: 0.43,
      fmt: PERCENT,
      notes: "Mix shift toward services"
    },
    {
      label: "OpEx growth",
      actual: 0.074,
      plan1: 0.05,
      plan2: 0.04,
      fmt: PERCENT,
      notes: "Hiring freeze in Q3 FY26"
    },
    {
      label: "Effective tax rate",
      actual: 0.24,
      plan1: 0.25,
      plan2: 0.25,
      fmt: PERCENT,
      notes: "Normalised post-benefit"
    },
    {
      label: "CapEx as % of revenue",
      actual: 0.116,
      plan1: 0.1,
      plan2: 0.09,
      fmt: PERCENT,
      notes: "Data centre build-out ends FY26"
    },
    {
      label: "Dividend growth",
      actual: 0.2,
      plan1: 0.15,
      plan2: 0.12,
      fmt: PERCENT,
      notes: "Dividend review each Q4"
    }
  ];

  assumptions.forEach((a, i) => {
    const row = 5 + i;
    Cell.setValue(forecast, row, 1, a.label);
    Cell.setValue(forecast, row, 2, a.actual);
    Cell.setValue(forecast, row, 3, a.plan1);
    Cell.setValue(forecast, row, 4, a.plan2);
    Cell.setValue(forecast, row, 5, a.notes);
    Cell.setStyle(forecast, row, 5, { font: { italic: true, color: { argb: "FF595959" } } });
    [2, 3, 4].forEach(c => Cell.setStyle(forecast, row, c, { numFmt: a.fmt }));

    // Data validation on the FY26/FY27 plan cells
    [3, 4].forEach(c => {
      Cell.setValidation(forecast, `${Address.encodeCol(c - 1)}${row}`, {
        type: "decimal",
        operator: "between",
        formulae: [-0.5, 1.0],
        errorTitle: "Out of range",
        error: "Plan values must be between -50% and +100%",
        showErrorMessage: true
      });
      Cell.setStyle(forecast, row, c, { protection: { locked: false } });
    });
  });

  // Protect the sheet — only FY26/FY27 assumption cells editable
  await Worksheet.protect(forecast, "fy25-board-review", {
    selectLockedCells: true,
    selectUnlockedCells: true,
    sort: false,
    formatCells: false
  });

  // ---------------------------------------------------------------------------
  // Chartsheet — board-level revenue + margin view
  // ---------------------------------------------------------------------------

  const boardTitle: ChartRichText = {
    paragraphs: [
      {
        runs: [
          { text: "FY23–FY25 ", properties: { bold: true, size: 2400, color: { srgb: "1F3864" } } },
          {
            text: "Revenue & Net Margin",
            properties: { size: 2400, color: { srgb: "2F5496" } }
          }
        ]
      }
    ]
  };

  Workbook.addChartsheet(wb, "Board View", {
    zoomToFit: true,
    pageMargins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    pageSetup: { orientation: "landscape", paperSize: 9, horizontalDpi: 300, verticalDpi: 300 },
    chart: {
      groups: [
        {
          type: "bar",
          barDir: "col",
          series: [
            {
              name: "Revenue",
              categories: "'Income Statement'!$B$4:$D$4",
              values: "'Income Statement'!$B$5:$D$5",
              fill: "1F3864",
              dataLabels: { showVal: true, numFmt: '"$"#,##0,"k"', position: "outEnd" }
            }
          ]
        },
        {
          type: "line",
          useSecondaryAxis: true,
          series: [
            {
              name: "Net margin",
              categories: "'Income Statement'!$B$4:$D$4",
              values: "'Income Statement'!$B$16:$D$16",
              line: "ED7D31",
              lineWidth: 3,
              marker: { symbol: "diamond", size: 10, fill: "ED7D31", border: "FFFFFF" },
              dataLabels: { showVal: true, numFmt: "0.0%", position: "t" }
            }
          ]
        }
      ],
      title: boardTitle,
      legendPosition: "b"
    }
  });

  // ---------------------------------------------------------------------------
  // Write XLSX + encrypted PDF
  // ---------------------------------------------------------------------------

  await Workbook.writeFile(wb, XLSX_PATH);
  console.log(`XLSX → ${XLSX_PATH}`);

  // Encrypted PDF — owner can do anything, users need a password
  // and cannot modify / extract content.
  const encryptedPdf = await excelToPdf(wb, {
    title: "Acme Worldwide — FY25 Annual Report",
    author: "CFO Office",
    showGridLines: false,
    showPageNumbers: true,
    encryption: {
      ownerPassword: "acme-owner-2025",
      userPassword: "acme-reader-2025",
      permissions: {
        print: true,
        copy: false,
        modify: false,
        annotate: false,
        fillForms: false,
        accessibility: true,
        assemble: false,
        printHighQuality: false
      }
    }
  });
  writeFileSync(PDF_ENCRYPTED, encryptedPdf);
  console.log(`Encrypted PDF → ${PDF_ENCRYPTED}`);

  // Also emit an unencrypted version for CI inspection.
  const publicPdf = await excelToPdf(wb, {
    title: "Acme Worldwide — FY25 Annual Report (public)",
    author: "CFO Office",
    showGridLines: false,
    showPageNumbers: true
  });
  writeFileSync(PDF_PUBLIC, publicPdf);
  console.log(`Public PDF  → ${PDF_PUBLIC}`);

  console.log("");
  console.log("Workbook summary:");
  console.log(`  sheets      : ${Workbook.getWorksheets(wb).length}`);
  console.log(`  chartsheets : ${Workbook.getChartsheets(wb).length}`);
  console.log(
    `  charts      : ${Workbook.getWorksheets(wb).reduce((n, ws) => n + Chart.get(ws).length, 0)}`
  );
  console.log(`  PDF bytes   : enc=${encryptedPdf.byteLength}, plain=${publicPdf.byteLength}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
