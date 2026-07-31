import type { FormCheckboxModel } from "@excel/core/form-control";
import {
  formCheckboxVmlAnchor,
  formCheckboxVmlCheckedValue,
  formCheckboxVmlStyle
} from "@excel/core/form-control";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { ShapeModel } from "@excel/xlsx/xform/comment/vml-shape-xform";
import { VmlShapeXform } from "@excel/xlsx/xform/comment/vml-shape-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";
import { StdDocAttributes } from "@xml/writer";

/**
 * Unified VML Drawing Xform - Combines Notes (comments) and Form Controls
 *
 * Excel uses a single VML file per worksheet that can contain:
 * - Comment/note shapes (shapetype 202)
 * - Form control shapes (checkbox shapetype 201, etc.)
 *
 * This unified xform renders both into a single VML file.
 */

/** Header/footer image model for VML rendering. */
interface VmlHeaderImageModel {
  /** rId referencing the image in the VML drawing's .rels */
  imageRelId: string;
  /** Image width in points */
  width?: number;
  /** Image height in points */
  height?: number;
  /** Excel header/footer section id: LH, CH, RH, LF, CF, or RF. */
  position?: string;
}

interface VmlDrawingModel {
  /** Comment/note shapes */
  comments?: ShapeModel[];
  /** Form control checkboxes */
  formControls?: FormCheckboxModel[];
  /** Header/footer image (for watermark in header mode) */
  headerImage?: VmlHeaderImageModel;
  /** All header/footer image shapes parsed from a foreign workbook. */
  headerImages?: VmlHeaderImageModel[];
}

class VmlDrawingXform extends BaseXform<VmlDrawingModel> {
  declare public map: Record<string, BaseXform>;
  declare public parser?: BaseXform;

  constructor() {
    super();
    this.map = {
      "v:shape": new VmlShapeXform()
    };
    this.model = { comments: [], formControls: [] };
  }

  get tag(): string {
    return "xml";
  }

  /**
   * Render VML drawing containing both notes and form controls
   */
  render(xmlStream: XmlSink, model?: VmlDrawingModel): void {
    const renderModel = (model || this.model)!;
    const comments = renderModel.comments;
    const formControls = renderModel.formControls;
    const declaredHeaderImages =
      renderModel.headerImages ?? (renderModel.headerImage ? [renderModel.headerImage] : []);
    // Excel holds at most one image per header/footer section, and a VML part
    // must not repeat a shape id. Keep the last declaration per section.
    const headerImages = [
      ...new Map(
        declaredHeaderImages.map(image => [image.position ?? "CH", image] as const)
      ).values()
    ];
    const hasComments = comments && comments.length > 0;
    const hasFormControls = formControls && formControls.length > 0;
    const hasHeaderImage = headerImages.length > 0;

    xmlStream.openXml(StdDocAttributes);
    xmlStream.openNode(this.tag, VmlDrawingXform.DRAWING_ATTRIBUTES);

    // Shape layout - shared by both notes and form controls
    xmlStream.openNode("o:shapelayout", { "v:ext": "edit" });
    xmlStream.leafNode("o:idmap", { "v:ext": "edit", data: 1 });
    xmlStream.closeNode();

    // Shapetype 202 for notes/comments
    if (hasComments) {
      xmlStream.openNode("v:shapetype", {
        id: "_x0000_t202",
        coordsize: "21600,21600",
        "o:spt": 202,
        path: "m,l,21600r21600,l21600,xe"
      });
      xmlStream.leafNode("v:stroke", { joinstyle: "miter" });
      xmlStream.leafNode("v:path", { gradientshapeok: "t", "o:connecttype": "rect" });
      xmlStream.closeNode();
    }

    // Shapetype 201 for form control checkboxes
    if (hasFormControls) {
      xmlStream.openNode("v:shapetype", {
        id: "_x0000_t201",
        coordsize: "21600,21600",
        "o:spt": "201",
        path: "m,l,21600r21600,l21600,xe"
      });
      xmlStream.leafNode("v:stroke", { joinstyle: "miter" });
      xmlStream.leafNode("v:path", {
        shadowok: "f",
        "o:extrusionok": "f",
        strokeok: "f",
        fillok: "f",
        "o:connecttype": "rect"
      });
      xmlStream.leafNode("o:lock", { "v:ext": "edit", shapetype: "t" });
      xmlStream.closeNode();
    }

    // Shapetype 75 for header/footer image (watermark)
    if (hasHeaderImage) {
      xmlStream.openNode("v:shapetype", {
        id: "_x0000_t75",
        coordsize: "21600,21600",
        "o:spt": "75",
        "o:preferrelative": "t",
        path: "m@4@5l@4@11@9@11@9@5xe",
        filled: "f",
        stroked: "f"
      });
      xmlStream.leafNode("v:stroke", { joinstyle: "miter" });
      xmlStream.openNode("v:formulas");
      xmlStream.leafNode("v:f", { eqn: "if lineDrawn pixelLineWidth 0" });
      xmlStream.leafNode("v:f", { eqn: "sum @0 1 0" });
      xmlStream.leafNode("v:f", { eqn: "sum 0 0 @1" });
      xmlStream.leafNode("v:f", { eqn: "prod @2 1 2" });
      xmlStream.leafNode("v:f", { eqn: "prod @3 21600 pixelWidth" });
      xmlStream.leafNode("v:f", { eqn: "prod @3 21600 pixelHeight" });
      xmlStream.leafNode("v:f", { eqn: "sum @0 0 1" });
      xmlStream.leafNode("v:f", { eqn: "prod @6 1 2" });
      xmlStream.leafNode("v:f", { eqn: "prod @7 21600 pixelWidth" });
      xmlStream.leafNode("v:f", { eqn: "sum @8 21600 0" });
      xmlStream.leafNode("v:f", { eqn: "prod @7 21600 pixelHeight" });
      xmlStream.leafNode("v:f", { eqn: "sum @10 21600 0" });
      xmlStream.closeNode(); // v:formulas
      xmlStream.leafNode("v:path", {
        "o:extrusionok": "f",
        gradientshapeok: "t",
        "o:connecttype": "rect"
      });
      xmlStream.leafNode("o:lock", { "v:ext": "edit", aspectratio: "t" });
      xmlStream.closeNode(); // v:shapetype
    }

    // Render comment shapes
    if (hasComments) {
      for (let i = 0; i < comments.length; i++) {
        (this.map["v:shape"] as VmlShapeXform).render(xmlStream, comments[i], i);
      }
    }

    // Render form control shapes
    if (hasFormControls) {
      for (const control of formControls) {
        this._renderCheckboxShape(xmlStream, control);
      }
    }

    // Render header/footer image shape
    if (hasHeaderImage) {
      for (let i = 0; i < headerImages.length; i++) {
        this._renderHeaderImageShape(xmlStream, headerImages[i], i);
      }
    }

    xmlStream.closeNode();
  }

