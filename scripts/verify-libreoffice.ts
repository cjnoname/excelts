/**
 * Hands every `.xlsb` this repository produces to LibreOffice, and asks whether an independent implementation can read
 * it.
 *
 * **Why a third reader exists at all.** Every other check here is judged by one of three parties, and each has a gap
 * the others do not fill:
 *
 * - This library's own reader, through a round trip. Cheap, runs on everything — and structurally unable to catch a
 *   reader and a writer that share one wrong assumption, which is where most of this codec's real defects have come
 *   from. A round trip through a shared mistake is perfect.
 * - A byte comparison against files Excel itself saved (`scripts/xlsb-oracle.ts`). The strongest automated signal
 *   available, but it needs a human to produce each reference file, so it covers fifteen cases.
 * - A person opening the file in Excel. The only authority that counts, and the reason several crash-level defects
 *   here were found at all. It does not scale: most of the files this repository writes have never been opened.
 *
 * LibreOffice is the only judge that is both independent of this codebase and cheap enough to point at all of them.
 *
 * **What a pass does not mean.** LibreOffice is markedly more permissive than Excel. This is not a guess: an array
 * formula written without a `PtgExp` forwarding record for every cell in its range made *Excel terminate its own
 * process*, while this library's 19,900 tests and every third-party-format check passed. So:
 *
 * - a failure here is a strong signal — the file is broken;
 * - a pass here is a weak one — it says nothing about whether Excel will accept it.
 *
 * Read this gate as a screen for gross structural damage across files nobody has opened, and not as a substitute for
 * opening them.
 *
 * **What "converted successfully" is worth, precisely.** Three things are checked: a zero exit, an output file that is
 * not empty, and no repair or error in LibreOffice's diagnostics. The middle one is a floor rather than a verdict, and it
 * was worth measuring how low: a workbook whose shared-string table is truncated to garbage converts to a **one-byte**
 * CSV while an intact single-cell workbook converts to two, and LibreOffice reports nothing either way. So a package can
 * lose all of its content and pass — which is why the corpus checks compare *content* (`verify:xlsb-corpus` derives a
 * fingerprint per fixture and holds it across containers) and this gate is about structure.
 *
 * The repair scan is applied to the diagnostics and **not** to the `convert … -> … using filter …` line LibreOffice
 * echoes on success. That line contains the input path, so a fixture directory named `lo-repair-test` failed this check
 * on the strength of its own name — a gate reporting on itself.
 *
 * ## Usage
 *
 * ```
 * pnpm verify:libreoffice              # skips loudly when LibreOffice is absent
 * pnpm verify:libreoffice --require    # absence is a failure — what CI passes
 * pnpm verify:libreoffice --filter pivot
 * ```
 *
 * `--require` is the whole design. A gate that skips silently when its dependency is missing is a gate that is green
 * forever: it would skip on every developer machine, and skip again the day the CI install breaks, reporting success
 * both times. With `--require`, "could not be verified" and "was verified" cannot be confused.
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";

/**
 * Where a macOS cask and the common Linux packages put the binary.
 *
 * `SOFFICE`, when set, **replaces** this list rather than being prepended to it. Falling through to a discovered
 * binary after an explicit one failed to resolve would turn a typo in the variable into a silent success, and would
 * mean the harness could never be told "there is no LibreOffice here" — which is the one thing `--require` has to be
 * able to test.
 */
const DISCOVERED =
  process.env["DOCUMONSTER_LO_DISCOVERED"] === undefined
    ? [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/usr/bin/soffice",
        "/usr/bin/libreoffice",
        "/snap/bin/libreoffice"
      ]
    : // Overridable so the `--require` contract can be tested on a machine that *does* have LibreOffice installed.
      // Without this the "nothing resolves" branch is unreachable here, and an untested failure path is the one that
      // fails wrongly when it finally runs.
      process.env["DOCUMONSTER_LO_DISCOVERED"].split(",");
/**
 * `SOFFICE` first, then the known install locations.
 *
 * An earlier version made `SOFFICE` *exclusive*, so a typo could not be masked by a discovered binary. That is the right
 * instinct and the wrong trade: CI passes `SOFFICE=soffice`, a bare name, and exclusivity meant one resolution failure
 * took the gate down rather than falling back to `/usr/bin/soffice` on the same machine. The typo case is covered by
 * `--require`, which fails when *nothing* resolves — and the report names every candidate it tried.
 */
const CANDIDATES =
  process.env["SOFFICE"] === undefined ? DISCOVERED : [process.env["SOFFICE"], ...DISCOVERED];

/**
 * Files that are inputs or references rather than this library's output.
 *
 * The two corpora are obvious. `xxxN.xlsb` is less so: those are workbooks *Excel* saved from this library's output, kept
 * beside it for byte comparison — checking them tells you about Excel, and one of them
 * (`sales-dashboard1.xlsb`) converts to a **one-byte** CSV because Excel stored the sheet with its pivots collapsed.
 * That one byte is also why the "not empty" check below is not enough on its own to call a conversion good; it is a
 * floor, not a verdict.
 */
