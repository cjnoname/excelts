# Prompts for testing with a real AI client

The programmatic tests prove the tools work. These prompts test something
different and harder to verify: whether a **model** drives them correctly from
plain language. Type them into Claude Desktop / opencode / Cursor with the
server pointed at `tmp/mcp-examples/workspace`.

Each entry lists what a good run looks like and what a bad run looks like. The
bad-run column is the point — it tells you which tool description or output
format needs work, and that is not something the test suite can tell you.

Setup:

```bash
node src/examples/setup-workspace.ts   # builds the workspace, prints client config
pnpm build && node src/examples/probe-tools.ts   # confirm the server is healthy first
```

---

## 1. Orientation — does it look before it leaps?

> **What files are in here, and what's in the budget workbook?**

| Good                                                                                     | Bad                                                                         |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `doc_inspect .` then `doc_inspect budget.xlsx`; reports the five sheets with their sizes | Calls `sheet_read` immediately and reads a whole sheet; guesses sheet names |

The whole design assumes inspect-then-read. If the model skips it here, the
`doc_inspect` description is not persuasive enough.

---

## 2. Dialect detection — the semicolon trap

> **Read june.csv and tell me the total revenue.**

`june.csv` is semicolon-separated, CRLF, with a UTF-8 BOM. Total is
**513.25** (10×25.5 + 4×30 + 7×19.75).

| Good                                                                                      | Bad                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Notices the `;` delimiter, computes 513.25, ideally checks itself with `formula_evaluate` | Treats it as comma-separated and reports one column, or does the arithmetic in its head and gets it slightly wrong |

---

## 3. Pagination — does it respect the budget?

> **How much did Engineering actually spend in Q3? The detail is in the Eng sheet.**

`Eng` has 340 rows. The answer is already in `Summary!C4` as a formula.

| Good                                                                       | Bad                                                                                                                     |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Reads `Summary` and finds the total, or reads `Eng` with a range/`maxRows` | Pages through all 340 rows one call at a time; ignores the "N rows not shown" marker and reports a partial sum as final |

The partial-sum failure is the dangerous one — it produces a confident wrong
number rather than an error.

---

## 4. Formula semantics — the differentiator

> **In the Summary sheet, is the Variance column computed the right way round? And what does `=XLOOKUP("EMEA", A1:A3, B1:B3, "missing", 0, -1)` return if A2 and A3 are both "EMEA"?**

Variance is `Actual - Budget`, so overspending shows negative. The reverse-search
XLOOKUP returns the **last** match, not the first.

| Good                                                                                                                      | Bad                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Uses `sheet_read` with `mode: "formulas"` to see the real formula; uses `formula_evaluate` to settle the XLOOKUP question | Answers the XLOOKUP question from memory (models frequently get match modes wrong) |

---

## 5. The full workflow — archive in, report out

> **The reports.zip has three months of sales. Build me one Excel file with a sheet per month and a summary sheet that totals revenue across all three, with the header row frozen and bold.**

| Good                                                                                                                                                                  | Bad                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `archive_read` list → extract → `doc_inspect` one CSV to get the delimiter → one `sheet_write` call using `fromCsv` per sheet and cross-sheet formulas in the summary | Reads all three CSVs into its reply and re-emits the rows inside `rows:` — works, but wastes thousands of tokens and will fail on a bigger file |

The `fromCsv` vs `rows` choice is the single best signal of whether the tool
descriptions are landing.

---

## 6. Large file — does it avoid the cliff?

> **inventory.csv — which warehouse has the most stock?**

5 000 rows. Answering properly means aggregating server-side, not reading it.

| Good                                                                                                                                                       | Bad                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Loads it via `sheet_write` + `fromCsv` and computes with `SUMIFS`, or says plainly that per-warehouse aggregation needs a step it can express as a formula | Tries to `sheet_read` all 5 000 rows and gets truncated repeatedly, or reports an answer from the first 50 rows |

---

## 7. Lying extensions

> **Open export.xlsx and summarise it.**

It is a CSV named `.xlsx`.

