import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Row, Workbook, Worksheet } from "@excel/index";
import type { Fill } from "@excel/types";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "workbook-styles.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "blort");

const fonts = {
  arialBlackUI14: {
    name: "Arial Black",
    family: 2,
    size: 14,
    underline: true,
    italic: true
  },
  comicSansUdB16: {
    name: "Comic Sans MS",
    family: 4,
    size: 16,
    underline: "double",
    bold: true
  },
  whiteText: {
    name: "Arial Black",
    family: 2,
    size: 14,
    color: { argb: "FFFFFFFF" }
  }
} as const;

const alignments = [
  { text: "Top Left", alignment: { horizontal: "left", vertical: "top" } },
  {
    text: "Middle Centre",
    alignment: { horizontal: "center", vertical: "middle" }
  },
  {
    text: "Bottom Right",
    alignment: { horizontal: "right", vertical: "bottom" }
  },
  {
    text: "Wrap Text - Wrapping Wrapping Wrappity Wrap Wrap Wrap",
    alignment: { wrapText: true }
  },
  { text: "Indent 1", alignment: { indent: 1 } },
  { text: "Indent 2", alignment: { indent: 2 } },
  {
    text: "Rotate 15",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: 15 }
  },
  {
    text: "Rotate 30",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: 30 }
  },
  {
    text: "Rotate 45",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: 45 }
  },
  {
    text: "Rotate 60",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: 60 }
  },
  {
    text: "Rotate 75",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: 75 }
  },
  {
    text: "Rotate 90",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: 90 }
  },
  {
    text: "Rotate -15",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: -55 }
  },
  {
    text: "Rotate -30",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: -30 }
  },
  {
    text: "Rotate -45",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: -45 }
  },
  {
    text: "Rotate -60",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: -60 }
  },
  {
    text: "Rotate -75",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: -75 }
  },
  {
    text: "Rotate -90",
    alignment: { horizontal: "right", vertical: "bottom", textRotation: -90 }
  },
  {
    text: "Vertical Text",
    alignment: {
      horizontal: "right",
      vertical: "bottom",
      textRotation: "vertical"
    }
  }
] as const;
// const badAlignments = [
//  { text: 'Rotate -91', alignment: { textRotation: -91 } },
//  { text: 'Rotate 91', alignment: { textRotation: 91 } },
//  { text: 'Indent -1', alignment: { indent: -1 } },
//  { text: 'Blank', alignment: {  } }
// ];

const borders = {
  thin: {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" }
  },
  doubleRed: {
    color: { argb: "FFFF0000" },
    top: { style: "double" },
    left: { style: "double" },
    bottom: { style: "double" },
    right: { style: "double" }
  },
  thickRainbow: {
    top: { style: "double", color: { argb: "FFFF00FF" } },
    left: { style: "double", color: { argb: "FF00FFFF" } },
    bottom: { style: "double", color: { argb: "FF00FF00" } },
    right: { style: "double", color: { argb: "FFFF00FF" } },
    diagonal: {
      style: "double",
      color: { argb: "FFFFFF00" },
      up: true,
      down: true
    }
  },
  thinWhite: {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
    color: { argb: "FFFFFFFF" }
  }
} as const;

const fills = {
  solidGreen: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF00FF00" }
  },
  redDarkVertical: {
    type: "pattern",
    pattern: "darkVertical",
    fgColor: { argb: "FFFF0000" }
  },
  redGreenDarkTrellis: {
    type: "pattern",
    pattern: "darkTrellis",
    fgColor: { argb: "FFFF0000" },
    bgColor: { argb: "FF00FF00" }
  },
  blueWhiteHGrad: {
    type: "gradient",
    gradient: "angle",
    degree: 0,
    stops: [
      { position: 0, color: { argb: "FF0000FF" } },
      { position: 1, color: { argb: "FFFFFFFF" } }
    ]
  },
  rgbPathGrad: {
    type: "gradient",
    gradient: "path",
    center: { left: 0.5, top: 0.5 },
    stops: [
      { position: 0, color: { argb: "FFFF0000" } },
      { position: 0.5, color: { argb: "FF00FF00" } },
      { position: 1, color: { argb: "FF0000FF" } }
    ]
  }
} satisfies Record<string, Fill>;

