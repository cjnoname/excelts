/**
 * Frozen and split panes: `BrtPane`.
 *
 * **Everything here is read off Excel's own bytes**, from an XLSB Excel produced by saving a workbook this
 * library wrote as XLSX. That matters because two of the three facts below contradict `[MS-XLSB]`, and this
 * record was wrong for as long as the specification was the only source.
 *
 * **The axes are *not* crossed.** MS-XLSB 2.4.723 says `xnumXSplit` — the first field — "specifies the number
 * of rows in the frozen panes and MUST be less than the maximum value of `Rw`". Excel writes the number of
 * **columns** there. Freezing one row gives `xnumXSplit = 0, xnumYSplit = 1`; freezing one column gives the
 * reverse; freezing two columns and one row gives `2` and `1`. So the mapping is direct:
 *
 * ```text
 * BrtPane.xnumXSplit  ↔  columns  ↔  model xSplit
 * BrtPane.xnumYSplit  ↔  rows     ↔  model ySplit
 * ```
 *
 * This file used to name its fields `rows` and `columns` to make a crossover visible. There is no crossover,
 * and the renaming was what let a plainly wrong reading survive: the argument for it — "a horizontal line
 * divides rows" — is a good argument that happens to be about a document, not about Excel.
 *
 * **`fFrozen` and `fFrozenNoSplit` are both set.** The specification makes them mutually exclusive with a MUST
 * on each ("This value MUST NOT be 1 if …"), and Excel writes `0x03` for every frozen pane it produces. A
 * split pane gets `0x00`. So the pair is not two alternatives but one two-bit value, whatever the prose says.
 *
 * **The fields change unit with the pane state.** They are `Xnum` — float64 — holding a position *in twips*
 * for a split pane and a *count* for a frozen one. XLSX carries the identical duality on the identical
 * attributes, so the model's number passes through unchanged either way. What does not pass through is the
 * validation: clamping a twip position to 1,048,575 rows, or truncating it to an integer, applies a row rule
 * to something that is not a row count.
 */
import { XLSB_MAX_COLUMNS, XLSB_MAX_ROWS } from "@excel/xlsb/binary";
import { BinaryReader, BinaryWriter } from "@utils/binary";

/** `Pnn`, MS-XLSB 2.5.108: which pane Excel puts the cursor in. */
export const PANE = { bottomRight: 0, topRight: 1, bottomLeft: 2, topLeft: 3 } as const;

/**
 * `fFrozen` and `fFrozenNoSplit` — MS-XLSB 2.4.755, bits 0 and 1 of the trailing flag byte.
 *
 * The specification makes them mutually exclusive with a MUST, so writing the wrong one is not a shade of
 * meaning but a different pane arrangement. `fFrozenNoSplit` is the plain "freeze panes" a person asks for;
 * `fFrozen` claims the panes are frozen *and* split.
 *
 * Excel sets **both**, which its own specification forbids. Verified against a file Excel wrote; see the note
 * at the top of this module.
 */
const FROZEN = 0x01;
const FROZEN_NO_SPLIT = 0x02;

/** The pane arrangement a sheet view describes. */
export interface SheetPane {
  /**
   * Frozen rather than split. This decides what `rows` and `columns` *mean*, so it is not a hint: a
   * frozen pane counts rows and columns, a split pane measures twips.
   */
  readonly frozen: boolean;
  /** Rows above the split — a count when frozen, a twip position when split. `BrtPane.xnumYSplit`. */
  readonly rows: number;
  /** Columns left of the split — a count when frozen, a twip position when split. `BrtPane.xnumXSplit`. */
  readonly columns: number;
  /** First visible cell of the bottom-right pane, zero-based. Always an index, in both states. */
  readonly topRow: number;
  readonly leftColumn: number;
  readonly activePane: keyof typeof PANE;
}

/** One `BrtSel`'s worth of information: the pane it belongs to and that pane's active cell. */
export interface PaneSelection {
  /** `Pnn`. */
  readonly pane: number;
  readonly row: number;
  readonly column: number;
}

/**
 * The selections a view needs: **one per pane the split creates**, always including the top-left.
 *
 * Verified against Excel's own output: a frozen row gives two (`PNNTOPLEFT`, `PNNBOTLEFT`), a frozen column
 * gives two (`PNNTOPLEFT`, `PNNTOPRIGHT`), and freezing or splitting both ways gives four. This rule spent a
 * while marked "not demonstrated" after a probe was misread — it is demonstrated.
 *
 * The asymmetry with XLSX is why reading the XML form never suggested it: there a `<selection>` with no `pane`
 * attribute *is* the top-left one, so Excel writes a single element for a frozen top row and the implicit
 * top-left selection never appears. `Pnn` has no "unspecified" value, so what is implicit there is written
 * here.
 */
