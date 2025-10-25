import { parseSax } from "../../utils/parse-sax.js";
import { XmlStream } from "../../utils/xml-stream.js";

/* 'virtual' methods used as a form of documentation */

interface ParseEvent {
  eventType: string;
  value: any;
}

// Base class for Xforms
class BaseXform {
  declare public map?: { [key: string]: any };
  declare public model?: any;

  // ============================================================
  // Virtual Interface
  prepare(_model?: any, _options?: any): void {
    // optional preparation (mutation) of model so it is ready for write
  }

  render(_xmlStream?: XmlStream, _model?: any): void {
    // convert model to xml
  }

  parseOpen(_node: any): void {
    // XML node opened
  }

  parseText(_text: string): void {
    // chunk of text encountered for current node
  }

  parseClose(_name: string): boolean {
    // XML node closed
    return false;
  }

  reconcile(_model: any, _options?: any): void {
    // optional post-parse step (opposite to prepare)
  }

  // ============================================================
  reset(): void {
    // to make sure parses don't bleed to next iteration
    (this as any).model = null;

    // if we have a map - reset them too
    if (this.map) {
      Object.values(this.map).forEach(xform => {
        if (xform instanceof BaseXform) {
          xform.reset();
        } else if (xform.xform) {
          xform.xform.reset();
        }
      });
    }
  }

  mergeModel(obj: any): void {
    // set obj's props to this.model
    (this as any).model = Object.assign((this as any).model || {}, obj);
  }

  async parse(saxParser: AsyncIterable<ParseEvent[]>): Promise<any> {
    for await (const events of saxParser) {
      for (const { eventType, value } of events) {
        if (eventType === "opentag") {
          this.parseOpen(value);
        } else if (eventType === "text") {
          this.parseText(value);
        } else if (eventType === "closetag") {
          if (!this.parseClose(value.name)) {
            return (this as any).model;
          }
        }
      }
    }
    return (this as any).model;
  }

  async parseStream(stream: any): Promise<any> {
    return this.parse(parseSax(stream));
  }

  get xml(): string {
    // convenience function to get the xml of this.model
    // useful for manager types that are built during the prepare phase
    return this.toXml((this as any).model);
  }

  toXml(model: any): string {
    const xmlStream = new XmlStream();
    this.render(xmlStream, model);
    return xmlStream.xml;
  }

  // ============================================================
  // Useful Utilities
  static toAttribute(value: any, dflt?: any, always: boolean = false): string | undefined {
    if (value === undefined) {
      if (always) {
        return dflt;
      }
    } else if (always || value !== dflt) {
      return value.toString();
    }
    return undefined;
  }

  static toStringAttribute(value: any, dflt?: any, always: boolean = false): string | undefined {
    return BaseXform.toAttribute(value, dflt, always);
  }

  static toStringValue(attr: any, dflt?: any): any {
    return attr === undefined ? dflt : attr;
  }

  static toBoolAttribute(value: any, dflt?: any, always: boolean = false): string | undefined {
    if (value === undefined) {
      if (always) {
        return dflt;
      }
    } else if (always || value !== dflt) {
      return value ? "1" : "0";
    }
    return undefined;
  }

  static toBoolValue(attr: any, dflt?: any): boolean {
    return attr === undefined ? dflt : attr === "1";
  }

  static toIntAttribute(value: any, dflt?: any, always: boolean = false): string | undefined {
    return BaseXform.toAttribute(value, dflt, always);
  }

  static toIntValue(attr: any, dflt?: any): number {
    return attr === undefined ? dflt : parseInt(attr, 10);
  }

  static toFloatAttribute(value: any, dflt?: any, always: boolean = false): string | undefined {
    return BaseXform.toAttribute(value, dflt, always);
  }

  static toFloatValue(attr: any, dflt?: any): number {
    return attr === undefined ? dflt : parseFloat(attr);
  }
}

export { BaseXform };
