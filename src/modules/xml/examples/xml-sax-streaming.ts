/**
 * Example: XML Module — Functional SAX & Streaming APIs
 *
 * Complements `xml-complete.ts` (which uses `new Xml.SaxParser()` directly)
 * by covering the functional / streaming SAX surface it skips:
 * - Xml.parseSax: async generator yielding batches of SAX events per chunk
 * - Xml.saxStream: low-overhead adapter feeding an async iterable into a
 *   pre-configured SaxParser (no per-event object allocation)
 * - Xml.validateCommentText: validate text is legal inside an XML comment
 *
 * Usage:   pnpm example --filter xml-sax-streaming
 */
import { Xml, isXmlError } from "../index";

// A small XML document split into chunks to simulate a stream.
const xmlChunks = [
  '<?xml version="1.0"?><catalog>',
  '<book id="1"><title>1984</title>',
  "<author>George Orwell</author></book>",
  '<book id="2"><title>Dune</title>',
  "<author>Frank Herbert</author></book>",
  "</catalog>"
];

async function* chunkSource(): AsyncGenerator<string> {
  for (const chunk of xmlChunks) {
    // Simulate async arrival (e.g. network/file reads).
    await Promise.resolve();
    yield chunk;
  }
}

// =============================================================================
// 1. Xml.parseSax — async generator of SAX event batches
// =============================================================================

console.log("=== 1. Xml.parseSax (async generator) ===");

// parseSax yields an array of events (a batch) per input chunk written.
const openTags: string[] = [];
const texts: string[] = [];
let totalEvents = 0;

for await (const batch of Xml.parseSax(chunkSource())) {
  totalEvents += batch.length;
  for (const event of batch) {
    if (event.eventType === "opentag") {
      openTags.push(event.value.name);
    } else if (event.eventType === "text") {
      const trimmed = String(event.value).trim();
      if (trimmed) {
        texts.push(trimmed);
      }
    }
  }
}

console.log("Total events:", totalEvents);
console.log("Open tags:", openTags);
console.log("Text values:", texts);

// parseSax also accepts a plain (sync) iterable and parser options.
console.log("\n--- parseSax with sync iterable + options ---");
const fragmentChunks = ["<row><c>A</c>", "<c>B</c></row>"];
const fragmentTags: string[] = [];
for await (const batch of Xml.parseSax(fragmentChunks, { fragment: true })) {
  for (const event of batch) {
    if (event.eventType === "opentag") {
      fragmentTags.push(event.value.name);
    }
  }
}
console.log("Fragment open tags:", fragmentTags);

// parseSax propagates parse errors by throwing from the generator.
console.log("\n--- parseSax error propagation ---");
try {
  for await (const _batch of Xml.parseSax(["<root><unclosed>"])) {
    // consume
  }
  console.log("No error thrown");
} catch (err) {
  console.log("parseSax threw on malformed input:", (err as Error).message);
}

// =============================================================================
// 2. Xml.saxStream — direct streaming into a pre-configured SaxParser
// =============================================================================

console.log("\n=== 2. Xml.saxStream (direct adapter) ===");

// Register handlers on the parser *before* calling saxStream. No intermediate
// { eventType, value } objects are created — handlers fire directly.
const parser = new Xml.SaxParser();

const books: { id?: string; title?: string; author?: string }[] = [];
let current: { id?: string; title?: string; author?: string } | null = null;
let currentField: "title" | "author" | null = null;

parser.on("opentag", tag => {
  if (tag.name === "book") {
    current = { id: tag.attributes.id };
  } else if (tag.name === "title") {
    currentField = "title";
  } else if (tag.name === "author") {
    currentField = "author";
  }
});
parser.on("text", text => {
  const trimmed = text.trim();
  if (current && currentField && trimmed) {
    current[currentField] = trimmed;
  }
});
parser.on("closetag", tag => {
  if (tag.name === "book" && current) {
    books.push(current);
    current = null;
  } else if (tag.name === "title" || tag.name === "author") {
    currentField = null;
  }
});

await Xml.saxStream(parser, chunkSource());

console.log("Books parsed via saxStream:");
for (const book of books) {
  console.log(`  [${book.id}] "${book.title}" by ${book.author}`);
}

// saxStream surfaces parse errors by rejecting its returned promise.
console.log("\n--- saxStream error propagation ---");
const errParser = new Xml.SaxParser();
try {
  await Xml.saxStream(errParser, ["<a><b></a>"]);
  console.log("No error thrown");
} catch (err) {
  console.log("saxStream rejected on malformed input:", (err as Error).message);
}

// =============================================================================
// 3. Xml.validateCommentText — validate XML comment text
// =============================================================================

console.log("\n=== 3. Xml.validateCommentText ===");

const samples = [
  "A perfectly valid comment",
  "Contains -- double hyphen", // illegal: "--" not allowed in comments
  "Ends with a hyphen-" // illegal: comment text must not end with "-"
];

for (const sample of samples) {
  try {
    Xml.validateCommentText(sample);
    console.log(`OK     : "${sample}"`);
  } catch (err) {
    if (isXmlError(err)) {
      console.log(`INVALID: "${sample}" -> ${err.message}`);
    } else {
      throw err;
    }
  }
}

console.log("\n=== XML SAX Streaming Examples Complete ===");
