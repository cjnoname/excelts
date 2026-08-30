/**
 * Package parts the workbook model carries but does not interpret.
 *
 * These types live in `core/` rather than beside the XLSX policy that produces
 * them because they describe *workbook state*, not a serialisation detail: a
 * `WorkbookData` holds them for as long as it exists, `getWorkbookModel` hands
 * them out, and every OPC-based format has the same need. XLSB is the immediate
 * reason — it is also a ZIP of OPC parts with a `[Content_Types].xml` and `.rels`
 * files, so it needs to express "a part I did not model" without importing from
 * the XLSX serialiser to say it.
 *
 * The policy that decides *which* parts to keep, resolves relationship targets
 * and prunes unreachable ones is format-specific and stays in
 * `xlsx/opaque-parts.ts`.
 */

/**
 * A relationship carried through verbatim.
 *
 * `targetMode` is typed as `string` rather than `"Internal" | "External"` so a
 * non-standard value in the source package survives instead of being normalised
 * into something the producer never wrote.
 */
export interface OpaqueRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly targetMode?: string;
}

/** An inbound relationship, together with the part that declared it. */
export interface OpaqueSourceRelationship extends OpaqueRelationship {
  /** Part whose `.rels` carried this relationship, e.g. `xl/workbook.xml`. */
  readonly source: string;
}

/**
 * A package part this library does not model, preserved for round-trip fidelity.
 *
 * Bytes alone are not enough to keep a part alive. A reader reaches a part through
 * a relationship and decides how to interpret it from its content type, and the
 * writer regenerates both `[Content_Types].xml` and every `.rels` from the model.
 * So a preserved part needs three things travelling with it:
 *
 *  * `contentType` — the `Override` it had, if any, or nothing knows what it is;
 *  * `relationships` — its *own* `.rels`, so anything it points at resolves;
 *  * `sourceRelationships` — the relationships that pointed *at* it. This is the
 *    one that is easy to forget, and forgetting it produces a package that
 *    contains a VBA project no application will ever look for.
 */
export interface OpaquePart {
  readonly path: string;
  readonly data: Uint8Array;
  readonly contentType?: string;
  readonly relationships?: readonly OpaqueRelationship[];
  readonly sourceRelationships?: readonly OpaqueSourceRelationship[];
}

/** Why a preserved part was not written back, for reporting to the caller. */
export type OpaqueDropReason = "stale-cache" | "invalidated-signature" | "unreachable";

/**
 * A part that was deliberately not written back, and why.
 *
 * Recorded rather than discarded because two of the three reasons are things a
 * caller may need to know about: a digital signature is removed on every write
 * that re-serialises a modelled part, and a part can become unreachable as a
 * side effect of deleting the sheet that referenced it. Neither is an error, and
 * neither should be silent.
 */
export interface OpaqueDrop {
  readonly path: string;
  readonly reason: OpaqueDropReason;
  readonly description: string;
}
