/**
 * ChartsheetXform — parse and render OOXML chartsheet XML.
 *
 * A chartsheet is a simple sheet type that contains only a chart.
 * Structure (ECMA-376 `CT_Chartsheet`):
 * ```xml
 * <chartsheet xmlns="...">
 *   <sheetPr/>?
 *   <sheetViews><sheetView .../></sheetViews>
 *   <sheetProtection/>?
 *   <customSheetViews/>?
 *   <pageMargins .../>?
 *   <pageSetup .../>?        CT_CsPageSetup — NOT CT_PageSetup
 *   <headerFooter/>?
 *   <drawing r:id="rId1"/>
 *   <legacyDrawing/>?  legacyDrawingHF?  drawingHF?  picture?  webPublishItems?  extLst?
 * </chartsheet>
 * ```
 *
 * Note that chartsheets do NOT support `printOptions`, `pageBreaks`,
 * `rowBreaks`, or `colBreaks` — those are worksheet-only elements
 * per ECMA-376 `CT_Chartsheet`. Likewise `<c:pageSetup>` on a
 * chartsheet is `CT_CsPageSetup`, which has a reduced attribute set
 * compared to the worksheet's `CT_PageSetup` (no `scale`,
 * `fitToWidth`, `fitToHeight`, `pageOrder`, `cellComments`, or
 * `errors`).
 */

import type { HeaderFooter } from "@excel/types";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { RelationshipModel } from "@excel/xlsx/xform/core/relationship-xform";
import { HeaderFooterXform } from "@excel/xlsx/xform/sheet/header-footer-xform";
import { parseXsdBoolean, parseXsdInt } from "@excel/xlsx/xform/xsd-values";
import { xmlEncode as escapeXml, xmlEncodeAttr } from "@xml/encode";
import type { ParseOpenTag, XmlSink } from "@xml/types";

