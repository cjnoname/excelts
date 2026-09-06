/**
 * Package check: is this an XLSB package, and what is each of its parts?
 *
 * Runs first, and its failures are terminal for the rest: there is no point checking
 * record streams in something that is not a workbook. Deliberately thin — the OOXML
 * relationship graph is already checked by `ooxml-validator`, and duplicating it here
 * would create two places to fix the same bug.
 *
 * What *is* specific to XLSB is which parts are record streams, and that turns out to be
 * the whole difficulty. `.bin` is not a format, it is an extension: in an Excel-authored
 * workbook it covers the workbook, the worksheets, the styles, the shared strings, Excel's
 * own row index, the calculation chain, a DEVMODE printer struct and an OLE2 compound
 * document. Only the first six are records. The answer is in the content types, so that is
 * where it is read from — see `roles.ts`.
 */

import { extractAll } from "@archive/unzip/extract";
import { fromContentTypesPartName } from "@excel/utils/ooxml-paths";
// Reused rather than reimplemented: namespace-tolerant attribute and child lookup is
// exactly the same job here as in the OOXML validator, and a second copy would be a
// second place for the prefix handling to be subtly wrong.
import {
  attrByLocalName,
  findChildrenLocal,
  tryParseXml
} from "@excel/utils/ooxml-validator/xml-utils";
import type { XlsbReporter } from "@excel/utils/xlsb-validator/reporter";
import { isRecordStream, partRole, type XlsbPartRole } from "@excel/utils/xlsb-validator/roles";
import { RelType } from "@excel/xlsx/rel-type";

const WORKBOOK_PART = "xl/workbook.bin";
const CONTENT_TYPES = "[Content_Types].xml";

/**
 * Content types Excel accepts for an XLSB workbook part, lower-cased.
 *
 * Three, because macro-enabled workbooks, templates and add-ins each declare their own and
 * a package whose declared type disagrees with its extension is rejected.
 */
const WORKBOOK_CONTENT_TYPES = new Set([
  "application/vnd.ms-excel.sheet.binary.macroenabled.main",
  "application/vnd.ms-excel.template.macroenabled.main",
  "application/vnd.ms-excel.addin.macroenabled.main"
]);

export interface ContentTypeDeclarations {
  /** `Override` content types, keyed by lower-cased part path. */
  readonly overrides: ReadonlyMap<string, string>;
  /** `Default` content types, keyed by lower-cased extension. */
  readonly defaults: ReadonlyMap<string, string>;
}

export interface XlsbRecordStreamPart {
  readonly path: string;
  readonly role: XlsbPartRole;
  readonly bytes: Uint8Array;
}

export interface XlsbPackage {
  /** Every entry, keyed by zip-relative path. */
  readonly entries: ReadonlyMap<string, Uint8Array>;
  /**
   * Parts that are BIFF12 record streams, in path order.
   *
   * Not "the `.bin` parts": reading `vbaProject.bin` or `printerSettings1.bin` as a record
   * stream reports a framing error on a part that is perfectly valid.
   */
  readonly recordStreams: readonly XlsbRecordStreamPart[];
  /** False when the package is not usable and later checks should be skipped. */
  readonly usable: boolean;
}

