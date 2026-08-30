import { isExternalImage } from "@excel/utils/drawing-utils";
import {
  OOXML_PATHS,
  chartsheetPath,
  commentsPathFromName,
  ctrlPropPath,
  drawingPath,
  externalLinkPath,
  chartPath,
  chartUserShapesPath,
  chartExPath,
  chartStylePath,
  chartColorsPath,
  chartExStylePath,
  chartExColorsPath,
  pivotCacheDefinitionPath,
  pivotCacheRecordsPath,
  pivotTablePath,
  tablePath,
  fromContentTypesPartName,
  toContentTypesPartName,
  worksheetPath
} from "@excel/utils/ooxml-paths";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";
import { StdDocAttributes } from "@xml/writer";

/**
 * Canonical Override ContentType for `/xl/workbook.xml` in a plain `.xlsx`.
 * Used both as the render-time default and, alongside its template /
 * macro-enabled siblings, to recognise the workbook part on parse.
 */
const PLAIN_WORKBOOK_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

/**
 * The (write-only) model the content-types manifest is rendered from: the set
 * of parts the package contains. Sub-entries are typed to the fields this
 * renderer actually reads.
 */
interface ContentTypesModel {
  /**
   * Override ContentType for `/xl/workbook.xml`, captured from the source
   * file's `[Content_Types].xml` on read. Templates (.xltx) and macro-enabled
   * workbooks (.xlsm/.xltm) declare a different value here than a plain .xlsx,
   * and Excel uses it (with the file extension) to decide how to open the
   * file. When absent — a freshly created workbook — the writer falls back to
   * the plain-workbook type below.
   */
  workbookContentType?: string;
  /**
   * `Override` declarations for preserved parts this library does not model,
   * keyed by zip-relative path. Round-tripped from the source package so a
   * carried-through part stays classifiable by Excel.
   */
  opaqueContentTypes?: Record<string, string>;
  /**
   * `Default` declarations keyed by lower-case extension, for preserved parts
   * that were registered by extension rather than by an explicit `Override`.
   */
  opaqueContentTypeDefaults?: Record<string, string>;
  media?: { type?: string; extension: string }[];
  worksheets: { fileIndex: number }[];
  chartsheets?: { sheetNo: number }[];
  pivotTables?: {
    tableNumber: number;
    cacheId: string;
    cacheRecords?: unknown;
    isLoaded?: boolean;
  }[];
  tables?: { target: string }[];
  drawings?: { name: string }[];
  externalLinks?: { index: number }[];
  chartEntries?: unknown[];
  chartExEntries?: unknown[];
  chartExStructuredEntries?: unknown[];
  chartColors?: unknown[];
  chartStyles?: unknown[];
  chartExColors?: unknown[];
  chartExStyles?: unknown[];
  commentRefs?: { commentName: string }[];
  formControlRefs?: (string | number)[];
  slicerPartPaths?: string[];
  slicerCachePartPaths?: string[];
  timelinePartPaths?: string[];
  timelineCachePartPaths?: string[];
  threadedCommentSheetIds?: (number | string)[];
  sharedStrings?: { count?: number };
  hasChartsheetVml?: boolean;
  hasCheckboxes?: boolean;
  hasDynamicArrayFormulas?: boolean;
  hasHeaderWatermark?: boolean;
  hasPersons?: boolean;
}