Worksheet.setColumns(ws, [
  { header: "Col 1", key: "key", width: 25 },
  { header: "Col 2", key: "name", width: 32 },
  { header: "Col 3", key: "age", width: 21 },
  { header: "Col 4", key: "addr1", width: 18 },
  { header: "Col 5", key: "addr2", width: 8 },
  { header: "Col 6", width: 8 },
  { header: "Col 7", width: 8 },
  {
    header: "Col 8",
    width: 8,
    style: { font: fonts.comicSansUdB16, alignment: alignments[1].alignment }
  },
  { header: "Col 9", width: 8, hidden: true }
]);

Cell.setValue(ws, "A2", 7);
Cell.setValue(ws, "B2", "Hello, World!");
Cell.setStyle(ws, "B2", { font: fonts.comicSansUdB16 });
Cell.setStyle(ws, "B2", { border: borders.thin });

Cell.setValue(ws, "C2", -5.55);
Cell.setStyle(ws, "C2", { numFmt: "'£'#,##0.00;[Red]-'£'#,##0.00" });
Cell.setStyle(ws, "C2", { font: fonts.arialBlackUI14 });

Cell.setValue(ws, "D2", 3.14);
Cell.setValue(ws, "D2", new Date());
Cell.setStyle(ws, "D2", { numFmt: "d-mmm-yyyy" });
Cell.setStyle(ws, "D2", { font: fonts.comicSansUdB16 });
Cell.setStyle(ws, "D2", { border: borders.doubleRed });

Cell.setValue(ws, "E2", ["Hello", "World"].join(", ") + "!");

Cell.setValue(ws, "F2", true);
Cell.setValue(ws, "G2", { error: "#N/A" });
Cell.setValue(ws, "H2", { error: "#VALUE!" });

Cell.setValue(ws, "A3", {
  text: "www.google.com",
  hyperlink: "http://www.google.com",
  tooltip: "Google!"
});
Cell.setValue(ws, "A4", "Boo!");
Cell.setValue(ws, "C4", "Hoo!");
Worksheet.merge(ws, "A4", "C4");

Cell.setValue(ws, "A5", 1);
Cell.setValue(ws, "B5", 2);
Cell.setValue(ws, "C5", { formula: "A5+B5", result: 3 });

Cell.setValue(ws, "A6", "Hello");
Cell.setValue(ws, "B6", "World");
Cell.setValue(ws, "C6", {
  formula: 'CONCATENATE(A6,", ",B6,"!")',
  result: "Hello, World!"
});
Cell.setStyle(ws, "C6", { border: borders.thickRainbow });

Cell.setValue(ws, "A7", 1);
Cell.setValue(ws, "B7", 2);
Cell.setValue(ws, "C7", { formula: "A7+B7" });

const now = new Date();
Cell.setValue(ws, "A8", now);
Cell.setValue(ws, "B8", 0);
Cell.setValue(ws, "C8", { formula: "A8+B8", result: now });

Cell.setValue(ws, "A9", 1.6);
Cell.setStyle(ws, "A9", { numFmt: "# ?/?" });
Cell.setValue(ws, "B9", 1.6);
Cell.setStyle(ws, "B9", { numFmt: "h:mm:ss" });
Cell.setValue(ws, "C9", 0.016);
Cell.setStyle(ws, "C9", { numFmt: "0.00%" });
Cell.setValue(ws, "D9", 1.6);
Cell.setStyle(ws, "D9", { numFmt: "[Green]#,##0 ;[Red](#,##0)" });
Cell.setValue(ws, "E9", 1.6);
Cell.setStyle(ws, "E9", { numFmt: "#0.000" });
Cell.setValue(ws, "F9", 0.016);
Cell.setStyle(ws, "F9", { numFmt: "# ?/?%" });

