import { Workbook } from "../../index.js";

describe("typescript", () => {
  it("can create and buffer xlsx", async () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet("blort");
    ws.getCell("A1").value = 7;
    const buffer = await wb.xlsx.writeBuffer({
      useStyles: true,
      useSharedStrings: true
    });

    const wb2 = new Workbook();
    await wb2.xlsx.load(buffer);
    const ws2 = wb2.getWorksheet("blort");
    expect(ws2.getCell("A1").value).to.equal(7);
  });
});