export async function checkPackage(
  bytes: Uint8Array,
  reporter: XlsbReporter
): Promise<XlsbPackage> {
  let extracted: Map<string, Uint8Array>;
  try {
    const files = await extractAll(bytes);
    extracted = new Map([...files].map(([path, file]) => [path, file.data]));
  } catch (cause) {
    reporter.error(
      "package-unreadable",
      `not a readable ZIP package: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    return { entries: new Map(), recordStreams: [], usable: false };
  }

  const byLowerPath = new Map([...extracted.keys()].map(path => [path.toLowerCase(), path]));

  if (!byLowerPath.has(WORKBOOK_PART)) {
    reporter.error(
      "package-missing-workbook",
      `no ${WORKBOOK_PART}; an XLSB package stores the workbook as a binary part`
    );
    return { entries: extracted, recordStreams: [], usable: false };
  }

  const contentTypesPath = byLowerPath.get(CONTENT_TYPES.toLowerCase());
  let declarations: ContentTypeDeclarations = { overrides: new Map(), defaults: new Map() };
  if (contentTypesPath === undefined) {
    reporter.error("package-missing-content-types", `no ${CONTENT_TYPES}`);
  } else {
    declarations = parseContentTypes(extracted.get(contentTypesPath)!, reporter);
    checkContentTypes(declarations, extracted, reporter);
  }

  const recordStreams: XlsbRecordStreamPart[] = [];
  for (const path of [...extracted.keys()].sort()) {
    const role = partRole(path, effectiveContentType(path, declarations));
    if (isRecordStream(role)) {
      recordStreams.push({ path, role, bytes: extracted.get(path)! });
    }
  }
  return { entries: extracted, recordStreams, usable: true };
}

/**
 * A part's content type: its `Override`, or the `Default` for its extension.
 *
 * Both are needed. Excel declares the workbook part itself with
 * `<Default Extension="bin" …>` and no `Override`, so a check that consults only overrides
 * concludes the workbook is undeclared — on every file Excel writes.
 */
function effectiveContentType(
  path: string,
  declarations: ContentTypeDeclarations
): string | undefined {
  const override = declarations.overrides.get(path.toLowerCase());
  if (override) {
    return override;
  }
  const dot = path.lastIndexOf(".");
  return dot === -1 ? undefined : declarations.defaults.get(path.slice(dot + 1).toLowerCase());
}

function parseContentTypes(
  contentTypesXml: Uint8Array,
  reporter: XlsbReporter
): ContentTypeDeclarations {
  const overrides = new Map<string, string>();
  const defaults = new Map<string, string>();

  let malformed: Error | undefined;
  const document = tryParseXml(new TextDecoder().decode(contentTypesXml), error => {
    malformed = error;
  });
  if (!document?.root) {
    reporter.error(
      "package-missing-content-types",
      `${CONTENT_TYPES} is not well-formed: ${malformed?.message ?? "no root element"}`
    );
    return { overrides, defaults };
  }

  for (const node of findChildrenLocal(document.root, "Override")) {
    const partName = attrByLocalName(node, "PartName");
    const contentType = attrByLocalName(node, "ContentType");
    if (partName && contentType) {
      overrides.set(fromContentTypesPartName(partName).toLowerCase(), contentType);
    }
  }
  for (const node of findChildrenLocal(document.root, "Default")) {
    const extension = attrByLocalName(node, "Extension");
    const contentType = attrByLocalName(node, "ContentType");
    if (extension && contentType) {
      defaults.set(extension.toLowerCase(), contentType);
    }
  }
  return { overrides, defaults };
}

function checkContentTypes(
  declarations: ContentTypeDeclarations,
  entries: ReadonlyMap<string, Uint8Array>,
  reporter: XlsbReporter
): void {
  const workbookType =
    declarations.overrides.get(WORKBOOK_PART) ?? declarations.defaults.get("bin");
  if (!workbookType) {
    reporter.error(
      "package-missing-part",
      `${CONTENT_TYPES} declares no content type for /${WORKBOOK_PART}, by Override or by a ` +
        `Default for "bin"`
    );
  } else if (!WORKBOOK_CONTENT_TYPES.has(workbookType.toLowerCase())) {
    reporter.error(
      "package-wrong-content-type",
      `/${WORKBOOK_PART} resolves to ${workbookType}, which is not an XLSB workbook type`
    );
  }

  // **Every part needs a declaration**, not only the binary ones. OPC allows no exceptions, and Excel refuses a
  // package containing a part whose type it cannot resolve — which is how a header-picture VML with no `Default`
  // for its extension made a whole workbook unopenable while this check, restricted to `.bin`, passed.
  //
  // Two things are legitimately absent from the declarations: `[Content_Types].xml`, which declares and is not
  // declared, and the `_rels` parts, which the package format covers with a `Default` that Excel does write but
  // that nothing requires it to.
  for (const path of entries.keys()) {
    const lower = path.toLowerCase();
    if (lower === CONTENT_TYPES.toLowerCase() || lower.includes("_rels/")) {
      continue;
    }
    if (effectiveContentType(path, declarations) === undefined) {
      const dot = lower.lastIndexOf(".");
      const extension = dot === -1 ? "(none)" : lower.slice(dot + 1);
      reporter.error(
        "package-missing-part",
        `${path} has no content type: neither an Override nor a Default for "${extension}"`,
        { part: path }
      );
    }
  }

  checkRelationshipTargets(entries, reporter);
  checkKnownPartTypes(entries, declarations, reporter);
}

/**
 * Parts whose path implies a content type, checked against the one they were given.
 *
 * **"Has a content type" is not "has the right content type", and the difference cost a drawing.** Every
 * `chartEx*.xml`, `styleEx*.xml` and `colorsEx*.xml` fell through to the package's `Default` for `xml` —
 * `application/xml` — so the per-part check above answered yes for all of them while Excel could not tell a
 * chartEx from an arbitrary document, could not resolve the `graphicFrame` naming it, and reported
 * `Removed Part: /xl/drawings/drawingN.xml (Drawing shape)`.
 *
 * Only paths whose type is unambiguous are checked, and only when the declared type is wrong rather than merely
 * unknown: a part this library does not model is not a defect, but a `chartEx` declared as plain XML is.
 */
function checkKnownPartTypes(
  entries: ReadonlyMap<string, Uint8Array>,
  declarations: ContentTypeDeclarations,
  reporter: XlsbReporter
): void {
  for (const path of entries.keys()) {
    const expected = IMPLIED_PART_TYPES.find(entry => entry.test.test(path))?.type;
    if (expected === undefined) {
      continue;
    }
    const actual = effectiveContentType(path, declarations);
    if (actual !== expected) {
      reporter.error(
        "package-wrong-content-type",
        `${path} is declared ${actual ?? "(nothing)"} but its name says ${expected}`,
        { part: path }
      );
    }
  }
}

/** Paths whose content type is implied by their name, with the type Excel requires. All lowercase. */
const IMPLIED_PART_TYPES: readonly { readonly test: RegExp; readonly type: string }[] = [
  { test: /\/charts\/chartEx\d+\.xml$/, type: "application/vnd.ms-office.chartex+xml" },
  { test: /\/charts\/styleEx\d+\.xml$/, type: "application/vnd.ms-office.chartstyle+xml" },
  {
    test: /\/charts\/colorsEx\d+\.xml$/,
    type: "application/vnd.ms-office.chartcolorstyle+xml"
  },
  {
    test: /\/charts\/chart\d+\.xml$/,
    type: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
  }
];

/**
 * Every internal relationship must name a part the package contains.
 *
 * **This is the check that would have caught a whole class by itself.** The XLSB writer emitted a drawing
 * relationship targeting `../charts/chartEx1.xml` and never wrote that part — the modern chart types (waterfall,
 * funnel, treemap, sunburst, histogram, box plot, region map) are `chartEx`, and only the XLSX writer produces
 * them. Excel's answer was `Removed Part: /xl/drawings/drawing2.xml (Drawing shape)`: it discards the *drawing*,
 * because a drawing that points at nothing is not a drawing.
 *
 * Nothing here noticed. Every part present was well formed and declared, which is precisely the shape of defect
 * a per-part check cannot see — the fault is in the space *between* parts. A dangling reference is cheap to look
 * for and there is no legitimate reason to emit one.
 *
 * External relationships (`TargetMode="External"`) are skipped: their targets are URLs and file paths outside the
 * package, and resolving them is neither possible nor meaningful here.
 *
 * **The comparison is case-insensitive, and a real workbook proved it has to be.** OPC compares part names
 * without regard to ASCII case, and `cal-issue_419.xlsb` — written by Excel 12 — contains
 * `xl/SharedStrings.bin` while its relationship names `sharedStrings.bin`. Excel opens it. A case-sensitive
 * check called that file broken, which is the failure mode a validator can least afford: refusing something
 * Excel accepts teaches a caller to ignore it.
 */
function checkRelationshipTargets(
  entries: ReadonlyMap<string, Uint8Array>,
  reporter: XlsbReporter
): void {
  const present = new Set([...entries.keys()].map(path => path.toLowerCase()));
  for (const [path, data] of entries) {
    if (!path.toLowerCase().endsWith(".rels")) {
      continue;
    }
    // `xl/worksheets/_rels/sheet1.bin.rels` describes `xl/worksheets/sheet1.bin`, so a relative target resolves
    // against `xl/worksheets/`.
    const base = path.slice(0, path.lastIndexOf("_rels/"));
    let xml: string;
    try {
      xml = new TextDecoder("utf-8", { fatal: false }).decode(data);
    } catch {
      // An unreadable `.rels` is reported by the part checks above; nothing to resolve here.
      continue;
    }
    for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = match[0];
      if (/TargetMode\s*=\s*"External"/i.test(tag)) {
        continue;
      }
      const target = /Target\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
      if (target === undefined || target === "" || target.startsWith("#")) {
        continue;
      }
      // **The type, case-sensitively.** Relationship type URIs are compared exactly — unlike part names, which
      // are case-insensitive, and that asymmetry is the trap. A drawing named its `chartEx` part with
      // `…/office/drawing/2014/chartex` where the registered type is `…/office/2014/relationships/chartEx`, so
      // Excel could not resolve the `graphicFrame` and discarded the whole drawing: `Removed Part:
      // /xl/drawings/drawingN.xml (Drawing shape)`. The target existed and the part was well formed; only the
      // link's *label* was wrong, which no per-part check can see.
      //
      // Only a type that differs from a known one by case alone is reported. An unknown type is legitimate —
      // OPC is extensible and this library preserves relationships it does not model — but a *near-miss* is a
      // typo, and near-misses are the whole failure mode here.
      const type = /Type\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
      if (type !== undefined) {
        const known = KNOWN_REL_TYPES.get(type.toLowerCase());
        if (known !== undefined && known !== type) {
          reporter.error(
            "package-relationship-type-case",
            `${path} declares the type ${type}, which differs only in case from ${known} — ` +
              `relationship types are compared case-sensitively`,
            { part: path }
          );
        }
      }
      const resolved = resolveTarget(base, target);
      if (resolved !== undefined && !present.has(resolved.toLowerCase())) {
        reporter.error(
          "package-dangling-relationship",
          `${path} names ${target}, which resolves to ${resolved} — a part the package does not contain`,
          { part: path }
        );
      }
    }
  }
}

/** Every relationship type this library knows, by its lowercase form, for spotting a case-only typo. */
const KNOWN_REL_TYPES: ReadonlyMap<string, string> = new Map(
  Object.values(RelType).map(uri => [uri.toLowerCase(), uri])
);

/** A relationship target resolved to a package path, or `undefined` when it cannot be. */
function resolveTarget(base: string, target: string): string | undefined {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const segments = `${base}${target}`.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.pop() === undefined) {
        // Escaped the package root — a malformed target rather than a missing part.
        return undefined;
      }
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}
