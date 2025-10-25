import { describe, it, expect } from "vitest";
import { Range } from "../../../doc/range.js";

describe("Range", () => {
  function check(
    d: Range,
    range: string,
    $range: string,
    tl: string,
    $t$l: string,
    br: string,
    $b$r: string,
    top: number,
    left: number,
    bottom: number,
    right: number,
    sheetName?: string
  ) {
    expect(d.range).toBe(range);
    expect(d.$range).toBe($range);
    expect(d.tl).toBe(tl);
    expect(d.$t$l).toBe($t$l);
    expect(d.br).toBe(br);
    expect(d.$b$r).toBe($b$r);
    expect(d.top).toBe(top);
    expect(d.left).toBe(left);
    expect(d.bottom).toBe(bottom);
    expect(d.right).toBe(right);
    expect(d.toString()).toBe(range);
    expect(d.sheetName).toBe(sheetName);
  }

  it("has a valid default value", () => {
    const d = new Range();
    check(d, "A1:A1", "$A$1:$A$1", "A1", "$A$1", "A1", "$A$1", 1, 1, 1, 1);
  });

  it("constructs as expected", () => {
    // check range + rotations
    check(new Range("B5:D10"), "B5:D10", "$B$5:$D$10", "B5", "$B$5", "D10", "$D$10", 5, 2, 10, 4);
    check(new Range("B10:D5"), "B5:D10", "$B$5:$D$10", "B5", "$B$5", "D10", "$D$10", 5, 2, 10, 4);
    check(new Range("D5:B10"), "B5:D10", "$B$5:$D$10", "B5", "$B$5", "D10", "$D$10", 5, 2, 10, 4);
    check(new Range("D10:B5"), "B5:D10", "$B$5:$D$10", "B5", "$B$5", "D10", "$D$10", 5, 2, 10, 4);

    check(
      new Range("G7", "C16"),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );
    check(
      new Range("C7", "G16"),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );
    check(
      new Range("C16", "G7"),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );
    check(
      new Range("G16", "C7"),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );

    check(
      new Range(7, 3, 16, 7),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );
    check(
      new Range(16, 3, 7, 7),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );
    check(
      new Range(7, 7, 16, 3),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );
    check(
      new Range(16, 7, 7, 3),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );

    check(
      new Range([7, 3, 16, 7]),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );
    check(
      new Range([16, 3, 7, 7]),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );
    check(
      new Range([7, 7, 16, 3]),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );
    check(
      new Range([16, 7, 7, 3]),
      "C7:G16",
      "$C$7:$G$16",
      "C7",
      "$C$7",
      "G16",
      "$G$16",
      7,
      3,
      16,
      7
    );

    check(
      new Range("$B$5:$D$10"),
      "B5:D10",
      "$B$5:$D$10",
      "B5",
      "$B$5",
      "D10",
      "$D$10",
      5,
      2,
      10,
      4
    );
    check(
      new Range("blort!$B$5:$D$10"),
      "blort!B5:D10",
      "blort!$B$5:$D$10",
      "B5",
      "$B$5",
      "D10",
      "$D$10",
      5,
      2,
      10,
      4,
      "blort"
    );
  });

  it("expands properly", () => {
    const d = new Range();

    d.expand(1, 1, 1, 3);
    expect(d.tl).toBe("A1");
    expect(d.br).toBe("C1");
    expect(d.toString()).toBe("A1:C1");

    d.expand(1, 3, 3, 3);
    expect(d.tl).toBe("A1");
    expect(d.br).toBe("C3");
    expect(d.toString()).toBe("A1:C3");
  });

  it("doesn't always include the default row/col", () => {
    const d = new Range();

    d.expand(2, 2, 4, 4);
    expect(d.tl).toBe("B2");
    expect(d.br).toBe("D4");
    expect(d.toString()).toBe("B2:D4");
  });

  it("detects intersections", () => {
    const C3F6 = new Range("C3:F6");

    // touching at corners
    expect(C3F6.intersects(new Range("A1:B2"))).toBe(false);
    expect(C3F6.intersects(new Range("G1:H2"))).toBe(false);
    expect(C3F6.intersects(new Range("A7:B8"))).toBe(false);
    expect(C3F6.intersects(new Range("G7:H8"))).toBe(false);

    // Adjacent to edges
    expect(C3F6.intersects(new Range("A1:H2"))).toBe(false);
    expect(C3F6.intersects(new Range("A1:B8"))).toBe(false);
    expect(C3F6.intersects(new Range("G1:H8"))).toBe(false);
    expect(C3F6.intersects(new Range("A7:H8"))).toBe(false);

    // 1 cell margin
    expect(C3F6.intersects(new Range("A1:H1"))).toBe(false);
    expect(C3F6.intersects(new Range("A1:A8"))).toBe(false);
    expect(C3F6.intersects(new Range("G1:G8"))).toBe(false);
    expect(C3F6.intersects(new Range("A8:G8"))).toBe(false);

    // Adjacent at corners
    expect(C3F6.intersects(new Range("A1:B3"))).toBe(false);
    expect(C3F6.intersects(new Range("A1:C2"))).toBe(false);
    expect(C3F6.intersects(new Range("F1:H2"))).toBe(false);
    expect(C3F6.intersects(new Range("G1:H3"))).toBe(false);
    expect(C3F6.intersects(new Range("A6:B8"))).toBe(false);
    expect(C3F6.intersects(new Range("A7:C8"))).toBe(false);
    expect(C3F6.intersects(new Range("F7:H8"))).toBe(false);
    expect(C3F6.intersects(new Range("G6:H8"))).toBe(false);

    // Adjacent at edges
    expect(C3F6.intersects(new Range("A4:B5"))).toBe(false);
    expect(C3F6.intersects(new Range("D1:E2"))).toBe(false);
    expect(C3F6.intersects(new Range("D7:E8"))).toBe(false);
    expect(C3F6.intersects(new Range("G4:H8"))).toBe(false);

    // intersecting at corners
    expect(C3F6.intersects(new Range("A1:C3"))).toBe(true);
    expect(C3F6.intersects(new Range("F1:H3"))).toBe(true);
    expect(C3F6.intersects(new Range("A6:C8"))).toBe(true);
    expect(C3F6.intersects(new Range("F6:H8"))).toBe(true);

    // slice through middle
    expect(C3F6.intersects(new Range("A4:H5"))).toBe(true);
    expect(C3F6.intersects(new Range("D1:E8"))).toBe(true);

    // inside
    expect(C3F6.intersects(new Range("D4:E5"))).toBe(true);

    // outside
    expect(C3F6.intersects(new Range("A1:H8"))).toBe(true);
  });

  it("detects containment", () => {
    const C3F6 = new Range("C3:F6");

    expect(C3F6.contains("A1")).toBe(false);
    expect(C3F6.contains("B2")).toBe(false);
    expect(C3F6.contains("C2")).toBe(false);
    expect(C3F6.contains("D2")).toBe(false);
    expect(C3F6.contains("E2")).toBe(false);
    expect(C3F6.contains("F2")).toBe(false);
    expect(C3F6.contains("G2")).toBe(false);
    expect(C3F6.contains("H1")).toBe(false);
    expect(C3F6.contains("G3")).toBe(false);
    expect(C3F6.contains("G4")).toBe(false);
    expect(C3F6.contains("G5")).toBe(false);
    expect(C3F6.contains("G6")).toBe(false);
    expect(C3F6.contains("G7")).toBe(false);
    expect(C3F6.contains("H7")).toBe(false);
    expect(C3F6.contains("F7")).toBe(false);
    expect(C3F6.contains("E7")).toBe(false);
    expect(C3F6.contains("D7")).toBe(false);
    expect(C3F6.contains("C7")).toBe(false);
    expect(C3F6.contains("B7")).toBe(false);
    expect(C3F6.contains("A8")).toBe(false);
    expect(C3F6.contains("B6")).toBe(false);
    expect(C3F6.contains("B5")).toBe(false);
    expect(C3F6.contains("B4")).toBe(false);
    expect(C3F6.contains("B3")).toBe(false);

    expect(C3F6.contains("C3")).toBe(true);
    expect(C3F6.contains("D3")).toBe(true);
    expect(C3F6.contains("E3")).toBe(true);
    expect(C3F6.contains("F3")).toBe(true);
    expect(C3F6.contains("F4")).toBe(true);
    expect(C3F6.contains("F5")).toBe(true);
    expect(C3F6.contains("F6")).toBe(true);
    expect(C3F6.contains("E6")).toBe(true);
    expect(C3F6.contains("D6")).toBe(true);
    expect(C3F6.contains("C6")).toBe(true);
    expect(C3F6.contains("C5")).toBe(true);
    expect(C3F6.contains("C4")).toBe(true);
    expect(C3F6.contains("D4")).toBe(true);
    expect(C3F6.contains("E4")).toBe(true);
    expect(C3F6.contains("E5")).toBe(true);
    expect(C3F6.contains("D5")).toBe(true);

    expect(C3F6.contains("$A$1")).toBe(false);
    expect(C3F6.contains("$D$5")).toBe(true);

    expect(C3F6.contains("other!$A$1")).toBe(false);
    expect(C3F6.contains("other!$D$5")).toBe(true);

    const otherC3F6 = new Range("other!C3:F6");
    expect(otherC3F6.contains("$A$1")).toBe(false);
    expect(otherC3F6.contains("$D$5")).toBe(true);
    expect(otherC3F6.contains("other!$A$1")).toBe(false);
    expect(otherC3F6.contains("other!$D$5")).toBe(true);
    expect(otherC3F6.contains("blort!$A$1")).toBe(false);
    expect(otherC3F6.contains("blort!$D$5")).toBe(false);
  });
});
