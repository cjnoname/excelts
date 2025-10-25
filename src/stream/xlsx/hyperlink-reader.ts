import { EventEmitter } from "events";
import { parseSax } from "../../utils/parse-sax.js";
import { Enums } from "../../doc/enums.js";
import { RelType } from "../../xlsx/rel-type.js";

interface HyperlinkReaderOptions {
  workbook: any;
  id: number;
  iterator: any;
  options: any;
}

interface Hyperlink {
  type: number;
  rId: string;
  target: string;
  targetMode: string;
}

class HyperlinkReader extends EventEmitter {
  workbook: any;
  id: number;
  iterator: any;
  options: any;
  hyperlinks?: { [key: string]: Hyperlink };

  constructor({ workbook, id, iterator, options }: HyperlinkReaderOptions) {
    super();

    this.workbook = workbook;
    this.id = id;
    this.iterator = iterator;
    this.options = options;
  }

  get count(): number {
    return (this.hyperlinks && Object.keys(this.hyperlinks).length) || 0;
  }

  each(fn: (hyperlink: Hyperlink, rId: string) => void): void {
    if (this.hyperlinks) {
      Object.keys(this.hyperlinks).forEach(rId => {
        fn(this.hyperlinks![rId], rId);
      });
    }
  }

  async read(): Promise<void> {
    const { iterator, options } = this;
    let emitHyperlinks = false;
    let hyperlinks: { [key: string]: Hyperlink } | null = null;
    switch (options.hyperlinks) {
      case "emit":
        emitHyperlinks = true;
        break;
      case "cache":
        this.hyperlinks = hyperlinks = {};
        break;
      default:
        break;
    }

    if (!emitHyperlinks && !hyperlinks) {
      this.emit("finished");
      return;
    }

    try {
      for await (const events of parseSax(iterator)) {
        for (const { eventType, value } of events) {
          if (eventType === "opentag") {
            const node = value;
            if (node.name === "Relationship") {
              const rId = node.attributes.Id;
              switch (node.attributes.Type) {
                case RelType.Hyperlink:
                  {
                    const relationship: Hyperlink = {
                      type: Enums.RelationshipType.Styles,
                      rId,
                      target: node.attributes.Target,
                      targetMode: node.attributes.TargetMode
                    };
                    if (emitHyperlinks) {
                      this.emit("hyperlink", relationship);
                    } else {
                      hyperlinks![relationship.rId] = relationship;
                    }
                  }
                  break;

                default:
                  break;
              }
            }
          }
        }
      }
      this.emit("finished");
    } catch (error) {
      this.emit("error", error);
    }
  }
}

export { HyperlinkReader };
