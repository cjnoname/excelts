import { describe, it, expect } from "vitest";
import { SharedStrings } from "../../../utils/shared-strings.js";

describe("SharedStrings", () => {
  it("Stores and shares string values", () => {
    const ss = new SharedStrings();

    const iHello = ss.add("Hello");
    const iHelloV2 = ss.add("Hello");
    const iGoodbye = ss.add("Goodbye");

    expect(iHello).toBe(iHelloV2);
    expect(iGoodbye).not.toBe(iHelloV2);

    expect(ss.count).toBe(2);
    expect(ss.totalRefs).toBe(3);
  });

  it("Does not escape values", () => {
    // that's the job of the xml utils
    const ss = new SharedStrings();

    const iXml = ss.add("<tag>value</tag>");
    const iAmpersand = ss.add("&");

    expect(ss.getString(iXml)).toBe("<tag>value</tag>");
    expect(ss.getString(iAmpersand)).toBe("&");
  });
});
