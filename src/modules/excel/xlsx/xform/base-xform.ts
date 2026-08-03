import { toError } from "@utils/errors";
import { SaxParser } from "@xml/sax";
import type { XmlSink, SaxTag, SaxEvent } from "@xml/types";
import { XmlWriter } from "@xml/writer";

/* 'virtual' methods used as a form of documentation */

// HAN CELL namespace prefix normalization
// HAN CELL uses non-standard namespace prefixes (ep:, cp:, dc:, etc.)
const HAN_CELL_PREFIXES = new Set(["ep", "cp", "dc", "dcterms", "dcmitype", "vt"]);
const SPREADSHEETML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

// Detect HAN CELL mode from first tag. Returns:
// - undefined: normal file (no prefix handling needed)
// - null: HAN CELL file without spreadsheetml prefix (uses static prefixes only)
// - string: HAN CELL file with spreadsheetml prefix (e.g., "x")
function detectHanCellPrefix(
  tagName: string,
  attrs: Record<string, string>
): string | null | undefined {
  let hasHanCellPrefix = false;
  for (const key in attrs) {
    if (key.length > 6 && key.startsWith("xmlns:")) {
      const prefix = key.slice(6);
      // Check for spreadsheetml namespace prefix — always wins
      if (attrs[key] === SPREADSHEETML_NS) {
        return prefix;
      }
      // Note if we see a known HAN CELL prefix, but don't return yet
      // because spreadsheetml might appear later in the iteration
      if (HAN_CELL_PREFIXES.has(prefix)) {
        hasHanCellPrefix = true;
      }
    }
  }
  if (hasHanCellPrefix) {
    return null;
  }
  // Check if tag name has a known static prefix
  const i = tagName.indexOf(":");
  return i !== -1 && HAN_CELL_PREFIXES.has(tagName.slice(0, i)) ? null : undefined;
}

// Strip known namespace prefix from element name
function stripPrefix(name: string, nsPrefix: string | null): string {
  const i = name.indexOf(":");
  if (i === -1) {
    return name;
  }
  const p = name.slice(0, i);
  return p === nsPrefix || HAN_CELL_PREFIXES.has(p) ? name.slice(i + 1) : name;
}

// Base class for Xforms
class BaseXform<TModel = any> {
  declare public map?: { [key: string]: any };
  public model?: TModel;

  // ============================================================
  // Virtual Interface
  prepare(_model?: any, _options?: any): void {
    // optional preparation (mutation) of model so it is ready for write
  }

  render(_xmlStream?: XmlSink, _model?: any): void {
    // convert model to xml
  }

  parseOpen(_node: any): boolean | void {
    // XML node opened. Subclasses that participate in a composite parse return
    // a boolean indicating whether they consumed the node; leaf/standalone
    // xforms return nothing (void).
    return false;
  }

  parseText(_text: string): void {
    // chunk of text encountered for current node
  }

