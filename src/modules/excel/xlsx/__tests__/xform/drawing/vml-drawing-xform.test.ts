import { VmlDrawingXform } from "@excel/xlsx/xform/drawing/vml-drawing-xform";
import { XmlWriter } from "@xml/writer";
import { describe, expect, it } from "vitest";

async function parse(xml: string) {
  async function* input() {
    yield xml;
  }
  return new VmlDrawingXform().parseStream(input());
}

describe("VmlDrawingXform header/footer images", () => {
  it("parses every positioned header/footer image", async () => {
    const model = await parse(`
      <xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
        <v:shape id="LH" type="#_x0000_t75" style="width:20pt;height:10pt">
          <v:imagedata o:relid="rId1"/>
        </v:shape>
        <v:shape id="RF" type="#_x0000_t75" style="width:30pt;height:15pt">
          <v:imagedata o:relid="rId2"/>
        </v:shape>
      </xml>
    `);

    expect(model?.headerImages).toEqual([
      { imageRelId: "rId1", width: 20, height: 10, position: "LH" },
      { imageRelId: "rId2", width: 30, height: 15, position: "RF" }
    ]);
  });

  it("renders every positioned header/footer image", () => {
    const writer = new XmlWriter();
    new VmlDrawingXform().render(writer, {
      headerImages: [
        { imageRelId: "rId1", width: 20, height: 10, position: "LH" },
        { imageRelId: "rId2", width: 30, height: 15, position: "RF" }
      ]
    });
    const xml = writer.toString();

    expect(xml).toContain('id="LH"');
    expect(xml).toContain('o:relid="rId1"');
    expect(xml).toContain('id="RF"');
    expect(xml).toContain('o:relid="rId2"');
    expect(xml).toContain('o:spid="_x0000_s2049"');
    expect(xml).toContain('o:spid="_x0000_s2050"');
  });
});
