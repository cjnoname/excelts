import { describe, it, beforeAll, afterAll } from "vitest";
import { Readable } from "stream";
import express from "express";
import { testUtils } from "../utils/index.js";
import { Workbook } from "../../index.js";

describe("Express", () => {
  let server: any;

  beforeAll(() => {
    const app: any = express();
    app.get("/workbook", (req: any, res: any) => {
      const wb = testUtils.createTestBook(new Workbook(), "xlsx", undefined);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", "attachment; filename=Report.xlsx");
      wb.xlsx.write(res).then(() => {
        res.end();
      });
    });
    server = app.listen(3003);
  });

  afterAll(() => {
    server.close();
  });

  it("downloads a workbook", async () => {
    const response = await fetch("http://127.0.0.1:3003/workbook");
    if (!response.body) {
      throw new Error("No response body");
    }

    const wb2 = new Workbook();
    await wb2.xlsx.read(Readable.fromWeb(response.body as any));
    testUtils.checkTestBook(wb2, "xlsx", undefined, {});
  }, 5000);
});
