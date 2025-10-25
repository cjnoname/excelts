import { describe, it, expect } from "vitest";
import fs from "fs";
import { promisify } from "util";
import { testUtils } from "../../utils/index.js";
import { Workbook, WorkbookWriter } from "../../../index.js";
import { testFilePath } from "../../utils/test-file-helper.js";

const TEST_XLSX_FILE_NAME = testFilePath("wb-xlsx-writer.test");
const IMAGE_FILENAME = `${__dirname}/../data/image.png`;
const fsReadFileAsync = promisify(fs.readFile);

describe("WorkbookWriter", () => {
  it("creates sheets with correct names", () => {
    const wb = new WorkbookWriter();
    const ws1 = wb.addWorksheet("Hello, World!");
    expect(ws1.name).toBe("Hello, World!");

    const ws2 = wb.addWorksheet();
    expect(ws2.name).toMatch(/sheet\d+/);
  });

  describe("Serialise", () => {
    it("xlsx file", () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true
      };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx");

      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          testUtils.checkTestBook(wb2, "xlsx");
        });
    });

    it("shared formula", () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: false
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");
      ws.getCell("A1").value = {
        formula: "ROW()+COLUMN()",
        ref: "A1:B2",
        result: 2
      };
      ws.getCell("B1").value = { sharedFormula: "A1", result: 3 };
      ws.getCell("A2").value = { sharedFormula: "A1", result: 3 };
      ws.getCell("B2").value = { sharedFormula: "A1", result: 4 };

      ws.commit();
      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          const ws2 = wb2.getWorksheet("Hello");
          expect(ws2.getCell("A1").value).toEqual({
            formula: "ROW()+COLUMN()",
            shareType: "shared",
            ref: "A1:B2",
            result: 2
          });
          expect(ws2.getCell("B1").value).toEqual({
            sharedFormula: "A1",
            result: 3
          });
          expect(ws2.getCell("A2").value).toEqual({
            sharedFormula: "A1",
            result: 3
          });
          expect(ws2.getCell("B2").value).toEqual({
            sharedFormula: "A1",
            result: 4
          });
        });
    });

    it("auto filter", () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: false
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");
      ws.getCell("A1").value = 1;
      ws.getCell("B1").value = 1;
      ws.getCell("A2").value = 2;
      ws.getCell("B2").value = 2;
      ws.getCell("A3").value = 3;
      ws.getCell("B3").value = 3;

      ws.autoFilter = "A1:B1";
      ws.commit();

      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          const ws2 = wb2.getWorksheet("Hello");
          expect(ws2.autoFilter).toBe("A1:B1");
        });
    });

    it("Without styles", () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: false
      };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx");

      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          testUtils.checkTestBook(wb2, "xlsx", undefined, {
            checkStyles: false
          });
        });
    });

    it("serializes row styles and columns properly", () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("blort");

      const colStyle = {
        font: testUtils.styles.fonts.comicSansUdB16,
        alignment: testUtils.styles.namedAlignments.middleCentre
      };
      ws.columns = [
        { header: "A1", width: 10 },
        { header: "B1", style: colStyle },
        { header: "C1", width: 30 },
        { header: "D1" }
      ];

      ws.getRow(2).font = testUtils.styles.fonts.broadwayRedOutline20;

      ws.getCell("A2").value = "A2";
      ws.getCell("B2").value = "B2";
      ws.getCell("C2").value = "C2";
      ws.getCell("A3").value = "A3";
      ws.getCell("B3").value = "B3";
      ws.getCell("C3").value = "C3";

      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          const ws2 = wb2.getWorksheet("blort");
          ["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "C3"].forEach(address => {
            expect(ws2.getCell(address).value).toBe(address);
          });
          expect(ws2.getCell("B1").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
          expect(ws2.getCell("B1").alignment).toEqual(
            testUtils.styles.namedAlignments.middleCentre
          );
          expect(ws2.getCell("A2").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
          expect(ws2.getCell("B2").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
          expect(ws2.getCell("C2").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
          expect(ws2.getCell("B3").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
          expect(ws2.getCell("B3").alignment).toEqual(
            testUtils.styles.namedAlignments.middleCentre
          );

          expect(ws2.getColumn(2).font).toEqual(testUtils.styles.fonts.comicSansUdB16);
          expect(ws2.getColumn(2).alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
          expect(ws2.getColumn(2).width).toBe(9);

          expect(ws2.getColumn(4).width).toBe(undefined);

          expect(ws2.getRow(2).font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
        });
    });

    it("rich text", () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      ws.getCell("A1").value = {
        richText: [
          {
            font: { color: { argb: "FF0000" } },
            text: "red "
          },
          {
            font: { color: { argb: "00FF00" }, bold: true },
            text: " bold green"
          }
        ]
      };

      ws.getCell("B1").value = "plain text";

      ws.commit();
      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          const ws2 = wb2.getWorksheet("Hello");
          expect(ws2.getCell("A1").value).toEqual({
            richText: [
              {
                font: { color: { argb: "FF0000" } },
                text: "red "
              },
              {
                font: { color: { argb: "00FF00" }, bold: true },
                text: " bold green"
              }
            ]
          });
          expect(ws2.getCell("B1").value).toBe("plain text");
        });
    });

    it("A lot of sheets", function () {
      let i;
      const wb = new WorkbookWriter({
        filename: TEST_XLSX_FILE_NAME
      });
      const numSheets = 90;
      // add numSheets sheets
      for (i = 1; i <= numSheets; i++) {
        const ws = wb.addWorksheet(`sheet${i}`);
        ws.getCell("A1").value = i;
      }
      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          for (i = 1; i <= numSheets; i++) {
            const ws2 = wb2.getWorksheet(`sheet${i}`);
            expect(ws2).toBeTruthy();
            expect(ws2.getCell("A1").value).toBe(i);
          }
        });
    });

    it("addRow", () => {
      const options = {
        stream: fs.createWriteStream(TEST_XLSX_FILE_NAME, { flags: "w" }),
        useStyles: true,
        useSharedStrings: true
      };
      const workbook = new WorkbookWriter(options);
      const worksheet = workbook.addWorksheet("test");
      const newRow = worksheet.addRow(["hello"]);
      newRow.commit();
      worksheet.commit();
      return workbook.commit();
    });

    it("defined names", () => {
      const wb = new WorkbookWriter({
        filename: TEST_XLSX_FILE_NAME
      });
      const ws = wb.addWorksheet("blort");
      ws.getCell("A1").value = 5;
      ws.getCell("A1").name = "five";

      ws.getCell("A3").value = "drei";
      ws.getCell("A3").name = "threes";
      ws.getCell("B3").value = "trois";
      ws.getCell("B3").name = "threes";
      ws.getCell("B3").value = "san";
      ws.getCell("B3").name = "threes";

      ws.getCell("E1").value = "grün";
      ws.getCell("E1").name = "greens";
      ws.getCell("E2").value = "vert";
      ws.getCell("E2").name = "greens";
      ws.getCell("E3").value = "verde";
      ws.getCell("E3").name = "greens";

      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          const ws2 = wb2.getWorksheet("blort");
          expect(ws2.getCell("A1").name).toBe("five");

          expect(ws2.getCell("A3").name).toBe("threes");
          expect(ws2.getCell("B3").name).toBe("threes");
          expect(ws2.getCell("B3").name).toBe("threes");

          expect(ws2.getCell("E1").name).toBe("greens");
          expect(ws2.getCell("E2").name).toBe("greens");
          expect(ws2.getCell("E3").name).toBe("greens");
        });
    });

    it("does not escape special xml characters", () => {
      const wb = new WorkbookWriter({
        filename: TEST_XLSX_FILE_NAME,
        useSharedStrings: true
      });
      const ws = wb.addWorksheet("blort");
      const xmlCharacters = 'xml characters: & < > "';

      ws.getCell("A1").value = xmlCharacters;

      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          const ws2 = wb2.getWorksheet("blort");
          expect(ws2.getCell("A1").value).toBe(xmlCharacters);
        });
    });

    it("serializes and deserializes dataValidations", () => {
      const options = { filename: TEST_XLSX_FILE_NAME };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx", ["dataValidations"]);

      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          testUtils.checkTestBook(wb2, "xlsx", ["dataValidations"]);
        });
    });

    it("with zip compression option", () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true,
        zip: {
          zlib: { level: 9 } // Sets the compression level.
        }
      };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx", ["dataValidations"]);

      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          testUtils.checkTestBook(wb2, "xlsx", ["dataValidations"]);
        });
    });

    it("writes notes", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");
      ws.getCell("B2").value = 5;
      ws.getCell("B2").note = "five";

      const note = {
        texts: [
          {
            font: {
              size: 12,
              color: { argb: "FFFF6600" },
              name: "Calibri",
              scheme: "minor"
            },
            text: "seven"
          }
        ],
        margins: {
          insetmode: "auto",
          inset: [0.13, 0.13, 0.25, 0.25]
        },
        protection: {
          locked: "True",
          lockText: "True"
        },
        editAs: "twoCells"
      };
      ws.getCell("D2").value = 7;
      ws.getCell("D2").note = note;

      await wb.commit();

      const wb2 = new Workbook();
      await wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
      const ws2 = wb2.getWorksheet("Hello");

      expect(ws2.getCell("B2").value).toBe(5);
      expect(ws2.getCell("B2").note).toBe("five");
      expect(ws2.getCell("D2").value).toBe(7);
      expect(ws2.getCell("D2").note.texts).toEqual(note.texts);
      expect(ws2.getCell("D2").note.margins).toEqual(note.margins);
      expect(ws2.getCell("D2").note.protection).toEqual(note.protection);
      expect(ws2.getCell("D2").note.editAs).toEqual(note.editAs);
    });

    it("Cell annotation supports setting margins and protection properties", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");
      ws.getCell("B2").value = 5;
      ws.getCell("B2").note = "five";
      const note = {
        texts: [
          {
            font: {
              size: 12,
              color: { argb: "FFFF6600" },
              name: "Calibri",
              scheme: "minor"
            },
            text: "seven"
          }
        ],
        margins: {
          insetmode: "custom",
          inset: [0.25, 0.25, 0.35, 0.35]
        },
        protection: {
          locked: "False",
          lockText: "False"
        },
        editAs: "oneCells"
      };
      ws.getCell("D2").value = 7;
      ws.getCell("D2").note = note;

      await wb.commit();

      const wb2 = new Workbook();
      await wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
      const ws2 = wb2.getWorksheet("Hello");
      expect(ws2.getCell("B2").value).toBe(5);
      expect(ws2.getCell("B2").note).toBe("five");

      expect(ws2.getCell("D2").value).toBe(7);
      expect(ws2.getCell("D2").note.texts).toEqual(note.texts);
      expect(ws2.getCell("D2").note.margins).toEqual(note.margins);
      expect(ws2.getCell("D2").note.protection).toEqual(note.protection);
      expect(ws2.getCell("D2").note.editAs).toEqual(note.editAs);
    });

    it("with background image", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });
      ws.getCell("A1").value = "Hello, World!";
      ws.addBackgroundImage(imageId);

      await wb.commit();

      const wb2 = new Workbook();
      await wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
      const ws2 = wb2.getWorksheet("Hello");

      const backgroundId2 = ws2.getBackgroundImageId();
      const image = wb2.getImage(backgroundId2);
      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      expect(Buffer.compare(imageData, image.buffer)).toBe(0);
    });

    it("with background image where worksheet is commited in advance", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME
      };
      const wb = new WorkbookWriter(options);
      const ws = wb.addWorksheet("Hello");

      const imageId = wb.addImage({
        filename: IMAGE_FILENAME,
        extension: "jpeg"
      });
      ws.getCell("A1").value = "Hello, World!";
      ws.addBackgroundImage(imageId);

      await ws.commit();
      await wb.commit();

      const wb2 = new Workbook();
      await wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
      const ws2 = wb2.getWorksheet("Hello");

      const backgroundId2 = ws2.getBackgroundImageId();
      const image = wb2.getImage(backgroundId2);
      const imageData = await fsReadFileAsync(IMAGE_FILENAME);
      expect(Buffer.compare(imageData, image.buffer)).toBe(0);
    });

    it("with conditional formatting", async () => {
      const options = {
        filename: TEST_XLSX_FILE_NAME,
        useStyles: true,
        useSharedStrings: true
      };
      const wb = testUtils.createTestBook(new WorkbookWriter(options), "xlsx", [
        "conditionalFormatting"
      ]);

      return wb
        .commit()
        .then(() => {
          const wb2 = new Workbook();
          return wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
        })
        .then(wb2 => {
          testUtils.checkTestBook(wb2, "xlsx", ["conditionalFormatting"]);
        });
    });

    it("with conditional formatting that contains numFmt (#1814)", async () => {
      const sheet = "conditionalFormatting";
      const options = { filename: TEST_XLSX_FILE_NAME, useStyles: true };

      // generate file with conditional formatting that contains styles with numFmt
      const wb1 = new WorkbookWriter(options);
      const ws1 = wb1.addWorksheet(sheet);
      const cf1 = testUtils.conditionalFormatting.abbreviation;
      ws1.addConditionalFormatting(cf1);
      await wb1.commit();

      // read generated file and extract saved conditional formatting rule
      const wb2 = new Workbook();
      await wb2.xlsx.readFile(TEST_XLSX_FILE_NAME);
      const ws2 = wb2.getWorksheet(sheet);
      const [cf2] = ws2.conditionalFormattings;

      // verify that rules from generated file contain styles with valid numFmt
      cf2.rules.forEach(rule => {
        expect(rule.style.numFmt).toBeDefined();
        expect(rule.style.numFmt.id).to.be.a("number");
        expect(rule.style.numFmt.formatCode).to.be.a("string");
      });
    });
  });
});
