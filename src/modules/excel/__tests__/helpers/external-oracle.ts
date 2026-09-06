import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Cache resolved executables so we don't probe the filesystem repeatedly. */
const resolveCache = new Map<string, string | undefined>();

export interface ExternalOracleResult {
  available: boolean;
  skipped?: string;
  executable?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  outputs: Array<{ name: string; data: Uint8Array }>;
}

export interface ExternalOracleOptions {
  /**
   * Environment variable that gates the oracle. When set to `"1"` the
   * oracle runs unconditionally (and fails the test if the executable
   * cannot be located or the conversion errors).
   *
   * Pass `null` to use {@link autoMode} semantics instead — the oracle
   * runs whenever the executable is auto-discovered, otherwise it
   * gracefully reports `available: false` so callers can `expect(result.skipped).toBeTruthy()`.
   */
  envFlag: string | null;
  executableEnv: string;
  candidates: string[];
  args: string[];
  input: Uint8Array;
  inputName: string;
  outputGlob?: RegExp;
  timeoutMs?: number;
  /** Set to false for proprietary CLIs that do not support a cheap --version probe. */
  versionArgs?: string[] | false;
  /**
   * When true, run the oracle whenever the executable is discoverable,
   * skipping otherwise. Useful for "default-on if installed, off in
   * minimal CI" semantics that do not require an env flag opt-in.
   *
   * Ignored when {@link envFlag} is set to a non-null string and that
   * env var explicitly equals `"1"` (the explicit opt-in always wins).
   */
  autoMode?: boolean;
}

