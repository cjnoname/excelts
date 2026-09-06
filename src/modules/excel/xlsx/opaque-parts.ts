/**
 * Opaque package parts — preservation policy.
 *
 * A real-world `.xlsx` carries parts this library does not model: a VBA project,
 * custom document properties, data connections, query tables, printer settings,
 * vendor extensions. Until now the loader drained those entries and dropped the
 * bytes, so `read` followed by `write` silently deleted them. The most damaging
 * case was `xl/vbaProject.bin`: the workbook content type *is* round-tripped, so
 * a macro-enabled workbook came back out still declaring itself macro-enabled
 * with every macro gone.
 *
 * The default is therefore to preserve. A part nobody has classified is more
 * likely to be someone's data than to be something we are entitled to delete,
 * and the failure mode of keeping too much (a slightly larger file) is far
 * cheaper than the failure mode of keeping too little (silent data loss).
 *
 * What follows is the exception list: the parts that must *not* be written back.
 * They fall into exactly two kinds, and the distinction matters because the
 * reasons are different.
 *
 *  1. **Caches.** `calcChain.xml` records the order Excel last evaluated
 *     formulas in; `volatileDependencies.xml` and the revision log are the same
 *     shape of thing. Their contents describe a workbook state that no longer
 *     exists once anything is edited, and replaying a stale one is worse than
 *     omitting it — Excel rebuilds all of them on open. Dropping these is not
 *     data loss, it is declining to assert something false.
 *
 *  2. **Signatures.** A digital signature covers the exact bytes of the package
 *     it was made over. This library re-serialises every modelled part on write
 *     (attribute order, self-closing tags and shared-string indices all move),
 *     so the signature cannot still be valid. Writing it back would produce a
 *     file that claims to be signed and is not, which is a worse outcome than a
 *     file that is honestly unsigned. `word/` reached the same conclusion for
 *     `.docx` and drops `_xmlsignatures/` by default.
 *
 * Everything else is preserved verbatim, together with its content type and the
 * relationships that make it reachable.
 */

import type {
  OpaqueDrop,
  OpaqueDropReason,
  OpaquePart,
  OpaqueRelationship,
  OpaqueSourceRelationship
} from "@excel/core/opaque-part";

// Re-exported so the policy and the shapes it operates on can be imported from
// one place by the XLSX layer, without core having to know this file exists.
export type {
  OpaqueDrop,
  OpaqueDropReason,
  OpaquePart,
  OpaqueRelationship,
  OpaqueSourceRelationship
} from "@excel/core/opaque-part";

interface DropRule {
  readonly reason: OpaqueDropReason;
  /** Receives an already-lower-cased path, so patterns here are lower-case. */
  readonly test: (lowerPath: string) => boolean;
  /** Named in diagnostics so a caller learns what happened and why. */
  readonly description: string;
}

const DROP_RULES: readonly DropRule[] = [
  {
    reason: "stale-cache",
    description: "formula dependency-order cache; Excel rebuilds it on open",
    test: path => path === "xl/calcchain.xml"
  },
  {
    reason: "stale-cache",
    description: "volatile-function dependency cache; Excel rebuilds it on open",
    test: path => path === "xl/volatiledependencies.xml"
  },
  {
    reason: "stale-cache",
    description: "shared-workbook revision log; describes edits to the source package",
    test: path => path.startsWith("xl/revisions/")
  },
  {
    reason: "invalidated-signature",
    description: "digital signature over the source bytes, which this write replaces",
    test: path => path.startsWith("_xmlsignatures/")
  }
];

/**
 * Decide whether a part the loader does not model should be carried through.
 *
 * @returns `undefined` to preserve, or the reason it must be dropped.
 */
export function classifyOpaquePart(
  path: string
): { reason: OpaqueDropReason; description: string } | undefined {
  const normalized = path.toLowerCase();
  for (const rule of DROP_RULES) {
    if (rule.test(normalized)) {
      return { reason: rule.reason, description: rule.description };
    }
  }
  return undefined;
}

