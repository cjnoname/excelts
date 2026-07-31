import { testXformHelper } from "@excel/xlsx/__tests__/xform/test-xform-helper";
import { HeaderFooterXform } from "@excel/xlsx/xform/sheet/header-footer-xform";
import { describe } from "vitest";

const expectations = [
  {
    title: "set oddHeader",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      oddHeader: "&CDocumonster"
    },
    xml: "<headerFooter><oddHeader>&amp;CDocumonster</oddHeader></headerFooter>",
    parsedModel: {
      oddHeader: "&CDocumonster"
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "set oddFooter",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      oddFooter: "&CDocumonster"
    },
    xml: "<headerFooter><oddFooter>&amp;CDocumonster</oddFooter></headerFooter>",
    parsedModel: {
      oddFooter: "&CDocumonster"
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "set oddHeader position",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      oddHeader: "&LDocumonster"
    },
    xml: "<headerFooter><oddHeader>&amp;LDocumonster</oddHeader></headerFooter>",
    parsedModel: {
      oddHeader: "&LDocumonster"
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "set firstFooter",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      differentFirst: true,
      oddHeader: "&CDocumonster",
      oddFooter: "&CDocumonster",
      firstHeader: "&CHome",
      firstFooter: "&CHome"
    },
    xml: '<headerFooter differentFirst="1"><oddFooter>&amp;CDocumonster</oddFooter><firstFooter>&amp;CHome</firstFooter><oddHeader>&amp;CDocumonster</oddHeader><firstHeader>&amp;CHome</firstHeader></headerFooter>',
    parsedModel: {
      differentFirst: true,
      oddHeader: "&CDocumonster",
      oddFooter: "&CDocumonster",
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
  },
  {
    title: "set scaling and margin alignment",
    create: () => new HeaderFooterXform(),
    preparedModel: {
      scaleWithDoc: false,
      alignWithMargins: false,
      oddHeader: "&CTest"
    },
    xml: '<headerFooter scaleWithDoc="0" alignWithMargins="0"><oddHeader>&amp;CTest</oddHeader></headerFooter>',
    parsedModel: {
      scaleWithDoc: false,
      alignWithMargins: false,
      oddHeader: "&CTest"
    },
    tests: ["render", "renderIn", "parse"]
  },
  {
    title: "parse XSD boolean words",
    create: () => new HeaderFooterXform(),
    xml: '<headerFooter differentFirst="true" scaleWithDoc="false" alignWithMargins="false"><oddHeader>&amp;CTest</oddHeader></headerFooter>',
    parsedModel: {
      differentFirst: true,
      scaleWithDoc: false,
      alignWithMargins: false,
      oddHeader: "&CTest"
    },
    tests: ["parse"]
  }
];

describe("HeaderFooterXform", () => {
  testXformHelper(expectations);
});