  /**
   * Render a header/footer image shape for watermark
   */
  private _renderHeaderImageShape(
    xmlStream: XmlSink,
    headerImage: VmlHeaderImageModel,
    index: number
  ): void {
    const width = headerImage.width ?? 467.25;
    const height = headerImage.height ?? 311.25;

    const position = headerImage.position ?? "CH";
    xmlStream.openNode("v:shape", {
      id: position,
      "o:spid": `_x0000_s${2049 + index}`,
      type: "#_x0000_t75",
      style: `position:absolute;margin-left:0;margin-top:0;width:${width}pt;height:${height}pt;z-index:1`
    });
    xmlStream.leafNode("v:imagedata", {
      "o:relid": headerImage.imageRelId,
      "o:title": "watermark"
    });
    xmlStream.leafNode("o:lock", { "v:ext": "edit", rotation: "t" });
    xmlStream.closeNode(); // v:shape
  }

  /**
   * Render a checkbox form control shape
   */
  private _renderCheckboxShape(xmlStream: XmlSink, control: FormCheckboxModel): void {
    const shapeAttrs: Record<string, string> = {
      id: `_x0000_s${control.shapeId}`,
      type: "#_x0000_t201",
      style: formCheckboxVmlStyle(control),
      "o:insetmode": "auto",
      fillcolor: "buttonFace [67]",
      strokecolor: "windowText [64]",
      "o:preferrelative": "t",
      filled: "f",
      stroked: "f"
    };

    xmlStream.openNode("v:shape", shapeAttrs);

    // Fill element
    xmlStream.leafNode("v:fill", { "o:detectmouseclick": "t" });

    // Lock element
    xmlStream.leafNode("o:lock", { "v:ext": "edit", text: "t" });

    // Textbox for label
    if (control.text) {
      xmlStream.openNode("v:textbox", {
        style: "mso-direction-alt:auto",
        "o:singleclick": "t"
      });
      xmlStream.openNode("div", { style: "text-align:left" });
      xmlStream.openNode("font", { face: "Tahoma", size: "160", color: "auto" });
      xmlStream.writeText(control.text);
      xmlStream.closeNode(); // font
      xmlStream.closeNode(); // div
      xmlStream.closeNode(); // v:textbox
    }

    // ClientData - the core of the checkbox control
    xmlStream.openNode("x:ClientData", { ObjectType: "Checkbox" });

    // Match Excel's VML patterns (similar to Note ClientData): include positioning and cell address.
    // Omitting these can cause Excel to repair the sheet by dropping all legacy controls.
    xmlStream.leafNode("x:MoveWithCells");
    xmlStream.leafNode("x:SizeWithCells");

    // Anchor position
    xmlStream.openNode("x:Anchor");
    xmlStream.writeText(formCheckboxVmlAnchor(control));
    xmlStream.closeNode();

    // Protection / text locking
    xmlStream.leafNode("x:Locked", undefined, "False");
    xmlStream.leafNode("x:LockText", undefined, "True");

    // Print settings
    xmlStream.leafNode("x:PrintObject", undefined, control.print ? "True" : "False");
    xmlStream.leafNode("x:AutoFill", undefined, "False");
    xmlStream.leafNode("x:AutoLine", undefined, "False");
    xmlStream.leafNode("x:TextHAlign", undefined, "Left");
    xmlStream.leafNode("x:TextVAlign", undefined, "Center");

    // Linked cell
    if (control.link) {
      xmlStream.leafNode("x:FmlaLink", undefined, control.link);
    }

    // 3D appearance
    if (control.noThreeD) {
      xmlStream.leafNode("x:NoThreeD");
    }

    // Checked state (0 = unchecked, 1 = checked, 2 = mixed)
    xmlStream.leafNode("x:Checked", undefined, String(formCheckboxVmlCheckedValue(control)));

    // Cell address (0-based row/column)
    xmlStream.leafNode("x:Row", undefined, String(control.tl.row));
    xmlStream.leafNode("x:Column", undefined, String(control.tl.col));

    xmlStream.closeNode(); // x:ClientData
    xmlStream.closeNode(); // v:shape
  }

