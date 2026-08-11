/**
 * `Image` namespace surface.
 *
 * `Image.add(wb, payload)` registers media in the workbook → imageId;
 * `Image.place(ws, imageId, range)` anchors it on a sheet;
 * `Image.setBackground(ws, imageId)` sets a sheet background;
 * `Image.list(ws)` lists a sheet's images.
 */
export { addWorkbookImage as add } from "@excel/core/workbook-core";
export {
  addImage as place,
  getImages as list,
  addBackgroundImage as setBackground,
  getBackgroundImageId as getBackground,
  addShape,
  getShapes
} from "@excel/core/worksheet";
export {
  imageCreate as create,
  imageModel as model,
  imageClone as clone,
  applyImageModel as applyModel
} from "@excel/core/image";

/** An image handle. */
export type { WorksheetImage as Handle } from "@excel/core/image";
