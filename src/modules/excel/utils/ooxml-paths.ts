export const OOXML_PATHS = {
  contentTypes: "[Content_Types].xml",
  rootRels: "_rels/.rels",

  docPropsApp: "docProps/app.xml",
  docPropsCore: "docProps/core.xml",

  xlWorkbook: "xl/workbook.xml",
  xlWorkbookRels: "xl/_rels/workbook.xml.rels",
  xlSharedStrings: "xl/sharedStrings.xml",
  xlStyles: "xl/styles.xml",
  xlTheme1: "xl/theme/theme1.xml",
  xlFeaturePropertyBag: "xl/featurePropertyBag/featurePropertyBag.xml",
  xlMetadata: "xl/metadata.xml"
} as const;

const worksheetXmlRegex = /^xl\/worksheets\/sheet(\d+)[.]xml$/;
const worksheetRelsXmlRegex = /^xl\/worksheets\/_rels\/sheet(\d+)[.]xml[.]rels$/;
const themeXmlRegex = /^xl\/theme\/[a-zA-Z0-9]+[.]xml$/;

const mediaFilenameRegex = /^xl\/media\/([a-zA-Z0-9]+[.][a-zA-Z0-9]{3,4})$/;
const drawingXmlRegex = /^xl\/drawings\/(drawing\d+)[.]xml$/;
const drawingRelsXmlRegex = /^xl\/drawings\/_rels\/(drawing\d+)[.]xml[.]rels$/;
// `chartUserShape` is the canonical stem Excel and this library emit,
// but OOXML does not mandate any particular filename — the chart part
// discovers its user-shape drawing via the `.rels` relationship type,
// not by path. Widen the regex to also accept the plural form and
// a common third-party variant so foreign packages round-trip without
// silently dropping the overlay drawing. Packages that name the part
// entirely differently (e.g. `drawing5.xml` referenced via the
// `chartUserShapes` rel type) still require the relationship-based
// discovery path; that's a separate fix tracked against the reader.
const chartUserShapesXmlRegex =
  /^xl\/drawings\/((?:chartUserShape|chartUserShapes|userDrawing)\d+)[.]xml$/;
const vmlDrawingRegex = /^xl\/drawings\/(vmlDrawing\d+)[.]vml$/;
const vmlDrawingHFRegex = /^xl\/drawings\/(vmlDrawingHF\d+)[.]vml$/;
const vmlDrawingHFRelsRegex = /^xl\/drawings\/_rels\/(vmlDrawingHF\d+)[.]vml[.]rels$/;
// Matches both flat layout (xl/comments1.xml) and subdirectory layout (xl/comments/comment1.xml).
// Both are valid OOXML — the actual path is determined by .rels, not by convention.
const commentsXmlRegex = /^xl\/(?:comments(\d+)|comments\/comment(\d+))[.]xml$/;
const tableXmlRegex = /^xl\/tables\/(table\d+)[.]xml$/;

const pivotTableXmlRegex = /^xl\/pivotTables\/(pivotTable\d+)[.]xml$/;
const pivotTableRelsXmlRegex = /^xl\/pivotTables\/_rels\/(pivotTable\d+)[.]xml[.]rels$/;
const pivotCacheDefinitionXmlRegex = /^xl\/pivotCache\/(pivotCacheDefinition\d+)[.]xml$/;
const pivotCacheDefinitionRelsXmlRegex =
  /^xl\/pivotCache\/_rels\/(pivotCacheDefinition\d+)[.]xml[.]rels$/;
const pivotCacheRecordsXmlRegex = /^xl\/pivotCache\/(pivotCacheRecords\d+)[.]xml$/;

// External workbook links (xl/externalLinks/externalLink{n}.xml and its rels)
const externalLinkXmlRegex = /^xl\/externalLinks\/externalLink(\d+)[.]xml$/;
const externalLinkRelsXmlRegex = /^xl\/externalLinks\/_rels\/externalLink(\d+)[.]xml[.]rels$/;

export function normalizeZipPath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

export function getWorksheetNoFromWorksheetPath(path: string): number | undefined {
  const match = worksheetXmlRegex.exec(path);
  if (!match) {
    return undefined;
  }
  return parseInt(match[1], 10);
}

