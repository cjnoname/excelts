import { describe } from "vitest";
import { testXformHelper } from "../test-xform-helper.js";
import { HeaderFooterXform } from "../../../../../xlsx/xform/sheet/header-footer-xform.js";

const expectations = [
  {
    title: "set oddHeader",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      oddHeader: "&CExcelts"
    },
    xml: "<headerFooter><oddHeader>&amp;CExcelts</oddHeader></headerFooter>",
    parsedModel: {
      oddHeader: "&CExcelts"
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "set oddFooter",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      oddFooter: "&CExcelts"
    },
    xml: "<headerFooter><oddFooter>&amp;CExcelts</oddFooter></headerFooter>",
    parsedModel: {
      oddFooter: "&CExcelts"
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "set oddHeader position",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      oddHeader: "&LExcelts"
    },
    xml: "<headerFooter><oddHeader>&amp;LExcelts</oddHeader></headerFooter>",
    parsedModel: {
      oddHeader: "&LExcelts"
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "set firstFooter",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      differentFirst: true,
      oddHeader: "&CExcelts",
      oddFooter: "&CExcelts",
      firstHeader: "&CHome",
      firstFooter: "&CHome"
    },
    xml: '<headerFooter differentFirst="1"><oddFooter>&amp;CExcelts</oddFooter><firstFooter>&amp;CHome</firstFooter><oddHeader>&amp;CExcelts</oddHeader><firstHeader>&amp;CHome</firstHeader></headerFooter>',
    parsedModel: {
      differentFirst: true,
      oddHeader: "&CExcelts",
      oddFooter: "&CExcelts",
      firstHeader: "&CHome",
      firstFooter: "&CHome"
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "set differentOddEven",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      differentOddEven: true,
      oddHeader: "&Codd Header",
      oddFooter: "&Codd Footer",
      evenHeader: "&Ceven Header",
      evenFooter: "&Ceven Footer"
    },
    xml: '<headerFooter differentOddEven="1"><oddHeader>&amp;Codd Header</oddHeader><oddFooter>&amp;Codd Footer</oddFooter><evenHeader>&amp;Ceven Header</evenHeader><evenFooter>&amp;Ceven Footer</evenFooter></headerFooter>',
    parsedModel: {
      differentOddEven: true,
      oddHeader: "&Codd Header",
      oddFooter: "&Codd Footer",
      evenHeader: "&Ceven Header",
      evenFooter: "&Ceven Footer"
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "set font style",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      oddFooter: "&C&B&KFF0000Red Bold"
    },
    xml: "<headerFooter><oddFooter>&amp;C&amp;B&amp;KFF0000Red Bold</oddFooter></headerFooter>",
    parsedModel: {
      oddFooter: "&C&B&KFF0000Red Bold"
    },
    tests: ["render", "renderIn", "parse"]
  }
];

describe("HeaderFooterXform", () => {
  testXformHelper(expectations);
});