/**
 * True when the path is a relationships part.
 *
 * A `.rels` file belonging to an opaque part is not itself preserved as a part —
 * it is parsed and re-emitted from the owning part's `relationships`, so that a
 * relationship pointing at something we *did* drop does not survive as a
 * dangling reference.
 *
 * Note the `*` rather than `+`: the package-level relationships part is
 * `_rels/.rels`, whose file name is nothing but the extension.
 */
export function isRelationshipsPart(path: string): boolean {
  return /(^|\/)_rels\/[^/]*\.rels$/i.test(path);
}

/** The `.rels` path for a part, e.g. `xl/x.bin` → `xl/_rels/x.bin.rels`. */
export function relationshipsPathFor(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const base = slash === -1 ? path : path.slice(slash + 1);
  return `${dir}_rels/${base}.rels`;
}

/**
 * The part a `.rels` path describes, e.g. `xl/_rels/x.bin.rels` → `xl/x.bin`.
 *
 * `_rels/.rels` describes the package itself, and so yields the empty path.
 */
export function ownerOfRelationshipsPart(relsPath: string): string | undefined {
  const match = /^(.*?)_rels\/([^/]*)\.rels$/i.exec(relsPath);
  return match ? `${match[1]}${match[2]}` : undefined;
}

/**
 * Resolve a relationship target against the part that declares it.
 *
 * Targets are relative to the *directory of the declaring part*, so a
 * relationship on `xl/workbook.xml` with target `vbaProject.bin` means
 * `xl/vbaProject.bin`, and `../customXml/item1.xml` climbs out of `xl/`.
 * External targets and absolute ones are handled separately.
 *
 * `source` may be either the declaring part or its `.rels` file. That is not
 * mere convenience: `_rels/` is not part of the base for resolution, so treating
 * `_rels/.rels` literally would resolve every package-level target one directory
 * too deep — which is exactly how `docProps/custom.xml` becomes the
 * non-existent `_rels/docProps/custom.xml`.
 */
/**
 * Whether a relationship on a surviving part should still be written.
 *
 * **The one predicate for "does this edge dangle", because the two writers had opposite answers.** The policy is stated
 * beside `resolveReachableOpaqueParts`: prune only edges to paths *deliberately excluded*, and leave alone a target that
 * is a modelled part, an external URL, or something this writer knows nothing about — the goal is to avoid dangling
 * references, not to audit every relationship.
 *
 * `resolveRelationshipTarget` returns `undefined` for exactly those cases, so `undefined` means "not ours to judge" and
 * must be kept. The XLSX writer had that; the XLSB writer required `target !== undefined && kept.has(target)`, so a
 * sheet's external hyperlink relationship survived one container and was deleted by the other.
 */
export function relationshipStillResolves(
  source: string,
  relationship: { readonly target: string; readonly targetMode?: string },
  kept: ReadonlySet<string>
): boolean {
  const target = resolveRelationshipTarget(source, relationship.target, relationship.targetMode);
  return target === undefined || kept.has(target.toLowerCase());
}

