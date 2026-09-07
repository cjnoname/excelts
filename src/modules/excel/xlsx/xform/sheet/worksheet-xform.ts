import type { ImageModel } from "@excel/core/image";
import { StyledBlankRuns } from "@excel/core/styled-blanks";
import type { ConditionalFormattingRule } from "@excel/types";
import { decodeCol, encodeCol } from "@excel/utils/address";
import { colCache } from "@excel/utils/col-cache";
import {
  buildDrawingAnchorsAndRels,
  buildWatermarkOverlayAnchors,
  buildFormControlAnchors,
  buildShapeAnchors,
  resolveMediaTarget
} from "@excel/utils/drawing-utils";
import {
  chartRelTargetFromDrawing,
  chartExRelTargetFromDrawing,
  commentsRelTargetFromWorksheet,
  ctrlPropRelTargetFromWorksheet,
  drawingRelTargetFromWorksheet,
  pivotTableRelTargetFromWorksheet,
  resolveRelTarget,
  tableRelTargetFromWorksheet,
  vmlDrawingRelTargetFromWorksheet,
  vmlDrawingHFRelTargetFromWorksheet
} from "@excel/utils/ooxml-paths";
import { RelType } from "@excel/xlsx/rel-type";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { RelationshipModel } from "@excel/xlsx/xform/core/relationship-xform";
import { ListXform } from "@excel/xlsx/xform/list-xform";
import { PreservedSubtreeXform } from "@excel/xlsx/xform/preserved-xml-xform";
import { AutoFilterXform, resolveAutoFilterRef } from "@excel/xlsx/xform/sheet/auto-filter-xform";
import { ConditionalFormattingsXform } from "@excel/xlsx/xform/sheet/cf/conditional-formattings-xform";
import { ColBreaksXform } from "@excel/xlsx/xform/sheet/col-breaks-xform";
import { ColXform } from "@excel/xlsx/xform/sheet/col-xform";
import { DataValidationsXform } from "@excel/xlsx/xform/sheet/data-validations-xform";
import { DimensionXform } from "@excel/xlsx/xform/sheet/dimension-xform";
import { DrawingXform } from "@excel/xlsx/xform/sheet/drawing-xform";
import { ExtLstXform } from "@excel/xlsx/xform/sheet/ext-lst-xform";
import { HeaderFooterXform } from "@excel/xlsx/xform/sheet/header-footer-xform";
import { isInternalLink, HyperlinkXform } from "@excel/xlsx/xform/sheet/hyperlink-xform";
import { IgnoredErrorsXform } from "@excel/xlsx/xform/sheet/ignored-errors-xform";
import { MergeCellXform } from "@excel/xlsx/xform/sheet/merge-cell-xform";
import { Merges } from "@excel/xlsx/xform/sheet/merges";
import { PageMarginsXform } from "@excel/xlsx/xform/sheet/page-margins-xform";
import { PageSetupXform } from "@excel/xlsx/xform/sheet/page-setup-xform";
import { PictureXform } from "@excel/xlsx/xform/sheet/picture-xform";
import { PrintOptionsXform } from "@excel/xlsx/xform/sheet/print-options-xform";
import { RowBreaksXform } from "@excel/xlsx/xform/sheet/row-breaks-xform";
import { RowXform } from "@excel/xlsx/xform/sheet/row-xform";
import { SheetFormatPropertiesXform } from "@excel/xlsx/xform/sheet/sheet-format-properties-xform";
import { SheetPropertiesXform } from "@excel/xlsx/xform/sheet/sheet-properties-xform";
import { SheetProtectionXform } from "@excel/xlsx/xform/sheet/sheet-protection-xform";
import { SheetViewXform } from "@excel/xlsx/xform/sheet/sheet-view-xform";
import { TablePartXform } from "@excel/xlsx/xform/sheet/table-part-xform";
import { emuToPx } from "@utils/units";
import { StdDocAttributes } from "@xml/writer";

/**
 * Recursively collect every attribute value shaped like a relationship id
 * (`rId1`, `rId42`, …) out of a captured `EchoNode`-style tree. A preserved
 * `<xdr:grpSp>` group can reference relationships via several attribute names
 * depending on the child element (`r:embed` on a blip, `r:id` on an
 * `hlinkClick`, etc.), so this matches by value shape rather than trying to
 * enumerate every attribute name DrawingML might use.
 */
function collectRelIds(
  node: { attrs?: Record<string, unknown>; children?: unknown[] } | undefined,
  into: Set<string>
): void {
  if (!node) {
    return;
  }
  if (node.attrs) {
    for (const value of Object.values(node.attrs)) {
      if (typeof value === "string" && /^rId\d+$/.test(value)) {
        into.add(value);
      }
    }
  }
  for (const child of node.children ?? []) {
    collectRelIds(child as typeof node, into);
  }
}

function mergeRule<T extends object>(rule: T, extRule: T): void {
  (Object.keys(extRule) as (keyof T)[]).forEach(key => {
    const value = rule[key];
    const extValue = extRule[key];
    if (value === undefined && extValue !== undefined) {
      rule[key] = extValue;
    }
  });
}

/** A CF rule carrying the transient x14Id used to pair classic and ext rules. */
type MergeableCfRule = ConditionalFormattingRule & { x14Id?: string };
type MergeableCf = { ref: string; rules: MergeableCfRule[] };

function mergeConditionalFormattings(
  model: MergeableCf[] | undefined,
  extModel: MergeableCf[] | undefined
): MergeableCf[] | undefined {
  // conditional formattings are rendered in worksheet.conditionalFormatting and also in
  // worksheet.extLst.ext.x14:conditionalFormattings
  // some (e.g. dataBar) are even spread across both!
  if (!extModel || !extModel.length) {
    return model;
  }
  if (!model || !model.length) {
    return extModel;
  }

  // index model rules by x14Id
  const cfMap: Record<string, MergeableCf> = {};
  const ruleMap: Record<string, MergeableCfRule> = {};
  model.forEach(cf => {
    cfMap[cf.ref] = cf;
    cf.rules.forEach(rule => {
      const { x14Id } = rule;
      if (x14Id) {
        ruleMap[x14Id] = rule;
      }
    });
  });

  extModel.forEach(extCf => {
    extCf.rules.forEach(extRule => {
      const rule = extRule.x14Id ? ruleMap[extRule.x14Id] : undefined;
      if (rule) {
        // merge with matching rule
        mergeRule(rule, extRule);
      } else if (cfMap[extCf.ref]) {
        // reuse existing cf ref
        cfMap[extCf.ref].rules.push(extRule);
      } else {
        // create new cf
        model.push({
          ref: extCf.ref,
          rules: [extRule]
        });
      }
    });
  });

  // need to cope with rules in extModel that don't exist in model
  return model;
}

