/**
 * Run a streaming build **twice**, once per container, from one description.
 *
 * `writeBothFormats` cannot serve the streaming examples: it takes a finished `Workbook.Handle` and writes it,
 * while a streaming writer *is* the writing — there is no handle to hand over, and the rows are gone by the time
 * the first container is done. So the shape is inverted. The caller supplies a function that fills a writer, and
 * this calls it once per format with a writer already pointed at the right file.
 *
 * **Why the build runs twice rather than the output being teed.** A streamed workbook is not a value that can be
 * written to two places: the whole point is that nothing keeps it. Teeing the *bytes* would produce two files with
 * the same container, and buffering the model to write it twice would give up the property the examples are
 * demonstrating. Running the caller's code again is the honest form, and it doubles as a check that a streaming
 * build is repeatable — which the runner already requires of every example.
 *
 * The line it prints per container is the one thing a reader of the console wants: which file, how big, and
 * anything the writer could not express. For XLSB that last part is real — a streamed sheet cannot carry a table
 * or a pivot table, because both need a second pass over cells that have already been released — and the writer
 * reports it rather than this helper guessing.
 */
import fs from "node:fs";
import path from "node:path";

import { Stream } from "@excel/index";

/** The path for `format`, derived from a path that names another. */
function pathFor(file: string, format: "xlsx" | "xlsb"): string {
  const extension = path.extname(file);
  return extension === "" ? `${file}.${format}` : `${file.slice(0, -extension.length)}.${format}`;
}

/**
 * Build the same workbook into both containers with a streaming writer.
 *
 * `build` receives a writer and must fill it and commit its worksheets; this commits the workbook. Options other
 * than `filename` and `format` are passed through, so an example that cares about compression or shared strings
 * keeps saying so.
 */
export async function streamBothFormats(
  file: string,
  options: Omit<Stream.WorkbookWriterOptions, "filename" | "format" | "stream">,
  build: (writer: Stream.WorkbookWriter) => void | Promise<void>
): Promise<{ readonly xlsx: string; readonly xlsb: string }> {
  const written: Record<"xlsx" | "xlsb", string> = { xlsx: "", xlsb: "" };
  for (const format of ["xlsx", "xlsb"] as const) {
    const target = pathFor(file, format);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const writer = new Stream.WorkbookWriter({ ...options, filename: target, format });
    await build(writer);
    await writer.commit();
    written[format] = target;
    const size = fs.statSync(target).size;
    const dropped = writer.xlsbUnsupported;
    const suffix =
      dropped.length === 0
        ? ""
        : `  — dropped ${dropped.length}: ${dropped.slice(0, 3).join("; ")}${dropped.length > 3 ? " …" : ""}`;
    console.log(`  ${format}  ${String(size).padStart(9)} bytes  ${target}${suffix}`);
  }
  return { xlsx: written.xlsx, xlsb: written.xlsb };
}
