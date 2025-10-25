import { describe, it, expect } from "vitest";
import fs from "fs";
import { promisify } from "util";
import { Workbook } from "../../../index.js";

const IMAGE_FILENAME = `${__dirname}/../data/image.png`;
import { testFilePath } from "../../utils/test-file-helper.js";

const TEST_XLSX_FILE_NAME = testFilePath("workbook-images.test");
const fsReadFileAsync = promisify(fs.readFile);

// =============================================================================
// Tests

describe("Workbook", () => {
  describe("Images", () => {
    it("stores background image", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");
      let wb2;
      let ws2;
      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      ws.getCell("A1").value = "Hello, World!";
      ws.addBackgroundImage(imageId);

      return wb.xlsx
        .writeFile(TEST_XLSX_FILE_NAME)
        .then(() => {
          wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(() => {
          ws2 = wb2.getWorksheet("blort");
          expect(ws2).toBeDefined();

          return fsReadFileAsync(IMAGE_FILENAME);
        })
        .then(imageData => {
          const backgroundId2 = ws2.getBackgroundImageId();
          const image = wb2.getImage(backgroundId2);

          expect(Buffer.compare(imageData, image.buffer)).toBe(0);
        });
    });

    it("stores embedded image and hyperlink", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");
      let wb2;
      let ws2;

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      ws.getCell("A1").value = "Hello, World!";
      ws.getCell("A2").value = {
        hyperlink: "http://www.somewhere.com",
        text: "www.somewhere.com"
      };
      ws.addImage(imageId, "C3:E6");

      return wb.xlsx
        .writeFile(TEST_XLSX_FILE_NAME)
        .then(() => {
          wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(() => {
          ws2 = wb2.getWorksheet("blort");
          expect(ws2).toBeDefined();

          expect(ws.getCell("A1").value).toBe("Hello, World!");
          expect(ws.getCell("A2").value).toEqual({
            hyperlink: "http://www.somewhere.com",
            text: "www.somewhere.com"
          });

          return fsReadFileAsync(IMAGE_FILENAME);
        })
        .then(imageData => {
          const images = ws2.getImages();
          expect(images.length).toBe(1);

          const imageDesc = images[0];
          expect(imageDesc.range.tl.col).toBe(2);
          expect(imageDesc.range.tl.row).toBe(2);
          expect(imageDesc.range.br.col).toBe(5);
          expect(imageDesc.range.br.row).toBe(6);

          const image = wb2.getImage(imageDesc.imageId);
          expect(Buffer.compare(imageData, image.buffer)).toBe(0);
        });
    });

    it("stores embedded image with oneCell", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");
      let wb2;
      let ws2;

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      ws.addImage(imageId, {
        tl: { col: 0.1125, row: 0.4 },
        br: { col: 2.101046875, row: 3.4 },
        editAs: "oneCell"
      });

      return wb.xlsx
        .writeFile(TEST_XLSX_FILE_NAME)
        .then(() => {
          wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(() => {
          ws2 = wb2.getWorksheet("blort");
          expect(ws2).toBeDefined();

          return fsReadFileAsync(IMAGE_FILENAME);
        })
        .then(imageData => {
          const images = ws2.getImages();
          expect(images.length).toBe(1);

          const imageDesc = images[0];
          expect(imageDesc.range.editAs).toBe("oneCell");

          const image = wb2.getImage(imageDesc.imageId);
          expect(Buffer.compare(imageData, image.buffer)).toBe(0);
        });
    });

    it("stores embedded image with one-cell-anchor", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");
      let wb2;
      let ws2;

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      ws.addImage(imageId, {
        tl: { col: 0.1125, row: 0.4 },
        ext: { width: 100, height: 100 },
        editAs: "oneCell"
      });

      return wb.xlsx
        .writeFile(TEST_XLSX_FILE_NAME)
        .then(() => {
          wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(() => {
          ws2 = wb2.getWorksheet("blort");
          expect(ws2).toBeDefined();

          return fsReadFileAsync(IMAGE_FILENAME);
        })
        .then(imageData => {
          const images = ws2.getImages();
          expect(images.length).toBe(1);

          const imageDesc = images[0];
          expect(imageDesc.range.editAs).toBe("oneCell");
          expect(imageDesc.range.ext.width).toBe(100);
          expect(imageDesc.range.ext.height).toBe(100);

          const image = wb2.getImage(imageDesc.imageId);
          expect(Buffer.compare(imageData, image.buffer)).toBe(0);
        });
    });

    it("stores embedded image with hyperlinks", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");
      let wb2;
      let ws2;

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      ws.addImage(imageId, {
        tl: { col: 0.1125, row: 0.4 },
        ext: { width: 100, height: 100 },
        editAs: "absolute",
        hyperlinks: {
          hyperlink: "http://www.somewhere.com",
          tooltip: "www.somewhere.com"
        }
      });

      return wb.xlsx
        .writeFile(TEST_XLSX_FILE_NAME)
        .then(() => {
          wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(() => {
          ws2 = wb2.getWorksheet("blort");
          expect(ws2).toBeDefined();

          return fsReadFileAsync(IMAGE_FILENAME);
        })
        .then(imageData => {
          const images = ws2.getImages();
          expect(images.length).toBe(1);

          const imageDesc = images[0];
          expect(imageDesc.range.editAs).toBe("absolute");
          expect(imageDesc.range.ext.width).toBe(100);
          expect(imageDesc.range.ext.height).toBe(100);

          expect(imageDesc.range.hyperlinks).toEqual({
            hyperlink: "http://www.somewhere.com",
            tooltip: "www.somewhere.com"
          });

          const image = wb2.getImage(imageDesc.imageId);
          expect(Buffer.compare(imageData, image.buffer)).toBe(0);
        });
    });

    it("image extensions should not be case sensitive", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");
      let wb2;
      let ws2;

      const imageId1 = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "PNG"
      });

      const imageId2 = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "JPEG"
      });

      ws.addImage(imageId1, {
        tl: { col: 0.1125, row: 0.4 },
        ext: { width: 100, height: 100 }
      });

      ws.addImage(imageId2, {
        tl: { col: 0.1125, row: 0.4 },
        br: { col: 2.101046875, row: 3.4 },
        editAs: "oneCell"
      });

      return wb.xlsx
        .writeFile(TEST_XLSX_FILE_NAME)
        .then(() => {
          wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(() => {
          ws2 = wb2.getWorksheet("blort");
          expect(ws2).toBeDefined();

          return fsReadFileAsync(IMAGE_FILENAME);
        })
        .then(imageData => {
          const images = ws2.getImages();
          expect(images.length).toBe(2);

          const imageDesc1 = images[0];
          expect(imageDesc1.range.ext.width).toBe(100);
          expect(imageDesc1.range.ext.height).toBe(100);
          const image1 = wb2.getImage(imageDesc1.imageId);

          const imageDesc2 = images[1];
          expect(imageDesc2.range.editAs).toBe("oneCell");

          const image2 = wb2.getImage(imageDesc1.imageId);

          expect(Buffer.compare(imageData, image1.buffer)).toBe(0);
          expect(Buffer.compare(imageData, image2.buffer)).toBe(0);
        });
    });
  });
});
