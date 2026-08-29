/**
 * DOCX Writers - Settings, Font Table, Core Properties, App Properties,
 * Theme, Document Background, Custom Properties
 *
 * Renders various auxiliary parts of the DOCX package.
 */

import { DEFAULT_OFFICE_THEME } from "@utils/theme-colors";
import {
  NS_W,
  NS_R,
  NS_M,
  NS_V,
  NS_O,
  NS_W14,
  NS_DC,
  NS_DCTERMS,
  NS_DCMITYPE,
  NS_CP,
  NS_EP,
  NS_VT,
  NS_XSI,
  NS_CUSTOM,
  STD_DOC_ATTRIBUTES
} from "@word/constants";
import { DocxRawXmlPolicyError } from "@word/errors";
import type {
  DocumentSettings,
  CoreProperties,
  AppProperties,
  FontDef,
  DocumentBackground,
  CustomProperty,
  FootnoteProperties,
  EndnoteProperties,
  DocumentTheme,
  ThemeFont,
  WebSettings,
  PersonInfo
} from "@word/types";
import type { XmlSink } from "@xml/types";

/** Render footnote/endnote properties in settings. */
function renderSettingsNoteProperties(
  xml: XmlSink,
  tagName: string,
  props: FootnoteProperties | EndnoteProperties
): void {
  xml.openNode(tagName);
  if (props.position) {
    xml.leafNode("w:pos", { "w:val": props.position });
  }
  if (props.numFmt) {
    xml.leafNode("w:numFmt", { "w:val": props.numFmt });
  }
  if (props.numStart !== undefined) {
    xml.leafNode("w:numStart", { "w:val": String(props.numStart) });
  }
  if (props.numRestart) {
    xml.leafNode("w:numRestart", { "w:val": props.numRestart });
  }
  xml.closeNode();
}

// =============================================================================
// Settings
// =============================================================================