  // Parsing - delegate to VmlShapeXform for notes, handle header images directly
  parseOpen(node: ParseOpenTag): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case this.tag:
        this.reset();
        this.model = {
          comments: [],
          formControls: []
        };
        break;
      case "v:shape":
        // Check if this is a header image shape (type="#_x0000_t75")
        if (node.attributes.type === "#_x0000_t75") {
          this._parsingHeaderImage = true;
          this._headerImagePosition = node.attributes.id;
          // Extract width/height from style
          const style = node.attributes.style || "";
          const widthMatch = /width:([0-9.]+)pt/.exec(style);
          const heightMatch = /height:([0-9.]+)pt/.exec(style);
          this._headerImageWidth = widthMatch ? parseFloat(widthMatch[1]) : undefined;
          this._headerImageHeight = heightMatch ? parseFloat(heightMatch[1]) : undefined;
        } else {
          // Regular shape — delegate to VmlShapeXform (comments)
          this.parser = this.map[node.name];
          if (this.parser) {
            this.parser.parseOpen(node);
          }
        }
        break;
      default:
        if (this._parsingHeaderImage && node.name === "v:imagedata") {
          this._headerImageRelId = node.attributes["o:relid"];
        } else {
          this.parser = this.map[node.name];
          if (this.parser) {
            this.parser.parseOpen(node);
          }
        }
        break;
    }
    return true;
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.model!.comments!.push(this.parser.model);
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case "v:shape":
        if (this._parsingHeaderImage && this._headerImageRelId) {
          const headerImage = {
            imageRelId: this._headerImageRelId,
            width: this._headerImageWidth,
            height: this._headerImageHeight,
            position: this._headerImagePosition
          };
          this.model!.headerImages ??= [];
          this.model!.headerImages.push(headerImage);
          this.model!.headerImage ??= headerImage;
        }
        this._parsingHeaderImage = false;
        this._headerImageRelId = undefined;
        this._headerImageWidth = undefined;
        this._headerImageHeight = undefined;
        this._headerImagePosition = undefined;
        return true;
      case this.tag:
        return false;
      default:
        return true;
    }
  }

  // Internal state for parsing header image shapes
  private _parsingHeaderImage = false;
  private _headerImageRelId?: string;
  private _headerImageWidth?: number;
  private _headerImageHeight?: number;
  private _headerImagePosition?: string;

  static DRAWING_ATTRIBUTES = {
    "xmlns:v": "urn:schemas-microsoft-com:vml",
    "xmlns:o": "urn:schemas-microsoft-com:office:office",
    "xmlns:x": "urn:schemas-microsoft-com:office:excel"
  };
}

export { VmlDrawingXform };
export type { VmlDrawingModel };
