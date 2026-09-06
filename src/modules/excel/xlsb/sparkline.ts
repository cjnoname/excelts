/**
 * Sparklines: `BrtBeginSparklineGroups` and the records inside it.
 *
 * ```text
 * BrtBeginSparklineGroups        FRTHeader with nothing set
 *   BrtBeginSparklineGroup       FRTHeader + 16 flag bits + 8 BrtColors + 3 Xnums + isltype
 *     BrtBeginSparklines         FRTHeader
 *       BrtSparkline*            FRTHeader carrying one sqref and one formula
 *     BrtEndSparklines
 *   BrtEndSparklineGroup
 * BrtEndSparklineGroups
 * ```
 *
 * **Every one of these is a *future record*,** which is what makes them different from everything else in
 * this module. A future record begins with an `FRTHeader` — four flag bits saying which of four optional
 * blocks follow — and the blocks are where a sparkline's actual content lives: the cell it sits in is an
 * `FRTSqrefs`, and the data range it plots is an `FRTFormulas` holding a single `PtgArea3d`.
 *
 * That indirection is the reason this took a spec-reading pass of its own. It is also why the mechanism is
 * built here rather than inlined: `FRTHeader` is shared by dozens of records this module may yet write, so
 * `encodeFrtHeader` is the piece worth getting right once.
 *
 * The nesting to watch: **`FRTSqrefs` is a *count* of `FRTSqref`, and each `FRTSqref` contains an
 * `UncheckedSqRfX` which is itself a count of ranges.** Two levels of counting, and the specification
 * requires both to be 1 for a sparkline — `csqref` = 1 and `crfx` = 1 — with `rwFirst == rwLast` and
 * `colFirst == colLast`, because a sparkline occupies one cell.
 */
import {
  DEFAULT_SPARKLINE_COLORS,
  DEFAULT_SPARKLINE_EMPTY_CELLS,
  type SparklineColor
} from "@excel/core/sparkline";
import type { Color } from "@excel/types";
import { decodeCell, decodeRange, encodeCell } from "@excel/utils/address";
import { encodeRange, readRange, readWideString, type BiffRange } from "@excel/xlsb/binary";
import { encodeColor, readColor } from "@excel/xlsb/color";
import { decodePtg, encodePtg, type PtgContext } from "@excel/xlsb/formula/ptg";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import { parse } from "@formula/syntax/parser";
import { printAst } from "@formula/syntax/print";
import { tokenize } from "@formula/syntax/tokenizer";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** `isltype`: 0 line, 1 column, 2 stacked. */
const SPARKLINE_TYPE = ["line", "column", "stacked"] as const;

/** One sparkline: the cell it draws in, and the range it plots. */
export interface SheetSparkline {
  /**
   * The cell the sparkline occupies, as an `A1` reference.
   *
   * **The names are the model's**, and deliberately the model's only. This once declared `ref` and `sqref`,
   * which nothing produces: `Sparkline.add` stores `cellRef` and `dataRef`, so both reads were `undefined`,
   * `undefined.includes("!")` threw, and a `catch` turned that into a silently dropped sparkline — the group
   * went out with no members and Excel refused the sheet. Every test fixture agreed with the writer and neither
   * agreed with the model, which is why sixteen passing tests said nothing.
   *
   * Accepting both spellings was tried first and is worse: it keeps the ambiguity that caused the bug, and a
   * caller has no way to know which one the model will hand back. `SparklineItem` in `core/sparkline` is the
   * definition; this mirrors it exactly, both fields required.
   */
  readonly cellRef: string;
  /** The data range, as `A1:C1` — possibly sheet-qualified. */
  readonly dataRef: string;
}

