/**
 * `pdf_edit` — structural and overlay edits to an existing PDF.
 *
 * The operations here are the ones that need no understanding of the content:
 * stamp a watermark, add page numbers, draw a Mermaid diagram, drop or keep
 * pages, rotate, append another PDF. That is exactly the set a model can drive
 * safely, because getting them wrong is visible rather than subtle.
 *
 * The diagram operation is the reason `createPdfDrawSurface` is published from
 * `documonster/pdf`: a `PdfEditorPage` already puts down the six marks a
 * `PdfDrawPage` names, so a display list draws onto an existing page as **vectors**
 * with no rasterising step. A diagram stamped this way stays sharp at any zoom,
 * which a PNG overlay would not.
 *
 * Overlays are drawn on a separate content stream layered over the original, so
 * existing page content is never redrawn.
 *
 * How the file is saved depends on what was asked for, and it matters:
 *
 * - **Overlay-only** edits (watermark, page numbers, stamp, diagram) are saved as
 *   an incremental update where the format allows it, which appends to the
 *   original bytes and therefore keeps bookmarks, form fields and any signature
 *   intact.
 * - **Structural** edits (delete/keep pages, rotate, append) require a full
 *   rebuild. That renumbers objects, invalidates signatures and may drop
 *   document-level structures the rebuilder does not carry over. The result says
 *   so rather than leaving the caller to discover it.
 *
 * Deliberately absent: extracting or reflowing text into a new PDF, which no
 * faithful implementation exists for.
 */

import { readFile } from "node:fs/promises";

import { renderDrawList } from "documonster/draw";
import { Pdf, createPdfDrawSurface } from "documonster/pdf";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { toolError } from "../errors.js";
import { assertWritable, resolveEditTarget, resolveInRoot } from "../sandbox.js";
import {
  buildDrawList,
  parseDiagram,
  resolveDiagramSource,
  summariseDiagram,
  toRenderOptions
} from "./diagram.js";
import { parsePages, supportsIncrementalUpdate } from "./document.js";
import {
  assertReadableSize,
  assertUnchanged,
  backupOnce,
  describeBackup,
  fingerprint,
  isSameFile,
  writeBytesWithPolicy,
  writeFileAtomic
} from "./fs-helpers.js";
import { formatBytes, textResult } from "./result.js";
import { defineTool } from "./types.js";

/** Operations that cannot be expressed as an appended incremental update. */
const STRUCTURAL_OPS = new Set(["delete_pages", "keep_pages", "rotate", "append"]);

/** Pages a single call may touch. */
const MAX_PAGES = 2_000;

/** Breathing room left around a diagram that was given no explicit box. */
const DIAGRAM_MARGIN = 36;

