/**
 * The reference corpus, pinned so anyone can reproduce it.
 *
 * **Why this list exists at all.** Every layout claim in this module is an assertion about what Excel
 * writes, and until now the files those assertions were read off lived in a temporary directory on one
 * machine, reachable only through `DOCUMONSTER_XLSB_CORPUS_DIR`. That is not a corpus, it is a private
 * note: nobody else could confirm a single offset, and nobody could tell whether a later run used the
 * same bytes. Pinning the revision and the digest turns "read off Excel's output" from a claim into a
 * procedure.
 *
 * **Why they are downloaded rather than committed.** They are other projects' test fixtures. Their
 * licensing is not ours to assume and 283 KiB of third-party binaries does not belong in the published
 * package, so `pnpm corpus:xlsb` fetches them into the gitignored `tmp/` cache and verifies each digest.
 * The gate that uses them skips when the cache is absent, so a contributor who has not fetched it is
 * never blocked — but a contributor who has gets the same bytes this module was written against.
 *
 * **Why two upstreams.** Calamine's fixtures are Excel's own output across locales and date systems,
 * which is what establishes record layouts. Apache POI's carry features Calamine's do not — hyperlinks,
 * comments, a workbook of assorted odds and ends — which is what shows whether a layout read from one
 * file generalises. Two independent collections disagreeing about a field is a fact worth having.
 *
 * A digest mismatch is a hard failure, not a warning. Upstream is free to change a fixture; this module
 * is not free to keep asserting the old bytes while reading the new ones.
 */

/**
 * How much authority a fixture has over a layout claim.
 *
 * `excel` files are Excel's own output and are what establishes a record's shape. `reduced` files were
 * hand-trimmed for a bug report — they read correctly and legitimately omit records every real workbook
 * has, so they must not be held to the conformance checks. `nonconformant` files were written by Excel
 * and contradict the specification: `poi-Simple.xlsb` says "Microsoft Excel 2007 Beta 2" in its own
 * document properties, writes `iTabID` as 0 where the spec says the value MUST be between 1 and 0xFFFF,
 * and puts four integers before the strings in a `BrtBundleSh` that has room for two.
 *
 * The distinction is load-bearing rather than descriptive. Without it a beta's mistake becomes evidence
 * about the format, and the temptation is to widen a codec to accept it — which is how a reader comes to
 * accept two layouts and write a third. These files are kept precisely because reading them *without*
 * treating them as authoritative is the behaviour worth testing.
 */
export type CorpusAuthority = "excel" | "reduced" | "nonconformant" | "encrypted";