/** A sparkline group, in the shape the model holds it. */
export interface SheetSparklineGroup {
  readonly type?: (typeof SPARKLINE_TYPE)[number];
  readonly sparklines: readonly SheetSparkline[];
  readonly markers?: boolean;
  readonly high?: boolean;
  readonly low?: boolean;
  readonly first?: boolean;
  readonly last?: boolean;
  readonly negative?: boolean;
  readonly displayXAxis?: boolean;
  readonly displayHidden?: boolean;
  readonly rightToLeft?: boolean;
  readonly displayEmptyCellsAs?: "zero" | "gap" | "span";
  readonly lineWeight?: number;
  /**
   * How the vertical axis bounds are chosen — `"individual"`, `"group"` or `"custom"`.
   *
   * **Absent means `"individual"`**, which is the format's default and the reason these had to be modelled
   * here: this writer previously read only `manualMax`/`manualMin` and set `fGroupAutoMax`/`fGroupAutoMin`
   * whenever no manual bound was given, so every ordinary sparkline group went out sharing one vertical axis
   * instead of each sparkline scaling to its own data. The two are visibly different charts.
   */
  readonly maxAxisType?: "individual" | "group" | "custom";
  readonly minAxisType?: "individual" | "group" | "custom";
  readonly manualMax?: number;
  readonly manualMin?: number;
  /**
   * The eight colours, in the model's own shape.
   *
   * **`SparklineColor`, not `Color`** — and the difference is one field name that meant every stated colour was
   * silently thrown away. The model spells an sRGB value `rgb`; the workbook-wide `Color` this file used to
   * declare spells it `argb`. `encodeColor` therefore found nothing it recognised and fell back to the
   * automatic palette entry, so `Sparkline.add(sheet, { lineColor: "FF638EC6" })` wrote an *unpainted* colour
   * to XLSB while writing the right one to XLSX.
   *
   * It survived because the declared type was a lie the compiler could not catch: `Partial<Color>` and
   * `SparklineColor` share `theme` and `tint`, so an object with only `rgb` is assignable to neither strictly
   * nor detectably. And it survived the round-trip tests because a colour read *back* out of a file arrives as
   * `argb` — so read-then-write worked, and only a freshly built model was affected. Excel's bytes are what
   * found it.
   */
  readonly colorSeries?: SparklineColor;
  readonly colorNegative?: SparklineColor;
  readonly colorAxis?: SparklineColor;
  readonly colorMarkers?: SparklineColor;
  readonly colorFirst?: SparklineColor;
  readonly colorLast?: SparklineColor;
  readonly colorHigh?: SparklineColor;
  readonly colorLow?: SparklineColor;
}

/**
 * The whole `BrtBeginSparklineGroups` collection, as records.
 *
 * Records rather than bytes, so the caller splices them into the sheet's own stream — a pre-framed blob
 * would have to be concatenated around the framing, and the first version of this returned one and was
 * pushed with a fabricated record id.
 *
 * An empty list when nothing can be written, so the caller reports the groups as lost and still writes
 * the sheet.
 */
