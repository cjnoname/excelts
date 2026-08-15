/**
 * `doc_review` — compare two document versions, or work through one document's
 * tracked changes.
 *
 * The one capability that justified a new tool rather than an operation on an
 * existing one, for two reasons: it takes *two* inputs, which no other tool's
 * shape allows, and contract review is the document task where a model's help is
 * worth most — reading a redline is tedious, and the consequences of missing a
 * changed amount are real.
 *
 * Both modes answer the same question — "what changed" — so they share a tool.
 * Accepting or rejecting is opt-in and never implicit: the summary is what the
 * caller usually wants, and applying a revision is a decision a person should
 * make.
 */

import { Diff, Io, Query } from "documonster/word";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { toolError } from "../errors.js";
import { assertWritable, resolveEditTarget, resolveInRoot } from "../sandbox.js";
import {
  assertReadableSize,
  assertUnchanged,
  backupOnce,
  describeBackup,
  fingerprint,
  isSameFile,
  replaceAtomically,
  writeWithPolicy
} from "./fs-helpers.js";
import { textResult } from "./result.js";
import { defineTool } from "./types.js";

/** Entries reported in one call. */
const MAX_ENTRIES = 120;

export const docReviewTool = defineTool({
  name: "doc_review",
  group: "word",
  title: "Review document changes",
  description:
    "Compare two .docx versions paragraph by paragraph, or list a document's tracked changes with their authors. Optionally accept or reject revisions. Give `path` and `against` to compare two files; give `path` alone to review tracked changes in one.",
  inputSchema: {
    path: z.string().min(1).describe("The document, or the earlier version when comparing."),
    against: z
      .string()
      .optional()
      .describe(
        "The later version. Supply it to compare two files instead of reviewing revisions."
      ),
    apply: z
      .enum(["accept-all", "reject-all"])
      .optional()
      .describe(
        "Apply every tracked change. Omit to only report them — accepting a revision is a decision a person should usually make."
      ),
    out: z
      .string()
      .optional()
      .describe(
        "With `apply`, write below @output/. Required for input files unless --allow-in-place is enabled."
      ),
    backup: z
      .boolean()
      .optional()
      .describe("When applying in place, copy the original to <name>.bak first. Defaults to true."),
    overwrite: z.boolean().optional().describe("Replace an existing `out` file. Defaults to false.")
  },
  annotations: {
    readOnlyHint: false,
    // Conditional: listing/comparing is read-only, but `apply` can replace the
    // input. MCP annotations cannot depend on arguments, so choose the safer
    // hint and let clients ask for confirmation.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  // Comparing and listing are read-only; only `apply` writes. Declared
  // non-mutating so a read-only server can still review changes, with
  // assertWritable guarding the write path.
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;

    if (args.against !== undefined) {
      if (args.apply !== undefined) {
        throw toolError.invalidInput(
          "`apply` cannot be combined with `against`",
          "Comparing two files reports differences; there are no revisions in either to accept. Review one file's tracked changes instead."
        );
      }
      return textResult(config, await compare(config, args.path, args.against));
    }

    return textResult(config, await reviewRevisions(config, args));
  }
});

