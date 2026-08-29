/**
 * Every documented IIFE CDN URL must name a bundle that exists, at the version being
 * published, and every snippet beside one must read its API off the right global.
 *
 * Nothing in the toolchain read these. `verify-doc-examples.ts` checks `ts` fences by
 * handing their imports to `tsc`; a `<script src>` in an `html` fence has no imports and
 * no compiler, so it was unchecked — and it rotted exactly as you would expect:
 *
 * - `src/modules/excel/README.md` pointed at `documonster.iife.min.js`, a whole-family
 *   bundle that has never been built. The URL returned 404 for every reader.
 * - The snippet beneath it read `const { Workbook } = Documonster`, one level above where
 *   the namespace actually lives (`Documonster.Excel`), so a reader who worked past the
 *   404 still got `undefined`.
 * - The root README's URL was unpinned (`unpkg.com/documonster/…`), which resolves to
 *   whatever is newest — a copied snippet is then a page that changes under its owner on
 *   every release, and breaks on the first one that changes an API.
 *
 * Unlike the documented function count, this is a scan rather than a curated list: a URL
 * is unambiguous to match, so there are no false positives to work around and a *new*
 * document cannot escape the check by not being listed.
 *
 * **The filename is validated, not matched.** The first version of this test folded the
 * expected shape into the pattern (`documonster\.(\w+)\.iife\.js`) and therefore did not
 * see the one URL it was written for: `documonster.iife.min.js` has no module segment, so
 * it simply failed to match and passed. A gate must recognise the malformed case, so the
 * pattern now takes any filename under `dist/iife/` and the shape is an assertion.
 *
 * The pinned versions are kept current by release-please, which rewrites them inside the
 * `x-release-please-start-version` / `x-release-please-end` markers around each fence
 * (see `release-please-config.json`). Those markers are HTML comments placed outside the
 * fence, so they are invisible in rendered Markdown rather than noise a reader copies.
 *
 * ## Why not Subresource Integrity
 *
 * An `integrity` attribute is only correct for one exact build, and nothing here can
 * compute it: release-please rewrites text, it cannot hash a tarball that does not exist
 * yet. A hash a human maintains is a hash that goes stale, and a stale one is strictly
 * worse than none — the browser refuses to execute the script, so the failure mode is a
 * blank page rather than an old version. Pinning the version is the part that can be kept
 * true automatically, so that is the part the documentation claims.
 *
 * ## Why `.node.test.ts`
 *
 * It reads Markdown off disk. `vitest.browser.config.ts` excludes `*.node.test.ts` by
 * glob, which is a rule rather than a list somebody has to remember to extend.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IIFE_BUNDLES } from "../../../scripts/lib/iife-bundles";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SKIP_DIRS = new Set([".git", "dist", "node_modules", "out", "tmp", "__screenshots__"]);

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  version: string;
};

/**
 * A CDN reference to anything under `dist/iife/`. `unpkg` and `jsDelivr` both serve npm
 * from a `<host>/<name><spec>/<path>` shape, so one pattern covers both. The filename is
 * captured whole and checked below rather than encoded here — see the header.
 */
const URL_PATTERN =
  /https?:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/documonster(@[^/]*)?\/dist\/iife\/([\w.@-]+\.js)/g;

/** `documonster.<module>.iife.js`, optionally minified — what `rolldown.config.ts` emits. */
const BUNDLE_FILENAME = /^documonster\.([\w-]+)\.iife(?:\.min)?\.js$/;

/**
 * A snippet destructuring the root global. The bundles install
 * `Documonster.<Module>`, so this yields `undefined` members. The check looks for the
 * mistake rather than for one correct phrasing, which would fail on every rewording.
 */
const ROOT_DESTRUCTURE = /(?:const|let|var)\s*\{[^}]*\}\s*=\s*Documonster\s*[;,)\n]/g;

interface Reference {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** Version specifier after `documonster`, empty when the URL is unpinned. */
  readonly spec: string;
  /** The referenced filename, exactly as written. */
  readonly filename: string;
}

/** Authored Markdown, excluding generated and vendored trees. */
function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        found.push(...markdownFiles(full));
      }
    } else if (entry.name.endsWith(".md")) {
      found.push(full);
    }
  }
  return found;
}

function references(): Reference[] {
  const found: Reference[] = [];
  for (const file of markdownFiles(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    // CHANGELOG.md is history rather than instruction: an entry describing what a past
    // release shipped must keep saying what it said.
    if (rel === "CHANGELOG.md") {
      continue;
    }
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, index) => {
        for (const match of text.matchAll(URL_PATTERN)) {
          found.push({
            file: rel,
            line: index + 1,
            text: match[0],
            spec: match[1] ?? "",
            filename: match[2]
          });
        }
      });
  }
  return found;
}

describe("documented IIFE CDN URLs", () => {
  const found = references();
  const names = new Set(IIFE_BUNDLES.map(bundle => bundle.file));
  const globalOf = new Map(IIFE_BUNDLES.map(bundle => [bundle.file, bundle.global]));

  it("has something to check", () => {
    // A pattern that quietly stopped matching would make every case below vacuous.
    expect(found.length).toBeGreaterThan(0);
    expect(names.size).toBe(IIFE_BUNDLES.length);
  });

  it.each(found.map(reference => ({ ...reference, where: `${reference.file}:${reference.line}` })))(
    "names a real bundle at the published version — $where",
    ({ where, text, spec, filename }) => {
      const shape = BUNDLE_FILENAME.exec(filename);
      expect(
        shape,
        `${where} references "${filename}", which is not of the form ` +
          `documonster.<module>.iife[.min].js`
      ).not.toBeNull();
      expect(
        names.has(shape?.[1] ?? ""),
        `${where} references "${filename}", which no bundle in ` +
          `scripts/lib/iife-bundles.ts produces (have: ${[...names].sort().join(", ")})`
      ).toBe(true);
      expect(
        spec,
        `${where} must pin the version — "${text}" resolves to whatever is newest, so a ` +
          `release changes a reader's page without their asking`
      ).toBe(`@${version}`);
    }
  );

  it.each([...new Set(found.map(reference => reference.file))])(
    "reaches namespaces through Documonster.<Module> in %s",
    file => {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const expected = [
        ...new Set(
          found
            .filter(reference => reference.file === file)
            .map(reference => globalOf.get(BUNDLE_FILENAME.exec(reference.filename)?.[1] ?? ""))
            .filter(Boolean)
        )
      ];
      for (const wrong of source.matchAll(ROOT_DESTRUCTURE)) {
        expect.fail(
          `${file} destructures the root global (${wrong[0].trim()}) — namespaces live ` +
            `under ${expected.map(name => `Documonster.${name}`).join(" / ") || "Documonster.<Module>"}`
        );
      }
    }
  );
});
