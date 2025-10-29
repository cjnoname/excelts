import { WorkbookWriter } from "../index.js";

const filename = process.argv[2];
const styles = {
  filename,
  useStyles: true
};
const wb = new WorkbookWriter(styles);
const ws = wb.addWorksheet("blort");

const style = {
  font: { name: "Comic Sans MS", underline: true, bold: true, size: 16 },
  alignment: { vertical: "middle", horizontal: "center" }
};
ws.columns = [
  { header: "A1", width: 10 },
  { header: "B1", width: 20, style },
  { header: "C1", width: 30 }
];

ws.getRow(2).font = { name: "Broadway", color: { argb: "FFFF0000" }, outline: true, size: 20 };

ws.getCell("A2").value = "A2";
ws.getCell("B2").value = "B2";
ws.getCell("C2").value = "C2";
ws.getCell("A3").value = "A3";
ws.getCell("B3").value = "B3";
ws.getCell("C3").value = "C3";

wb.commit().then(() => {
  console.log("Done");
  // var wb2 = new Workbook();
  // return wb2.xlsx.readFile('./wb.test2.xlsx');
});
