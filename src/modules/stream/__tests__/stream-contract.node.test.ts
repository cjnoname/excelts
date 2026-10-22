/**
 * The module contract (stream-contract.shared.ts) against both entries, as
 * `browser/stream-contract.test.ts` runs it in a real browser, plus what only
 * the Node entry can do with a Web stream.
 */

import * as nodeStream from "node:stream";
import { runInNewContext } from "node:vm";

import {
  emitted,
  runBrowserKernelContractTests,
  runStreamContractTests,
  webSource
} from "@stream/__tests__/stream-contract.shared";
import * as nodeEntry from "@stream/index";
import * as browserEntry from "@stream/index.browser";
import { adoptThenables, rejectedDuplexBody } from "@stream/kernel/duplexify";
import { describe, it } from "vitest";

type Api = any;

const entries = [
  ["node entry", nodeEntry],
  ["browser entry", browserEntry]
] as const;

describe.each(entries)("module contract (%s)", (_n, S: Api) => {
  runStreamContractTests(S);
});

describe("browser kernel contract", () => {
  runBrowserKernelContractTests(browserEntry);
});

describe("finished() on a Web stream (node entry)", () => {
  it("observes any Web stream without locking it", async () => {
    const rs = webSource([1]);
    const done = nodeEntry.finished(rs);
    const reader = rs.getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    await done;
  });
});

describe.each(entries)("createTransform with a promise from another realm (%s)", (_n, S: Api) => {
  it("awaits it rather than pushing the promise", async () => {
    // A promise from a vm context, an iframe or a worker bridge is not an
    // instance of this realm's Promise.
    const ForeignPromise = runInNewContext("Promise") as PromiseConstructor;
    expect(ForeignPromise.resolve(1) instanceof Promise).toBe(false);
    const transform = S.createTransform((n: number) => ForeignPromise.resolve(n * 2), {
      objectMode: true
    });
    transform.end(3);
    expect(await emitted(transform)).toEqual([6]);
  });

  it("fails the stream with a rejection from another realm", async () => {
    const ForeignPromise = runInNewContext("Promise") as PromiseConstructor;
    const transform = S.createTransform(() => ForeignPromise.reject(new Error("foreign")), {
      objectMode: true
    });
    transform.end(1);
    await expect(emitted(transform)).rejects.toThrow("foreign");
  });
});

/**
 * pipeline checks every stage with `rejectedDuplexBody` before converting any,
 * then converts with `Duplex.from(adoptThenables(stage))`. The check must
 * accept exactly what the conversion accepts — for the kernel's `Duplex.from`
 * and for Node's, which the Node entry's pipeline uses — or a stage the check
 * let through fails mid-conversion, with earlier stages already converted and
 * owned by nobody. One case per branch of `duplexify`.
 */
describe.each([
  ["kernel", browserEntry],
  ["node:stream", nodeStream]
] as const)("the stage check agrees with Duplex.from (%s)", (_n, S: Api) => {
  const writable = (): unknown =>
    new S.Writable({
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      }
    });
  const handled = (promise: Promise<unknown>): Promise<unknown> => {
    promise.catch(() => {});
    return promise;
  };
  const bodies: Record<string, () => unknown> = {
    number: () => 5,
    string: () => "abc",
    null: () => null,
    undefined: () => undefined,
    boolean: () => true,
    symbol: () => Symbol("s"),
    bigint: () => 10n,
    "plain object": () => ({}),
    array: () => [1, 2],
    Set: () => new Set([1]),
    "async iterable": () => ({ async *[Symbol.asyncIterator]() {} }),
    "async generator function": () => async function* () {},
    promise: () => Promise.resolve(1),
    "rejected promise": () => handled(Promise.reject(new Error("x"))),
    "thenable calling back later": () => ({
      then(resolve: () => void) {
        setTimeout(resolve, 0);
      }
    }),
    "thenable calling back at once": () => ({
      then(resolve: () => void) {
        resolve();
      }
    }),
    Blob: () => new Blob(["a"]),
    Uint8Array: () => new Uint8Array(2),
    ArrayBuffer: () => new ArrayBuffer(2),
    Date: () => new Date(),
    Error: () => new Error("e"),
    ReadableStream: () => new ReadableStream(),
    WritableStream: () => new WritableStream(),
    TransformStream: () => new TransformStream(),
    "Web pair": () => ({ readable: new ReadableStream(), writable: new WritableStream() }),
    "Node Readable": () => S.Readable.from([1]),
    "Node Writable": writable,
    "Node Duplex": () => new S.PassThrough(),
    "Node pair": () => ({ readable: S.Readable.from([1]), writable: writable() }),
    "readable side only": () => ({ readable: S.Readable.from([1]) }),
    "writable side only": () => ({ writable: writable() }),
    "null side": () => ({ readable: null }),
    "Web readable side": () => ({ readable: new ReadableStream() }),
    "array side": () => ({ readable: [1] }),
    "promise side": () => ({ readable: Promise.resolve(1) }),
    "thenable-at-once side": () => ({
      readable: {
        then(resolve: () => void) {
          resolve();
        }
      }
    }),
    "function side": () => ({ writable: async function* () {} }),
    "number side": () => ({ writable: 5 }),
    "string side": () => ({ readable: "abc" }),
    "object side": () => ({ readable: {} }),
    "nested invalid side": () => ({ readable: { readable: 5 } }),
    "false and object sides": () => ({ writable: false, readable: {} })
  };

  it.each(Object.keys(bodies))("%s", name => {
    const accepted = rejectedDuplexBody(bodies[name]()) === undefined;
    let converted: string;
    try {
      const duplex = S.Duplex.from(adoptThenables(bodies[name]()));
      duplex?.on?.("error", () => {});
      duplex?.destroy?.();
      converted = "accepted";
    } catch (error) {
      converted = `rejected: ${(error as Error).message}`;
    }
    expect(converted).toEqual(accepted ? "accepted" : expect.stringMatching(/^rejected: /));
  });
});