/** Render word/settings.xml. */
export function renderSettings(
  xml: XmlSink,
  settings?: DocumentSettings,
  rawXmlPolicy?: "preserve" | "strip" | "reject"
): void {
  xml.openXml(STD_DOC_ATTRIBUTES);
  xml.openNode("w:settings", {
    "xmlns:w": NS_W,
    "xmlns:m": NS_M,
    "xmlns:r": NS_R,
    "xmlns:w14": NS_W14,
    "xmlns:o": NS_O,
    "xmlns:v": NS_V
  });

  if (settings?.zoom) {
    xml.leafNode("w:zoom", { "w:percent": String(settings.zoom) });
  }

  if (settings?.mirrorMargins) {
    xml.leafNode("w:mirrorMargins");
  }

  if (settings?.gutterAtTop) {
    xml.leafNode("w:gutterAtTop");
  }

  if (settings?.trackRevisions) {
    xml.leafNode("w:trackRevisions");
  }

  if (settings?.evenAndOddHeaders) {
    xml.leafNode("w:evenAndOddHeaders");
  }

  xml.leafNode("w:defaultTabStop", { "w:val": String(settings?.defaultTabStop ?? 720) });
  xml.leafNode("w:characterSpacingControl", {
    "w:val": settings?.characterSpacingControl ?? "doNotCompress"
  });

  // Extended settings flags
  if (settings?.doNotTrackMoves) {
    xml.leafNode("w:doNotTrackMoves");
  }
  if (settings?.doNotTrackFormatting) {
    xml.leafNode("w:doNotTrackFormatting");
  }
  if (settings?.doNotDemoteAsianTextFirstLine) {
    xml.leafNode("w:doNotDemoteNonCombiningChars");
  }
  if (settings?.saveSubsetFonts) {
    xml.leafNode("w:saveSubsetFonts", { "w:val": "1" });
  }
  if (settings?.noPunctuationKerning) {
    xml.leafNode("w:noPunctuationKerning");
  }
  if (settings?.bordersDoNotSurroundHeader) {
    xml.leafNode("w:bordersDoNotSurroundHeader");
  }
  if (settings?.bordersDoNotSurroundFooter) {
    xml.leafNode("w:bordersDoNotSurroundFooter");
  }
  if (settings?.clickAndTypeStyle) {
    xml.leafNode("w:clickAndTypeStyle", { "w:val": settings.clickAndTypeStyle });
  }
  if (settings?.stylePaneFormatFilter) {
    xml.leafNode("w:stylePaneFormatFilter", {
      "w:val": settings.stylePaneFormatFilter
    });
  }
  if (settings?.stylePaneSortMethod) {
    xml.leafNode("w:stylePaneSortMethod", { "w:val": settings.stylePaneSortMethod });
  }
  if (settings?.themeFontLang) {
    const attrs: Record<string, string> = {};
    if (settings.themeFontLang.val) {
      attrs["w:val"] = settings.themeFontLang.val;
    }
    if (settings.themeFontLang.eastAsia) {
      attrs["w:eastAsia"] = settings.themeFontLang.eastAsia;
    }
    if (settings.themeFontLang.bidi) {
      attrs["w:bidi"] = settings.themeFontLang.bidi;
    }
    if (Object.keys(attrs).length > 0) {
      xml.leafNode("w:themeFontLang", attrs);
    }
  }
  if (settings?.decimalSymbol !== undefined) {
    xml.leafNode("w:decimalSymbol", { "w:val": settings.decimalSymbol });
  }
  if (settings?.listSeparator !== undefined) {
    xml.leafNode("w:listSeparator", { "w:val": settings.listSeparator });
  }

  // RSID list (revision save IDs)
  if (settings?.rsids) {
    xml.openNode("w:rsids");
    if (settings.rsids.rsidRoot) {
      xml.leafNode("w:rsidRoot", { "w:val": settings.rsids.rsidRoot });
    }
    if (settings.rsids.rsid) {
      for (const id of settings.rsids.rsid) {
        xml.leafNode("w:rsid", { "w:val": id });
      }
    }
    xml.closeNode();
  }

  // Hyphenation
  if (settings?.autoHyphenation || settings?.hyphenation?.autoHyphenation) {
    xml.leafNode("w:autoHyphenation");
  }
  if (settings?.hyphenation) {
    const h = settings.hyphenation;
    if (h.consecutiveHyphenLimit !== undefined) {
      xml.leafNode("w:consecutiveHyphenLimit", { "w:val": String(h.consecutiveHyphenLimit) });
    }
    if (h.hyphenationZone !== undefined) {
      xml.leafNode("w:hyphenationZone", { "w:val": String(h.hyphenationZone) });
    }
    if (h.doNotHyphenateCaps) {
      xml.leafNode("w:doNotHyphenateCaps");
    }
  }

  // Document protection
  if (settings?.documentProtection) {
    const dp = settings.documentProtection;
    const attrs: Record<string, string> = {};
    if (dp.type) {
      attrs["w:edit"] = dp.type;
    } else if (dp.edit) {
      attrs["w:edit"] = dp.edit;
    }
    if (dp.enforcement !== undefined) {
      attrs["w:enforcement"] = dp.enforcement ? "1" : "0";
    }
    if (dp.formatting !== undefined) {
      attrs["w:formatting"] = dp.formatting ? "1" : "0";
    }
    if (dp.hashAlgorithm) {
      attrs["w:cryptAlgorithmClass"] = "hash";
      attrs["w:cryptAlgorithmType"] = "typeAny";
      attrs["w:cryptAlgorithmSid"] = hashAlgorithmToSid(dp.hashAlgorithm);
      attrs["w:cryptProviderType"] = "rsaAES";
    }
    if (dp.hashValue) {
      attrs["w:hash"] = dp.hashValue;
    }
    if (dp.saltValue) {
      attrs["w:salt"] = dp.saltValue;
    }
    if (dp.spinCount !== undefined) {
      attrs["w:cryptSpinCount"] = String(dp.spinCount);
    }
    xml.leafNode("w:documentProtection", attrs);
  }

  // Display background shape
  if (settings?.displayBackgroundShape) {
    xml.leafNode("w:displayBackgroundShape");
  }

  // Update fields on open
  if (settings?.updateFieldsOnOpen) {
    xml.leafNode("w:updateFields", { "w:val": "true" });
  }

  // Document variables
  if (settings?.docVars && settings.docVars.size > 0) {
    xml.openNode("w:docVars");
    for (const [name, val] of settings.docVars) {
      xml.leafNode("w:docVar", { "w:name": name, "w:val": val });
    }
    xml.closeNode();
  }

  // Footnote/endnote properties
  if (settings?.footnoteProperties) {
    renderSettingsNoteProperties(xml, "w:footnotePr", settings.footnoteProperties);
  }
  if (settings?.endnoteProperties) {
    renderSettingsNoteProperties(xml, "w:endnotePr", settings.endnoteProperties);
  }

  // Mail merge (round-trip preservation)
  if (settings?.mailMergeRawXml) {
    if (rawXmlPolicy === "reject") {
      throw new DocxRawXmlPolicyError("settings.mailMergeRawXml");
    }
    if (rawXmlPolicy !== "strip") {
      xml.writeRaw(settings.mailMergeRawXml);
    }
  }

  // Write protection
  if (settings?.writeProtection) {
    const wp = settings.writeProtection;
    const wpAttrs: Record<string, string> = {};
    if (wp.recommended) {
      wpAttrs["w:recommended"] = "1";
    }
    if (wp.algorithmName) {
      wpAttrs["w:algorithmName"] = wp.algorithmName;
    }
    if (wp.hashValue) {
      wpAttrs["w:hashValue"] = wp.hashValue;
    }
    if (wp.saltValue) {
      wpAttrs["w:saltValue"] = wp.saltValue;
    }
    if (wp.spinCount !== undefined) {
      wpAttrs["w:spinCount"] = String(wp.spinCount);
    }
    xml.leafNode("w:writeProtection", wpAttrs);
  }

  // Compatibility
  xml.openNode("w:compat");

  // Legacy compat flags (w:useFELayout, etc.) come before compatSettings
  if (settings?.compatFlags) {
    for (const flag of settings.compatFlags) {
      const attrs: Record<string, string> = {};
      if (flag.val !== undefined) {
        attrs["w:val"] = flag.val;
      }
      xml.leafNode(`w:${flag.name}`, attrs);
    }
  }

  // Resolve compatibilityMode value: prefer an explicit entry in
  // settings.compatSettings, then settings.compatibilityMode, then 15.
  // Then emit every additional compatSetting (skipping the duplicate
  // compatibilityMode entry to avoid two w:compatSetting elements with
  // the same name — Word treats the first as authoritative, which would
  // hide a user-supplied mode behind the default 15).
  const explicitMode = settings?.compatSettings?.find(s => s.name === "compatibilityMode");
  const compatibilityModeVal = explicitMode?.val ?? String(settings?.compatibilityMode ?? 15);
  xml.leafNode("w:compatSetting", {
    "w:name": "compatibilityMode",
    "w:uri": "http://schemas.microsoft.com/office/word",
    "w:val": compatibilityModeVal
  });

  // Additional compatSettings (excluding compatibilityMode — already written)
  if (settings?.compatSettings) {
    for (const cs of settings.compatSettings) {
      if (cs.name === "compatibilityMode") {
        continue;
      }
      xml.leafNode("w:compatSetting", {
        "w:name": cs.name,
        "w:uri": cs.uri,
        "w:val": cs.val
      });
    }
  }

  xml.closeNode(); // w:compat

  xml.closeNode();
}

