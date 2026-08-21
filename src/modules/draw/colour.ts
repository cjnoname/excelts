/**
 * Colour policy for display-list producers.
 *
 * The IR carries colour as a struct, not a token, so every producer needs a step
 * that turns an authored string into one. Two decisions live in that step, and both
 * have to be the same everywhere or the same chart comes out differently depending
 * on which producer drew it:
 *
 * - **An unreadable token becomes black**, not transparent and not a throw. A
 *   colour the parser does not recognise is a authoring mistake, and a visible
 *   wrong colour is easier to notice and fix than an invisible shape.
 * - **Translucency is real alpha**, never a mix towards the background. The chart
 *   renderers used to fake it by blending towards white, which meant a translucent
 *   area series hid the gridlines it was supposed to sit over, and looked wrong on
 *   any background that was not white.
 *
 * These lived as private copies in `scene-to-draw.ts` and `chart-ex-nodes.ts`, one
 * per producer, which is how the two came to disagree about the second point.
 *
 * Not to be confused with mixing towards white as a *lighting* cue — a 3D bar's
 * lit face really is a paler version of its colour rather than a see-through one,
 * so that stays with the code that shades it.
 */

import { parseCssColor } from "@utils/svg-lex";
import type { Rgba01 } from "@utils/svg-lex";

const BLACK: Rgba01 = { r: 0, g: 0, b: 0, a: 1 };

/** An authored colour token as an IR colour; black when it cannot be read. */
export function cssColour(token: string | undefined): Rgba01 {
  return parseCssColor(token) ?? BLACK;
}

/** An authored colour token at the given alpha. */
export function translucent(token: string | undefined, alpha: number): Rgba01 {
  return { ...cssColour(token), a: alpha };
}
