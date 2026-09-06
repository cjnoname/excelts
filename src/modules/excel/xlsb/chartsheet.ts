/**
 * Chartsheets: the `xl/chartsheets/sheetN.bin` part.
 *
 * A chartsheet holds a chart and no cell grid, which is why it is a different part *type* from a
 * worksheet rather than a worksheet with one anchor. Its record stream is short — ten records — and every
 * one of them was read out of `cal-any_sheets.xlsb`, the one corpus workbook that carries one:
 *
 * ```text
 * BrtBeginSheet
 * BrtCsProp          34 bytes: a flag word, a BrtColor tab colour, a code name
 * BrtBeginCsViews
 *   BrtBeginCsView   10 bytes: flags, wScale, iwbkview
 *   BrtEndCsView
 * BrtEndCsViews
 * BrtCsProtection    10 bytes, all zero in that workbook
 * BrtMargins         48
 * BrtDrawing         the relationship id of the chart's drawing
 * BrtEndSheet
 * ```
 *
 * The reading is confirmed by the bytes rather than by the field list alone: that workbook's
 * `BrtBeginCsView` is `02 00 | 58 00 00 00 | 00 00 00 00` — a zoom of 88 and workbook view 0 — and
 * `2 + 4 + 4 = 10` is its length.
 *
 * **The chart parts are XML and shared with XLSX.** `cal-any_sheets.xlsb` holds `xl/charts/chart1.xml`
 * beside its `.bin` chartsheet, so only the *sheet* needs BIFF12. That is why this became tractable once
 * charts were: the chart itself, its drawing and the drawing's relationships all come from the XLSX
 * writer unchanged.
 */
import type { Margins } from "@excel/types";
import { encodeBiffRecords, encodeNullableWideString } from "@excel/xlsb/binary";
import { encodeColor } from "@excel/xlsb/color";
import { encodeDrawing, readDrawing } from "@excel/xlsb/drawing";
import { encodeMargins } from "@excel/xlsb/page-setup";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** A chartsheet, in the shape the model holds it. */
export interface SheetChartsheet {
  readonly name: string;
  /** Relationship id of the drawing that carries the chart. */
  readonly drawingRelationshipId?: string;
  /** Window zoom, 10–400, or absent for Excel's own. */
  readonly zoomScale?: number;
  readonly selected?: boolean;
  readonly codeName?: string;
  /**
   * Scale the chart to fill the window — `<sheetView zoomToFit="1"/>` in XLSX.
   *
   * **The one chartsheet property whose absence is visible.** A chartsheet has no cell grid, so this is how Excel is
   * told how big to draw the chart; without it the view falls back to `zoomScale`, which this writer left at 0 ("no zoom
   * set"). `financial-report`'s "Board View" tab came out blank in XLSB while the same workbook's XLSX rendered it,
   * and this is the only view property that differed.
   */
  readonly zoomToFit?: boolean;
  /** Print margins. A chartsheet has its own, and they were being replaced by defaults. */
  readonly pageMargins?: Partial<Margins>;
}

/** Serialise a whole `xl/chartsheets/sheetN.bin`. */
export function encodeChartsheetPart(chartsheet: SheetChartsheet): Uint8Array {
  const records: Emitted[] = [
    record("BrtBeginSheet"),
    record("BrtCsProp", encodeChartsheetProperties(chartsheet)),
    record("BrtBeginCsViews"),
    record("BrtBeginCsView", encodeChartsheetView(chartsheet)),
    record("BrtEndCsView"),
    record("BrtEndCsViews"),
    // Ten zero bytes in the corpus workbook: a chartsheet that protects nothing. Written because the
    // part's grammar has it, not because there is anything to say.
    record("BrtCsProtection", new Uint8Array(10)),
    // **The model's margins, which used to be discarded.** `encodeMargins(undefined)` writes Excel's defaults, so a
    // chartsheet with `pageMargins: 0.5` on every side came out at 0.7/0.75 — measured against the same workbook's
    // XLSX, which writes `<pageMargins left="0.5" …/>`. Same encoder the worksheet path uses, so the layout is the
    // established one.
    record("BrtMargins", encodeMargins(chartsheet.pageMargins))
  ];
  if (chartsheet.drawingRelationshipId !== undefined) {
    // Without this the chartsheet is a blank tab: the chart lives in a drawing, and this record is the
    // only thing connecting the two.
    records.push(record("BrtDrawing", encodeDrawing(chartsheet.drawingRelationshipId)));
  }
  records.push(record("BrtEndSheet"));
  return encodeBiffRecords(records);
}

