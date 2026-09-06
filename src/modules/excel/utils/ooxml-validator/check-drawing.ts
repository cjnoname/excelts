/**
 * Drawing part structure check.
 *
 * When a drawing file contains `<xdr:graphicFrame>` nodes but neither a
 * classic `<c:chart>` nor a chartEx `<cx:chart>` reference inside them,
 * the graphic frame is dangling — Excel shows a placeholder or drops the
 * frame on load.
 *
 * We also scan anchor coordinates: every anchor must have `from` and
 * `to` child elements, and EMU values (`x`, `y`, `cx`, `cy`,
 * `colOff`, `rowOff`) when present must parse as finite non-negative
 * numbers. Excel rejects anchors with NaN coordinates outright.
 *
 * Finally we enforce the ChartEx drawing-wrapper invariants that
 * trigger "Removed Part: /xl/drawings/drawingN.xml (Drawing shape)"
 * in production Excel logs:
 *
 *   - Any `<cx:chart>` reference MUST live inside an
 *     `<mc:AlternateContent>` block. The Microsoft ChartEx schema was
 *     never part of the base OOXML spec, so Excel's strict loader
 *     requires MC substitution so legacy readers see a fallback shape.
 *   - The `<mc:Fallback>` MUST be non-empty. An empty Fallback
 *     collapses the anchor to nothing on clients that take that
 *     branch, and Excel's strict loader has been observed to reject
 *     the drawing even on the Choice branch when it sees the
 *     degenerate Fallback.
 *   - `<mc:AlternateContent>` lives INSIDE the `<xdr:twoCellAnchor>`
 *     shape slot (between `<xdr:to>` and `<xdr:clientData>`), NOT
 *     around the whole anchor. Wrapping the entire anchor duplicates
 *     `<xdr:from>`/`<xdr:to>` across Choice and Fallback, which Excel
 *     rejects even though MC substitution permits it in theory.
 */

import type { ValidationContext } from "@excel/utils/ooxml-validator/context";
import {
  attrByLocalName,
  collectDescendantsLocal,
  findChildLocal,
  findChildrenLocal,
  hasDescendantLocal,
  matchesLocal
} from "@excel/utils/ooxml-validator/xml-utils";
import { textContent } from "@xml/dom";
import type { XmlElement } from "@xml/types";

const DRAWING_PATH_RE = /^xl\/drawings\/drawing\d+\.xml$/;

export function checkDrawing(ctx: ValidationContext): void {
  for (const [path, entry] of ctx.files()) {
    if (ctx.reporter.capped) {
      return;
    }
    if (entry.type === "directory" || !DRAWING_PATH_RE.test(path)) {
      continue;
    }
    checkSingleDrawing(ctx, path);
  }
}

function checkSingleDrawing(ctx: ValidationContext, path: string): void {
  const dom = ctx.readDom(path);
  if (!dom) {
    return;
  }
  const root = dom.root;

  // Graphic frame without embedded chart reference.
  for (const gf of collectDescendantsLocal(root, "graphicFrame")) {
    const hasChartFrame = hasDescendantLocal(gf, "chart");
    if (!hasChartFrame) {
      ctx.reporter.error(
        "drawing-graphicFrame-missing-chart",
        `${path}: xdr:graphicFrame has no c:chart or cx:chart reference`,
        path
      );
    }
  }

  // AlternateContent wrap at drawing-root level is the "outer wrap"
  // writer bug — but ONLY for chartEx (`Requires="cx1"` / `"cx"`).
  // Form-control legacy wrappers (`Requires="a14"`) legitimately
  // wrap the whole anchor and Excel handles them fine; those are
  // not the chartEx bug this rule targets. When the whole anchor
  // is wrapped for chartEx, `<xdr:from>` / `<xdr:to>` get
  // duplicated inside Choice and Fallback and Excel rejects the
  // drawing.
  for (const child of root.children) {
    if (child.type === "element" && matchesLocal(child.name, "AlternateContent")) {
      // Only flag if the AlternateContent contains anchor elements —
      // otherwise it might be a root-level extension that's fine.
      if (
        hasDescendantLocal(child, "twoCellAnchor") ||
        hasDescendantLocal(child, "oneCellAnchor") ||
        hasDescendantLocal(child, "absoluteAnchor")
      ) {
        // Look for a Choice with Requires="cx1" / "cx" — those mean
        // chartEx, which is the bug this rule flags. If the Choice
        // uses any other prefix ("a14" for form controls, etc.) the
        // outer wrap is the Microsoft-sanctioned shape and we skip.
        const choiceRequires = findChoiceRequires(child);
        if (choiceRequires === "cx" || choiceRequires === "cx1") {
          ctx.reporter.error(
            "drawing-chartEx-alternateContent-outer-wrap",
            `${path}: <mc:AlternateContent> wraps the entire anchor. ` +
              `Move it INSIDE <xdr:twoCellAnchor>, after <xdr:to> and before ` +
              `<xdr:clientData>, so <xdr:from>/<xdr:to> are not duplicated.`,
            path
          );
        }
      }
    }
  }

  // Anchors.
  for (const anchorName of ["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"] as const) {
    for (const anchor of findChildrenLocal(root, anchorName)) {
      checkAnchor(ctx, path, anchor);
      checkChartExWrapping(ctx, path, anchor);
    }
  }
}