/** Whether the parsed rows already hold a cell at `address`. */
function hasCellAt(
  rows:
    | readonly (
        | { readonly cells?: readonly ({ readonly address?: string } | undefined)[] }
        | undefined
      )[]
    | undefined,
  address: string
): boolean {
  for (const row of rows ?? []) {
    for (const cell of row?.cells ?? []) {
      if (cell?.address === address) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Turn a collapsed read's rectangles back into one `<c s="N"/>` per cell.
 *
 * A cell the model already has wins: the rectangles cover cells that held nothing when they were read, but a caller may
 * have written into one since, and a blank must not overwrite a value.
 *
 * The rows are re-sorted after insertion because a rectangle may reach columns left of ones the model already had, and
 * the row xform derives its `spans` from the order it is handed.
 */
/** A collapsed rectangle as the model carries it: the source index, and the style it resolved to. */
interface StyledBlankRangeModel {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly styleIndex: number;
  /** Filled in by `reconcile`, where the style table is reachable. */
  readonly style?: unknown;
}

function expandStyledBlanks(model: {
  rows?: { number: number; cells?: unknown[] }[];
  styledBlankRanges?: readonly unknown[];
}): void {
  const ranges = model.styledBlankRanges as readonly StyledBlankRangeModel[] | undefined;
  if (ranges === undefined || ranges.length === 0) {
    return;
  }
  const rows = (model.rows ??= []);
  const byNumber = new Map(rows.map(row => [row.number, row]));
  for (const range of ranges) {
    for (let row = range.firstRow; row <= range.lastRow; row++) {
      let target = byNumber.get(row + 1);
      if (target === undefined) {
        target = { number: row + 1, cells: [] };
        rows.push(target);
        byNumber.set(row + 1, target);
      }
      const cells = (target.cells ??= []) as { address?: string; style?: unknown }[];
      const before = cells.length;
      for (let column = range.firstColumn; column <= range.lastColumn; column++) {
        const address = `${encodeCol(column)}${row + 1}`;
        if (cells.some(cell => cell?.address === address)) {
          continue;
        }
        // The resolved style, not the source index — see the note in `reconcile`. An unresolved range still produces a
        // cell, because losing the cell would shrink the sheet; it just carries no formatting.
        cells.push({ address, style: range.style ?? {} } as never);
      }
      cells.sort((left, right) =>
        (left.address ?? "").length === (right.address ?? "").length
          ? (left.address ?? "").localeCompare(right.address ?? "")
          : (left.address ?? "").length - (right.address ?? "").length
      );
      // **`spans` has to be restated, and this is the last thing that made the round trip lossy.**
      //
      // A row's `spans` is read off the file into the row model during parse; a row whose cells were collapsed away has
      // none, and one synthesised here never had one. Without it the row is written as `<row r="4">` where it arrived as
      // `<row r="4" spans="1:3">` — every cell identical, and the file still not the one that was read. Recomputed only
      // when this rectangle actually added something, so a row that already had its own span keeps it.
      if (cells.length !== before) {
        const columns = cells
          .map(cell => spanColumn(cell.address))
          .filter((column): column is number => column !== undefined);
        if (columns.length > 0) {
          // **`min`/`max`, not `spans`.** The row xform renders the attribute from those two numbers; a `spans` string
          // set here is a field nothing reads, which is exactly what the first attempt produced — cells byte-identical
          // and the row tag still missing its attribute.
          const row = target as { min?: number; max?: number };
          row.min = row.min === undefined ? Math.min(...columns) : Math.min(row.min, ...columns);
          row.max = row.max === undefined ? Math.max(...columns) : Math.max(row.max, ...columns);
        }
      }
    }
  }
  rows.sort((left, right) => left.number - right.number);
  // **The dimension has to grow with them.** It is computed from the cells that existed when the workbook was committed,
  // so a collapsed read reported `A1:H200` for a sheet whose formatting reached H8000 and the written file said so.
  // Excel treats the dimension as advisory, which is exactly why a wrong one is easy to ship unnoticed.
  const dimensions = (
    model as {
      dimensions?: { top: number; left: number; bottom: number; right: number };
    }
  ).dimensions;
  if (dimensions !== undefined) {
    for (const range of ranges) {
      dimensions.top = Math.min(dimensions.top, range.firstRow + 1);
      dimensions.left = Math.min(dimensions.left, range.firstColumn + 1);
      dimensions.bottom = Math.max(dimensions.bottom, range.lastRow + 1);
      dimensions.right = Math.max(dimensions.right, range.lastColumn + 1);
    }
  }
  // Consumed. Leaving it would make a second `prepare` — which `writeBothFormats` does, once per container — expand
  // the same rectangles onto cells that already exist, and that is a silent doubling rather than an error.
  delete model.styledBlankRanges;
}

/**
 * The one-based column of an `"A4"`-style address, for a row's `spans`.
 *
 * `decodeCol` plus one rather than a private base-26 loop: this file held two such loops — one decoding to a *one*-based
 * column and one encoding from a *zero*-based one — which made them look like they disagreed about the base when they
 * were simply serving callers that use different ones. Sharing the parser leaves the `+ 1` as the only difference, which
 * is the thing that is actually true here, and brings the upper-bound check with it.
 */
function spanColumn(address: string | undefined): number | undefined {
  const match = address === undefined ? null : /^([A-Z]+)/i.exec(address);
  if (match === null) {
    return undefined;
  }
  try {
    return decodeCol(match[1]!.toUpperCase()) + 1;
  } catch {
    // A column past the sheet's last is not a span this row can state. `spans` is a hint Excel recomputes, so omitting
    // it costs nothing — where writing `XFE` into it would be a value no reader accepts.
    return undefined;
  }
}

class WorkSheetXform extends BaseXform {
  /**
   * The child xforms, keyed by element name.
   *
   * Typed as the base class, which loses every child's own signature. `dataValidations` is named separately
   * below because its `render` takes the workbook's date system as a third argument, and reaching it through
   * this map would have needed a cast at the call site — a cast being exactly how a signature change stops
   * being checked.
   */
  declare public map: Record<string, BaseXform>;
  declare private ignoreNodes: string[];
  declare public parser?: BaseXform;
  declare private namespaceAttributes?: Record<string, string>;
  declare private mcIgnorable?: string;

  static WORKSHEET_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "xmlns:mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "xmlns:x14ac": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac",
    "mc:Ignorable": "x14ac"
  };

  /**
   * Styled blank cells this sheet collapsed, when the read asked for it.
   *
   * Accumulated as rectangles by `StyledBlankRuns` and handed to the model in `parseClose`, where both writers expand
   * them again. Created eagerly so the row xform can hold a reference to the collector rather than reach back through
   * this class for one.
   */
  declare private styledBlanks?: StyledBlankRuns;

  /**
   * The data-validation child, held at its own type so `render` can be given the workbook's date system.
   *
   * The same instance that sits in `map`, so parsing and reconciling reach it either way.
   */
  private readonly dataValidations = new DataValidationsXform();

  constructor(options?: {
    maxRows?: number;
    maxCols?: number;
    ignoreNodes?: string[];
    blankCells?: "keep" | "collapse";
  }) {
    super();

    const { maxRows, maxCols, ignoreNodes, blankCells } = options || {};
    this.styledBlanks = blankCells === "collapse" ? new StyledBlankRuns() : undefined;

    this.ignoreNodes = ignoreNodes ?? [];

    this.map = {
      sheetPr: new SheetPropertiesXform(),
      dimension: new DimensionXform(),
      sheetViews: new ListXform({
        tag: "sheetViews",
        count: false,
        childXform: new SheetViewXform()
      }),
      sheetFormatPr: new SheetFormatPropertiesXform(),
      cols: new ListXform({ tag: "cols", count: false, childXform: new ColXform() }),
      sheetData: new ListXform({
        tag: "sheetData",
        count: false,
        empty: true,
        childXform: new RowXform({
          maxItems: maxCols,
          ...(blankCells === undefined ? {} : { blankCells }),
          ...(this.styledBlanks === undefined
            ? {}
            : {
                collectStyledBlank: (row: number, column: number, styleId: number): void => {
                  this.styledBlanks!.add(row, column, styleId);
                }
              })
        }),
        maxItems: maxRows
      }),
      autoFilter: new AutoFilterXform(),
      sortState: new PreservedSubtreeXform(),
      mergeCells: new ListXform({
        tag: "mergeCells",
        count: true,
        childXform: new MergeCellXform()
      }),
      rowBreaks: new RowBreaksXform(),
      colBreaks: new ColBreaksXform(),
      hyperlinks: new ListXform({
        tag: "hyperlinks",
        count: false,
        childXform: new HyperlinkXform()
      }),
      pageMargins: new PageMarginsXform(),
      dataValidations: this.dataValidations,
      pageSetup: new PageSetupXform(),
      headerFooter: new HeaderFooterXform(),
      printOptions: new PrintOptionsXform(),
      picture: new PictureXform(),
      drawing: new DrawingXform(),
      legacyDrawingHF: new DrawingXform("legacyDrawingHF"),
      sheetProtection: new SheetProtectionXform(),
      tableParts: new ListXform({
        tag: "tableParts",
        count: true,
        childXform: new TablePartXform()
      }),
      conditionalFormatting: new ConditionalFormattingsXform(),
      extLst: new ExtLstXform(),
      ignoredErrors: new IgnoredErrorsXform()
    };
  }

  prepare(model, options) {
    options.merges = new Merges();
    model.hyperlinks = options.hyperlinks = [];
    model.comments = options.comments = [];

    // Some Excel builds are surprisingly strict when legacy form controls exist.
    // Emitting a default sheetView (workbookViewId=0) matches typical Excel output
    // and avoids relying on optional element handling.
    if (model.formControls && model.formControls.length > 0) {
      if (!model.views || model.views.length === 0) {
        model.views = [{ workbookViewId: 0 }];
      }
    }

    // **The collapsed styled blanks, put back before anything is written.**
    //
    // This is the half that makes `blankCells: "collapse"` lossless in *this* container. The XLSB writer expands the
    // same rectangles in `sheetRowsFromModel`; doing it here means a formatted region survives a round trip through
    // either one, and that an option's fidelity does not depend on which container a workbook came from.
    //
    // Done in `prepare` rather than during render because the cells have to exist before the row xform counts them,
    // assigns spans and resolves styles — the same reason every other derived cell is materialised here.
    expandStyledBlanks(model);

    options.formulae = {};
    options.siFormulae = 0;
    this.map.cols.prepare(model.cols, options);
    this.map.sheetData.prepare(model.rows, options);
    this.map.conditionalFormatting.prepare(model.conditionalFormattings, options);
    // The workbook's date system, recorded on the *worksheet* model so that `render` — which runs on a
    // separately constructed `WorksheetXform`, with no options bag and no shared instance state — can convert a
    // `type: "date"` validation bound against the right epoch. It is not written onto the caller's validation
    // rules: those are the objects `Cell.getValidation` hands back, and a serialiser must not leave anything
    // behind in them.
    //
    // Cleared rather than set to `false`, so a workbook written under the 1904 system and then switched back
    // does not keep a stale `true`, and so the default leaves no trace in a model a caller can inspect.
    if (options.date1904 === true) {
      model.date1904 = true;
    } else {
      delete model.date1904;
    }

    model.mergeCells = options.merges.mergeCells;

    // prepare relationships
    const rels: RelationshipModel[] = (model.rels = []);

    function nextRid(r: readonly unknown[]) {
      // Derive the next id from the highest existing numeric suffix, not the
      // array length. Length-based numbering only works while a rels list is a
      // clean, gap-free rId1..rIdN sequence — true for lists this codebase
      // builds from empty, but NOT once we preserve a subset of externally
      // authored rels (e.g. keeping a `<xdr:grpSp>` group's original rel
      // entries in place instead of renumbering them). There, length-based ids
      // could collide with an id still in use.
      let max = 0;
      for (const rel of r) {
        const id = (rel as { Id?: string } | undefined)?.Id;
        const m = id ? /^rId(\d+)$/.exec(id) : null;
        if (m) {
          max = Math.max(max, Number(m[1]));
        }
      }
      return `rId${max + 1}`;
    }

    model.hyperlinks.forEach(hyperlink => {
      // Internal links (e.g. "#Sheet2!A1") use the location attribute only,
      // no relationship is needed in the .rels file.
      if (isInternalLink(hyperlink.target)) {
        return;
      }
      const rId = nextRid(rels);
      hyperlink.rId = rId;
      rels.push({
        Id: rId,
        Type: RelType.Hyperlink,
        Target: hyperlink.target,
        TargetMode: "External"
      });
    });

    // prepare comment relationships
    // Use fileIndex (sequential 1-based) for file naming instead of model.id
    // (the workbook-level sheet ID) because model.id can have gaps when sheets
    // have been deleted, causing a mismatch between the relationship targets
    // and the actual ZIP entry paths written by addWorksheets().
    const { fileIndex } = model;
    if (model.comments.length > 0) {
      const comment = {
        Id: nextRid(rels),
        Type: RelType.Comments,
        Target: commentsRelTargetFromWorksheet(fileIndex)
      };
      rels.push(comment);
      const vmlDrawing = {
        Id: nextRid(rels),
        Type: RelType.VmlDrawing,
        Target: vmlDrawingRelTargetFromWorksheet(fileIndex)
      };
      rels.push(vmlDrawing);

      model.comments.forEach(item => {
        item.refAddress = colCache.decodeAddress(item.ref);
      });

      options.commentRefs.push({
        commentName: `comments${fileIndex}`,
        vmlDrawing: `vmlDrawing${fileIndex}`
      });
    }

    // Office 365 threaded comments — a separate rel pointing at the
    // per-sheet `xl/threadedComments/threadedComment{N}.xml` part.
    // Excel requires the rel to exist even when the sheet already has
    // a classic comments rel (the two are independent — legacy VML
    // carries the fallback text, threaded comments carry the modern
    // conversation tree).
    if (model.threadedComments && model.threadedComments.length > 0) {
      rels.push({
        Id: nextRid(rels),
        Type: RelType.ThreadedComments,
        Target: `../threadedComments/threadedComment${fileIndex}.xml`
      });
    }

    // Relationships to preserved parts this library does not model — printer
    // settings, query tables. `rels` is rebuilt from empty on every write, so
    // without this the part survives in the package with nothing pointing at it,
    // which to Excel is the same as it not being there.
    //
    // The original rId is reused when free, because the preserved part's own XML
    // may name it; on a collision `nextRid` allocates above every id in use.
    const opaqueIdRemap = new Map<string, string>();
    for (const opaque of model.opaqueRels ?? []) {
      const taken = rels.some(rel => rel.Id === opaque.id);
      const id = taken ? nextRid(rels) : opaque.id;
      if (id !== opaque.id) {
        opaqueIdRemap.set(opaque.id, id);
      }
      rels.push({
        Id: id,
        Type: opaque.type,
        Target: opaque.target,
        ...(opaque.targetMode ? { TargetMode: opaque.targetMode } : {})
      });
    }

    // Sheet XML that names one of those ids has to follow it. `<pageSetup r:id>`
    // is the case that occurs in practice: without this the reference either
    // vanishes with the id or, worse, keeps pointing at an id a hyperlink or
    // drawing has since been given — a silently wrong target rather than a
    // missing one.
    if (model.pageSetup?.rId) {
      const remapped = opaqueIdRemap.get(model.pageSetup.rId);
      if (remapped) {
        model.pageSetup = { ...model.pageSetup, rId: remapped };
      } else if (!rels.some(rel => rel.Id === model.pageSetup.rId)) {
        // The printer-settings part is gone (dropped as unreachable, or never
        // preserved), so the attribute must go rather than dangle.
        model.pageSetup = { ...model.pageSetup, rId: undefined };
      }
    }

    // Handle pre-loaded drawing (from file read) that may contain charts or other non-image content.
    // Chart anchors (with chartNumber from reconcile) are preserved and get fresh rels.
    // Group anchors (`<xdr:grpSp>`, captured verbatim by GenericEchoXform — no
    // programmatic API mutates these) are preserved as-is. Image anchors are
    // discarded here and rebuilt from model.media below, since that is the path
    // Image.place()/etc. actually mutate.
    if (model.drawing && model.drawing.anchors) {
      const drawing = model.drawing;
      drawing.rId = nextRid(rels);
      if (!drawing.name) {
        drawing.name = `drawing${++options.drawingsCount}`;
      }

      // Separate chart anchors (preserved + renumbered) and group anchors
      // (preserved verbatim) from image anchors (rebuilt from model.media
      // below). `a` is a drawing-anchor model element (a prepare()-model
      // substructure shared with the drawing xform); kept `any` until that
      // model is typed.
      const chartAnchors = drawing.anchors.filter((a: any) => a.chartNumber || a.chartExNumber);
      const groupAnchors = drawing.anchors.filter(
        (a: any) => a.group && !a.chartNumber && !a.chartExNumber
      );

      // A group anchor's captured XML references its original rIds directly
      // (blip r:embed, hlinkClick r:id, …) with no remapping, so keep ONLY the
      // rel entries a preserved group actually points at — not the whole
      // original `drawing.rels`. Keeping everything would leave stale,
      // never-referenced rels in the array, shifting `nextRid`'s numbering for
      // freshly built chart/image rels.
      const referencedRelIds = new Set<string>();
      for (const anchor of groupAnchors) {
        collectRelIds((anchor as any).group, referencedRelIds);
      }
      const preservedRels = (drawing.rels ?? []).filter((rel: any) => referencedRelIds.has(rel.Id));

      // Reset anchors — chart anchors re-added (renumbered) below, group
      // anchors preserved verbatim, image anchors rebuilt from model.media.
      drawing.anchors = [...groupAnchors];
      drawing.rels = preservedRels;

      // Re-add chart anchors and build their rels
      for (const anchor of chartAnchors) {
        const chartRId = nextRid(drawing.rels);
        if (anchor.chartExNumber) {
          // Office 2016+ cx chart
          drawing.rels.push({
            Id: chartRId,
            Type: RelType.ChartEx,
            Target: chartExRelTargetFromDrawing(anchor.chartExNumber)
          });
          anchor.graphicFrame = {
            ...anchor.graphicFrame,
            rId: chartRId,
            isChartEx: true,
            index: anchor.graphicFrame?.index,
            name: anchor.graphicFrame?.name ?? `Chart ${anchor.chartExNumber}`
          };
          // ChartEx MUST be serialised inside `<mc:AlternateContent>`
          // — see TwoCellAnchorXform.render for the full rationale.
          // Tag the anchor here so re-saves of files we authored
          // ourselves (which load without the wrapper in the current
          // codebase) still emit the correct structure on the next
          // write. Files that came in already wrapped keep whatever
          // requires value the parser captured.
          if (!anchor.alternateContent) {
            anchor.alternateContent = { requires: "cx1" };
          }
        } else {
          // Traditional c: chart
          drawing.rels.push({
            Id: chartRId,
            Type: RelType.Chart,
            Target: chartRelTargetFromDrawing(anchor.chartNumber)
          });
          anchor.graphicFrame = {
            ...anchor.graphicFrame,
            rId: chartRId,
            index: anchor.graphicFrame?.index,
            name: anchor.graphicFrame?.name ?? `Chart ${anchor.chartNumber}`
          };
        }
        drawing.anchors.push(anchor);
      }

      options.drawings.push(drawing);
      rels.push({
        Id: drawing.rId,
        Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
        Target: drawingRelTargetFromWorksheet(drawing.name)
      });
    }

    // Handle programmatic charts (from worksheet.addChart API) that are NOT already
    // in the drawing. Charts loaded from XLSX are already in drawing.anchors with
    // chartNumber — only add truly new charts.
    if (model.charts && model.charts.length > 0) {
      // Collect chartNumbers already present in the drawing
      const existingChartNumbers = new Set<number>();
      const existingChartExNumbers = new Set<number>();
      if (model.drawing?.anchors) {
        for (const a of model.drawing.anchors) {
          if (a.chartNumber) {
            existingChartNumbers.add(a.chartNumber);
          }
          if (a.chartExNumber) {
            existingChartExNumbers.add(a.chartExNumber);
          }
        }
      }

      // `c` is a model.charts element (prepare()-model substructure); kept
      // `any` until that model is typed.
      const newCharts = model.charts.filter((c: any) => {
        if (c.chartNumber && !existingChartNumbers.has(c.chartNumber)) {
          return true;
        }
        if (c.chartExNumber && !existingChartExNumbers.has(c.chartExNumber)) {
          return true;
        }
        return false;
      });

      if (newCharts.length > 0) {
        // Ensure a drawing exists
        if (!model.drawing) {
          model.drawing = {
            anchors: [],
            rels: [],
            rId: nextRid(rels),
            name: `drawing${++options.drawingsCount}`
          };
          options.drawings.push(model.drawing);
          rels.push({
            Id: model.drawing.rId,
            Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
            Target: drawingRelTargetFromWorksheet(model.drawing.name)
          });
        }

        const drawing = model.drawing;
        for (const chartAnchor of newCharts) {
          // Chart `ChartAnchorModel.range` stores absolute position
          // (`pos.x/y`) and extent (`ext.cx/cy`) in EMU — the native
          // OOXML unit. The drawing xform pipeline (PosXform,
          // ExtXform) expects pixels at 96 dpi (the image convention
          // — `ext.width/height`) and multiplies by `EMU_PER_PIXEL_AT_96_DPI`
          // on render. Normalise at this boundary: convert the EMU
          // values to pixels so downstream xforms re-convert to EMU
          // without doubling.
          //
          // Without this conversion an absolute-anchored chart wrote
          // `<xdr:pos x="8709660000" y="8709660000"/>` for a 914400
          // EMU position (a 9525× overshoot) and
          // `<xdr:ext cx="NaN" cy="NaN"/>` because `ext` carried
          // `{ cx, cy }` keys but ExtXform looked for `{ width,
          // height }`.
          const normalizedRange: Record<string, unknown> = { ...chartAnchor.range };
          if (chartAnchor.range.pos) {
            normalizedRange.pos = {
              x: emuToPx(chartAnchor.range.pos.x),
              y: emuToPx(chartAnchor.range.pos.y)
            };
          }
          if (chartAnchor.range.ext && chartAnchor.range.ext.cx !== undefined) {
            normalizedRange.ext = {
              width: emuToPx(chartAnchor.range.ext.cx),
              height: emuToPx(chartAnchor.range.ext.cy)
            };
          }
          const chartRId = nextRid(drawing.rels);
          if (chartAnchor.chartExNumber) {
            drawing.rels.push({
              Id: chartRId,
              Type: RelType.ChartEx,
              Target: chartExRelTargetFromDrawing(chartAnchor.chartExNumber)
            });
            drawing.anchors.push({
              range: normalizedRange,
              chartExNumber: chartAnchor.chartExNumber,
              alternateContent: { requires: "cx1" },
              graphicFrame: {
                rId: chartRId,
                isChartEx: true,
                name: `Chart ${chartAnchor.chartExNumber}`
              }
            });
          } else {
            drawing.rels.push({
              Id: chartRId,
              Type: RelType.Chart,
              Target: chartRelTargetFromDrawing(chartAnchor.chartNumber)
            });
            drawing.anchors.push({
              range: normalizedRange,
              chartNumber: chartAnchor.chartNumber,
              graphicFrame: {
                rId: chartRId,
                name: `Chart ${chartAnchor.chartNumber}`
              }
            });
          }
        }
      }
    }

    // Split `model.media` (a discriminated union keyed by `type`) into the four
    // concrete member types so each downstream branch is typed.
    //
    // NOTE: `imageMedia` is typed as the `ImageModel` `image` member here, but it
    // flows into `buildDrawingAnchorsAndRels`, whose `ImageMedium.range` is the
    // looser `DrawingRange` whose `ext` requires `{ width: number; height: number }`
    // (or `{ cx; cy }`), while `ImageRangeModel.ext` is `{ width?; height? }`. The
    // two are NOT assignable (optional vs required ext dims), so the call site below
    // bridges via `unknown`. Unifying `ImageRangeModel`/`DrawingRange` is a separate
    // drawing-subsystem refactor; until then the bridge cast is explicit and local.
    const backgroundMedia: Extract<ImageModel, { type: "background" }>[] = [];
    const imageMedia: Extract<ImageModel, { type: "image" }>[] = [];
    const watermarkMedia: Extract<ImageModel, { type: "watermark" }>[] = [];
    const headerImageMedia: Extract<ImageModel, { type: "headerImage" }>[] = [];
    (model.media as ImageModel[]).forEach(medium => {
      if (medium.type === "background") {
        backgroundMedia.push(medium);
      } else if (medium.type === "image") {
        imageMedia.push(medium);
      } else if (medium.type === "watermark") {
        watermarkMedia.push(medium);
      } else if (medium.type === "headerImage") {
        headerImageMedia.push(medium);
      }
    });

    // Handle background images. Background pictures are always embedded —
    // external (linked) images are rejected in addBackgroundImage because Excel
    // drops a background whose relationship uses TargetMode="External".
    backgroundMedia.forEach(medium => {
      const bookImage = options.media[medium.imageId];
      // Guard against an invalid imageId — same as the image/watermark paths.
      if (!bookImage) {
        return;
      }
      const rId = nextRid(rels);
      rels.push({
        Id: rId,
        Type: RelType.Image,
        Target: resolveMediaTarget(bookImage)
      });
      model.background = { rId };
      model.image = bookImage;
    });

    // Handle embedded images — create drawing model using shared utility
    if (imageMedia.length > 0) {
      let { drawing } = model;
      if (!drawing) {
        drawing = model.drawing = {
          rId: nextRid(rels),
          name: `drawing${++options.drawingsCount}`,
          anchors: [],
          rels: []
        };
        options.drawings.push(drawing);
        rels.push({
          Id: drawing.rId,
          Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
          Target: drawingRelTargetFromWorksheet(drawing.name)
        });
      }

      // Bridge to the drawing subsystem's looser media shape — see the NOTE on
      // `imageMedia` above. `ImageRangeModel.ext` (`{ width?; height? }`) is not
      // assignable to `DrawingRange.ext` (`{ width; height }` | `{ cx; cy }`),
      // so cross via `unknown`. The runtime shapes are compatible.
      const result = buildDrawingAnchorsAndRels(
        imageMedia as unknown as Parameters<typeof buildDrawingAnchorsAndRels>[0],
        drawing.rels,
        {
          getBookImage: id => options.media[id as number],
          nextRId: currentRels => nextRid(currentRels)
        }
      );
      drawing.anchors.push(...result.anchors);
      drawing.rels = result.rels;
    }

    // Handle watermark overlay images — placed as a full-sheet drawing with transparency
    if (watermarkMedia.length > 0) {
      let { drawing } = model;
      if (!drawing) {
        drawing = model.drawing = {
          rId: nextRid(rels),
          name: `drawing${++options.drawingsCount}`,
          anchors: [],
          rels: []
        };
        options.drawings.push(drawing);
        rels.push({
          Id: drawing.rId,
          Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
          Target: drawingRelTargetFromWorksheet(drawing.name)
        });
      }

      // `buildWatermarkOverlayAnchors` rather than the arithmetic inline, because the XLSB writer needs
      // the identical picture and had nothing of the sort — it wrote an overlay watermark into the
      // header/footer VML instead.
      drawing.anchors.push(
        ...buildWatermarkOverlayAnchors(
          watermarkMedia as { imageId: string | number; opacity?: number }[],
          {
            getBookImage: id => options.media[id as number],
            nextRId: () => nextRid(drawing!.rels),
            extent: {
              right: model.dimensions?.model?.right,
              bottom: model.dimensions?.model?.bottom
            }
          },
          drawing.rels
        )
      );
    }

    // Handle user-drawn shapes — anchored drawing parts with no media/rel.
    const shapes = model.shapes ?? [];
    if (shapes.length > 0) {
      let { drawing } = model;
      if (!drawing) {
        drawing = model.drawing = {
          rId: nextRid(rels),
          name: `drawing${++options.drawingsCount}`,
          anchors: [],
          rels: []
        };
        options.drawings.push(drawing);
        rels.push({
          Id: drawing.rId,
          Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
          Target: drawingRelTargetFromWorksheet(drawing.name)
        });
      }

      // Through `buildShapeAnchors`, which the XLSB writer also calls. Sixty inline lines here was the
      // reason that writer had no shapes: the anchoring arithmetic had one home and it was this file.
      drawing.anchors.push(...buildShapeAnchors(shapes, drawing.anchors.length));
    }

    if (headerImageMedia.length > 0) {
      const preparedImages = headerImageMedia.flatMap((medium, index) => {
        const bookImage = options.media[medium.imageId];
        return bookImage
          ? [
              {
                imageId: medium.imageId,
                bookImage,
                imageRelId: `rId${index + 1}`,
                position: medium.position ?? "CH",
                headerWidth: medium.headerWidth,
                headerHeight: medium.headerHeight
              }
            ]
          : [];
      });
      if (preparedImages.length > 0) {
        const rIdVml = nextRid(rels);
        rels.push({
          Id: rIdVml,
          Type: RelType.VmlDrawing,
          Target: vmlDrawingHFRelTargetFromWorksheet(fileIndex)
        });
        // Store header image info on the model for the VML writer and worksheet render
        model.headerImages = preparedImages;
        model.headerImage = {
          vmlRelId: rIdVml,
          ...preparedImages[0]
        };

        // Flag for content-types registration
        options.hasHeaderWatermark = true;

        // The `&G` placeholder is owned by the worksheet API
        // (`addWatermark`) and by the parsed source file, so the writer never
        // synthesises header/footer fields here. Emitting them in two places
        // let the two rules drift apart (e.g. a footer-positioned image that
        // the writer still announced in the centre header).
        if (!model.headerFooter) {
          model.headerFooter = {};
        }
      }
    }

    // prepare tables
    model.tables.forEach(table => {
      // relationships
      const rId = nextRid(rels);
      table.rId = rId;
      rels.push({
        Id: rId,
        Type: RelType.Table,
        Target: tableRelTargetFromWorksheet(table.target)
      });

      // dynamic styles
      table.columns.forEach(column => {
        const { style } = column;
        if (style) {
          column.dxfId = options.styles.addDxfStyle(style);
        }
      });
    });

    // prepare pivot tables
    (model.pivotTables ?? []).forEach((pivotTable: { tableNumber: number }) => {
      rels.push({
        Id: nextRid(rels),
        Type: RelType.PivotTable,
        Target: pivotTableRelTargetFromWorksheet(pivotTable.tableNumber)
      });
    });

    // prepare form controls (legacy checkboxes)
    // Form controls share the VML file with comments, but need separate ctrlProp relationships
    if (model.formControls && model.formControls.length > 0) {
      // Ensure a DrawingML drawing part exists for form controls.
      // Excel often repairs sheets that have legacy controls but no <drawing> part.
      let { drawing } = model;
      if (!drawing) {
        drawing = model.drawing = {
          rId: nextRid(rels),
          name: `drawing${++options.drawingsCount}`,
          anchors: [],
          rels: []
        };
        options.drawings.push(drawing);
        rels.push({
          Id: drawing.rId,
          Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
          Target: drawingRelTargetFromWorksheet(drawing.name)
        });
      }

      // If no comments, we need to add the VML drawing relationship for form controls
      if (model.comments.length === 0) {
        rels.push({
          Id: nextRid(rels),
          Type: RelType.VmlDrawing,
          Target: vmlDrawingRelTargetFromWorksheet(fileIndex)
        });
      }

      // Add ctrlProp relationships for each form control, then the hidden DrawingML anchors that
      // bridge to their VML shapes. The anchors come from `buildFormControlAnchors`, which the XLSB
      // writer also calls — the `spid` link between an anchor and its VML shape is exactly the kind of
      // detail two implementations get differently.
      for (const control of model.formControls) {
        const globalCtrlPropId = options.formControlRefs.length + 1;
        control.ctrlPropId = globalCtrlPropId;
        const relId = nextRid(rels);
        control.ctrlPropRelId = relId;
        rels.push({
          Id: relId,
          Type: RelType.CtrlProp,
          Target: ctrlPropRelTargetFromWorksheet(globalCtrlPropId)
        });
        options.formControlRefs.push(globalCtrlPropId);
      }
      drawing.anchors.push(...buildFormControlAnchors(model.formControls, drawing.anchors.length));
    }

    // prepare ext items
    this.map.extLst.prepare(model, options);
  }

  render(xmlStream, model) {
    xmlStream.openXml(StdDocAttributes);
    const worksheetAttrs: Record<string, string> = {
      ...WorkSheetXform.WORKSHEET_ATTRIBUTES,
      ...model.worksheetNamespaceAttributes
    };
    if (model.worksheetMcIgnorable) {
      worksheetAttrs["mc:Ignorable"] = [
        ...new Set(
          `${worksheetAttrs["mc:Ignorable"]} ${model.worksheetMcIgnorable}`.trim().split(/\s+/)
        )
      ].join(" ");
    }
    if (model.formControls && model.formControls.length > 0) {
      worksheetAttrs["xmlns:x14"] = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main";
      worksheetAttrs["xmlns:xdr"] =
        "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
      worksheetAttrs["mc:Ignorable"] = [
        ...new Set(`${worksheetAttrs["mc:Ignorable"]} x14`.trim().split(/\s+/))
      ].join(" ");
    }
    xmlStream.openNode("worksheet", worksheetAttrs);

    const sheetFormatPropertiesModel = model.properties
      ? {
          defaultRowHeight: model.properties.defaultRowHeight,
          dyDescent: model.properties.dyDescent,
          outlineLevelCol: model.properties.outlineLevelCol,
          outlineLevelRow: model.properties.outlineLevelRow,
          customHeight: model.properties.customHeight,
          ...(model.properties.defaultColWidth
            ? { defaultColWidth: model.properties.defaultColWidth }
            : {})
        }
      : undefined;
    const sheetPropertiesModel = {
      outlineProperties: model.properties && model.properties.outlineProperties,
      tabColor: model.properties && model.properties.tabColor,
      pageSetup:
        model.pageSetup && model.pageSetup.fitToPage
          ? {
              fitToPage: model.pageSetup.fitToPage
            }
          : undefined
    };
    const pageMarginsModel = model.pageSetup && model.pageSetup.margins;
    const printOptionsModel = {
      showRowColHeaders: model.pageSetup && model.pageSetup.showRowColHeaders,
      showGridLines: model.pageSetup && model.pageSetup.showGridLines,
      horizontalCentered: model.pageSetup && model.pageSetup.horizontalCentered,
      verticalCentered: model.pageSetup && model.pageSetup.verticalCentered
    };
    const sheetProtectionModel = model.sheetProtection;

    this.map.sheetPr.render(xmlStream, sheetPropertiesModel);
    this.map.dimension.render(xmlStream, model.dimensions);
    this.map.sheetViews.render(xmlStream, model.views);
    this.map.sheetFormatPr.render(xmlStream, sheetFormatPropertiesModel);
    this.map.cols.render(xmlStream, model.cols);
    this.map.sheetData.render(xmlStream, model.rows);
    this.map.sheetProtection.render(xmlStream, sheetProtectionModel); // Note: must be after sheetData and before autoFilter
    (this.map.autoFilter as AutoFilterXform).render(
      xmlStream,
      model.autoFilter,
      model.autoFilterCriteria
    );
    if (
      model.sortStateXml &&
      (model.sortStateAutoFilterRef === undefined ||
        (model.autoFilter &&
          model.sortStateAutoFilterRef === resolveAutoFilterRef(model.autoFilter)))
    ) {
      xmlStream.writeRaw(model.sortStateXml);
    }
    this.map.mergeCells.render(xmlStream, model.mergeCells);
    this.map.conditionalFormatting.render(xmlStream, model.conditionalFormattings); // Note: must be before dataValidations
    this.dataValidations.render(xmlStream, model.dataValidations, model.date1904 === true);

    // For some reason hyperlinks have to be after the data validations
    this.map.hyperlinks.render(xmlStream, model.hyperlinks);

    this.map.printOptions.render(xmlStream, printOptionsModel); // Note: must be before pageMargins
    this.map.pageMargins.render(xmlStream, pageMarginsModel);
    this.map.pageSetup.render(xmlStream, model.pageSetup);
    this.map.headerFooter.render(xmlStream, model.headerFooter);
    this.map.rowBreaks.render(xmlStream, model.rowBreaks);
    this.map.colBreaks.render(xmlStream, model.colBreaks);
    // `ignoredErrors` must precede `drawing` per ECMA-376 §18.3.1.99
    // CT_Worksheet (… colBreaks, customProperties, cellWatches,
    // ignoredErrors, smartTags, drawing, legacyDrawing, …). Emitting
    // it after `controls` produced out-of-order XML that strict
    // validators reject and some Excel builds repair on open
    // (dropping the ignoredErrors block entirely). Previously the
    // comment on this call claimed the opposite order — it was
    // factually wrong.
    this.map.ignoredErrors.render(xmlStream, model.ignoredErrors);
    this.map.drawing.render(xmlStream, model.drawing); // Note: must be after rowBreaks/colBreaks

    // ECMA-376 §18.3.1.99 CT_Worksheet child sequence is:
    //   … drawing → legacyDrawing → legacyDrawingHF → drawingHF → picture → oleObjects → controls →
    //   webPublishItems → tableParts → extLst
    // `legacyDrawing` and `legacyDrawingHF` therefore MUST be emitted
    // before the background `<picture>` element. The previous order here
    // had picture before legacyDrawing, which validates against strict
    // OOXML checkers as out-of-order and was the root cause of several
    // "Excel needs to repair" reports.
    if (model.rels) {
      // Add a <legacyDrawing /> node for each VML drawing relationship (comments and/or form controls).
      model.rels.forEach(rel => {
        if (rel.Type === RelType.VmlDrawing) {
          // Skip VML rels that are for header images (they use legacyDrawingHF instead)
          if (model.headerImage && rel.Id === model.headerImage.vmlRelId) {
            return;
          }
          xmlStream.leafNode("legacyDrawing", { "r:id": rel.Id });
        }
      });
    }

    // legacyDrawingHF — VML drawing for header/footer images (watermark in header mode)
    if (model.headerImage) {
      xmlStream.leafNode("legacyDrawingHF", { "r:id": model.headerImage.vmlRelId });
    }

    // Background image: must be emitted AFTER drawing/legacyDrawing per
    // the CT_Worksheet sequence noted above.
    this.map.picture.render(xmlStream, model.background);

    // Controls section for legacy form controls (checkboxes, etc.)
    // Excel expects <controls> entries that reference ctrlProp relationships.
    if (model.formControls && model.formControls.length > 0) {
      xmlStream.openNode("mc:AlternateContent");
      xmlStream.openNode("mc:Choice", { Requires: "x14" });
      xmlStream.openNode("controls");

      for (const control of model.formControls) {
        if (!control.ctrlPropRelId) {
          continue;
        }

        const defaultName = `Check Box ${Math.max(1, control.shapeId - 1024)}`;
        xmlStream.openNode("mc:AlternateContent");
        xmlStream.openNode("mc:Choice", { Requires: "x14" });
        xmlStream.openNode("control", {
          shapeId: control.shapeId,
          "r:id": control.ctrlPropRelId,
          name: control.name || defaultName
        });
        xmlStream.openNode("controlPr", {
          locked: 0,
          defaultSize: 0,
          print: control.print ? 1 : 0,
          autoFill: 0,
          autoLine: 0,
          autoPict: 0
        });
        xmlStream.openNode("anchor");
        xmlStream.openNode("from");
        xmlStream.leafNode("xdr:col", undefined, control.tl.col);
        xmlStream.leafNode("xdr:colOff", undefined, control.tl.colOff);
        xmlStream.leafNode("xdr:row", undefined, control.tl.row);
        xmlStream.leafNode("xdr:rowOff", undefined, control.tl.rowOff);
        xmlStream.closeNode();
        xmlStream.openNode("to");
        xmlStream.leafNode("xdr:col", undefined, control.br.col);
        xmlStream.leafNode("xdr:colOff", undefined, control.br.colOff);
        xmlStream.leafNode("xdr:row", undefined, control.br.row);
        xmlStream.leafNode("xdr:rowOff", undefined, control.br.rowOff);
        xmlStream.closeNode(); // to
        xmlStream.closeNode(); // anchor
        xmlStream.closeNode(); // controlPr
        xmlStream.closeNode(); // control
        xmlStream.closeNode(); // mc:Choice
        xmlStream.leafNode("mc:Fallback");
        xmlStream.closeNode(); // mc:AlternateContent
      }

      xmlStream.closeNode();
      xmlStream.closeNode();
      xmlStream.leafNode("mc:Fallback");
      xmlStream.closeNode();
    }

    // `ignoredErrors` is rendered earlier (before `drawing`) per
    // ECMA-376 §18.3.1.99 schema order — see the block above
    // `this.map.drawing.render(...)`. Only `tableParts` and `extLst`
    // remain in this tail section.
    this.map.tableParts.render(xmlStream, model.tables);

    // extLst should be the last element in the worksheet.
    this.map.extLst.render(xmlStream, model);

    xmlStream.closeNode();
  }

  parseOpen(node) {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }

    if (node.name === "worksheet") {
      Object.values(this.map).forEach((xform: BaseXform) => {
        xform.reset();
      });
      this.namespaceAttributes = Object.fromEntries(
        Object.entries(node.attributes).filter(
          ([key]) => key.startsWith("xmlns:") && !(key in WorkSheetXform.WORKSHEET_ATTRIBUTES)
        )
      ) as Record<string, string>;
      const extraIgnorable = (node.attributes["mc:Ignorable"] ?? "")
        .split(/\s+/)
        .filter(token => token && token !== "x14ac");
      this.mcIgnorable = extraIgnorable.length > 0 ? extraIgnorable.join(" ") : undefined;
      return true;
    }

    if (this.map[node.name] && !this.ignoreNodes.includes(node.name)) {
      this.parser = this.map[node.name];
      this.parser.parseOpen(node);
    }
    return true;
  }

  parseText(text) {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name) {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case "worksheet": {
        const properties = this.map.sheetFormatPr.model || {};
        if (this.map.sheetPr.model && this.map.sheetPr.model.tabColor) {
          properties.tabColor = this.map.sheetPr.model.tabColor;
        }
        if (this.map.sheetPr.model && this.map.sheetPr.model.outlineProperties) {
          properties.outlineProperties = this.map.sheetPr.model.outlineProperties;
        }
        const sheetProperties = {
          fitToPage:
            (this.map.sheetPr.model &&
              this.map.sheetPr.model.pageSetup &&
              this.map.sheetPr.model.pageSetup.fitToPage) ||
            false,
          margins: this.map.pageMargins.model
        };
        const pageSetup = Object.assign(
          sheetProperties,
          this.map.pageSetup.model,
          this.map.printOptions.model
        );
        const conditionalFormattings = mergeConditionalFormattings(
          this.map.conditionalFormatting.model,
          this.map.extLst.model && this.map.extLst.model["x14:conditionalFormattings"]
        );
        this.model = {
          dimensions: this.map.dimension.model,
          cols: this.map.cols.model,
          rows: this.map.sheetData.model,
          // The rectangles this sheet's styled blanks collapsed into, closed here because a rectangle is only final once
          // no further row can extend it. Absent unless the read asked for the collapse.
          ...(this.styledBlanks === undefined
            ? {}
            : { styledBlankRanges: this.styledBlanks.ranges() }),
          mergeCells: this.map.mergeCells.model,
          hyperlinks: this.map.hyperlinks.model,
          dataValidations: this.map.dataValidations.model,
          properties,
          views: this.map.sheetViews.model,
          pageSetup,
          headerFooter: this.map.headerFooter.model,
          background: this.map.picture.model,
          drawing: this.map.drawing.model,
          legacyDrawingHF: this.map.legacyDrawingHF.model,
          tables: this.map.tableParts.model,
          // The sparkline extension, reached the same way `x14:conditionalFormattings` is. Without this the
          // block was parsed and then thrown away at the last step, which is the same defect one level up from
          // the one in `ext-lst-xform.ts`.
          ...(this.map.extLst.model?.sparklineGroups === undefined
            ? {}
            : { sparklineGroups: this.map.extLst.model.sparklineGroups }),
          conditionalFormattings,
          rowBreaks: this.map.rowBreaks.model ?? [],
          colBreaks: this.map.colBreaks.model ?? [],
          ignoredErrors: this.map.ignoredErrors.model ?? []
        };

        if (this.map.autoFilter.model) {
          this.model.autoFilter = this.map.autoFilter.model;
          // Filter criteria are not part of the public `autoFilter` range
          // model; carry them separately so a save can replay them.
          const { criteria } = this.map.autoFilter as AutoFilterXform;
          if (criteria) {
            this.model.autoFilterCriteria = criteria;
          }
        }
        if (this.namespaceAttributes && Object.keys(this.namespaceAttributes).length > 0) {
          this.model.worksheetNamespaceAttributes = this.namespaceAttributes;
        }
        if (this.mcIgnorable) {
          this.model.worksheetMcIgnorable = this.mcIgnorable;
        }
        if (this.map.sortState.model) {
          // The sort the user last applied. Not modelled, so preserved as XML.
          this.model.sortStateXml = this.map.sortState.model;
          if (this.map.autoFilter.model) {
            this.model.sortStateAutoFilterRef = resolveAutoFilterRef(this.map.autoFilter.model);
          }
        }
        if (this.map.sheetProtection.model) {
          this.model.sheetProtection = this.map.sheetProtection.model;
        }

        return false;
      }

      default:
        // not quite sure how we get here!
        return true;
    }
  }

  reconcile(model, options) {
    // options.merges = new Merges();
    // options.merges.reconcile(model.mergeCells, model.rows);
    // Build rel index first, then process comments and VML in two passes so
    // that the result is independent of the order rels appear in the file.
    const relList = model.relationships ?? [];
    const rels = relList.reduce((h, rel) => {
      h[rel.Id] = rel;
      return h;
    }, {});

    // Pass 1: resolve comments
    for (const rel of relList) {
      if (rel.Type === RelType.Comments) {
        const resolvedPath = resolveRelTarget("xl/worksheets/", rel.Target);
        const commentEntry = options.comments?.[resolvedPath];
        if (commentEntry) {
          model.comments = commentEntry.comments;
        }
      }
    }

    // Pass 2: merge VML note metadata (requires model.comments from pass 1)
    if (model.comments && model.comments.length) {
      for (const rel of relList) {
        if (rel.Type === RelType.VmlDrawing) {
          const resolvedVmlPath = resolveRelTarget("xl/worksheets/", rel.Target);
          const vmlEntry = options.vmlDrawings?.[resolvedVmlPath];
          if (vmlEntry) {
            // Build a ref-keyed map from VML comments for order-independent merge.
            // Fall back to index-based merge if VML entries lack row/col.
            const vmlComments = vmlEntry.comments;
            // Value type is the VML comment element from `options.vmlDrawings`;
            // `any` because `options` is the untyped prepare()/render() bag.
            const vmlByRef: Record<string, any> = {};
            let hasRefInfo = false;
            for (const vc of vmlComments) {
              if (vc.row != null && vc.col != null) {
                const ref = colCache.encodeAddress(vc.row, vc.col);
                vmlByRef[ref] = vc;
                hasRefInfo = true;
              }
            }

            if (hasRefInfo) {
              // Merge by cell reference (robust against order differences)
              for (const comment of model.comments) {
                const vml = vmlByRef[comment.ref];
                if (vml) {
                  comment.note = Object.assign({}, comment.note, vml);
                }
              }
            } else {
              // Fallback: index-based merge for VML files without row/col
              model.comments.forEach((comment, index) => {
                if (index < vmlComments.length) {
                  comment.note = Object.assign({}, comment.note, vmlComments[index]);
                }
              });
            }
          }
        }
      }
    }
    options.commentsMap = (model.comments ?? []).reduce((h, comment) => {
      if (comment.ref) {
        h[comment.ref] = comment;
      }
      return h;
    }, {});
    options.hyperlinkMap = (model.hyperlinks ?? []).reduce((h, hyperlink) => {
      if (hyperlink.rId) {
        // External link: resolve target from relationship
        const rel = rels[hyperlink.rId];
        if (rel) {
          h[hyperlink.address] = rel.Target;
        }
      } else if (hyperlink.target) {
        // Internal link: target was restored from location attribute (with "#" prefix)
        h[hyperlink.address] = hyperlink.target;
      }
      return h;
    }, {});
    options.formulae = {};

    // compact the rows and cells — remove any holes from sparse parse results
    if (model.rows) {
      if (model.rows.includes(undefined)) {
        model.rows = model.rows.filter(Boolean);
      }
      for (let i = 0; i < model.rows.length; i++) {
        const row = model.rows[i];
        if (row.cells?.includes(undefined)) {
          row.cells = row.cells.filter(Boolean);
        }
      }
    } else {
      model.rows = [];
    }

    // **A style index is only meaningful against the table it came from.**
    //
    // The rectangles were collected during parse, where only the `s` attribute is available — and the style table is
    // rebuilt on write, so index 1 in the source can mean something else in the output. Worse, a style no cell in the
    // model references is never registered at all: the rebuilt `styles.xml` came out with `<fills count="2">` where the
    // source had 3, and the blank cells pointed at whatever landed at that index.
    //
    // Resolved here because `options.styles` exists here, into the same shape the XLSB reader stores. That path never
    // had this problem precisely because it resolved to a style *object* at read time; making the two agree is the whole
    // reason the representation is shared.
    const ranges = (model as { styledBlankRanges?: readonly StyledBlankRangeModel[] })
      .styledBlankRanges;
    if (ranges !== undefined) {
      const styles = options.styles as { getStyleModel(id: number): unknown } | undefined;
      (model as { styledBlankRanges?: readonly StyledBlankRangeModel[] }).styledBlankRanges =
        ranges.map(range => ({ ...range, style: styles?.getStyleModel(range.styleIndex) }));
    }

    this.map.cols.reconcile(model.cols, options);
    this.map.sheetData.reconcile(model.rows, options);

    // **A comment on an empty cell needs a cell to live on.**
    //
    // Comments are attached during cell reconcile, so a comment whose `ref` has no `<c>` element in the sheet was
    // dropped — and a `<c>` is not required for one: `comments1.xml` keys them by address and Excel shows a comment
    // on an empty cell perfectly well. Three of `poi-comments.xlsb`'s four notes were lost this way when it was
    // converted to XLSX, and the one that survived was the only one whose cell also held a value.
    //
    // Found by the cross-container check in `verify-xlsb-corpus`, which is worth saying because an XLSX round trip
    // never showed it: a workbook this library *wrote* put values in those cells, so the comment always had one.
    for (const [address, comment] of Object.entries(
      (options.commentsMap ?? {}) as Record<string, unknown>
    )) {
      if (hasCellAt(model.rows, address)) {
        continue;
      }
      const rowNumber = Number(/\d+$/.exec(address)?.[0] ?? "0");
      if (rowNumber === 0) {
        continue;
      }
      let row = model.rows.find(
        (candidate: { number: number } | undefined) => candidate?.number === rowNumber
      );
      if (row === undefined) {
        row = { number: rowNumber, cells: [] };
        model.rows.push(row);
        model.rows.sort(
          (left: { number: number }, right: { number: number }) => left.number - right.number
        );
      }
      // `ValueType.Null` — a real cell holding nothing, which is what a comment-only cell is. Omitting the type
      // reaches `rowSetModel` as a cell of unknown kind and throws.
      row.cells = [...(row.cells ?? []), { address, type: 0, comment }];
    }
    this.map.conditionalFormatting.reconcile(model.conditionalFormattings, options);
    // A `type: "date"` bound is a serial, so it needs the workbook's epoch just as a cell value does. Reconcile
    // rather than parse, because the epoch is not known while the sheet is being tokenised.
    this.map.dataValidations.reconcile(model.dataValidations, options);

    model.media = [];
    if (model.drawing) {
      const drawingRel = rels[model.drawing.rId];
      if (drawingRel) {
        const match = drawingRel.Target.match(/\/drawings\/([a-zA-Z0-9]+)[.][a-zA-Z]{3,4}$/);
        if (match) {
          const drawingName = match[1];
          const drawing = options.drawings[drawingName];
          if (drawing) {
            // Preserve the drawing object for round-trip (charts, etc.)
            // This includes the name, anchors, and rels
            model.drawing = {
              ...drawing,
              name: drawingName,
              rels: options.drawingRels?.[drawingName] ?? drawing.rels ?? []
            };

            // Also extract images to model.media for backward compatibility.
            drawing.anchors.forEach(anchor => {
              if (anchor.medium) {
                // Detect overlay watermarks: drawings that carry alphaModFix
                const hasAlpha =
                  anchor.medium.alphaModFix !== undefined && anchor.medium.alphaModFix < 100000;
                if (hasAlpha) {
                  model.media.push({
                    type: "watermark",
                    imageId: anchor.medium.index,
                    opacity: anchor.medium.alphaModFix / 100000
                  });
                } else {
                  model.media.push({
                    type: "image",
                    imageId: anchor.medium.index,
                    range: anchor.range,
                    hyperlinks: anchor.picture.hyperlinks,
                    // Carry the picture's absolute geometry through so a plain
                    // re-save (which discards the parsed anchor and rebuilds it
                    // from this media entry — see the drawing-reset block in
                    // prepare()) doesn't zero out an `editAs="oneCell"`
                    // picture's position/size, rendering it invisible.
                    xfrmOffX: anchor.picture.xfrmOffX,
                    xfrmOffY: anchor.picture.xfrmOffY,
                    xfrmExtCx: anchor.picture.xfrmExtCx,
                    xfrmExtCy: anchor.picture.xfrmExtCy,
                    rawSpPr: anchor.picture.rawSpPr
                  });
                }
              }
            });
          } else {
            // Drawing data not found - clear the stale reference
            model.drawing = undefined;
          }
        } else {
          // Target path doesn't match expected drawing pattern
          model.drawing = undefined;
        }
      } else {
        // Relationship missing (corrupted/malicious file) - clear stale reference
        model.drawing = undefined;
      }
    }

    const backgroundRel = model.background && rels[model.background.rId];
    if (backgroundRel) {
      const target = backgroundRel.Target.split("/media/")[1];
      const imageId = options.mediaIndex && options.mediaIndex[target];
      if (imageId !== undefined) {
        model.media.push({
          type: "background",
          imageId
        });
      }
    } else if (model.background) {
      // Relationship missing - clear stale reference
      model.background = undefined;
    }

    const headerVmlRel = model.legacyDrawingHF && rels[model.legacyDrawingHF.rId];
    if (headerVmlRel) {
      const match = /\/(vmlDrawingHF\d+)[.]vml$/.exec(headerVmlRel.Target);
      const name = match?.[1];
      const images = name && options.vmlDrawingHF?.[name];
      const imageRels = name && options.vmlDrawingHFRels?.[name];
      if (images && imageRels) {
        const relMap = Object.fromEntries(imageRels.map(rel => [rel.Id, rel]));
        for (const image of images) {
          const target = relMap[image.imageRelId]?.Target?.split("/media/")[1];
          const imageId = target && options.mediaIndex?.[target];
          if (imageId !== undefined && /^(?:LH|CH|RH|LF|CF|RF)$/.test(image.position ?? "")) {
            model.media.push({
              type: "headerImage",
              imageId,
              headerWidth: image.width,
              headerHeight: image.height,
              position: image.position
            });
          }
        }
      }
    }

    model.tables = (model.tables ?? []).reduce((acc, tablePart) => {
      const rel = rels[tablePart.rId];
      if (rel) {
        const resolvedPath = resolveRelTarget("xl/worksheets/", rel.Target);
        const table = options.tables[resolvedPath];
        if (table) {
          acc.push(table);
        }
      }
      return acc;
    }, []);

    // Link pivot tables from relationships to worksheet
    // This is needed so that when writing, the worksheet knows which pivot tables it contains
    model.pivotTables = [];
    (model.relationships ?? []).forEach(rel => {
      if (rel.Type === RelType.PivotTable && options.pivotTables) {
        const resolvedPath = resolveRelTarget("xl/worksheets/", rel.Target);
        const pivotTable = options.pivotTables[resolvedPath];
        if (pivotTable) {
          model.pivotTables.push(pivotTable);
        }
      }
    });

    delete model.relationships;
    delete model.hyperlinks;
    delete model.comments;
  }
}

export { WorkSheetXform };
