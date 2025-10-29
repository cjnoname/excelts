import { Workbook } from "../index.js";

const filename = process.argv[2];

const wb = new Workbook();
const ws = wb.addWorksheet("Sheet1");
ws.columns = [
  { header: "FirstName", key: "firstname" },
  { header: "LastName", key: "lastname" },
  { header: "Other Name", key: "othername" }
];

wb.xlsx
  .writeFile(filename)
  .then(() => {
    console.log("done");
  })
  .catch(e => console.log(e));
