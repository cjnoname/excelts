import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Range, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "conditional-formatting.xlsx");

const wb = Workbook.create();

function addTable(ws, ref) {
  const range = Range.create(ref);
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].forEach((day, index) => {
    Cell.setValue(ws, range.top, range.left + index, day);
  });
  let count = 1;
  for (let i = 1; i <= 6; i++) {
    for (let j = 0; j < 5; j++) {
      Cell.setValue(ws, range.top + i, range.left + j, count++);
    }
  }
}

function addDateTable(ws, ref) {
  const range = Range.create(ref);
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].forEach(
    (day, index) => {
      Cell.setValue(ws, range.top, range.left + index, day);
    }
  );
  const DAY = 86400000;
  const now = Date.now();
  const today = now - (now % DAY);
  let dt = new Date(today);
  const sow = today - (dt.getDay() - 1) * DAY;
  const som = sow - 28 * DAY;
  dt = new Date(som);

  for (let i = 1; i <= 9; i++) {
    for (let j = 0; j < 7; j++) {
      Cell.setValue(ws, range.top + i, range.left + j, dt);
      Cell.setStyle(ws, range.top + i, range.left + j, { numFmt: "DD MMM" });
      dt = new Date(dt.getTime() + DAY);
    }
  }
}

// ============================================================================
// Expression
const expressionWS = Workbook.addWorksheet(wb, "Formula");

addTable(expressionWS, "A1:E7");
Worksheet.addConditionalFormatting(expressionWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "expression",
      priority: 3,
      formulae: ["MOD(ROW()+COLUMN(),2)=0"],
      style: { font: { bold: true } }
    }
  ]
});

// testing priority
Worksheet.addConditionalFormatting(expressionWS, {
  ref: "A2",
  rules: [
    {
      type: "expression",
      priority: 1,
      formulae: ["TRUE"],
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF00FF00" } }
      }
    },
    {
      type: "expression",
      priority: 2,
      formulae: ["TRUE"],
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFF0000" } }
      }
    }
  ]
});

// ============================================================================
// Highlight Cells
const highlightWS = Workbook.addWorksheet(wb, "Highlight");

addTable(highlightWS, "A1:E7");
Worksheet.addConditionalFormatting(highlightWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "cellIs",
      operator: "greaterThan",
      formulae: [13],
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF00FF00" } }
      }
    }
  ]
});

// ============================================================================
// Top 10% (and bottom)
const top10pcWS = Workbook.addWorksheet(wb, "Top 10%");

addTable(top10pcWS, "A1:E7");
Worksheet.addConditionalFormatting(top10pcWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "top10",
      percent: true,
      rank: 10,
      style: { font: { bold: true } }
    },
    {
      type: "top10",
      percent: true,
      bottom: true,
      rank: 10,
      style: { font: { italic: true } }
    }
  ]
});

// top and bottom 8
addTable(top10pcWS, "G1:K7");
Worksheet.addConditionalFormatting(top10pcWS, {
  ref: "G1:K7",
  rules: [
    {
      type: "top10",
      percent: false,
      rank: 8,
      style: { font: { bold: true } }
    },
    {
      type: "top10",
      percent: false,
      bottom: true,
      rank: 8,
      style: { font: { italic: true } }
    }
  ]
});

// above and below average
addTable(top10pcWS, "M1:Q7");
Worksheet.addConditionalFormatting(top10pcWS, {
  ref: "M1:Q7",
  rules: [
    {
      type: "aboveAverage",
      style: { font: { bold: true } }
    },
    {
      type: "aboveAverage",
      aboveAverage: false,
      style: { font: { italic: true } }
    }
  ]
});

// ============================================================================
// Colour Scales
const colourScaleWS = Workbook.addWorksheet(wb, "Colour Scales");

addTable(colourScaleWS, "A1:E7");
Worksheet.addConditionalFormatting(colourScaleWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "colorScale",
      cfvo: [{ type: "min" }, { type: "percentile", value: 50 }, { type: "max" }],
      color: [{ argb: "FFF8696B" }, { argb: "FFFFEB84" }, { argb: "FF63BE7B" }]
    }
  ]
});

// top and bottom 8
addTable(colourScaleWS, "G1:K7");
Worksheet.addConditionalFormatting(colourScaleWS, {
  ref: "G1:K7",
  rules: [
    {
      type: "colorScale",
      cfvo: [{ type: "min" }, { type: "max" }],
      color: [{ argb: "FFF8696B" }, { argb: "FFFCFCFF" }]
    }
  ]
});

