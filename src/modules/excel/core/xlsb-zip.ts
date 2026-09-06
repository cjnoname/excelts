/**
 * The streaming zip a binary package is written into.
 *
 * A one-line factory in a file of its own, and the reason is a layer rule rather than tidiness: the adapter
 * lives in `xlsx.browser.ts`, and `core/xlsb-stream.ts` must not import the XLSX module — it describes the zip
 * structurally so that it does not. Something has to bridge the two, and doing it here keeps that import in one
 * place instead of at every call site.
 *
 * The adapter itself is shared on purpose. A ZIP is a ZIP; the streamed XLSX path and the streamed XLSB path
 * have the same backpressure, the same entry lifecycle and the same finalisation, and a second implementation
 * would be a second set of those to get wrong.
 */
import type { StreamingZipDriver } from "@excel/core/xlsb-stream";

/**
 * A streaming zip writer, from the adapter the XLSX path already uses.
 *
 * Imported dynamically for the same reason every other cross-module reach in `core/` is: the XLSX module is
 * large and a binary-only caller should not pull it in until it actually writes something.
 */
export async function createXlsbZipWriter(): Promise<StreamingZipDriver> {
  // The module's own factory rather than the adapter class, which is deliberately not exported.
  const { createZipWriterAdapter } = await import("@excel/xlsx/xlsx.browser");
  return createZipWriterAdapter() as unknown as StreamingZipDriver;
}