const NOT_OURS = ["tmp/xlsb-oracle/", "tmp/xlsb-corpus/"];
/**
 * Excel's own saves, kept beside this library's output for byte comparison.
 *
 * **Matched by directory and by the `1` suffix convention *together*, because the suffix alone is a guess about a name.**
 * `/\d\.xls[bx]$/` on its own excluded `tmp/xlsb-bisect/g2-array-4x1.xlsb` — a package this library wrote, silently
 * dropped from the gate for ending in a digit. The convention only exists in `tmp/excel-examples/`, where a manual
 * "Save As" sits next to the original, so that is where it is applied.
 */
function isExcelSaved(path: string): boolean {
  return path.includes("tmp/excel-examples/") && /\d\.xls[bx]$/.test(path);
}

async function findSoffice(): Promise<string | undefined> {
  for (const candidate of CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Next candidate.
    }
  }
  return undefined;
}

async function collect(dir: string, out: string[]): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(path, out);
    } else if (
      // **Both containers, and it used to be `.xlsb` only.**
      //
      // The gate was written while the XLSB writer was the new thing, and the omission left 98 `.xlsx` files this
      // repository produces unread by anything but itself — a larger set than the 149 `.xlsb` it did check. The
      // defect that motivated all of this (`c:varyColors`, 498 s against 32 s) was in the *shared* chart renderer and
      // showed in both containers, so restricting the check to one of them was checking the writer twice and the
      // library once.
      /\.xls[bx]$/.test(entry.name) &&
      !isExcelSaved(path) &&
      // **`~$name.xlsb` is Excel's lock file, not something this library wrote.** It appears next to any workbook a
      // human has open, it is a few hundred bytes of owner name, and LibreOffice rightly refuses it — which showed up
      // as four of the first five "failures" here.
      !entry.name.startsWith("~$") &&
      !NOT_OURS.some(skip => path.includes(skip))
    ) {
      out.push(path);
    }
  }
}

