/**
 * Write one workbook to **both** containers from a single call.
 *
 * Every example here used to end with `Workbook.writeFile(wb, filename)` and produce one `.xlsx`. That made the
 * binary container invisible: a feature could work in the XML form and be silently dropped, mis-encoded or
 * unreadable in the binary one, and no example would notice. Several were — a table nothing pointed at, a
 * sparkline with no colour, four print options that never reached the file.
 *
 * So the write is shared rather than the workbook. Each example still builds exactly what it is about, and this
 * turns the result into two files and one line saying whether the two agree.
 *
 * ## Why `unsupported: "ignore"`
 *
 * A refusal would abort the example, and the refusal is the interesting part. What the writer could not express
 * is printed instead, per container — which is how an example reports an honest limitation rather than either
 * hiding it or dying of it.
 */
import fs from "node:fs";
import path from "node:path";

import { calculateFormulas } from "@excel/bridge/formula";
import { Workbook } from "@excel/index";

/** The path for `format`, derived from a path that names another. */
function pathFor(file: string, format: "xlsx" | "xlsb"): string {
  const extension = path.extname(file);
  return extension === "" ? `${file}.${format}` : `${file.slice(0, -extension.length)}.${format}`;
}

/**
 * What `format` cannot express, as the writer itself reports it.
 *
 * **There is no callback for this, and this helper used to pretend there was.** It passed
 * `onUnsupported: note => dropped.push(note)` — an option no writer here accepts — and silenced the
 * resulting type error with `as never`. The callback was therefore never invoked, `dropped` was always
 * empty, and **every example printed a line saying it had lost nothing** while `formulas.xlsx` alone was
 * losing 33 items. The helper written to make losses visible was hiding them, and the cast is what let it.
 *
 * The real reporting channel is the refusal: `unsupported: "error"` is the default and throws an
 * `ExcelNotSupportedError` carrying `items`. So the report is obtained by *asking for* the refusal and
 * reading it, then writing again with `"ignore"`. That serialises twice, which is a real cost and the
 * reason to state it: for an example it is fractions of a second, and the alternative is a number nobody
 * can trust. A caller who needs both in one pass wants a public API that returns the list without
 * throwing, which does not exist yet — noted here rather than faked again.
 */
async function unsupportedItems(
  workbook: Workbook.Handle,
  format: "xlsx" | "xlsb"
): Promise<readonly string[]> {
  try {
    await Workbook.toBuffer(workbook, { format, unsupported: "error" });
    return [];
  } catch (cause) {
    const items = (cause as { items?: readonly string[] }).items;
    // A refusal without `items` is a different failure — a genuine write error — and must not be reported
    // as "nothing was dropped".
    if (items === undefined) {
      throw cause;
    }
    return items;
  }
}

/**
 * Write `workbook` as both `.xlsx` and `.xlsb`, next to each other.
 *
 * `file` may name either container or carry no extension — the extension is replaced, so an example that already
 * accepts `process.argv[2]` keeps working whatever the caller passes.
 *
 * Prints one line per container, with the byte count and anything the writer had to drop. Returns the two paths
 * for an example that wants to say more about them.
 */
export async function writeBothFormats(
  workbook: Workbook.Handle,
  file: string
): Promise<{ readonly xlsx: string; readonly xlsb: string }> {
  // **Recalculate before writing, or every formula ships with no cached value.**
  //
  // A formula this library creates carries an expression and nothing else until `calculateFormulas` runs — the engine
  // is a separate subpath precisely so a CDN consumer does not pay ~200 KB for it, which means an example has to ask.
  // None of them did, and the cost is not the missing number; it is what the missing number makes a *reader* do.
  //
  // Measured on `sales-dashboard`, whose table totals row is six `SUBTOTAL(109, Transactions[…])` over 10,080 rows:
  // LibreOffice took **498 s** to open this library's `.xlsb` and 461 s for its `.xlsx`, against **33 s** for the same
  // content saved by Excel — a *larger* file. Excel's six cached values are real (205797, 305999433.24, …); ours were
  // all `0`. With nothing cached, opening the file means evaluating six aggregates across a ten-thousand-row
  // structured reference, and anyone who tries it concludes the file is broken.
  //
  // It belongs here rather than in each example for the same reason the write does: an example should be about the
  // feature it demonstrates, and a file that takes eight minutes to open is not a demonstration of anything.
  calculateFormulas(workbook);

  const written: Record<"xlsx" | "xlsb", string> = { xlsx: "", xlsb: "" };
  for (const format of ["xlsx", "xlsb"] as const) {
    const target = pathFor(file, format);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const dropped = await unsupportedItems(workbook, format);
    const buffer = await Workbook.toBuffer(workbook, { format, unsupported: "ignore" });
    fs.writeFileSync(target, buffer);
    written[format] = target;
    const suffix =
      dropped.length === 0
        ? ""
        : `  — dropped ${dropped.length}: ${dropped.slice(0, 3).join("; ")}${dropped.length > 3 ? " …" : ""}`;
    console.log(`  ${format}  ${String(buffer.length).padStart(8)} bytes  ${target}${suffix}`);
  }
  return { xlsx: written.xlsx, xlsb: written.xlsb };
}
