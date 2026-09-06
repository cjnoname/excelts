import { writeFile } from "node:fs/promises";

/**
 * Regenerate `examples/data/themed.xlsb`, the fixture `xlsb-fidelity` reads.
 *
 * Run: `pnpm generate:themed-xlsb`
 *
 * **Why the fixture is generated rather than copied.** The example it feeds has to prove that parts
 * this library does not model survive a read-modify-write, and proving that needs an *input* that
 * carries such parts. Reading a workbook this library wrote would prove nothing — it contains only
 * parts it models — and the reference corpus that does carry them is not redistributable.
 *
 * **Why the generator lives here rather than in a scratch directory.** The first version of this
 * fixture was built by a throwaway script, which made it a binary blob nobody could rebuild — and
 * it was wrong twice over in ways that only surfaced when Excel refused to open the example's
 * output: its theme had only a `clrScheme` where a valid theme needs all three schemes, and its row
 * headers were the twelve-byte shape this library used to write instead of the twenty-five bytes
 * Excel writes. A fixture that cannot be regenerated cannot be corrected either.
 *
 * The workbook is therefore assembled from the same helpers the writer uses, so a change to what
 * Excel's own records look like reaches this fixture too rather than leaving it frozen at whatever
 * was believed on the day it was made.
 */
import { ZipArchive } from "@archive/zip";
import {
  bookView,
  calculationProperties,
  fileVersion,
  printOptions,
  selection,
  sheetProtection,
  workbookProperties,
  worksheetView
} from "@excel/xlsb/defaults";
import { MANDATORY_FILL_PATTERNS, mandatoryFill } from "@excel/xlsb/fill";
import { defaultFont } from "@excel/xlsb/font";
import { encodeMargins, encodePageSetup, encodeSheetFormatInfo } from "@excel/xlsb/page-setup";
import { encodeSheetProperties } from "@excel/xlsb/sheet-properties";
import { biff, rowHeader } from "@test/biff-fixture";

// A binary workbook carrying parts this library does not model: a theme and an image, each
// reachable through a relationship. Written by hand rather than by Excel because the corpus is
// not redistributable — the shape is what matters, and it is the shape Excel produces.
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ExampleTheme"><a:themeElements><a:clrScheme name="Example"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Example"><a:majorFont><a:latin typeface="Calibri Light" panose="020F0302020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Example"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
// A 1x1 red PNG.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82
]);
const a = new ZipArchive();
a.add(
  "[Content_Types].xml",
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>' +
    '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
    '<Override PartName="/xl/styles.bin" ContentType="application/vnd.ms-excel.styles"/>' +
    '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    "</Types>"
);
a.add(
  "_rels/.rels",
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.bin"/>' +
    "</Relationships>"
);
a.add(
  "xl/_rels/workbook.bin.rels",
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.bin"/>' +
    "</Relationships>"
);
a.add(
  "xl/workbook.bin",
  biff([
    ["BrtBeginBook"],
    ["BrtFileVersion", fileVersion()],
    ["BrtWbProp", workbookProperties(false)],
    ["BrtBeginBookViews"],
    ["BrtBookView", bookView()],
    ["BrtEndBookViews"],
    ["BrtBeginBundleShs"],
    ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "Report" }],
    ["BrtEndBundleShs"],
    ["BrtCalcProp", calculationProperties()],
    ["BrtEndBook"]
  ])
);
a.add(
  "xl/worksheets/sheet1.bin",
  biff([
    ["BrtBeginSheet"],
    ["BrtWsProp", encodeSheetProperties(undefined)],
    ["BrtWsDim", { ref: { firstRow: 0, lastRow: 1, firstColumn: 0, lastColumn: 0 } }],
    ["BrtBeginWsViews"],
    ["BrtBeginWsView", worksheetView()],
    ["BrtSel", selection()],
    ["BrtEndWsView"],
    ["BrtEndWsViews"],
    ["BrtWsFmtInfo", encodeSheetFormatInfo(undefined)],
    ["BrtBeginSheetData"],
    ["BrtRowHdr", rowHeader({ row: 0 })],
    ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (1250 << 2) | 0x02 }],
    ["BrtRowHdr", rowHeader({ row: 1 })],
    ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (2500 << 2) | 0x02 }],
    ["BrtEndSheetData"],
    ["BrtSheetProtection", sheetProtection()],
    ["BrtPrintOptions", printOptions()],
    ["BrtMargins", encodeMargins(undefined)],
    ["BrtPageSetup", encodePageSetup(undefined)],
    ["BrtEndSheet"]
  ])
);
a.add(
  "xl/styles.bin",
  biff([
    ["BrtBeginStyleSheet"],
    ["BrtBeginFonts", new Uint8Array([1, 0, 0, 0])],
    ["BrtFont", defaultFont()],
    ["BrtEndFonts"],
    ["BrtBeginFills", new Uint8Array([2, 0, 0, 0])],
    ["BrtFill", mandatoryFill(MANDATORY_FILL_PATTERNS[0])],
    ["BrtFill", mandatoryFill(MANDATORY_FILL_PATTERNS[1])],
    ["BrtEndFills"],
    ["BrtBeginBorders", new Uint8Array([1, 0, 0, 0])],
    ["BrtBorder", new Uint8Array(51)],
    ["BrtEndBorders"],
    ["BrtBeginCellStyleXFs", new Uint8Array([1, 0, 0, 0])],
    ["BrtXF", new Uint8Array(16)],
    ["BrtEndCellStyleXFs"],
    ["BrtBeginCellXFs", new Uint8Array([1, 0, 0, 0])],
    ["BrtXF", new Uint8Array(16)],
    ["BrtEndCellXFs"],
    ["BrtEndStyleSheet"]
  ])
);
a.add("xl/theme/theme1.xml", new TextEncoder().encode(THEME));
// Reached through the worksheet, the way a real file reaches a drawing — which is also what
// exercises worksheet-level relationship preservation.
a.add(
  "xl/worksheets/_rels/sheet1.bin.rels",
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/>' +
    "</Relationships>"
);
a.add("xl/media/logo.png", PNG);
await writeFile("src/modules/excel/examples/data/themed.xlsb", await a.bytes());
console.log("wrote src/modules/excel/examples/data/themed.xlsb");
