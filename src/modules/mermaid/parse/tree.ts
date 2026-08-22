/**
 * The `mindmap` and `gitGraph` parsers.
 *
 * A mind map is the one diagram whose structure is carried by *whitespace*: indentation is
 * the syntax, so the parser has to track a stack of column positions rather than look for
 * a delimiter. Deeper than the last line means a child, shallower means unwind until the
 * columns line up again.
 */

import { decodeLabel, splitStatements, linesOf } from "@mermaid/parse/lex";
import type {
  GitCommit,
  GitGraphDiagram,
  MindNode,
  MindShape,
  MindmapDiagram
} from "@mermaid/types";

/** Bracket pairs that pick a mind-map node's outline, longest first. */
const SHAPES: ReadonlyArray<{ open: string; close: string; shape: MindShape }> = [
  { open: "((", close: "))", shape: "circle" },
  { open: "))", close: "((", shape: "bang" },
  { open: ")", close: "(", shape: "cloud" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[", close: "]", shape: "square" },
  { open: "(", close: ")", shape: "rounded" }
];

/**
 * Parse a mind map.
 *
 * Indentation is read from the raw source rather than from the statement list, because
 * `splitStatements` trims — which is exactly the information this grammar keeps its
 * structure in.
 */
export function parseMindmap(source: string): MindmapDiagram {
  interface Building {
    readonly indent: number;
    readonly node: { text: string; shape: MindShape; children: Building["node"][] };
  }
  const stack: Building[] = [];
  let root: Building["node"] | undefined;
  let title: string | undefined;

  for (const raw of linesOf(source)) {
    // Already comment-free: `linesOf` applies the shared, quote-aware rule.
    const line = raw;
    if (line.trim() === "") {
      continue;
    }
    const body = line.trim();
    if (/^mindmap\b/i.test(body)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(body);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }
    // `::icon(...)` and `:::class` decorate a node rather than declaring one.
    if (/^(::icon|:::)/.test(body)) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const parsed = readNode(body);
    const node = { text: parsed.text, shape: parsed.shape, children: [] as Building["node"][] };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.node.children.push(node);
    } else if (root === undefined) {
      root = node;
    } else {
      // A second node at the outermost level is a sibling of the root; Mermaid errors, but
      // hanging it off the root keeps what the author wrote visible.
      root.children.push(node);
    }
    stack.push({ indent, node });
  }

  return {
    kind: "mindmap",
    ...(title === undefined ? {} : { title }),
    ...(root === undefined ? {} : { root: freeze(root) })
  };
}

function freeze(node: { text: string; shape: MindShape; children: unknown[] }): MindNode {
  return {
    text: node.text,
    shape: node.shape,
    children: (node.children as Array<{ text: string; shape: MindShape; children: unknown[] }>).map(
      freeze
    )
  };
}

/** `id[label]`, `id(label)`, `id((label))`, or a bare label. */
function readNode(body: string): { text: string; shape: MindShape } {
  for (const candidate of SHAPES) {
    const open = body.indexOf(candidate.open);
    if (open === -1 || !body.endsWith(candidate.close)) {
      continue;
    }
    const inner = body.slice(open + candidate.open.length, body.length - candidate.close.length);
    if (inner === "") {
      continue;
    }
    return { text: decodeLabel(inner), shape: candidate.shape };
  }
  return { text: decodeLabel(body), shape: "default" };
}

/** Parse a git graph. */
export function parseGitGraph(source: string): GitGraphDiagram {
  const commits: GitCommit[] = [];
  const branches: string[] = ["main"];
  let current = "main";
  let title: string | undefined;
  let auto = 0;

  const use = (name: string): void => {
    if (!branches.includes(name)) {
      branches.push(name);
    }
  };

  for (const text of splitStatements(source)) {
    if (/^gitGraph\b/i.test(text)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    const branch = /^branch\s+(\S+)/i.exec(text);
    if (branch) {
      use(branch[1]);
      // Mermaid switches to a branch as it creates it.
      current = branch[1];
      continue;
    }
    const checkout = /^(?:checkout|switch)\s+(\S+)/i.exec(text);
    if (checkout) {
      use(checkout[1]);
      current = checkout[1];
      continue;
    }
    const merge = /^merge\s+(\S+)(.*)$/i.exec(text);
    if (merge) {
      use(merge[1]);
      const options = readOptions(merge[2]);
      commits.push({
        kind: "merge",
        id: options.id ?? `merge-${auto++}`,
        branch: current,
        from: merge[1],
        ...(options.tag === undefined ? {} : { tag: options.tag }),
        highlight: false,
        reverse: false
      });
      continue;
    }
    if (/^commit\b/i.test(text)) {
      const options = readOptions(text.slice("commit".length));
      commits.push({
        kind: "commit",
        id: options.id ?? `c${auto++}`,
        branch: current,
        ...(options.tag === undefined ? {} : { tag: options.tag }),
        highlight: options.type === "HIGHLIGHT",
        reverse: options.type === "REVERSE"
      });
      continue;
    }
    // `cherry-pick`, `%%{init}%%` and the accessibility statements carry no geometry here.
  }

  return {
    kind: "git",
    ...(title === undefined ? {} : { title }),
    // A branch nobody committed to would draw an empty lane.
    branches: branches.filter(name => commits.some(commit => commit.branch === name)),
    commits
  };
}

/** `id: "x" tag: "v1" type: HIGHLIGHT`. */
function readOptions(text: string): { id?: string; tag?: string; type?: string } {
  const out: { id?: string; tag?: string; type?: string } = {};
  for (const match of text.matchAll(/(id|tag|type)\s*:\s*("([^"]*)"|\S+)/gi)) {
    const value = match[3] ?? match[2];
    const key = match[1].toLowerCase();
    if (key === "id") {
      out.id = value;
    } else if (key === "tag") {
      out.tag = value;
    } else {
      out.type = value.toUpperCase();
    }
  }
  return out;
}
