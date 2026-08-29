/**
 * Every documented function count must equal the registry's.
 *
 * The count was stated in prose in sixteen places across ten files and nothing derived it,
 * so it drifted: the READMEs, `AGENTS.md` and a public TSDoc block all claimed 433 while the
 * table held 448. A number that only a human keeps in sync is a number that is eventually
 * wrong, and the wrongness is invisible — nothing fails, the docs simply lie.
 *
 * Twelve of those sixteen are user-facing claims and are pinned below. The other four were
 * internal comments — two in `function-registry.ts`, two in `scripts/treeshake-verify.ts` —
 * and were reworded to drop the number instead: a count in a comment about tree-shaking costs
 * maintenance and tells its reader nothing they need.
 *
 * ## Why a curated list rather than a scan
 *
 * The obvious approach — look for a three-digit number near the word "function" — cannot
 * be made to work on this corpus. `crc32`, `getBigUint64`, `SHA-256`, "680 lines paired
 * function-for-function", "200+ functions" and `date1904 propagation to the function
 * registry` all match, and tightening the pattern until they do not turns the test into a
 * prose parser that is wrong in a new way. Worse, the count in `excel/README.md` is split
 * across a line break ("433 supported\nfunctions"), so anything line-oriented misses a
 * real claim while reporting several false ones.
 *
 * So each claim is named explicitly, and **every pattern must match**. A rewording that
 * breaks a pattern fails this test rather than silently escaping it, which is the property
 * that matters: the failure lands on whoever changed the sentence, while they are looking
 * at it. The known gap is a *new* claim written somewhere not listed here — the same
 * tradeoff `verify-public-types.ts` documents for its exceptions map, and the reason the
 * eventual documentation site should generate this number instead of restating it.
 *
 * `listFunctionNames()` is the authority. It exists because there was previously no way to
 * ask the registry how large it is.
 *
 * ## Why `.node.test.ts`
 *
 * This reads Markdown off disk, so it is Node-only — and it is a check on *documentation*,
 * not on shipped logic, so there is nothing a browser could usefully re-verify. The suffix
 * is how this repository states that: `vitest.browser.config.ts` excludes
 * `*.node.test.ts` by glob, which is a rule rather than a list somebody has to remember to
 * extend. Naming the file instead in that config's hand-maintained `exclude` array is the
 * other option and the worse one, because the next such test would fail the browser run
 * before anyone thought to add it.
 */

import fs from "node:fs";
import path from "node:path";

import { listFunctionNames } from "@formula/runtime/function-registry";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

/**
 * Where the function count is stated, and how to read it.
 *
 * Internal comments are deliberately absent: `scripts/treeshake-verify.ts` used to state
 * the count twice and now says "the built-in function table", because a number in a
 * script's comment costs maintenance and tells its reader nothing they need.
 */
const CLAIMS: readonly { readonly file: string; readonly pattern: RegExp }[] = [
  { file: "README.md", pattern: /\b(\d+)-function calculation engine/ },
  { file: "README_zh.md", pattern: /\b(\d+) 函数计算引擎/ },
  { file: "AGENTS.md", pattern: /evaluator, (\d+) functions, spill engine/ },
  { file: "src/modules/formula/README.md", pattern: /and (\d+) built-in functions/ },
  { file: "src/modules/formula/README.md", pattern: /\*\*(\d+) built-in Excel functions\*\*/ },
  { file: "src/modules/formula/README.md", pattern: /(\d+) function implementations/ },
  { file: "src/modules/formula/README_zh.md", pattern: /(\d+) 个内置函数/ },
  { file: "src/modules/formula/README_zh.md", pattern: /\*\*(\d+) 个内置 Excel 函数\*\*/ },
  { file: "src/modules/formula/README_zh.md", pattern: /(\d+) 个函数实现/ },
  // Split across a line break in the source, hence the `\s`.
  { file: "src/modules/excel/README.md", pattern: /(\d+) supported\s+functions/ },
  { file: "src/modules/excel/README_zh.md", pattern: /(\d+) 个支持的函数/ },
  {
    file: "src/modules/formula/integration/calculate-formulas.ts",
    pattern: /(\d+) built-in functions/
  }
];

describe("the documented function count", () => {
  const registrySize = listFunctionNames().length;

  it("has something to check", () => {
    // A list that quietly emptied would make every case below vacuous.
    expect(CLAIMS.length).toBeGreaterThan(10);
    expect(registrySize).toBeGreaterThan(400);
  });

  it("counts each name once, so the total is unambiguous", () => {
    const names = listFunctionNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(CLAIMS.map((claim, index) => ({ ...claim, index })))(
    "matches the registry in $file ($index)",
    ({ file, pattern }) => {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      const match = pattern.exec(text);
      // A missing match means the sentence was reworded. That is not a licence to skip
      // the check — it is the moment to confirm the number is still right.
      expect(match, `${file}: no text matching ${pattern} — was it reworded?`).not.toBeNull();
      expect(
        Number(match?.[1]),
        `${file} states a function count that is not ${registrySize}`
      ).toBe(registrySize);
    }
  );
});
