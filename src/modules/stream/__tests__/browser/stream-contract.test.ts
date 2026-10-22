/**
 * The stream module's Web-boundary contract, in a real browser: the same
 * suite the Node tests run against both entries, here against the entry a
 * browser bundle actually gets.
 */

import * as S from "@stream";
import {
  runBrowserKernelContractTests,
  runStreamContractTests
} from "@stream/__tests__/stream-contract.shared";
import { describe } from "vitest";

describe("stream module contract (browser)", () => {
  runStreamContractTests(S);
});

describe("browser kernel contract (browser)", () => {
  runBrowserKernelContractTests(S);
});
