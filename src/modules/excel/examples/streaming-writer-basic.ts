import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Stream } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "streaming-writer-basic.xlsx");

const wb = new Stream.WorkbookWriter({
  filename,
  useSharedStrings: false,
  useStyles: false
});
const ws = wb.addWorksheet("blort");

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
    underline: "double" as const,
    bold: true
  }
};

const alignments = [
  { text: "Top Left", alignment: { horizontal: "left" as const, vertical: "top" as const } },
  {
    text: "Middle Centre",
    alignment: { horizontal: "center" as const, vertical: "middle" as const }
  },
  {
    text: "Bottom Right",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const }
  },
  { text: "Wrap Text", alignment: { wrapText: true } },
  { text: "Indent 1", alignment: { indent: 1 } },
  { text: "Indent 2", alignment: { indent: 2 } },
  {
    text: "Rotate 15",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: 15 }
  },
  {
    text: "Rotate 30",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: 30 }
  },
  {
    text: "Rotate 45",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: 45 }
  },
  {
    text: "Rotate 60",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: 60 }
  },
  {
    text: "Rotate 75",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: 75 }
  },
  {
    text: "Rotate 90",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: 90 }
  },
  {
    text: "Rotate -15",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: -55 }
  },
  {
    text: "Rotate -30",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: -30 }
  },
  {
    text: "Rotate -45",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: -45 }
  },
  {
    text: "Rotate -60",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: -60 }
  },
  {
    text: "Rotate -75",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: -75 }
  },
  {
    text: "Rotate -90",
    alignment: { horizontal: "right" as const, vertical: "bottom" as const, textRotation: -90 }
  },
  {
    text: "Vertical Text",
    alignment: {
      horizontal: "right" as const,
      vertical: "bottom" as const,
      textRotation: "vertical" as const
    }
  }
];
// const badAlignments = [
//   { text: 'Rotate -91', alignment: { textRotation: -91 } },
//   { text: 'Rotate 91', alignment: { textRotation: 91 } },
//   { text: 'Indent -1', alignment: { indent: -1 } },
//   { text: 'Blank', alignment: {} },
// ];

const borders = {
  thin: {
    top: { style: "thin" as const },
    left: { style: "thin" as const },
    bottom: { style: "thin" as const },
    right: { style: "thin" as const }
  },
  doubleRed: {
    color: { argb: "FFFF0000" },
    top: { style: "double" as const },
    left: { style: "double" as const },
    bottom: { style: "double" as const },
    right: { style: "double" as const }
  },
  thickRainbow: {
    top: { style: "double" as const, color: { argb: "FFFF00FF" } },
    left: { style: "double" as const, color: { argb: "FF00FFFF" } },
    bottom: { style: "double" as const, color: { argb: "FF00FF00" } },
    right: { style: "double" as const, color: { argb: "FF00FF" } },
    diagonal: {
      style: "double" as const,
      color: { argb: "FFFFFF00" },
      up: true,
      down: true
    }
  }
};

const fills = {
  redDarkVertical: {
    type: "pattern" as const,
    pattern: "darkVertical" as const,
    fgColor: { argb: "FFFF0000" }
  },
  redGreenDarkTrellis: {
    type: "pattern" as const,
    pattern: "darkTrellis" as const,
    fgColor: { argb: "FFFF0000" },
    bgColor: { argb: "FF00FF00" }
  },
  blueWhiteHGrad: {
    type: "gradient" as const,
    gradient: "angle" as const,
    degree: 0,
    stops: [
      { position: 0, color: { argb: "FF0000FF" } },
      { position: 1, color: { argb: "FFFFFFFF" } }
    ]
  },
  rgbPathGrad: {
    type: "gradient" as const,
    gradient: "path" as const,
    center: { left: 0.5, top: 0.5 },
    stops: [
      { position: 0, color: { argb: "FFFF0000" } },
      { position: 0.5, color: { argb: "FF00FF00" } },
      { position: 1, color: { argb: "FF0000FF" } }
    ]
  }
};

ws.columns = [
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
  }
];

Stream.setCellValue(ws.getCell("A2"), 7);
Stream.setCellValue(ws.getCell("B2"), "Hello, World!");
Stream.setCellFont(ws.getCell("B2"), fonts.comicSansUdB16);
Stream.setCellBorder(ws.getCell("B2"), borders.thin);

Stream.setCellValue(ws.getCell("C2"), -5.55);
Stream.setCellNumFmt(ws.getCell("C2"), "'£'#,##0.00;[Red]-'£'#,##0.00");
Stream.setCellFont(ws.getCell("C2"), fonts.arialBlackUI14);

Stream.setCellValue(ws.getCell("D2"), 3.14);
Stream.setCellValue(ws.getCell("D2"), new Date());
Stream.setCellNumFmt(ws.getCell("D2"), "d-mmm-yyyy");
Stream.setCellFont(ws.getCell("D2"), fonts.comicSansUdB16);
Stream.setCellBorder(ws.getCell("D2"), borders.doubleRed);

