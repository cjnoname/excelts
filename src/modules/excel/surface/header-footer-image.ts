/**
 * `HeaderFooterImage` namespace surface — Excel's six printable
 * header/footer image sections.
 *
 * `import { HeaderFooterImage } from "documonster/excel"` →
 *   `HeaderFooterImage.set(ws, opts)`, `HeaderFooterImage.list(ws)`,
 *   `HeaderFooterImage.remove(ws, "CH")`.
 *
 * Use this namespace when a worksheet needs per-section control (including
 * images loaded from an existing workbook). `Watermark` remains the
 * single-value convenience API for the common "one centred header image"
 * case.
 */
export {
  setHeaderFooterImage as set,
  getHeaderFooterImages as list,
  removeHeaderFooterImage as remove
} from "@excel/core/worksheet";

export type {
  HeaderFooterImageEntry as Entry,
  HeaderFooterImageOptions as Options
} from "@excel/core/worksheet";
export type { HeaderFooterImagePosition as Position } from "@excel/types";