export interface ChartsheetModel {
  /** Sheet number (positional index in the XLSX archive) */
  sheetNo: number;
  /** Sheet name (from workbook.xml) */
  name: string;
  /** Sheet ID (from workbook.xml) */
  id: number;
  /**
   * Tab order index — the 0-based position in the workbook's
   * `<sheets>` list, shared between worksheets and chartsheets so a
   * combined sort preserves the author's interleaved layout. Assigned
   * at add time (monotonic across both add paths) and at load time
   * (from the workbook.xml `<sheet>` ordinal).
   */
  orderNo?: number;
  /** Relationship ID linking to this chartsheet from workbook.xml.rels */
  rId?: string;
  /** Sheet visibility state */
  state?: "visible" | "hidden" | "veryHidden";
  /** Tab selected */
  tabSelected?: boolean;
  /** Zoom scale */
  zoomScale?: number;
  /**
   * `CT_ChartsheetViewBase/@workbookViewId` — 0-based index into the
   * workbook's `<bookViews>` list that this chartsheet view is bound
   * to. Defaults to 0 per OOXML schema; round-tripped verbatim so
   * multi-view workbooks don't get their view hierarchy rewritten.
   */
  workbookViewId?: number;
  /**
   * `CT_ChartsheetViewBase/@zoomToFit` — when true the chartsheet
   * scales its content to fill the window. Schema default is false;
   * captured/written only when explicitly set to preserve round-trip.
   */
  zoomToFit?: boolean;
  /** Page margins */
  pageMargins?: {
    l?: number;
    r?: number;
    t?: number;
    b?: number;
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    header?: number;
    footer?: number;
  };
  /**
   * Chartsheet page setup — `CT_CsPageSetup`.
   *
   * Note the attribute set differs from the worksheet `CT_PageSetup`:
   *   - **Supported**: paperSize, firstPageNumber, orientation,
   *     usePrinterDefaults, blackAndWhite, draft, useFirstPageNumber,
   *     horizontalDpi, verticalDpi, copies, paperHeight, paperWidth
   *   - **Not supported on chartsheets** (worksheet-only, will be
   *     silently ignored on write): scale, fitToWidth, fitToHeight,
   *     pageOrder, cellComments, errors
   */
  pageSetup?: {
    paperSize?: number;
    firstPageNumber?: number;
    orientation?: "default" | "portrait" | "landscape";
    usePrinterDefaults?: boolean;
    blackAndWhite?: boolean;
    draft?: boolean;
    useFirstPageNumber?: boolean;
    horizontalDpi?: number;
    verticalDpi?: number;
    copies?: number;
    /** Paper height in a unit-of-measure string (e.g. "11in", "297mm"). */
    paperHeight?: string;
    /** Paper width in a unit-of-measure string (e.g. "8.5in", "210mm"). */
    paperWidth?: string;
    /**
     * Relationship id referencing a `printerSettings` part. Preserved
     * verbatim through round-trip so an already-authored
     * `xl/printerSettings/…` rel target keeps its XML reference from
     * the chartsheet. Previously this attribute was dropped by the
     * parser and never emitted by the writer, leaving the printer-
     * settings part accessible via the chartsheet's `.rels` but
     * unreferenced from the chartsheet XML — a dangling-rel-reverse
     * that strict validators flag.
     */
    rId?: string;
  };
  /** Structured printable header/footer content. */
  headerFooter?: Partial<HeaderFooter>;
  /** VML drawing containing positioned header/footer images. */
  legacyDrawingHF?: { rId: string };
  /** Reconciled header/footer images for consumers such as PDF export. */
  headerImages?: Array<{
    imageId: number;
    width?: number;
    height?: number;
    position: "LH" | "CH" | "RH" | "LF" | "CF" | "RF";
  }>;
  /** Drawing relationship reference */
  drawing?: { rId: string };
  /** Relationships parsed from the chartsheet .rels file */
  relationships?: RelationshipModel[];
  /** Drawing part name without extension (e.g. drawing2) */
  drawingName?: string;
  /** Classic chart number displayed by this chartsheet */
  chartNumber?: number;
  /** ChartEx number displayed by this chartsheet */
  chartExNumber?: number;
  /**
   * Raw XML captured for elements the structured parser doesn't model
   * (`sheetPr`, `sheetProtection`, `customSheetViews`, `headerFooter`,
   * `legacyDrawing`, `legacyDrawingHF`, `drawingHF`, `picture`,
   * `webPublishItems`, `extLst`). The writer emits these verbatim at
   * the correct schema position so a round-trip through a workbook
   * that uses chartsheet-specific features (e.g. password-protected
   * chartsheets, printer-defined header/footer blocks) doesn't lose
   * them.
   *
   * Keys are the element local name (e.g. `"sheetPr"`); values are the
   * full `<tag …>…</tag>` serialised bytes.
   *
   * Note: `rowBreaks`, `colBreaks`, and `pageBreaks` are NOT captured —
   * per ECMA-376 `CT_Chartsheet` they are worksheet-only elements.
   * Similarly `printOptions` is worksheet-only. Legacy on-disk
   * chartsheets that erroneously contained them are silently
   * discarded on load to produce schema-valid output on save.
   */
  rawChildren?: Record<string, string>;
}

const CHARTSHEET_ATTRIBUTES = {
  xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
};

class ChartsheetXform extends BaseXform<ChartsheetModel> {
  private inSheetView = false;
  /**
   * Raw-capture state for elements the structured parser doesn't model.
   * When `parseOpen` sees one of the names in {@link RAW_CAPTURE_TAGS}
   * at depth-1 of `<chartsheet>`, it starts recording the full
   * serialised XML (open tags, text, nested children, close tags) into
   * `captureParts`. The recording ends when `parseClose` fires with
   * the matching root name; the assembled string is stored under
   * `model.rawChildren[rootName]` for verbatim re-emission by
   * {@link render}.
   *
   * Without this, elements like `<sheetProtection>` (password-protected
   * chartsheets) and `<headerFooter>` silently disappeared on
   * round-trip, breaking the author's layout / security configuration.
   *
   * `sheetDepth` tracks nesting depth inside `<chartsheet>`: the root
   * itself sits at depth 1, its direct children at depth 2. Capture
   * only ever starts at depth 2 so a nested element whose local name
   * happens to overlap with one in {@link RAW_CAPTURE_TAGS} (e.g. an
   * `<extLst>` inside `<customSheetViews>` as a leaf of that subtree)
   * stays part of the outer capture rather than being promoted to a
   * sibling root child.
   */
  private captureRoot: string | undefined;
  private captureDepth = 0;
  private captureParts: string[] = [];
  private skipNextCaptureClose = false;
  private sheetDepth = 0;
  private headerFooterXform = new HeaderFooterXform();

