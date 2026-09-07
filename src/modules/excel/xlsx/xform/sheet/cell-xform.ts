import { Enums } from "@excel/core/enums";
import { rangeCreate, rangeExpandToAddress, rangeRange } from "@excel/core/range";
import { InvalidValueTypeError, ExcelError } from "@excel/errors";
import type { RichText } from "@excel/types";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { RichTextXform } from "@excel/xlsx/xform/strings/rich-text-xform";
import {
  dateToExcel,
  isDateFmt,
  excelToDate,
  decodeOoxmlEscape,
  parseOoxmlDate
} from "@utils/utils";
import type { XmlAttributes } from "@xml/types";

function getValueType(v) {
  if (v === null || v === undefined) {
    return Enums.ValueType.Null;
  }
  if (v instanceof String || typeof v === "string") {
    return Enums.ValueType.String;
  }
  if (typeof v === "number") {
    return Enums.ValueType.Number;
  }
  if (typeof v === "boolean") {
    return Enums.ValueType.Boolean;
  }
  if (v instanceof Date) {
    return Enums.ValueType.Date;
  }
  if (v.text && v.hyperlink) {
    return Enums.ValueType.Hyperlink;
  }
  if (v.formula) {
    return Enums.ValueType.Formula;
  }
  if (v.error) {
    return Enums.ValueType.Error;
  }
  throw new InvalidValueTypeError(typeof v, "Could not understand type of value");
}

function getEffectiveCellType(cell) {
  switch (cell.type) {
    case Enums.ValueType.Formula:
      return getValueType(cell.result);
    default:
      return cell.type;
  }
}

/**
 * Extract the display form of a hyperlink cell value that came either from
 * a shared-string rich-text payload (`{ richText: [...] }`) or from a
 * plain scalar.
 *
 * Input comes from the XML parser (`raw: unknown`), so every nested value is
 * treated defensively — the public `RichText` shape is only produced after
 * runtime validation, never asserted.
 *
 * Returns:
 *  - `text`:     always a string (flattened rich-text or `String(raw)`)
 *  - `richText`: preserved if the source was a rich-text payload, else undefined
 *
 * This keeps the CellHyperlinkValue.text: string public contract intact while
 * also letting the Hyperlink value class retain the formatted runs.
 */
function extractHyperlinkDisplay(raw: unknown): { text: string; richText?: RichText[] } {
  if (raw === null || raw === undefined) {
    return { text: "" };
  }
  if (typeof raw === "string") {
    return { text: raw };
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return { text: String(raw) };
  }
  if (typeof raw === "object") {
    const obj = raw as { richText?: unknown; error?: unknown };
    if (Array.isArray(obj.richText)) {
      // Empty runs array carries no content — emit empty display text rather
      // than falling through to `String(raw)` which would produce
      // "[object Object]".
      if (obj.richText.length === 0) {
        return { text: "" };
      }
      const runs: RichText[] = obj.richText.map(rawRun => {
        const run = rawRun as { text?: unknown; font?: unknown } | null | undefined;
        const normalized: RichText = {
          text: typeof run?.text === "string" ? run.text : ""
        };
        if (run?.font !== null && typeof run?.font === "object") {
          normalized.font = run.font as RichText["font"];
        }
        return normalized;
      });
      return { text: runs.map(r => r.text).join(""), richText: runs };
    }
    if (typeof obj.error === "string") {
      return { text: obj.error };
    }
  }
  return { text: String(raw) };
}

/**
 * Record the workbook's date system on a cell model, or clear it.
 *
 * **The `else` is the fix.** `cellGetModel` hands back the live value model, so what `prepare` writes here
 * outlives the write. Setting the flag only when true meant a workbook written once under the 1904 system kept
 * `date1904: true` on every date cell forever; writing it again after switching back to 1900 re-encoded every
 * date against the wrong epoch — 1,462 days out, silently, into a file that reopens cleanly because the
 * workbook part *had* switched.
 *
 * Deleted rather than set to `false` because the field is optional and absent means 1900. Writing the default
 * onto every date cell in every workbook would be noise in the model the caller can see.
 */
function setDate1904(model: { date1904?: boolean }, date1904: boolean): void {
  if (date1904) {
    model.date1904 = true;
  } else {
    delete model.date1904;
  }
}

