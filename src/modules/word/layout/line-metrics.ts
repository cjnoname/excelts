/** Font ink extents in points. `descent` is negative. */
export interface WordFontMetrics {
  readonly ascent: number;
  readonly descent: number;
}

/** Inputs shared by the pagination estimator and the positioned layout. */
export interface WordLineMetricsInput extends WordFontMetrics {
  /** Requested line-box height after applying `w:spacing`. */
  readonly nominalHeight: number;
  /** Tallest inline image, which sits above the text baseline. */
  readonly imageAscent?: number;
  /** Whether `nominalHeight` came from `w:lineRule="exact"`. */
  readonly exact?: boolean;
}

export interface WordLineMetrics {
  /** Distance from the top of the line box to the shared baseline. */
  readonly baseline: number;
  /** Final line-box height. */
  readonly height: number;
}

const EMPTY_LINE_BASELINE_RATIO = 0.8;

/**
 * Resolve one Word line box from its nominal height and visual extents.
 *
 * Text runs share a baseline. Surplus line height (leading) is split evenly
 * above the ascent and below the descent. Inline images sit on that baseline,
 * so a taller picture increases the above-baseline extent.
 *
 * `exact` fixes the box height at the requested value, because OOXML defines
 * `w:lineRule="exact"` as an exact line height rather than a minimum — that is
 * what positions everything after it and drives pagination. It does *not* clip
 * the line: when the ink is taller than the box the glyphs are still drawn in
 * full and simply overlap the neighbouring lines, exactly as `line-height`
 * smaller than `font-size` behaves in CSS. Clipping instead would slice glyphs
 * in half, which no typesetter does; a cell or text box is what bounds overflow.
 */
export function resolveWordLineMetrics(input: WordLineMetricsInput): WordLineMetrics {
  const nominalHeight = Math.max(0, input.nominalHeight);
  if (input.ascent - input.descent <= 0 && (input.imageAscent ?? 0) <= 0) {
    return {
      baseline: nominalHeight * EMPTY_LINE_BASELINE_RATIO,
      height: nominalHeight
    };
  }
  const ascent = Math.max(0, input.ascent, input.imageAscent ?? 0);
  const descent = Math.min(0, input.descent);
  const inkHeight = ascent - descent;
  const halfLeading = Math.max(0, (nominalHeight - inkHeight) / 2);
  const baseline = halfLeading + ascent;

  return {
    baseline,
    height: input.exact ? nominalHeight : Math.max(nominalHeight, baseline - descent)
  };
}
