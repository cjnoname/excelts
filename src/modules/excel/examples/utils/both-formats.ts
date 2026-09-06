/**
 * Write one workbook to **both** containers, read each back, and report what survived.
 *
 * Every XLSB example in this directory needs the same four steps — build, write, read, compare — and the value
 * of the comparison is that it is against XLSX rather than against nothing. A feature "works in XLSB" only if
 * the binary container preserves what the XML one does; a round trip that agrees with itself proves that the
 * reader and the writer share an assumption, not that the file is right. Three defects fixed in this module
 * survived exactly that kind of check.
 *
 * So the shared part is deliberately the *plumbing* and not the feature code: each example still contains the
 * API calls it is about, in full view, and the builders they share live in `features.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractAll } from "@archive/unzip/extract";
import { Workbook } from "@excel/index";

/** Where every example writes. Gitignored, and the only directory an example may touch. */
export const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../tmp/excel-examples"
);

/** One container's result: the file it wrote and the workbook read back out of it. */
export interface Written {
  readonly format: "xlsx" | "xlsb";
  readonly file: string;
  readonly bytes: number;
  readonly reloaded: Workbook.Handle;
  /**
   * Every part in the package it wrote.
   *
   * Needed because "the model forgot it" and "the file lost it" are different statements, and several features
   * are only in the first category: a chart or a pivot survives an XLSB round trip as preserved bytes while the
   * reader does not put it back into the model. An example that could only see the model would report those as
   * losses, which is wrong and alarming in the wrong direction.
   */
  readonly parts: readonly string[];
}

/**
 * Write `workbook` as both `.xlsx` and `.xlsb`, then read each back.
 *
 * `unsupported: "ignore"` on purpose: a feature the writer declines is exactly what these examples exist to
 * show, and refusing would stop the comparison to report something the caller is about to be told anyway. What
 * was dropped comes back in `dropped`.
 */
/** What `format` cannot express — see the identically named helper in `write-both.ts`. */
async function unsupportedItems(
  workbook: Workbook.Handle,
  format: "xlsx" | "xlsb"
): Promise<readonly string[]> {
  try {
    await Workbook.toBuffer(workbook, { format, unsupported: "error" });
    return [];
  } catch (cause) {
    const items = (cause as { items?: readonly string[] }).items;
    if (items === undefined) {
      throw cause;
    }
    return items;
  }
}

export async function writeBoth(
  workbook: Workbook.Handle,
  basename: string
): Promise<{ readonly results: readonly Written[]; readonly dropped: readonly string[] }> {
  fs.mkdirSync(outDir, { recursive: true });
  const dropped: string[] = [];
  const results: Written[] = [];
  for (const format of ["xlsx", "xlsb"] as const) {
    const file = path.join(outDir, `${basename}.${format}`);
    // The writer reports what it cannot express by *refusing*; there is no callback. This asked for one
    // (`onUnsupported`) and cast the option object to `never` to get past the compiler, so `dropped` was
    // always empty and every example claimed a clean write. See `write-both.ts` for the same fix and the
    // cost it carries.
    for (const item of await unsupportedItems(workbook, format)) {
      dropped.push(`${format}: ${item}`);
    }
    const buffer = await Workbook.toBuffer(workbook, { format, unsupported: "ignore" });
    fs.writeFileSync(file, buffer);
    const reloaded = Workbook.create();
    await Workbook.read(reloaded, buffer);
    const parts = [...(await extractAll(buffer)).keys()];
    results.push({ format, file, bytes: buffer.length, reloaded, parts });
  }
  return { results, dropped };
}

/**
 * Print one row per container for a feature, using a caller-supplied probe.
 *
 * The probe returns what it found in a reloaded workbook — a count, a reference, a colour. Printing the two
 * side by side is the whole point: a difference between the columns is a container that lost something, and it
 * is visible without reading any bytes.
 */
export function report(
  title: string,
  results: readonly Written[],
  probe: (workbook: Workbook.Handle, written: Written) => string
): void {
  console.log(`\n${title}`);
  for (const written of results) {
    let found: string;
    try {
      found = probe(written.reloaded, written);
    } catch (error) {
      // A probe that throws is a finding, not a crash — one container may lack what the other has.
      found = `probe failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(
      `  ${written.format.padEnd(5)} ${String(written.bytes).padStart(7)} bytes   ${found}`
    );
  }
}

/** Print what the writer refused, or say that it refused nothing. */
export function reportDropped(dropped: readonly string[]): void {
  if (dropped.length === 0) {
    console.log("\nNothing was dropped: both containers expressed every feature above.");
    return;
  }
  console.log(`\nDropped by the writer (${dropped.length}):`);
  for (const note of dropped) {
    console.log(`  ${note}`);
  }
}

/** The files an example wrote, for its closing line. */
export function reportFiles(results: readonly Written[]): void {
  console.log("\nWrote:");
  for (const written of results) {
    console.log(`  ${written.file}`);
  }
}