// =============================================================================
// Font Table
// =============================================================================

/** Render word/fontTable.xml. */
export function renderFontTable(xml: XmlSink, fonts?: readonly FontDef[]): void {
  xml.openXml(STD_DOC_ATTRIBUTES);
  xml.openNode("w:fonts", { "xmlns:w": NS_W, "xmlns:r": NS_R });

  // Merged, not replaced. `fonts ?? DEFAULT_FONTS` meant a single `addFont()`
  // call dropped every default — including the SimSun that docDefaults names, so
  // the document referenced a typeface its own font table no longer declared.
  // The caller's entry wins on a name collision, since it is the more specific
  // statement.
  const allFonts = mergeFontDefs(DEFAULT_FONTS, fonts);
  for (const font of allFonts) {
    xml.openNode("w:font", { "w:name": font.name });
    if (font.panose1) {
      xml.leafNode("w:panose1", { "w:val": font.panose1 });
    }
    if (font.charset) {
      xml.leafNode("w:charset", { "w:val": font.charset });
    }
    if (font.family) {
      xml.leafNode("w:family", { "w:val": font.family });
    }
    if (font.pitch) {
      xml.leafNode("w:pitch", { "w:val": font.pitch });
    }
    // Signature bytes
    if (font.sig) {
      const sigAttrs: Record<string, string> = {};
      if (font.sig.usb0 !== undefined) {
        sigAttrs["w:usb0"] = font.sig.usb0;
      }
      if (font.sig.usb1 !== undefined) {
        sigAttrs["w:usb1"] = font.sig.usb1;
      }
      if (font.sig.usb2 !== undefined) {
        sigAttrs["w:usb2"] = font.sig.usb2;
      }
      if (font.sig.usb3 !== undefined) {
        sigAttrs["w:usb3"] = font.sig.usb3;
      }
      if (font.sig.csb0 !== undefined) {
        sigAttrs["w:csb0"] = font.sig.csb0;
      }
      if (font.sig.csb1 !== undefined) {
        sigAttrs["w:csb1"] = font.sig.csb1;
      }
      if (Object.keys(sigAttrs).length > 0) {
        xml.leafNode("w:sig", sigAttrs);
      }
    }
    // Embedded font references
    if (font.embedRegular) {
      const attrs: Record<string, string> = { "r:id": font.embedRegular };
      if (font.embedRegularKey) {
        attrs["w:fontKey"] = font.embedRegularKey;
      }
      xml.leafNode("w:embedRegular", attrs);
    }
    if (font.embedBold) {
      const attrs: Record<string, string> = { "r:id": font.embedBold };
      if (font.embedBoldKey) {
        attrs["w:fontKey"] = font.embedBoldKey;
      }
      xml.leafNode("w:embedBold", attrs);
    }
    if (font.embedItalic) {
      const attrs: Record<string, string> = { "r:id": font.embedItalic };
      if (font.embedItalicKey) {
        attrs["w:fontKey"] = font.embedItalicKey;
      }
      xml.leafNode("w:embedItalic", attrs);
    }
    if (font.embedBoldItalic) {
      const attrs: Record<string, string> = { "r:id": font.embedBoldItalic };
      if (font.embedBoldItalicKey) {
        attrs["w:fontKey"] = font.embedBoldItalicKey;
      }
      xml.leafNode("w:embedBoldItalic", attrs);
    }
    xml.closeNode();
  }

  xml.closeNode();
}