class CellXform extends BaseXform {
  declare private richTextXform: RichTextXform;
  declare public parser: BaseXform | undefined;
  declare private t: string | undefined;
  declare private currentNode: string | undefined;

  constructor() {
    super();

    this.richTextXform = new RichTextXform();
  }

  get tag() {
    return "c";
  }

  prepare(model, options) {
    const styleId = options.styles.addStyleModel(model.style || {}, getEffectiveCellType(model));
    if (styleId) {
      model.styleId = styleId;
    }

    if (model.comment) {
      options.comments.push({ ...model.comment, ref: model.address });
    }

    switch (model.type) {
      case Enums.ValueType.String:
      case Enums.ValueType.RichText:
        if (options.sharedStrings) {
          model.ssId = options.sharedStrings.add(model.value);
        }
        break;

      case Enums.ValueType.Date:
        setDate1904(model, options.date1904 === true);
        break;

      case Enums.ValueType.Hyperlink:
        if (options.sharedStrings) {
          // Prefer rich-text payload when present so formatted display
          // survives a write. Fall back to plain text otherwise.
          if (Array.isArray(model.richText) && model.richText.length > 0) {
            model.ssId = options.sharedStrings.add({ richText: model.richText });
          } else if (model.text !== undefined && model.text !== null) {
            model.ssId = options.sharedStrings.add(model.text);
          }
        }
        options.hyperlinks.push({
          address: model.address,
          target: model.hyperlink,
          tooltip: model.tooltip
        });
        break;

      case Enums.ValueType.Merge:
        options.merges.add(model);
        break;

      case Enums.ValueType.Formula:
        // A cached formula result may be a date, so it needs the epoch for the same reason.
        setDate1904(model, options.date1904 === true);

        // Convert isDynamicArray flag to cm attribute for XML rendering.
        // All dynamic array cells share cm=1 pointing to a single XLDAPR metadata record.
        if (model.isDynamicArray) {
          model.cm = 1;
        }

        // A formula cell may also carry an attached hyperlink (e.g. when the
        // model came from another writer or was constructed without going
        // through the load-side reconcile that promotes type=Formula to
        // type=Hyperlink). Re-emit the <hyperlink> element so it survives.
        if (model.hyperlink) {
          options.hyperlinks.push({
            address: model.address,
            target: model.hyperlink,
            tooltip: model.tooltip
          });
        }

        if (model.shareType === "shared") {
          model.si = options.siFormulae++;
        }

        if (model.formula) {
          options.formulae[model.address] = model;
        } else if (model.sharedFormula) {
          const master = options.formulae[model.sharedFormula];
          if (!master) {
            throw new ExcelError(
              `Shared Formula master must exist above and or left of clone for cell ${model.address}`
            );
          }
          if (master.si === undefined) {
            master.shareType = "shared";
            master.si = options.siFormulae++;
            master.range = rangeCreate(master.address, model.address);
          } else if (master.range) {
            rangeExpandToAddress(master.range, model.address);
          }
          model.si = master.si;
        }
        break;

      default:
        break;
    }
  }

  renderFormula(xmlStream, model) {
    let attrs: XmlAttributes | null = null;
    switch (model.shareType) {
      case "shared":
        attrs = {
          t: "shared",
          ref: model.ref || rangeRange(model.range),
          si: model.si
        };
        break;

      case "array":
        attrs = {
          t: "array",
          ref: model.ref
        };
        break;

      default:
        if (model.si !== undefined) {
          attrs = {
            t: "shared",
            si: model.si
          };
        }
        break;
    }

    switch (getValueType(model.result)) {
      case Enums.ValueType.Null: // ?
        xmlStream.leafNode("f", attrs, model.formula);
        break;

      case Enums.ValueType.String:
        // oddly, formula results don't ever use shared strings
        xmlStream.addAttribute("t", "str");
        xmlStream.leafNode("f", attrs, model.formula);
        xmlStream.leafNode("v", null, model.result);
        break;

      case Enums.ValueType.Number:
        xmlStream.leafNode("f", attrs, model.formula);
        xmlStream.leafNode("v", null, model.result);
        break;

      case Enums.ValueType.Boolean:
        xmlStream.addAttribute("t", "b");
        xmlStream.leafNode("f", attrs, model.formula);
        xmlStream.leafNode("v", null, model.result ? 1 : 0);
        break;

      case Enums.ValueType.Error:
        xmlStream.addAttribute("t", "e");
        xmlStream.leafNode("f", attrs, model.formula);
        xmlStream.leafNode("v", null, model.result.error);
        break;

      case Enums.ValueType.Date:
        xmlStream.leafNode("f", attrs, model.formula);
        xmlStream.leafNode("v", null, dateToExcel(model.result, model.date1904));
        break;

      // case Enums.ValueType.Hyperlink: // ??
      // case Enums.ValueType.Formula:
      default:
        throw new InvalidValueTypeError(
          String(getValueType(model.result)),
          "Could not understand type of value"
        );
    }
  }