export function getWorksheetNoFromWorksheetRelsPath(path: string): number | undefined {
  const match = worksheetRelsXmlRegex.exec(path);
  if (!match) {
    return undefined;
  }
  return parseInt(match[1], 10);
}

export function isMediaPath(path: string): boolean {
  return path.startsWith("xl/media/");
}

export function getMediaFilenameFromPath(path: string): string | undefined {
  const match = mediaFilenameRegex.exec(path);
  return match ? match[1] : undefined;
}

export function isThemePath(path: string): boolean {
  return themeXmlRegex.test(path);
}

export function getThemeNameFromPath(path: string): string | undefined {
  const match = /^xl\/theme\/([a-zA-Z0-9]+)[.]xml$/.exec(path);
  return match ? match[1] : undefined;
}

export function isBinaryEntryPath(path: string): boolean {
  // Media and themes should be treated as binary in the legacy buffer-based reader.
  // Everything else is parsed as text XML.
  return isMediaPath(path) || isThemePath(path);
}

export function getDrawingNameFromPath(path: string): string | undefined {
  const match = drawingXmlRegex.exec(path);
  return match ? match[1] : undefined;
}

export function getDrawingNameFromRelsPath(path: string): string | undefined {
  const match = drawingRelsXmlRegex.exec(path);
  return match ? match[1] : undefined;
}

/**
 * Canonical filename stem for a chart-overlay drawing part — used by
 * the reader to recognise `xl/drawings/chartUserShapeN.xml` entries
 * and stash their bytes for post-load reconciliation onto the owning
 * chart. Returns `undefined` for any other path, including regular
 * worksheet drawings (those go through {@link getDrawingNameFromPath}).
 */
export function getChartUserShapesNameFromPath(path: string): string | undefined {
  const match = chartUserShapesXmlRegex.exec(path);
  return match ? match[1] : undefined;
}

export function getVmlDrawingNameFromPath(path: string): string | undefined {
  const match = vmlDrawingRegex.exec(path);
  return match ? match[1] : undefined;
}

export function getVmlDrawingHFNameFromPath(path: string): string | undefined {
  const match = vmlDrawingHFRegex.exec(path);
  return match ? match[1] : undefined;
}

export function getVmlDrawingHFNameFromRelsPath(path: string): string | undefined {
  const match = vmlDrawingHFRelsRegex.exec(path);
  return match ? match[1] : undefined;
}

/**
 * Check if a zip entry path is a comments XML file.
 * Works for both `xl/comments1.xml` and `xl/comments/comment1.xml`.
 */
export function isCommentsPath(path: string): boolean {
  return commentsXmlRegex.test(path);
}

export function getTableNameFromPath(path: string): string | undefined {
  const match = tableXmlRegex.exec(path);
  return match ? match[1] : undefined;
}

export function getPivotTableNameFromPath(path: string): string | undefined {
  const match = pivotTableXmlRegex.exec(path);
  return match ? match[1] : undefined;
}

export function getPivotTableNameFromRelsPath(path: string): string | undefined {
  const match = pivotTableRelsXmlRegex.exec(path);
  return match ? match[1] : undefined;
}

export function getPivotCacheDefinitionNameFromPath(path: string): string | undefined {
  const match = pivotCacheDefinitionXmlRegex.exec(path);
  return match ? match[1] : undefined;
}

export function getPivotCacheDefinitionNameFromRelsPath(path: string): string | undefined {
  const match = pivotCacheDefinitionRelsXmlRegex.exec(path);
  return match ? match[1] : undefined;
}

export function getPivotCacheRecordsNameFromPath(path: string): string | undefined {
  const match = pivotCacheRecordsXmlRegex.exec(path);
  return match ? match[1] : undefined;
}

/**
 * Extract the 1-based index `N` from `xl/externalLinks/externalLink{N}.xml`.
 * Returns the raw integer (e.g. `1` for externalLink1.xml) or undefined.
 */
