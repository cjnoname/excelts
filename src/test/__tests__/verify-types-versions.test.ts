/**
 * The `typesVersions` gate has to actually fire.
 *
 * `verify-types-versions.ts` exists because a subpath missing from `typesVersions`
 * type-checks for most consumers and fails with `TS2307` for the ones on
 * `moduleResolution: "node10"` — a failure this repository's own builds never see.
 * That is also why the check needs testing: nothing else would notice if it silently
 * passed everything, and a gate that never fires is worse than no gate, because it
 * looks like coverage.
 *
 * The script is run as a subprocess rather than imported. `scripts/` sits outside the
 * typed project on purpose (`tsconfig.json` excludes it, and pulling it in raises 237
 * type errors from the existing scripts), so a test that imported it would neither be
 * type-checked nor resolvable. Running the real CLI also covers the parts an imported
 * function would not: argument handling and the exit code that makes `pnpm check`
 * fail.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../../scripts/verify-types-versions.ts");

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "types-versions-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Run the gate against a manifest, returning its exit code and output. */
function run(manifest: unknown): { code: number; output: string } {
  const file = path.join(workspace, `manifest-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(manifest));
  try {
    const output = execFileSync("node", [SCRIPT, "--manifest", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

const declaration = (name: string): string[] => [`dist/types/modules/${name}/index.d.ts`];

describe("the typesVersions gate", () => {
  it("passes a manifest whose maps agree", () => {
    const { code } = run({
      exports: { "./excel": {}, "./word": {} },
      typesVersions: { "*": { excel: declaration("excel"), word: declaration("word") } }
    });
    expect(code).toBe(0);
  });

  it("fails when a subpath has no declaration mapping", () => {
    // The case that started this: `./draw` was added to `exports` and nowhere else.
    const { code, output } = run({
      exports: { "./excel": {}, "./draw": {} },
      typesVersions: { "*": { excel: declaration("excel") } }
    });
    expect(code).toBe(1);
    expect(output).toContain("./draw");
    expect(output).toContain("node10");
  });

  it("fails on a mapping left behind by a rename", () => {
    // What actually happened in f5b3efbb: `./zip` became `./archive` and the old
    // `typesVersions` key stayed, so one subpath had no mapping and a mapping had no
    // subpath.
    const { code, output } = run({
      exports: { "./archive": {} },
      typesVersions: { "*": { zip: declaration("archive"), archive: declaration("archive") } }
    });
    expect(code).toBe(1);
    expect(output).toContain("zip");
    expect(output).toContain("stale");
  });

  it("fails on a declaration path that could not be built", () => {
    // A typo or a stale directory. The file cannot be checked for existence — it only
    // appears after a build — so the shape of the path is what is verified.
    for (const target of ["dist/esm/modules/excel/index.js", "src/modules/excel/index.ts"]) {
      const { code, output } = run({
        exports: { "./excel": {} },
        typesVersions: { "*": { excel: [target] } }
      });
      expect(code, target).toBe(1);
      expect(output).toContain("dist/types");
    }
  });

  it("fails on an empty mapping rather than treating it as present", () => {
    const { code } = run({
      exports: { "./excel": {} },
      typesVersions: { "*": { excel: [] } }
    });
    expect(code).toBe(1);
  });

  it("ignores the package.json export, which is a file rather than an entry point", () => {
    const { code } = run({
      exports: { "./excel": {}, "./package.json": "./package.json" },
      typesVersions: { "*": { excel: declaration("excel") } }
    });
    expect(code).toBe(0);
  });

  it("reports a missing typesVersions block instead of throwing", () => {
    const { code, output } = run({ exports: { "./excel": {} } });
    expect(code).toBe(1);
    expect(output).toContain("./excel");
  });

  it("catches a declaration that does not exist", () => {
    // The shape check alone passes a path into a directory that was renamed away. `pnpm
    // check` builds types first, so the file is there to look at.
    const { code, output } = run({
      exports: { "./excel": { import: { types: "./dist/types/modules/excel/index.d.ts" } } },
      typesVersions: { "*": { excel: ["dist/types/modules/excel/gone.d.ts"] } }
    });
    expect(code).toBe(1);
    expect(output).toContain("does not exist");
  });

  it("catches a mapping pointed at the wrong declaration", () => {
    // `typesVersions` and `exports` are two answers to the same question. When they
    // disagree, older TypeScript resolves a different file from every other toolchain —
    // and both files exist, so nothing else notices.
    const { code, output } = run({
      exports: { "./excel": { import: { types: "./dist/types/modules/excel/index.d.ts" } } },
      typesVersions: { "*": { excel: ["dist/types/modules/xml/index.d.ts"] } }
    });
    expect(code).toBe(1);
    expect(output).toContain("must name the same declaration");
  });

  it("guards this repository's own manifest", () => {
    // The gate is wired into `pnpm check`; this is the assertion that it is green here
    // and not merely that the logic works on fixtures.
    const output = execFileSync("node", [SCRIPT], { encoding: "utf8" });
    expect(output).toContain("mirrors exports");
  });
});
