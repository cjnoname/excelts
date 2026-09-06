/**
 * System font discovery for PDF generation.
 *
 * When no embedded font is provided and the document contains non-WinAnsi
 * characters, this module searches standard system font directories for a
 * TrueType font (.ttf or .ttc) with broad Unicode coverage.
 *
 * This is a Node.js-only feature — browser environments do not have
 * file system access and must always provide fonts explicitly.
 *
 * .ttc (TrueType Collection) files are supported, and are expanded to one
 * candidate per face: the faces in a collection differ in both coverage and
 * regional glyph conventions, so face 0 is not automatically the one worth
 * having.
 *
 * Discovery runs as an internal generator so selection can stop at the first face
 * that answers; {@link discoverSystemFontCandidates} materialises the whole list
 * for tests and for callers enumerating deliberately.
 *
 * Neither is cached — a snapshot holds every font file's bytes. What *is* cached is
 * the metadata that costs I/O rather than memory: the path index, each file's face
 * count, each face's family and weight, and the faces already proven unparseable.
 *
 * Auto-embed callers should not iterate themselves: use
 * {@link findSystemFontForCodePoints}, which owns the coverage rule so every
 * pipeline picks the same font for the same text.
 *
 * Ordering is a legibility decision, not just a coverage one — see
 * `PREFERRED_FONTS` below.
 */

import { countTtfFaces, parseTtf } from "@pdf/font/ttf-parser";
import type { TtfFont } from "@pdf/font/ttf-parser";
import { requiresEmbeddedFace } from "@pdf/font/type3-repertoire";
import type { CjkLanguage } from "@utils/cjk";
import { isGlyphlessControl } from "@utils/cjk";
import { readFileBytesSync, traverseDirectorySync } from "@utils/fs";
import type { FileEntry } from "@utils/fs";

// =============================================================================
// Platform Font Directories
// =============================================================================

function getSystemFontDirs(): string[] {
  const platform = typeof process !== "undefined" ? process.platform : "";
  const home =
    typeof process !== "undefined" ? (process.env.HOME ?? process.env.USERPROFILE ?? "") : "";

  const dirs: string[] = [];

  switch (platform) {
    case "darwin":
      dirs.push(
        "/System/Library/Fonts",
        "/System/Library/Fonts/Supplemental",
        "/Library/Fonts",
        `${home}/Library/Fonts`,
        // Downloadable / on-demand faces. Recent macOS releases moved a large
        // part of the system's font library here, and a scan of the four
        // directories above misses all of it: this machine has 136 font files
        // under AssetsV2, 90 of them with `glyf` outlines, including 黑体
        // (`Hei.ttf`), 楷体 (`Kaiti.ttc`), 仿宋 (`STFANGSO.ttf`) and 隶变
        // (`Libian.ttc`). None of them were reachable, so naming one through
        // `preferSystemFonts` silently fell through to the built-in order.
        //
        // `fontdb` (Typst) scans the same place; matplotlib solves it by asking
        // CoreText to enumerate instead. Enumerating the directory keeps this
        // module free of a native dependency. The subdirectory name is matched
        // rather than hardcoded because the hash in it changes per install.
        ...macOsAssetFontDirs()
      );
      break;
    case "win32": {
      const winDir = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
      dirs.push(`${winDir}\\Fonts`, `${process.env.LOCALAPPDATA ?? ""}\\Microsoft\\Windows\\Fonts`);
      break;
    }
    case "linux":
    default:
      dirs.push(
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        "/usr/share/fonts/truetype",
        "/usr/share/fonts/opentype",
        "/usr/share/fonts/TTF",
        "/usr/share/fonts/noto",
        "/usr/share/fonts/noto-cjk",
        "/usr/share/fonts/google-noto",
        "/usr/share/fonts/google-noto-cjk",
        "/usr/share/fonts/truetype/noto",
        "/usr/share/fonts/truetype/dejavu",
        "/usr/share/fonts/truetype/liberation",
        "/usr/share/fonts/truetype/droid",
        "/usr/share/fonts/wqy",
        `${home}/.local/share/fonts`,
        `${home}/.fonts`
      );
      break;
  }

  return dirs;
}

/**
 * macOS on-demand font asset directories, newest first.
 *
 * Each is `/System/Library/AssetsV2/com_apple_MobileAsset_Font<N>/<hash>.asset/AssetData`.
 * Both levels are enumerated because the version suffix and the content hash
 * change between releases and installs.
 */
function macOsAssetFontDirs(): string[] {
  const root = "/System/Library/AssetsV2";
  const out: string[] = [];
  let families: FileEntry[];
  try {
    families = traverseDirectorySync(root, { recursive: false });
  } catch {
    return out;
  }
  for (const family of families) {
    if (!family.isDirectory || !family.relativePath.startsWith("com_apple_MobileAsset_Font")) {
      continue;
    }
    let assets: FileEntry[];
    try {
      assets = traverseDirectorySync(family.absolutePath, { recursive: false });
    } catch {
      continue;
    }
    for (const asset of assets) {
      if (asset.isDirectory && asset.relativePath.endsWith(".asset")) {
        out.push(`${asset.absolutePath}/AssetData`);
      }
    }
  }
  return out;
}

// =============================================================================
// Preferred Font Names (ordered by preference — first match wins)
// =============================================================================

/**
 * Candidate filenames, in the order they are tried.
 *
 * Ordering is a **legibility** decision, not only a coverage one. Coverage
 * alone would put `Arial Unicode MS` first — one file, almost every script —
 * and that is exactly what this list used to do. But its CJK glyphs are the
 * 1998 Monotype set, and preferring it meant a Mac with STHeiti installed still
 * produced Chinese that read as visibly worse than anything else on the system.
 * System CJK faces therefore come first and the broad-coverage catch-alls last,
 * so a document gets the nicest face that can draw it rather than the first one
 * that can.
 *
 * Filenames are **platform facts**, not guesses, and several were wrong when first
 * written: Apple spells the BIZ UD family with underscores (`BIZ_UDGothic.ttc`)
 * and ships its Mincho as a `.ttf`, `Toppan` carries a `Pr6N` suffix, and
 * `Tsukushi` is `Maru` rather than `Round`. A name that does not exist costs
 * nothing at lookup time but removes the cheap path entirely — the face is then
 * only reachable through the recursive sweep, where a family-name match can lose
 * to another region's font that happened to be read first. Where a name varies
 * between releases, both spellings are listed; a `stat` is far cheaper than a
 * missed match.
 *
 * @internal Exported for the ordering regression test.
 */
