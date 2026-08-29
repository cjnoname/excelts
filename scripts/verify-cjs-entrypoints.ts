/**
 * Load every published CommonJS entry point in a child process.
 *
 * `build:verify:node` type-checks the emitted `.d.ts` files, which says nothing
 * about whether the JavaScript beside them runs. A `require()` that ends up
 * *after* the code using it is valid TypeScript and valid ESM — import bindings
 * are hoisted — but `tsc`'s CommonJS emit keeps statement order, so the call lands
 * below its consumer and the temporal dead zone throws at load:
 *
 * ```
 * ReferenceError: Cannot access 'grapheme_1' before initialization
 * ```
 *
 * That shipped once: an import placed at the end of `src/utils/cjk.ts` broke 12 of
 * the 19 CJS entries while the whole suite stayed green, because the tests run
 * against source through ESM.
 *
 * There is a Vitest test for this too, but it can only skip when `dist/cjs` is
 * absent — and `pnpm test` runs Vitest before any build and never builds CJS at
 * all, so in a clean checkout it always skipped. This runs inside `build:verify`,
 * where the artifact is guaranteed to exist.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `.pathname`: the latter yields `/C:/…` on Windows and does
// not percent-decode, so a path with a space in it fails.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
  readonly exports?: Record<string, unknown>;
}

/** The CommonJS file each export subpath resolves to, when it has one. */
function commonJsEntries(): { subpath: string; file: string }[] {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8")
  ) as PackageManifest;
  const out: { subpath: string; file: string }[] = [];

  const pickRequire = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const req = (value as { require?: unknown }).require;
    if (typeof req === "string") {
      return req;
    }
    if (typeof req === "object" && req !== null) {
      const def = (req as { default?: unknown }).default;
      return typeof def === "string" ? def : undefined;
    }
    return undefined;
  };

  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    const file = pickRequire(value);
    if (file !== undefined) {
      out.push({ subpath, file });
    }
  }
  return out;
}

const entries = commonJsEntries();
if (entries.length === 0) {
  console.error("verify:cjs — no CommonJS entry points found in package.json exports");
  process.exit(1);
}

const failures: string[] = [];
for (const { subpath, file } of entries) {
  const absolute = join(repoRoot, file);
  if (!existsSync(absolute)) {
    failures.push(`${subpath} — missing artifact ${file}`);
    continue;
  }
  try {
    // A child process per entry: a module registry is per-process, so loading them
    // together would let one entry mask another's failure.
    execFileSync(process.execPath, ["-e", `require(${JSON.stringify(absolute)})`], {
      stdio: "pipe"
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    failures.push(`${subpath} — ${stderr.trim().split("\n")[0]}`);
  }
}

if (failures.length > 0) {
  console.error(`✗ verify:cjs — ${failures.length} of ${entries.length} entry point(s) failed:`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(`✓ verify:cjs — ${entries.length} CommonJS entry point(s) load.`);