/**
 * Combine the built-in declarations with a caller's, keyed by name.
 *
 * Later entries win, and order is preserved so the defaults keep their
 * conventional position at the head of the table.
 */
function mergeFontDefs(
  defaults: readonly FontDef[],
  extra: readonly FontDef[] | undefined
): FontDef[] {
  if (!extra || extra.length === 0) {
    return [...defaults];
  }
  const byName = new Map<string, FontDef>();
  for (const font of [...defaults, ...extra]) {
    byName.set(font.name.toLowerCase(), font);
  }
  return [...byName.values()];
}

const DEFAULT_FONTS: readonly FontDef[] = [
  {
    name: "Calibri",
    panose1: "020F0502020204030204",
    charset: "00",
    family: "swiss",
    pitch: "variable"
  },
  {
    name: "Times New Roman",
    panose1: "02020603050405020304",
    charset: "00",
    family: "roman",
    pitch: "variable"
  },
  { name: "Symbol", charset: "02", family: "roman", pitch: "variable" },
  {
    name: "Courier New",
    panose1: "02070309020205020404",
    charset: "00",
    family: "modern",
    pitch: "fixed"
  },
  { name: "Wingdings", charset: "02", family: "auto", pitch: "variable" },
  { name: "MS Gothic", charset: "80", family: "modern", pitch: "fixed" },
  // `useDefaultStyles` sets docDefaults' `w:eastAsia` to SimSun, and a font a
  // document uses belongs in its font table — this listed the Japanese
  // `MS Gothic` (charset 80) but no Chinese face at all, so the one East Asian
  // typeface the defaults actually name went undeclared. Charset 86 is GB2312,
  // 136 is Big5.
  {
    name: "SimSun",
    panose1: "02010600030101010101",
    charset: "86",
    family: "auto",
    pitch: "variable"
  },
  // The other faces `@word/core/east-asian-defaults` can name in `docDefaults`. A
  // Japanese or Korean document referenced `Yu Gothic` or `Malgun Gothic` while its own
  // font table declared neither, which is the same inconsistency the `SimSun` note above
  // describes — a typeface the document asks for and never introduces, leaving
  // substitution and charset hints to the reader.
  //
  // Charsets are the Windows values behind `@utils/cjk-typefaces`: `80` is
  // SHIFT_JIS (128) for Japanese, `81` is HANGUL (129) for Korean, and `88` is
  // CHINESEBIG5 (136) for Traditional Chinese. `fontTable.xml` writes them in hex
  // where `styles.xml` uses decimal.
  {
    name: "Yu Gothic",
    charset: "80",
    family: "swiss",
    pitch: "variable"
  },
  {
    name: "Malgun Gothic",
    charset: "81",
    family: "swiss",
    pitch: "variable"
  },
  {
    name: "PMingLiU",
    charset: "88",
    family: "auto",
    pitch: "variable"
  },
  {
    name: "Microsoft YaHei",
    panose1: "020B0503020204020204",
    charset: "86",
    family: "swiss",
    pitch: "variable"
  },
  {
    name: "DengXian",
    panose1: "02010600030101010101",
    charset: "86",
    family: "auto",
    pitch: "variable"
  },
  {
    name: "PMingLiU",
    panose1: "02020500000000000000",
    charset: "88",
    family: "auto",
    pitch: "variable"
  }
];