export const FONT_FILES_BY_LANGUAGE: Record<CjkLanguage, readonly string[]> = {
  // --- Simplified Chinese ---
  //
  // Serif (宋体) before sans, and the order of the *files* mirrors the order of the
  // *families* below: the scan may stop as soon as it holds a regional answer, so if
  // the two lists disagree they disagree about which face wins.
  //
  // Two measured facts shape this list, both worth stating so they are not
  // rediscovered by reading font binaries a second time:
  //
  //   - `NotoSerifCJK-Regular.ttc` and `NotoSansCJK-Regular.ttc` — what Debian and
  //     Ubuntu's `fonts-noto-cjk` actually installs, under
  //     `/usr/share/fonts/opentype/noto/` — are **CFF** collections (`CFF `, no
  //     `glyf`). `parseTtf` rejects them exactly as it rejects PingFang, so they are
  //     deliberately *not* named here: the recursive sweep finds them anyway, and
  //     naming them would only move a ~100 MB read earlier for a face that can
  //     never be embedded.
  //   - The per-language Google Fonts builds (`NotoSansSC[wght].ttf`,
  //     `NotoSerifSC[wght].ttf`) *are* `glyf`, so those are the Noto files that can
  //     actually be used. They are variable fonts; only the default instance is
  //     embedded, since `gvar` deltas are not applied.
  "zh-Hans": [
    // Serif, explicitly installed by the user — so it outranks anything the OS
    // merely happens to ship.
    "NotoSerifSC-Regular.ttf",
    "NotoSerifCJKsc-Regular.ttf",
    "SourceHanSerifSC-Regular.otf",
    // Serif, shipped with the OS. macOS `Songti.ttc`, Windows `simsun.ttc` (in the
    // Windows base install, and described by Microsoft as a mincho/serif face), and
    // the Linux `uming.ttc` from `fonts-arphic-uming`, which installs under
    // `truetype/` and therefore carries outlines we can subset.
    "Songti.ttc",
    "simsun.ttc",
    "uming.ttc",
    "SimSong.ttc",
    "STSONG.TTF",
    // Sans, explicitly installed.
    "NotoSansSC-Regular.ttf",
    "NotoSansCJKsc-Regular.ttf",
    "SourceHanSansSC-Regular.otf",
    // Sans, shipped with the OS. PingFang and Hiragino Sans GB are what macOS
    // itself renders Chinese with, so they lead this group: `parseTtf` rejects them
    // today (CFF outlines) and the scan moves on, but the intent survives a
    // CFF-capable embedder instead of having to be rediscovered.
    "PingFang.ttc",
    "Hiragino Sans GB.ttc",
    "STHeiti Light.ttc",
    "STHeiti Medium.ttc",
    "STHEITI.ttf",
    "STXIHEI.ttf",
    "Hei.ttf",
    "msyh.ttc",
    "msyhbd.ttc",
    "wqy-microhei.ttc",
    "wqy-zenhei.ttc",
    "DroidSansFallbackFull.ttf",
    "DroidSansFallback.ttf",
    // Windows "Chinese (Simplified) Supplemental Fonts" — a Feature On Demand
    // package, not the base install, so these are reached only on a machine that
    // has it and rank below everything that is always present.
    "Deng.ttf",
    "simhei.ttf",
    "simkai.ttf",
    "simfang.ttf",
    // Display and calligraphic faces: a last resort for coverage, never a body
    // text choice.
    "STFANGSO.ttf",
    "Kaiti.ttc",
    "Kai.ttf",
    "Yuanti.ttc",
    "Lantinghei.ttc",
    "Baoli.ttc",
    "Xingkai.ttc",
    "Libian.ttc"
  ],
  // --- Traditional Chinese ---
  //
  // Serif (宋體/明體) first, for the same reason and by the same rule as `zh-Hans`
  // above: within one script, Simplified and Traditional should not differ in
  // typographic class, or a document containing both mixes a serif with a gothic.
  "zh-Hant": [
    "NotoSerifTC-Regular.ttf",
    "NotoSerifCJKtc-Regular.ttf",
    "SourceHanSerifTC-Regular.otf",
    "Songti.ttc",
    "LiSongPro.ttf",
    "AppleLiSung-Light.ttf",
    "mingliu.ttc",
    "uming.ttc",
    "NotoSansTC-Regular.ttf",
    "NotoSansCJKtc-Regular.ttf",
    "SourceHanSansTC-Regular.otf",
    "PingFang.ttc",
    "STHeiti Light.ttc",
    "STHeiti Medium.ttc",
    "LiHeiPro.ttf",
    "Hiragino_Sans_CNS.ttc",
    "AppleLiGothic-Medium.ttf",
    "msjh.ttc",
    "msjhbd.ttc",
    "BiauKai.ttc",
    "BiauKai.ttf",
    "kaiu.ttf"
  ],
  // --- Japanese ---
  ja: [
    "NotoSansCJKjp-Regular.ttf",
    "NotoSansJP-Regular.ttf",
    "SourceHanSansJP-Regular.otf",
    "ヒラギノ角ゴシック W3.ttc",
    "Hiragino Sans GB.ttc",
    "Osaka.ttf",
    "OsakaMono.ttf",
    // Apple's own spelling uses underscores, and the Mincho is a .ttf. Both were
    // written with hyphens and a .ttc suffix, so the cheap filename lookup always
    // missed and the faces were only reachable through the expensive sweep — where
    // a family-name match could then lose to another region's font.
    "BIZ_UDGothic.ttc",
    "BIZ_UDMincho-regular.ttf",
    "BIZ-UDGothic.ttc",
    "BIZ-UDMincho.ttc",
    "Klee.ttc",
    "ToppanBunkyuGothicPr6N.ttc",
    "ToppanBunkyuMinchoPr6N.ttc",
    "TsukushiAMaruGothic.ttc",
    "TsukushiBMaruGothic.ttc",
    "YuMincho.ttc",
    "meiryo.ttc",
    "YuGothM.ttc",
    "yugothic.ttf",
    "msgothic.ttc",
    "IPAexGothic.ttf",
    "ipag.ttf"
  ],
  // --- Korean ---
  ko: [
    "NotoSansCJKkr-Regular.ttf",
    "NotoSansKR-Regular.ttf",
    "SourceHanSansKR-Regular.otf",
    "AppleSDGothicNeo.ttc",
    "AppleGothic.ttf",
    "AppleMyungjo.ttf",
    "NanumScript.ttc",
    "NanumMyeongjo.ttc",
    "malgun.ttf",
    "malgunbd.ttf",
    "gulim.ttc",
    "batang.ttc",
    "NanumGothic.ttc",
    "NanumGothic.ttf",
    "NanumMyeongjo.ttc"
  ]
};

