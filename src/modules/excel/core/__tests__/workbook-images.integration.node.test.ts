import fs from "fs";
import { promisify } from "util";

import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { anchorCol, anchorRow } from "@excel/core/anchor";
import { cellSetValue } from "@excel/core/cell";
import { getImage } from "@excel/core/workbook";
import { addWorkbookImage } from "@excel/core/workbook-core";
import {
  addBackgroundImage,
  addImage,
  getBackgroundImageId,
  getImages
} from "@excel/core/worksheet";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { makeTestDataPath, testFilePath } from "@test/utils";
import { describe, it, expect } from "vitest";

const excelTestDataPath = makeTestDataPath(import.meta.url, "../../__tests__/data");

const IMAGE_FILENAME = excelTestDataPath("image.png");

const TEST_XLSX_FILE_NAME = testFilePath("workbook-images.test");
const fsReadFileAsync = promisify(fs.readFile);

// =============================================================================
// Tests

describe("Workbook", () => {
  describe("Images", () => {
    it("stores background image", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");
      const imageId = addWorkbookImage(wb, {
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      Cell.setValue(ws, "A1", "Hello, World!");
      addBackgroundImage(ws, imageId);

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);

      const ws2 = Workbook.getWorksheet(wb2, "blort")!;
      expect(ws2).toBeDefined();

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const backgroundId2 = getBackgroundImageId(ws2!);
      const image = getImage(wb2, backgroundId2!);

      expect(Buffer.compare(imageData, image!.buffer as Uint8Array)).toBe(0);
    });

    it("stores embedded image and hyperlink", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");

      const imageId = addWorkbookImage(wb, {
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      Cell.setValue(ws, "A1", "Hello, World!");
      Cell.setValue(ws, "A2", {
        hyperlink: "http://www.somewhere.com",
        text: "www.somewhere.com"
      });
      addImage(ws, imageId, "C3:E6");

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);

      const ws2 = Workbook.getWorksheet(wb2, "blort")!;
      expect(ws2).toBeDefined();

      expect(Cell.getValue(ws, "A1")).toBe("Hello, World!");
      expect(Cell.getValue(ws, "A2")).toEqual({
        hyperlink: "http://www.somewhere.com",
        text: "www.somewhere.com"
      });

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const images = getImages(ws2!);
      expect(images.length).toBe(1);

      const imageDesc = images[0];
      expect(anchorCol(imageDesc.range!.tl)).toBe(2);
      expect(anchorRow(imageDesc.range!.tl)).toBe(2);
      expect(anchorCol(imageDesc.range!.br!)).toBe(5);
      expect(anchorRow(imageDesc.range!.br!)).toBe(6);

      const image = getImage(wb2, imageDesc.imageId!);
      expect(Buffer.compare(imageData, image!.buffer as Uint8Array)).toBe(0);
    });

    it("stores embedded image with oneCell", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");

      const imageId = addWorkbookImage(wb, {
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      addImage(ws, imageId, {
        tl: { col: 0.1125, row: 0.4 },
        br: { col: 2.101046875, row: 3.4 },
        editAs: "oneCell"
      });

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);

      const ws2 = Workbook.getWorksheet(wb2, "blort")!;
      expect(ws2).toBeDefined();

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const images = getImages(ws2!);
      expect(images.length).toBe(1);

      const imageDesc = images[0];
      expect(imageDesc.range!.editAs).toBe("oneCell");

      const image = getImage(wb2, imageDesc.imageId!);
      expect(Buffer.compare(imageData, image!.buffer as Uint8Array)).toBe(0);
    });

    it("stores embedded image with one-cell-anchor", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");

      const imageId = addWorkbookImage(wb, {
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      addImage(ws, imageId, {
        tl: { col: 0.1125, row: 0.4 },
        ext: { width: 100, height: 100 },
        editAs: "oneCell"
      });

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);

      const ws2 = Workbook.getWorksheet(wb2, "blort")!;
      expect(ws2).toBeDefined();

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const images = getImages(ws2!);
      expect(images.length).toBe(1);

      const imageDesc = images[0];
      expect(imageDesc.range!.editAs).toBe("oneCell");
      expect(imageDesc.range!.ext!.width).toBe(100);
      expect(imageDesc.range!.ext!.height).toBe(100);

      const image = getImage(wb2, imageDesc.imageId!);
      expect(Buffer.compare(imageData, image!.buffer as Uint8Array)).toBe(0);
    });

    it("stores embedded image with hyperlinks", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");

      const imageId = addWorkbookImage(wb, {
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      addImage(ws, imageId, {
        tl: { col: 0.1125, row: 0.4 },
        ext: { width: 100, height: 100 },
        editAs: "absolute",
        hyperlinks: {
          hyperlink: "http://www.somewhere.com",
          tooltip: "www.somewhere.com"
        }
      });

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);

      const ws2 = Workbook.getWorksheet(wb2, "blort")!;
      expect(ws2).toBeDefined();

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const images = getImages(ws2!);
      expect(images.length).toBe(1);

      const imageDesc = images[0];
      // **`"oneCell"`, not the `"absolute"` that was asked for**, and the request was the contradictory part.
      // An absolute anchor is positioned by `pos`; this image gave `tl` + `ext`, which is a one-cell anchor by
      // definition — so `<xdr:oneCellAnchor>` is what the file has always contained and what Excel has always
      // rendered. The old `"absolute"` came back only because the writer stored the string in an `editAs`
      // attribute that `CT_OneCellAnchor` does not define, which is a file Excel repairs. `range.editAs` now
      // reports the anchor the file actually uses.
      expect(imageDesc.range!.editAs).toBe("oneCell");
      expect(imageDesc.range!.ext!.width).toBe(100);
      expect(imageDesc.range!.ext!.height).toBe(100);

      expect(imageDesc.range!.hyperlinks).toEqual({
        hyperlink: "http://www.somewhere.com",
        tooltip: "www.somewhere.com"
      });

      const image = getImage(wb2, imageDesc.imageId!);
      expect(Buffer.compare(imageData, image!.buffer as Uint8Array)).toBe(0);
    });

    it("image extensions should not be case sensitive", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");

      const imageId1 = addWorkbookImage(wb, {
        filename: IMAGE_FILENAME,
        extension: "png"
      });

      const imageId2 = addWorkbookImage(wb, {
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });

      addImage(ws, imageId1, {
        tl: { col: 0.1125, row: 0.4 },
        ext: { width: 100, height: 100 }
      });

      addImage(ws, imageId2, {
        tl: { col: 0.1125, row: 0.4 },
        br: { col: 2.101046875, row: 3.4 },
        editAs: "oneCell"
      });

      await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);

      const ws2 = Workbook.getWorksheet(wb2, "blort")!;
      expect(ws2).toBeDefined();

      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const images = getImages(ws2!);
      expect(images.length).toBe(2);

      const imageDesc1 = images[0];
      expect(imageDesc1.range!.ext!.width).toBe(100);
      expect(imageDesc1.range!.ext!.height).toBe(100);
      const image1 = getImage(wb2, imageDesc1.imageId!);

      const imageDesc2 = images[1];
      expect(imageDesc2.range!.editAs).toBe("oneCell");

      const image2 = getImage(wb2, imageDesc1.imageId!);

      expect(Buffer.compare(imageData, image1!.buffer!)).toBe(0);
      expect(Buffer.compare(imageData, image2!.buffer!)).toBe(0);
    });

    describe("read-write round-trip", () => {
      it("does not duplicate images after read-write cycles", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, { tl: { col: 1, row: 0 }, br: { col: 2, row: 1 } });

        // First write
        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

        // Read back and write again
        await Workbook.readFile(wb, TEST_XLSX_FILE_NAME);
        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

        // Read the final file and verify images are not duplicated
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
        expect(ws2).toBeDefined();

        const images = getImages(ws2!);
        expect(images.length).toBe(1);
      });

      it("does not duplicate images after multiple read-write cycles", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, "B2:D4");

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

        // Perform 3 read-write cycles on the same workbook
        for (let i = 0; i < 3; i++) {
          await Workbook.readFile(wb, TEST_XLSX_FILE_NAME);
          await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
        }

        // Read the final file with a fresh workbook
        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
        expect(ws2).toBeDefined();

        const images = getImages(ws2!);
        expect(images.length).toBe(1);
      });

      it("does not duplicate when multiple images exist", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId1 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        const imgId2 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId1, "A1:B2");
        addImage(ws, imgId2, "C3:D4");

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

        // Read-write cycle
        await Workbook.readFile(wb, TEST_XLSX_FILE_NAME);
        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
        expect(ws2).toBeDefined();

        const images = getImages(ws2!);
        expect(images.length).toBe(2);
      });

      it("preserves image data through read-write cycle", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, "C3:E6");

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);
        await Workbook.readFile(wb, TEST_XLSX_FILE_NAME);
        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
        const images = getImages(ws2!);
        expect(images.length).toBe(1);

        const imageData = await fsReadFileAsync(IMAGE_FILENAME);
        const image = getImage(wb2, images[0].imageId!);
        expect(Buffer.compare(imageData, image!.buffer!)).toBe(0);
      });
    });

    describe("image range updates on row/column splice", () => {
      it("updates image range after insertRow", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, "B2:D4");

        // Insert a row before the image
        Worksheet.insertRow(ws, 1, []);

        const images = getImages(ws);
        expect(images.length).toBe(1);
        const img = images[0];
        // Image should shift down by 1 row (B2:D4 -> B3:D5)
        // nativeRow is 0-based: row 2 -> nativeRow 1, after insert -> nativeRow 2
        expect(img.range!.tl.nativeRow).toBe(2);
        expect(img.range!.tl.nativeCol).toBe(1);
        expect(img.range!.br!.nativeRow).toBe(5);
        expect(img.range!.br!.nativeCol).toBe(4);
      });

      it("does not update image range when inserting row after the image", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, "A1:B2");

        // Insert a row after the image
        Worksheet.insertRow(ws, 5, []);

        const images = getImages(ws);
        const img = images[0];
        // Image should not move (A1:B2 stays the same)
        // nativeRow for A1 with string range uses offset -1: row=1 -> nativeRow=0
        expect(img.range!.tl.nativeRow).toBe(0);
        expect(img.range!.tl.nativeCol).toBe(0);
        expect(img.range!.br!.nativeRow).toBe(2);
        expect(img.range!.br!.nativeCol).toBe(2);
      });

      it("updates image range after spliceRows with remove", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, "A3:B4");

        // Remove 1 row at row 1
        Worksheet.spliceRows(ws, 1, 1);

        const images = getImages(ws);
        const img = images[0];
        // Image should shift up by 1 row (A3:B4 -> A2:B3)
        // nativeRow: row 3 -> nativeRow 2, after remove -> nativeRow 1
        expect(img.range!.tl.nativeRow).toBe(1);
        expect(img.range!.br!.nativeRow).toBe(3);
      });

      it("updates image range after spliceColumns with insert", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, "B1:C2");

        // Insert a column before column B
        Worksheet.spliceColumns(ws, 1, 0, []);

        const images = getImages(ws);
        const img = images[0];
        // Image should shift right by 1 column (B1:C2 -> C1:D2)
        // tl: col=2 with offset -1 -> nativeCol=1, after insert -> nativeCol=2
        // br: col=3 with offset 0 -> nativeCol=3, after insert -> nativeCol=4
        expect(img.range!.tl.nativeCol).toBe(2);
        expect(img.range!.br!.nativeCol).toBe(4);
      });

      it("handles multiple images correctly during row splice", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId1 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        const imgId2 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId1, "A1:A1");
        addImage(ws, imgId2, "A3:B4");

        // Insert 2 rows at row 2
        Worksheet.spliceRows(ws, 2, 0, [], []);

        const images = getImages(ws);
        // First image at A1 should not move (nativeRow 0 < start-1 = 1)
        expect(images[0].range!.tl.nativeRow).toBe(0);
        // Second image at A3 should shift down by 2 (nativeRow 2 >= start-1 = 1)
        expect(images[1].range!.tl.nativeRow).toBe(4);
        expect(images[1].range!.br!.nativeRow).toBe(6);
      });

      it("does not update background images during splice", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addBackgroundImage(ws, imgId);

        // Should not throw
        Worksheet.insertRow(ws, 1, []);

        // Background image should still exist
        expect(getBackgroundImageId(ws)).toBeDefined();
      });
    });

    describe("image duplication during row duplication", () => {
      it("duplicates images anchored to the source row", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, { tl: { col: 1, row: 0 }, br: { col: 2, row: 1 } });
        Cell.setValue(ws, "A1", "Row 1");

        // Duplicate row 1 twice (creates rows 2 and 3 as copies)
        Worksheet.duplicateRow(ws, 1, 2);

        const images = getImages(ws);
        // Original + 2 clones = 3 images
        expect(images.length).toBe(3);

        // Original stays at row 0 (0-based)
        expect(images[0].range!.tl.nativeRow).toBe(0);
        // Clone 1 at row 1 (0-based)
        expect(images[1].range!.tl.nativeRow).toBe(1);
        // Clone 2 at row 2 (0-based)
        expect(images[2].range!.tl.nativeRow).toBe(2);
      });

      it("preserves two-cell anchor span when duplicating", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        // Image spans 2 rows: tl at row 0, br at row 2
        addImage(ws, imgId, {
          tl: { col: 0, row: 0 },
          br: { col: 2, row: 2 }
        });

        Worksheet.duplicateRow(ws, 1, 1);

        const images = getImages(ws);
        expect(images.length).toBe(2);

        // Original: tl row 0, br row 2
        expect(images[0].range!.tl.nativeRow).toBe(0);
        expect(images[0].range!.br!.nativeRow).toBe(2);

        // Clone: tl row 1, br row 3 (same 2-row span)
        expect(images[1].range!.tl.nativeRow).toBe(1);
        expect(images[1].range!.br!.nativeRow).toBe(3);
      });

      it("duplicates one-cell anchor images (ext-based, no br)", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, {
          tl: { col: 0, row: 0 },
          ext: { width: 200, height: 150 }
        });

        Worksheet.duplicateRow(ws, 1, 1);

        const images = getImages(ws);
        expect(images.length).toBe(2);

        // Clone should have the same ext and no br
        const cloned = images[1];
        expect(cloned.range!.tl.nativeRow).toBe(1);
        expect(cloned.range!.br).toBeUndefined();
        expect(cloned.range!.ext).toEqual({ width: 200, height: 150 });
      });

      it("duplicates multiple images on the same source row", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId1 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        const imgId2 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        // Two images on row 1 (0-based row 0), different columns
        addImage(ws, imgId1, {
          tl: { col: 0, row: 0 },
          br: { col: 1, row: 1 }
        });
        addImage(ws, imgId2, {
          tl: { col: 3, row: 0 },
          br: { col: 4, row: 1 }
        });

        Worksheet.duplicateRow(ws, 1, 1);

        const images = getImages(ws);
        // 2 originals + 2 clones = 4
        expect(images.length).toBe(4);

        // Clones should be at row 1 (0-based), same columns as originals
        expect(images[2].range!.tl.nativeRow).toBe(1);
        expect(images[2].range!.tl.nativeCol).toBe(0);
        expect(images[3].range!.tl.nativeRow).toBe(1);
        expect(images[3].range!.tl.nativeCol).toBe(3);
      });

      it("does not clone images from other rows", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId1 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        const imgId2 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        // Image on row 1 (0-based row 0)
        addImage(ws, imgId1, {
          tl: { col: 0, row: 0 },
          br: { col: 1, row: 1 }
        });
        // Image on row 5 (0-based row 4)
        addImage(ws, imgId2, {
          tl: { col: 0, row: 4 },
          br: { col: 1, row: 5 }
        });

        // insert=true so spliceRows inserts a new row, shifting images below
        Worksheet.duplicateRow(ws, 1, 1, true);

        const images = getImages(ws);
        // 2 originals + 1 clone (from row 1 only) = 3
        expect(images.length).toBe(3);

        // The row-5 image should be shifted down by 1 (spliceRows effect)
        // but not duplicated. Original was nativeRow 4, after splice it becomes 5
        const row5Image = images[1]; // the second original
        expect(row5Image.range!.tl.nativeRow).toBe(5);
      });

      it("preserves hyperlinks on cloned images", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        addImage(ws, imgId, {
          tl: { col: 0, row: 0 },
          ext: { width: 100, height: 100 },
          hyperlinks: {
            hyperlink: "http://example.com",
            tooltip: "Example"
          }
        });

        Worksheet.duplicateRow(ws, 1, 1);

        const images = getImages(ws);
        expect(images.length).toBe(2);

        const cloned = images[1];
        expect(cloned.range!.hyperlinks).toEqual({
          hyperlink: "http://example.com",
          tooltip: "Example"
        });
      });

      it("round-trips duplicated images through write/read", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        Cell.setValue(ws, "A1", "Hello");
        addImage(ws, imgId, {
          tl: { col: 1, row: 0 },
          br: { col: 2, row: 1 }
        });

        Worksheet.duplicateRow(ws, 1, 2);

        // Write and read back
        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;
        expect(ws2).toBeDefined();

        const images = getImages(ws2!);
        expect(images.length).toBe(3);

        // Verify positions survived round-trip
        expect(images[0].range!.tl.nativeRow).toBe(0);
        expect(images[1].range!.tl.nativeRow).toBe(1);
        expect(images[2].range!.tl.nativeRow).toBe(2);

        // Verify image data is intact
        const imageData = await fsReadFileAsync(IMAGE_FILENAME);
        for (const img of images) {
          const imgBuffer = getImage(wb2, img.imageId!);
          expect(Buffer.compare(imageData, imgBuffer!.buffer!)).toBe(0);
        }
      });

      it("works with insert mode", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        Cell.setValue(ws, "A1", "Row 1");
        Cell.setValue(ws, "A2", "Row 2");
        addImage(ws, imgId, {
          tl: { col: 1, row: 0 },
          br: { col: 2, row: 1 }
        });

        // insert=true: inserts new rows instead of overwriting
        Worksheet.duplicateRow(ws, 1, 1, true);

        const images = getImages(ws);
        expect(images.length).toBe(2);

        // Original at row 0
        expect(images[0].range!.tl.nativeRow).toBe(0);
        // Clone at row 1
        expect(images[1].range!.tl.nativeRow).toBe(1);
      });

      it("loads test file and duplicates row with images", async () => {
        const wb = Workbook.create();
        await Workbook.readFile(wb, excelTestDataPath("duplicate-row-images.xlsx"));

        // The test file has a drawing on sheet3 with an image at row 12
        const ws = Workbook.getWorksheet(wb, "Sheet3")!;
        expect(ws).toBeDefined();

        const imagesBefore = getImages(ws!);
        const countBefore = imagesBefore.length;
        expect(countBefore).toBeGreaterThan(0);

        // Find which row has the image (0-based nativeRow -> 1-based rowNum)
        const srcRow0 = imagesBefore[0].range!.tl.nativeRow;
        const srcRowNum = srcRow0 + 1;

        // Duplicate that row once (insert mode to push existing rows down)
        Worksheet.duplicateRow(ws!, srcRowNum, 1, true);

        const imagesAfter = getImages(ws!);
        // Each image on the source row should be cloned once
        const imagesOnSrcRow = imagesBefore.filter(
          img => img.range && img.range.tl.nativeRow === srcRow0
        );
        expect(imagesAfter.length).toBe(countBefore + imagesOnSrcRow.length);

        // Write and read back to verify integrity
        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "Sheet3")!;
        const finalImages = getImages(ws2!);
        expect(finalImages.length).toBe(countBefore + imagesOnSrcRow.length);
      });

      it("overwrite mode removes images on target rows before cloning", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId1 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        const imgId2 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });

        // Image on row 1 (0-based row 0)
        addImage(ws, imgId1, {
          tl: { col: 0, row: 0 },
          br: { col: 1, row: 1 }
        });
        // Image on row 2 (0-based row 1) — this will be overwritten
        addImage(ws, imgId2, {
          tl: { col: 2, row: 1 },
          br: { col: 3, row: 2 }
        });

        // Overwrite mode (default): duplicate row 1 once, overwriting row 2
        Worksheet.duplicateRow(ws, 1, 1);

        const images = getImages(ws);
        // Original on row 1 + clone on row 2 = 2 (old row-2 image removed)
        expect(images.length).toBe(2);

        // Original stays at row 0
        expect(images[0].range!.tl.nativeRow).toBe(0);
        expect(images[0].range!.tl.nativeCol).toBe(0);

        // Clone at row 1 (0-based), same column as the source
        expect(images[1].range!.tl.nativeRow).toBe(1);
        expect(images[1].range!.tl.nativeCol).toBe(0);
      });

      it("overwrite mode with no source images still removes target row images", () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const imgId = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });

        Cell.setValue(ws, "A1", "Row 1 (no images)");
        // Image on row 2 (0-based row 1)
        addImage(ws, imgId, {
          tl: { col: 0, row: 1 },
          br: { col: 1, row: 2 }
        });

        // Overwrite mode: duplicate row 1 once, overwriting row 2
        Worksheet.duplicateRow(ws, 1, 1);

        const images = getImages(ws);
        // Old row-2 image should be removed since the row was overwritten
        expect(images.length).toBe(0);
      });
    });

    describe("image deduplication", () => {
      it("deduplicates drawing rels for non-consecutive same imageId", async () => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");

        // Add two different images and use the first one again (non-consecutive)
        const imgId1 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });
        const imgId2 = addWorkbookImage(wb, {
          filename: IMAGE_FILENAME,
          extension: "png"
        });

        // Pattern: imgId1, imgId2, imgId1 — tests non-consecutive dedup
        addImage(ws, imgId1, "A1:B2");
        addImage(ws, imgId2, "C3:D4");
        addImage(ws, imgId1, "E5:F6");

        await Workbook.writeFile(wb, TEST_XLSX_FILE_NAME);

        const wb2 = Workbook.create();
        await Workbook.readFile(wb2, TEST_XLSX_FILE_NAME);
        const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

        const images = getImages(ws2);
        expect(images.length).toBe(3);

        // All 3 images should be valid and readable
        const imageData = await fsReadFileAsync(IMAGE_FILENAME);
        for (const img of images) {
          const imgBuffer = getImage(wb2, img.imageId!);
          expect(imgBuffer).toBeDefined();
          expect(Buffer.compare(imageData, imgBuffer!.buffer!)).toBe(0);
        }
      });
    });

    it("round-trips absoluteAnchor image through write and read", async () => {
      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "absolute");
      const imageId = addWorkbookImage(wb, {
        buffer: imageData,
        extension: "png"
      });

      // Add image with absolute positioning (pos + ext)
      addImage(ws, imageId, {
        pos: { x: 50, y: 100 },
        ext: { width: 200, height: 150 }
      });

      const buffer = await Workbook.toBuffer(wb);
      await expectValidXlsx(buffer, { label: "absoluteAnchor image" });

      // Read back
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);
      const ws2 = Workbook.getWorksheet(wb2, "absolute")!;
      const images = getImages(ws2);

      expect(images).toHaveLength(1);
      const img = images[0];

      // Verify absolute position is preserved
      expect(img.range).toBeDefined();
      expect(img.range!.pos).toEqual({ x: 50, y: 100 });
      expect(img.range!.ext).toEqual({ width: 200, height: 150 });

      // Verify the actual image data survived
      const imgBuffer = getImage(wb2, img.imageId!);
      expect(imgBuffer).toBeDefined();
      expect(Buffer.compare(imageData, imgBuffer!.buffer as Uint8Array)).toBe(0);
    });

    it("round-trips absoluteAnchor image through streaming writer", async () => {
      const { WorkbookWriter } = await import("@excel/stream/workbook-writer");
      const imageData = await fsReadFileAsync(IMAGE_FILENAME);

      const outFile = testFilePath("streaming-absolute-anchor.test");
      const wb = new WorkbookWriter({ filename: outFile });
      const imageId = wb.addImage({ buffer: imageData, extension: "png" });

      const ws = wb.addWorksheet("absolute");
      ws.addImage(imageId, {
        pos: { x: 30, y: 60 },
        ext: { width: 120, height: 80 }
      });

      cellSetValue(ws.getCell("A1"), "data");
      ws.commit();
      await wb.commit();

      // Read back with standard reader
      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, outFile);
      const ws2 = Workbook.getWorksheet(wb2, "absolute")!;
      const images = getImages(ws2);

      expect(images).toHaveLength(1);
      expect(images[0].range!.pos).toEqual({ x: 30, y: 60 });
      expect(images[0].range!.ext).toEqual({ width: 120, height: 80 });

      const imgBuffer = getImage(wb2, images[0].imageId!);
      expect(imgBuffer).toBeDefined();
      expect(Buffer.compare(imageData, imgBuffer!.buffer as Uint8Array)).toBe(0);
    });
  });

  describe("SVG with raster fallback", () => {
    const SVG_BYTES = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>',
      "utf8"
    );

    it("embeds an SVG picture with a raster fallback and round-trips both", async () => {
      const pngBytes = await fsReadFileAsync(IMAGE_FILENAME);
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "svg");

      const imageId = addWorkbookImage(wb, {
        buffer: pngBytes,
        extension: "png",
        svg: { buffer: SVG_BYTES }
      });
      addImage(ws, imageId, "B2:D5");

      const file = testFilePath("workbook-svg.test");
      await Workbook.writeFile(wb, file);
      await expectValidXlsx(await fsReadFileAsync(file), { label: "svg-image" });

      const wb2 = Workbook.create();
      await Workbook.readFile(wb2, file);
      const ws2 = Workbook.getWorksheet(wb2, "svg")!;

      const images = getImages(ws2);
      expect(images).toHaveLength(1);

      // Raster fallback round-trips byte-for-byte.
      const raster = getImage(wb2, images[0].imageId!);
      expect(raster!.extension).toBe("png");
      expect(Buffer.compare(pngBytes, raster!.buffer as Uint8Array)).toBe(0);

      // The SVG companion is linked via svgMediaId and round-trips its bytes.
      const svgMediaId = (raster as any).svgMediaId;
      expect(typeof svgMediaId).toBe("number");
      const svg = getImage(wb2, svgMediaId);
      expect(svg!.extension).toBe("svg");
      expect(Buffer.compare(SVG_BYTES, svg!.buffer as Uint8Array)).toBe(0);
    });

    it("writes the svgBlip extension and image/svg+xml content type", async () => {
      const pngBytes = await fsReadFileAsync(IMAGE_FILENAME);
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "svg");
      const imageId = addWorkbookImage(wb, {
        buffer: pngBytes,
        extension: "png",
        svg: { buffer: SVG_BYTES }
      });
      addImage(ws, imageId, "A1:B2");

      const buffer = await Workbook.toBuffer(wb);
      const { unzip } = await import("@archive/read-archive");
      const reader = unzip(buffer);
      const entries: Record<string, string> = {};
      for await (const entry of reader.entries()) {
        const bytes = await entry.bytes();
        entries[entry.path] = new TextDecoder().decode(bytes ?? new Uint8Array());
      }

      // Content type registers SVG correctly (image/svg+xml, not image/svg).
      expect(entries["[Content_Types].xml"]).toContain(
        '<Default Extension="svg" ContentType="image/svg+xml"/>'
      );

      // The drawing carries the asvg:svgBlip extension under the raster blip.
      const drawingKey = Object.keys(entries).find(k => /drawings\/drawing\d+\.xml$/.test(k))!;
      const drawingXml = entries[drawingKey];
      expect(drawingXml).toContain("asvg:svgBlip");
      expect(drawingXml).toContain("{96DAC541-7B7A-43D3-8B79-37D633B846F1}");
    });

    it("creates only one svg relationship when the image is reused across anchors", async () => {
      const pngBytes = await fsReadFileAsync(IMAGE_FILENAME);
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "svg");
      const imageId = addWorkbookImage(wb, {
        buffer: pngBytes,
        extension: "png",
        svg: { buffer: SVG_BYTES }
      });
      addImage(ws, imageId, "A1:B2");
      addImage(ws, imageId, "D1:E2"); // same image, second anchor

      const buffer = await Workbook.toBuffer(wb);
      const { unzip } = await import("@archive/read-archive");
      const reader = unzip(buffer);
      const entries: Record<string, string> = {};
      for await (const entry of reader.entries()) {
        const bytes = await entry.bytes();
        entries[entry.path] = new TextDecoder().decode(bytes ?? new Uint8Array());
      }
      const relKey = Object.keys(entries).find(k =>
        /drawings\/_rels\/drawing\d+\.xml\.rels$/.test(k)
      )!;
      const rels = entries[relKey];
      // The raster + svg media are each referenced by exactly one relationship.
      expect((rels.match(/image\d+\.png/g) ?? []).length).toBe(1);
      expect((rels.match(/image\d+\.svg/g) ?? []).length).toBe(1);
    });

    it("survives a second write→read→write round-trip with the SVG intact", async () => {
      const pngBytes = await fsReadFileAsync(IMAGE_FILENAME);
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "svg");
      const imageId = addWorkbookImage(wb, {
        buffer: pngBytes,
        extension: "png",
        svg: { buffer: SVG_BYTES }
      });
      addImage(ws, imageId, "B2:D5");

      // First round-trip.
      const buf1 = await Workbook.toBuffer(wb);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buf1);

      // Second round-trip from the re-read workbook.
      const buf2 = await Workbook.toBuffer(wb2);
      const { unzip } = await import("@archive/read-archive");
      const reader = unzip(buf2);
      const entries: Record<string, string> = {};
      for await (const entry of reader.entries()) {
        const bytes = await entry.bytes();
        entries[entry.path] = new TextDecoder().decode(bytes ?? new Uint8Array());
      }
      const drawingKey = Object.keys(entries).find(k => /drawings\/drawing\d+\.xml$/.test(k))!;
      expect(entries[drawingKey]).toContain("asvg:svgBlip");

      const wb3 = Workbook.create();
      await Workbook.read(wb3, buf2);
      const raster = getImage(wb3, getImages(Workbook.getWorksheet(wb3, "svg")!)[0].imageId!);
      expect(Buffer.compare(pngBytes, raster!.buffer as Uint8Array)).toBe(0);
      const svgMediaId = (raster as { svgMediaId?: number }).svgMediaId;
      expect(typeof svgMediaId).toBe("number");
      expect(Buffer.compare(SVG_BYTES, getImage(wb3, svgMediaId!)!.buffer as Uint8Array)).toBe(0);
    });

    it("rejects an SVG combined with an external (linked) raster", () => {
      const wb = Workbook.create();
      expect(() =>
        addWorkbookImage(wb, {
          extension: "png",
          link: "https://example.com/x.png",
          svg: { buffer: SVG_BYTES }
        })
      ).toThrow(/raster fallback/);
    });
  });
});
