/**
 * Bisection probes: one workbook, many variants, each with a single suspect removed.
 *
 * **Why this exists.** Excel is the only oracle for "does this file open", and each round trip through a human
 * costs a lot. Diagnosing by *difference from Excel's bytes* does not work on its own — three differences were
 * fixed in a row (`BrtStyle.iLevel`, `PtgFunc` versus `PtgFuncVar`, a missing `chartEx` part) and the repair log
 * came back identical, because **a byte that differs from Excel's is not necessarily the byte Excel rejected.**
 *
 * So this writes a ladder instead of a guess. Every variant is the same workbook with one feature suppressed; the
 * first one that opens cleanly names the culprit, and the whole ladder is one round trip rather than one per
 * hypothesis.
 *
 * Run: `node --import @oxc-node/core/register scripts/xlsb-bisect.ts <example-output.xlsb>`
 *
 * It reads a package this library wrote, emits `tmp/xlsb-bisect/<name>--<variant>.xlsb`, and prints what each
 * variant dropped. Open them in Excel from the least-suppressed downwards and report the first that is clean.
 */
import fs from "node:fs";
import path from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { iterateInterpretableRecords, encodeBiffRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "tmp", "xlsb-bisect");

/**
 * A variant: which records to drop from which parts.
 *
 * Suppressing a *record* rather than rebuilding the workbook keeps every other byte identical, so a variant that
 * opens cleanly implicates exactly what it removed. Collections are dropped whole — begin, members and end —
 * because a collection whose count no longer matches its members is a new defect rather than a smaller one.
 */
interface Variant {
  readonly name: string;
  readonly why: string;
  /** Which part a rule applies to; `undefined` means every part. */
  readonly part?: RegExp;
  /** Collections to remove entirely, by the name of their opening record. */
  readonly dropCollections?: readonly string[];
  /** Individual records to remove. */
  readonly dropRecords?: readonly string[];
}

const VARIANTS: readonly Variant[] = [
  {
    name: "00-baseline",
    why: "unchanged, so a clean open here means the defect is already fixed"
  },
  {
    name: "01-no-dxfs",
    why: "the differential formats a conditional-formatting rule points at",
    part: /styles\.bin$/,
    dropCollections: ["BrtBeginDXFs"]
  },
  {
    name: "02-no-named-styles",
    why: "the Styles collection — the one the repair log names",
    part: /styles\.bin$/,
    dropCollections: ["BrtBeginStyles"]
  },
  {
    name: "03-no-number-formats",
    why: "custom number-format codes, which Excel rewrites when it repairs",
    part: /styles\.bin$/,
    dropCollections: ["BrtBeginFmts"]
  },
  {
    name: "04-no-table-styles",
    why: "the table/PivotTable style-name declarations",
    part: /styles\.bin$/,
    dropCollections: ["BrtBeginTableStyles"]
  },
  {
    name: "05-no-conditional-formatting",
    why: "every rule in every sheet, formulas included",
    part: /worksheets\//,
    dropCollections: ["BrtBeginConditionalFormatting"]
  },
  {
    name: "06-no-cell-formulas",
    why: "formula cells, which the repair log calls Cell information",
    part: /worksheets\//,
    dropRecords: ["BrtFmlaNum", "BrtFmlaString", "BrtFmlaBool", "BrtFmlaError"]
  },
  {
    name: "07-no-defined-names",
    why: "the workbook's names, whose formulas the log calls Formula from workbook.bin",
    part: /workbook\.bin$/,
    dropRecords: ["BrtName"]
  }
];

/** Rewrite one record stream with a variant's suppressions applied. */
function filterPart(bytes: Uint8Array, variant: Variant): Uint8Array {
  const keep: { id: number; payload: Uint8Array }[] = [];
  const closing = new Map(
    (variant.dropCollections ?? []).map(open => [open, open.replace("Begin", "End")])
  );
  const dropRecords = new Set(variant.dropRecords ?? []);
  let suppressUntil: string | undefined;
  for (const record of iterateInterpretableRecords(bytes, "s")) {
    const name = recordSpec(record.id)?.name;
    if (suppressUntil !== undefined) {
      if (name === suppressUntil) {
        suppressUntil = undefined;
      }
      continue;
    }
    if (name !== undefined && closing.has(name)) {
      suppressUntil = closing.get(name);
      continue;
    }
    if (name !== undefined && dropRecords.has(name)) {
      continue;
    }
    keep.push({ id: record.id, payload: record.payload });
  }
  return encodeBiffRecords(
    keep.map(record => ({ id: record.id, payload: record.payload })) as never
  );
}

async function main(): Promise<void> {
  const source = process.argv[2];
  if (source === undefined) {
    console.log("usage: xlsb-bisect.ts <path-to.xlsb>");
    process.exitCode = 1;
    return;
  }
  const parts = await extractAll(new Uint8Array(fs.readFileSync(source)));
  const base = path.basename(source, ".xlsb");
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`${base}: ${parts.size} parts\n`);
  for (const variant of VARIANTS) {
    const archive = new ZipArchive();
    let touched = 0;
    for (const [name, entry] of parts) {
      const applies =
        (variant.dropCollections !== undefined || variant.dropRecords !== undefined) &&
        (variant.part === undefined || variant.part.test(name)) &&
        name.endsWith(".bin");
      if (!applies) {
        archive.add(name, entry.data);
        continue;
      }
      try {
        const filtered = filterPart(entry.data, variant);
        if (filtered.length !== entry.data.length) {
          touched += 1;
        }
        archive.add(name, filtered);
      } catch {
        // A part this walker cannot rewrite is passed through unchanged: a variant that fails to suppress is
        // still a valid file, and saying so is better than emitting a broken one.
        archive.add(name, entry.data);
      }
    }
    const target = path.join(OUT, `${base}--${variant.name}.xlsb`);
    fs.writeFileSync(target, await archive.bytes());
    console.log(
      `  ${variant.name.padEnd(30)} ${touched} part(s) changed   ${variant.why}\n` +
        `    ${path.relative(ROOT, target)}`
    );
  }
  console.log(
    `\nOpen them in order. The first that opens **without a repair dialog** names the cause:\n` +
      `the feature its line describes is the one Excel is rejecting.`
  );
}

await main();
