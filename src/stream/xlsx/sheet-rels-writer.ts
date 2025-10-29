import { xmlEncode } from "../../utils/utils.js";
import { RelType } from "../../xlsx/rel-type.js";

interface Hyperlink {
  address: string;
  target: string;
}

interface Relationship {
  Type: string;
  Target: string;
  TargetMode?: string;
}

class HyperlinksProxy {
  writer: SheetRelsWriter;

  constructor(sheetRelsWriter: SheetRelsWriter) {
    this.writer = sheetRelsWriter;
  }

  push(hyperlink: Hyperlink): void {
    this.writer.addHyperlink(hyperlink);
  }
}

interface SheetRelsWriterOptions {
  id: number;
  workbook: any;
}

class SheetRelsWriter {
  id: number;
  count: number;
  _hyperlinks: Array<{ rId: string; address: string }>;
  _workbook: any;
  _stream?: any;
  _hyperlinksProxy?: HyperlinksProxy;

  constructor(options: SheetRelsWriterOptions) {
    // in a workbook, each sheet will have a number
    this.id = options.id;

    // count of all relationships
    this.count = 0;

    // keep record of all hyperlinks
    this._hyperlinks = [];

    this._workbook = options.workbook;
  }

  get stream(): any {
    if (!this._stream) {
      this._stream = this._workbook._openStream(`xl/worksheets/_rels/sheet${this.id}.xml.rels`);
    }
    return this._stream;
  }

  get length(): number {
    return this._hyperlinks.length;
  }

  each(fn: (hyperlink: { rId: string; address: string }) => void): void {
    return this._hyperlinks.forEach(fn);
  }

  get hyperlinksProxy(): HyperlinksProxy {
    return this._hyperlinksProxy || (this._hyperlinksProxy = new HyperlinksProxy(this));
  }

  addHyperlink(hyperlink: Hyperlink): void {
    // Write to stream
    const relationship: Relationship = {
      Target: hyperlink.target,
      Type: RelType.Hyperlink,
      TargetMode: "External"
    };
    const rId = this._writeRelationship(relationship);

    // store sheet stuff for later
    this._hyperlinks.push({
      rId,
      address: hyperlink.address
    });
  }

  addMedia(media: Relationship): string {
    return this._writeRelationship(media);
  }

  addRelationship(rel: Relationship): string {
    return this._writeRelationship(rel);
  }

  commit(): void {
    if (this.count) {
      // write xml utro
      this._writeClose();
      // and close stream
      this.stream.end();
    }
  }

  // ================================================================================
  _writeOpen(): void {
    this.stream.write(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    );
  }

  _writeRelationship(relationship: Relationship): string {
    if (!this.count) {
      this._writeOpen();
    }

    const rId = `rId${++this.count}`;

    if (relationship.TargetMode) {
      this.stream.write(
        `<Relationship Id="${rId}"` +
          ` Type="${relationship.Type}"` +
          ` Target="${xmlEncode(relationship.Target)}"` +
          ` TargetMode="${relationship.TargetMode}"` +
          "/>"
      );
    } else {
      this.stream.write(
        `<Relationship Id="${rId}" Type="${relationship.Type}" Target="${relationship.Target}"/>`
      );
    }

    return rId;
  }

  _writeClose(): void {
    this.stream.write("</Relationships>");
  }
}

export { SheetRelsWriter };