/**
 * Family names to prefer for each language, used to pick between the faces of
 * one collection.
 *
 * A filename is not enough on its own: `STHeiti Light.ttc` holds `Heiti TC` at
 * face 0 and `Heiti SC` at face 1, and taking face 0 gave Simplified Chinese
 * documents Traditional punctuation placement. `Songti.ttc` holds eight faces
 * across both scripts. Naming the family is the only way to reach the right one.
 */
export const FAMILIES_BY_LANGUAGE: Record<CjkLanguage, readonly string[]> = {
  "zh-Hans": [
    // Serif (宋体) before sans, and the same three platforms therefore agree.
    //
    // A 宋体 is the conventional body face for Chinese print — the counterpart of a
    // serif for English — and this is a document library, not a UI toolkit. The old
    // order was sans throughout, which meant the choice of body face was decided by
    // whichever sans a given machine happened to ship, and differed by platform for
    // no stated reason.
    //
    // Within each group, a face someone installed outranks one the OS merely ships,
    // so an explicit `fonts-noto-cjk`-style install is still honoured.
    //
    // Why each OS entry is the right one under those rules:
    //
    //   - macOS `Songti SC`. `Heiti SC` is not merely a different taste: macOS
    //     ships exactly one face of it, `STHeitiSC-Medium`, so there is no Regular
    //     to choose and body text is set a weight too heavy.
    //   - Windows `SimSun`. Microsoft's own font list puts `Simsun.ttc` in the
    //     Windows 11 *base install* and describes the family as a mincho (serif)
    //     face, and `SimSun`/`NSimSun` are Regular. `Microsoft YaHei` is also in the
    //     base install but is a sans, so it now sits in the sans group.
    //     `DengXian` and `SimHei` moved below both: they ship in the "Chinese
    //     (Simplified) Supplemental Fonts" Feature On Demand package rather than the
    //     base install, so ranking them above a face that is always present was
    //     wrong twice over.
    //   - Linux `AR PL UMing`. `fonts-noto-cjk` is the usual CJK package but
    //     installs **CFF** collections that cannot be subset here (see the file list
    //     above), so the serif that actually works is `uming.ttc` from
    //     `fonts-arphic-uming`, which installs under `truetype/`. Several family
    //     spellings are listed because the collection carries a face per region.
    "Noto Serif SC",
    "Noto Serif CJK SC",
    "Source Han Serif SC",
    "Songti SC",
    "SimSun",
    "NSimSun",
    "AR PL UMing CN",
    "AR PL UMing",
    "AR PL ShanHeiSun Uni",
    "STSong",
    // Sans. Reached when no 宋体 is installed, and still the whole of the previous
    // behaviour — only its rank relative to the serif faces has changed.
    "Noto Sans SC",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "PingFang SC",
    "Heiti SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    "STHeiti",
    "WenQuanYi Micro Hei",
    "WenQuanYi Zen Hei",
    "Droid Sans Fallback",
    "Hei",
    // Windows Feature On Demand, so present only on a machine that installed the
    // Chinese supplemental fonts.
    "DengXian",
    "SimHei",
    // Display and calligraphic faces: coverage of last resort, never body text.
    // The macOS ones live under AssetsV2 and were unreachable until that directory
    // was scanned, so naming them here is what makes those faces usable rather
    // than merely present.
    "STFangsong",
    "Kaiti SC",
    "STKaiti",
    "Kai",
    "Yuanti SC",
    "Lantinghei SC",
    "Baoli SC",
    "Xingkai SC",
    "Libian SC"
  ],
  "zh-Hant": [
    // Serif (宋體/明體) first, mirroring `zh-Hans`.
    //
    //   - macOS `Songti TC`, which does carry a Regular (`STSongti-TC-Regular`),
    //     unlike `Heiti TC` whose best available face is `STHeitiTC-Medium` — the
    //     same missing-Regular defect that made `Heiti SC` wrong for body text.
    //     `LiSong Pro` (儷宋) is the older macOS serif and follows it.
    //   - Windows `PMingLiU`/`MingLiU` (明體). Note the platform limit: Microsoft's
    //     font list puts these in the "Chinese (Traditional) Supplemental Fonts"
    //     Feature On Demand package, while the base install carries only
    //     `Microsoft JhengHei` (a sans) and the Ext-B files. So a stock Windows
    //     reaches a serif for Traditional Chinese only when that package is present;
    //     ranking them here is what makes it work on a machine that has it.
    //   - Linux `uming.ttc` again, which carries the TW and HK faces alongside CN.
    "Noto Serif TC",
    "Noto Serif CJK TC",
    "Source Han Serif TC",
    "Songti TC",
    "LiSong Pro",
    "Apple LiSung",
    "PMingLiU",
    "MingLiU",
    "AR PL UMing TW",
    "AR PL UMing HK",
    "AR PL UMing",
    // Sans.
    "Noto Sans TC",
    "Noto Sans CJK TC",
    "Source Han Sans TC",
    "PingFang TC",
    "PingFang HK",
    "Heiti TC",
    "Microsoft JhengHei",
    "LiHei Pro",
    "Apple LiGothic",
    // Display and calligraphic faces: coverage of last resort.
    "Kaiti TC",
    "BiauKai",
    "Yuanti TC",
    "Baoli TC",
    "Xingkai TC",
    "Libian TC"
  ],
  // Japanese and Korean stay gothic-first, and that asymmetry with Chinese is
  // deliberate rather than an unfinished edit.
  //
  // The Chinese lists lead with a serif because 宋体/宋體 is the conventional body
  // face for Chinese documents — Word's own Simplified Chinese default was `SimSun`
  // for years. The equivalent claim does not hold here: the modern document default
  // for Japanese is a gothic (`Yu Gothic`) and for Korean `Malgun Gothic`, so leading
  // with Mincho or Myungjo would impose a choice the software these documents
  // interoperate with does not make. Serif faces stay in both lists, below the
  // gothics, so a caller who wants one can still reach it through
  // `preferSystemFonts`.
  ja: [
    "Hiragino Kaku Gothic ProN",
    "Hiragino Sans",
    "Noto Sans CJK JP",
    "Noto Sans JP",
    "Source Han Sans JP",
    "Yu Gothic",
    "Meiryo",
    "MS Gothic",
    "MS PGothic",
    "Osaka",
    // macOS ships these and they cover modern Japanese completely; without them
    // a Japanese document fell through to a Chinese face, which draws the shared
    // characters in the wrong hand — the very thing the language rule exists to
    // prevent.
    "BIZ UDGothic",
    "BIZ UDMincho",
    "BIZ UDPGothic",
    "BIZ UDPMincho",
    "Hiragino Maru Gothic ProN",
    "Hiragino Mincho ProN",
    "Klee",
    "Toppan Bunkyu Gothic",
    "Toppan Bunkyu Mincho",
    "Tsukushi A Round Gothic",
    "Tsukushi B Round Gothic",
    "YuKyokasho",
    "YuMincho",
    "IPAexGothic",
    "IPAGothic"
  ],
  ko: [
    "Apple SD Gothic Neo",
    "Noto Sans CJK KR",
    "Noto Sans KR",
    "Source Han Sans KR",
    "Malgun Gothic",
    "AppleGothic",
    "Gulim",
    "Batang",
    "NanumGothic",
    "NanumMyeongjo",
    "AppleMyungjo",
    "PCMyungjo",
    "GungSeo",
    "PilGi",
    "HeadLineA"
  ]
};

