/**
 * Font diagnostics for the tools that write a PDF.
 *
 * Every PDF this server produces went through `Pdf.fromDocx` / `Pdf.fromExcel`
 * without an `onWarning` handler, so the one degradation a caller cannot see for
 * themselves was the one thing never reported: a character no available typeface
 * covers still carries its Unicode for copy and search, and draws as a `.notdef`
 * box. The tool then said "Converted … (md → pdf, 74.1 kB)" and the boxes were
 * discovered by a human opening the file — which is exactly how a document of
 * Chinese prose came back with every ideograph blank and nobody was told.
 *
 * The model cannot check this either: the result text says to verify by opening
 * the PDF, and this server deliberately cannot read its own PDF output back
 * structurally. So the writer's own warning is the only signal that exists.
 *
 * @module
 */

import { readFileSync } from "node:fs";

import type { PdfFontConfig } from "documonster/pdf";

import { toolError } from "../errors.js";

/**
 * Font options for one PDF-producing call: the operator's font, if they named
 * one, and a collector for whatever the writer reports.
 *
 * Returned as one object so a call site cannot wire the diagnostics and forget
 * the font, or the other way round — the two exist for the same failure.
 */
export function pdfFontOptions(config: { readonly pdfFont?: string }): {
  /** Spread into the PDF call. Never carries anything the library does not define. */
  readonly options: {
    readonly fonts?: PdfFontConfig;
    readonly onWarning: (message: string) => void;
  };
  /** Lines to append to the tool result, most serious first. */
  notes(): string[];
} {
  const collector = collectFontWarnings();
  const fonts = config.pdfFont === undefined ? undefined : loadFont(config.pdfFont);
  return {
    options: {
      ...(fonts === undefined ? {} : { fonts }),
      onWarning: collector.onWarning
    },
    notes: collector.notes
  };
}

/**
 * Read and cache the operator's font.
 *
 * Cached by path because a CJK face is tens of megabytes and a conversion-heavy
 * session would otherwise re-read it per call. `resolveConfig` has already vetted
 * that the file exists and is TrueType, so a failure here is a font deleted while
 * the server was running — worth reporting as itself rather than as a PDF error.
 */
function loadFont(fontPath: string): PdfFontConfig {
  const cached = fontCache.get(fontPath);
  if (cached !== undefined) {
    return cached;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(fontPath));
  } catch (cause) {
    throw toolError.unsupported(
      `the font configured with --pdf-font could not be read: ${fontPath}`,
      "It existed at startup, so it has been moved or deleted since.",
      { cause }
    );
  }
  // One default regular face. Named families would need the operator to state
  // which Word/Excel family each file serves, and the point of this option is a
  // floor under every document, not per-family typography.
  const config: PdfFontConfig = { default: { regular: bytes } };
  fontCache.set(fontPath, config);
  return config;
}

const fontCache = new Map<string, PdfFontConfig>();

/** A collector to hand to `onWarning`, plus the notes it accumulated. */
export interface FontWarningCollector {
  /** Pass as `onWarning` to any PDF-producing call. */
  readonly onWarning: (message: string) => void;
  /**
   * Lines to append to the tool result, most serious first.
   *
   * Empty when nothing was raised, so a caller can splat it unconditionally.
   */
  notes(): string[];
}

/**
 * The substring the library uses for characters that will visibly render as
 * `.notdef` boxes.
 *
 * Matched rather than re-derived: the condition is decided inside the font
 * manager, and a second rule here would drift from it. Kept as a constant so the
 * coupling is visible at the one place that depends on the wording.
 */
const TOFU_MARKER = "no glyph in any available font";

export function collectFontWarnings(): FontWarningCollector {
  const messages: string[] = [];
  return {
    onWarning: message => {
      messages.push(message);
    },
    notes: () => {
      if (messages.length === 0) {
        return [];
      }
      const tofu = messages.filter(message => message.includes(TOFU_MARKER));
      const rest = messages.filter(message => !message.includes(TOFU_MARKER));
      return [
        // Bold, because this one means the page is visibly wrong. The rest are
        // notes about how the output was produced, not about it being broken.
        ...tofu.map(message => `- **font coverage**: ${message}`),
        ...rest.map(message => `- font: ${message}`)
      ];
    }
  };
}