// =============================================================================
// Core Properties (docProps/core.xml)
// =============================================================================

/** Render docProps/core.xml. */
export function renderCoreProperties(xml: XmlSink, props?: CoreProperties): void {
  xml.openXml(STD_DOC_ATTRIBUTES);
  xml.openNode("cp:coreProperties", {
    "xmlns:cp": NS_CP,
    "xmlns:dc": NS_DC,
    "xmlns:dcterms": NS_DCTERMS,
    "xmlns:dcmitype": NS_DCMITYPE,
    "xmlns:xsi": NS_XSI
  });

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  if (props?.title) {
    xml.leafNode("dc:title", undefined, props.title);
  }
  if (props?.subject) {
    xml.leafNode("dc:subject", undefined, props.subject);
  }
  if (props?.creator) {
    xml.leafNode("dc:creator", undefined, props.creator);
  }
  if (props?.description) {
    xml.leafNode("dc:description", undefined, props.description);
  }
  if (props?.keywords) {
    xml.leafNode("cp:keywords", undefined, props.keywords);
  }
  if (props?.lastModifiedBy) {
    xml.leafNode("cp:lastModifiedBy", undefined, props.lastModifiedBy);
  }
  if (props?.revision) {
    xml.leafNode("cp:revision", undefined, props.revision);
  }
  if (props?.category) {
    xml.leafNode("cp:category", undefined, props.category);
  }

  xml.leafNode(
    "dcterms:created",
    { "xsi:type": "dcterms:W3CDTF" },
    props?.created ? props.created.toISOString().replace(/\.\d+Z$/, "Z") : now
  );

  xml.leafNode(
    "dcterms:modified",
    { "xsi:type": "dcterms:W3CDTF" },
    props?.modified ? props.modified.toISOString().replace(/\.\d+Z$/, "Z") : now
  );

  xml.closeNode();
}

// =============================================================================
// App Properties (docProps/app.xml)
// =============================================================================

/** Render docProps/app.xml. */
export function renderAppProperties(xml: XmlSink, props?: AppProperties): void {
  xml.openXml(STD_DOC_ATTRIBUTES);
  xml.openNode("Properties", {
    xmlns: NS_EP,
    "xmlns:vt": NS_VT
  });

  xml.leafNode("Application", undefined, props?.application ?? "documonster");
  xml.leafNode("AppVersion", undefined, props?.appVersion ?? "1.0.0");

  if (props?.pages !== undefined) {
    xml.leafNode("Pages", undefined, String(props.pages));
  }
  if (props?.words !== undefined) {
    xml.leafNode("Words", undefined, String(props.words));
  }
  if (props?.characters !== undefined) {
    xml.leafNode("Characters", undefined, String(props.characters));
  }
  if (props?.lines !== undefined) {
    xml.leafNode("Lines", undefined, String(props.lines));
  }
  if (props?.paragraphs !== undefined) {
    xml.leafNode("Paragraphs", undefined, String(props.paragraphs));
  }
  if (props?.company) {
    xml.leafNode("Company", undefined, props.company);
  }
  if (props?.manager) {
    xml.leafNode("Manager", undefined, props.manager);
  }

  xml.closeNode();
}