// -----------------------------------------------------------------------------
// ChartEx AlternateContent wrapping
// -----------------------------------------------------------------------------

/**
 * For every anchor: if it hosts a `<cx:chart>` reference, that
 * reference MUST be wrapped in `<mc:AlternateContent>` (inside the
 * anchor) with a non-empty `<mc:Fallback>`. This mirrors what Excel
 * itself writes for every ChartEx drawing.
 */
function checkChartExWrapping(ctx: ValidationContext, path: string, anchor: XmlElement): void {
  // Collect every `<cx:chart>` descendant of the anchor.
  const chartExRefs = collectDescendantsLocal(anchor, "chart").filter(el => {
    // Distinguish `<cx:chart>` (ChartEx) from `<c:chart>` (classic) by
    // namespace prefix. Both have local name "chart".
    const idx = el.name.indexOf(":");
    return idx !== -1 && el.name.slice(0, idx) === "cx";
  });
  if (chartExRefs.length === 0) {
    return;
  }

  // Is there an `<mc:AlternateContent>` direct child?
  const alternateContent = anchor.children.find(
    (c): c is XmlElement => c.type === "element" && matchesLocal(c.name, "AlternateContent")
  );

  if (!alternateContent) {
    ctx.reporter.error(
      "drawing-chartEx-missing-alternateContent-wrap",
      `${path}: anchor contains <cx:chart> but has no <mc:AlternateContent> wrapper. ` +
        `ChartEx drawings must place the <xdr:graphicFrame> inside ` +
        `<mc:AlternateContent><mc:Choice>…</mc:Choice><mc:Fallback>…</mc:Fallback></mc:AlternateContent>.`,
      path
    );
    return;
  }

  // Fallback must be non-empty.
  const fallback = findChildLocal(alternateContent, "Fallback");
  if (!fallback) {
    ctx.reporter.error(
      "drawing-chartEx-alternateContent-empty-fallback",
      `${path}: <mc:AlternateContent> has no <mc:Fallback>. ` +
        `Excel's strict loader rejects drawings whose Fallback is missing.`,
      path
    );
    return;
  }
  const fallbackHasChildren = fallback.children.some(c => c.type === "element");
  if (!fallbackHasChildren) {
    ctx.reporter.error(
      "drawing-chartEx-alternateContent-empty-fallback",
      `${path}: <mc:Fallback> is empty. ` +
        `Provide a non-empty legacy shape (e.g. <xdr:sp>) so non-ChartEx ` +
        `readers see a placeholder instead of collapsing the anchor.`,
      path
    );
    return;
  }

  // Office creation-id extension. Warning-level: not strictly required
  // by the base OOXML schema, but strict Excel builds have been seen
  // dropping chartEx drawings that lack the extension.
  // Structure: xdr:graphicFrame/xdr:nvGraphicFramePr/xdr:cNvPr/a:extLst/a:ext/a16:creationId
  // We locate the graphicFrame inside Choice and walk down.
  const choice = findChildLocal(alternateContent, "Choice");
  if (!choice) {
    return;
  }
  const graphicFrame = findChildLocal(choice, "graphicFrame");
  if (!graphicFrame) {
    return;
  }
  const nvGraphicFramePr = findChildLocal(graphicFrame, "nvGraphicFramePr");
  if (!nvGraphicFramePr) {
    return;
  }
  const cNvPr = findChildLocal(nvGraphicFramePr, "cNvPr");
  if (!cNvPr) {
    return;
  }
  const extLst = findChildLocal(cNvPr, "extLst");
  const hasCreationId = !!extLst && collectDescendantsLocal(extLst, "creationId").length > 0;
  if (!hasCreationId) {
    ctx.reporter.warning(
      "drawing-chartEx-missing-creationId",
      `${path}: chartEx drawing <xdr:cNvPr> missing Office creation-id extension ` +
        `(<a:extLst>/<a:ext>/<a16:creationId>). Strict Excel builds may drop the drawing ` +
        `on load without it.`,
      path
    );
  }
}