export function resolveRelationshipTarget(
  source: string,
  target: string,
  targetMode?: string
): string | undefined {
  if (targetMode === "External" || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return undefined;
  }
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const declaring = isRelationshipsPart(source)
    ? (ownerOfRelationshipsPart(source) ?? source)
    : source;
  const slash = declaring.lastIndexOf("/");
  const segments = (slash === -1 ? "" : declaring.slice(0, slash)).split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** Raw material the loader gathers while walking the package, in ZIP order. */
export interface OpaquePartSources {
  /** Bytes of every entry the loader did not recognise, keyed by path. */
  readonly unknownEntries: ReadonlyMap<string, Uint8Array>;
  /** `Override` content types from `[Content_Types].xml`, keyed by part path. */
  readonly contentTypeOverrides: ReadonlyMap<string, string>;
  /** Parsed `.rels` files, keyed by the part that declares them. */
  readonly relationshipsBySource: ReadonlyMap<string, readonly OpaqueRelationship[]>;
}

export interface OpaquePartCollection {
  readonly parts: readonly OpaquePart[];
  readonly drops: readonly OpaqueDrop[];
}

/**
 * Join the bytes, content types and relationships the loader gathered into a set
 * of self-contained preserved parts.
 *
 * This runs after the whole package has been walked rather than per entry,
 * because a ZIP imposes no order: `[Content_Types].xml` may appear after the
 * parts it describes, and a `.rels` file may appear before or after its owner. A
 * per-entry assembly would therefore be correct only for the orderings Excel
 * happens to use, and wrong for every other producer.
 *
 * A relationship pointing at a part that was *dropped* is itself dropped, so
 * that declining to write a stale cache does not leave a dangling reference
 * behind — a dangling relationship is one of the things Excel offers to repair.
 */
export function collectOpaqueParts(sources: OpaquePartSources): OpaquePartCollection {
  const drops: OpaqueDrop[] = [];
  const droppedPaths = new Set<string>();

  const candidates = [...sources.unknownEntries.keys()]
    .filter(path => !isRelationshipsPart(path))
    .sort();

  for (const path of candidates) {
    const verdict = classifyOpaquePart(path);
    if (verdict) {
      drops.push({ path, reason: verdict.reason, description: verdict.description });
      droppedPaths.add(path.toLowerCase());
    }
  }

  // Resolve every relationship in the package once, into target → inbound edges.
  // The obvious shape — ask "what points at this part?" per part — rescans every
  // relationship for every part, so a 60-sheet workbook with 30 preserved parts
  // performs ~21,600 target resolutions where ~720 suffice, each one splitting and
  // rejoining path segments. Inverting it is both faster and shorter.
  const inbound = new Map<string, OpaqueSourceRelationship[]>();
  for (const [source, relationships] of sources.relationshipsBySource) {
    // A relationship declared by another opaque part travels with that part's own
    // `relationships`, so recording it here as well would register it twice.
    if (sources.unknownEntries.has(source)) {
      continue;
    }
    for (const relationship of relationships) {
      const target = resolveRelationshipTarget(
        source,
        relationship.target,
        relationship.targetMode
      );
      if (!target) {
        continue;
      }
      const key = target.toLowerCase();
      if (droppedPaths.has(key)) {
        continue;
      }
      const edges = inbound.get(key);
      if (edges) {
        edges.push({ ...relationship, source });
      } else {
        inbound.set(key, [{ ...relationship, source }]);
      }
    }
  }

  const parts: OpaquePart[] = [];
  for (const path of candidates) {
    if (droppedPaths.has(path.toLowerCase())) {
      continue;
    }
    // An opaque part's own `.rels` is re-emitted verbatim, so an edge to something
    // the policy dropped has to go with it. Without this the promise made above —
    // that declining to write a stale cache leaves no dangling reference — holds
    // only for the relationships this writer regenerates, and a preserved
    // `customXml/_rels/item1.xml.rels` pointing at `xl/calcChain.xml` still ships.
    const relationships = (sources.relationshipsBySource.get(path) ?? []).filter(relationship => {
      const target = resolveRelationshipTarget(path, relationship.target, relationship.targetMode);
      return !target || !droppedPaths.has(target.toLowerCase());
    });
    parts.push({
      path,
      data: sources.unknownEntries.get(path)!,
      contentType: sources.contentTypeOverrides.get(path),
      relationships: relationships.length > 0 ? relationships : undefined,
      sourceRelationships: inbound.get(path.toLowerCase())
    });
  }

  return { parts, drops };
}

/**
 * Append the relationships that reach preserved parts from `source`.
 *
 * The writer regenerates `_rels/.rels` and `xl/_rels/workbook.xml.rels` from the
 * model with freshly numbered `rId`s, so a preserved part's inbound relationship
 * has to be re-registered or nothing in the package points at it — a VBA project
 * that is present but unreachable is indistinguishable, to Excel, from one that
 * was never there.
 *
 * The original `rId` is kept when it does not collide, because an opaque part's
 * *own* XML may name it. On a collision a fresh id is allocated above every id
 * already present: correctness of the reference wins over preserving the label.
 */
export function appendOpaqueSourceRelationships(
  relationships: { Id: string; Type: string; Target: string; TargetMode?: string }[],
  parts: readonly OpaquePart[] | undefined,
  source: string
): void {
  if (!parts || parts.length === 0) {
    return;
  }

  const used = new Set(relationships.map(rel => rel.Id));
  let nextFree =
    relationships.reduce((highest, rel) => {
      const match = /^rId(\d+)$/.exec(rel.Id);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;

  for (const part of parts) {
    for (const inbound of part.sourceRelationships ?? []) {
      if (inbound.source !== source) {
        continue;
      }
      let id = inbound.id;
      if (used.has(id)) {
        while (used.has(`rId${nextFree}`)) {
          nextFree++;
        }
        id = `rId${nextFree++}`;
      }
      used.add(id);
      relationships.push({
        Id: id,
        Type: inbound.type,
        Target: inbound.target,
        ...(inbound.targetMode ? { TargetMode: inbound.targetMode } : {})
      });
    }
  }
}

/**
 * Work out how to declare each preserved part's content type.
 *
 * A part that had an explicit `Override` keeps it. A part that relied on a
 * `Default` for its extension is the interesting case, because `Default` is a
 * package-wide statement and this writer emits its own for `rels`, `xml` and every
 * media extension it knows about. When the source package declared one of those
 * extensions differently — and OPC allows that, since the modelled parts each
 * carry their own `Override` — re-emitting the writer's value silently reclassifies
 * the preserved part. A vendor XML part declared through
 * `<Default Extension="xml" ContentType="application/vnd.vendor.feature+xml"/>`
 * would come back out as `application/xml`: bytes intact, meaning gone.
 *
 * So a conflicting `Default` is promoted to an explicit `Override` on the part
 * that needed it. That preserves the classification without changing how the
 * package declares anything else, and it is the same shape OPC itself uses to say
 * "this one part is different".
 *
 * @param reserved Extensions this writer declares itself, and with what.
 */
export function opaqueContentTypeDeclarations(
  parts: readonly OpaquePart[] | undefined,
  defaults: Readonly<Record<string, string>> | undefined,
  reserved: ReadonlyMap<string, string>,
  /**
   * Part *paths* this writer declares an `Override` for itself, lower-cased.
   *
   * **`reserved` handles a clash of extensions; this handles a clash of names, and they are not the same problem.** The
   * XLSX content-types writer emits a fixed `Override` for `xl/theme/theme1.xml` whatever the model holds — so a theme
   * that arrives as a *preserved* part, which is how every XLSB read delivers one, was declared twice and the package's
   * own validator refused it with `content-types-duplicate-override`. Nothing caught it before because a preserved
   * theme could not previously reach an XLSX write at all: it was being dropped as unreachable.
   *
   * The writer's own declaration wins, since it is emitted unconditionally and cannot be suppressed from here. Both
   * name the same content type in practice — a theme is a theme — so which one survives changes nothing but the count.
   */
  reservedPaths: ReadonlySet<string> = new Set()
): { overrides: Record<string, string>; defaults: Record<string, string> } {
  const overrides: Record<string, string> = {};
  const emittedDefaults: Record<string, string> = {};

  for (const part of parts ?? []) {
    if (reservedPaths.has(part.path.toLowerCase())) {
      continue;
    }
    if (part.contentType) {
      overrides[part.path] = part.contentType;
      continue;
    }
    const dot = part.path.lastIndexOf(".");
    const extension = dot === -1 ? "" : part.path.slice(dot + 1).toLowerCase();
    const declared = extension ? defaults?.[extension] : undefined;
    if (!declared) {
      continue;
    }
    const reservedValue = reserved.get(extension);
    if (reservedValue !== undefined && reservedValue !== declared) {
      overrides[part.path] = declared;
    } else if (reservedValue === undefined) {
      emittedDefaults[extension] = declared;
    }
  }

  return { overrides, defaults: emittedDefaults };
}

/**
 * Group the inbound edges by the part that declares them.
 *
 * Built once and looked up per sheet rather than rescanning every part for every
 * sheet — and it reads better at the call site, which is a loop over worksheets
 * asking "what did this one point at?".
 */
export function groupOpaqueRelationshipsBySource(
  parts: readonly OpaquePart[] | undefined
): Map<string, OpaqueRelationship[]> {
  const grouped = new Map<string, OpaqueRelationship[]>();
  for (const part of parts ?? []) {
    for (const inbound of part.sourceRelationships ?? []) {
      const edge: OpaqueRelationship = {
        id: inbound.id,
        type: inbound.type,
        target: inbound.target,
        targetMode: inbound.targetMode
      };
      const edges = grouped.get(inbound.source);
      if (edges) {
        edges.push(edge);
      } else {
        grouped.set(inbound.source, [edge]);
      }
    }
  }
  return grouped;
}

/**
 * Drop the preserved parts nothing will point at, and prune the edges to them.
 *
 * Keeping a part's bytes is only half of preserving it. A part Excel cannot reach
 * is indistinguishable from a part that was never there, so emitting one adds
 * weight to the package and changes nothing — and a relationship whose target is
 * absent is worse than either, because a dangling reference is one of the things
 * Excel offers to "repair".
 *
 * Reachability has to be decided at write time rather than at read time, because
 * what can be reached depends on what is being written. Three things make a part
 * unreachable, and they are all the same shape once expressed this way:
 *
 *  * its only inbound relationship came from a sheet that has since been deleted;
 *  * its only inbound relationship came from a part whose `.rels` this writer
 *    regenerates without a channel for preserved edges (a chart, a drawing, a
 *    pivot table) — recorded on read precisely so the decision here is informed
 *    rather than accidental;
 *  * the part it hung off was itself dropped, transitively.
 *
 * A part with no inbound relationship at all is *not* unreachable: plenty are
 * found by convention or by another opaque part's `.rels`, and the absence of a
 * recorded edge is not evidence of absent reachability.
 *
 * @param parts             Preserved parts, as assembled on read.
 * @param emittedInbound    Inbound relationships this write will actually emit,
 *                          each with the part that will declare it.
 */
export function resolveReachableOpaqueParts(
  parts: readonly OpaquePart[],
  emittedInbound: readonly OpaqueSourceRelationship[]
): { parts: readonly OpaquePart[]; drops: readonly OpaqueDrop[] } {
  const known = new Map(parts.map(part => [part.path.toLowerCase(), part]));
  const reachable = new Set<string>();

  // Seed: parts with no recorded inbound edge, plus the targets of the edges this
  // write emits.
  for (const part of parts) {
    if (!part.sourceRelationships || part.sourceRelationships.length === 0) {
      reachable.add(part.path.toLowerCase());
    }
  }
  for (const inbound of emittedInbound) {
    const target = resolveRelationshipTarget(inbound.source, inbound.target, inbound.targetMode);
    if (target && known.has(target.toLowerCase())) {
      reachable.add(target.toLowerCase());
    }
  }

  // Fixpoint over opaque-to-opaque edges: a part reached from a reachable part is
  // itself reachable, and a chain hanging off a dropped part collapses entirely.
  const queue = [...reachable];
  while (queue.length > 0) {
    const part = known.get(queue.pop()!);
    for (const relationship of part?.relationships ?? []) {
      const target = resolveRelationshipTarget(
        part!.path,
        relationship.target,
        relationship.targetMode
      );
      const key = target?.toLowerCase();
      if (key && known.has(key) && !reachable.has(key)) {
        reachable.add(key);
        queue.push(key);
      }
    }
  }

  const excluded = new Set<string>();
  const drops: OpaqueDrop[] = [];
  for (const part of parts) {
    const key = part.path.toLowerCase();
    if (!reachable.has(key)) {
      excluded.add(key);
      drops.push({
        path: part.path,
        reason: "unreachable",
        description: "no relationship in the written package would point at it"
      });
    }
  }

  // Prune only edges to paths deliberately excluded. A target that is a modelled
  // part, an external URL, or something this writer knows nothing about is left
  // exactly as it was — the goal is to avoid dangling references, not to audit
  // every relationship an opaque part carries.
  const kept = parts
    .filter(part => reachable.has(part.path.toLowerCase()))
    .map(part => {
      const relationships = (part.relationships ?? []).filter(relationship => {
        const target = resolveRelationshipTarget(
          part.path,
          relationship.target,
          relationship.targetMode
        );
        return !target || !excluded.has(target.toLowerCase());
      });
      return relationships.length === (part.relationships?.length ?? 0)
        ? part
        : { ...part, relationships: relationships.length > 0 ? relationships : undefined };
    });

  return { parts: kept, drops };
}
