import { ChartsheetXform } from "@excel/xlsx/xform/sheet/chartsheet-xform";
import { XmlWriter } from "@xml/writer";
import { describe, expect, it } from "vitest";

async function parse(xml: string) {
  async function* input() {
    yield xml;
  }
  return new ChartsheetXform().parseStream(input());
}

describe("ChartsheetXform header/footer", () => {
  it("parses structured header/footer content", async () => {
    const model = await parse(`
      <chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetViews><sheetView workbookViewId="0"/></sheetViews>
        <headerFooter differentOddEven="1">
          <oddHeader>&amp;CReport</oddHeader>
          <evenFooter>&amp;C&amp;P/&amp;N</evenFooter>
        </headerFooter>
      </chartsheet>
    `);

    expect(model?.headerFooter).toMatchObject({
      differentOddEven: true,
      oddHeader: "&CReport",
      evenFooter: "&C&P/&N"
    });
  });

  it("renders structured header/footer content", () => {
    const writer = new XmlWriter();
    new ChartsheetXform().render(writer, {
      sheetNo: 1,
      id: 1,
      name: "Chart Sheet",
      headerFooter: {
        differentFirst: false,
        differentOddEven: false,
        oddHeader: "&CReport",
        oddFooter: "&C&P/&N"
      }
    });
    const xml = writer.toString();

    expect(xml).toContain("<headerFooter>");
    expect(xml).toContain("<oddHeader>&amp;CReport</oddHeader>");
    expect(xml).toContain("<oddFooter>&amp;C&amp;P/&amp;N</oddFooter>");
  });
});
