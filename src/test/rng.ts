/**
 * Deterministic RNG for tests.
 *
 * Mulberry32, which had been copied five times across this repository — twice in
 * tests, once in `csv/utils/generate.ts`, and twice more in examples — with the
 * two test copies exposing slightly different helpers and one of them seeding with
 * `| 0` where the other used `>>> 0`. That difference is invisible until a seed
 * above 2^31 produces two different sequences from what reads as the same
 * generator, which is the sort of thing that makes a "deterministic" fuzz failure
 * unreproducible.
 *
 * The seed is fixed by the caller, never by the clock: the house style for
 * property tests here is a literal list of seeds so a failure names the input that
 * produced it and re-running reproduces it exactly.
 */

export interface Rng {
  /** Uniform in `[0, 1)`. */
  next(): number;
  /** Uniform integer in `[min, max]`, inclusive. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  bool(p?: number): boolean;
  /** A uniformly chosen element. Throws on an empty array, rather than `undefined`. */
  pick<T>(values: readonly T[]): T;
  /** `count` bytes, uniform over 0–255. */
  bytes(count: number): Uint8Array;
}

export function createRng(seed: number): Rng {
  // `>>> 0` rather than `| 0`: the state is an unsigned 32-bit accumulator, and
  // seeding it as signed makes seeds above 2^31 diverge from the same seed written
  // as unsigned.
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    bool: (p = 0.5) => next() < p,
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) {
        throw new RangeError("cannot pick from an empty array");
      }
      return values[int(0, values.length - 1)]!;
    },
    bytes(count: number): Uint8Array {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        out[i] = int(0, 255);
      }
      return out;
    }
  };
}