  parseCdata(text: string): void {
    // CDATA and ordinary text have the same parsed value. Xforms that need to
    // preserve the lexical CDATA wrapper may override this method.
    this.parseText(text);
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
    this.model = undefined;

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

  mergeModel(obj: Partial<TModel>): void {
    // set obj's props to this.model
    const base: object = (this.model as object | undefined) ?? {};
    this.model = Object.assign(base, obj) as TModel;
  }

  async parse(saxParser: AsyncIterable<SaxEvent[]>): Promise<TModel | undefined> {
    // IMPORTANT:
    // Do not return early once parsing is "done".
    // In true streaming scenarios, `parseSax(stream)` is backed by a Node.js
    // Readable async iterator. Returning early would close the iterator, which
    // destroys the underlying stream and can surface as AbortError (ABORT_ERR).
    let done = false;
    let finalModel: TModel | undefined;

    // HAN CELL compatibility: 0 = not checked, 1 = normal file, 2 = HAN CELL file
    let nsMode = 0;
    let nsPrefix: string | null = null;

    for await (const events of saxParser) {
      if (done) {
        continue;
      }
      for (const event of events) {
        if (event.eventType === "opentag") {
          const value = event.value;
          // Fast path for normal Excel files (majority case)
          if (nsMode === 1) {
            this.parseOpen(value);
            continue;
          }
          // First tag - detect mode
          if (nsMode === 0) {
            const prefix = detectHanCellPrefix(value.name, value.attributes);
            if (prefix === undefined) {
              nsMode = 1;
              this.parseOpen(value);
              continue;
            }
            nsMode = 2;
            nsPrefix = prefix;
          }
          // HAN CELL mode - strip prefix without mutating the SAX tag object
          const strippedName = stripPrefix(value.name, nsPrefix);
          if (strippedName !== value.name) {
            this.parseOpen({
              name: strippedName,
              attributes: value.attributes,
              isSelfClosing: value.isSelfClosing
            });
          } else {
            this.parseOpen(value);
          }
        } else if (event.eventType === "text") {
          this.parseText(event.value);
        } else if (event.eventType === "cdata") {
          this.parseCdata(event.value);
        } else if (event.eventType === "closetag") {
          const value = event.value;
          // Fast path for normal files
          if (nsMode === 1) {
            if (!this.parseClose(value.name)) {
              done = true;
              finalModel = this.model;
              break;
            }
            continue;
          }
          // HAN CELL mode - strip prefix
          if (!this.parseClose(stripPrefix(value.name, nsPrefix))) {
            done = true;
            finalModel = this.model;
            break;
          }
        }
      }
    }

    return done ? finalModel : this.model;
  }

  /**
   * High-performance stream parsing using direct SAX callbacks.
   * Eliminates per-event object allocation and async generator overhead.
   * Use this instead of parse(parseSax(stream)) for hot paths.
   */
  async parseStreamDirect(stream: AsyncIterable<any>): Promise<TModel | undefined> {
    const parser = new SaxParser({ invalidCharHandling: "skip" });
    const decoder = new TextDecoder("utf-8", { fatal: true });

    let done = false;
    let finalModel: TModel | undefined;

    // HAN CELL compatibility: 0 = not checked, 1 = normal file, 2 = HAN CELL file
    let nsMode = 0;
    let nsPrefix: string | null = null;

    // Suppress errors that occur after we're done parsing (the SAX parser will
    // encounter unmatched tags when we stop processing close tags).
    // IMPORTANT: We set error handler FIRST, before any write() calls, to ensure
    // it's always present when fail() is called from within callbacks.
    let parseError: Error | undefined;
    parser.on("error", (err: Error) => {
      if (!done) {
        parseError = err;
      }
      // When done, silently swallow all SAX errors
    });

    parser.on("opentag", (tag: SaxTag) => {
      if (done) {
        return;
      }
      // Fast path for normal Excel files (majority case)
      if (nsMode === 1) {
        this.parseOpen(tag);
        return;
      }
      // First tag - detect mode
      if (nsMode === 0) {
        const prefix = detectHanCellPrefix(tag.name, tag.attributes);
        if (prefix === undefined) {
          nsMode = 1;
          this.parseOpen(tag);
          return;
        }
        nsMode = 2;
        nsPrefix = prefix;
      }
      // HAN CELL mode - strip prefix without mutating the SAX tag object
      // (the SAX parser reuses the tag on its internal stack for close-tag matching)
      const strippedName = stripPrefix(tag.name, nsPrefix);
      if (strippedName !== tag.name) {
        this.parseOpen({
          name: strippedName,
          attributes: tag.attributes,
          isSelfClosing: tag.isSelfClosing
        });
      } else {
        this.parseOpen(tag);
      }
    });

    parser.on("text", (text: string) => {
      if (!done) {
        this.parseText(text);
      }
    });

    parser.on("cdata", (text: string) => {
      if (!done) {
        this.parseCdata(text);
      }
    });

    parser.on("closetag", (tag: SaxTag) => {
      if (done) {
        return;
      }
      const name = nsMode === 2 ? stripPrefix(tag.name, nsPrefix) : tag.name;
      if (!this.parseClose(name)) {
        done = true;
        finalModel = this.model;
      }
    });

    // IMPORTANT: Do not return early from the async iterator.
    // In true streaming scenarios the iterator is backed by a Node.js Readable.
    // Returning early would close/destroy the stream (AbortError).
    // We must consume all chunks, but once done we skip writing to the parser.
    for await (const chunk of stream) {
      if (done) {
        continue;
      }
      const chunkStr =
        typeof chunk === "string" ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
      parser.write(chunkStr);
      if (parseError) {
        throw toError(parseError);
      }
    }

    if (!done) {
      // Flush trailing bytes from streaming decoder (catches truncated UTF-8)
      const trailing = decoder.decode();
      if (trailing) {
        parser.write(trailing);
        if (parseError) {
          throw toError(parseError);
        }
      }

      parser.close();
      if (parseError) {
        throw toError(parseError);
      }
    }

    return done ? finalModel : this.model;
  }

  async parseStream(stream: any): Promise<TModel | undefined> {
    return this.parseStreamDirect(stream);
  }

  get xml(): string {
    // convenience function to get the xml of this.model
    // useful for manager types that are built during the prepare phase
    return this.toXml(this.model);
  }

  toXml(model?: any): string {
    const xmlStream = new XmlWriter();
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
