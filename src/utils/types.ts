/**
 * Shared type-level utilities.
 *
 * Types only — this file emits no JavaScript, and (like the rest of `utils/`)
 * imports from no module.
 */

/** Values `DeepReadonly` must not recurse into. */
type Builtin =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | RegExp
  | ArrayBuffer
  | ArrayBufferView
  | ((...args: any[]) => unknown);

/**
 * Recursively `readonly` view of `T`.
 *
 * Used where a public reader hands back a *live* internal object: the shallow
 * `Readonly<T>` only freezes the top level, so `columns(ws)[0].style.numFmt = …`
 * would still compile and mutate the worksheet behind the namespace API.
 *
 * Built-ins (`Date`, typed arrays, functions, …) are passed through untouched —
 * mapping over their methods would produce unusable types. Arrays, `Map` and
 * `Set` become their readonly counterparts.
 *
 * Note this is a *type-level* guarantee only: TypeScript ignores `readonly`
 * property modifiers when checking assignability, so a caller can still launder
 * the value through a mutable type. That is deliberate — the goal is to stop
 * accidental writes, not to freeze objects at runtime.
 */
export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlySet<infer U>
      ? ReadonlySet<DeepReadonly<U>>
      : T extends readonly (infer U)[]
        ? readonly DeepReadonly<U>[]
        : { readonly [K in keyof T]: DeepReadonly<T[K]> };
