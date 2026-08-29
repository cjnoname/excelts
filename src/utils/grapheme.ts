/**
 * Extended grapheme cluster segmentation with a zero-dependency fallback.
 *
 * Node 22, Chromium and Safari expose `Intl.Segmenter`, but Firefox 102–124 do
 * not. Constructing it at module load crashed every import on a supported
 * browser. The fallback preserves the boundaries this library must never split:
 * combining marks, variation selectors, emoji modifiers, ZWJ sequences and
 * regional-indicator flag pairs.
 */

type SegmenterLike = { segment(input: string): Iterable<{ segment: string }> };
let cachedSegmenter: SegmenterLike | null | undefined;

function nativeSegmenter(): SegmenterLike | null {
  if (cachedSegmenter !== undefined) {
    return cachedSegmenter;
  }
  const ctor = (
    Intl as unknown as {
      Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => SegmenterLike;
    }
  ).Segmenter;
  cachedSegmenter = ctor ? new ctor(undefined, { granularity: "grapheme" }) : null;
  return cachedSegmenter;
}

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

function isEmojiModifier(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

function fallbackClusters(text: string): string[] {
  const cps = [...text];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    let cluster = cps[i];
    const first = cps[i].codePointAt(0)!;
    if (isRegionalIndicator(first) && i + 1 < cps.length) {
      if (isRegionalIndicator(cps[i + 1].codePointAt(0)!)) {
        cluster += cps[++i];
      }
    }
    while (i + 1 < cps.length) {
      const next = cps[i + 1].codePointAt(0)!;
      if (isCombining(next) || isVariationSelector(next) || isEmojiModifier(next)) {
        cluster += cps[++i];
      } else if (next === 0x200d && i + 2 < cps.length) {
        cluster += cps[++i];
        cluster += cps[++i];
      } else {
        break;
      }
    }
    out.push(cluster);
  }
  return out;
}

export function graphemeClusters(text: string): string[] {
  const segmenter = nativeSegmenter();
  return segmenter
    ? [...segmenter.segment(text)].map(item => item.segment)
    : fallbackClusters(text);
}

/** @internal */
export function _resetGraphemeSegmenterForTest(): void {
  cachedSegmenter = undefined;
}
