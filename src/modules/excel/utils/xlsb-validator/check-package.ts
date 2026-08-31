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

  // Every binary part needs a declaration, by Override or by a `bin` Default.
  const hasBinDefault = declarations.defaults.has("bin");
  for (const path of entries.keys()) {
    if (!path.toLowerCase().endsWith(".bin")) {
      continue;
    }
    if (!declarations.overrides.has(path.toLowerCase()) && !hasBinDefault) {
      reporter.error(
        "package-missing-part",
        `${path} has no content type: neither an Override nor a Default for "bin"`,
        { part: path }
      );
    }
  }
}