Cell.setValue(ws, "A10", "<");
Cell.setValue(ws, "B10", ">");
Cell.setValue(ws, "C10", "<a>");
Cell.setValue(ws, "D10", "><");

Row.setHeight(ws, 11, 40);
alignments.forEach((alignment, index) => {
  const rowNumber = 11;
  const colNumber = index + 1;
  Cell.setValue(ws, rowNumber, colNumber, alignment.text);
  Cell.setStyle(ws, rowNumber, colNumber, { alignment: alignment.alignment });
});

Row.setHeight(ws, 12, 40);
Cell.setValue(ws, "A12", "Blue White Horizontal Gradient");
Cell.setFill(ws, "A12", fills.blueWhiteHGrad);
Cell.setValue(ws, "B12", "Red Dark Vertical");
Cell.setFill(ws, "B12", fills.redDarkVertical);
Cell.setValue(ws, "C12", "Red Green Dark Trellis");
Cell.setFill(ws, "C12", fills.redGreenDarkTrellis);
Cell.setValue(ws, "D12", "RGB Path Gradient");
Cell.setFill(ws, "D12", fills.rgbPathGrad);
Cell.setValue(ws, "E12", "Solid Green");
Cell.setFill(ws, "E12", fills.solidGreen);

// testing background and color trickery
Cell.setValue(ws, "F5", "white");
Cell.setStyle(ws, "F5", { fill: fills.solidGreen });
Cell.setStyle(ws, "F5", { border: borders.thinWhite });
Cell.setStyle(ws, "F5", { font: fonts.whiteText });
Cell.setStyle(ws, "E4", { fill: fills.solidGreen });
Cell.setStyle(ws, "E5", { fill: fills.solidGreen });
Cell.setStyle(ws, "E6", { fill: fills.solidGreen });
Cell.setStyle(ws, "F4", { fill: fills.solidGreen });
Cell.setStyle(ws, "F6", { fill: fills.solidGreen });
Cell.setStyle(ws, "G4", { fill: fills.solidGreen });
Cell.setStyle(ws, "G5", { fill: fills.solidGreen });
Cell.setStyle(ws, "G6", { fill: fills.solidGreen });

// row and column styles
Row.setFont(ws, 13, fonts.arialBlackUI14);
Cell.setValue(ws, "H12", "Foo");
Cell.setValue(ws, "G13", "Foo");
Cell.setValue(ws, "H13", "Bar");
Cell.setValue(ws, "I13", "Baz");
Cell.setValue(ws, "H14", "Baz");

// hidden stuff
Row.setHidden(ws, 16, true);
Cell.setValue(ws, "I15", "You Can't See Me!");
Cell.setValue(ws, "A16", "You Can't See Me!");

Cell.setValue(ws, "A18", "Wrap Text - Wrapping Wrapping Wrappity Wrap Wrap Wrap");
Cell.setAlignment(ws, "A18", { wrapText: true });

Cell.setValue(ws, "A20", "Wrap Text - Wrapping Wrappity Wrap");
Cell.setAlignment(ws, "A20", { shrinkToFit: true });

Cell.setName(ws, "A2", "Passe");
Cell.setName(ws, "B2", "Passe");

Cell.setName(ws, "E2", "Greet");
Cell.setValue(ws, "A22", { formula: "E2" });

Cell.setValue(ws, "A24", "Choose");
Cell.setValue(ws, "D24", "Hewie");
Cell.setName(ws, "D24", "Nephews");
Cell.setValue(ws, "E24", "Dewie");
Cell.setName(ws, "E24", "Nephews");
Cell.setValue(ws, "F24", "Louie");
Cell.setName(ws, "F24", "Nephews");
Cell.setValidation(ws, "B24", {
  type: "list",
  allowBlank: true,
  formulae: ["Nephews"]
});

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
