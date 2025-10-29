import { fix } from "./tools.js";
import testValuesJson from "./data/sheet-values.json" with { type: "json" };
const testValues = fix(testValuesJson);
import { utils } from "../../utils/utils.js";
import { WorkbookReader, ValueType } from "../../index.js";

function fillFormula(f) {
  return Object.assign({ formula: undefined }, f);
}

const streamedValues = {
  B1: { sharedString: 0 },
  C1: utils.dateToExcel(testValues.date),
  D1: fillFormula(testValues.formulas[0]),
  E1: fillFormula(testValues.formulas[1]),
  F1: { sharedString: 1 },
  G1: { sharedString: 2 }
};
import stylesJson from "./data/styles.json" with { type: "json" };
import propertiesJson from "./data/sheet-properties.json" with { type: "json" };
import pageSetupJson from "./data/page-setup.json" with { type: "json" };

const testWorkbookReader = {
  testValues: fix(testValuesJson),
  styles: fix(stylesJson),
  properties: fix(propertiesJson),
  pageSetup: fix(pageSetupJson),

  checkBook(filename: string): Promise<void> {
    const wb = new WorkbookReader({});

    // expectations
    const dateAccuracy = 0.00001;

    return new Promise<void>((resolve, reject) => {
      let rowCount = 0;

      wb.on("worksheet", ws => {
        // Sheet name stored in workbook. Not guaranteed here
        // expect(ws.name).toBe('blort');
        ws.on("row", row => {
          rowCount++;
          try {
            switch (row.number) {
              case 1:
                expect(row.getCell("A").value).toBe(7);
                expect(row.getCell("A").type).to.equal(ValueType.Number);
                expect(row.getCell("B").value).toEqual(streamedValues.B1);
                expect(row.getCell("B").type).to.equal(ValueType.String);
                expect(Math.abs(row.getCell("C").value - streamedValues.C1)).to.be.below(
                  dateAccuracy
                );
                expect(row.getCell("C").type).to.equal(ValueType.Number);

                expect(row.getCell("D").value).toEqual(streamedValues.D1);
                expect(row.getCell("D").type).to.equal(ValueType.Formula);
                expect(row.getCell("E").value).toEqual(streamedValues.E1);
                expect(row.getCell("E").type).to.equal(ValueType.Formula);
                expect(row.getCell("F").value).toEqual(streamedValues.F1);
                expect(row.getCell("F").type).to.equal(ValueType.SharedString);
                expect(row.getCell("G").value).toEqual(streamedValues.G1);
                break;

              case 2:
                // A2:B3
                expect(row.getCell("A").value).toBe(5);
                expect(row.getCell("A").type).to.equal(ValueType.Number);

                expect(row.getCell("B").type).toBe(ValueType.Null);

                // C2:D3
                expect(row.getCell("C").value).toBeNull();
                expect(row.getCell("C").type).toBe(ValueType.Null);

                expect(row.getCell("D").value).toBeNull();
                expect(row.getCell("D").type).toBe(ValueType.Null);

                break;

              case 3:
                expect(row.getCell("A").value).toBe(null);
                expect(row.getCell("A").type).toBe(ValueType.Null);

                expect(row.getCell("B").value).toBe(null);
                expect(row.getCell("B").type).toBe(ValueType.Null);

                expect(row.getCell("C").value).toBeNull();
                expect(row.getCell("C").type).toBe(ValueType.Null);

                expect(row.getCell("D").value).toBeNull();
                expect(row.getCell("D").type).toBe(ValueType.Null);
                break;

              case 4:
                expect(row.getCell("A").type).to.equal(ValueType.Number);
                expect(row.getCell("C").type).to.equal(ValueType.Number);
                break;

              case 5:
                // test fonts and formats
                expect(row.getCell("A").value).toEqual(streamedValues.B1);
                expect(row.getCell("A").type).to.equal(ValueType.String);
                expect(row.getCell("B").value).toEqual(streamedValues.B1);
                expect(row.getCell("B").type).to.equal(ValueType.String);
                expect(row.getCell("C").value).toEqual(streamedValues.B1);
                expect(row.getCell("C").type).to.equal(ValueType.String);

                expect(Math.abs(row.getCell("D").value - 1.6)).to.be.below(0.00000001);
                expect(row.getCell("D").type).to.equal(ValueType.Number);

                expect(Math.abs(row.getCell("E").value - 1.6)).to.be.below(0.00000001);
                expect(row.getCell("E").type).to.equal(ValueType.Number);

                expect(Math.abs(row.getCell("F").value - streamedValues.C1)).to.be.below(
                  dateAccuracy
                );
                expect(row.getCell("F").type).to.equal(ValueType.Number);
                break;

              case 6:
                expect(row.height).toBe(42);
                break;

              case 7:
                break;

              case 8:
                expect(row.height).toBe(40);
                break;

              default:
                break;
            }
          } catch (error) {
            reject(error);
          }
        });
      });
      wb.on("end", () => {
        try {
          expect(rowCount).toBe(11);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      wb.read(filename, { entries: "emit", worksheets: "emit" });
    });
  }
};

export { testWorkbookReader };
