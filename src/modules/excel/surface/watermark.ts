/**
 * `Watermark` namespace surface — worksheet background watermark.
 *
 * `import { Watermark } from "documonster/excel"` →
 *   `Watermark.add(ws, opts)`, `Watermark.get(ws)`, `Watermark.remove(ws)`.
 *
 * This is a single-value convenience API. `mode: "overlay"` is its primary use
 * case; for `mode: "header"` prefer the `HeaderFooterImage` namespace, which
 * addresses Excel's six header/footer sections independently and can manage
 * images loaded from an existing workbook.
 */
export {
  addWatermark as add,
  getWatermark as get,
  removeWatermark as remove
} from "@excel/core/worksheet";
