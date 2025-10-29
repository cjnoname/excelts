import { Workbook } from "../index.js";
import { HrStopwatch } from "./utils/hr-stopwatch.js";

const [, , filename] = process.argv;

const wb = new Workbook();
const ws = wb.addWorksheet("Foo");

ws.getCell("A1").value = " H, \n W! ";
ws.getCell("A1").note = " Hello, \n World! ";
ws.getCell("A1").alignment = { wrapText: true };

ws.getCell("C1").value = "H,\nW!";
ws.getCell("C1").note = "H,\nW!";
ws.getCell("C1").alignment = { wrapText: true };

const stopwatch = new HrStopwatch();
stopwatch.start();
try {
  await wb.xlsx.writeFile(filename);
  const micros = stopwatch.microseconds;
  console.log("Done.");
  console.log("Time taken:", micros);
} catch (error) {
  console.log(error.message);
}
