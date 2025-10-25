import { Workbook } from "../index.js";
import { HrStopwatch } from "./utils/hr-stopwatch.js";

const [, , filename] = process.argv;

const wb = new Workbook();
const ws = wb.addWorksheet("Foo");

const now = Date.now();
const today = now - (now % 86400000);

const getRows = () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push([new Date(today + 86400000 * i), Math.random() * 10]);
  }
  return rows;
};

ws.columns = [{ key: "date", width: 16 }, { key: "number" }];

ws.addTable({
  name: "TestTable",
  ref: "A1",
  headerRow: true,
  totalsRow: true,
  style: {
    theme: "TableStyleDark3",
    showRowStripes: true
  },
  columns: [
    { name: "Date", totalsRowLabel: "Max:", filterButton: true },
    {
      name: "Value",
      totalsRowFunction: "max",
      filterButton: true,
      totalsRowResult: 8
    }
  ],
  rows: getRows()
});

const stopwatch = new HrStopwatch();
stopwatch.start();

try {
  await wb.xlsx.writeFile(filename);
  const micros = stopwatch.microseconds;
  console.log("Done.");
  console.log("Time taken:", micros);
} catch (error) {
  console.log((error as Error).message);
}