export async function runExternalOracle(
  options: ExternalOracleOptions
): Promise<ExternalOracleResult> {
  const explicitOptIn = options.envFlag !== null && process.env[options.envFlag] === "1";
  const auto = options.autoMode === true;
  if (!explicitOptIn && !auto) {
    return {
      available: false,
      skipped: options.envFlag
        ? `Set ${options.envFlag}=1 to enable.`
        : "autoMode disabled and no envFlag opt-in",
      outputs: []
    };
  }
  const executable = await resolveExecutable(
    options.executableEnv,
    options.candidates,
    options.versionArgs
  );
  if (!executable) {
    return {
      available: false,
      skipped: `${options.executableEnv} executable not found.`,
      outputs: []
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "documonster-oracle-"));
  const outDir = join(dir, "out");
  try {
    await mkdir(outDir);
    const inputPath = join(dir, options.inputName);
    await writeFile(inputPath, options.input);
    const args = options.args.map(arg =>
      arg.replace(/\{input\}/g, inputPath).replace(/\{outDir\}/g, outDir)
    );
    const { stdout, stderr } = await runExclusively(() =>
      execFileAsync(executable, args, {
        timeout: options.timeoutMs ?? 120_000,
        // A profile of its own, so two runs cannot contend for one lock. LibreOffice serialises invocations that share
        // a profile: the second exits zero having converted nothing, which reads as a pass.
        env: { ...process.env, UserInstallation: `file://${join(dir, "profile")}` }
      })
    );
    const outputs = await collectOutputs(outDir, options.outputGlob);
    return { available: true, executable, exitCode: 0, stdout, stderr, outputs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface OfficeOpenValidationOptions {
  /** Pass `null` to rely on {@link autoMode} only. */
  envFlag: string | null;
  executableEnv: string;
  candidates: string[];
  args?: string[];
  input: Uint8Array;
  inputName: string;
  timeoutMs?: number;
  repairLogPatterns?: RegExp[];
  versionArgs?: string[] | false;
  /** See {@link ExternalOracleOptions.autoMode}. */
  autoMode?: boolean;
}

export async function runOfficeOpenValidation(
  options: OfficeOpenValidationOptions
): Promise<ExternalOracleResult> {
  const result = await runExternalOracle({
    envFlag: options.envFlag,
    executableEnv: options.executableEnv,
    candidates: options.candidates,
    args: options.args ?? ["--headless", "--convert-to", "xlsx", "--outdir", "{outDir}", "{input}"],
    input: options.input,
    inputName: options.inputName,
    outputGlob: /[.]xlsx$/i,
    timeoutMs: options.timeoutMs,
    versionArgs: options.versionArgs,
    autoMode: options.autoMode
  });
  if (!result.available) {
    return result;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const repairLogPatterns = options.repairLogPatterns ?? [
    /repair/i,
    /repaired/i,
    /corrupt/i,
    /error/i
  ];
  const repairHit = repairLogPatterns.find(pattern => pattern.test(output));
  if (repairHit) {
    const message = `Office open validation reported a possible repair/error (${repairHit}).`;
    return {
      ...result,
      available: true,
      exitCode: 1,
      stderr: [result.stderr, message].filter(Boolean).join("\n"),
      outputs: result.outputs
    };
  }
  return result;
}

/**
 * Absolute paths to try after the PATH-relative candidates.
 *
 * **A cask installs LibreOffice outside PATH on macOS,** so `soffice` never resolved and every oracle here reported
 * `available: false` — for as long as nobody had it installed, which was the whole time. That is the failure mode a
 * skip-when-absent gate has: it is indistinguishable from a pass, and it stays that way silently. Adding the install
 * locations is what made these tests run for the first time, and they found a real defect immediately.
 */
const WELL_KNOWN: Record<string, readonly string[]> = {
  LIBREOFFICE_BIN: [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/snap/bin/libreoffice"
  ]
};

/**
 * One external conversion at a time, across every worker.
 *
 * These helpers spawn a full office suite, and vitest runs test files in *separate processes* — so an in-process queue
 * is not enough: several workers start a conversion at once, contend for CPU, and each takes long enough to blow a
 * per-test timeout that is generous for a single run. The failure looks like a broken file and is not one.
 *
 * That is not a hypothesis. The same mistake made by hand during a performance investigation produced six consecutive
 * *wrong* measurements, each looking like a real improvement; re-measured serially, the file had not changed at all.
 *
 * A lock rather than a bigger timeout, because the timeout was never the problem — the contention was, and raising it
 * only makes a contended run slower rather than fixing what it reports. `mkdir` is the primitive: it is atomic on every
 * platform this runs on, needs no dependency, and a stale directory from a killed process expires by age.
 */
const LOCK_DIR = join(tmpdir(), "documonster-external-oracle.lock");
const LOCK_STALE_MS = 15 * 60 * 1000;

async function acquireLock(): Promise<void> {
  for (;;) {
    try {
      await mkdir(LOCK_DIR);
      return;
    } catch {
      // Held. Take it over if the holder is old enough to be dead, otherwise wait.
      try {
        const age = Date.now() - (await stat(LOCK_DIR)).mtimeMs;
        if (age > LOCK_STALE_MS) {
          await rm(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // It disappeared between the two calls, which means it is free.
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function runExclusively<T>(task: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await task();
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true });
  }
}

async function resolveExecutable(
  envName: string,
  candidates: string[],
  versionArgs: string[] | false = ["--version"]
): Promise<string | undefined> {
  const cacheKey = `${envName}:${candidates.join(",")}:${String(versionArgs)}`;
  if (resolveCache.has(cacheKey)) {
    return resolveCache.get(cacheKey);
  }
  const values = [process.env[envName], ...candidates, ...(WELL_KNOWN[envName] ?? [])].filter(
    (value): value is string => !!value
  );
  for (const value of values) {
    if (versionArgs === false) {
      resolveCache.set(cacheKey, value);
      return value;
    }
    try {
      await execFileAsync(value, versionArgs, { timeout: 10_000 });
      resolveCache.set(cacheKey, value);
      return value;
    } catch {
      // Try next optional oracle executable.
    }
  }
  resolveCache.set(cacheKey, undefined);
  return undefined;
}

/**
 * Convenience wrapper that runs LibreOffice's `--convert-to xlsx`
 * round-trip in auto mode: if `LIBREOFFICE_BIN` (or `soffice` /
 * `libreoffice` on PATH) is discoverable the validation runs and
 * `expect(exitCode).toBe(0)` passes; otherwise the result reports
 * `available: false` and callers should `expect(skipped).toBeTruthy()`.
 *
 * Used by the synthetic chart corpus tests so the open-validation gate
 * runs by default for everyone with LibreOffice installed, without
 * forcing an explicit env-var opt-in or breaking minimal CI environments.
 */
export async function runLibreOfficeOpenValidationAuto(
  input: Uint8Array,
  inputName: string
): Promise<ExternalOracleResult> {
  return runOfficeOpenValidation({
    envFlag: "DOCUMONSTER_LIBREOFFICE_OPEN_VALIDATION",
    executableEnv: "LIBREOFFICE_BIN",
    candidates: [
      "soffice",
      "libreoffice",
      // macOS app bundle install (default Homebrew Cask + manual install location).
      "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    ],
    input,
    inputName,
    autoMode: true
  });
}

async function collectOutputs(
  dir: string,
  include: RegExp | undefined
): Promise<Array<{ name: string; data: Uint8Array }>> {
  const result: Array<{ name: string; data: Uint8Array }> = [];
  for (const name of await readdir(dir)) {
    if (include && !include.test(name)) {
      continue;
    }
    const filePath = join(dir, name);
    // Read directly — skip on failure (avoids TOCTOU race between stat and read).
    try {
      const data = new Uint8Array(await readFile(filePath));
      result.push({ name: basename(name), data });
    } catch {
      // Not a readable file (directory, permission error, removed between readdir and read).
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
