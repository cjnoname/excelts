import { HrStopwatch } from "./utils/hr-stopwatch.js";
import { Workbook } from "../index.js";

const filenameIn = process.argv[2];
const filenameOut = process.argv[3];

// all this script does is read a file and write to another
// useful for testing for lost properties

const stopwatch = new HrStopwatch();
const wb = new Workbook();
stopwatch.start();
wb.xlsx
  .readFile(filenameIn)
  .then(() => wb.xlsx.writeFile(filenameOut))
  .then(() => {
    const micros = stopwatch.microseconds;
    console.log("Done.");
    console.log("Time taken:", micros);
  })
  .catch(error => {
    console.error("Error", error.stack);
  });