export function sparklineRecords(
  groups: readonly SheetSparklineGroup[],
  context: PtgContext,
  sheetName: string
): readonly Emitted[] {
  const usable = groups.filter(group => group.sparklines.length > 0);
  if (usable.length === 0) {
    return [];
  }
  // Each group's members are encoded first, because **a group with no members is not writable**: Excel refuses
  // the sheet rather than showing an empty group, and that is what a silently dropped sparkline produced.
  const writable = usable
    .map(group => ({
      group,
      members: group.sparklines
        .map(sparkline => encodeSparkline(sparkline, context, sheetName))
        .filter((payload): payload is Uint8Array => payload !== undefined)
    }))
    .filter(entry => entry.members.length > 0);
  if (writable.length === 0) {
    return [];
  }
  // **The whole collection goes inside a future-record wrapper**, which is what Excel does and what this
  // omitted. Without it the sparkline records sit in the sheet's ordinary stream, where a reader that does not
  // know them has no way to step over them — `BrtFRTBegin`/`BrtFRTEnd` exists precisely so a newer feature can
  // be skipped safely, and the ids inside a wrapper are allowed to collide with ordinary ones.
  //
  // Note this library's own reader had to be taught to look inside (`iterateInterpretableRecords` withholds
  // wrapper contents on purpose), which is the other half of the same defect: writing outside the wrapper and
  // reading only outside it round-tripped perfectly and agreed with nothing else.
  const records: Emitted[] = [
    record("BrtFRTBegin", frtProductVersion()),
    // **Zero bytes, not an `FRTHeader`.** Excel gives the two collection-opening records empty payloads while
    // `BrtBeginSparklineGroup` does carry a header; four bytes were written for each of these.
    record("BrtBeginSparklineGroups")
  ];
  for (const { group, members } of writable) {
    records.push(
      record("BrtBeginSparklineGroup", encodeSparklineGroup(group)),
      record("BrtBeginSparklines")
    );
    for (const payload of members) {
      records.push(record("BrtSparkline", payload));
    }
    records.push(record("BrtEndSparklines"), record("BrtEndSparklineGroup"));
  }
  records.push(record("BrtEndSparklineGroups"), record("BrtFRTEnd"));
  return records;
}

/**
 * An `FRTHeader` — MS-XLSB 2.5.61.
 *
 * Four flag bits and then only the blocks they claim. A header with nothing set is four zero bytes, which
 * is what every one of the collection delimiters carries.
 */
function encodeFrtHeader(options: {
  readonly sqref?: string;
  readonly formula?: Uint8Array;
}): Uint8Array {
  let flags = 0;
  // `fRef` at bit 0 is unused here; `fSqref` at bit 1 and `fFormula` at bit 2 are the two a sparkline
  // needs, and `fRelID` at bit 3 names a part, which none of these records do.
  flags |= options.sqref === undefined ? 0 : 1 << 1;
  flags |= options.formula === undefined ? 0 : 1 << 2;
  const parts: Uint8Array[] = [new BinaryWriter().writeUint32(flags).toUint8Array()];
  if (options.sqref !== undefined) {
    parts.push(encodeFrtSqrefs(options.sqref));
  }
  if (options.formula !== undefined) {
    parts.push(encodeFrtFormulas(options.formula));
  }
  return concatUint8Arrays(parts);
}

/**
 * `BrtFRTBegin`'s payload: an `FRTProductVersion` (MS-XLSB 2.5.62) — a `u16` version then a 15-bit product id.
 *
 * **Nothing validates it.** Across the pinned corpus and every Excel-authored reference here the field takes
 * six distinct values (versions 3586, 3843, 4352, 4355 and a `product` of 2 from a non-Excel writer), which is
 * why the oracle already treats `BrtFRTBegin` as a benign difference. It is a stamp saying who wrote the block.
 *
 * `product` is left 0 and the version is this library's own rather than a copy of an Excel build number: a
 * borrowed build number is a claim about which Excel wrote the file, and the field is free.
 */
function frtProductVersion(): Uint8Array {
  return new BinaryWriter().writeUint16(FRT_VERSION).writeUint16(0).toUint8Array();
}

/** This library's future-record version stamp. Any value is legal; see `frtProductVersion`. */
const FRT_VERSION = 1;

/**
 * `FRTSqrefs` → one `FRTSqref` → one `UncheckedSqRfX` → one range.
 *
 * Two counts, both 1: `csqref` and `crfx`. The specification requires exactly that for a sparkline, and
 * the reason is that a sparkline occupies a single cell — so `rwFirst == rwLast` and
 * `colFirst == colLast` as well.
 */