export function paneSelections(pane: SheetPane): PaneSelection[] {
  const rows = Math.max(0, Math.trunc(pane.rows));
  const columns = Math.max(0, Math.trunc(pane.columns));
  // A split measured in twips does not say which row or column it falls on, so the panes past it start at
  // the first visible cell of the bottom-right pane instead — the one field that is an index in both states.
  const row = pane.frozen ? rows : Math.max(0, Math.trunc(pane.topRow));
  const column = pane.frozen ? columns : Math.max(0, Math.trunc(pane.leftColumn));

  // **A frozen pane's selections all sit at A1; a *split* pane's `PNNTOPLEFT` sits at `topLeftCell`.**
  //
  // Excel writes `rwAct = colAct = 0` for every pane of a frozen view, including the panes that begin further down or
  // across — a pane's active cell is not required to be inside it, and computing each pane's own first cell from the
  // split is a tidier idea that Excel does not follow. That much was already established here.
  //
  // The split case is the exception, and the comment used to note it as unmodelled. Across the four sheets of the
  // oracle's `01-panes`: three are frozen (`BrtPane.state` ends 227) and write `r0c0` for every pane; the fourth is
  // split (state ends 224) and writes `r3c2` for `PNNTOPLEFT` — exactly its own `topLeftCell` — while its other three
  // panes stay at A1. So the rule is one selection's active cell, conditional on the split, and it is now written.
  // **The pane that carries it is `bottomRight`, whose `PANE` value is 0 — not `topLeft`, whose value is 3.**
  //
  // Excel's fourth `BrtSel` on the split sheet has `pane = 0` and the active cell, and 0 is `PNNBOTRIGHT` in this
  // enumeration: the names run in the opposite order to the numbers (`bottomRight: 0 … topLeft: 3`). Attaching the
  // active cell to `PANE.topLeft` on the strength of the name put it on the *first* record instead of the last, which
  // read as a fix and moved the difference rather than removing it.
  const activeSelection = pane.frozen ? { row: 0, column: 0 } : { row, column };
  const selections: PaneSelection[] = [{ pane: PANE.topLeft, row: 0, column: 0 }];
  if (columns > 0) {
    selections.push({ pane: PANE.topRight, row: 0, column: 0 });
  }
  if (rows > 0) {
    selections.push({ pane: PANE.bottomLeft, row: 0, column: 0 });
  }
  if (rows > 0 && columns > 0) {
    selections.push({ pane: PANE.bottomRight, ...activeSelection });
  }
  return selections;
}

/** Serialise a `BrtPane`. Twenty-nine bytes. */
export function encodePane(pane: SheetPane): Uint8Array {
  return (
    new BinaryWriter()
      // **Columns first.** The specification says rows; Excel writes columns. See the note at the top.
      .writeFloat64(splitValue(pane.columns, pane.frozen, XLSB_MAX_COLUMNS))
      .writeFloat64(splitValue(pane.rows, pane.frozen, XLSB_MAX_ROWS))
      .writeUint32(clampIndex(pane.topRow, XLSB_MAX_ROWS))
      .writeUint32(clampIndex(pane.leftColumn, XLSB_MAX_COLUMNS))
      .writeUint32(PANE[pane.activePane])
      // Both bits, which the specification forbids and Excel does anyway — see the note at the top. Writing
      // only `fFrozenNoSplit`, the reading its name invites, was part of why Excel repaired every frozen view
      // this library produced.
      .writeUint8(pane.frozen ? FROZEN | FROZEN_NO_SPLIT : 0)
      .toUint8Array()
  );
}

/** Read a `BrtPane`, or `undefined` when the payload is short. */
export function readPane(payload: Uint8Array, part: string): SheetPane | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    // Columns first, then rows — see the note at the top. Both this reader and the writer had it the other way
    // round, so they agreed with each other and a round trip could not see it.
    const columns = reader.readFloat64();
    const rows = reader.readFloat64();
    const topRow = reader.readUint32();
    const leftColumn = reader.readUint32();
    const active = reader.readUint32();
    const flags = reader.readUint8();
    const frozen = (flags & (FROZEN | FROZEN_NO_SPLIT)) !== 0;
    return {
      frozen,
      // Truncated only when the value is a count. A split pane's twip position is a genuine `Xnum` and
      // rounding it moves the split line.
      rows: frozen ? Math.trunc(rows) : rows,
      columns: frozen ? Math.trunc(columns) : columns,
      topRow,
      leftColumn,
      activePane: paneName(active)
    };
  } catch {
    // A truncated record costs the pane, not the sheet.
    return undefined;
  }
}

/**
 * A split value in the unit the pane state implies.
 *
 * The row and column maxima are the specification's bound on a frozen pane's *count*. They are not
 * applied to a split pane, where the number is a twip position and the bound would be meaningless.
 */
function splitValue(value: number, frozen: boolean, limit: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return frozen ? Math.min(Math.trunc(value), limit - 1) : value;
}

function clampIndex(value: number, limit: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(Math.trunc(value), limit - 1)) : 0;
}

function paneName(value: number): keyof typeof PANE {
  for (const [name, id] of Object.entries(PANE)) {
    if (id === value) {
      return name as keyof typeof PANE;
    }
  }
  return "topLeft";
}
