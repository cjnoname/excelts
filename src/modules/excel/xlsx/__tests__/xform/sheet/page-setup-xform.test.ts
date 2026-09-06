import { testXformHelper } from "@excel/xlsx/__tests__/xform/test-xform-helper";
import { PageSetupXform } from "@excel/xlsx/xform/sheet/page-setup-xform";
import { describe } from "vitest";

const expectations = [
  {
    title: "normal",
    create: () => new PageSetupXform(),
    preparedModel: {
      paperSize: 9,
      orientation: "portrait",
      // 4294967295 is a sentinel value used when parsing missing DPI attributes;
      // it should NOT be emitted back to XML.
      horizontalDpi: 4294967295,
      verticalDpi: 4294967295
    },
    // Note: DPI 4294967295 sentinel values are filtered out during render.
    xml: '<pageSetup paperSize="9" orientation="portrait"/>',
    parsedModel: {
      paperSize: 9,
      orientation: "portrait",
      // Absent in the XML, absent in the model. This asserted 4294967295 before, which pinned a sentinel that
      // only the XLSX writer knew to strip — the XLSB writer wrote it into `BrtPageSetup` verbatim.
      horizontalDpi: undefined,
      verticalDpi: undefined,
      useFirstPageNumber: false,
      usePrinterDefaults: false,
      copies: 1,
      blackAndWhite: false,
      cellComments: "None",
      draft: false,
      errors: "displayed",
      fitToHeight: 1,
      fitToWidth: 1,
      pageOrder: "downThenOver",
      scale: 100
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "options",
    create: () => new PageSetupXform(),
    preparedModel: {
      paperSize: 119,
      pageOrder: "overThenDown",
      orientation: "portrait",
      blackAndWhite: true,
      draft: true,
      cellComments: "atEnd",
      errors: "dash"
    },
    xml: '<pageSetup paperSize="119" pageOrder="overThenDown" orientation="portrait" blackAndWhite="1" draft="1" cellComments="atEnd" errors="dash"/>',
    parsedModel: {
      paperSize: 119,
      pageOrder: "overThenDown",
      orientation: "portrait",
      blackAndWhite: true,
      draft: true,
      cellComments: "atEnd",
      errors: "dash",
      useFirstPageNumber: false,
      usePrinterDefaults: false,
      copies: 1,
      // Absent in the XML, absent in the model. This asserted 4294967295 before, which pinned a sentinel that
      // only the XLSX writer knew to strip — the XLSB writer wrote it into `BrtPageSetup` verbatim.
      horizontalDpi: undefined,
      verticalDpi: undefined,
      fitToHeight: 1,
      fitToWidth: 1,
      scale: 100
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "defaults",
    create: () => new PageSetupXform(),
    preparedModel: {
      pageOrder: "downThenOver",
      orientation: "portrait",
      cellComments: "None",
      errors: "displayed"
    },
    xml: '<pageSetup orientation="portrait"/>',
    parsedModel: {
      pageOrder: "downThenOver",
      orientation: "portrait",
      cellComments: "None",
      errors: "displayed",
      useFirstPageNumber: false,
      usePrinterDefaults: false,
      copies: 1,
      // Absent in the XML, absent in the model. This asserted 4294967295 before, which pinned a sentinel that
      // only the XLSX writer knew to strip — the XLSB writer wrote it into `BrtPageSetup` verbatim.
      horizontalDpi: undefined,
      verticalDpi: undefined,
      blackAndWhite: false,
      draft: false,
      fitToHeight: 1,
      fitToWidth: 1,
      scale: 100
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "scale and fit",
    create: () => new PageSetupXform(),
    preparedModel: {
      paperSize: 119,
      scale: 95,
      fitToWidth: 2,
      fitToHeight: 3,
      orientation: "landscape"
    },
    xml: '<pageSetup paperSize="119" scale="95" fitToWidth="2" fitToHeight="3" orientation="landscape"/>',
    parsedModel: {
      paperSize: 119,
      scale: 95,
      fitToWidth: 2,
      fitToHeight: 3,
      orientation: "landscape",
      useFirstPageNumber: false,
      usePrinterDefaults: false,
      copies: 1,
      // Absent in the XML, absent in the model. This asserted 4294967295 before, which pinned a sentinel that
      // only the XLSX writer knew to strip — the XLSB writer wrote it into `BrtPageSetup` verbatim.
      horizontalDpi: undefined,
      verticalDpi: undefined,
      blackAndWhite: false,
      cellComments: "None",
      draft: false,
      errors: "displayed",
      pageOrder: "downThenOver"
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("PageSetupXform", () => {
  testXformHelper(expectations);
});