function encodeFrtSqrefs(reference: string): Uint8Array {
  const cell = decodeCell(reference);
  const range: BiffRange = {
    firstRow: cell.r,
    lastRow: cell.r,
    firstColumn: cell.c,
    lastColumn: cell.c
  };
  return concatUint8Arrays([
    // `csqref`, then the single `FRTSqref`: its own flag word — `fDoAdjust` MUST be 1 — then `crfx` and the
    // `UncheckedSqRfX`.
    //
    // **There is no `reserved` word between the flags and `crfx`.** One was written here, and Excel's own
    // record shows the flags followed immediately by `crfx`. The consequence was invisible from inside: the
    // extra word pushed `crfx` where the range's first row goes, so Excel read *zero* ranges and then took
    // every following field from the wrong offset — while this library's own reader, mirroring the same
    // layout, round-tripped it perfectly. It even passed a length check, because the missing `cb` below is
    // also four bytes and the two errors cancelled: 63 bytes either way. Two wrongs summing to the right
    // total is the least detectable shape a binary defect can have.
    new BinaryWriter()
      .writeUint32(1)
      .writeUint32(1 << 1)
      .writeInt32(1)
      .toUint8Array(),
    encodeRange(range)
  ]);
}

/** `FRTFormulas` → one `FRTFormula` → an `FRTParsedFormula`. */
function encodeFrtFormulas(tokens: Uint8Array): Uint8Array {
  return concatUint8Arrays([
    // `cformula`, the `FRTFormula` flag word whose bit 1 MUST be 1, then **both lengths before either blob**:
    // `cce`, then `cb` for the ancillary `rgcb`, then the tokens.
    //
    // `cb` was missing. Note the ordering, which differs from `CellParsedFormula` (`cce, rgce, cb, rgcb`) —
    // Excel's record puts `cb` immediately after `cce` and before the token stream, and reading it the other
    // way makes the first four bytes of a formula look like a length.
    new BinaryWriter()
      .writeUint32(1)
      .writeUint32(1 << 1)
      .writeUint32(tokens.length)
      .writeUint32(0)
      .toUint8Array(),
    tokens
  ]);
}

/** `BrtSparkline`: an `FRTHeader` carrying the cell and the data range, and nothing else. */
function encodeSparkline(
  sparkline: SheetSparkline,
  context: PtgContext,
  sheetName: string
): Uint8Array | undefined {
  const { cellRef: cell, dataRef: data } = sparkline;
  try {
    // The formula MUST be a single `PtgArea3d` (or `PtgRef3d`), which is what a *sheet-qualified* range
    // parses to. An unqualified `A1:C1` becomes a plain `PtgArea` and is not a form this record accepts,
    // so the sheet name is added when the model leaves it off.
    const qualified = data.includes("!") ? data : `'${sheetName.replace(/'/g, "''")}'!${data}`;
    const tokens = encodePtg(parse(tokenize(qualified)), context, `sparkline ${cell}`);
    return encodeFrtHeader({ sqref: cell, formula: tokens });
  } catch {
    return undefined;
  }
}