// ============================================================================
// Arrows
const arrowsWS = Workbook.addWorksheet(wb, "Arrows");

addTable(arrowsWS, "A1:E7");
Worksheet.addConditionalFormatting(arrowsWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "iconSet",
      iconSet: "3Arrows",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 33 },
        { type: "percent", value: 66 }
      ]
    }
  ]
});

addTable(arrowsWS, "G1:K7");
Worksheet.addConditionalFormatting(arrowsWS, {
  ref: "G1:K7",
  rules: [
    {
      type: "iconSet",
      iconSet: "4Arrows",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 25 },
        { type: "percent", value: 50 },
        { type: "percent", value: 75 }
      ]
    }
  ]
});

addTable(arrowsWS, "M1:Q7");
Worksheet.addConditionalFormatting(arrowsWS, {
  ref: "M1:Q7",
  rules: [
    {
      type: "iconSet",
      iconSet: "5Arrows",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 20 },
        { type: "percent", value: 40 },
        { type: "percent", value: 60 },
        { type: "percent", value: 80 }
      ]
    }
  ]
});

addTable(arrowsWS, "A9:E15");
Worksheet.addConditionalFormatting(arrowsWS, {
  ref: "A9:E15",
  rules: [
    {
      type: "iconSet",
      iconSet: "4ArrowsGray",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 25 },
        { type: "percent", value: 50 },
        { type: "percent", value: 75 }
      ]
    }
  ]
});

addTable(arrowsWS, "G9:K15");
Worksheet.addConditionalFormatting(arrowsWS, {
  ref: "G9:K15",
  rules: [
    {
      type: "iconSet",
      iconSet: "3TrafficLights1",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "num", value: "COLUMN()" },
        { type: "num", value: "ROW()" }
      ]
    }
  ]
});

// ============================================================================
// Shapes
const shapesWS = Workbook.addWorksheet(wb, "Shapes");

addTable(shapesWS, "A1:E7");
Worksheet.addConditionalFormatting(shapesWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "iconSet",
      iconSet: "3TrafficLights1",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 33 },
        { type: "percent", value: 67 }
      ]
    }
  ]
});

addTable(shapesWS, "G1:K6");
Worksheet.addConditionalFormatting(shapesWS, {
  ref: "G1:K6",
  rules: [
    {
      type: "iconSet",
      iconSet: "5Quarters",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 20 },
        { type: "percent", value: 40 },
        { type: "percent", value: 60 },
        { type: "percent", value: 80 }
      ]
    }
  ]
});

addTable(shapesWS, "M1:Q7");
Worksheet.addConditionalFormatting(shapesWS, {
  ref: "M1:Q7",
  rules: [
    {
      type: "iconSet",
      iconSet: "3TrafficLights1",
      showValue: false,
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 33 },
        { type: "percent", value: 67 }
      ]
    }
  ]
});

addTable(shapesWS, "A9:E15");
Worksheet.addConditionalFormatting(shapesWS, {
  ref: "A9:E15",
  rules: [
    {
      type: "iconSet",
      iconSet: "3TrafficLights1",
      reverse: true,
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 33 },
        { type: "percent", value: 67 }
      ]
    }
  ]
});

// ============================================================================
// Shapes
const extSshapesWS = Workbook.addWorksheet(wb, "Ext Shapes");

addTable(extSshapesWS, "A1:E7");
Worksheet.addConditionalFormatting(extSshapesWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "iconSet",
      iconSet: "3Stars",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 33 },
        { type: "percent", value: 67 }
      ]
    }
  ]
});

addTable(extSshapesWS, "G1:K7");
Worksheet.addConditionalFormatting(extSshapesWS, {
  ref: "G1:K7",
  rules: [
    {
      type: "iconSet",
      iconSet: "3Triangles",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 33 },
        { type: "percent", value: 67 }
      ]
    }
  ]
});

addTable(extSshapesWS, "M1:Q7");
Worksheet.addConditionalFormatting(extSshapesWS, {
  ref: "M1:Q7",
  rules: [
    {
      type: "iconSet",
      iconSet: "5Boxes",
      cfvo: [
        { type: "percent", value: 0 },
        { type: "percent", value: 20 },
        { type: "percent", value: 40 },
        { type: "percent", value: 60 },
        { type: "percent", value: 80 }
      ]
    }
  ]
});

// ============================================================================
// Databar
const databarWS = Workbook.addWorksheet(wb, "Databar");