const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("watermark"),
    text: z.string().min(1).describe('Watermark text, e.g. "DRAFT" or "CONFIDENTIAL".'),
    pages: z
      .union([z.array(z.number().int().positive()), z.string()])
      .optional()
      .describe('Pages to stamp, as [1,2] or "1-3,7". Omit for every page.'),
    fontSize: z.number().positive().max(200).optional().describe("Defaults to 48."),
    color: z.string().optional().describe('Hex RGB without "#". Defaults to "FF0000".'),
    opacity: z.number().min(0.05).max(1).optional().describe("Defaults to 0.25."),
    rotation: z.number().optional().describe("Degrees. Defaults to 45.")
  }),
  z.object({
    op: z.literal("page_numbers"),
    format: z
      .string()
      .optional()
      .describe(
        'Template using {page} and {total}, e.g. "Page {page} of {total}". Defaults to that.'
      ),
    startAt: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Number to give the first page. Defaults to 1."),
    fontSize: z.number().positive().max(72).optional().describe("Defaults to 9."),
    position: z
      .enum(["bottom-right", "bottom-center", "bottom-left"])
      .optional()
      .describe("Defaults to bottom-center.")
  }),
  z.object({
    op: z.literal("stamp"),
    text: z.string().min(1).describe("Text to place at a fixed position."),
    x: z.number().describe("Points from the left edge."),
    y: z.number().describe("Points from the BOTTOM edge — PDF coordinates start bottom-left."),
    pages: z.union([z.array(z.number().int().positive()), z.string()]).optional(),
    fontSize: z.number().positive().max(200).optional().describe("Defaults to 12."),
    color: z.string().optional().describe('Hex RGB without "#". Defaults to "000000".')
  }),
  z.object({
    op: z.literal("diagram"),
    source: z.string().optional().describe("Mermaid diagram text. Use this or `from`, not both."),
    from: z
      .string()
      .optional()
      .describe("Read the diagram from a .mmd file, or a ```mermaid fence in a .md file."),
    index: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Which fence, when `from` is a Markdown file with several. Defaults to 1."),
    pages: z
      .union([z.array(z.number().int().positive()), z.string()])
      .optional()
      .describe("Pages to draw it on. Omit for every page."),
    x: z.number().optional().describe("Points from the left edge. Defaults to centred."),
    y: z
      .number()
      .optional()
      .describe(
        "Points from the BOTTOM edge — PDF coordinates start bottom-left. Defaults to centred."
      ),
    width: z
      .number()
      .positive()
      .optional()
      .describe(
        "Box width in points; the diagram is fitted into it uniformly. Omit to use its natural size, shrunk if needed to fit the page."
      ),
    height: z.number().positive().optional().describe("Box height in points."),
    theme: z
      .enum(["default", "dark", "neutral"])
      .optional()
      .describe("Colour set. Defaults to `default`."),
    background: z
      .string()
      .optional()
      .describe(
        'Defaults to "transparent" here, unlike diagram_render: this draws over existing page content, and a white panel would hide it. Pass a colour to get an opaque plate.'
      )
  }),
  z.object({
    op: z.literal("delete_pages"),
    pages: z
      .union([z.array(z.number().int().positive()), z.string()])
      .describe('Pages to remove, e.g. "2,5-7".')
  }),
  z.object({
    op: z.literal("keep_pages"),
    pages: z
      .union([z.array(z.number().int().positive()), z.string()])
      .describe("Pages to keep; all others are removed.")
  }),
  z.object({
    op: z.literal("rotate"),
    degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
    pages: z
      .union([z.array(z.number().int().positive()), z.string()])
      .optional()
      .describe(
        "Set these pages' absolute rotation to 90, 180 or 270 degrees; it is not relative to their current rotation."
      )
  }),
  z.object({
    op: z.literal("append"),
    path: z.string().min(1).describe("Another PDF to append, relative to the server root."),
    pages: z
      .union([z.array(z.number().int().positive()), z.string()])
      .optional()
      .describe("Pages of that PDF to append. Omit for all of them.")
  })
]);

