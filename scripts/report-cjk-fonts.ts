/**
 * Report which CJK faces this host actually has, and which one the library picks.
 *
 *   pnpm build:esm && node scripts/report-cjk-fonts.ts
 *
 * Read-only: prints and exits 0.
 *
 * It exists because the font order in `system-fonts.ts` encodes claims about three
 * operating systems, and only one of them can be checked from any given machine. The
 * claims that mattered most were also the least obvious:
 *
 *   - macOS `PingFang.ttc` cannot be embedded at all — every face is CFF, and
 *     subsetting needs `glyf`.
 *   - Debian and Ubuntu's `fonts-noto-cjk` installs CFF collections, so the standard
 *     Linux CJK package is unusable here for the same reason.
 *   - Windows `DengXian` and `SimHei` are a Feature On Demand package, not the base
 *     install, so they may simply be absent.
 *
 * Each of those was found by reading font bytes, and each would have been guessed
 * wrong. This prints the same evidence for whatever host it runs on: what is present,
 * its weight, whether it carries outlines we can use, and the face
 * the selector settles on per language. CI runs on all three platforms, so running it
 * there is what turns the ordering from an assertion into a measurement.
 */
import {
  FAMILIES_BY_LANGUAGE,
  discoverSystemFontCandidates,
  findSystemFontForCodePoints,
  resetFontDiscoveryCache
} from "../dist/esm/modules/pdf/font/system-fonts.js";
import { parseTtf } from "../dist/esm/modules/pdf/font/ttf-parser.js";
import type { CjkLanguage } from "../dist/esm/utils/cjk.js";

/** Sample text per language, chosen so only that language's faces can draw it well. */
const SAMPLES: Record<CjkLanguage, string> = {
  "zh-Hans": "简体中文销售业绩概述径者前母",
  "zh-Hant": "繁體中文銷售業績概述徑者前母",
  ja: "日本語のテスト資料径者前母",
  ko: "한국어 보고서 자료"
};

/**
 * Whether the outlines are ones we can subset.
 *
 * `glyf` means yes; `CFF ` means no, which is why PingFang and Debian's
 * `fonts-noto-cjk` are unusable here. Read straight from the table directory rather
 * than inferred from the parser's success, so a face that fails for some other reason
 * is not reported as CFF.
 */
function outlineFlavour(data: Uint8Array, collectionIndex: number): string {
  const u16 = (o: number) => (data[o] << 8) | data[o + 1];
  const u32 = (o: number) =>
    ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
  try {
    let base = 0;
    if (u32(0) === 0x74746366) {
      const numFonts = u32(8);
      base = u32(12 + (collectionIndex < numFonts ? collectionIndex : 0) * 4);
    }
    const tags: string[] = [];
    const count = u16(base + 4);
    for (let i = 0; i < count; i++) {
      const rec = base + 12 + i * 16;
      if (rec + 4 > data.length) break;
      tags.push(String.fromCharCode(data[rec], data[rec + 1], data[rec + 2], data[rec + 3]));
    }
    if (tags.includes("glyf")) return "glyf";
    if (tags.some(t => t.trim() === "CFF" || t.trim() === "CFF2")) return "CFF";
    return tags.length > 0 ? "other" : "unreadable";
  } catch {
    return "unreadable";
  }
}

console.log(`platform: ${process.platform}  node: ${process.version}\n`);

// --- What is installed, of everything the curated lists name ------------------
const wanted = new Set<string>();
for (const families of Object.values(FAMILIES_BY_LANGUAGE)) {
  for (const family of families) {
    wanted.add(family.toLowerCase());
  }
}

interface Found {
  family: string;
  postScriptName: string;
  weight: number;
  flavour: string;
}

const found = new Map<string, Found>();
let scanned = 0;
let unparseable = 0;

for (const candidate of discoverSystemFontCandidates()) {
  scanned++;
  const flavour = outlineFlavour(candidate.data, candidate.collectionIndex);
  let parsed;
  try {
    parsed = parseTtf(candidate.data, candidate.collectionIndex);
  } catch {
    unparseable++;
    continue;
  }
  const key = parsed.familyName.trim().toLowerCase();
  if (!wanted.has(key)) {
    continue;
  }
  // Keep the face closest to Regular, which is the rule the selector itself uses.
  // Reporting whichever face was scanned first is actively misleading: macOS
  // `Songti.ttc` starts with Black and `STHeiti Light.ttc` with Light, so the first
  // face said `w900` and `w300` for families whose usable Regular sits further in —
  // and the selector picks that Regular.
  const incumbent = found.get(key);
  if (
    incumbent !== undefined &&
    Math.abs(incumbent.weight - 400) <= Math.abs(parsed.weightClass - 400)
  ) {
    continue;
  }
  found.set(key, {
    family: parsed.familyName.trim(),
    postScriptName: parsed.postScriptName,
    weight: parsed.weightClass,
    flavour
  });
}

console.log(
  `scanned ${scanned} face(s); ${unparseable} could not be parsed (CFF, bitmap or corrupt)`
);
console.log(`\nnamed families present, best available weight per family (${found.size}):`);
for (const [, f] of [...found].sort((a, b) => a[1].family.localeCompare(b[1].family))) {
  console.log(
    `  ${f.family.padEnd(24)} ${f.postScriptName.padEnd(26)} w${String(f.weight).padStart(3)}  ${f.flavour}`
  );
}

// --- Which of the curated names are missing, in list order --------------------
for (const [language, families] of Object.entries(FAMILIES_BY_LANGUAGE) as Array<
  [CjkLanguage, readonly string[]]
>) {
  const absent = families.filter(f => !found.has(f.toLowerCase()));
  console.log(
    `\n${language}: ${families.length - absent.length}/${families.length} named families present`
  );
  if (absent.length > 0) {
    console.log(`  absent: ${absent.join(", ")}`);
  }
}

// --- What the selector actually chooses --------------------------------------
console.log(`\nselection per language (what a document would embed):`);
for (const [language, sample] of Object.entries(SAMPLES) as Array<[CjkLanguage, string]>) {
  resetFontDiscoveryCache();
  const codePoints = new Set([...sample].map(c => c.codePointAt(0)!));
  const chosen = findSystemFontForCodePoints(codePoints, [], language);
  if (!chosen) {
    console.log(`  ${language.padEnd(8)} NONE — Han would render as Type3 tofu`);
    continue;
  }
  const rank = FAMILIES_BY_LANGUAGE[language].findIndex(
    f => f.toLowerCase() === chosen.familyName.trim().toLowerCase()
  );
  const missing = [...codePoints].filter(cp => !chosen.cmap.has(cp));
  console.log(
    `  ${language.padEnd(8)} ${chosen.familyName.padEnd(22)} ${chosen.postScriptName.padEnd(26)} ` +
      `w${String(chosen.weightClass).padStart(3)}  rank ${rank < 0 ? "unranked" : rank}` +
      (missing.length > 0 ? `  (lacks ${missing.length}, drawn by Type3)` : "")
  );
}
