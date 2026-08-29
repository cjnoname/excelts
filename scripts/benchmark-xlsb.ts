import { performance } from "node:perf_hooks";

import { Cell, Column, Table, Workbook } from "../dist/esm/modules/excel/index.js";
import type { CellValueInput, WorkbookFormat } from "../dist/esm/modules/excel/index.js";

interface BenchmarkSample {
  durationMs: number;
  heapDeltaMb: number;
}

interface Measurement<T> {
  lastValue: T;
  samples: BenchmarkSample[];
}

interface BenchmarkStatistics {
  medianMs: number;
  minMs: number;
  maxMs: number;
  rowsPerSecond: number;
  medianHeapDeltaMb: number;
}

interface FormatBenchmarkResult {
  format: WorkbookFormat;
  bytes: number;
  write: BenchmarkStatistics;
  read: BenchmarkStatistics;
}

const DEFAULT_ROWS = 10_000;
const DEFAULT_RUNS = 5;
const FIXED_MOD_TIME = new Date("2026-01-01T00:00:00.000Z");

const rows = positiveInteger("XLSB_BENCHMARK_ROWS", DEFAULT_ROWS);
const runs = positiveInteger("XLSB_BENCHMARK_RUNS", DEFAULT_RUNS);
const formats: WorkbookFormat[] = ["xlsx", "xlsb"];
const results: FormatBenchmarkResult[] = [];

for (const format of formats) {
  const workbook = buildWorkbook(rows);
  const write = await measure(runs, async () =>
    Workbook.toBuffer(workbook, {
      format,
      zip: { level: 6, modTime: FIXED_MOD_TIME }
    })
  );
  const bytes = write.lastValue;
  const read = await measure(runs, async () => {
    const loaded = Workbook.create();
    await Workbook.read(loaded, bytes);
    assertLoadedWorkbook(loaded, rows);
    return loaded;
  });

  results.push({
    format,
    bytes: bytes.byteLength,
    write: summarize(write.samples, rows),
    read: summarize(read.samples, rows)
  });
}

const xlsx = results.find(result => result.format === "xlsx");
const xlsb = results.find(result => result.format === "xlsb");
if (!xlsx || !xlsb) {
  throw new Error("benchmark did not produce results for both XLSX and XLSB");
}
console.log(
  JSON.stringify(
    {
      configuration: {
        rows,
        columns: 8,
        measuredCells: rows * 8,
        warmups: 1,
        runs,
        node: process.version
      },
      results,
      ratios: {
        xlsbToXlsxBytes: round(xlsb.bytes / xlsx.bytes),
        xlsbToXlsxWriteMedian: round(xlsb.write.medianMs / xlsx.write.medianMs),
        xlsbToXlsxReadMedian: round(xlsb.read.medianMs / xlsx.read.medianMs)
      }
    },
    null,
    2
  )
);

function buildWorkbook(rowCount: number): Workbook.Handle {
  const workbook = Workbook.create();
  workbook.creator = "documonster XLSB benchmark";
  workbook.company = "documonster";
  workbook.calcProperties = { fullCalcOnLoad: false };
  const sheet = Workbook.addWorksheet(workbook, "Transactions", {
    views: [{ state: "frozen", ySplit: 1, topLeftCell: "A2", activeCell: "A2" }]
  });
  const data: CellValueInput[][] = [];
  for (let index = 1; index <= rowCount; index++) {
    const worksheetRow = index + 1;
    const amount = (index * 37.17) % 10_000;
    data.push([
      index,
      `Region ${index % 12}`,
      `Customer ${index % 500}`,
      new Date(Date.UTC(2020 + (index % 6), index % 12, (index % 28) + 1)),
      amount,
      index % 3 === 0,
      `Order ${index.toString().padStart(6, "0")}`,
      { formula: `E${worksheetRow}*1.2`, result: amount * 1.2 }
    ]);
  }
  Table.add(sheet, {
    name: "TransactionsTable",
    ref: "A1",
    headerRow: true,
    totalsRow: false,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [
      { name: "Id" },
      { name: "Region" },
      { name: "Customer" },
      { name: "Date" },
      { name: "Amount" },
      { name: "Approved" },
      { name: "Description" },
      { name: "Gross" }
    ],
    rows: data
  });
  Column.setWidth(sheet, "B", 14);
  Column.setWidth(sheet, "C", 16);
  Column.setWidth(sheet, "D", 13);
  Column.setWidth(sheet, "G", 18);
  Column.setStyle(sheet, "D", { numFmt: "yyyy-mm-dd" });
  Column.setStyle(sheet, "E", { numFmt: "#,##0.00" });
  Column.setStyle(sheet, "H", { numFmt: "#,##0.00" });
  Cell.setComment(sheet, "A1", {
    author: "documonster",
    note: "Representative XLSX/XLSB IO benchmark"
  });

  const summary = Workbook.addWorksheet(workbook, "Summary");
  Cell.setValue(summary, "A1", "Rows");
  Cell.setValue(summary, "B1", rowCount);
  Cell.setValue(summary, "A2", "Gross total");
  Cell.setValue(summary, "B2", {
    formula: `SUM(Transactions!H2:H${rowCount + 1})`,
    result: data.reduce((sum, row) => sum + row[4] * 1.2, 0)
  });
  return workbook;
}

async function measure<T>(runCount: number, operation: () => Promise<T>): Promise<Measurement<T>> {
  await operation();
  const samples: BenchmarkSample[] = [];
  let lastValue: T | undefined;
  for (let run = 0; run < runCount; run++) {
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    lastValue = await operation();
    const durationMs = performance.now() - start;
    samples.push({
      durationMs,
      heapDeltaMb: (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024
    });
  }
  if (lastValue === undefined) {
    throw new Error("benchmark operation did not produce a value");
  }
  return { lastValue, samples };
}

function summarize(samples: BenchmarkSample[], rowCount: number): BenchmarkStatistics {
  const durations = samples.map(sample => sample.durationMs).sort((left, right) => left - right);
  const heapDeltas = samples.map(sample => sample.heapDeltaMb);
  const medianMs = median(durations);
  return {
    medianMs: round(medianMs),
    minMs: round(durations[0]!),
    maxMs: round(durations.at(-1)!),
    rowsPerSecond: Math.round((rowCount * 1_000) / medianMs),
    medianHeapDeltaMb: round(median(heapDeltas))
  };
}

function assertLoadedWorkbook(workbook: Workbook.Handle, rowCount: number): void {
  const sheet = Workbook.getWorksheet(workbook, "Transactions");
  if (!sheet || Cell.getValue(sheet, `A${rowCount + 1}`) !== rowCount) {
    throw new Error("benchmark round-trip did not preserve the last transaction row");
  }
  const formula = Cell.getFormula(sheet, `H${rowCount + 1}`);
  if (formula !== `E${rowCount + 1}*1.2`) {
    throw new Error(`benchmark round-trip changed the last formula: ${formula}`);
  }
}

function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("cannot calculate the median of an empty sample");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
    : sorted[midpoint]!;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