// used for rendering the [Content_Types].xml file; on parse it captures only
// the workbook part's Override ContentType (see parseOpen).
class ContentTypesXform extends BaseXform<{
  workbookContentType?: string;
  overrides?: Record<string, string>;
  defaults?: Record<string, string>;
}> {
  render(xmlStream: XmlSink, model: ContentTypesModel): void {
    xmlStream.openXml(StdDocAttributes);

    xmlStream.openNode("Types", ContentTypesXform.PROPERTY_ATTRIBUTES);

    const mediaHash: { [key: string]: boolean } = {};
    (model.media ?? []).forEach(medium => {
      if (medium.type === "image") {
        // External (linked) images add no part to the package, so they need
        // no Default content-type registration.
        if (isExternalImage(medium)) {
          return;
        }
        // Lower-cased: OPC matches an extension case-insensitively, so treating
        // `PNG` and `png` as different keys emits both and produces a duplicate
        // Default — itself a package error.
        const imageType = medium.extension.toLowerCase();
        if (!mediaHash[imageType]) {
          mediaHash[imageType] = true;
          xmlStream.leafNode("Default", {
            Extension: imageType,
            // SVG's IANA media type is "image/svg+xml"; everything else follows
            // the "image/<ext>" convention.
            ContentType: imageType === "svg" ? "image/svg+xml" : `image/${imageType}`
          });
        }
      }
    });

    xmlStream.leafNode("Default", {
      Extension: "rels",
      ContentType: "application/vnd.openxmlformats-package.relationships+xml"
    });
    xmlStream.leafNode("Default", { Extension: "xml", ContentType: "application/xml" });

    // Extension defaults needed by preserved parts. The caller has already
    // resolved which of these can be a Default and which had to become a
    // per-part Override (see `opaqueContentTypeDeclarations`), so this list
    // never collides with the ones emitted above.
    Object.entries(model.opaqueContentTypeDefaults ?? {}).forEach(([extension, contentType]) => {
      xmlStream.leafNode("Default", { Extension: extension, ContentType: contentType });
    });

    xmlStream.leafNode("Override", {
      PartName: toContentTypesPartName(OOXML_PATHS.xlWorkbook),
      ContentType: model.workbookContentType ?? PLAIN_WORKBOOK_CONTENT_TYPE
    });

    // Preserved parts this library does not model. Emitted first so a later
    // modelled Override always wins: `opaqueContentTypes` is captured from the
    // source package, and if a part has since become modelled the writer's own
    // declaration is the current one.
    Object.entries(model.opaqueContentTypes ?? {}).forEach(([path, contentType]) => {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(path),
        ContentType: contentType
      });
    });

    model.worksheets.forEach(worksheet => {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(worksheetPath(worksheet.fileIndex)),
        ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
      });
    });

    if (model.chartsheets) {
      model.chartsheets!.forEach(cs => {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(chartsheetPath(cs.sheetNo)),
          ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"
        });
      });
    }

    if ((model.pivotTables ?? []).length) {
      // R9-B6: Deduplicate cache content types by cacheId. When multiple pivot tables
      // share the same cache, the cache definition/records files are written only once.
      const writtenCacheIds = new Set<string>();

      // Add content types for each pivot table
      (model.pivotTables ?? []).forEach(pivotTable => {
        const n = pivotTable.tableNumber;
        const cacheId: string = pivotTable.cacheId;

        if (!writtenCacheIds.has(cacheId)) {
          writtenCacheIds.add(cacheId);

          xmlStream.leafNode("Override", {
            PartName: toContentTypesPartName(pivotCacheDefinitionPath(n)),
            ContentType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"
          });
          // R9-B5: Only register cacheRecords content type when the file actually exists.
          // Loaded pivot tables may lack cacheRecords (e.g. OLAP sources).
          const hasCacheRecords = pivotTable.isLoaded ? !!pivotTable.cacheRecords : true;
          if (hasCacheRecords) {
            xmlStream.leafNode("Override", {
              PartName: toContentTypesPartName(pivotCacheRecordsPath(n)),
              ContentType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"
            });
          }
        }

        // Each pivot table always has its own file
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(pivotTablePath(n)),
          ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"
        });
      });
    }

    xmlStream.leafNode("Override", {
      PartName: toContentTypesPartName(OOXML_PATHS.xlTheme1),
      ContentType: "application/vnd.openxmlformats-officedocument.theme+xml"
    });
    xmlStream.leafNode("Override", {
      PartName: toContentTypesPartName(OOXML_PATHS.xlStyles),
      ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"
    });

    // Each externalLink part needs its own Override. Omitted entries make
    // Excel fail to load the external reference (and, in some builds,
    // trigger a "the workbook is damaged" dialog).
    if (model.externalLinks && model.externalLinks.length > 0) {
      for (const link of model.externalLinks) {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(externalLinkPath(link.index)),
          ContentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"
        });
      }
    }

    // Add FeaturePropertyBag if checkboxes are used
    if (model.hasCheckboxes) {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(OOXML_PATHS.xlFeaturePropertyBag),
        ContentType: "application/vnd.ms-excel.featurepropertybag+xml"
      });
    }

    // Add metadata part for dynamic array formulas
    if (model.hasDynamicArrayFormulas) {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(OOXML_PATHS.xlMetadata),
        ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"
      });
    }

    const hasSharedStrings = model.sharedStrings && model.sharedStrings.count;
    if (hasSharedStrings) {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(OOXML_PATHS.xlSharedStrings),
        ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"
      });
    }

    if (model.tables) {
      model.tables!.forEach(table => {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(tablePath(table.target)),
          ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"
        });
      });
    }

    if (model.drawings) {
      model.drawings!.forEach(drawing => {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(drawingPath(drawing.name)),
          ContentType: "application/vnd.openxmlformats-officedocument.drawing+xml"
        });
      });
    }

    if (model.chartEntries) {
      for (const [n, entry] of Object.entries(model.chartEntries) as Array<
        [string, { userShapesXml?: Uint8Array }]
      >) {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(chartPath(n)),
          ContentType: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
        });
        if (entry?.userShapesXml) {
          // `c:userShapes` overlay drawings use the same DrawingML
          // content type as worksheet drawings — Excel distinguishes
          // them via the relationship type, not the content-type.
          xmlStream.leafNode("Override", {
            PartName: toContentTypesPartName(chartUserShapesPath(n)),
            ContentType: "application/vnd.openxmlformats-officedocument.drawing+xml"
          });
        }
      }
    }

    // Track every ChartEx PartName already emitted so the structured
    // and raw entry loops can't duplicate an Override. Open Packaging
    // mandates at most one `<Override>` per PartName — a duplicate
    // surfaces as the "damaged workbook" dialog in Excel. Using an
    // explicit Set also guards against any future drift in the key
    // shape between `chartExEntries` and `chartExStructuredEntries`.
    const chartExPartNamesEmitted = new Set<string>();

    if (model.chartExEntries) {
      for (const n of Object.keys(model.chartExEntries)) {
        const partName = toContentTypesPartName(chartExPath(n));
        if (chartExPartNamesEmitted.has(partName)) {
          continue;
        }
        chartExPartNamesEmitted.add(partName);
        xmlStream.leafNode("Override", {
          PartName: partName,
          // Microsoft's canonical content type for ChartEx parts is
          // `application/vnd.ms-office.chartex+xml` — ALL lowercase.
          // Earlier versions of this library emitted the camel-cased
          // `chartEx+xml` variant; Excel 2016+ is strict about this and
          // drops any chartEx whose content-type doesn't match exactly,
          // which cascades into "Removed Part: /xl/drawings/drawingN.xml
          // (Drawing shape)" because the parent drawing's r:id pointer
          // is left dangling.
          ContentType: "application/vnd.ms-office.chartex+xml"
        });
      }
    }

    if (model.chartExStructuredEntries) {
      for (const n of Object.keys(model.chartExStructuredEntries)) {
        const partName = toContentTypesPartName(chartExPath(n));
        if (chartExPartNamesEmitted.has(partName)) {
          continue;
        }
        chartExPartNamesEmitted.add(partName);
        xmlStream.leafNode("Override", {
          PartName: partName,
          ContentType: "application/vnd.ms-office.chartex+xml"
        });
      }
    }

    if (model.chartStyles) {
      for (const n of Object.keys(model.chartStyles)) {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(chartStylePath(n)),
          ContentType: "application/vnd.ms-office.chartstyle+xml"
        });
      }
    }
    if (model.chartColors) {
      for (const n of Object.keys(model.chartColors)) {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(chartColorsPath(n)),
          ContentType: "application/vnd.ms-office.chartcolorstyle+xml"
        });
      }
    }
    if (model.chartExStyles) {
      for (const n of Object.keys(model.chartExStyles)) {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(chartExStylePath(n)),
          ContentType: "application/vnd.ms-office.chartstyle+xml"
        });
      }
    }
    if (model.chartExColors) {
      for (const n of Object.keys(model.chartExColors)) {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(chartExColorsPath(n)),
          ContentType: "application/vnd.ms-office.chartcolorstyle+xml"
        });
      }
    }

    // VML extension is needed for comments, form controls, header
    // watermarks, OR any chartsheet that carries a `<legacyDrawing>`
    // reference — that last case pins a VML part body through the
    // package without the worksheet loop declaring the extension.
    const hasComments = model.commentRefs && model.commentRefs.length > 0;
    const hasFormControls = model.formControlRefs && model.formControlRefs.length > 0;
    const hasHeaderWatermark = model.hasHeaderWatermark === true;
    const hasChartsheetVml = model.hasChartsheetVml === true;
    if (hasComments || hasFormControls || hasHeaderWatermark || hasChartsheetVml) {
      xmlStream.leafNode("Default", {
        Extension: "vml",
        ContentType: "application/vnd.openxmlformats-officedocument.vmlDrawing"
      });
    }

    if (hasComments) {
      model.commentRefs!.forEach(({ commentName }) => {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(commentsPathFromName(commentName)),
          ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"
        });
      });
    }

    if (hasFormControls) {
      for (const ctrlPropId of model.formControlRefs!) {
        xmlStream.leafNode("Override", {
          PartName: toContentTypesPartName(ctrlPropPath(ctrlPropId)),
          ContentType: "application/vnd.ms-excel.controlproperties+xml"
        });
      }
    }

    // Office 365 threaded comments: each worksheet that has them gets
    // its own override, and the workbook-level person directory gets
    // one more. Writers populate `model.threadedCommentSheetIds` with
    // the worksheet ids that need parts; absent entry means no
    // threaded comments on that sheet.
    const threadedCommentSheetIds: Array<number | string> = model.threadedCommentSheetIds ?? [];
    for (const sheetId of threadedCommentSheetIds) {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(`xl/threadedComments/threadedComment${sheetId}.xml`),
        ContentType: "application/vnd.ms-excel.threadedcomments+xml"
      });
    }
    if (model.hasPersons) {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName("xl/persons/person.xml"),
        ContentType: "application/vnd.ms-excel.person+xml"
      });
    }

    // Raw-passthrough parts for slicers / timelines. The path lists
    // were populated in `prepareModel` from the workbook's captured
    // raw parts. Content type URIs come from MS-XLSX §2.1.32 and the
    // 2011 timeline extension addendum.
    for (const path of model.slicerPartPaths ?? []) {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(path),
        ContentType: "application/vnd.ms-excel.slicer+xml"
      });
    }
    for (const path of model.slicerCachePartPaths ?? []) {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(path),
        ContentType: "application/vnd.ms-excel.slicerCache+xml"
      });
    }
    for (const path of model.timelinePartPaths ?? []) {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(path),
        ContentType: "application/vnd.ms-excel.timeline+xml"
      });
    }
    for (const path of model.timelineCachePartPaths ?? []) {
      xmlStream.leafNode("Override", {
        PartName: toContentTypesPartName(path),
        ContentType: "application/vnd.ms-excel.timelineCache+xml"
      });
    }

    xmlStream.leafNode("Override", {
      PartName: toContentTypesPartName(OOXML_PATHS.docPropsCore),
      ContentType: "application/vnd.openxmlformats-package.core-properties+xml"
    });
    xmlStream.leafNode("Override", {
      PartName: toContentTypesPartName(OOXML_PATHS.docPropsApp),
      ContentType: "application/vnd.openxmlformats-officedocument.extended-properties+xml"
    });

    xmlStream.closeNode();
  }

  parseOpen(node: ParseOpenTag): boolean {
    // Read side: capture the Override for `/xl/workbook.xml`, whose ContentType
    // varies by workbook kind (plain / template / macro-enabled) and must be
    // round-tripped so Excel doesn't see a content-type ⁄ extension mismatch.
    //
    // Every Override is also recorded in `overrides`, because a part this
    // library does not model is preserved verbatim on write and needs its
    // declared content type to travel with it — bytes alone leave Excel with a
    // part it cannot classify. The modelled parts re-declare themselves during
    // `render`, so their entries here are simply unused.
    const localName = node.name.includes(":")
      ? node.name.slice(node.name.indexOf(":") + 1)
      : node.name;
    if (localName === "Override") {
      const partName = node.attributes.PartName;
      const contentType = node.attributes.ContentType;
      if (partName && contentType) {
        const overrides = { ...(this.model?.overrides ?? {}) };
        overrides[fromContentTypesPartName(partName)] = contentType;
        this.model = { ...(this.model ?? {}), overrides };
        if (partName === toContentTypesPartName(OOXML_PATHS.xlWorkbook)) {
          this.model = { ...this.model, workbookContentType: contentType };
        }
      }
    } else if (localName === "Default") {
      // `Default` matters as much as `Override` for preserved parts, and it is
      // easy to overlook because the parts this library models are all declared
      // by Override. `xl/printerSettings/printerSettings1.bin` is typical: Excel
      // registers it with a single `Default Extension="bin"`, so capturing only
      // Overrides preserves the bytes and loses the declaration — which the
      // OOXML self-check reports as `content-types-missing-for-part`.
      const extension = node.attributes.Extension;
      const contentType = node.attributes.ContentType;
      if (extension && contentType) {
        const defaults = { ...(this.model?.defaults ?? {}) };
        defaults[extension.toLowerCase()] = contentType;
        this.model = { ...(this.model ?? {}), defaults };
      }
    }
    return true;
  }

  parseText(): void {}

  parseClose(name: string): boolean {
    // Keep consuming until the manifest's root `<Types>` closes.
    const localName = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
    return localName !== "Types";
  }

  static PROPERTY_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/package/2006/content-types"
  };
}

export { ContentTypesXform };