/**
 * Tried after every language group: broad-coverage faces that can draw the text
 * but not in any particular regional hand, then Latin-only faces that cover
 * Cyrillic, Greek and symbols.
 *
 * `Arial Unicode MS` used to be *first* in a single flat list, because it covers
 * almost every script in one file. That is why Chinese came out in Japanese
 * glyph forms: its CJK repertoire is Monotype's Japanese set, so 「者」「青」
 * 「每」were drawn the Japanese way on every Mac. It belongs here — when nothing
 * regional covers the text, correct-but-foreign beats `.notdef` boxes.
 */
const GENERIC_FALLBACK_FILES: readonly string[] = [
  "NotoSansCJK-Regular.ttc",
  "NotoSansCJKSC-Regular.otf",
  "Arial Unicode.ttf",
  "Arial Unicode MS.ttf",
  "ArialUnicode.ttf",
  "arialuni.ttf",
  // Latin-only from here: no CJK at all, but they cover Cyrillic/Greek/symbols.
  "NotoSans-Regular.ttf",
  "segoeui.ttf",
  "arial.ttf",
  "DejaVuSans.ttf",
  "LiberationSans-Regular.ttf",
  "FreeSans.ttf"
];

/**
 * The order languages are consulted when the text gives no evidence of its own.
 *
 * Chinese leads because it has the most writers, but the point of the ordering
 * is narrower than that: *any* fixed order that keeps the four groups apart
 * stops a Japanese face being chosen for Chinese merely because it was installed
 * and covered the code points. That was the actual defect.
 */
const LANGUAGE_ORDER: readonly CjkLanguage[] = ["zh-Hans", "zh-Hant", "ja", "ko"];

/**
 * Candidate filenames in the order they are tried, for a given language.
 *
 * The language's own faces come first, then the other languages in a fixed
 * order, then the broad-coverage fallbacks. Duplicates are dropped, keeping the
 * earliest position.
 *
 * @internal Exported for the ordering regression test.
 */
export function preferredFontFiles(language?: CjkLanguage): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (files: readonly string[]): void => {
    for (const file of files) {
      if (!seen.has(file)) {
        seen.add(file);
        out.push(file);
      }
    }
  };
  if (language) {
    push(FONT_FILES_BY_LANGUAGE[language]);
  }
  for (const lang of LANGUAGE_ORDER) {
    push(FONT_FILES_BY_LANGUAGE[lang]);
  }
  push(GENERIC_FALLBACK_FILES);
  return out;
}

/**
 * Every candidate filename, in the default (no-language) order.
 *
 * @internal Exported for the ordering regression test.
 */
export const PREFERRED_FONTS: readonly string[] = preferredFontFiles();

// =============================================================================
// Font Discovery
// =============================================================================

/**
 * One selectable face: the bytes of a `.ttf`/`.ttc` file plus the index of the
 * face within it.
 *
 * Discovery yields a candidate per *face*, not per file, because a collection's
 * faces are not interchangeable — they differ in coverage (macOS `Songti.ttc`:
 * 8,535 glyphs in face 0, 43,033 in face 1) and in regional glyph conventions
 * (`STHeiti Light.ttc` is Heiti TC at face 0 and Heiti SC at face 1, which
 * differ in full-width punctuation placement).
 */
export interface SystemFontCandidate {
  /**
   * The font file's bytes.
   *
   * For a candidate discovered on disk this is a **lazy** property: the file is
   * read on first access and not before. Enumerating every face on this machine
   * yields 853 candidates across 1.5 GB of font files, so a candidate that eagerly
   * carried its bytes made `discoverSystemFontCandidates()` allocate the entire
   * font library — enough to exhaust a 4 GB heap. Selection only ever parses the
   * few candidates it actually reaches.
   */
  readonly data: Uint8Array;
  readonly collectionIndex: number;
  /**
   * True when this face came from the curated filename list rather than from the
   * recursive directory sweep.
   *
   * Selection uses it as a budget: the sweep reads hundreds of megabytes on
   * macOS and Windows, so a search that wants to compare candidates against each
   * other (picking the best family for a language rather than the first face that
   * covers the text) confines itself to the cheap half and only falls through to
   * the sweep when nothing there can draw the text at all.
   */
  readonly preferred: boolean;
  /**
   * Where the file came from, when it came from disk.
   *
   * Only used to remember that a face could not be parsed, so a later search
   * skips it instead of reading and rejecting it again. Absent for candidates
   * injected by a test.
   */
  readonly path?: string;
}

// Candidates injected by a test, standing in for the host's fonts.
//
// The only writer is `_setCandidatesForTest`; nothing populates it from a real
// scan. Enumerating for real is deliberately *not* cached — see
// `discoverSystemFontCandidates` — so this is an override slot rather than a
// discovery cache. What is genuinely cached is the metadata: `_pathIndex`,
// `_faceMeta`, `_faceCounts` and `_unusableFaces`.
let _cachedCandidates: SystemFontCandidate[] | undefined;

/**
 * Font file paths on this host, discovered once.
 *
 * Enumerating them means `readdir` over every system font directory — and on
 * macOS that now includes the on-demand `AssetsV2` tree. The result does not
 * depend on the language being asked for, so it is cached independently of the
 * *order* candidates are yielded in: a later request for a different language
 * re-sorts this list rather than walking the filesystem again.
 *
 * Before this, only a search that ran to completion cached anything, so every
 * search that ended in failure — an uninstalled `preferSystemFonts` family, or a
 * document with a code point no font covers — repeated the whole sweep. Measured
 * at 450–735 ms, paid again on every export.
 */
let _pathIndex: { readonly preferred: Map<string, string[]>; readonly swept: string[] } | undefined;

/**
 * Paths that cannot yield a usable face, so they are never read or parsed twice.
 *
 * This is where the real cost of a failed search sits: `AssetsV2` alone holds 46
 * CFF-flavoured files, several of them tens of megabytes, and each one was read
 * from disk and handed to `parseTtf` only to be rejected — once per search.
 */