  get tag(): string {
    return "chartsheet";
  }

  render(xmlStream: XmlSink, model?: ChartsheetModel): void {
    const m = model ?? this.model;
    if (!m) {
      return;
    }

    xmlStream.openNode("chartsheet", CHARTSHEET_ATTRIBUTES);

    // `CT_Chartsheet` schema sequence:
    //   sheetPr?, sheetViews, sheetProtection?, customSheetViews?,
    //   pageMargins?, pageSetup?, headerFooter?,
    //   drawing, legacyDrawing?, legacyDrawingHF?, drawingHF?,
    //   picture?, webPublishItems?, extLst?
    //
    // Elements we don't structurally model (most of the tail) are
    // captured as raw XML via `rawChildren` and re-emitted at the
    // correct sequence position so round-tripping a chartsheet with
    // `sheetProtection` / `headerFooter` / `legacyDrawing` doesn't
    // drop them.
    //
    // Notably absent: `printOptions`, `pageBreaks`, `rowBreaks`,
    // `colBreaks` — all worksheet-only per ECMA-376 `CT_Chartsheet`.
    // Legacy workbooks that stored them in chartsheets are silently
    // stripped; Excel itself also ignores them at load time.
    const raw = m.rawChildren ?? {};
    const writeRaw = (name: string): void => {
      const xml = raw[name];
      if (xml) {
        xmlStream.writeRaw(xml);
      }
    };

    writeRaw("sheetPr");

    // sheetViews
    xmlStream.openNode("sheetViews");
    // Preserve the author's `workbookViewId` (0-based index into the
    // workbook's `<bookViews>` list). Default is 0 per schema; writing
    // 0 explicitly is harmless and matches the wire shape Excel emits.
    const svAttrs: Record<string, string> = {
      workbookViewId: String(m.workbookViewId ?? 0)
    };
    if (m.tabSelected) {
      svAttrs.tabSelected = "1";
    }
    if (m.zoomScale !== undefined) {
      svAttrs.zoomScale = String(m.zoomScale);
    }
    if (m.zoomToFit) {
      svAttrs.zoomToFit = "1";
    }
    xmlStream.leafNode("sheetView", svAttrs);
    xmlStream.closeNode();

    writeRaw("sheetProtection");
    writeRaw("customSheetViews");

    // pageMargins
    if (m.pageMargins) {
      const pm = m.pageMargins;
      xmlStream.leafNode("pageMargins", {
        left: pm.left !== undefined ? String(pm.left) : pm.l !== undefined ? String(pm.l) : "0.7",
        right:
          pm.right !== undefined ? String(pm.right) : pm.r !== undefined ? String(pm.r) : "0.7",
        top: pm.top !== undefined ? String(pm.top) : pm.t !== undefined ? String(pm.t) : "0.75",
        bottom:
          pm.bottom !== undefined ? String(pm.bottom) : pm.b !== undefined ? String(pm.b) : "0.75",
        header: pm.header !== undefined ? String(pm.header) : "0.3",
        footer: pm.footer !== undefined ? String(pm.footer) : "0.3"
      });
    }

    // pageSetup — note this is `CT_CsPageSetup`, NOT the worksheet's
    // `CT_PageSetup`. The attribute set is narrower: no `scale`,
    // `fitToWidth`, `fitToHeight`, `pageOrder`, `cellComments`, or
    // `errors`. `definedAttrs` emits only fields with defined values,
    // and the `ChartsheetModel["pageSetup"]` type constrains the
    // permitted field set at compile time.
    if (m.pageSetup) {
      // `rId` rides on this element as `r:id` (namespaced). Project
      // the model's camel-case `rId` onto the wire name and pass the
      // rest through `definedAttrs`. Previously the parser dropped
      // `r:id` entirely and the writer never emitted it, so printer-
      // settings rels preserved in the chartsheet .rels went
      // unreferenced inside the XML.
      const { rId, ...pageSetupAttrs } = m.pageSetup;
      const attrs = definedAttrs(pageSetupAttrs);
      if (rId !== undefined) {
        attrs["r:id"] = rId;
      }
      xmlStream.leafNode("pageSetup", attrs);
    }

    this.headerFooterXform.render(xmlStream, m.headerFooter);

    // drawing
    if (m.drawing) {
      xmlStream.leafNode("drawing", { "r:id": m.drawing.rId });
    }

    writeRaw("legacyDrawing");
    if (m.legacyDrawingHF) {
      xmlStream.leafNode("legacyDrawingHF", { "r:id": m.legacyDrawingHF.rId });
    }
    writeRaw("drawingHF");
    writeRaw("picture");
    writeRaw("webPublishItems");
    writeRaw("extLst");

    xmlStream.closeNode();
  }