/** `BrtBeginSparklineGroup` — MS-XLSB 2.4.228. */
function encodeSparklineGroup(group: SheetSparklineGroup): Uint8Array {
  let flags = 0;
  // Bit 0 is `fDateAxis`, which needs a date range in the header — not modelled, so it stays 0.
  // Bits 1–2 are `fShowEmptyCellAsZero`, a two-bit *enumeration* rather than a flag: 0 zero, 1 gap,
  // 2 interpolated. Treating it as one bit would turn "span" into "gap".
  // Defaulted through the shared constant, not to 0: Excel's default is `gap` and the schema's is `zero`, so
  // falling through to 0 drew a break in the data as a column of height zero.
  const shown = group.displayEmptyCellsAs ?? DEFAULT_SPARKLINE_EMPTY_CELLS;
  const empty = shown === "gap" ? 1 : shown === "span" ? 2 : 0;
  flags |= (empty & 0x03) << 1;
  flags |= group.markers === true ? 1 << 3 : 0;
  flags |= group.high === true ? 1 << 4 : 0;
  flags |= group.low === true ? 1 << 5 : 0;
  flags |= group.first === true ? 1 << 6 : 0;
  flags |= group.last === true ? 1 << 7 : 0;
  flags |= group.negative === true ? 1 << 8 : 0;
  flags |= group.displayXAxis === true ? 1 << 9 : 0;
  flags |= group.displayHidden === true ? 1 << 10 : 0;
  // **Bits 11–14 are two *pairs*, and choosing the wrong one of a pair is a different chart.**
  // 11 `fIndividualAutoMax`, 12 `fIndividualAutoMin`, 13 `fGroupAutoMax`, 14 `fGroupAutoMin`; the individual
  // and group members of each pair are mutually exclusive, and the matching `Xnum` MUST be 0 when either is
  // set. This used to set the *group* bit whenever no manual bound was given, so a group whose axis type was
  // absent — the common case, and `"individual"` by default in both this model and the XML — was written as
  // sharing one vertical axis across every sparkline in it.
  flags |= axisFlag(axisTypeOf(group.maxAxisType, group.manualMax), 11, 13);
  flags |= axisFlag(axisTypeOf(group.minAxisType, group.manualMin), 12, 14);
  flags |= group.rightToLeft === true ? 1 << 15 : 0;

  return concatUint8Arrays([
    encodeFrtHeader({}),
    // **Two bytes.** MS-XLSB 2.4.228 gives this record fifteen flag bits in a `u16`; it was written as a `u32`,
    // which pushed all eight colours and the three `Xnum`s two bytes along and made the record 100 bytes where
    // the field list sums to 98. Excel answered `Replaced Part` — it could not parse the sheet at all, which is
    // the failure a wrong length produces rather than the repair a wrong value does.
    new BinaryWriter().writeUint16(flags).toUint8Array(),
    // Eight colours, in the record's order. **`xColorType` MUST NOT be 0 for any of them**, and the automatic
    // colour *is* type 0 — the comment here used to claim `encodeColor(undefined)` satisfied the rule "because
    // it writes the automatic colour rather than zeros", which confuses "the bytes are not all zero" with "the
    // type is not zero". `sparklineColor` supplies a palette-indexed automatic instead: a non-zero type whose
    // meaning is still "the application chooses".
    // Each falls back to what Excel writes rather than to "automatic": an automatic colour satisfies the
    // record's `xColorType != 0` rule and still paints nothing, which is the same defect the XML had as an
    // absent element. Same policy, one definition — see `DEFAULT_SPARKLINE_COLORS`.
    sparklineColor(group.colorSeries, "colorSeries"),
    sparklineColor(group.colorNegative, "colorNegative"),
    sparklineColor(group.colorAxis, "colorAxis"),
    sparklineColor(group.colorMarkers, "colorMarkers"),
    sparklineColor(group.colorFirst, "colorFirst"),
    sparklineColor(group.colorLast, "colorLast"),
    sparklineColor(group.colorHigh, "colorHigh"),
    sparklineColor(group.colorLow, "colorLow"),
    new BinaryWriter()
      // Both MUST be 0 unless the matching axis is `"custom"`, which is the only case in which neither
      // automatic flag is set — so the flags and these two cannot contradict each other.
      .writeFloat64(
        axisTypeOf(group.maxAxisType, group.manualMax) === "custom" ? (group.manualMax ?? 0) : 0
      )
      .writeFloat64(
        axisTypeOf(group.minAxisType, group.manualMin) === "custom" ? (group.manualMin ?? 0) : 0
      )
      // Bounded at 0–1584 points by the specification. Excel's default is 0.75.
      .writeFloat64(Math.max(0, Math.min(1584, group.lineWeight ?? 0.75)))
      .writeUint32(Math.max(0, SPARKLINE_TYPE.indexOf(group.type ?? "line")))
      .toUint8Array()
  ]);
}

