/**
 * `BErr` — the one-byte error code a cell or a cached formula result carries.
 *
 * MS-XLSB 2.5.98.2 gives eight values and this file is the only place they appear, because a second copy is
 * how a reader and a writer come to disagree about which byte means `#REF!`.
 *
 * ## Why this exists now and did not before
 *
 * Both directions used to give up here, and both gave the same reason: "no workbook in the reference corpus
 * contains a single `BrtCellError` or `BrtFmlaError` — so the byte's meaning is unobserved, and inventing it
 * is how a reader comes to agree with this library's own writer and disagree with Excel." That was sound
 * against the nine-workbook corpus it was written for. The current corpus contains five, and every one of
 * them matches the specification's table:
 *
 * | Bytes Excel wrote | Meaning     | Where                             |
 * | ----------------- | ----------- | --------------------------------- |
 * | `0x07`            | `#DIV/0!`   | `BrtFmlaError`                    |
 * | `0x17`            | `#REF!`     | `BrtFmlaError`                    |
 * | `0x1D`            | `#NAME?`    | `BrtFmlaError` (twice)            |
 * | `0x2A`            | `#N/A`      | `BrtFmlaError`                    |
 *
 * Four of the eight are therefore observed rather than assumed, and the four that are not — `#NULL!`,
 * `#VALUE!`, `#NUM!` and `#GETTING_DATA` — sit in a table whose other half Excel has confirmed exactly. That
 * is a different situation from having no evidence at all, and it is what makes writing them defensible.
 */

/** Error text by `BErr` value, from MS-XLSB 2.5.98.2. */
const TEXT_BY_CODE = new Map<number, string>([
  [0x00, "#NULL!"],
  [0x07, "#DIV/0!"],
  [0x0f, "#VALUE!"],
  [0x17, "#REF!"],
  [0x1d, "#NAME?"],
  [0x24, "#NUM!"],
  [0x2a, "#N/A"],
  [0x2b, "#GETTING_DATA"]
]);

/** The inverse, built from the same table so the two cannot drift. */
const CODE_BY_TEXT = new Map([...TEXT_BY_CODE].map(([code, text]) => [text, code]));

/**
 * The error text for a `BErr` byte, or `undefined` when the byte is not one of the eight.
 *
 * An unknown byte is refused rather than guessed: a file carrying one is a file this reader does not
 * understand, and reporting it is more useful than inventing an error nobody wrote.
 */
export function errorTextOf(code: number): string | undefined {
  return TEXT_BY_CODE.get(code);
}

/**
 * The `BErr` byte for an error text, or `undefined` when the text is not one Excel has a code for.
 *
 * Case-insensitive on the text, because the model accepts whatever a caller typed. `#SPILL!`, `#CALC!` and
 * the other dynamic-array errors deliberately return `undefined`: they postdate `BErr` and have no byte, so a
 * cell carrying one is a reported loss rather than a silently substituted `#VALUE!`.
 */
export function errorCodeOf(text: string): number | undefined {
  return CODE_BY_TEXT.get(text.trim().toUpperCase());
}

/** Every error text this codec can express, for a message that has to list them. */
export function knownErrorTexts(): readonly string[] {
  return [...CODE_BY_TEXT.keys()];
}
