import { Cell, Workbook } from "../dist/esm/modules/excel/index.js";
import { calculateFormulas } from "../dist/esm/modules/excel/bridge/formula.js";

const SIZE = 10_000;
const DEFAULT_BUDGET_MS = 30_000;
const budgetMs = Number(process.env.FORMULA_BENCHMARK_BUDGET_MS ?? DEFAULT_BUDGET_MS);

const scenarios = [
  ["10k-independent", buildIndependent],
  ["10k-deep-chain", buildDeepChain],
  ["10k-spill", buildSpill],
  ["10k-dynamic-refs", buildDynamicRefs],
  ["10k-circular", buildCircular]
];

const results = [];
for (const [name, build] of scenarios) {
  const workbook = build();
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  calculateFormulas(workbook);
  const durationMs = performance.now() - start;
  const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  results.push({
    name,
    formulas: SIZE,
    durationMs: round(durationMs),
    heapDeltaMb: round(heapDeltaMb)
  });
  if (durationMs > budgetMs) {
    throw new Error(`${name} exceeded ${budgetMs}ms budget: ${round(durationMs)}ms`);
  }
}

console.log(JSON.stringify({ size: SIZE, budgetMs, results }, null, 2));

function createSheet() {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "S");
  return { wb, ws };
}

function buildIndependent() {
  const { wb, ws } = createSheet();
  for (let row = 1; row <= SIZE; row++) {
    Cell.setValue(ws, `A${row}`, { formula: `${row}+1`, result: 0 });
  }
  return wb;
}

function buildDeepChain() {
  const { wb, ws } = createSheet();
  Cell.setValue(ws, "A1", 1);
  for (let row = 2; row <= SIZE + 1; row++) {
    Cell.setValue(ws, `A${row}`, { formula: `A${row - 1}+1`, result: 0 });
  }
  return wb;
}

function buildSpill() {
  const { wb, ws } = createSheet();
  Cell.setValue(ws, "A1", { formula: `SEQUENCE(${SIZE})`, result: 0 });
  return wb;
}

function buildDynamicRefs() {
  const { wb, ws } = createSheet();
  Cell.setValue(ws, "A1", 1);
  for (let row = 1; row <= SIZE; row++) {
    Cell.setValue(ws, `B${row}`, { formula: 'INDIRECT("A1")+1', result: 0 });
  }
  return wb;
}

function buildCircular() {
  const { wb, ws } = createSheet();
  wb.calcProperties = { iterate: true, iterateCount: 10, iterateDelta: 0.001 };
  for (let row = 1; row <= SIZE; row++) {
    Cell.setValue(ws, `A${row}`, { formula: `A${row}/2+1`, result: 0 });
  }
  return wb;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
