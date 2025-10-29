import { WorkbookWriter } from "../index.js";

const filename = process.argv[2];

const workbook = new WorkbookWriter({
  filename,
  useSharedStrings: true
});

const worksheet = workbook.addWorksheet("myWorksheet");
const sheetRow = worksheet.addRow(["Hello"]);
sheetRow.commit();

worksheet.commit();
await workbook.commit();
