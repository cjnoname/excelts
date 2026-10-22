/**
 * Streams the user already has come from another implementation: most often
 * `readable-stream`, which many npm libraries depend on and which bundles carry
 * for Node-style streams in a browser — and, to the browser kernel,
 * `node:stream` itself.
 *
 * Both directions — theirs driven by our functions, ours by theirs — with
 * data, errors and teardown checked. The `typed` blocks are
 * compiled, not run: every call in them is something a consumer may write
 * without `as`, and they fail `pnpm type` if a signature stops accepting it.
 */

import * as nodeStream from "node:stream";
import { pipeline as nativePipeline } from "node:stream/promises";

import * as nodeEntry from "@stream/index";
import * as browserEntry from "@stream/index.browser";
import * as RS from "readable-stream";
import { describe, expect, it } from "vitest";

type Api = any;

/** Typed readable-stream stages, for the compile-only blocks at the end. */
function theirSink(out: string[]): RS.Writable {
  return new RS.Writable({
    objectMode: true,
    write(chunk: unknown, _encoding, callback) {
      out.push(String(chunk));
      callback();
    }
  });
}

function theirUpper(): RS.Transform {
  return new RS.Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding, callback) {
      callback(null, String(chunk).toUpperCase());
    }
  });
}

/**
 * Each entry with each implementation a user's streams may come from.
 * `node:stream` is foreign only to the browser kernel; to the Node entry it is
 * the entry's own classes.
 */
const pairings: Array<[string, string, Api, Api]> = [
  ["node entry", "readable-stream", nodeEntry, RS],
  ["browser entry", "readable-stream", browserEntry, RS],
  ["browser entry", "node:stream", browserEntry, nodeStream]
];

describe.each(pairings)("%s with streams from %s", (_entry, _theirs, S: Api, F: Api) => {
  const sink = (I: Api, out: string[]): any =>
    new I.Writable({
      objectMode: true,
      write(chunk: unknown, _e: string, cb: () => void) {
        out.push(String(chunk));
        cb();
      }
    });
  const upper = (I: Api): any =>
    new I.Transform({
      objectMode: true,
      transform(chunk: unknown, _e: string, cb: (e: null, d: string) => void) {
        cb(null, String(chunk).toUpperCase());
      }
    });
  const failing = (I: Api, message: string): any =>
    new I.Transform({
      objectMode: true,
      transform(_c: unknown, _e: string, cb: (e: Error) => void) {
        cb(new Error(message));
      }
    });
  /** Their own pipeline / finished, through the callback forms both implementations share. */
  const theirPipeline = (...streams: unknown[]): Promise<void> =>
    new Promise((resolve, reject) => {
      F.pipeline(...streams, (error?: Error | null) => (error ? reject(error) : resolve()));
    });
  const theirFinished = (stream: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      F.finished(stream, (error?: Error | null) => (error ? reject(error) : resolve()));
    });

  it("our pipeline carries data through their stages", async () => {
    const out: string[] = [];
    await S.pipeline(F.Readable.from(["a", "b"]), upper(S), upper(F), sink(F, out));
    expect(out).toEqual(["A", "B"]);
  });

  it("their pipeline carries data through ours", async () => {
    const out: string[] = [];
    await theirPipeline(S.Readable.from(["a", "b"]), upper(F), sink(S, out));
    expect(out).toEqual(["A", "B"]);
  });

  it("an error in their stage fails our pipeline and destroys every stage", async () => {
    const stages = [S.Readable.from(["a", "b", "c"]), failing(F, "theirs broke"), sink(F, [])];
    await expect(S.pipeline(...stages)).rejects.toThrow("theirs broke");
    expect(stages.map(stage => stage.destroyed)).toEqual([true, true, true]);
  });

  it("an error in our stage fails their pipeline and destroys every stage", async () => {
    const stages = [F.Readable.from(["a", "b"]), failing(S, "ours broke"), sink(S, [])];
    await expect(theirPipeline(...stages)).rejects.toThrow("ours broke");
    expect(stages.map(stage => stage.destroyed)).toEqual([true, true, true]);
  });

  it("pipe() and finished() work both ways", async () => {
    const a: string[] = [];
    const theirs = sink(F, a);
    S.Readable.from(["x"]).pipe(theirs);
    await S.finished(theirs);
    const b: string[] = [];
    const ours = sink(S, b);
    F.Readable.from(["y"]).pipe(ours);
    await theirFinished(ours);
    expect([a, b]).toEqual([["x"], ["y"]]);
  });

  it("compose, Duplex.from and Readable.from accept their streams", async () => {
    const composed = S.compose(upper(F), upper(S));
    composed.end("c");
    const fromDuplex = S.Duplex.from(F.Readable.from(["d"]));
    const fromReadable = S.Readable.from(F.Readable.from(["e"]));
    const out: unknown[] = [];
    for (const stream of [composed, fromDuplex, fromReadable]) {
      for await (const chunk of stream) {
        out.push(chunk);
      }
    }
    expect(out).toEqual(["C", "d", "e"]);
  });

  it("recognises their streams by protocol, not by class", () => {
    const readable = F.Readable.from(["a"]);
    const transform = upper(F);
    expect([
      S.isStream(readable),
      S.isReadable(readable),
      S.isWritable(sink(F, [])),
      S.isDuplex(transform),
      S.isTransform(transform),
      S.isErrored(readable)
    ]).toEqual([true, true, true, true, true, false]);
    expect(readable instanceof S.Readable).toBe(false);
  });

  it("addAbortSignal destroys their stream", async () => {
    const controller = new AbortController();
    const readable = S.addAbortSignal(controller.signal, new F.Readable({ read() {} }));
    const errored = new Promise(resolve => readable.on("error", resolve));
    controller.abort();
    expect(await errored).toMatchObject({ name: "AbortError" });
    expect(readable.destroyed).toBe(true);
  });

  it("the Web conversions accept their streams", async () => {
    const chunks: unknown[] = [];
    for await (const chunk of S.readableToWeb(F.Readable.from(["a", "b"]))) {
      chunks.push(chunk);
    }
    const written: string[] = [];
    const writer = S.writableToWeb(sink(F, written)).getWriter();
    await writer.write("q");
    await writer.close();
    expect([chunks, written]).toEqual([["a", "b"], ["q"]]);
  });

  it("text() and streamToString read their byte streams", async () => {
    const bytes = (): unknown => F.Readable.from([new TextEncoder().encode("hi")]);
    expect([await S.text(bytes()), await S.streamToString(bytes())]).toEqual(["hi", "hi"]);
  });
});