  parseOpen(node: ParseOpenTag): boolean {
    const { name } = node;
    const attrs = node.attributes || {};
    const isSelfClosing = !!node.isSelfClosing;

    // If we're already inside a raw-captured element, serialise every
    // child / text node into the capture buffer regardless of name —
    // we don't want to structurally interpret children of, say,
    // `<sheetProtection>`. Honour `isSelfClosing` so the captured
    // bytes match the original encoding (self-closing `<foo/>` stays
    // `<foo/>`, not `<foo></foo>`).
    if (this.captureRoot) {
      if (isSelfClosing) {
        // Self-closing within a capture: append the `<foo/>` bytes
        // verbatim and instruct `parseClose` to skip the synthetic
        // close SAX will fire next. Depth stays where it was — a
        // self-close neither enters nor leaves a level.
        this.captureParts.push(selfCloseTag(node));
        this.skipNextCaptureClose = true;
      } else {
        this.captureDepth++;
        this.captureParts.push(openTag(node));
      }
      return true;
    }

    // Track depth from the `<chartsheet>` root so the raw-capture
    // dispatch only fires for direct children. Without this guard a
    // nested `<extLst>` (or any other RAW_CAPTURE_TAG name reused
    // inside a container we don't structurally model) would be
    // promoted to a sibling of `<chartsheet>` — clobbering whichever
    // capture was meant to contain it.
    if (name === "chartsheet") {
      this.sheetDepth = 1;
      this.model = {
        sheetNo: 0,
        name: "",
        id: 0
      };
      this.headerFooterXform.reset();
      return true;
    }
    this.sheetDepth += 1;

    if (name === "headerFooter" || this.headerFooterXform.model) {
      this.headerFooterXform.parseOpen(node);
      return true;
    }

    // Start a fresh capture for any DIRECT chartsheet child that we
    // don't structurally model. `sheetDepth === 2` means we're one
    // level below the `<chartsheet>` root.
    if (this.sheetDepth === 2 && RAW_CAPTURE_TAGS.has(name)) {
      if (isSelfClosing) {
        // Empty placeholder (e.g. `<extLst/>`) — store its bytes
        // verbatim and don't enter the multi-event capture loop.
        // The matching `parseClose` must also decrement
        // `sheetDepth`, so we flag to skip stateful close work.
        (this.model!.rawChildren ??= {})[name] = selfCloseTag(node);
        // No capture state to clear; `parseClose` handles the
        // close via its fall-through and decrements `sheetDepth`.
        return true;
      }
      this.captureRoot = name;
      this.captureDepth = 1;
      this.captureParts = [openTag(node)];
      return true;
    }

    switch (name) {
      case "sheetView":
        this.inSheetView = true;
        if (this.model) {
          // Use the shared `xsd:boolean` parser — previously this
          // switch only accepted `"1"` and silently mapped `"true"`
          // (the other spec-legal form, emitted by many third-party
          // writers) to `false`, so chartsheets authored elsewhere
          // lost their `tabSelected` / `zoomToFit` state on round-trip.
          const parsedTabSelected = parseXsdBoolean(attrs.tabSelected);
          if (parsedTabSelected !== undefined) {
            this.model.tabSelected = parsedTabSelected;
          }
          const parsedZoom = parseXsdInt(attrs.zoomScale);
          if (parsedZoom !== undefined) {
            this.model.zoomScale = parsedZoom;
          }
          // Round-trip `workbookViewId` — default 0 is only omitted
          // when the attribute was absent on the wire; preserve an
          // explicit 0 if the author wrote it, else leave undefined
          // so `render` falls back to its `?? 0` default.
          const parsedViewId = parseXsdInt(attrs.workbookViewId);
          if (parsedViewId !== undefined) {
            this.model.workbookViewId = parsedViewId;
          }
          const parsedZoomToFit = parseXsdBoolean(attrs.zoomToFit);
          if (parsedZoomToFit !== undefined) {
            this.model.zoomToFit = parsedZoomToFit;
          }
        }
        break;
      case "pageMargins":
        if (this.model) {
          this.model.pageMargins = {
            l: parseMargin(attrs.left),
            r: parseMargin(attrs.right),
            t: parseMargin(attrs.top),
            b: parseMargin(attrs.bottom),
            left: parseMargin(attrs.left),
            right: parseMargin(attrs.right),
            top: parseMargin(attrs.top),
            bottom: parseMargin(attrs.bottom),
            header: parseMargin(attrs.header),
            footer: parseMargin(attrs.footer)
          };
        }
        break;
      case "printOptions":
        // Worksheet-only element per ECMA-376 `CT_Chartsheet`.
        // Silently skip — the containing file is malformed but Excel
        // itself ignores the element at load, so preserving it in
        // `rawChildren` would re-emit invalid XML on save.
        break;
      case "rowBreaks":
      case "colBreaks":
      case "pageBreaks":
        // Same as `printOptions`: worksheet-only. Drop on load.
        break;
      case "pageSetup":
        if (this.model) {
          // `CT_CsPageSetup` — the chartsheet variant. Only the
          // attributes listed in ECMA-376 18.3.1.68 are captured;
          // worksheet-only attributes (`scale`, `fitToWidth`,
          // `fitToHeight`, `pageOrder`, `cellComments`, `errors`)
          // are silently discarded so re-serialised XML matches
          // `CT_CsPageSetup`.
          this.model.pageSetup = {
            paperSize: parseNumber(attrs.paperSize),
            firstPageNumber: parseNumber(attrs.firstPageNumber),
            orientation: attrs.orientation as "default" | "landscape" | "portrait" | undefined,
            usePrinterDefaults: parseBool(attrs.usePrinterDefaults),
            blackAndWhite: parseBool(attrs.blackAndWhite),
            draft: parseBool(attrs.draft),
            useFirstPageNumber: parseBool(attrs.useFirstPageNumber),
            horizontalDpi: parseNumber(attrs.horizontalDpi),
            verticalDpi: parseNumber(attrs.verticalDpi),
            copies: parseNumber(attrs.copies),
            paperHeight: attrs.paperHeight,
            paperWidth: attrs.paperWidth,
            // Capture the printer-settings rel id so the writer can
            // emit `r:id="…"` back on round-trip. Without this the
            // pre-existing `printerSettings` rel target in the
            // chartsheet .rels file was preserved (via
            // `relationships`) but the XML lost its reference to it —
            // a dangling rel in the saved package.
            rId: attrs["r:id"]
          };
        }
        break;
      case "drawing":
        if (this.model && attrs["r:id"]) {
          this.model.drawing = { rId: attrs["r:id"] };
        }
        break;
      case "legacyDrawingHF":
        if (this.model && attrs["r:id"]) {
          this.model.legacyDrawingHF = { rId: attrs["r:id"] };
        }
        break;
      default:
        break;
    }
    // Self-closing leaf at direct-child level: SAX fires a closetag
    // next which would decrement `sheetDepth` — so we do nothing
    // extra here. The increment above already covered the "open"
    // half of the event; the close will balance it.
    if (isSelfClosing) {
      // Balance the increment we just did so `parseClose` sees the
      // expected post-state (the SAX emitter will still fire a
      // `closetag` but our `parseClose` is a no-op for these names).
      // Equivalent: leave `sheetDepth` incremented and let the
      // subsequent `closetag` decrement it. We choose the latter for
      // consistency with non-self-closing paths.
    }
    return true;
  }