/**
 * Which of the three axis modes a group means.
 *
 * A stated type wins. Otherwise a manual bound implies `"custom"` — a caller who sets `manualMax` and nothing
 * else means it to be used — and with neither it is `"individual"`, the default in both this model and the XML.
 */
function axisTypeOf(
  stated: SheetSparklineGroup["maxAxisType"],
  manual: number | undefined
): "individual" | "group" | "custom" {
  return stated ?? (manual === undefined ? "individual" : "custom");
}

/** The bit for an axis mode: the individual one, the group one, or neither for a manual bound. */
function axisFlag(
  type: "individual" | "group" | "custom",
  individualBit: number,
  groupBit: number
): number {
  if (type === "individual") {
    return 1 << individualBit;
  }
  return type === "group" ? 1 << groupBit : 0;
}

/** Whether a reference decodes, so a group with a broken one can be reported rather than written. */
export function isUsableSparkline(sparkline: SheetSparkline): boolean {
  const { cellRef: cell, dataRef: data } = sparkline;
  try {
    decodeCell(cell);
    decodeRange(data.includes("!") ? (data.split("!")[1] ?? data) : data);
    return true;
  } catch {
    return false;
  }
}

/**
 * One of a sparkline group's eight colours, falling back to what Excel writes for it.
 *
 * `BrtBeginSparklineGroup` requires `xColorType != 0` on every one, so an unstated colour cannot be written as
 * the *automatic* type — that is type 0. The first fix here substituted palette index 64, which satisfies the
 * rule and is still "the application chooses", and the application chooses to draw nothing. Excel's own record
 * carries concrete sRGB for all eight, so that is what an unstated colour becomes.
 */
function sparklineColor(
  color: SparklineColor | undefined,
  field: keyof typeof DEFAULT_SPARKLINE_COLORS
): Uint8Array {
  return encodeColor(toWorkbookColor(color ?? DEFAULT_SPARKLINE_COLORS[field]));
}

/**
 * A sparkline colour in the shape `encodeColor` reads.
 *
 * The one place the two spellings meet. `rgb` → `argb` was previously done for the default only, which is why
 * a stated colour reached the encoder unrecognised and came out automatic.
 */
function toWorkbookColor(color: SparklineColor): Partial<Color> {
  return {
    ...(color.rgb === undefined ? {} : { argb: color.rgb }),
    ...(color.theme === undefined ? {} : { theme: color.theme }),
    ...(color.tint === undefined ? {} : { tint: color.tint })
  };
}

/** The legacy palette's "automatic" slot, which `xColorType` 1 may point at where type 0 is forbidden. */
const AUTOMATIC_PALETTE_INDEX = 64;

/**
 * Read `BrtBeginSparklineGroup` back into the model's shape.
 *
 * **The inverse of `encodeSparklineGroup`, and written against it rather than beside it.** Until this existed
 * an XLSB round trip lost every sparkline: the group was written correctly, `Workbook.read` produced a model
 * with no `sparklineGroups`, and the *second* write therefore emitted nothing and reported no loss — from the
 * writer's point of view the model it was handed genuinely had none. `read-write-symmetry.test.ts` listed
 * sparklines under `LOSES_ON_READ` for exactly that reason.
 *
 * The two automatic-bound flags are the subtlety. `fGroupAutoMax`/`fGroupAutoMin` are set when no manual bound
 * was given, and the specification requires the matching `Xnum` to be 0 then — so a reader that returns the
 * number unconditionally turns "scale automatically" into "scale to 0", which is a visibly wrong chart. The
 * bound is therefore reported only when its automatic flag is clear.
 */