/** `BrtCsProp`: a flag word, a tab colour, then a code name. */
function encodeChartsheetProperties(chartsheet: SheetChartsheet): Uint8Array {
  return concatUint8Arrays([
    // `fPublish` at bit 0. The remaining fifteen bits are `unused` and MUST be ignored, so they stay 0.
    new BinaryWriter().writeUint16(0).toUint8Array(),
    // No tab colour. `encodeColor(undefined)` writes the *automatic* colour, which is right here — unlike
    // a border, where "no line" means the whole `Blxf` is zeros.
    encodeColor(undefined),
    // **An empty string, not NULL, when the sheet has no code name.** Excel's re-save of this library's own
    // `financial-report.xlsb` writes `00 00 00 00` here where this wrote `ff ff ff ff`. That is the same
    // distinction `BrtBeginList`'s `stComment` turned on earlier in this module: a `XLNullableWideString` has
    // both forms and they are not interchangeable, and Excel reserves NULL for a different circumstance.
    chartsheet.codeName === undefined
      ? new BinaryWriter().writeUint32(0).toUint8Array()
      : encodeNullableWideString(chartsheet.codeName)
  ]);
}

/** `BrtBeginCsView`: ten bytes. */
function encodeChartsheetView(chartsheet: SheetChartsheet): Uint8Array {
  return (
    new BinaryWriter()
      // `fSelected` at bit 0, `fZoomToFit` at bit 1.
      //
      // **Bit 1 was described here as "an undefined bit the specification says to ignore", on one sample.** Three things
      // now line up on it, and they are about the same content rather than about a bit in isolation: the model carries
      // `zoomToFit: true` for `financial-report`'s chartsheet, this library's own XLSX writes `zoomToFit="1"` for it, and
      // Excel's re-save of the *XLSB* has bit 1 set. `cal-any_sheets.xlsb` corroborates that Excel sets it on a
      // chartsheet of its own. A named attribute on one side of a conversion matching a bit on the other is a different
      // quality of evidence from a bit that merely occurs.
      //
      // It is also the property whose absence was visible: the tab rendered blank, because a chartsheet has no grid and
      // nothing else told Excel how large to draw the chart.
      .writeUint16(
        (chartsheet.selected === true ? 0x01 : 0) | (chartsheet.zoomToFit === true ? 0x02 : 0)
      )
      // A `u32` here, unlike `BrtBeginWsView` where the zoom is a `u16`. Bounded at 10–400, or 0 for "no
      // zoom set" — a legal value, and the one to use when the model says nothing.
      .writeUint32(clampZoom(chartsheet.zoomScale))
      .writeUint32(0) // iwbkview
      .toUint8Array()
  );
}

/** Read a chartsheet part back into the model's shape. */
export function readChartsheetPart(
  bytes: Uint8Array,
  part: string,
  records: (bytes: Uint8Array, part: string) => Iterable<{ id: number; payload: Uint8Array }>,
  nameOf: (id: number) => string | undefined
): Omit<SheetChartsheet, "name"> {
  let zoomScale: number | undefined;
  let selected: boolean | undefined;
  let zoomToFit: boolean | undefined;
  let drawingRelationshipId: string | undefined;
  for (const entry of records(bytes, part)) {
    const name = nameOf(entry.id);
    if (name === "BrtBeginCsView") {
      try {
        const reader = new BinaryReader(entry.payload, 0, part);
        const flags = reader.readUint16();
        const zoom = reader.readUint32();
        if (zoom !== 0 && zoom !== 100) {
          zoomScale = zoom;
        }
        if ((flags & 0x01) !== 0) {
          selected = true;
        }
        // Bit 1, decoded so this reader stays the writer's inverse. Note what this does *not* fix: the XLSB package
        // reader keeps a chartsheet as an opaque part and a placeholder worksheet rather than calling this function
        // (see `read/package.ts`), so an XLSB → XLSX conversion does not currently reach here. Kept symmetric anyway —
        // a decoder that silently drops a bit its encoder writes is how the writer's own gap survived unnoticed.
        if ((flags & 0x02) !== 0) {
          zoomToFit = true;
        }
      } catch {
        // A truncated view costs the zoom, not the sheet.
      }
      continue;
    }
    if (name === "BrtDrawing") {
      drawingRelationshipId = readDrawing(entry.payload, part);
    }
  }
  return {
    ...(zoomScale === undefined ? {} : { zoomScale }),
    ...(selected === undefined ? {} : { selected }),
    ...(zoomToFit === undefined ? {} : { zoomToFit }),
    ...(drawingRelationshipId === undefined ? {} : { drawingRelationshipId })
  };
}

function clampZoom(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    // 0 is the record's own "no zoom level set", which is what a model that says nothing means.
    return 0;
  }
  return Math.max(10, Math.min(400, Math.trunc(value)));
}
