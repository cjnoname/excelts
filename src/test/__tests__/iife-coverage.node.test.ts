/**
 * Every public module must have a way to be used without a bundler.
 *
 * `exports` publishes 19 subpaths; `rolldown.config.ts` built 9 bundles. Nothing compared
 * the two, so `draw` and `mermaid` were public for several releases with no script-tag path
 * at all — and nothing recorded whether that was a decision or an oversight. It was an
 * oversight: both are pure computation with no platform API of their own, and a diagram
 * renderer you cannot drop into a page with one `<script>` is missing its most obvious
 * consumer.
 *
 * That class of gap is invisible by construction. Adding a module means adding an `exports`
 * entry, a `typesVersions` entry and a README; the bundle table is in a third place that no
 * check read, so forgetting it produced a working release with a silently narrower surface.
 * This is the comparison that makes forgetting fail.
 *
 * A subpath that deliberately ships no bundle goes in `IIFE_EXEMPT_SUBPATHS` with a reason,
 * next to the table — the same shape as `verify-doc-examples.ts`'s `DELIBERATELY_ABSENT` and
 * `verify-public-types.ts`'s exceptions map. An exemption is a claim that a script-tag
 * consumer can still reach the module some other way, and it should be readable as such.
 *
 * Only **top-level** subpaths are required to have one. A nested subpath (`./excel/csv`,
 * `./word/html`) is a bridge between two modules whose bundles both exist, and giving each
 * pairing its own bundle would multiply the artifact without adding reach.
 *
 * ## Why `.node.test.ts`
 *
 * It reads `package.json` off disk. `vitest.browser.config.ts` excludes `*.node.test.ts` by
 * glob, which is a rule rather than a list somebody has to remember to extend.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IIFE_BUNDLES, IIFE_EXEMPT_SUBPATHS } from "../../../scripts/lib/iife-bundles";

const ROOT = path.resolve(import.meta.dirname, "../../..");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
};

/** Public subpaths, minus `./package.json` and the nested bridges. */
function topLevelSubpaths(): string[] {
  return Object.keys(manifest.exports).filter(
    subpath => subpath !== "./package.json" && !subpath.slice(2).includes("/")
  );
}

describe("IIFE coverage of the public surface", () => {
  const subpaths = topLevelSubpaths();
  const bundled = new Set(IIFE_BUNDLES.map(bundle => `./${bundle.file}`));
  const exempt = new Map(IIFE_EXEMPT_SUBPATHS.map(entry => [entry.subpath, entry.why]));

  it("has something to check", () => {
    // A manifest read that quietly returned nothing would make every case below vacuous.
    expect(subpaths.length).toBeGreaterThan(10);
    expect(IIFE_BUNDLES.length).toBeGreaterThan(8);
  });

  it.each(subpaths)("%s is reachable without a bundler", subpath => {
    const reason = exempt.get(subpath);
    expect(
      bundled.has(subpath) || reason !== undefined,
      `${subpath} is published in exports but has no IIFE bundle. Either add one to ` +
        "IIFE_BUNDLES in scripts/lib/iife-bundles.ts, or record why a script-tag consumer " +
        "does not need one in IIFE_EXEMPT_SUBPATHS."
    ).toBe(true);
  });

  it.each([...exempt])("the exemption for %s explains itself", (subpath, why) => {
    // An exemption with no reason is a gap wearing a permission slip.
    expect(why.length, `${subpath} is exempt without a reason`).toBeGreaterThan(30);
    expect(
      bundled.has(subpath),
      `${subpath} is both bundled and exempt — remove the exemption`
    ).toBe(false);
  });

  it("bundles nothing that exports does not publish", () => {
    // The reverse drift: a bundle for a module that is no longer public ships bytes to
    // every CDN consumer for an API they cannot import.
    const unpublished = [...bundled].filter(subpath => !subpaths.includes(subpath));
    expect(unpublished, `bundled but absent from exports: ${unpublished.join(", ")}`).toEqual([]);
  });

  it("gives every bundle a distinct file name and global", () => {
    expect(new Set(IIFE_BUNDLES.map(b => b.file)).size).toBe(IIFE_BUNDLES.length);
    expect(new Set(IIFE_BUNDLES.map(b => b.global)).size).toBe(IIFE_BUNDLES.length);
  });

  it.each(IIFE_BUNDLES)("$file names an entry module that exists", ({ input }) => {
    expect(fs.existsSync(path.join(ROOT, input)), `${input} does not exist`).toBe(true);
  });

  // A list only a human keeps in sync is a list that is eventually wrong — the same reason
  // `function-count.node.test.ts` exists. Both READMEs enumerate the bundle names so a
  // reader knows what to put in the URL, and the enumeration is delimited by an HTML
  // comment so it can be checked; the comment is invisible in rendered Markdown, unlike a
  // marker inside the fence a reader copies.
  it.each(["README.md", "README_zh.md"])("%s lists exactly the bundles that exist", file => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const region = /<!-- iife-bundles:start -->([\s\S]*?)<!-- iife-bundles:end -->/.exec(source);
    expect(region, `${file} has no iife-bundles region — was it reworded?`).not.toBeNull();

    const listed = [...(region?.[1] ?? "").matchAll(/`([\w-]+)`/g)].map(match => match[1]);
    expect([...listed].sort()).toEqual(IIFE_BUNDLES.map(bundle => bundle.file).sort());
  });
});