const _unusableFaces = new Set<string>();
/**
 * What a face turned out to be, keyed like {@link _unusableFaces}.
 *
 * Metadata only — a family name and a weight class, never the font's bytes. It
 * lets a later search rank a face without re-reading and re-parsing the file,
 * which is what made every export re-derive the same answer from scratch.
 */
const _faceMeta = new Map<string, { family: string; weight: number }>();

/**
 * Face counts per path, so re-enumerating does not re-read a file to count them.
 */
const _faceCounts = new Map<string, number>();

/**
 * The font file being read right now.
 *
 * Enumeration visits a collection's faces consecutively, so a single slot removes
 * the repeated reads a lazy `data` would otherwise cause. It is scoped to one
 * search and released by {@link releaseFontReadBuffer} when that search ends: a
 * CJK font is tens of megabytes, and holding the last one read kept 108 MB alive
 * for the life of the process — for a cache that only ever helps *within* a
 * single enumeration.
 */
let _lastRead: { path: string; data: Uint8Array } | undefined;

/** Drop the read buffer. Called when a search completes. */
function releaseFontReadBuffer(): void {
  _lastRead = undefined;
}

function readFontCached(path: string): Uint8Array | null {
  if (_lastRead?.path === path) {
    return _lastRead.data;
  }
  const data = tryReadFont(path);
  if (data) {
    _lastRead = { path, data };
  }
  return data;
}

/** Cache key for one face of one file. */
function faceKey(path: string, index: number): string {
  return `${path}#${index}`;
}

/**
 * Expand one font file into a candidate per face, so a caller filtering by
 * coverage or family name can reach faces past the first.
 *
 * A file whose collection header will not parse still yields face 0: the
 * coverage check is the real gate, and letting `parseTtf` produce the error
 * keeps the reason for skipping a file in one place.
 */
function* expandFacesAtPath(
  path: string,
  preferred: boolean
): Generator<SystemFontCandidate, void, void> {
  let faces = _faceCounts.get(path);
  if (faces === undefined) {
    const data = readFontCached(path);
    if (!data) {
      return;
    }
    try {
      faces = countTtfFaces(data);
    } catch {
      faces = 1;
    }
    _faceCounts.set(path, faces);
  }
  for (let i = 0; i < faces; i++) {
    // A face already proven unparseable is not offered again. Without this, a
    // failed search re-read and re-parsed every CFF file on the host — 46 of them
    // under AssetsV2, several tens of megabytes each.
    if (_unusableFaces.has(faceKey(path, i))) {
      continue;
    }
    yield {
      collectionIndex: i,
      preferred,
      path,
      get data(): Uint8Array {
        return readFontCached(path) ?? new Uint8Array(0);
      }
    };
  }
}

/** Faces of an in-memory font, for test-injected candidates. */
function* expandFaces(
  data: Uint8Array,
  preferred: boolean
): Generator<SystemFontCandidate, void, void> {
  let faces: number;
  try {
    faces = countTtfFaces(data);
  } catch {
    faces = 1;
  }
  for (let i = 0; i < faces; i++) {
    yield { data, collectionIndex: i, preferred };
  }
}

/**
 * Lazily yield discoverable system font candidates, in preference order.
 *
 * Each entry names a single face (see {@link SystemFontCandidate}).
 * The caller decides which candidate to use (e.g. by checking cmap coverage).
 *
 * Iterating one candidate at a time lets callers `break` as soon as
 * they find a match, avoiding the cost of recursively reading every
 * font in every system font directory just to discard them.
 */
function* iterateSystemFontCandidates(
  language?: CjkLanguage
): Generator<SystemFontCandidate, void, void> {
  // Fast path: a previous call already produced the full snapshot.
  if (_cachedCandidates !== undefined) {
    for (const c of _cachedCandidates) {
      yield c;
    }
    return;
  }

  if (typeof process === "undefined" || !process.platform) {
    return;
  }

  const index = (_pathIndex ??= buildPathIndex());
  const seen = new Set<string>(); // dedupe by path within this iteration

  // Strategy 1: the curated filenames, in the order this language wants them.
  // Looked up in the index rather than stat-ed per directory, so re-ordering for
  // a different language costs nothing.
  for (const fontName of preferredFontFiles(language)) {
    for (const fontPath of index.preferred.get(fontName.toLowerCase()) ?? []) {
      if (seen.has(fontPath)) {
        continue;
      }
      seen.add(fontPath);
      yield* expandFacesAtPath(fontPath, true);
    }
  }

  // Strategy 2: everything else found by the sweep. A caller that matched in
  // Strategy 1 never gets here.
  for (const fontPath of index.swept) {
    if (seen.has(fontPath)) {
      continue;
    }
    seen.add(fontPath);
    yield* expandFacesAtPath(fontPath, false);
  }
}

/**
 * Walk the system font directories once, indexing what is there.
 *
 * `preferred` maps a lower-cased filename to every path holding it, so the
 * curated list can be consulted without a `stat` per name per directory.
 * `swept` is everything else, ordered as the recursive scan used to yield it:
 * broad-coverage names first, then files large enough to be worth opening.
 */
/**
 * Configured directories with any that another one already contains removed.
 *
 * The lists name both a root and some of its own subdirectories —
 * `/System/Library/Fonts` and `/System/Library/Fonts/Supplemental`, and several
 * `/usr/share/fonts/*` under `/usr/share/fonts`. The traversal is recursive, so
 * the nested entry re-reads files the root already produced: 253 duplicate
 * `lstat`s on this machine. Deduplicating the results afterwards hid the cost
 * rather than avoiding it.
 *
 * Containment is tested for either separator because the Windows list is built
 * with `\`.
 */
function rootFontDirs(): string[] {
  const dirs = getSystemFontDirs();
  const isSep = (c: string): boolean => c === "/" || c === "\\";
  const normalised = dirs.map(d => (d.length > 1 && isSep(d[d.length - 1]) ? d.slice(0, -1) : d));
  return normalised.filter(
    (dir, i) =>
      !normalised.some(
        (other, j) =>
          j !== i && dir.length > other.length && dir.startsWith(other) && isSep(dir[other.length])
      )
  );
}

/**
 * Lower-cased final path segment, for either separator.
 *
 * Splitting on `/` alone left a Windows path as its own basename
 * (`c:\windows\fonts\arial.ttf`), so every curated filename missed and the
 * whole platform fell through to the recursive sweep — where a regional family
 * can lose to whichever covering face happens to be read first.
 */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(cut + 1).toLowerCase();
}