async function compare(config: ServerConfig, aPath: string, bPath: string): Promise<string> {
  const [aResolved, bResolved] = await Promise.all([
    resolveInRoot(config, aPath, { mustExist: true }),
    resolveInRoot(config, bPath, { mustExist: true })
  ]);

  await Promise.all([
    assertReadableSize(config, aResolved, aPath),
    assertReadableSize(config, bResolved, bPath)
  ]);
  const [a, b] = await Promise.all([readWord(aResolved, aPath), readWord(bResolved, bPath)]);
  const diff = Diff.documents(a, b);

  if (diff.summary.added === 0 && diff.summary.deleted === 0 && diff.summary.modified === 0) {
    return [
      `# ${aPath} → ${bPath}`,
      "",
      "**No textual differences.** Every paragraph matches.",
      "",
      "This comparison covers body paragraphs only. Changes in headers, footers, footnotes, endnotes, comments, images and formatting are not detected — use doc_search with a `format` filter for appearance, and inspect those containers separately when they matter."
    ].join("\n");
  }

  // Changed paragraphs first: a reviewer reading in document order wades through
  // unchanged text to find the three lines that matter.
  const changed = diff.entries.filter(entry => entry.type !== "unchanged");

  const lines = [
    `# ${aPath} → ${bPath}`,
    "",
    `- paragraphs compared: ${diff.summary.totalParagraphs}`,
    `- **modified: ${diff.summary.modified} · added: ${diff.summary.added} · deleted: ${diff.summary.deleted}** · unchanged: ${diff.summary.unchanged}`,
    ""
  ];

  for (const entry of changed.slice(0, MAX_ENTRIES)) {
    const where =
      entry.newIndex !== undefined
        ? `paragraph ${entry.newIndex + 1}`
        : `was paragraph ${(entry.oldIndex ?? 0) + 1}`;

    if (entry.type === "modified") {
      lines.push(
        `## modified — ${where}`,
        "",
        `- before: ${quote(entry.oldText)}`,
        `- after: ${quote(entry.newText)}`,
        ""
      );
    } else if (entry.type === "added") {
      lines.push(`## added — ${where}`, "", `- ${quote(entry.newText)}`, "");
    } else {
      lines.push(`## deleted — ${where}`, "", `- ${quote(entry.oldText)}`, "");
    }
  }

  if (changed.length > MAX_ENTRIES) {
    lines.push(`[${changed.length - MAX_ENTRIES} further change(s) not listed]`, "");
  }

  lines.push(
    "This comparison covers body-paragraph text only. Headers, footers, footnotes, endnotes, comments, images and formatting are outside its scope."
  );
  return lines.join("\n");
}

async function reviewRevisions(
  config: ServerConfig,
  args: {
    readonly path: string;
    readonly apply?: "accept-all" | "reject-all";
    readonly out?: string;
    readonly backup?: boolean;
    readonly overwrite?: boolean;
  }
): Promise<string> {
  const resolved = await resolveInRoot(config, args.path, { mustExist: true });
  await assertReadableSize(config, resolved, args.path);
  const inputVersion = await fingerprint(resolved);
  const doc = await readWord(resolved, args.path);
  const revisions = Query.listRevisions(doc);

  if (revisions.length === 0) {
    return [
      `# ${args.path}`,
      "",
      "This document contains no tracked changes.",
      "",
      "To compare it against another version, pass `against`."
    ].join("\n");
  }

  // A revision's author and kind are optional in the model — Word permits an
  // anonymous change — so both are normalised before counting.
  const changes = collectRevisionText(doc);
  const byAuthor = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const revision of revisions) {
    const author = revision.author ?? "(unattributed)";
    const type = revision.type ?? "(unknown)";
    byAuthor.set(author, (byAuthor.get(author) ?? 0) + 1);
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }

  const lines = [
    `# ${args.path} — ${revisions.length} tracked change(s)`,
    "",
    `- by author: ${[...byAuthor].map(([author, count]) => `${author} (${count})`).join(", ")}`,
    `- by kind: ${[...byType].map(([type, count]) => `${type} (${count})`).join(", ")}`,
    "",
    "| id | kind | author | text | date |",
    "| --- | --- | --- | --- | --- |",
    ...revisions.slice(0, MAX_ENTRIES).map(revision => {
      const text = changes.get(revision.id);
      return `| ${revision.id} | ${revision.type ?? "—"} | ${revision.author ?? "(unattributed)"} | ${text === undefined ? "—" : quote(text)} | ${revision.date ?? "—"} |`;
    })
  ];

  if (revisions.length > MAX_ENTRIES) {
    lines.push("", `[${revisions.length - MAX_ENTRIES} more not listed]`);
  }

  if (args.apply === undefined) {
    lines.push(
      "",
      'Nothing was written. Pass `apply: "accept-all"` or `"reject-all"` to resolve them.',
      "",
      "Read the document with doc_read to see the text as it stands — inserted text is included, deleted text is not."
    );
    return lines.join("\n");
  }

  assertWritable(config);
  await assertUnchanged(resolved, inputVersion);

  // Re-read: accept/reject mutate the document **in place** and return the
  // number handled, so the listing's instance must not be reused.
  const fresh = await readWord(resolved, args.path);
  const handled =
    args.apply === "accept-all" ? Query.acceptAllRevisions(fresh) : Query.rejectAllRevisions(fresh);

  const writeTarget = await resolveEditTarget(config, args.path, args.out);
  const inPlace = isSameFile(writeTarget.path, resolved);
  const backupPath = inPlace && (args.backup ?? true) ? await backupOnce(writeTarget) : undefined;

  if (inPlace) {
    await replaceAtomically(writeTarget.path, temporary => Io.writeFile(fresh, temporary));
  } else {
    await writeWithPolicy(writeTarget.path, args.overwrite === true, temporary =>
      Io.writeFile(fresh, temporary)
    );
  }

  lines.push(
    "",
    `**${args.apply === "accept-all" ? "Accepted" : "Rejected"} ${handled} revision(s)**, written to ${writeTarget.display}${inPlace ? " (in place)" : ""}.`,
    `- revisions remaining: ${countRevisions(fresh)}`,
    ...describeBackup(writeTarget.display, backupPath),
    "",
    "Read it back with doc_read to confirm the resulting text."
  );

  return lines.join("\n");
}