export function readSparklineGroup(
  payload: Uint8Array,
  part: string
): SheetSparklineGroup | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    // The `FRTHeader`, which for this record has no optional block set. Consumed by reading it, so a file that
    // does carry one does not shift every field after it.
    skipFrtHeader(reader, part);
    const flags = reader.readUint16();
    const colors = Array.from({ length: 8 }, () => readColor(reader));
    const manualMax = reader.readFloat64();
    const manualMin = reader.readFloat64();
    const lineWeight = reader.readFloat64();
    const type = SPARKLINE_TYPE[reader.readUint32()];
    const empty = (flags >> 1) & 0x03;
    // Assembled imperatively. Spreading one conditional object per field produced a union TypeScript could
    // not represent, and a builder reads closer to the encoder it mirrors anyway.
    const group: Mutable<SheetSparklineGroup> = { sparklines: [], lineWeight };
    if (type !== undefined) {
      group.type = type;
    }
    if (empty !== 0) {
      group.displayEmptyCellsAs = empty === 1 ? "gap" : "span";
    }
    for (const [index, name] of BOOLEAN_FLAGS) {
      if (((flags >> index) & 1) === 1) {
        group[name] = true;
      }
    }
    // **The axis pairs, and the bound only when neither automatic bit is set.** With one of them set the
    // specification requires the `Xnum` to be 0, so returning it unconditionally would turn "scale
    // automatically" into "scale to 0" — a visibly wrong chart. `"individual"` is reported as absent because
    // it is the default, which keeps a round trip returning the shape it started with.
    const maxType = axisTypeFromFlags(flags, 11, 13);
    const minType = axisTypeFromFlags(flags, 12, 14);
    if (maxType !== "individual") {
      group.maxAxisType = maxType;
    }
    if (minType !== "individual") {
      group.minAxisType = minType;
    }
    if (maxType === "custom") {
      group.manualMax = manualMax;
    }
    if (minType === "custom") {
      group.manualMin = manualMin;
    }
    for (const [index, name] of COLOR_FIELDS) {
      const color = colors[index];
      if (color !== undefined && !isAutomaticColor(color)) {
        // Back into the model's spelling. Storing `readColor`'s `argb` form worked by accident — it is what the
        // encoder wanted — but it put a shape in the model that `Sparkline.list` and the XLSX renderer do not
        // read, so a colour read from XLSB was invisible to every other consumer.
        group[name] = fromWorkbookColor(color);
      }
    }
    return group;
  } catch {
    // A truncated group costs the group, not the sheet.
    return undefined;
  }
}

/** The group's boolean flags, by bit position — the same order `encodeSparklineGroup` sets them. */
const BOOLEAN_FLAGS = [
  [3, "markers"],
  [4, "high"],
  [5, "low"],
  [6, "first"],
  [7, "last"],
  [8, "negative"],
  [9, "displayXAxis"],
  [10, "displayHidden"],
  [15, "rightToLeft"]
] as const satisfies readonly (readonly [number, keyof SheetSparklineGroup])[];

/** The eight colours, in the record's order. */
const COLOR_FIELDS = [
  [0, "colorSeries"],
  [1, "colorNegative"],
  [2, "colorAxis"],
  [3, "colorMarkers"],
  [4, "colorFirst"],
  [5, "colorLast"],
  [6, "colorHigh"],
  [7, "colorLow"]
] as const satisfies readonly (readonly [number, keyof SheetSparklineGroup])[];

/** The inverse of `toWorkbookColor`: a decoded colour in the shape the model holds. */
function fromWorkbookColor(color: Partial<Color>): SparklineColor {
  return {
    ...(color.argb === undefined ? {} : { rgb: color.argb }),
    ...(color.theme === undefined ? {} : { theme: color.theme }),
    ...(color.tint === undefined ? {} : { tint: color.tint })
  };
}

/** The inverse of `axisFlag`: which mode a pair of bits names. */
function axisTypeFromFlags(
  flags: number,
  individualBit: number,
  groupBit: number
): "individual" | "group" | "custom" {
  if (((flags >> individualBit) & 1) === 1) {
    return "individual";
  }
  return ((flags >> groupBit) & 1) === 1 ? "group" : "custom";
}