function buildPathIndex(): { preferred: Map<string, string[]>; swept: string[] } {
  const preferred = new Map<string, string[]>();
  const swept: string[] = [];
  const seen = new Set<string>();
  const broadRe =
    /noto|unicode|cjk|yahei|heiti|gothic|sans|serif|ming|song|dejavu|liberation|droid|wqy/i;

  for (const dir of rootFontDirs()) {
    let entries: FileEntry[];
    try {
      // No `filter` here. `traverseDirectorySync` applies it before deciding
      // whether to recurse, so `e => !e.isDirectory` excluded directories from the
      // *walk* rather than from the results — it never descended at all, and
      // `/System/Library/Fonts/Supplemental` (253 fonts, including Songti.ttc) was
      // reachable only because the list happened to name it separately. Filtering
      // afterwards is what makes the traversal actually recursive.
      entries = traverseDirectorySync(dir, { recursive: true });
    } catch {
      continue; // missing or unreadable
    }
    const fonts = entries.filter(e => !e.isDirectory && /\.tt[cf]$/i.test(e.absolutePath));
    const broad = fonts.filter(e => broadRe.test(e.absolutePath));
    const rest = fonts.filter(e => !broadRe.test(e.absolutePath) && e.size > 50000);

    for (const entry of fonts) {
      const name = baseName(entry.absolutePath);
      const paths = preferred.get(name);
      if (paths) {
        paths.push(entry.absolutePath);
      } else {
        preferred.set(name, [entry.absolutePath]);
      }
    }
    for (const entry of [...broad, ...rest]) {
      if (!seen.has(entry.absolutePath)) {
        seen.add(entry.absolutePath);
        swept.push(entry.absolutePath);
      }
    }
  }
  return { preferred, swept };
}

/**
 * Return all discoverable system font candidates, ordered by preference.
 *
 * Each entry names a single face (see {@link SystemFontCandidate}).
 * The caller decides which candidate to use (e.g. by checking cmap coverage).
 *
 * The result is **not** cached — see the note in the body — so each call walks
 * the font directories again. Selection does not use this function; it iterates
 * lazily and stops at the first match, which is why nothing pays for the walk.
 */
export function discoverSystemFontCandidates(): SystemFontCandidate[] {
  if (_cachedCandidates !== undefined) {
    return _cachedCandidates;
  }
  // Deliberately **not** cached. The snapshot holds every font file's bytes:
  // measured on this machine, 415 candidates across 118 distinct buffers totalling
  // 1,546 MB. Keeping that for the lifetime of the process to save a rescan is the
  // wrong trade, and nothing in the library needs it — selection iterates lazily
  // and stops at the first match, so this function exists for tests and for
  // callers enumerating deliberately. What *is* cached is the path index, which is
  // the part that costs I/O rather than memory.
  const all: SystemFontCandidate[] = [];
  for (const candidate of iterateSystemFontCandidates()) {
    all.push(candidate);
  }
  // The read buffer only ever helps *within* one enumeration — it exists so the
  // faces of a single `.ttc` are read once. Past the end of the walk it is simply
  // whichever file happened to be last, held until the next reset; on this machine
  // that is 1.2 MB, but the same slot holds tens of megabytes when the last file is
  // a CJK collection. The returned candidates read lazily, so dropping it costs a
  // re-read only if someone actually asks for that face's bytes.
  releaseFontReadBuffer();
  return all;
}

/**
 * Search for a system font suitable for Unicode rendering.
 *
 * Returns the highest-priority candidate face, or `null` if no font was found.
 */