interface Outcome {
  readonly file: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * One conversion, in its own profile directory.
 *
 * The separate `-env:UserInstallation` matters: LibreOffice serialises every invocation that shares a profile, so
 * without it a second run while the first still holds the lock exits zero having converted nothing — a false pass.
 */
async function convert(soffice: string, file: string): Promise<Outcome> {
  // **Scaled to the file, not a flat ceiling.** A 2.3 MB dashboard needs about a minute of LibreOffice's time on its
  // own, and a flat 120 s budget failed it — reported as "timed out", which reads like a broken file and is not one.
  // The same file converts fine given room, and produces byte-identical CSV from this library's XLSB and XLSX.
  const bytes = await stat(file).then(
    info => info.size,
    () => 0
  );
  const timeoutMs = Math.max(60_000, Math.ceil(bytes / 1024 / 1024) * 45_000);
  const work = await mkdtemp(join(tmpdir(), "documonster-lo-"));
  try {
    let output = "";
    const code = await new Promise<number | string>(resolve => {
      const child = spawn(
        soffice,
        [
          `-env:UserInstallation=file://${join(work, "profile")}`,
          "--headless",
          "--norestore",
          "--convert-to",
          "csv",
          "--outdir",
          work,
          file
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      // **Collected, because LibreOffice reports a repair on its output and still exits 0.**
      //
      // The pipes were opened and never read: a package it had to repair — a dropped part, a malformed record stream —
      // converted "successfully" and this gate called it good. The repository's own `external-oracle.ts` has scanned for
      // this since it was written; not reusing the idea here left the whole-tree gate weaker than the per-fixture one.
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("timed out");
      }, timeoutMs);
      child.on("error", error => {
        clearTimeout(timer);
        resolve(error.message);
      });
      child.on("close", status => {
        clearTimeout(timer);
        resolve(status ?? "killed");
      });
    });
    if (code !== 0) {
      return { file, ok: false, detail: `soffice exited ${code}` };
    }
    // The same patterns `external-oracle.ts` uses, so the two gates cannot disagree about what a repair looks like —
    // **applied to the diagnostics and not to the paths.**
    //
    // LibreOffice echoes the input and output paths on success (`convert … -> … using filter …`), and those contain the
    // file's own name. A fixture directory called `lo-repair-test` therefore failed this check on the strength of its
    // name, which is a gate reporting on itself. Dropping the `convert …` line leaves what LibreOffice has to say about
    // the *content*.
    const diagnostics = output
      .split("\n")
      .filter(line => !/^convert .* using filter/.test(line.trim()))
      .join("\n");
    const repair = [/repair/i, /repaired/i, /corrupt/i, /error/i].find(pattern =>
      pattern.test(diagnostics)
    );
    if (repair !== undefined) {
      return {
        file,
        ok: false,
        detail: `exited 0 but reported a repair or error (${String(repair)}): ${diagnostics.trim().split("\n")[0] ?? ""}`
      };
    }
    // **A zero exit is not enough.** LibreOffice reports success and writes nothing when it cannot make sense of the
    // input, so the output file is the actual claim — and an empty one means it read the package and found no cells.
    // The extension has to be stripped whichever it is — `basename(file, ".xlsb")` left `.xlsx` in place, so the
    // check looked for `name.xlsx.csv`, found nothing, and reported a file LibreOffice had read perfectly well as
    // "exited 0 but produced no output". A gate whose failure message describes the gate is worse than no gate.
    const produced = join(work, `${basename(file).replace(/\.xls[bx]$/, "")}.csv`);
    try {
      const size = (await stat(produced)).size;
      const text = await readFile(produced, "utf8");
      return size === 0
        ? { file, ok: false, detail: "converted to an empty file" }
        : { file, ok: true, detail: `${size} B, ${text.split("\n").length - 1} line(s)` };
    } catch {
      return { file, ok: false, detail: "exited 0 but produced no output" };
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const required = argv.includes("--require");
  const filterAt = argv.indexOf("--filter");
  const filter = filterAt === -1 ? undefined : argv[filterAt + 1];

  const soffice = await findSoffice();
  if (soffice === undefined) {
    const message =
      "LibreOffice was not found. Looked at:\n" +
      CANDIDATES.map(path => `    ${path}`).join("\n") +
      "\n  Install it with `brew install --cask libreoffice` or `apt-get install libreoffice-calc`,\n" +
      "  or set SOFFICE to the binary.";
    if (required) {
      console.error(`✗ verify:libreoffice — ${message}`);
      process.exit(1);
    }
    // Loud, and it says what was *not* checked. A quiet skip is how a gate dies green.
    console.log(`⚠ verify:libreoffice — skipped, nothing was verified.\n  ${message}`);
    return;
  }

  const files: string[] = [];
  // **`tmp/` only, and `examples/data/` used to be included as well.**
  //
  // That directory holds committed *inputs* — workbooks an example reads, and a couple of references it compares against.
  // They are not what this library wrote in this run, so their passing says something about the fixture and their failing
  // would be blamed on the writer. Including them also inflated the coverage number this gate reports.
  await collect("tmp", files);
  const targets = (filter === undefined ? files : files.filter(f => f.includes(filter))).sort();
  const byKind = (extension: string): number =>
    targets.filter(name => name.endsWith(extension)).length;

  if (targets.length === 0) {
    console.error(
      `✗ verify:libreoffice — no spreadsheet files to check${filter === undefined ? ". Run `pnpm verify:examples` first." : ` matching ${JSON.stringify(filter)}.`}`
    );
    process.exit(1);
    return;
  }
  // **A floor, because "more than zero" is not a coverage statement.**
  //
  // This gate discovers whatever happens to be on disk. An example that regresses to writing only one container, returns
  // early with a zero exit, or has its output renamed makes the set quietly smaller — and the gate stays green while
  // checking less. A floor turns that into a failure without pinning an exact list, which would need editing every time
  // an example is added.
  //
  // Set from a full run — 209 files, 126 `.xlsb` and 83 `.xlsx` — with room for a couple to move. Raise it when the tree
  // grows; a failure here means either coverage shrank or this number is stale, and both are worth a look.
  //
  // It earned its place immediately: excluding the committed example *inputs* took the count from 223 to 209 and this
  // floor caught it, which is the behaviour a floor is for.
  const FLOOR = 200;
  if (filter === undefined && targets.length < FLOOR) {
    console.error(
      `✗ verify:libreoffice — found ${targets.length} file(s), fewer than the expected floor of ${FLOOR}.\n` +
        "  Either an example stopped writing its output, or the floor needs updating. Run `pnpm verify:examples` first."
    );
    process.exit(1);
    return;
  }

  console.log(
    `${soffice}\n${targets.length} file(s) — ${byKind(".xlsb")} xlsb, ${byKind(".xlsx")} xlsx\n`
  );
  const failures: Outcome[] = [];
  let done = 0;
  for (const file of targets) {
    const outcome = await convert(soffice, file);
    done += 1;
    if (!outcome.ok) {
      failures.push(outcome);
      console.log(`  ✗ ${file}\n      ${outcome.detail}`);
    } else if (process.env["CI"] === undefined) {
      console.log(`  ✓ ${String(done).padStart(3)}/${targets.length} ${file}  ${outcome.detail}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\n✗ verify:libreoffice — ${failures.length} of ${targets.length} file(s) could not be read by LibreOffice.`
    );
    console.error(
      "  A failure here means the file is broken. A pass would not have meant it is fine."
    );
    process.exit(1);
    return;
  }
  console.log(`\n✓ verify:libreoffice — LibreOffice read all ${targets.length} file(s).`);
  console.log("  This screens for structural damage; it is not evidence that Excel accepts them.");
}

await main();
