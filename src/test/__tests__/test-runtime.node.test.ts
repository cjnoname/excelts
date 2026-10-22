/**
 * A CI job that names a runtime must actually run its tests there.
 *
 * `bun run vitest run` does not: vitest's bin starts with `#!/usr/bin/env node`,
 * and `bun run` honours the shebang, so the "Bun" job ran every test in Node
 * for as long as it existed. `bun --bun` is what makes Bun the runtime. The job
 * sets `EXPECTED_TEST_RUNTIME` and this fails if the suite is somewhere else.
 */

import { describe, expect, it } from "vitest";

const expected = process.env.EXPECTED_TEST_RUNTIME;

describe("test runtime", () => {
  it.runIf(expected)(`is ${expected}`, () => {
    expect("Bun" in globalThis ? "bun" : "node").toBe(expected);
  });
});