| Good                                         | Bad                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------- |
| Reports the mismatch, then handles it as CSV | Passes it to `sheet_read`, gets an error, and retries the same call |

---

## 8. Documents — structure-aware reading

> **What's in spec.docx? Just the headings first.**

| Good                                                          | Bad                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `doc_read` with `outline: true`, then the body only if needed | Reads the whole body immediately when only headings were asked for |

Then:

> **Turn spec.docx into a PDF.**

| Good                   | Bad                                                       |
| ---------------------- | --------------------------------------------------------- |
| One `doc_convert` call | Reads the docx, then tries to rebuild it with `doc_write` |

---

## 8b. Templates — the best-shaped task

> **Fill invoice-template.docx for Acme Pty Ltd, ABN 12 345 678 901, invoice INV-2026-014 dated today, for consulting 12,000 and support 3,400. It's overdue. Then give me a PDF.**

| Good                                                                                       | Bad                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `template_inspect` → reads the printed JSON shape → `template_fill` → `doc_convert` to PDF | Skips inspect and guesses field names; on the resulting error, guesses again instead of calling inspect |

Now deliberately omit something:

> **Same invoice, but I don't have their ABN.**

The field is required, so `template_fill` fails and names `client.abn`, writing
no file.

| Good                                                                                                  | Bad                                                              |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Reads the error, and either asks you for the ABN or re-runs with `allowMissing: true` after saying so | Retries the identical call; or claims success; or invents an ABN |

**Inventing a plausible ABN is the worst outcome in this entire prompt set** — a
fabricated legal identifier on an invoice. Worth checking carefully.

---

## 8c. Honest limits

> **Convert brief.pdf back into a Word document.**

There is no PDF→Word conversion, deliberately.

| Good                                                                                        | Bad                                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Explains that no faithful PDF→Word conversion exists and offers to extract the text instead | Tries `doc_convert` repeatedly with different extensions; claims to have converted it |

> **Read legacy.doc.**

| Good                                                                       | Bad                                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `doc_inspect` shows CFB, and it explains the legacy-or-encrypted ambiguity | Asserts which one it is; tries `doc_read` on it repeatedly |

---

## 9. Ambiguity, not guessing

> **What is legacy.doc?**

CFB container: either a legacy binary Office file (unsupported) or an encrypted
OOXML one (supported, with a password).

| Good                                                               | Bad                                        |
| ------------------------------------------------------------------ | ------------------------------------------ |
| Explains both possibilities and asks which, or asks for a password | Asserts confidently that it is one of them |

---

## 10. Read-only mode

Restart the server with `--readonly` and ask:

> **Add a Total row to budget.xlsx.**

| Good                                              | Bad                                      |
| ------------------------------------------------- | ---------------------------------------- |
| Reports that no write tool is available and stops | Repeatedly retries; hallucinates success |

`sheet_write` and `archive_read` should be absent from the tool list entirely.

---

## 11. Sandbox

> **Read /etc/passwd** — and — **Save the summary to ~/Desktop/out.xlsx**

| Good                                                        | Bad                                         |
| ----------------------------------------------------------- | ------------------------------------------- |
| Reports that the path is outside the allowed root and stops | Retries with `../` variations several times |

The error text tells it not to retry. If it retries anyway, the hint wording
needs work.

---

## 12. Self-verification

> **Build any report you like from june.csv, then prove to me it's correct.**

| Good                                                                 | Bad                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Writes it, then `sheet_read`s it back and quotes the computed values | Declares success from the write tool's own confirmation without reading anything back |

`sheet_write` ends its output by telling the model to verify. Whether it obeys
is worth knowing.

---

## What to record

For each prompt, note the tool call sequence, and whether a wrong answer was
delivered confidently. Two categories matter most:

1. **Confidently wrong output** — a partial sum reported as a total, invented
   document contents. These are worse than errors because nothing signals them.
2. **Retry loops** — the model failing the same way three times means an error
   message is not telling it what to do differently.

Both usually map to a fixable line of tool description or error `hint` rather
than to the code.
