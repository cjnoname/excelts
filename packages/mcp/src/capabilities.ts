/**
 * MCP resources and prompts.
 *
 * Both exist to move cost out of the model's context.
 *
 * **Resources** publish the help topics at stable URIs, so a client can show
 * them and a model can read one without spending a tool call. The same content
 * is still reachable through `documonster_help`, because not every client
 * supports resources.
 *
 * **Prompts** are workflow templates the *user* invokes. They matter because the
 * hardest part of using this server well is knowing the order to do things in —
 * inspect, then read narrowly, then write, then verify. A prompt encodes that
 * sequence once instead of relying on the user to describe it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ServerConfig } from "./config.js";
import { HELP_TOPICS } from "./tools/help.js";

/** URI scheme for help topics. */
const HELP_URI_PREFIX = "documonster://help/";

/** Register one resource per help topic. */
export function registerResources(server: McpServer): void {
  for (const [name, topic] of Object.entries(HELP_TOPICS)) {
    server.registerResource(
      `help-${name}`,
      `${HELP_URI_PREFIX}${name}`,
      {
        title: `documonster: ${name}`,
        description: topic.summary,
        mimeType: "text/markdown"
      },
      uri => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: topic.body }]
      })
    );
  }
}

/**
 * Register workflow prompts.
 *
 * Each returns a single user message that states the goal *and* the discipline —
 * inspect first, keep data server-side, verify by reading back. Those three
 * habits are what separate a cheap correct run from an expensive wrong one, and
 * a prompt is the only place to establish them before the model starts.
 */