// =============================================================================
// Document Background
// =============================================================================

/** Render document background element (w:background in document.xml). */
export function renderDocumentBackground(xml: XmlSink, bg: DocumentBackground): void {
  const attrs: Record<string, string> = {};
  if (bg.color) {
    attrs["w:color"] = bg.color;
  }
  if (bg.themeColor) {
    attrs["w:themeColor"] = bg.themeColor;
  }
  if (bg.themeShade) {
    attrs["w:themeShade"] = bg.themeShade;
  }
  if (bg.themeTint) {
    attrs["w:themeTint"] = bg.themeTint;
  }
  xml.leafNode("w:background", attrs);
}

// =============================================================================
// Custom Properties (docProps/custom.xml)
// =============================================================================

/** Render docProps/custom.xml. */
export function renderCustomProperties(xml: XmlSink, properties: readonly CustomProperty[]): void {
  xml.openXml(STD_DOC_ATTRIBUTES);
  xml.openNode("Properties", {
    xmlns: NS_CUSTOM,
    "xmlns:vt": NS_VT
  });

  let fmtid = 2; // Start at 2 (1 is reserved)
  for (const prop of properties) {
    xml.openNode("property", {
      fmtid: "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}",
      pid: String(fmtid++),
      name: prop.name
    });

    switch (prop.value.type) {
      case "string":
        xml.leafNode("vt:lpwstr", undefined, prop.value.value);
        break;
      case "number":
        if (Number.isInteger(prop.value.value)) {
          xml.leafNode("vt:i4", undefined, String(prop.value.value));
        } else {
          xml.leafNode("vt:r8", undefined, String(prop.value.value));
        }
        break;
      case "boolean":
        xml.leafNode("vt:bool", undefined, prop.value.value ? "true" : "false");
        break;
      case "date":
        xml.leafNode(
          "vt:filetime",
          undefined,
          prop.value.value.toISOString().replace(/\.\d+Z$/, "Z")
        );
        break;
    }

    xml.closeNode();
  }

  xml.closeNode();
}

// =============================================================================
// Theme (minimal default theme)
// =============================================================================

/** Render word/theme/theme1.xml (minimal theme). */
export function renderTheme(
  xml: XmlSink,
  theme?: DocumentTheme,
  rawXmlPolicy?: "preserve" | "strip" | "reject"
): void {
  const NS_A_LOCAL = "http://schemas.openxmlformats.org/drawingml/2006/main";
  // No theme supplied means we are generating one, and only then may defaults be
  // filled in — serialising a caller's theme must reproduce it, not improve it.
  const generated = theme?.fontScheme === undefined;

  xml.openXml(STD_DOC_ATTRIBUTES);
  xml.openNode("a:theme", { "xmlns:a": NS_A_LOCAL, name: theme?.name ?? "Office Theme" });

  xml.openNode("a:themeElements");

  // Color scheme
  const colorScheme = theme?.colorScheme;
  xml.openNode("a:clrScheme", { name: colorScheme?.name ?? "Office" });
  const defaultColors: Record<string, string> = DEFAULT_OFFICE_THEME;
  const colorOrder = [
    "dk1",
    "lt1",
    "dk2",
    "lt2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink"
  ] as const;
  for (const name of colorOrder) {
    const val = colorScheme?.colors[name] ?? defaultColors[name];
    xml.openNode(`a:${name}`);
    // dk1/lt1 use sysClr in standard theme, but srgbClr also valid
    xml.leafNode("a:srgbClr", { val });
    xml.closeNode();
  }
  xml.closeNode(); // a:clrScheme

  // Font scheme
  const fontScheme = theme?.fontScheme;
  xml.openNode("a:fontScheme", { name: fontScheme?.name ?? "Office" });

  // Major font
  xml.openNode("a:majorFont");
  renderThemeFont(xml, fontScheme?.major, fontScheme?.majorFont ?? "Calibri Light", generated);
  xml.closeNode();

  // Minor font
  xml.openNode("a:minorFont");
  renderThemeFont(xml, fontScheme?.minor, fontScheme?.minorFont ?? "Calibri", generated);
  xml.closeNode();

  xml.closeNode(); // a:fontScheme

  // Format scheme - preserve raw XML if provided, otherwise minimal default
  if (theme?.formatScheme?.rawXml) {
    if (rawXmlPolicy === "reject") {
      throw new DocxRawXmlPolicyError("theme.formatScheme.rawXml");
    }
    if (rawXmlPolicy === "strip") {
      // Fall back to a minimal default rather than emitting an empty
      // a:fmtScheme — Word treats an empty format scheme as malformed.
      renderDefaultFormatScheme(xml);
    } else {
      xml.openNode("a:fmtScheme", { name: theme.formatScheme.name });
      xml.writeRaw(theme.formatScheme.rawXml);
      xml.closeNode();
    }
  } else {
    renderDefaultFormatScheme(xml);
  }

  xml.closeNode(); // a:themeElements

  // Extension list (round-trip preservation)
  if (theme?.extLstXml) {
    if (rawXmlPolicy === "reject") {
      throw new DocxRawXmlPolicyError("theme.extLstXml");
    }
    if (rawXmlPolicy !== "strip") {
      xml.writeRaw(theme.extLstXml);
    }
  }

  xml.closeNode(); // a:theme
}