export function discoverSystemFont(): SystemFontCandidate | null {
  const candidates = discoverSystemFontCandidates();
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Find a system font for `codePoints`, and return it parsed.
 *
 * This is the single selection rule used by every auto-embed path (the
 * spreadsheet exporter, the Word bridge, and `PdfDocumentBuilder.build()`), so
 * they all agree on which font a document ends up with. Candidates that fail to
 * parse are skipped — which is how CFF-flavoured faces such as PingFang are
 * passed over.
 *
 * Selection is by **language first, coverage second**. Coverage alone is what
 * made Chinese come out in Japanese glyph forms: Unicode Han Unification gives
 * the two the same code points, so a Japanese face "covers" Chinese text and a
 * first-match-wins scan happily used it. `language` picks the regional hand —
 * `zh-Hans` chooses `Heiti SC` over `Heiti TC` from the same `.ttc`, and a
 * Japanese face is only reached once nothing Chinese can draw the text.
 *
 * **A face is required to cover the East Asian text, not every code point.** Those
 * are the characters nothing else can draw; a symbol is drawn by the Type3 path,
 * which has a glyph for every arrow, box-drawing character, dingbat and enclosed
 * numeral and none for any ideograph. Demanding total coverage inverted the rule
 * above: a page of Chinese carrying `☑` and `☐` — absent from every macOS Chinese
 * face — disqualified all of them and settled on `Arial Unicode MS`, drawing 508
 * Chinese characters in a Japanese hand because of two checkboxes. When the text
 * contains no East Asian characters at all there is no regional hand to protect,
 * and total coverage is required as before.
 *
 * `preferredFamilies` is the caller's own list and outranks everything: it is
 * matched case-insensitively, in order, across every candidate. A family that is
 * not installed, cannot be parsed, or cannot draw the East Asian text is skipped
 * and the built-in order applies — this steers a best-effort search rather than
 * constraining it. Use `embedFonts()` when a face is a requirement.
 *
 * Returns `null` only when `codePoints` is empty or nothing installed can draw any
 * of them — the caller then falls back to Type3 glyphs (and should warn, since
 * uncovered code points render as NOTDEF boxes). Code points the returned face
 * lacks take the same Type3 route; `FontManager.getUncoveredFallbackCodePoints`
 * reports them.
 *
 * **Partial coverage wins over no coverage.** A face that draws most of the text is
 * returned when none draws all of it, because the alternative is not "a better font"
 * but *no* font: every character goes to Type3 and a page of Chinese becomes boxes
 * because of the one emoji no installed face carries. Only a face that covers
 * nothing essential is refused.
 */
export function findSystemFontForCodePoints(
  codePoints: ReadonlySet<number>,
  preferredFamilies: readonly string[] = [],
  language?: CjkLanguage
): TtfFont | null {
  try {
    return selectSystemFont(codePoints, preferredFamilies, language);
  } finally {
    // The chosen face keeps its own bytes; nothing else needs the read buffer.
    releaseFontReadBuffer();
  }
}

function selectSystemFont(
  codePoints: ReadonlySet<number>,
  preferredFamilies: readonly string[],
  language: CjkLanguage | undefined
): TtfFont | null {
  if (codePoints.size === 0) {
    return null;
  }
  const wanted = [...codePoints].sort((a, b) => a - b);
  const requestedFamilies = preferredFamilies
    .map(name => name.trim().toLowerCase())
    .filter(name => name.length > 0);
  // A glyphless control is never asked of a face, here or anywhere else. See
  // `essential` below for what demanding one cost.
  const covers = (ttf: TtfFont): boolean =>
    wanted.every(cp => isGlyphlessControl(cp) || ttf.cmap.has(cp));

  /**
   * The code points that decide whether a face is usable at all.
   *
   * Requiring *every* code point is what made this function contradict its own
   * documented rule of language first, coverage second. A document of Chinese
   * prose carrying two task-list checkboxes — `☑` and `☐`, which no macOS Chinese
   * face has — disqualified every Chinese font and left `Arial Unicode MS`, whose
   * Han glyphs follow Japanese conventions: 者 gains a dot, and 径, 前 and 母 are
   * drawn with a different number of strokes. Two symbols therefore decided the
   * shape of 508 Chinese characters, silently, which is precisely the failure the
   * `language` parameter exists to prevent.
   *
   * The symbols never needed the face: Type3 draws them. So coverage of East
   * Asian text is the requirement, and coverage of the rest is a preference.
   *
   * **A glyphless control is excluded, and leaving it in was catastrophic.** The
   * Type3 repertoire is a set of *drawings*, so it has no entry for U+FE0F — which
   * made a variation selector "essential" and demanded a glyph for it. Practically
   * no CJK face carries one, so a single `⚠️` disqualified every font on the
   * machine, this function returned `null`, and a whole document of Chinese fell to
   * Type3 and rendered as `.notdef` boxes. One invisible code point therefore lost
   * every visible one. `isGlyphlessControl` is the same set the embedder folds into
   * the preceding glyph and the renderer strips before drawing — it is not a glyph,
   * so no face can be judged by it.
   */
  const essential = wanted.filter(cp => requiresEmbeddedFace(cp) && !isGlyphlessControl(cp));

  /** Essential code points `ttf` cannot draw. Zero means it qualifies outright. */
  const missingEssential = (ttf: TtfFont): number => {
    let missing = 0;
    for (const cp of essential) {
      if (!ttf.cmap.has(cp)) {
        missing++;
      }
    }
    return missing;
  };

  /**
   * Whether `ttf` can draw everything that only a font can draw.
   *
   * With no East Asian text there is no regional hand to get wrong and no Type3
   * gap to tolerate, so the original all-or-nothing rule applies unchanged —
   * otherwise the first candidate would win while covering nothing at all.
   */
  const coversEssential = (ttf: TtfFont): boolean =>
    essential.length === 0 ? covers(ttf) : missingEssential(ttf) === 0;

  const parse = (candidate: SystemFontCandidate): TtfFont | null => {
    try {
      const ttf = parseTtf(candidate.data, candidate.collectionIndex);
      if (candidate.path !== undefined) {
        // Remember what this face *is*, so a later search can rank it without
        // reading and parsing the file again. Two strings and a number per face,
        // not the font's bytes.
        _faceMeta.set(faceKey(candidate.path, candidate.collectionIndex), {
          family: ttf.familyName.trim().toLowerCase(),
          weight: ttf.weightClass
        });
      }
      return ttf;
    } catch {
      // Not a usable face — CFF, bitmap-only, or corrupt. Remembered so a later
      // search skips it instead of reading and rejecting the same file again.
      if (candidate.path !== undefined) {
        _unusableFaces.add(faceKey(candidate.path, candidate.collectionIndex));
      }
      return null;
    }
  };

  // 1. The caller's explicit list. Worth scanning everything for, because they
  //    asked for a specific face by name.
  const requested = requestedFamilies;
  if (requested.length > 0) {
    let best: TtfFont | null = null;
    let bestRank = requested.length;
    for (const candidate of iterateSystemFontCandidates(language)) {
      // A face whose family an earlier search already identified can be ranked
      // without parsing it. A family the caller did not ask for is rejected below
      // anyway, so naming a font that is not installed — a typo, or a family from
      // another platform — no longer reads and parses every font on the machine.
      if (candidate.path !== undefined) {
        const known = _faceMeta.get(faceKey(candidate.path, candidate.collectionIndex));
        if (known !== undefined) {
          const knownRank = requested.indexOf(known.family);
          const canWin =
            knownRank >= 0 &&
            (knownRank < bestRank ||
              (knownRank === bestRank &&
                (best === null ||
                  Math.abs(known.weight - 400) < Math.abs(best.weightClass - 400))));
          if (!canWin) {
            continue;
          }
        }
      }
      const ttf = parse(candidate);
      if (ttf === null) {
        continue;
      }
      const rank = requested.indexOf(ttf.familyName.trim().toLowerCase());
      if (rank < 0 || rank > bestRank || !coversEssential(ttf)) {
        continue;
      }
      // Same family, so the weight decides. A collection can list its heaviest
      // face first — macOS `Songti.ttc` starts with `Songti SC` Black — and taking
      // whichever came first set a whole document in it.
      if (rank === bestRank && best !== null && !isCloserToRegular(ttf, best)) {
        continue;
      }
      best = ttf;
      bestRank = rank;
      // The caller's first choice at a regular weight cannot be beaten, so stop
      // rather than finish a recursive scan of every system font directory.
      if (rank === 0 && isUnbeatableWeight(ttf)) {
        return ttf;
      }
    }
    if (best !== null) {
      return best;
    }
  }

  // 2. The language's own families, then plain coverage. Both are answered in a
  //    single pass over the candidates, and the pass stops at the end of the
  //    curated filenames if it found anything at all — comparing candidates is
  //    only worth a recursive sweep of every font directory when nothing cheap
  //    can draw the text.
  //
  //    With no language, Simplified Chinese families are still preferred. Text
  //    that carries no evidence needs *some* answer, and taking the first face
  //    that covers it means taking whichever face happens to sit at index 0 of a
  //    collection — which is `Heiti TC` in macOS's `STHeiti Light.ttc`, so
  //    Simplified documents got Traditional punctuation placement for no reason.
  //    Chromium resolves the same ambiguity the same way (`ComputeScriptForHan`
  //    falls back to `USCRIPT_SIMPLIFIED_HAN`).
  const regional = FAMILIES_BY_LANGUAGE[language ?? "zh-Hans"].map(n => n.toLowerCase());
  let regionalBest: TtfFont | null = null;
  let regionalRank = regional.length;
  let firstCovering: TtfFont | null = null;
  /**
   * The best face that draws *some* of the text, used only when none draws all of it.
   *
   * Returning `null` because no face is perfect is the worst available outcome: it
   * sends every character to Type3, so a document loses the 500 ideographs a face
   * had glyphs for because of the one emoji it did not. Nothing regional is at
   * stake either — a partial face is only consulted once every full candidate has
   * failed — so more coverage simply wins, and a tie is broken the way every other
   * comparison here is, by regional rank and then by weight.
   */
  let partialBest: { ttf: TtfFont; missing: number; rank: number } | null = null;

  for (const candidate of iterateSystemFontCandidates(language)) {
    if (!candidate.preferred && (regionalBest !== null || firstCovering !== null)) {
      break; // the sweep begins here and we already have an answer
    }
    // A merely *partial* face is deliberately not an answer for this test. It is a
    // fallback for having found nothing, so it is worth the sweep to look for a face
    // that covers the text properly — a cost paid only by a document that would
    // otherwise have rendered as boxes.
    // Skip a face that cannot change the answer, using what an earlier search
    // already learned about it.
    //
    // The rank-0 early return below is the intended exit, and on macOS it is dead:
    // `FAMILIES_BY_LANGUAGE["zh-Hans"][0]` is PingFang SC, whose only files are CFF
    // and Apple's private `hvgl`, so it never parses and the rank never reaches 0.
    // Every export therefore read and parsed the whole curated list — 65 faces and
    // 215 ms, repeated identically for the next document because the answer
    // (`Heiti SC`) does not depend on which characters were asked for.
    //
    // This prunes rather than caches a result: once a regional family is in hand,
    // `firstCovering` can no longer affect the return value (`regionalBest ??
    // firstCovering`), so any face that cannot outrank the incumbent — a worse
    // rank, an equal rank with no better weight, or no regional rank at all — is
    // not worth parsing. The chosen face is identical either way.
    if (regionalBest !== null && candidate.path !== undefined) {
      const known = _faceMeta.get(faceKey(candidate.path, candidate.collectionIndex));
      if (known !== undefined) {
        const knownRank = regional.indexOf(known.family);
        const canOutrank =
          knownRank >= 0 &&
          (knownRank < regionalRank ||
            (knownRank === regionalRank &&
              Math.abs(known.weight - 400) < Math.abs(regionalBest.weightClass - 400)));
        if (!canOutrank) {
          continue;
        }
      }
    }
    const ttf = parse(candidate);
    if (ttf === null) {
      continue;
    }
    if (!coversEssential(ttf)) {
      // Not good enough to win, but better than nothing if nothing else qualifies.
      const missing = missingEssential(ttf);
      const rank = regional.indexOf(ttf.familyName.trim().toLowerCase());
      const rankOf = (value: number): number => (value < 0 ? regional.length : value);
      if (
        missing < essential.length &&
        (partialBest === null ||
          missing < partialBest.missing ||
          (missing === partialBest.missing &&
            (rankOf(rank) < rankOf(partialBest.rank) ||
              (rankOf(rank) === rankOf(partialBest.rank) &&
                isCloserToRegular(ttf, partialBest.ttf)))))
      ) {
        partialBest = { ttf, missing, rank };
      }
      continue;
    }
    if (regional.length > 0) {
      const rank = regional.indexOf(ttf.familyName.trim().toLowerCase());
      if (rank === 0 && isUnbeatableWeight(ttf)) {
        return ttf;
      }
      if (
        rank >= 0 &&
        (rank < regionalRank ||
          (rank === regionalRank && regionalBest !== null && isCloserToRegular(ttf, regionalBest)))
      ) {
        regionalBest = ttf;
        regionalRank = rank;
      }
    }
    // The last resort, reached only when no regional family qualifies, so it keeps
    // the stricter rule: a face chosen on coverage alone has no regional claim to
    // make, and the point of taking it is that it can draw everything.
    if (
      covers(ttf) &&
      (firstCovering === null ||
        (isCloserToRegular(ttf, firstCovering) && ttf.familyName === firstCovering.familyName))
    ) {
      firstCovering = ttf;
    }
  }

  return regionalBest ?? firstCovering ?? partialBest?.ttf ?? null;
}

/**
 * Whether this face's weight cannot be beaten, so the search may stop.
 *
 * Exactly 400. The tolerant version of this test — anything from 350 to 450 —
 * contradicted the rule the very next function states: a 350 face returned
 * immediately and a true Regular later in the same collection never got to
 * compete, so `[Light, Regular]` chose Light and `[Medium, Regular]` chose Medium.
 * Only distance zero is unbeatable; a near-Regular is still recorded as the
 * incumbent by {@link isCloserToRegular} and wins if nothing better turns up.
 */
function isUnbeatableWeight(ttf: TtfFont): boolean {
  return ttf.weightClass === 400;
}

/**
 * Whether `candidate` is a better weight than `incumbent` for body text.
 *
 * Distance from 400 decides, so Regular beats Light beats Bold beats Black. Ties
 * keep the incumbent, which preserves discovery order.
 */
function isCloserToRegular(candidate: TtfFont, incumbent: TtfFont): boolean {
  return Math.abs(candidate.weightClass - 400) < Math.abs(incumbent.weightClass - 400);
}

/**
 * Reset the cached font discovery result (for testing).
 */
export function resetFontDiscoveryCache(): void {
  _cachedCandidates = undefined;
  _faceMeta.clear();
  _pathIndex = undefined;
  _unusableFaces.clear();
  _faceCounts.clear();
  _lastRead = undefined;
}

/**
 * Whether a font file's bytes are currently held in the read buffer (for testing).
 *
 * The invariant is about *retention*, and a memory delta cannot express it: without
 * a forced collection the numbers measure whatever the collector has not got round
 * to yet, which differs by Node version. This reports the state directly.
 */
export function _isReadBufferHeldForTest(): boolean {
  return _lastRead !== undefined;
}

/**
 * Override the cached candidates with a custom list (for testing).
 *
 * Raw `Uint8Array` entries are expanded to one candidate per face, so a test
 * can keep handing over font bytes without naming an index.
 *
 * Call {@link resetFontDiscoveryCache} to clear the override.
 */
export function _setCandidatesForTest(
  candidates: readonly (Uint8Array | SystemFontCandidate)[]
): void {
  // Injected candidates come from a different set of faces, so anything learned
  // about the real ones no longer applies. `_faceMeta` is keyed by path and face
  // index just like `_unusableFaces`, so a second injection reusing a path would
  // otherwise be ranked by the *previous* face's family — and the search would
  // prune away the very face the test had just installed.
  _unusableFaces.clear();
  _faceMeta.clear();
  const expanded: SystemFontCandidate[] = [];
  for (const c of candidates) {
    if (c instanceof Uint8Array) {
      expanded.push(...expandFaces(c, true));
    } else {
      expanded.push(c);
    }
  }
  _cachedCandidates = expanded;
}

// =============================================================================
// Internal
// =============================================================================

function tryReadFont(fontPath: string): Uint8Array | null {
  try {
    return readFileBytesSync(fontPath);
  } catch {
    return null;
  }
}