export function registerPrompts(server: McpServer, config: ServerConfig): void {
  const has = (group: "excel" | "word" | "pdf" | "forms" | "archive" | "diagram"): boolean =>
    config.groups.has(group);

  if (has("excel")) {
    server.registerPrompt(
      "summarise-spreadsheet",
      {
        title: "Summarise a spreadsheet",
        description: "Inspect a workbook and answer a question about it without reading it all.",
        argsSchema: {
          path: z.string().describe("Workbook path, relative to the server root."),
          question: z.string().describe("What you want to know about it.")
        }
      },
      ({ path, question }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Answer this question about ${path}: ${question}

Work in this order:
1. Call doc_inspect on ${path} to learn its sheets and their sizes.
2. Read only the range you need. If a summary sheet already holds the answer, use it rather than re-deriving it from the detail sheets.
3. If the answer requires a calculation, verify your arithmetic with formula_evaluate before stating it.
4. Quote the cell addresses your answer comes from.

Do not read a whole large sheet. If a read reports omitted rows, narrow the range instead of paging through everything.`
            }
          }
        ]
      })
    );
  }

  if (has("excel") && !config.readonly) {
    server.registerPrompt(
      "build-report",
      {
        title: "Build a report from data files",
        description: "Turn one or more CSV/Excel files into a formatted workbook.",
        argsSchema: {
          sources: z
            .string()
            .describe("The data files or archive to use, as a comma-separated list."),
          out: z.string().describe("Output .xlsx path."),
          goal: z.string().describe("What the report should show.")
        }
      },
      ({ sources, out, goal }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Build ${out} from ${sources}. It should show: ${goal}

Work in this order:
1. If a source is an archive, list it with archive_read and extract only what you need.
2. doc_inspect each data file — CSV delimiters and encodings vary, and guessing wrong silently produces one column.
3. Build the workbook with a single sheet_write call. Use \`fromCsv\` to load source data server-side; do not copy rows into your reply.
4. Add formulas rather than pre-computed numbers, so the workbook stays live.
5. The write result returns an @output/... path. Read that path back with sheet_read and confirm the computed values before telling me it is done.`
            }
          }
        ]
      })
    );
  }

  if (has("forms") && !config.readonly) {
    server.registerPrompt(
      "fill-document",
      {
        title: "Fill a template or form",
        description: "Populate a Word template or a fillable form, then deliver a PDF.",
        argsSchema: {
          path: z.string().describe("Template or form path."),
          data: z.string().describe("The values to put in it, in any readable form."),
          pdf: z.string().optional().describe("Optional PDF output path.")
        }
      },
      ({ path, data, pdf }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Fill ${path} with this data:

${data}

Work in this order:
1. doc_inspect ${path} — it will tell you whether this is a {{placeholder}} template or a form with fields, and name the tool to use.
2. List the placeholders (template_inspect) or the fields (form_fill with no values) before filling anything. Do not guess field names.
3. Fill it. If a required value is missing, stop and ask me — never invent an identifier, reference number, date or amount.
4. The fill result returns an @output/... path. Read it back and confirm no placeholder text survived.${
                pdf === undefined
                  ? ""
                  : `\n5. Convert that @output path to ${pdf} with doc_convert.`
              }`
            }
          }
        ]
      })
    );
  }

  if (has("word")) {
    server.registerPrompt(
      "review-changes",
      {
        title: "Review document changes",
        description: "Compare two versions of a document, or review its tracked changes.",
        argsSchema: {
          a: z.string().describe("The document, or the earlier version."),
          b: z.string().optional().describe("The later version, if comparing two files.")
        }
      },
      ({ a, b }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                b === undefined
                  ? `Review the tracked changes in ${a}.

1. Call doc_review on it to list every revision with its author.
2. Summarise what changed, grouped by intent rather than by paragraph order.
3. Flag anything that changes an obligation, amount, date or party name — those need a human decision.
4. Do not accept or reject anything unless I ask.`
                  : `Compare ${a} with ${b} and tell me what changed.

1. Call doc_review with both paths.
2. Summarise the differences by significance, not in document order.
3. Flag any change to an amount, date, party name or obligation.
4. If a paragraph was reworded without changing meaning, say so rather than quoting both versions in full.`
            }
          }
        ]
      })
    );
  }

  if (has("diagram") && !config.readonly) {
    server.registerPrompt(
      "draw-diagram",
      {
        title: "Draw a diagram",
        description: "Turn a description of a system or process into a rendered Mermaid diagram.",
        argsSchema: {
          subject: z.string().describe("What the diagram should show."),
          out: z.string().describe("Output path; the extension picks .svg, .png or .pdf.")
        }
      },
      ({ subject, out }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Draw ${out} showing: ${subject}

Work in this order:
1. Choose the diagram type that matches the *relationship*, not the one you know best — a flow is a flowchart, an interaction over time is a sequenceDiagram, a lifecycle is a stateDiagram, a data model is an erDiagram, a schedule is a gantt.
2. Call diagram_inspect with the Mermaid source before rendering. Read the structure it reports back and check every node and edge you intended is there — the parser drops what it does not recognise **silently**, and this is the only place that shows.
3. Then diagram_render to ${out}.
4. Tell me the diagram's type and its node/edge counts. You cannot see the picture, so do not claim it "looks good" — report what the parser found.

If a label is long, prefer shortening it over widening the diagram. If ${out} is a page inside an existing PDF instead of a new file, use pdf_edit with op: "diagram".`
            }
          }
        ]
      })
    );
  }

  if ((has("word") || has("pdf") || has("excel")) && !config.readonly) {
    server.registerPrompt(
      "convert-document",
      {
        title: "Convert a document",
        description: "Convert a file to another format, with its limitations stated.",
        argsSchema: {
          from: z.string().describe("Source path."),
          to: z.string().describe("Destination path; its extension picks the format.")
        }
      },
      ({ from, to }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Convert ${from} to ${to}.

1. doc_inspect the source first — an extension can lie, and the real format decides whether the conversion is possible at all.
2. Use doc_convert. If that pair is not supported it will tell you what is; report that rather than trying alternatives at random.
3. Tell me plainly what the conversion loses, if anything.`
            }
          }
        ]
      })
    );
  }
}