/** Render a single theme font (major or minor). */
function renderThemeFont(
  xml: XmlSink,
  font: ThemeFont | undefined,
  fallbackLatin: string,
  isGeneratedTheme: boolean
): void {
  xml.leafNode("a:latin", { typeface: font?.latin ?? fallbackLatin });
  xml.leafNode("a:ea", { typeface: font?.eastAsia ?? "" });
  xml.leafNode("a:cs", { typeface: font?.complexScript ?? "" });
  if (font?.supplementalFonts) {
    for (const [script, typeface] of Object.entries(font.supplementalFonts)) {
      xml.leafNode("a:font", { script, typeface });
    }
    return;
  }
  // Per-script fonts are supplied only when *generating* a theme, never when
  // serialising one the caller gave us.
  //
  // A theme with none leaves Word to resolve `minorEastAsia` against nothing,
  // which is how a document whose docDefaults name SimSun still rendered Chinese
  // in whatever the host chose — Excel's own theme has carried these four entries
  // all along while the Word writer emitted `<a:ea typeface=""/>` and stopped.
  // But filling them in unconditionally broke round-tripping: the reader
  // represents "no `a:font` elements" as `undefined`, so reading a valid theme
  // without them and writing it back silently added four.
  if (!isGeneratedTheme) {
    return;
  }
  for (const [script, typeface] of DEFAULT_SUPPLEMENTAL_FONTS) {
    xml.leafNode("a:font", { script, typeface });
  }
}

/**
 * Per-script theme fonts written when a theme names none of its own.
 *
 * Matches what Word and Excel write for a Chinese, Traditional Chinese, Japanese
 * and Korean locale respectively.
 */
const DEFAULT_SUPPLEMENTAL_FONTS: readonly (readonly [string, string])[] = [
  ["Hans", "\u5b8b\u4f53"], // 宋体
  ["Hant", "\u65b0\u7d30\u660e\u9ad4"], // 新細明體
  ["Jpan", "\uff2d\uff33 \uff30\u30b4\u30b7\u30c3\u30af"], // ＭＳ Ｐゴシック
  ["Hang", "\ub9d1\uc740 \uace0\ub515"] // 맑은 고딕
];