function checkAnchor(ctx: ValidationContext, path: string, anchor: XmlElement): void {
  const name = anchor.name.includes(":")
    ? anchor.name.slice(anchor.name.lastIndexOf(":") + 1)
    : anchor.name;

  // **Attributes, before the children.** Only `CT_TwoCellAnchor` declares one — `editAs`, the choice between
  // resizing with the cells and holding a fixed size, which is a choice only a two-cell anchor can make.
  // `CT_OneCellAnchor` and `CT_AbsoluteAnchor` declare none.
  //
  // This checker looked exclusively at child elements, so it passed a drawing carrying
  // `<xdr:oneCellAnchor editAs="oneCell">` — schema-invalid, and enough for Excel to answer
  // `Repaired Records: Drawing … (Drawing shape)`. Reporting zero problems on a file Excel repairs is the
  // failure mode a validator exists to avoid, so the attribute set is now part of what it checks.
  if (name !== "twoCellAnchor") {
    for (const attribute of Object.keys(anchor.attributes ?? {})) {
      ctx.reporter.error(
        "drawing-anchor-attribute",
        `${path}: <${anchor.name}> carries the attribute ${attribute}, and ` +
          `CT_${name[0]!.toUpperCase()}${name.slice(1)} declares none. ` +
          `editAs belongs to twoCellAnchor alone.`,
        path
      );
    }
  }

  // twoCellAnchor requires from+to; oneCellAnchor requires from+ext;
  // absoluteAnchor requires pos+ext.
  if (name === "twoCellAnchor") {
    if (!findChildLocal(anchor, "from") || !findChildLocal(anchor, "to")) {
      ctx.reporter.error("drawing-anchor-missing", `${path}: ${name} missing from/to`, path);
      return;
    }
    checkCellAnchor(ctx, path, findChildLocal(anchor, "from"));
    checkCellAnchor(ctx, path, findChildLocal(anchor, "to"));
  } else if (name === "oneCellAnchor") {
    if (!findChildLocal(anchor, "from") || !findChildLocal(anchor, "ext")) {
      ctx.reporter.error("drawing-anchor-missing", `${path}: ${name} missing from/ext`, path);
      return;
    }
    checkCellAnchor(ctx, path, findChildLocal(anchor, "from"));
    checkExtOrPos(ctx, path, findChildLocal(anchor, "ext"), "ext");
  } else if (name === "absoluteAnchor") {
    if (!findChildLocal(anchor, "pos") || !findChildLocal(anchor, "ext")) {
      ctx.reporter.error("drawing-anchor-missing", `${path}: ${name} missing pos/ext`, path);
      return;
    }
    checkExtOrPos(ctx, path, findChildLocal(anchor, "pos"), "pos");
    checkExtOrPos(ctx, path, findChildLocal(anchor, "ext"), "ext");
  }
}

function checkCellAnchor(
  ctx: ValidationContext,
  path: string,
  cellAnchor: XmlElement | undefined
): void {
  if (!cellAnchor) {
    return;
  }
  // Children are col / colOff / row / rowOff (as xdr:col etc.). Each is a
  // plain-text integer. A non-integer is typically the result of a writer
  // that stringified `undefined` / `null` — Excel silently repairs the
  // anchor (the "Removed Part: Drawing shape" message) but the file
  // still opens. So we downgrade this to a warning.
  for (const tag of ["col", "colOff", "row", "rowOff"] as const) {
    const el = findChildLocal(cellAnchor, tag);
    if (!el) {
      continue; // some producers elide zero offsets — tolerate.
    }
    const text = textContent(el).trim();
    const n = parseInt(text, 10);
    if (!Number.isFinite(n)) {
      ctx.reporter.warning(
        "drawing-anchor-invalid-coords",
        `${path}: anchor ${tag}=${JSON.stringify(text)} is not an integer`,
        path
      );
    }
    // Negatives are permitted for colOff/rowOff in some corner cases
    // (e.g. partial-cell anchors slight-past zero). Only warn on NaN.
  }
}

function checkExtOrPos(
  ctx: ValidationContext,
  path: string,
  el: XmlElement | undefined,
  kind: "ext" | "pos"
): void {
  if (!el) {
    return;
  }
  const attrs = kind === "ext" ? (["cx", "cy"] as const) : (["x", "y"] as const);
  for (const a of attrs) {
    const v = attrByLocalName(el, a);
    if (v === undefined) {
      continue;
    }
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) {
      ctx.reporter.warning(
        "drawing-anchor-invalid-coords",
        `${path}: ${kind} ${a}=${JSON.stringify(v)} is not a valid EMU integer`,
        path
      );
    }
  }
}

/**
 * Extract the `Requires` value from the first `<mc:Choice>` inside an
 * `<mc:AlternateContent>` block. Used by the outer-wrap rule to skip
 * form-control (`Requires="a14"`) anchors — only chartEx
 * (`Requires="cx1"` / `"cx"`) should trigger the diagnostic.
 *
 * Returns `undefined` when no Choice with a `Requires` attribute is
 * found.
 */
function findChoiceRequires(ac: XmlElement): string | undefined {
  for (const child of ac.children) {
    if (child.type === "element" && matchesLocal(child.name, "Choice")) {
      const req = attrByLocalName(child, "Requires");
      if (req !== undefined) {
        return req;
      }
    }
  }
  return undefined;
}
