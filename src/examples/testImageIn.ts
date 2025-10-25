import { HrStopwatch } from "./utils/hr-stopwatch.js";
import { Workbook } from "../index.js";

const filename = process.argv[2];

const wb = new Workbook();
const stopwatch = new HrStopwatch();
stopwatch.start();
wb.xlsx
  .readFile(filename)
  .then(() => {
    const micros = stopwatch.microseconds;
    console.log("Done.");
    console.log("Time taken:", micros);

    const _ws = wb.getWorksheet("blort");

    // const { image } = ws.background; // background property not supported
    // console.log('Media', image.name, image.type, image.buffer.length);
    console.log("Worksheet loaded successfully");
  })
  .catch(error => {
    console.log(error.message);
  });