/**
 * Count remaining revisions, tolerating a failure to walk the document.
 *
 * Defensive on purpose: during development the document walker threw on one
 * particular revision arrangement that could not afterwards be reproduced in
 * isolation. Whatever the cause, a verification step must not be able to fail
 * the write that already succeeded.
 */
function countRevisions(doc: Awaited<ReturnType<typeof Io.readFile>>): string {
  try {
    return String(Query.listRevisions(doc).length);
  } catch {
    return "could not be counted — read the document to confirm";
  }
}

/**
 * Text covered by each revision, keyed by revision id.
 *
 * `listRevisions` reports who changed what *kind* of thing but not the words,
 * which makes a redline summary useless on its own — a reviewer cannot approve
 * "insert by Alice". The document is walked here to recover the runs, guarded
 * because a malformed revision arrangement has been seen to break the walker and
 * a listing must not fail for want of an annotation.
 */
function collectRevisionText(doc: Awaited<ReturnType<typeof Io.readFile>>): Map<number, string> {
  const found = new Map<number, string>();

  const runText = (run: { readonly content?: readonly { readonly text?: string }[] }): string =>
    (run.content ?? []).map(item => item.text ?? "").join("");

  try {
    Query.walkDocument(doc, {
      visitInsertedRun(node: { revision?: { id?: number }; run?: unknown }) {
        const id = node.revision?.id;
        if (id !== undefined) {
          found.set(id, runText(node.run as { content?: readonly { text?: string }[] }));
        }
      },
      visitDeletedRun(node: { revision?: { id?: number }; run?: unknown }) {
        const id = node.revision?.id;
        if (id !== undefined) {
          found.set(id, runText(node.run as { content?: readonly { text?: string }[] }));
        }
      }
    });
  } catch {
    // Annotation is best-effort; the id/kind/author listing stands without it.
  }

  return found;
}

function quote(text: string | undefined): string {
  if (text === undefined || text.length === 0) {
    return "_(empty)_";
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

async function readWord(resolved: string, displayPath: string) {
  return await Io.readFile(resolved).catch((cause: unknown) => {
    throw toolError.unsupported(
      `could not read ${displayPath} as a Word document`,
      "doc_review works with .docx only. Run doc_inspect to check the real file type.",
      { cause }
    );
  });
}