addTable(databarWS, "A1:E7");
Worksheet.addConditionalFormatting(databarWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "dataBar",
      color: { argb: "FFFF0000" },
      gradient: true,
      cfvo: [
        { type: "num", value: 5 },
        { type: "num", value: 20 }
      ]
    }
  ]
});

addTable(databarWS, "G1:K7");
Worksheet.addConditionalFormatting(databarWS, {
  ref: "G1:K7",
  rules: [
    {
      type: "dataBar",
      color: { argb: "FF00FF00" },
      gradient: false,
      cfvo: [
        { type: "num", value: 5 },
        { type: "num", value: 20 }
      ]
    }
  ]
});

// ============================================================================
// Cell Is
const cellIsWS = Workbook.addWorksheet(wb, "Cell Is");

addTable(cellIsWS, "A1:E7");
Worksheet.addConditionalFormatting(cellIsWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "cellIs",
      operator: "equal",
      formulae: [13],
      style: { font: { bold: true } }
    },
    {
      type: "cellIs",
      operator: "greaterThan",
      formulae: [22],
      style: { font: { italic: true } }
    },
    {
      type: "cellIs",
      operator: "lessThan",
      formulae: [4],
      style: { font: { underline: true } }
    },
    {
      type: "cellIs",
      operator: "between",
      formulae: [16, 20],
      style: { font: { strike: true } }
    }
  ]
});

// ============================================================================
// Contains
const containsWS = Workbook.addWorksheet(wb, "Contains");

addTable(containsWS, "A1:E7");
Worksheet.addConditionalFormatting(containsWS, {
  ref: "A1:E7",
  rules: [
    {
      type: "containsText",
      operator: "containsText",
      text: "sday",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF00FF00" } }
      }
    }
  ]
});

addTable(containsWS, "G1:K7");
Worksheet.addConditionalFormatting(containsWS, {
  ref: "G1:K7",
  rules: [
    {
      type: "containsText",
      operator: "containsBlanks",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFF0000" } }
      }
    }
  ]
});

addTable(containsWS, "M1:Q7");
Worksheet.addConditionalFormatting(containsWS, {
  ref: "M1:Q7",
  rules: [
    {
      type: "containsText",
      operator: "notContainsBlanks",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF0000FF" } }
      }
    }
  ]
});

addTable(containsWS, "A9:E15");
Worksheet.addConditionalFormatting(containsWS, {
  ref: "A9:E15",
  rules: [
    {
      type: "containsText",
      operator: "containsErrors",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF00FF00" } }
      }
    }
  ]
});

addTable(containsWS, "G9:K15");
Worksheet.addConditionalFormatting(containsWS, {
  ref: "G9:K15",
  rules: [
    {
      type: "containsText",
      operator: "notContainsErrors",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFF0000" } }
      }
    }
  ]
});

// ============================================================================
// Dates
const dateWS = Workbook.addWorksheet(wb, "Dates");

addDateTable(dateWS, "A1:G10");
Worksheet.addConditionalFormatting(dateWS, {
  ref: "A1:G10",
  rules: [
    {
      type: "timePeriod",
      timePeriod: "lastWeek",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFF0000" } }
      }
    },
    {
      type: "timePeriod",
      timePeriod: "thisWeek",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF00FF00" } }
      }
    },
    {
      type: "timePeriod",
      timePeriod: "nextWeek",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF0000FF" } }
      }
    },
    {
      type: "timePeriod",
      timePeriod: "yesterday",
      style: { font: { italic: true } }
    },
    {
      type: "timePeriod",
      timePeriod: "today",
      style: { font: { bold: true } }
    },
    {
      type: "timePeriod",
      timePeriod: "tomorrow",
      style: { font: { underline: true } }
    },
    {
      type: "timePeriod",
      timePeriod: "last7Days",
      style: { font: { strike: true } }
    },
    {
      type: "timePeriod",
      timePeriod: "lastMonth",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFFF00" } }
      }
    },
    {
      type: "timePeriod",
      timePeriod: "thisMonth",
      style: {
        font: {
          name: "Comic Sans MS",
          family: 4,
          size: 16,
          underline: "double",
          bold: true
        }
      }
    },
    {
      type: "timePeriod",
      timePeriod: "nextMonth",
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF00FFFF" } }
      }
    }
  ]
});

// ============================================================================
// Save

const stopwatch = new HrStopwatch();
stopwatch.start();
try {
  await writeBothFormats(wb, filename);
  const micros = stopwatch.microseconds;
  console.log("Done.");
  console.log("Time taken:", micros);
} catch (error) {
  console.log(error.message);
}
