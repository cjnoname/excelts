import { isInternalLink } from "@excel/core/hyperlink";
import type { WorkbookWriterLike } from "@excel/stream/worksheet-writer";
import { worksheetRelsPath } from "@excel/utils/ooxml-paths";
import type { StreamBuf } from "@excel/utils/stream-buf";
import { RelType } from "@excel/xlsx/rel-type";
import { xmlEncode } from "@xml/encode";

interface Hyperlink {
  address: string;
  target: string;
}

interface Relationship {
  Type: string;
  Target: string;
  TargetMode?: string;
}

interface HyperlinksProxy {
  push(hyperlink: Hyperlink): void;
}

function createHyperlinksProxy(sheetRelsWriter: SheetRelsWriter): HyperlinksProxy {
  return {
    push(hyperlink: Hyperlink) {
      sheetRelsWriter.addHyperlink(hyperlink);
    }
  };
}

interface SheetRelsWriterOptions {
  id: number;
  workbook: WorkbookWriterLike;
}

class SheetRelsWriter {
  id: number;
  count: number;
  /** @internal */
  _hyperlinks: Array<{ rId?: string; address: string; target?: string }>;
  private _workbook: WorkbookWriterLike;
  private _stream?: StreamBuf;
  private _hyperlinksProxy?: HyperlinksProxy;

  constructor(options: SheetRelsWriterOptions) {
    // in a workbook, each sheet will have a number
    this.id = options.id;

    // count of all relationships
    this.count = 0;

    // keep record of all hyperlinks
    this._hyperlinks = [];

    this._workbook = options.workbook;
  }

  get stream(): StreamBuf {
    if (!this._stream) {
      this._stream = this._workbook._openStream(worksheetRelsPath(this.id));
    }
    return this._stream;
  }

  get length(): number {
    return this._hyperlinks.length;
  }

  each(fn: (hyperlink: { rId?: string; address: string; target?: string }) => void): void {
    return this._hyperlinks.forEach(fn);
  }

  get hyperlinksProxy(): HyperlinksProxy {
    return this._hyperlinksProxy || (this._hyperlinksProxy = createHyperlinksProxy(this));
  }

  addHyperlink(hyperlink: Hyperlink): void {
    if (isInternalLink(hyperlink.target)) {
      // Internal link: no relationship needed, only store for sheet XML
      this._hyperlinks.push({
        address: hyperlink.address,
        target: hyperlink.target
      });
      return;
    }
    // External link: write relationship
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

  private _writeOpen(): void {
    this.stream.write(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    );
  }

  private _writeRelationship(relationship: Relationship): string {
    if (!this.count) {
      this._writeOpen();
    }

    const rId = `rId${++this.count}`;

    if (relationship.TargetMode) {
      this.stream.write(
        `<Relationship Id="${rId}"` +
          ` Type="${xmlEncode(relationship.Type)}"` +
          ` Target="${xmlEncode(relationship.Target)}"` +
          ` TargetMode="${xmlEncode(relationship.TargetMode)}"` +
          "/>"
      );
    } else {
      this.stream.write(
        `<Relationship Id="${rId}" Type="${xmlEncode(relationship.Type)}" Target="${xmlEncode(relationship.Target)}"/>`
      );
    }

    return rId;
  }

  private _writeClose(): void {
    this.stream.write("</Relationships>");
  }
}

export { SheetRelsWriter };
