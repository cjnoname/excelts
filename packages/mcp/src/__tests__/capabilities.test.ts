/**
 * Resource and prompt tests.
 *
 * These go through a real client, because the value of both capabilities is that
 * a client can enumerate and fetch them — something a unit test on the registry
 * cannot demonstrate.
 */

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { resolveConfig } from "../config.js";
import { createServer } from "../server.js";
import { HELP_TOPICS } from "../tools/help.js";

/** Concatenate a prompt result's text content; the content type is a union. */
function promptText(result: {
  messages: readonly { content: { type: string; text?: string } }[];
}): string {
  return result.messages
    .map(message => (message.content.type === "text" ? (message.content.text ?? "") : ""))
    .join("\n");
}

interface Harness {
  readonly client: Client;
  close(): Promise<void>;
}

async function connect(): Promise<Harness> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-caps-")));
  const server = createServer(resolveConfig(["--root", root], { cwd: root }), {
    name: "documonster",
    version: "0.0.0-test"
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "caps-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

async function connectWith(args: readonly string[]): Promise<Harness> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-caps-")));
  const server = createServer(resolveConfig(["--root", root, ...args], { cwd: root }), {
    name: "documonster",
    version: "0.0.0-test"
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "caps-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

describe("resources", () => {
  it("declares the resources capability", async () => {
    const harness = await connect();
    try {
      expect(harness.client.getServerCapabilities()?.resources).toBeDefined();
    } finally {
      await harness.close();
    }
  });

  it("publishes every expected topic, named explicitly", async () => {
    // Listed literally rather than derived from HELP_TOPICS: comparing the
    // registry against itself cannot notice a topic that was accidentally
    // deleted, which is exactly what happened once during development.
    const harness = await connect();
    try {
      const { resources } = await harness.client.listResources();
      expect(resources.map(resource => resource.uri).toSorted()).toEqual([
        "documonster://help/documents",
        "documonster://help/editing",
        "documonster://help/formulas",
        "documonster://help/overview",
        "documonster://help/roadmap",
        "documonster://help/sandbox"
      ]);
    } finally {
      await harness.close();
    }
  });

  it("publishes one resource per help topic", async () => {
    const harness = await connect();
    try {
      const { resources } = await harness.client.listResources();
      const expected = Object.keys(HELP_TOPICS)
        .map(name => `documonster://help/${name}`)
        .toSorted();
      expect(resources.map(resource => resource.uri).toSorted()).toEqual(expected);
    } finally {
      await harness.close();
    }
  });

  it("returns a topic's Markdown body", async () => {
    const harness = await connect();
    try {
      const result = await harness.client.readResource({ uri: "documonster://help/overview" });
      const first = result.contents[0];
      expect(first?.mimeType).toBe("text/markdown");
      // A resource's content is text-or-blob, so narrow before reading it.
      expect(first !== undefined && "text" in first ? first.text : "").toContain(
        "Working discipline"
      );
    } finally {
      await harness.close();
    }
  });

  it("gives every resource a description, so a client can list them usefully", async () => {
    const harness = await connect();
    try {
      const { resources } = await harness.client.listResources();
      for (const resource of resources) {
        expect(resource.description, resource.uri).toBeTruthy();
      }
    } finally {
      await harness.close();
    }
  });
});

describe("prompts", () => {
  it("declares the prompts capability", async () => {
    const harness = await connect();
    try {
      expect(harness.client.getServerCapabilities()?.prompts).toBeDefined();
    } finally {
      await harness.close();
    }
  });

  it("lists the workflow prompts with their arguments", async () => {
    const harness = await connect();
    try {
      const { prompts } = await harness.client.listPrompts();
      expect(prompts.map(prompt => prompt.name).toSorted()).toEqual([
        "build-report",
        "convert-document",
        "fill-document",
        "review-changes",
        "summarise-spreadsheet"
      ]);
      const report = prompts.find(prompt => prompt.name === "build-report");
      expect(report?.arguments?.map(argument => argument.name).toSorted()).toEqual([
        "goal",
        "out",
        "sources"
      ]);
    } finally {
      await harness.close();
    }
  });

  it("interpolates arguments and states the working order", async () => {
    const harness = await connect();
    try {
      const result = await harness.client.getPrompt({
        name: "build-report",
        arguments: { sources: "reports.zip", out: "out/q3.xlsx", goal: "revenue by region" }
      });
      const text = promptText(result);

      expect(text).toContain("reports.zip");
      expect(text).toContain("out/q3.xlsx");
      expect(text).toContain("revenue by region");
      // The discipline is the point of the prompt, not the goal restatement.
      expect(text).toContain("doc_inspect");
      expect(text).toContain("fromCsv");
      expect(text).toContain("do not copy rows into your reply");
    } finally {
      await harness.close();
    }
  });

  it("tells the model never to invent a missing value", async () => {
    // The most valuable instruction in the set: a fabricated reference number on
    // an invoice is worse than a failure.
    const harness = await connect();
    try {
      const result = await harness.client.getPrompt({
        name: "fill-document",
        arguments: { path: "invoice-template.docx", data: "client: Acme" }
      });
      const text = promptText(result);
      expect(text).toContain("never invent an identifier");
    } finally {
      await harness.close();
    }
  });

  it("adapts review-changes to one or two documents", async () => {
    const harness = await connect();
    try {
      const single = await harness.client.getPrompt({
        name: "review-changes",
        arguments: { a: "contract.docx" }
      });
      expect(promptText(single)).toContain("tracked changes");

      const pair = await harness.client.getPrompt({
        name: "review-changes",
        arguments: { a: "v1.docx", b: "v2.docx" }
      });
      expect(promptText(pair)).toContain("Compare v1.docx with v2.docx");
    } finally {
      await harness.close();
    }
  });

  it("omits the PDF step when no PDF path is given", async () => {
    const harness = await connect();
    try {
      const without = await harness.client.getPrompt({
        name: "fill-document",
        arguments: { path: "f.docx", data: "x" }
      });
      expect(promptText(without)).not.toContain("doc_convert");

      const with_ = await harness.client.getPrompt({
        name: "fill-document",
        arguments: { path: "f.docx", data: "x", pdf: "out/f.pdf" }
      });
      expect(promptText(with_)).toContain("out/f.pdf");
    } finally {
      await harness.close();
    }
  });

  it("does not advertise workflows whose tools are disabled", async () => {
    const harness = await connectWith(["--enable", "pdf"]);
    try {
      const names = (await harness.client.listPrompts()).prompts.map(prompt => prompt.name);
      expect(names).toEqual(["convert-document"]);
    } finally {
      await harness.close();
    }
  });

  it("does not advertise write workflows under --readonly", async () => {
    const harness = await connectWith(["--readonly"]);
    try {
      const names = (await harness.client.listPrompts()).prompts
        .map(prompt => prompt.name)
        .toSorted();
      expect(names).toEqual(["review-changes", "summarise-spreadsheet"]);
    } finally {
      await harness.close();
    }
  });
});
