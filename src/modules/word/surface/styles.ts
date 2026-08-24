/**
 * `Styles` namespace surface — style-mapping DSL parsing / matching.
 *
 * `import { Styles } from "documonster/word"` →
 *   `Styles.parse(dsl)`, `Styles.create(rules)`, `Styles.match(...)`,
 *   `Styles.DEFAULT`, … — tree-shaken via `export * as Styles`.
 *
 * Named `Styles` at the entry, not `StyleMap`: `StyleMap` is already the public
 * name of the mapping *type* (`export type { StyleMap }`), so a namespace under
 * that name would collide with it — and did, in this comment, which told readers
 * to call `StyleMap.parse` on a type.
 */
export {
  parseStyleMap as parse,
  createStyleMap as create,
  mergeStyleMaps as merge,
  matchStyleMap as match,
  DEFAULT_STYLE_MAP as DEFAULT
} from "@word/advanced/style-map";