/** Drop the `readonly` so the reader can assemble a group field by field. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Read one `BrtSparkline` — the cell it draws in and the range it plots.
 *
 * Both live in the `FRTHeader`'s optional blocks rather than in a fixed part, so this walks the same two
 * structures `encodeFrtHeader` writes: an `FRTSqrefs` holding one single-cell range, and an `FRTFormulas`
 * holding one `PtgArea3d`.
 */
export function readSparkline(
  payload: Uint8Array,
  part: string,
  context: PtgContext
): SheetSparkline | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    const flags = reader.readUint32();
    let cellRef: string | undefined;
    let dataRef: string | undefined;
    if (((flags >> 1) & 1) === 1) {
      cellRef = readFrtSqrefs(reader);
    }
    if (((flags >> 2) & 1) === 1) {
      dataRef = readFrtFormulas(reader, part, context);
    }
    // Both are required by the model's shape, and a sparkline missing either draws nothing — so an
    // incomplete record is dropped rather than completed with a guess.
    return cellRef === undefined || dataRef === undefined ? undefined : { cellRef, dataRef };
  } catch {
    return undefined;
  }
}

/** The single cell an `FRTSqrefs` block names, as `A1`. */
function readFrtSqrefs(reader: BinaryReader): string {
  reader.readUint32(); // csqref, which MUST be 1
  reader.readUint32(); // the FRTSqref flag word
  reader.readInt32(); // crfx, which MUST be 1 — no reserved word precedes it; see `encodeFrtSqrefs`
  const range = readRange(reader);
  // `rwFirst == rwLast` and `colFirst == colLast` for a sparkline, so the first corner is the cell.
  return encodeCell({ r: range.firstRow, c: range.firstColumn });
}

/** The data range an `FRTFormulas` block holds, printed back to text. */
function readFrtFormulas(
  reader: BinaryReader,
  part: string,
  context: PtgContext
): string | undefined {
  reader.readUint32(); // cformula, which MUST be 1
  reader.readUint32(); // the FRTFormula flag word
  const cce = reader.readUint32();
  reader.readUint32(); // `cb`, the ancillary block's length — it precedes the tokens; see `encodeFrtFormulas`
  const tokens = reader.readBytes(cce);
  const decoded = decodePtg(tokens, context, `${part} sparkline data`);
  // `FRTParsedFormula` cannot carry `PtgExp`, so a shared-formula reference here is a malformed record.
  return "sharedRow" in decoded ? undefined : printAst(decoded);
}

/**
 * Consume an `FRTHeader` whose optional blocks this record does not use.
 *
 * Read rather than skipped by a fixed four bytes: the flag word says which blocks follow, and a file that
 * carries one would otherwise shift every field after it.
 */
function skipFrtHeader(reader: BinaryReader, part: string): void {
  const flags = reader.readUint32();
  if (((flags >> 1) & 1) === 1) {
    readFrtSqrefs(reader);
  }
  if (((flags >> 2) & 1) === 1) {
    reader.readUint32(); // cformula
    reader.readUint32(); // flags
    const cce = reader.readUint32();
    reader.readUint32(); // cb
    reader.readBytes(cce);
  }
  if (((flags >> 3) & 1) === 1) {
    readWideString(reader, part); // fRelID: a relationship id
  }
}

/**
 * Whether a colour is the automatic default this writer emits for an unstated one.
 *
 * `readColor` always yields something, so all eight come back — and reporting all eight would turn a group
 * that stated no colours into one stating eight. Palette index 64 is exactly what `sparklineColor` writes for
 * an unstated colour, so recognising it keeps **both** round trips stable: the model returns to the shape it
 * had, and the bytes are unchanged because an absent colour re-encodes to that same palette entry.
 */
function isAutomaticColor(color: Partial<Color>): boolean {
  return (
    color.indexed === AUTOMATIC_PALETTE_INDEX &&
    color.argb === undefined &&
    color.theme === undefined
  );
}