export function getExternalLinkIndexFromPath(path: string): number | undefined {
  const match = externalLinkXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Extract the 1-based index `N` from
 * `xl/externalLinks/_rels/externalLink{N}.xml.rels`.
 */
export function getExternalLinkIndexFromRelsPath(path: string): number | undefined {
  const match = externalLinkRelsXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function toContentTypesPartName(zipPath: string): string {
  // ContentTypes uses leading slash PartName (e.g. "/xl/workbook.xml").
  return zipPath.startsWith("/") ? zipPath : `/${zipPath}`;
}

/** Inverse of {@link toContentTypesPartName}: `/xl/workbook.xml` → `xl/workbook.xml`. */
export function fromContentTypesPartName(partName: string): string {
  return partName.startsWith("/") ? partName.slice(1) : partName;
}

export function themePath(themeName: string): string {
  return `xl/theme/${themeName}.xml`;
}

export function mediaPath(filename: string): string {
  return `xl/media/${filename}`;
}

export function worksheetPath(sheetId: number | string): string {
  return `xl/worksheets/sheet${sheetId}.xml`;
}

export function worksheetRelsPath(sheetId: number | string): string {
  return `xl/worksheets/_rels/sheet${sheetId}.xml.rels`;
}

export function worksheetRelTarget(sheetId: number | string): string {
  return `worksheets/sheet${sheetId}.xml`;
}

export function commentsPath(sheetId: number | string): string {
  return `xl/comments${sheetId}.xml`;
}

export function commentsPathFromName(commentName: string): string {
  // For comments when the caller already has the logical name (e.g. "comments1").
  return `xl/${commentName}.xml`;
}

export function vmlDrawingPath(sheetId: number | string): string {
  return `xl/drawings/vmlDrawing${sheetId}.vml`;
}

export function vmlDrawingHFPath(sheetId: number | string): string {
  return `xl/drawings/vmlDrawingHF${sheetId}.vml`;
}

export function vmlDrawingHFRelsPath(sheetId: number | string): string {
  return `xl/drawings/_rels/vmlDrawingHF${sheetId}.vml.rels`;
}

export function tablePath(target: string): string {
  return `xl/tables/${target}`;
}

export function drawingPath(drawingName: string): string {
  return `xl/drawings/${drawingName}.xml`;
}

export function drawingRelsPath(drawingName: string): string {
  return `xl/drawings/_rels/${drawingName}.xml.rels`;
}

export function pivotCacheDefinitionPath(n: number | string): string {
  return `xl/pivotCache/pivotCacheDefinition${n}.xml`;
}

export function pivotCacheDefinitionRelsPath(n: number | string): string {
  return `xl/pivotCache/_rels/pivotCacheDefinition${n}.xml.rels`;
}

export function pivotCacheRecordsPath(n: number | string): string {
  return `xl/pivotCache/pivotCacheRecords${n}.xml`;
}

export function pivotCacheRecordsRelTarget(n: number | string): string {
  return `pivotCacheRecords${n}.xml`;
}

export function pivotTablePath(n: number | string): string {
  return `xl/pivotTables/pivotTable${n}.xml`;
}

export function pivotTablePathFromName(name: string): string {
  return `xl/pivotTables/${name}.xml`;
}

export function pivotTableRelsPath(n: number | string): string {
  return `xl/pivotTables/_rels/pivotTable${n}.xml.rels`;
}

// -------- External links --------
export function externalLinkPath(n: number | string): string {
  return `xl/externalLinks/externalLink${n}.xml`;
}

export function externalLinkRelsPath(n: number | string): string {
  return `xl/externalLinks/_rels/externalLink${n}.xml.rels`;
}

/**
 * Build the `Target` value for an externalLink relationship inside
 * `xl/_rels/workbook.xml.rels` (base: `xl/`).
 */
export function externalLinkRelTargetFromWorkbook(n: number | string): string {
  return `externalLinks/externalLink${n}.xml`;
}

export function pivotCacheDefinitionRelTargetFromPivotTable(n: number | string): string {
  return `../pivotCache/pivotCacheDefinition${n}.xml`;
}

export const OOXML_REL_TARGETS = {
  // Targets inside xl/_rels/workbook.xml.rels (base: xl/)
  workbookStyles: "styles.xml",
  workbookSharedStrings: "sharedStrings.xml",
  workbookTheme1: "theme/theme1.xml",
  workbookFeaturePropertyBag: "featurePropertyBag/featurePropertyBag.xml",
  workbookMetadata: "metadata.xml"
} as const;

export function pivotCacheDefinitionRelTargetFromWorkbook(n: number | string): string {
  // Target inside xl/_rels/workbook.xml.rels (base: xl/)
  return `pivotCache/pivotCacheDefinition${n}.xml`;
}

export function commentsRelTargetFromWorksheet(sheetId: number | string): string {
  // Target inside xl/worksheets/_rels/sheetN.xml.rels (base: xl/worksheets/)
  return `../comments${sheetId}.xml`;
}

export function vmlDrawingRelTargetFromWorksheet(sheetId: number | string): string {
  // Target inside xl/worksheets/_rels/sheetN.xml.rels (base: xl/worksheets/)
  return `../drawings/vmlDrawing${sheetId}.vml`;
}

export function vmlDrawingHFRelTargetFromWorksheet(sheetId: number | string): string {
  // Target inside xl/worksheets/_rels/sheetN.xml.rels (base: xl/worksheets/)
  return `../drawings/vmlDrawingHF${sheetId}.vml`;
}

export function drawingRelTargetFromWorksheet(drawingName: string): string {
  // Target inside xl/worksheets/_rels/sheetN.xml.rels (base: xl/worksheets/)
  return `../drawings/${drawingName}.xml`;
}

export function pivotTableRelTargetFromWorksheet(n: number | string): string {
  // Target inside xl/worksheets/_rels/sheetN.xml.rels (base: xl/worksheets/)
  return `../pivotTables/pivotTable${n}.xml`;
}

export function tableRelTargetFromWorksheet(target: string): string {
  // Target inside xl/worksheets/_rels/sheetN.xml.rels (base: xl/worksheets/)
  return `../tables/${target}`;
}

export function mediaRelTargetFromRels(filename: string): string {
  // Target from a rels file located under xl/*/_rels (base is one level deeper than xl/)
  return `../media/${filename}`;
}

// Form Control (ctrlProps) path functions
export function ctrlPropPath(id: number | string): string {
  return `xl/ctrlProps/ctrlProp${id}.xml`;
}

// -------- Charts --------

const chartXmlRegex = /^xl\/charts\/chart(\d+)[.]xml$/;
const chartRelsXmlRegex = /^xl\/charts\/_rels\/chart(\d+)[.]xml[.]rels$/;
const chartStyleXmlRegex = /^xl\/charts\/style(\d+)[.]xml$/;
const chartColorsXmlRegex = /^xl\/charts\/colors(\d+)[.]xml$/;
const chartExStyleXmlRegex = /^xl\/charts\/styleEx(\d+)[.]xml$/;
const chartExColorsXmlRegex = /^xl\/charts\/colorsEx(\d+)[.]xml$/;

export function getChartNumberFromPath(path: string): number | undefined {
  const match = chartXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function getChartNumberFromRelsPath(path: string): number | undefined {
  const match = chartRelsXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function getChartStyleNumberFromPath(path: string): number | undefined {
  const match = chartStyleXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function getChartColorsNumberFromPath(path: string): number | undefined {
  const match = chartColorsXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function getChartExStyleNumberFromPath(path: string): number | undefined {
  const match = chartExStyleXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function getChartExColorsNumberFromPath(path: string): number | undefined {
  const match = chartExColorsXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function chartPath(n: number | string): string {
  return `xl/charts/chart${n}.xml`;
}

export function chartRelsPath(n: number | string): string {
  return `xl/charts/_rels/chart${n}.xml.rels`;
}

export function chartStylePath(n: number | string): string {
  return `xl/charts/style${n}.xml`;
}

export function chartColorsPath(n: number | string): string {
  return `xl/charts/colors${n}.xml`;
}

export function chartExStylePath(n: number | string): string {
  return `xl/charts/styleEx${n}.xml`;
}

export function chartExColorsPath(n: number | string): string {
  return `xl/charts/colorsEx${n}.xml`;
}

export function chartRelTargetFromDrawing(n: number | string): string {
  // Target inside xl/drawings/_rels/drawingN.xml.rels (base: xl/drawings/)
  return `../charts/chart${n}.xml`;
}

/**
 * Path of the DrawingML overlay part backing a chart's `c:userShapes`
 * reference. Placed under `xl/drawings/` with a `chartUserShape` prefix
 * (rather than sharing the regular `drawingN` pool) so the writer can
 * allocate it by chart number without colliding with worksheet
 * drawings. Excel itself is indifferent to the part path — only the
 * rel target matters — so files loaded with a different original
 * path are renamed on write.
 */
export function chartUserShapesPath(n: number | string): string {
  return `xl/drawings/chartUserShape${n}.xml`;
}

/**
 * Target path emitted inside `xl/charts/_rels/chartN.xml.rels` for the
 * user-shapes drawing part. Resolved relative to the rels file's
 * base directory (`xl/charts/`).
 */
export function chartUserShapesRelTarget(n: number | string): string {
  return `../drawings/chartUserShape${n}.xml`;
}

export function chartStyleRelTarget(n: number | string): string {
  // Target inside xl/charts/_rels/chartN.xml.rels (base: xl/charts/)
  return `style${n}.xml`;
}

export function chartColorsRelTarget(n: number | string): string {
  // Target inside xl/charts/_rels/chartN.xml.rels (base: xl/charts/)
  return `colors${n}.xml`;
}

export function chartExStyleRelTarget(n: number | string): string {
  return `styleEx${n}.xml`;
}

export function chartExColorsRelTarget(n: number | string): string {
  return `colorsEx${n}.xml`;
}

// ============================================================================
// Chart Ex (Office 2016+ extended charts: treemap, sunburst, waterfall, etc.)
// ============================================================================

const chartExXmlRegex = /^xl\/charts\/chartEx(\d+)[.]xml$/;
const chartExRelsXmlRegex = /^xl\/charts\/_rels\/chartEx(\d+)[.]xml[.]rels$/;

export function getChartExNumberFromPath(path: string): number | undefined {
  const match = chartExXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function getChartExNumberFromRelsPath(path: string): number | undefined {
  const match = chartExRelsXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function chartExPath(n: number | string): string {
  return `xl/charts/chartEx${n}.xml`;
}

export function chartExRelsPath(n: number | string): string {
  return `xl/charts/_rels/chartEx${n}.xml.rels`;
}

export function chartExRelTargetFromDrawing(n: number | string): string {
  return `../charts/chartEx${n}.xml`;
}

export function ctrlPropRelTargetFromWorksheet(id: number | string): string {
  // Target inside xl/worksheets/_rels/sheetN.xml.rels (base: xl/worksheets/)
  return `../ctrlProps/ctrlProp${id}.xml`;
}

/**
 * Resolve a relationship Target (relative or absolute) to a normalized zip path.
 *
 * OOXML relationship targets may be:
 *   - Relative: `../comments1.xml` (resolved against `baseDir`)
 *   - Absolute: `/xl/comments/comment1.xml` (leading slash stripped)
 *
 * @param baseDir  The directory containing the source part (e.g. `xl/worksheets/`)
 * @param target   The raw Target value from the .rels file
 */
export function resolveRelTarget(baseDir: string, target: string): string {
  // Normalise every path through the same split / `.` / `..` collapse
  // so absolute targets with `..` segments (legal per OPC, emitted by
  // some third-party producers like LibreOffice for cross-folder rels
  // such as `/xl/worksheets/../charts/chart1.xml`) resolve to a
  // canonical zip path. Previously the absolute branch returned
  // `target.slice(1)` verbatim — every downstream `_chartRels[path]`
  // lookup then missed because the stored keys are canonical.
  const rawPath = target.startsWith("/")
    ? target.slice(1)
    : `${baseDir.endsWith("/") ? baseDir : baseDir + "/"}${target}`;
  const parts = rawPath.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") {
      continue;
    } else if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

// ============================================================================
// Chartsheet paths
// ============================================================================

const chartsheetXmlRegex = /^xl\/chartsheets\/sheet(\d+)[.]xml$/;
const chartsheetRelsXmlRegex = /^xl\/chartsheets\/_rels\/sheet(\d+)[.]xml[.]rels$/;

export function getChartsheetNoFromPath(path: string): number | undefined {
  const match = chartsheetXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function getChartsheetNoFromRelsPath(path: string): number | undefined {
  const match = chartsheetRelsXmlRegex.exec(path);
  return match ? parseInt(match[1], 10) : undefined;
}

export function chartsheetPath(n: number | string): string {
  return `xl/chartsheets/sheet${n}.xml`;
}

export function chartsheetRelsPath(n: number | string): string {
  return `xl/chartsheets/_rels/sheet${n}.xml.rels`;
}
