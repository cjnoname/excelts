/**
 * How a write refuses content it cannot carry — one function, for both containers.
 *
 * **A leaf on purpose.** This used to live in `core/workbook-format.ts`, which statically imports the XLSB writer; the
 * XLSX writer needed the same refusal and importing it from there would have closed a cycle (`xlsx` → `workbook-format`
 * → `xlsb/write/package` → `xlsx`). Splitting the one function out is cheaper than either duplicating it or restructuring
 * two writers, and it depends on nothing but the error class.
 *
 * **Why it has to be shared at all.** `WorkbookWriteOptions.unsupported` is declared for both formats, and until this
 * existed only the XLSB writer consulted it — so `{ format: "xlsx", unsupported: "error" }` was a guarantee that could
 * never fire. Two implementations of the refusal would have been free to differ about the default (`"error"`), about the
 * wording, and about whether an empty list is a refusal.
 */
import { ExcelNotSupportedError } from "@excel/errors";

/**
 * The shared refusal, so the two entry points cannot disagree about what a loss is.
 *
 * Was inline in `writeXlsbBytes`, and the streamed entry point would have needed a copy — which is how the two
 * would have come to word the same message differently, or to apply the default differently.
 */
export function refuseUnsupported(
  unsupported: readonly string[],
  options: { readonly unsupported?: "error" | "ignore" } | undefined,
  /**
   * Which writer is refusing, for the error's `operation`.
   *
   * Named rather than fixed at `"Write XLSB"`, because the XLSX writer refuses through this too now — it has exactly one
   * loss of its own (a preserved sheet part from the other container) and the option governing it used to be inert.
   */
  container: "XLSB" | "XLSX" = "XLSB"
): void {
  if (unsupported.length === 0 || (options?.unsupported ?? "error") !== "error") {
    return;
  }
  throw new ExcelNotSupportedError(
    `Write ${container}`,
    // Deliberately not "cell(s) … written as blanks": the report covers sheet features and defined
    // names as well, and what happens to each differs — an unsupported cell becomes a blank, a
    // dropped sheet feature simply does not appear, and a formula whose cached result cannot be
    // expressed keeps its formula. Naming one outcome for all of them was accurate only while cells
    // were all this could report.
    `${unsupported.length} item(s) carry content this writer cannot express: ` +
      `${unsupported.slice(0, 10).join(", ")}` +
      `${unsupported.length > 10 ? ", …" : ""}. ` +
      `Pass { unsupported: "ignore" } to write the workbook without them.`,
    { items: unsupported }
  );
}