  render(xmlStream, model) {
    if (model.type === Enums.ValueType.Null && !model.styleId) {
      // if null and no style, exit
      return;
    }

    xmlStream.openNode("c");
    xmlStream.addAttribute("r", model.address);

    if (model.styleId) {
      xmlStream.addAttribute("s", model.styleId);
    }

    // Dynamic array formulas require the cm attribute linking to xl/metadata.xml
    if (model.cm) {
      xmlStream.addAttribute("cm", model.cm);
    }

    switch (model.type) {
      case Enums.ValueType.Null:
        break;

      case Enums.ValueType.Number:
        xmlStream.leafNode("v", null, model.value);
        break;

      case Enums.ValueType.Boolean:
        xmlStream.addAttribute("t", "b");
        xmlStream.leafNode("v", null, model.value ? "1" : "0");
        break;

      case Enums.ValueType.Checkbox:
        // Checkboxes are stored as boolean values
        xmlStream.addAttribute("t", "b");
        xmlStream.leafNode("v", null, model.value ? "1" : "0");
        break;

      case Enums.ValueType.Error:
        xmlStream.addAttribute("t", "e");
        xmlStream.leafNode("v", null, model.value.error);
        break;

      case Enums.ValueType.String:
      case Enums.ValueType.RichText:
        if (model.ssId !== undefined) {
          xmlStream.addAttribute("t", "s");
          xmlStream.leafNode("v", null, model.ssId);
        } else if (model.value && model.value.richText) {
          xmlStream.addAttribute("t", "inlineStr");
          xmlStream.openNode("is");
          model.value.richText.forEach(text => {
            this.richTextXform.render(xmlStream, text);
          });
          xmlStream.closeNode("is");
        } else {
          xmlStream.addAttribute("t", "str");
          xmlStream.leafNode("v", null, model.value);
        }
        break;

      case Enums.ValueType.Date:
        xmlStream.leafNode("v", null, dateToExcel(model.value, model.date1904));
        break;

      case Enums.ValueType.Hyperlink:
        // A hyperlink cell may also carry a formula (loaded from XLSX where
        // a `<hyperlink>` entry shares its address with a formula `<c>`).
        // Render the formula in that case so the underlying expression
        // survives the round-trip; the <hyperlink> element is emitted
        // separately via options.hyperlinks (collected in prepare).
        if (model.formula || model.sharedFormula) {
          this.renderFormula(xmlStream, model);
        } else if (model.ssId !== undefined) {
          xmlStream.addAttribute("t", "s");
          xmlStream.leafNode("v", null, model.ssId);
        } else if (Array.isArray(model.richText) && model.richText.length > 0) {
          // Inline rich-text representation — used when shared strings are
          // disabled (some streaming configurations).
          xmlStream.addAttribute("t", "inlineStr");
          xmlStream.openNode("is");
          model.richText.forEach(text => {
            this.richTextXform.render(xmlStream, text);
          });
          xmlStream.closeNode("is");
        } else {
          xmlStream.addAttribute("t", "str");
          xmlStream.leafNode("v", null, model.text);
        }
        break;

      case Enums.ValueType.Formula:
        this.renderFormula(xmlStream, model);
        break;

      case Enums.ValueType.Merge:
        // nothing to add
        break;

      default:
        break;
    }

    xmlStream.closeNode(); // </c>
  }