  parseText(text: string): void {
    if (this.headerFooterXform.model) {
      this.headerFooterXform.parseText(text);
      return;
    }
    // Pass text content through to the raw-capture buffer when we're
    // recording an unmodeled element. Top-level chartsheet children
    // have no meaningful text content (everything is element-based),
    // so we ignore text outside capture mode.
    if (this.captureRoot && text) {
      this.captureParts.push(escapeXml(text));
    }
  }

  parseClose(name: string): boolean {
    if (this.headerFooterXform.model) {
      if (name === "headerFooter") {
        this.model!.headerFooter = this.headerFooterXform.model;
        this.headerFooterXform.reset();
      } else {
        this.headerFooterXform.parseClose();
      }
      this.sheetDepth -= 1;
      return true;
    }
    // Close-tag inside an active capture — pop depth and decide
    // whether the capture ends here.
    if (this.captureRoot) {
      if (this.skipNextCaptureClose) {
        // This close is the synthetic half of a self-closing tag we
        // already wrote as `<foo/>`. Swallow it without touching
        // `captureDepth`.
        this.skipNextCaptureClose = false;
        return true;
      }
      this.captureDepth--;
      this.captureParts.push(`</${name}>`);
      if (this.captureDepth === 0) {
        // Capture complete — store the serialised XML and reset state.
        if (this.model) {
          (this.model.rawChildren ??= {})[this.captureRoot] = this.captureParts.join("");
        }
        this.captureRoot = undefined;
        this.captureParts = [];
        this.sheetDepth -= 1;
      }
      return true;
    }
    this.sheetDepth -= 1;
    switch (name) {
      case "chartsheet":
        return false;
      case "sheetView":
        this.inSheetView = false;
        return true;
      default:
        return true;
    }
  }
}