/** One pinned fixture. */
export interface CorpusEntry {
  /** Local filename in the cache, prefixed by its origin so the two collections cannot collide. */
  readonly name: string;
  readonly origin: "calamine" | "poi";
  readonly authority: CorpusAuthority;
  /** Raw URL, pinned to a commit rather than a branch. */
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Two of these are not readable, on purpose.
 *
 * `cal-pass_protected.xlsb` and `poi-protected_passtika.xlsb` are OLE-wrapped encrypted workbooks — not
 * ZIP packages at all. They are pinned because "this reader refuses an encrypted file rather than
 * mangling it" is a claim worth testing, and because a corpus that contained only files that work would
 * not be a corpus of what people actually have.
 */
export const XLSB_CORPUS: readonly CorpusEntry[] = [
  {
    name: "cal-any_sheets.xlsb",
    origin: "calamine",
    authority: "excel",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/any_sheets.xlsb",
    sha256: "ad645571475f1e30875610fc51ad7726d8b7af296850135bc593e15ead0e28c6",
    bytes: 14837
  },
  {
    name: "cal-date.xlsb",
    origin: "calamine",
    authority: "excel",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/date.xlsb",
    sha256: "68d36adf4d4de3890209e786eeb89a98778d25158628f83e96587e652fbb4eca",
    bytes: 7711
  },
  {
    name: "cal-date_1904.xlsb",
    origin: "calamine",
    authority: "excel",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/date_1904.xlsb",
    sha256: "afc2478a94822c624c44291c8455c172d6d45cc7828849f0168950b9230cb7d8",
    bytes: 7709
  },
  {
    name: "cal-issue127.xlsb",
    origin: "calamine",
    authority: "excel",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/issue127.xlsb",
    sha256: "7a1eebd5b6d8f560a91babd3831f1133d964b1b094b848dd00c933d905ca0e09",
    bytes: 13868
  },
  {
    name: "cal-issue_182.xlsb",
    origin: "calamine",
    authority: "excel",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/issue_182.xlsb",
    sha256: "c34351496e7e2874504e272a696f3919da54c33939e78cafc877f1976a25a562",
    bytes: 12657
  },
  {
    name: "cal-issue_186.xlsb",
    origin: "calamine",
    authority: "excel",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/issue_186.xlsb",
    sha256: "c0b99eb23c7031a6af7d295c64f291fa807551c59adb433a54562cc95a3d443d",
    bytes: 8465
  },
  {
    name: "cal-issue_419.xlsb",
    origin: "calamine",
    authority: "excel",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/issue_419.xlsb",
    sha256: "ac265de7165e4c1af712d44f23f43b04bc0ffcb705de478813e3d13819993f4a",
    bytes: 5748
  },
  {
    name: "cal-issue_666_lost_sheets.xlsb",
    origin: "calamine",
    authority: "reduced",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/issue_666_lost_sheets.xlsb",
    sha256: "7cdde22f11a823309ac2cbd663580c70d834b54f527239b8790dea4477a3b32f",
    bytes: 1748
  },
  {
    name: "cal-issue_666_panic.xlsb",
    origin: "calamine",
    authority: "reduced",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/issue_666_panic.xlsb",
    sha256: "466bbc38d665e16b7d5446b908e3b414faaafd1666c0f13512ba9ef5da20684b",
    bytes: 1760
  },
  {
    name: "cal-issues.xlsb",
    origin: "calamine",
    authority: "excel",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/issues.xlsb",
    sha256: "06c648de5529e022ef399a2b6ebc227040e9fdf71a0780e19e614f556bdb53d7",
    bytes: 19226
  },
  {
    name: "cal-pass_protected.xlsb",
    origin: "calamine",
    authority: "encrypted",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/pass_protected.xlsb",
    sha256: "f790bbce8ccad2a6f3d58f85b830d625a46924d49e356ac51d862bc18d3a938d",
    bytes: 16384
  },
  {
    name: "cal-picture.xlsb",
    origin: "calamine",
    authority: "excel",
    url: "https://raw.githubusercontent.com/tafia/calamine/5c02e86e99ec5c1fb1dcc15e64c2bbaf19bff60d/tests/picture.xlsb",
    sha256: "978d13b99eab37eb644df007d04237c59528dac50c002b060f3558b39e50772b",
    bytes: 55437
  },
  {
    name: "poi-51519.xlsb",
    origin: "poi",
    authority: "excel",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/51519.xlsb",
    sha256: "53ebff181db309ae9b602780591836515678db7590aeb59942f9c3348fe61192",
    bytes: 10897
  },
  {
    name: "poi-62815.xlsb",
    origin: "poi",
    authority: "excel",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/62815.xlsb",
    sha256: "2c1da74896f383b8cb33cb128bfeef20783572b81ca48410229bb098ac5c3565",
    bytes: 10665
  },
  {
    name: "poi-Simple.xlsb",
    origin: "poi",
    authority: "nonconformant",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/Simple.xlsb",
    sha256: "41b0c82bfa682f968d69e05e23137232d6c89ea4f24439786f0b779be319929b",
    bytes: 9161
  },
  {
    name: "poi-WithTextBox.xlsb",
    origin: "poi",
    authority: "excel",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/WithTextBox.xlsb",
    sha256: "019fcd1672d45d557fcc4e2de334c8685a49c07c132075a3618c83db832f08b4",
    bytes: 10076
  },
  {
    name: "poi-bug66682.xlsb",
    origin: "poi",
    authority: "excel",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/bug66682.xlsb",
    sha256: "490f0430a6bd44bdf697c7a41a898bce632ce2b775797c3b8c1517764c0900b3",
    bytes: 9580
  },
  {
    name: "poi-comments.xlsb",
    origin: "poi",
    authority: "excel",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/comments.xlsb",
    sha256: "d22daaebbc2a18d29cc3d6f1bb257cad1d880a32311a7def0b288f795b6340d6",
    bytes: 10796
  },
  {
    name: "poi-date.xlsb",
    origin: "poi",
    authority: "excel",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/date.xlsb",
    sha256: "fbb969989aabed2e057b2ddfc4cfd10ef1f6ebe9b7697c3755283515158d5b09",
    bytes: 7566
  },
  {
    name: "poi-hyperlink.xlsb",
    origin: "poi",
    authority: "excel",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/hyperlink.xlsb",
    sha256: "6675f4bde45d1291e1d56783b7abe2857f56837ca674c7877dfc125fb49a4724",
    bytes: 7882
  },
  {
    name: "poi-protected_passtika.xlsb",
    origin: "poi",
    authority: "encrypted",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/protected_passtika.xlsb",
    sha256: "316aafa78433238ea38ecd39be718f3b64a81f54f95fa942a1038104ead99c5e",
    bytes: 14336
  },
  {
    name: "poi-sample.xlsb",
    origin: "poi",
    authority: "excel",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/sample.xlsb",
    sha256: "8cf995ace93f9d0e3bf34b6bdb1355ff46db2d418f6f3fb7943fdc4ca1db4d1b",
    bytes: 10843
  },
  {
    name: "poi-testVarious.xlsb",
    origin: "poi",
    authority: "excel",
    url: "https://raw.githubusercontent.com/apache/poi/f1a042ff46f0c70665785ebf5901cb1923b315f1/test-data/spreadsheet/testVarious.xlsb",
    sha256: "8c600e97d719b0266dcfb49c1872feb8d10c6ed12bc768ff16ace7dae555ebfc",
    bytes: 22715
  }
];
