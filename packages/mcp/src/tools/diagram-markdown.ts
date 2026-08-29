/**
 * Mermaid fences inside Markdown, for `doc_write` and `doc_convert`.
 *
 * A ` ```mermaid ` fence carried into a Word document as monospace text is
 * useless — the whole point of the fence is that it is a picture. So each one is
 * rendered to a PNG and spliced in as an inline image before the Markdown reaches
 * the converter.
 *
 * The seam is `markdownToDocx`'s `resolveImage` callback: the fence is rewritten
 * to `![alt](documonster-diagram:N)` and the callback answers that one URL scheme
 * and nothing else. Rewriting to a *file* path instead would need a writable
 * scratch directory and would leak the diagrams as loose files beside the
 * document; going through the callback keeps them in memory and inside the
 * package.
 *
 * The width cap is not cosmetic. A flowchart is routinely wider than a page's text
 * column, and Word does not shrink an oversized inline image — it runs off the
 * edge of the paper. Fitting to the text width is the difference between a
 * document and a broken one.
 */

import type { MarkdownImageData, MarkdownImportOptions } from "documonster/word/markdown";

import { toolError } from "../errors.js";
import {
  EMU_PER_POINT,
  buildDrawList,
  findMermaidFences,
  parseDiagram,
  renderDiagram,
  toRenderOptions,
  type DiagramStyleArgs
} from "./diagram.js";
import { newImageBudget, type ImageBudget } from "./image.js";

/**
 * Widest an embedded diagram may be, in points.
 *
 * US Letter (the Word writer's default page) less one-inch margins is 6.5 inches
 * of text column. A wider image is not clipped by Word, it overflows the page.
 */
const MAX_EMBED_WIDTH_POINTS = 468;

/** Pixels per point for an embedded diagram — 144 DPI, sharp in print and on screen. */
const EMBED_SCALE = 2;

/** URL scheme the rewritten fences use. Deliberately not a real one. */
const DIAGRAM_URL_PREFIX = "documonster-diagram:";

/** Fences one document may carry, so a pathological input cannot exhaust memory. */
const MAX_EMBEDDED_DIAGRAMS = 20;

/** Aggregate rendering budget for one document's fences. */
const MAX_EMBED_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_EMBED_TOTAL_PIXELS = 80_000_000;

export interface PreparedMarkdown {
  /** The Markdown with every mermaid fence replaced by an image reference. */
  readonly markdown: string;
  /**
   * Pass as `markdownToDocx`'s `resolveImage`. Present only when at least one
   * fence was rendered, so the no-diagram path behaves exactly as before.
   */
  readonly resolveImage?: MarkdownImportOptions["resolveImage"];
  /** How many diagrams were rendered. */
  readonly count: number;
  /** Lines worth reporting to the caller. */
  readonly notes: readonly string[];
}

/**
 * Render every mermaid fence in `markdown` and rewrite it as an inline image.
 *
 * A fence that does not parse is left exactly as it was — a code block — and
 * reported. Failing the whole document because one diagram is malformed would
 * throw away the nine paragraphs that were fine, and the note names the line to
 * fix.
 */
export async function prepareMarkdownDiagrams(
  markdown: string,
  style: DiagramStyleArgs = {}
): Promise<PreparedMarkdown> {
  const fences = findMermaidFences(markdown);
  if (fences.length === 0) {
    return { markdown, count: 0, notes: [] };
  }

  if (fences.length > MAX_EMBEDDED_DIAGRAMS) {
    throw toolError.tooLarge(
      `this document has ${fences.length} mermaid fences, over the ${MAX_EMBEDDED_DIAGRAMS} limit for one call`,
      "Every diagram is rendered and held in memory until the document is written. Split the document, or pass diagrams: false and render the ones you need with diagram_render."
    );
  }

  const options = toRenderOptions(style);
  const images = new Map<string, MarkdownImageData>();
  const failures: string[] = [];
  // One budget across every fence: ten diagrams each just under the rasteriser's
  // own per-image cap is gigabytes, and each is held until the document is written.
  const budget = newImageBudget();
  let rewritten = markdown;

  // Back to front, so each splice leaves the earlier fences' offsets valid.
  for (const fence of [...fences].reverse()) {
    let image: MarkdownImageData;
    let alt: string;
    try {
      const diagram = parseDiagram(fence.source);
      const list = buildDrawList(fence.source, options);
      const fit = Math.min(1, MAX_EMBED_WIDTH_POINTS / list.width);
      // Rasterised at the size it will be *displayed*, not at its natural size.
      // A 1034-point flowchart in a 468-point column was previously rendered in
      // full and then merely declared smaller, so most of the pixels — and the CPU
      // and memory that produced them — were discarded by Word.
      const rendered = await renderDiagram(
        list,
        "png",
        { scale: EMBED_SCALE * fit },
        options.background
      );
      spendEmbedBudget(budget, rendered, fence.line);
      alt = diagram.title ?? `${diagram.kind} diagram`;
      image = {
        data: rendered.bytes,
        mediaType: "png",
        width: Math.round(list.width * fit * EMU_PER_POINT),
        height: Math.round(list.height * fit * EMU_PER_POINT)
      };
    } catch (cause) {
      failures.push(
        `- **diagram at line ${fence.line} left as a code block**: ${cause instanceof Error ? cause.message : String(cause)}`
      );
      continue;
    }

    const url = `${DIAGRAM_URL_PREFIX}${fence.ordinal}`;
    images.set(url, image);
    // A blank line either side: an image reference that lands against a
    // neighbouring line is parsed as part of that paragraph.
    rewritten = `${rewritten.slice(0, fence.start)}\n![${escapeAlt(alt)}](${url})\n${rewritten.slice(fence.end)}`;
  }

  const notes =
    images.size === 0
      ? failures
      : [
          `- ${images.size} mermaid diagram(s) rendered and embedded as PNG, fitted to the text column`,
          ...failures
        ];

  return {
    markdown: rewritten,
    count: images.size,
    ...(images.size === 0 ? {} : { resolveImage: (url: string) => images.get(url) }),
    notes
  };
}

/**
 * Charge one rendered diagram against the call's budget.
 *
 * A `too_large` here aborts the whole conversion rather than being collected as a
 * per-fence failure: the limit is about the call, and continuing would keep spending
 * exactly the resource that ran out.
 */
function spendEmbedBudget(
  budget: ImageBudget,
  rendered: { readonly bytes: Uint8Array; readonly width: number; readonly height: number },
  line: number
): void {
  budget.count += 1;
  budget.bytes += rendered.bytes.length;
  budget.pixels += rendered.width * rendered.height;
  if (budget.bytes > MAX_EMBED_TOTAL_BYTES || budget.pixels > MAX_EMBED_TOTAL_PIXELS) {
    throw toolError.tooLarge(
      `the diagrams in this document exceed the per-call rendering budget (reached at the fence on line ${line})`,
      "Split the document, or pass diagrams: false and render the large ones separately with diagram_render."
    );
  }
}

/** `[` and `]` in alt text would close the image reference early. */
function escapeAlt(text: string): string {
  return text.replace(/[[\]]/g, "");
}