/**
 * Chartsheet children we don't structurally model but preserve as raw
 * XML bytes for round-trip. Adding a new structured path for one of
 * these elements means (a) remove it from this set and (b) add the
 * matching `parseOpen` case + `render` emission.
 *
 * Note: `rowBreaks`, `colBreaks`, `pageBreaks`, and `printOptions`
 * are NOT in this set — they are worksheet-only elements per
 * ECMA-376 `CT_Chartsheet`. A legacy file that has them is silently
 * dropped on load to produce schema-valid output.
 */
const RAW_CAPTURE_TAGS: ReadonlySet<string> = new Set([
  "sheetPr",
  "sheetProtection",
  "customSheetViews",
  "legacyDrawing",
  "drawingHF",
  "picture",
  "webPublishItems",
  "extLst"
]);

/**
 * Build the opening `<tag attr="…" …>` string for a SAX event. Shared
 * with the chart-space xform's `RawXmlCapture` but inlined here to
 * keep the chartsheet module self-contained (chart-space depends on
 * this module's exports, so we can't reach into it without a cycle).
 */
function openTag(node: { name: string; attributes?: Record<string, unknown> }): string {
  let s = `<${node.name}`;
  if (node.attributes) {
    for (const [k, v] of Object.entries(node.attributes)) {
      s += ` ${k}="${xmlEncodeAttr(String(v))}"`;
    }
  }
  return `${s}>`;
}

/**
 * Build a self-closing `<tag attr="…"/>` string. Used when the SAX
 * parser reports `isSelfClosing === true` so the captured bytes match
 * the original form — emitting `<tag></tag>` instead breaks
 * byte-for-byte round-trip and can confuse diff tools comparing the
 * reserialised package against the original.
 */
function selfCloseTag(node: { name: string; attributes?: Record<string, unknown> }): string {
  let s = `<${node.name}`;
  if (node.attributes) {
    for (const [k, v] of Object.entries(node.attributes)) {
      s += ` ${k}="${xmlEncodeAttr(String(v))}"`;
    }
  }
  return `${s}/>`;
}

function definedAttrs(
  model: Record<string, string | number | boolean | undefined>
): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(model)) {
    if (value !== undefined) {
      attrs[key] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    }
  }
  return attrs;
}

function parseBool(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "1" || value === "true";
}

function parseMargin(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export { ChartsheetXform };