export const pdfEditTool = defineTool({
  name: "pdf_edit",
  group: "pdf",
  title: "Edit an existing PDF",
  description:
    "Apply operations to a PDF: watermark, page numbers, a positioned stamp, a Mermaid diagram drawn as vectors, delete or keep pages, rotate, or append another PDF. Overlays are drawn over the original content, which is never rewritten. Use dryRun to see the effect described before writing. There is no text extraction into a new PDF and no PDF→Word.",
  inputSchema: {
    path: z.string().min(1).describe("PDF to edit, relative to the server root."),
    ops: z.array(opSchema).min(1).describe("Operations, applied in order."),
    out: z
      .string()
      .optional()
      .describe(
        "Write below @output/. Required for input files unless --allow-in-place is enabled."
      ),
    dryRun: z.boolean().optional().describe("Describe what would change without writing."),
    backup: z
      .boolean()
      .optional()
      .describe("When editing in place, copy the original to <name>.bak first. Defaults to true."),
    overwrite: z.boolean().optional().describe("Replace an existing `out` file. Defaults to false.")
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  },
  mutates: true,
  handler: async (args, context) => {
    const { config } = context;
    assertWritable(config);

    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    await assertReadableSize(config, resolved, args.path);
    const inputVersion = await fingerprint(resolved);
    const bytes = new Uint8Array(await readFile(resolved));

    const info = await Pdf.read(bytes, { extractText: false, extractImages: false }).catch(
      (cause: unknown) => {
        throw toolError.unsupported(
          `could not read ${args.path} as a PDF`,
          "A password-protected PDF cannot be edited here. Run doc_inspect to check the file type.",
          { cause }
        );
      }
    );

    const pageCount = info.metadata?.pageCount ?? 0;
    if (pageCount === 0) {
      throw toolError.unsupported(`${args.path} reports no pages`, "The file may be corrupt.");
    }
    if (pageCount > MAX_PAGES) {
      throw toolError.tooLarge(
        `${args.path} has ${pageCount} pages, over the ${MAX_PAGES} limit`,
        "Split it first with a keep_pages operation on a copy."
      );
    }

    // Editor.load is synchronous despite the async surroundings.
    let editor: ReturnType<typeof Pdf.Editor.load>;
    try {
      editor = Pdf.Editor.load(bytes);
    } catch (cause) {
      throw toolError.unsupported(`could not open ${args.path} for editing`, undefined, { cause });
    }

    // Page count changes as pages are removed, so it is tracked through the
    // operation list rather than read once.
    const pageMap = Array.from({ length: pageCount }, (_, index) => index);
    const applied: string[] = [];
    // Structural operations force a full rebuild; overlay-only edits do not.
    const structural = args.ops.some(op => STRUCTURAL_OPS.has(op.op));

    for (const [index, op] of args.ops.entries()) {
      try {
        const result = await applyOp(editor, op, pageMap, config);
        applied.push(result.description);
      } catch (cause) {
        if (cause instanceof Error && cause.name === "McpToolError") {
          throw cause;
        }
        throw toolError.invalidInput(
          `op ${index + 1} (${op.op}) failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          "Nothing was written.",
          { cause }
        );
      }
    }

    if (args.dryRun === true) {
      return textResult(
        config,
        [
          `**Dry run** — nothing was written to ${args.path}.`,
          `- pages: ${pageCount} → ${pageMap.length}`,
          "",
          "Would apply:",
          ...applied.map((line, index) => `${index + 1}. ${line}`),
          "",
          "Re-run without dryRun to write these changes."
        ].join("\n")
      );
    }

    // `out` may name the very file being edited (`a.pdf` vs `./a.pdf`), so the
    // decision is made on the resolved paths, not on whether `out` was given.
    await assertUnchanged(resolved, inputVersion);
    const writeTarget = await resolveEditTarget(config, args.path, args.out);
    const target = writeTarget.path;
    const inPlace = isSameFile(target, resolved);

    const backupPath = inPlace && (args.backup ?? true) ? await backupOnce(writeTarget) : undefined;

    // Overlay-only: prefer the incremental path so bookmarks, form fields and
    // signatures survive. `saveIncremental` itself falls back to a rebuild for
    // xref-stream files, so the report is based on what was actually possible.
    const incrementalPossible = !structural && supportsIncrementalUpdate(bytes);
    const out = incrementalPossible ? await editor.saveIncremental() : await editor.save();
    if (inPlace) {
      await writeFileAtomic(target, out);
    } else {
      await writeBytesWithPolicy(target, args.overwrite === true, out);
    }

    // Re-read so the reported page count is the file's, not the editor's idea.
    const verified = await Pdf.read(new Uint8Array(out), {
      extractText: false,
      extractImages: false
    });

    return textResult(
      config,
      [
        `Edited **${args.path}** — ${applied.length} operation(s) applied.`,
        `- written to ${writeTarget.display}${inPlace ? " (in place)" : ""} (${formatBytes(out.byteLength)})`,
        `- pages: ${pageCount} → ${verified.metadata?.pageCount ?? pageMap.length}`,
        incrementalPossible
          ? "- saved as an incremental update: bookmarks, form fields and original signature bytes are preserved; a certified signature may still report the document as modified if its DocMDP permissions forbid this edit"
          : structural
            ? "- **structural change, so the file was rebuilt**: any signature is now invalid, and document-level extras such as bookmarks may not survive"
            : "- rebuilt rather than appended (this PDF uses a cross-reference stream), so any signature is now invalid",
        ...describeBackup(writeTarget.display, backupPath),
        "",
        ...applied.map((line, index) => `${index + 1}. ${line}`),
        "",
        "Read it back with doc_read to verify any text you added."
      ].join("\n")
    );
  }
});

async function applyOp(
  editor: ReturnType<typeof Pdf.Editor.load>,
  op: z.infer<typeof opSchema>,
  pageMap: number[],
  config: ServerConfig
): Promise<{ description: string }> {
  const pageCount = pageMap.length;
  switch (op.op) {
    case "watermark": {
      const pages = resolvePages(op.pages, pageCount);
      for (const page of pages) {
        editor.getPage(requireOriginalPage(pageMap, page)).drawText(op.text, {
          x: 120,
          y: 360,
          fontSize: op.fontSize ?? 48,
          rotation: op.rotation ?? 45,
          // Transparency is the colour's alpha channel; drawText has no
          // separate opacity option.
          color: toColor(op.color ?? "FF0000", op.opacity ?? 0.25)
        });
      }
      return {
        description: `watermarked ${pages.length} page(s) with ${JSON.stringify(op.text)}`
      };
    }

    case "page_numbers": {
      const template = op.format ?? "Page {page} of {total}";
      const startAt = op.startAt ?? 1;
      const fontSize = op.fontSize ?? 9;
      const position = op.position ?? "bottom-center";

      for (let index = 0; index < pageCount; index += 1) {
        const label = template
          .replace(/\{page\}/g, String(index + startAt))
          .replace(/\{total\}/g, String(pageCount + startAt - 1));
        editor.getPage(requireOriginalPage(pageMap, index + 1)).drawText(label, {
          x: position === "bottom-left" ? 60 : position === "bottom-center" ? 260 : 460,
          y: 28,
          fontSize
        });
      }
      return {
        description: `numbered ${pageCount} page(s) as ${JSON.stringify(template)}`
      };
    }

    case "stamp": {
      const pages = resolvePages(op.pages, pageCount);
      for (const page of pages) {
        editor.getPage(requireOriginalPage(pageMap, page)).drawText(op.text, {
          x: op.x,
          y: op.y,
          fontSize: op.fontSize ?? 12,
          color: toColor(op.color ?? "000000")
        });
      }
      return { description: `stamped ${pages.length} page(s) at (${op.x}, ${op.y})` };
    }

    case "diagram": {
      const pages = resolvePages(op.pages, pageCount);
      const resolved = await resolveDiagramSource(config, op);
      const diagram = parseDiagram(resolved.source);
      // Built once and drawn onto every page: the layout does not depend on
      // where it lands, and re-running it per page would be pure waste.
      const style = toRenderOptions({
        ...(op.theme === undefined ? {} : { theme: op.theme }),
        // Transparent by default, because this draws over content that is
        // already there. `diagram_render` defaults to white for the opposite
        // reason: a standalone transparent file is invisible.
        background: op.background ?? "transparent"
      });
      const list = buildDrawList(resolved.source, style);

      let placement = "";
      for (const page of pages) {
        const target = editor.getPage(requireOriginalPage(pageMap, page));
        const boxWidth = op.width ?? Math.max(1, target.width - DIAGRAM_MARGIN * 2);
        const boxHeight = op.height ?? Math.max(1, target.height - DIAGRAM_MARGIN * 2);
        const room = Math.min(boxWidth / list.width, boxHeight / list.height);
        // An explicit box may enlarge the diagram; an implicit one only shrinks
        // it, so a small diagram is not blown up to fill the paper.
        const fit = op.width === undefined && op.height === undefined ? Math.min(1, room) : room;
        const drawnWidth = list.width * fit;
        const drawnHeight = list.height * fit;
        const x = op.x ?? (target.width - drawnWidth) / 2;
        const y = op.y ?? (target.height - drawnHeight) / 2;
        // Vectors, not a raster: `PdfEditorPage` puts down exactly the six marks
        // `PdfDrawPage` names, so the shared walker draws straight onto the
        // existing page and the diagram stays sharp at any zoom.
        renderDrawList(
          list,
          createPdfDrawSurface(target, { x, y, width: drawnWidth, height: drawnHeight }, fit)
        );
        placement = `${Math.round(drawnWidth)}×${Math.round(drawnHeight)} pt at (${Math.round(x)}, ${Math.round(y)})`;
      }

      return {
        description: `drew a diagram on ${pages.length} page(s) as vectors, ${placement} — ${summariseDiagram(diagram)}`
      };
    }

    case "delete_pages": {
      const pages = resolvePages(op.pages, pageCount);
      if (pages.length >= pageCount) {
        throw toolError.invalidInput(
          "that would delete every page",
          "A PDF must keep at least one page."
        );
      }
      // Descending, so each removal cannot shift the index of the next.
      for (const page of [...pages].sort((a, b) => b - a)) {
        const [original] = pageMap.splice(page - 1, 1);
        if (original === undefined || original < 0) {
          throw toolError.invalidInput("an appended page cannot be removed in the same call");
        }
        editor.removePage(original);
      }
      return {
        description: `deleted page(s) ${pages.join(", ")}`
      };
    }

    case "keep_pages": {
      const keep = new Set(resolvePages(op.pages, pageCount));
      if (keep.size === 0) {
        throw toolError.invalidInput("keep_pages must keep at least one page");
      }
      const remove: number[] = [];
      for (let page = 1; page <= pageCount; page += 1) {
        if (!keep.has(page)) {
          remove.push(page);
        }
      }
      for (const page of remove.toSorted((a, b) => b - a)) {
        const [original] = pageMap.splice(page - 1, 1);
        if (original === undefined || original < 0) {
          throw toolError.invalidInput("an appended page cannot be removed in the same call");
        }
        editor.removePage(original);
      }
      return {
        description: `kept page(s) ${[...keep].toSorted((a, b) => a - b).join(", ")}, removed ${remove.length}`
      };
    }

    case "rotate": {
      const pages = resolvePages(op.pages, pageCount);
      for (const page of pages) {
        editor.rotatePage(requireOriginalPage(pageMap, page), op.degrees);
      }
      return { description: `set ${pages.length} page(s) to ${op.degrees}° rotation` };
    }

    case "append": {
      const source = await resolveInRoot(config, op.path, { mustExist: true });
      const sourceBytes = new Uint8Array(await readFile(source));
      const sourceInfo = await Pdf.read(sourceBytes, {
        extractText: false,
        extractImages: false
      }).catch((cause: unknown) => {
        throw toolError.unsupported(`could not read ${op.path} as a PDF`, undefined, { cause });
      });
      const sourcePageCount = sourceInfo.metadata?.pageCount ?? 0;
      const wanted = op.pages === undefined ? undefined : resolvePages(op.pages, sourcePageCount);

      editor.copyPagesFrom(
        sourceBytes,
        wanted === undefined ? undefined : wanted.map(page => page - 1)
      );

      const added = wanted === undefined ? sourcePageCount : wanted.length;
      // Copied pages are not addressable through getPage/removePage until the
      // rebuilt document is loaded again. Keep sentinels so a later operation
      // gets an honest error instead of silently touching an original page.
      pageMap.push(...Array.from({ length: added }, () => -1));
      return {
        description: `appended ${added} page(s) from ${op.path}`
      };
    }
  }
}

/** Original editor index corresponding to a current 1-based page number. */
function requireOriginalPage(pageMap: readonly number[], page: number): number {
  const original = pageMap[page - 1];
  if (original === undefined) {
    throw toolError.invalidInput(`page ${page} does not exist`);
  }
  if (original < 0) {
    throw toolError.invalidInput(
      `page ${page} was appended earlier in this call and cannot be edited until the PDF is saved and reopened`,
      "Put append last, or make a second pdf_edit call for the appended pages."
    );
  }
  return original;
}

/** Resolve a page selector against the live page count, or every page. */
function resolvePages(
  selector: readonly number[] | string | undefined,
  pageCount: number
): number[] {
  const parsed = parsePages(selector);
  if (parsed === undefined) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const outOfRange = parsed.filter(page => page > pageCount);
  if (outOfRange.length > 0) {
    throw toolError.invalidInput(
      `page(s) ${outOfRange.join(", ")} do not exist — the document has ${pageCount}`,
      "Check the page count with doc_read or doc_inspect first."
    );
  }
  return [...new Set(parsed)].toSorted((a, b) => a - b);
}

/**
 * Convert `RRGGBB` to the engine's normalised colour.
 *
 * `PdfColor` components run 0–1, not 0–255, and its `a` channel is how
 * transparency is expressed — passing a hex string type-checks nowhere and
 * would be silently ignored.
 */
function toColor(color: string, alpha?: number): { r: number; g: number; b: number; a?: number } {
  const hex = color.replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(hex)) {
    throw toolError.invalidInput(
      `${JSON.stringify(color)} is not a hex colour`,
      'Use RRGGBB, e.g. "FF0000".'
    );
  }
  const channel = (offset: number): number =>
    Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    ...(alpha === undefined ? {} : { a: alpha })
  };
}