/** Render the minimal default format scheme. */
function renderDefaultFormatScheme(xml: XmlSink): void {
  xml.openNode("a:fmtScheme", { name: "Office" });
  // Fill styles
  xml.openNode("a:fillStyleLst");
  for (let i = 0; i < 3; i++) {
    xml.openNode("a:solidFill");
    xml.leafNode("a:schemeClr", { val: "phClr" });
    xml.closeNode();
  }
  xml.closeNode();

  // Line styles
  xml.openNode("a:lnStyleLst");
  for (let i = 0; i < 3; i++) {
    xml.openNode("a:ln", { w: String(6350 + i * 6350) });
    xml.openNode("a:solidFill");
    xml.leafNode("a:schemeClr", { val: "phClr" });
    xml.closeNode();
    xml.leafNode("a:prstDash", { val: "solid" });
    xml.closeNode();
  }
  xml.closeNode();

  // Effect styles
  xml.openNode("a:effectStyleLst");
  for (let i = 0; i < 3; i++) {
    xml.openNode("a:effectStyle");
    xml.leafNode("a:effectLst");
    xml.closeNode();
  }
  xml.closeNode();

  // Bg fill styles
  xml.openNode("a:bgFillStyleLst");
  for (let i = 0; i < 3; i++) {
    xml.openNode("a:solidFill");
    xml.leafNode("a:schemeClr", { val: "phClr" });
    xml.closeNode();
  }
  xml.closeNode();

  xml.closeNode(); // a:fmtScheme
}

// =============================================================================
// Web Settings
// =============================================================================

/** Render word/webSettings.xml. */
export function renderWebSettings(
  xml: XmlSink,
  ws?: WebSettings,
  rawXmlPolicy?: "preserve" | "strip" | "reject"
): void {
  xml.openXml(STD_DOC_ATTRIBUTES);
  xml.openNode("w:webSettings", { "xmlns:w": NS_W });

  if (ws?.optimizeForBrowser) {
    const attrs: Record<string, string> = {};
    if (ws.optimizeForBrowser.target) {
      attrs["w:target"] = ws.optimizeForBrowser.target;
    }
    if (ws.optimizeForBrowser.majorVersion !== undefined) {
      attrs["w:majorVersion"] = String(ws.optimizeForBrowser.majorVersion);
    }
    xml.leafNode("w:optimizeForBrowser", attrs);
  }
  if (ws?.allowPng) {
    xml.leafNode("w:allowPNG");
  }
  if (ws?.relyOnVml) {
    xml.leafNode("w:relyOnVML");
  }
  if (ws?.doNotSaveAsSingleFile) {
    xml.leafNode("w:doNotSaveAsSingleFile");
  }
  if (ws?.doNotOrganizeInFolder) {
    xml.leafNode("w:doNotOrganizeInFolder");
  }
  if (ws?.useTargetMachineType) {
    xml.leafNode("w:useTargetMachineType");
  }
  if (ws?.rawXml) {
    if (rawXmlPolicy === "reject") {
      throw new DocxRawXmlPolicyError("webSettings.rawXml");
    }
    if (rawXmlPolicy !== "strip") {
      xml.writeRaw(ws.rawXml);
    }
  }

  xml.closeNode();
}

// =============================================================================
// People (collaboration metadata)
// =============================================================================

/** Render word/people.xml. */
export function renderPeople(xml: XmlSink, people: readonly PersonInfo[]): void {
  xml.openXml(STD_DOC_ATTRIBUTES);
  xml.openNode("w15:people", {
    "xmlns:w": NS_W,
    "xmlns:w15": "http://schemas.microsoft.com/office/word/2012/wordml"
  });

  for (const person of people) {
    xml.openNode("w15:person", { "w15:author": person.author });
    if (person.presenceInfo) {
      const attrs: Record<string, string> = {};
      if (person.presenceInfo.providerId) {
        attrs["w15:providerId"] = person.presenceInfo.providerId;
      }
      if (person.presenceInfo.userId) {
        attrs["w15:userId"] = person.presenceInfo.userId;
      }
      xml.leafNode("w15:presenceInfo", attrs);
    }
    xml.closeNode();
  }

  xml.closeNode();
}

// =============================================================================
// Internal Helpers
// =============================================================================

/** Convert hash algorithm name to OOXML cryptAlgorithmSid value. */
function hashAlgorithmToSid(algorithm: string): string {
  switch (algorithm) {
    case "SHA-1":
      return "4";
    case "SHA-256":
      return "12";
    case "SHA-384":
      return "13";
    case "SHA-512":
      return "14";
    default:
      return "4"; // Default to SHA-1
  }
}