/** Compiled against the Node entry's declarations; never run. */
async function typedNodeEntry(): Promise<void> {
  const out: string[] = [];
  await nodeEntry.pipeline(RS.Readable.from(["a"]), theirUpper(), theirSink(out));
  await nodeEntry.finished(theirSink(out));
  const composed: nodeEntry.Duplex = nodeEntry.compose(theirUpper(), new nodeEntry.PassThrough());
  const typed = nodeEntry.compose<string, number>(theirUpper(), async function* (source) {
    for await (const chunk of source) {
      yield String(chunk).length;
    }
  });
  const length: number | null = typed.read();
  // Still what node:stream's own APIs and NodeJS.* parameters accept.
  const asNative: nodeStream.Duplex = typed;
  const asReadWrite: NodeJS.ReadWriteStream = typed;
  await nativePipeline(typed, new nodeEntry.PassThrough());
  await nativePipeline(RS.Readable.from(["a"]), typed);
  void [asNative, asReadWrite];
  const duplex: nodeEntry.Duplex = nodeEntry.Duplex.from(RS.Readable.from(["a"]));
  const web: ReadableStream = nodeEntry.readableToWeb(RS.Readable.from(["a"]));
  const sink: WritableStream = nodeEntry.writableToWeb(theirSink(out));
  const text: string = await nodeEntry.text(RS.Readable.from([new Uint8Array(1)]));
  const flags: boolean[] = [
    nodeEntry.isReadable(RS.Readable.from(["a"])),
    nodeEntry.isStream(theirSink(out)),
    nodeEntry.isTransform(theirUpper())
  ];
  RS.Readable.from(["a"]).pipe(new nodeEntry.PassThrough());
  void [composed, typed, length, duplex, web, sink, text, flags];
}

/** Compiled against the browser entry's declarations; never run. */
async function typedBrowserEntry(): Promise<void> {
  const out: string[] = [];
  await browserEntry.pipeline(RS.Readable.from(["a"]), theirUpper(), theirSink(out));
  await browserEntry.finished(theirSink(out));
  const composed: browserEntry.Duplex = browserEntry.compose(
    theirUpper(),
    new browserEntry.PassThrough()
  );
  const typed = browserEntry.compose<string, number>(theirUpper(), async function* (source) {
    for await (const chunk of source) {
      yield String(chunk).length;
    }
  });
  const length: number | null = typed.read();
  const duplex: browserEntry.Duplex = browserEntry.Duplex.from(RS.Readable.from(["a"]));
  const web: ReadableStream = browserEntry.readableToWeb(RS.Readable.from(["a"]));
  const sink: WritableStream = browserEntry.writableToWeb(theirSink(out));
  const text: string = await browserEntry.text(RS.Readable.from([new Uint8Array(1)]));
  const flags: boolean[] = [
    browserEntry.isReadable(RS.Readable.from(["a"])),
    browserEntry.isStream(theirSink(out)),
    browserEntry.isTransform(theirUpper())
  ];
  RS.Readable.from(["a"]).pipe(new browserEntry.PassThrough());
  void [composed, typed, length, duplex, web, sink, text, flags];
}

void typedNodeEntry;
void typedBrowserEntry;