Stream.setCellValue(ws.getCell("E2"), `${["Hello", "World"].join(", ")}!`);
Stream.commitRow(ws.getRow(2));

Stream.setCellValue(ws.getCell("A3"), {
  text: "www.google.com",
  hyperlink: "http://www.google.com"
});
Stream.setCellValue(ws.getCell("A4"), "Boo!");
Stream.setCellValue(ws.getCell("C4"), "Hoo!");
ws.mergeCells("A4", "C4");
Stream.commitRow(ws.getRow(4));

Stream.setCellValue(ws.getCell("A5"), 1);
Stream.setCellValue(ws.getCell("B5"), 2);
Stream.setCellValue(ws.getCell("C5"), { formula: "A5+B5", result: 3 });
Stream.commitRow(ws.getRow(5));

Stream.setCellValue(ws.getCell("A6"), "Hello");
Stream.setCellValue(ws.getCell("B6"), "World");
Stream.setCellValue(ws.getCell("C6"), {
  formula: 'CONCATENATE(A6,", ",B6,"!")',
  result: "Hello, World!"
});
Stream.setCellBorder(ws.getCell("C6"), borders.thickRainbow);
Stream.commitRow(ws.getRow(6));

Stream.setCellValue(ws.getCell("A7"), 1);
Stream.setCellValue(ws.getCell("B7"), 2);
Stream.setCellValue(ws.getCell("C7"), { formula: "A7+B7" });
Stream.commitRow(ws.getRow(7));

const now = new Date();
Stream.setCellValue(ws.getCell("A8"), now);
Stream.setCellValue(ws.getCell("B8"), 0);
Stream.setCellValue(ws.getCell("C8"), { formula: "A8+B8", result: now });
Stream.commitRow(ws.getRow(8));

Stream.setCellValue(ws.getCell("A9"), 1.6);
Stream.setCellNumFmt(ws.getCell("A9"), "# ?/?");
Stream.setCellValue(ws.getCell("B9"), 1.6);
Stream.setCellNumFmt(ws.getCell("B9"), "h:mm:ss");
Stream.setCellValue(ws.getCell("C9"), 0.016);
Stream.setCellNumFmt(ws.getCell("C9"), "0.00%");
Stream.setCellValue(ws.getCell("D9"), 1.6);
Stream.setCellNumFmt(ws.getCell("D9"), "[Green]#,##0 ;[Red](#,##0)");
Stream.setCellValue(ws.getCell("E9"), 1.6);
Stream.setCellNumFmt(ws.getCell("E9"), "#0.000");
Stream.setCellValue(ws.getCell("F9"), 0.016);
Stream.setCellNumFmt(ws.getCell("F9"), "# ?/?%");
Stream.commitRow(ws.getRow(9));

Stream.setCellValue(ws.getCell("A10"), "<");
Stream.setCellValue(ws.getCell("B10"), ">");
Stream.setCellValue(ws.getCell("C10"), "<a>");
Stream.setCellValue(ws.getCell("D10"), "><");
Stream.commitRow(ws.getRow(10));

ws.getRow(11).height = 40;
alignments.forEach((alignment, index) => {
  const rowNumber = 11;
  const colNumber = index + 1;
  const cell = ws.getCell(rowNumber, colNumber);
  Stream.setCellValue(cell, alignment.text);
  Stream.setCellAlignment(cell, alignment.alignment);
});
Stream.commitRow(ws.getRow(11));

const row12 = ws.getRow(12);
row12.height = 40;
Stream.setCellValue(Stream.rowCell(row12, 1), "Blue White Horizontal Gradient");
Stream.setCellFill(Stream.rowCell(row12, 1), fills.blueWhiteHGrad);
Stream.setCellValue(Stream.rowCell(row12, 2), "Red Dark Vertical");
Stream.setCellFill(Stream.rowCell(row12, 2), fills.redDarkVertical);
Stream.setCellValue(Stream.rowCell(row12, 3), "Red Green Dark Trellis");
Stream.setCellFill(Stream.rowCell(row12, 3), fills.redGreenDarkTrellis);
Stream.setCellValue(Stream.rowCell(row12, 4), "RGB Path Gradient");
Stream.setCellFill(Stream.rowCell(row12, 4), fills.rgbPathGrad);

// row and column styles
Stream.setRowFont(ws.getRow(13), fonts.arialBlackUI14);
Stream.setCellValue(ws.getCell("H12"), "Foo");
Stream.setCellValue(ws.getCell("G13"), "Foo");
Stream.setCellValue(ws.getCell("H13"), "Bar");
Stream.setCellValue(ws.getCell("I13"), "Baz");
Stream.setCellValue(ws.getCell("H14"), "Baz");
// Row.commit(ws.getRow(13));

wb.commit()
  .then(() => {
    console.log("Done.");
  })
  .catch(error => {
    console.log(error.message);
  });