  parseOpen(node) {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "c":
        // const address = colCache.decodeAddress(node.attributes.r);
        this.model = {
          address: node.attributes.r
        };
        this.t = node.attributes.t;
        if (node.attributes.s) {
          this.model.styleId = parseInt(node.attributes.s, 10);
        }
        if (node.attributes.cm) {
          this.model.cm = parseInt(node.attributes.cm, 10);
        }
        return true;

      case "f":
        this.currentNode = "f";
        this.model.si = node.attributes.si;
        this.model.shareType = node.attributes.t;
        this.model.ref = node.attributes.ref;
        return true;

      case "v":
        this.currentNode = "v";
        return true;

      case "t":
        this.currentNode = "t";
        return true;

      case "r":
        this.parser = this.richTextXform;
        this.parser.parseOpen(node);
        return true;

      default:
        return false;
    }
  }

  parseText(text) {
    if (this.parser) {
      this.parser.parseText(text);
      return;
    }
    switch (this.currentNode) {
      case "f":
        this.model.formula = this.model.formula ? this.model.formula + text : text;
        break;
      case "v":
      case "t":
        if (this.model.value && this.model.value.richText) {
          this.model.value.richText.text = this.model.value.richText.text
            ? this.model.value.richText.text + text
            : text;
        } else {
          this.model.value = this.model.value ? this.model.value + text : text;
        }
        break;
      default:
        break;
    }
  }

  parseClose(name) {
    switch (name) {
      case "c": {
        const { model } = this;

        // first guess on cell type
        if (model.formula || model.shareType) {
          model.type = Enums.ValueType.Formula;
          if (model.value) {
            if (this.t === "str") {
              model.result = model.value;
            } else if (this.t === "b") {
              model.result = parseInt(model.value, 10) !== 0;
            } else if (this.t === "e") {
              model.result = { error: model.value };
            } else {
              model.result = parseFloat(model.value);
            }
            model.value = undefined;
          }
        } else if (model.value !== undefined) {
          switch (this.t) {
            case "s":
              model.type = Enums.ValueType.String;
              model.value = parseInt(model.value, 10);
              break;
            case "str":
              model.type = Enums.ValueType.String;
              // Value already decoded by SAX parser — no xmlDecode needed
              break;
            case "inlineStr":
              model.type = Enums.ValueType.String;
              // Decode OOXML _xHHHH_ escapes for plain text inline strings.
              // Rich text inline strings are already decoded via RichTextXform -> TextXform.
              if (typeof model.value === "string" && model.value.includes("_x")) {
                model.value = decodeOoxmlEscape(model.value);
              }
              break;
            case "b":
              model.type = Enums.ValueType.Boolean;
              model.value = parseInt(model.value, 10) !== 0;
              break;
            case "e":
              model.type = Enums.ValueType.Error;
              model.value = { error: model.value };
              break;
            case "d":
              // Strict OpenXML format stores dates as ISO strings with t="d"
              // See: https://www.loc.gov/preservation/digital/formats/fdd/fdd000401.shtml
              //
              // Through `parseOoxmlDate`, not `new Date(...)`. An OOXML datetime carries no timezone —
              // `2020-01-15T00:00:00` — and every JS engine reads an unsuffixed datetime as *local*, so this
              // branch produced a different instant in every timezone and read the date a day early anywhere
              // east of UTC. Every other read path in the library lands on UTC midnight; this one did not, so
              // the same workbook read back differently depending on which of two spellings of a date cell the
              // producer had chosen. `parseOoxmlDate` is the shared fix and already existed.
              model.type = Enums.ValueType.Date;
              model.value = parseOoxmlDate(model.value);
              break;
            default:
              model.type = Enums.ValueType.Number;
              model.value = parseFloat(model.value);
              break;
          }
        } else if (model.styleId) {
          model.type = Enums.ValueType.Null;
        } else {
          model.type = Enums.ValueType.Merge;
        }
        return false;
      }

      case "f":
      case "v":
      case "is":
        this.currentNode = undefined;
        return true;

      case "t":
        if (this.parser) {
          this.parser.parseClose(name);
          return true;
        }
        this.currentNode = undefined;
        return true;

      case "r":
        this.model.value = this.model.value || {};
        this.model.value.richText = this.model.value.richText ?? [];
        // `this.parser` is guaranteed by parseOpen("r"), which instantiates
        // a RichTextXform. A missing parser here means malformed XML that
        // should surface as a parse error rather than silently swallow.
        this.model.value.richText.push(this.parser!.model);
        this.parser = undefined;
        this.currentNode = undefined;
        return true;

      default:
        if (this.parser) {
          this.parser.parseClose(name);
          return true;
        }
        return false;
    }
  }

  reconcile(model, options) {
    const style =
      model.styleId !== undefined && options.styles && options.styles.getStyleModel(model.styleId);
    if (style) {
      model.style = style;
    }
    if (model.styleId !== undefined) {
      model.styleId = undefined;
    }

    switch (model.type) {
      case Enums.ValueType.String:
        if (typeof model.value === "number") {
          // A numeric value on a String-typed cell is a sharedStrings index
          // (originated from t="s" in parseClose).
          //
          // Two malformed-file cases to consider:
          //   1. sharedStrings table missing entirely — degrade gracefully
          //      (consistent with the "missing-bits.xlsx" graceful-loading
          //      contract); leave value as the raw index so worksheets still
          //      load.
          //   2. sharedStrings table present but the specific index is out of
          //      range — this is the case that previously crashed with
          //      `TypeError: cannot access property "richText"`. Fail loudly
          //      with a typed ExcelError so callers get file-corruption
          //      context.
          if (options.sharedStrings) {
            const ssIndex = model.value;
            model.value = options.sharedStrings.getString(ssIndex);
            if (model.value === undefined) {
              throw new ExcelError(
                `Invalid shared string index ${ssIndex} in cell ${model.address}: the xlsx file appears to be corrupted`
              );
            }
          }
        }
        if (model.value && model.value.richText) {
          model.type = Enums.ValueType.RichText;
        }
        break;

      case Enums.ValueType.Number:
        if (style && isDateFmt(style.numFmt)) {
          model.type = Enums.ValueType.Date;
          model.value = excelToDate(model.value, options.date1904);
        }
        break;

      case Enums.ValueType.Formula:
        // Only convert formula result to date if the result is a number
        // String results (t="str") should not be converted even if the cell has a date format
        if (
          model.result !== undefined &&
          typeof model.result === "number" &&
          style &&
          isDateFmt(style.numFmt)
        ) {
          model.result = excelToDate(model.result, options.date1904);
        }
        if (model.shareType === "shared") {
          if (model.ref) {
            // master
            options.formulae[model.si] = model.address;
          } else {
            // slave
            model.sharedFormula = options.formulae[model.si];
            delete model.shareType;
          }
          delete model.si;
        }
        // Convert cm metadata index into isDynamicArray flag.
        // The cm attribute (1-indexed) links to a cellMetadata record in
        // xl/metadata.xml. We use the precise dynamicArrayCmIndices set
        // (built by MetadataXform) to check whether this specific cm value
        // maps to an XLDAPR metadataType. Falls back to the coarser
        // hasDynamicArrayMetadata boolean for backwards compatibility.
        // We strip cm from the model — it will be reassigned during write prepare.
        if (model.cm) {
          if (options.dynamicArrayCmIndices) {
            if (options.dynamicArrayCmIndices.has(model.cm)) {
              model.isDynamicArray = true;
            }
          } else if (options.hasDynamicArrayMetadata) {
            model.isDynamicArray = true;
          }
        }
        delete model.cm;
        break;

      default:
        break;
    }

    // look for hyperlink
    const hyperlink = options.hyperlinkMap[model.address];
    if (hyperlink) {
      // CellHyperlinkValue.text is typed as string; if the shared-string
      // resolution produced a rich-text payload ({ richText: [...] }) we must
      // flatten it for `text` AND preserve the runs on `richText` so formatted
      // display survives round-trip.
      let source: unknown;
      if (model.type === Enums.ValueType.Formula) {
        // Formula + hyperlink: surface as a Hyperlink cell whose display is
        // the formula's evaluated result, but keep `model.formula` (and the
        // original result) on the model so write-time can re-emit both the
        // formula <c> and the <hyperlink> entry. The cell value layer ignores
        // unknown model fields, so the public Hyperlink shape stays clean
        // while round-trip data is preserved internally.
        source = model.result;
      } else {
        source = model.value;
        model.value = undefined;
      }
      const display = extractHyperlinkDisplay(source);
      model.text = display.text;
      if (display.richText) {
        model.richText = display.richText;
      } else {
        delete model.richText;
      }
      model.type = Enums.ValueType.Hyperlink;
      model.hyperlink = hyperlink;
    }

    const comment = options.commentsMap && options.commentsMap[model.address];
    if (comment) {
      model.comment = comment;
    }
  }
}

export { CellXform };
