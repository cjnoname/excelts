import { extractAll } from "@archive/unzip/extract";
/**
 * Conditional formatting.
 *
 * **A rule's shape is decided by a *pair* of enumerations, and that is the thing worth testing.** `iType`
 * says how the formatting is drawn and `iTemplate` says what the condition is; MS-XLSB lists the legal
 * combinations and states that "other combinations MUST NOT be used". Getting the pair wrong is silent —
 * a `containsText` rule written as `CF_TYPE_CELLIS` is read as a value comparison against the search
 * string — so every mapping below is asserted against the specification's own table.
 */
import { Workbook, Worksheet } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { borderStyleValue } from "@excel/xlsb/border";
import { collectDxfs, conditionalFormattingRecords } from "@excel/xlsb/conditional-format";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** One rule's `BrtBeginCFRule` payload, or `undefined` when it was refused. */
function ruleOf(rule: Record<string, unknown>): DataView | undefined {
  let priority = 0;
  const built = conditionalFormattingRecords(
    [{ ref: "A1:A3", rules: [rule] } as never],
    collectDxfs([]),
    { sheetNames: ["S"] },
    () => ++priority
  );
  const found = built.records.find(entry => recordSpec(entry.id)?.name === "BrtBeginCFRule");
  return found?.payload === undefined
    ? undefined
    : new DataView(found.payload.buffer, found.payload.byteOffset);
}

describe("the iType/iTemplate pair", () => {
  it("maps cellIs to CELLIS + EXPR, with the operator in iParam", () => {
    // `CFOper` starts at **1**, not 0 — so `equal` is 3, and an off-by-one here turns "greater than" into
    // "not equal".
    const view = ruleOf({ type: "cellIs", operator: "greaterThan", formulae: ["3"] })!;
    expect(view.getUint32(0, true)).toBe(1); // CF_TYPE_CELLIS
    expect(view.getUint32(4, true)).toBe(0x00); // CF_TEMPLATE_EXPR
    expect(view.getUint32(16, true)).toBe(5); // CF_OPER_GT
  });

  it("maps expression to EXPRIS + FMLA", () => {
    const view = ruleOf({ type: "expression", formulae: ["A1>0"] })!;
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getUint32(4, true)).toBe(0x01);
  });

  it("folds the five containsText conditions onto five different templates", () => {
    // The model has one type and distinguishes them by `operator`; the record has five templates. Writing
    // one template for all of them makes every blank-or-error rule a text search.
    const template = (operator: string): number =>
      ruleOf({ type: "containsText", operator, text: "x" })!.getUint32(4, true);
    expect(template("containsText")).toBe(0x08);
    expect(template("containsBlanks")).toBe(0x09);
    expect(template("notContainsBlanks")).toBe(0x0a);
    expect(template("containsErrors")).toBe(0x0b);
    expect(template("notContainsErrors")).toBe(0x0c);
  });

  it("maps each time period to its own template, and repeats it in iParam", () => {
    // `iParam` for a time-period rule is a `CFDateOper` that MUST equal the template — the specification
    // says so for each of the twelve, which is why one value serves both.
    for (const [period, template] of [
      ["today", 0x0f],
      ["yesterday", 0x11],
      ["last7Days", 0x12],
      ["thisMonth", 0x18]
    ] as const) {
      const view = ruleOf({ type: "timePeriod", timePeriod: period })!;
      expect(view.getUint32(4, true), period).toBe(template);
      expect(view.getUint32(16, true), period).toBe(template);
    }
  });

  it("derives fAbove from the template rather than from the model", () => {
    // `fAbove` MUST be 1 for the above-average templates and 0 otherwise. Deriving it is what stops the
    // flag and the template contradicting each other.
    expect(ruleOf({ type: "aboveAverage" })!.getUint32(28, true) & (1 << 2)).not.toBe(0);
    expect(
      ruleOf({ type: "aboveAverage", aboveAverage: false })!.getUint32(28, true) & (1 << 2)
    ).toBe(0);
    // And the template itself flips.
    expect(ruleOf({ type: "aboveAverage", aboveAverage: false })!.getUint32(4, true)).toBe(0x1a);
  });

  it("sets fBottom and fPercent only for a filter rule", () => {
    const view = ruleOf({ type: "top10", rank: 5, percent: true, bottom: true })!;
    expect(view.getUint32(0, true)).toBe(5); // CF_TYPE_FILTER
    expect(view.getUint32(28, true) & 0x18).toBe(0x18);
    // For anything else the specification says both MUST be 0 — a `cellIs` rule that happened to carry
    // `bottom: true` must not set them.
    const other = ruleOf({ type: "cellIs", operator: "equal", formulae: ["1"], bottom: true })!;
    expect(other.getUint32(28, true) & 0x18).toBe(0);
  });

  it("writes two formulas for between and one for everything else", () => {
    // `rgce2` exists only for `CF_OPER_BN`/`CF_OPER_NB`; a second stream for any other operator is a
    // record a reader misparses from that point on.
    // Offsets from section 3.1.2's worked example: seven `DWORD`s, a two-byte flag `WORD`, then the three
    // formula lengths at 30, 34 and 38. These read 36 and 28 while the writer had the flags as a `DWORD`,
    // so the test was pinned to the defect and moved with it — the reason a 55-byte record went unnoticed.
    const between = ruleOf({ type: "cellIs", operator: "between", formulae: ["1", "9"] })!;
    expect(between.getUint32(34, true)).toBeGreaterThan(0); // cbfmla2
    const single = ruleOf({ type: "cellIs", operator: "equal", formulae: ["1", "9"] })!;
    expect(single.getUint32(34, true)).toBe(0);
  });

  it("keeps the record at the length its own fields imply", () => {
    // The defect this pins: two surplus flag bytes and a missing trailing `cb` all but cancelled, so a
    // record four bytes short of legal looked two bytes off a plausible total.
    const rule = ruleOf({ type: "cellIs", operator: "greaterThan", formulae: ["15"] })!;
    const cbfmla1 = rule.getUint32(30, true);
    expect(cbfmla1).toBe(3); // PtgInt: one tag byte and a `u16`
    // 28 fixed + 2 flags + 12 lengths + 4 null `strParam` + (`cce` + `rgce` + `cb`)
    expect(rule.byteLength).toBe(46 + 4 + cbfmla1 + 4);
    // `cb` is the last field of a `CFParsedFormula`, not an optional tail.
    expect(rule.getUint32(46 + 4 + cbfmla1, true)).toBe(0);
  });

  it("carries stopIfTrue at bit 1", () => {
    expect(
      ruleOf({ type: "expression", formulae: ["A1"], stopIfTrue: true })!.getUint16(28, true) & 2
    ).not.toBe(0);
  });
});

describe("what it refuses", () => {
  it("writes the three graphical types with the collection each one requires", () => {
    // These used to be refused, because each MUST be followed by a child record and none was emitted. The
    // records and their contents are Excel's, read off an XLSB it produced: the counts below are what it wrote
    // for a two-stop colour scale, a data bar and a three-icon set.
    const shapes = (["colorScale", "dataBar", "iconSet"] as const).map(type => {
      const built = conditionalFormattingRecords(
        [
          {
            ref: "A1:A3",
            rules: [
              {
                type,
                priority: 1,
                cfvo:
                  type === "iconSet"
                    ? [
                        { type: "percent", value: 0 },
                        { type: "percent", value: 33 },
                        { type: "percent", value: 67 }
                      ]
                    : [{ type: "min" }, { type: "max" }],
                ...(type === "colorScale"
                  ? { color: [{ argb: "FFF8696B" }, { argb: "FF63BE7B" }] }
                  : type === "dataBar"
                    ? { color: [{ argb: "FF638EC6" }] }
                    : { iconSet: "3TrafficLights1" })
              }
            ]
          } as never
        ],
        collectDxfs([]),
        { sheetNames: ["S"] },
        () => 1
      );
      expect(built.lost, type).toEqual([]);
      return built.records
        .map(entry => recordSpec(entry.id)?.name)
        .filter(name => name !== undefined && /CFVO|Color$|ColorScale|Databar|IconSet/.test(name));
    });
    expect(shapes[0]).toEqual([
      "BrtBeginColorScale",
      "BrtCFVO",
      "BrtCFVO",
      "BrtColor",
      "BrtColor",
      "BrtEndColorScale"
    ]);
    expect(shapes[1]).toEqual([
      "BrtBeginDatabar",
      "BrtCFVO",
      "BrtCFVO",
      "BrtColor",
      "BrtEndDatabar"
    ]);
    // An icon set has thresholds and no colours: the pictures come from `iSet`.
    expect(shapes[2]).toEqual([
      "BrtBeginIconSet",
      "BrtCFVO",
      "BrtCFVO",
      "BrtCFVO",
      "BrtEndIconSet"
    ]);
  });

  it("writes each graphical record exactly as Excel does", () => {
    // Byte-for-byte against an XLSB Excel produced for the same three rules.
    const bytesOf = (rule: Record<string, unknown>, name: string): Uint8Array => {
      const built = conditionalFormattingRecords(
        [{ ref: "A1:A3", rules: [rule] } as never],
        collectDxfs([]),
        { sheetNames: ["S"] },
        () => 1
      );
      return built.records.find(entry => recordSpec(entry.id)?.name === name)!.payload!;
    };
    const hex = (bytes: Uint8Array): string =>
      [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(" ");

    // `bLenMin` 10, `bLenMax` 90, `fShowValue` 1.
    expect(
      hex(
        bytesOf(
          { type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }] },
          "BrtBeginDatabar"
        )
      )
    ).toBe("0a 5a 01");
    // `iSet` 3 is `KPI3TRAFFICLIGHTS1`; the flag word is clear for icon-and-value in the set's own order.
    expect(
      hex(
        bytesOf(
          {
            type: "iconSet",
            priority: 1,
            iconSet: "3TrafficLights1",
            cfvo: [{ type: "percent", value: 0 }]
          },
          "BrtBeginIconSet"
        )
      )
    ).toBe("03 00 00 00 00 00");
    // A `CFVOMIN` threshold: type 2, no number, and both icon-set booleans clear because this is not one.
    expect(
      hex(bytesOf({ type: "colorScale", priority: 1, cfvo: [{ type: "min" }] }, "BrtCFVO"))
    ).toBe("02 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00");
    // An icon set's threshold: `fSaveGTE` and `fGTE` are 1, which the specification requires of an icon set
    // and of nothing else, and 33 is written as an `Xnum`.
    expect(
      hex(
        bytesOf({ type: "iconSet", priority: 1, cfvo: [{ type: "percent", value: 33 }] }, "BrtCFVO")
      )
    ).toBe("04 00 00 00 00 00 00 00 00 80 40 40 01 00 00 00 01 00 00 00 00 00 00 00");
  });

  it("refuses a block whose range does not decode", () => {
    expect(
      conditionalFormattingRecords(
        [{ ref: "not a range", rules: [{ type: "expression", formulae: ["A1"] }] } as never],
        collectDxfs([]),
        { sheetNames: ["S"] },
        () => 1
      ).lost[0]
    ).toContain("not a range");
  });
});

describe("the dxf table", () => {
  it("deduplicates identical rule styles", () => {
    // Two rules with the same fill share one `BrtDXF`, which is what Excel's own output does — and the
    // index is workbook-wide, so it has to be built before any sheet is written.
    const style = { font: { bold: true } };
    const table = collectDxfs([
      {
        ref: "A1",
        rules: [
          { type: "cellIs", style },
          { type: "cellIs", style }
        ]
      },
      { ref: "B1", rules: [{ type: "cellIs", style: { font: { italic: true } } }] }
    ] as never);
    expect(table.styles).toHaveLength(2);
    expect(table.indexOf(style)).toBe(0);
  });

  it("resolves an unstyled rule to no differential format", () => {
    expect(collectDxfs([]).indexOf(undefined)).toBe(0xffffffff);
  });
});

describe("through a workbook", () => {
  it("writes the records with a workbook-unique priority", async () => {
    // `iPri` "MUST NOT duplicate" another rule's anywhere in the sheet, and the model's priorities are per
    // block and routinely collide — so they are handed out by the writer.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [[1], [5], [9]]);
    Worksheet.addConditionalFormatting(sheet, {
      ref: "A1:A3",
      rules: [
        { type: "cellIs", operator: "greaterThan", formulae: ["3"], priority: 1 },
        { type: "expression", formulae: ["A1<2"], priority: 1 }
      ]
    } as never);
    const parts = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    const priorities = [
      ...iterateInterpretableRecords(parts.get("xl/worksheets/sheet1.bin")!.data, "s")
    ]
      .filter(entry => recordSpec(entry.id)?.name === "BrtBeginCFRule")
      .map(entry =>
        new DataView(entry.payload.buffer, entry.payload.byteOffset).getInt32(12, true)
      );
    expect(priorities).toEqual([1, 2]);
  });

  it("counts the rules it actually wrote", async () => {
    // `ccf` counts the `BrtBeginCFRule` records that follow. A header promising more than follow leaves a
    // reader walking off the end of the collection — so a refused rule has to change the count.
    const built = conditionalFormattingRecords(
      [
        {
          ref: "A1:A3",
          // A rule this writer still cannot express, so the count has to drop to 1. `colorScale` used to serve
          // here and no longer does — it is written now.
          rules: [{ type: "expression", formulae: ["A1"] }, { type: "notAThing" }]
        } as never
      ],
      collectDxfs([]),
      { sheetNames: ["S"] },
      () => 1
    );
    const header = built.records.find(
      entry => recordSpec(entry.id)?.name === "BrtBeginConditionalFormatting"
    )!;
    const payload = header.payload!;
    expect(new DataView(payload.buffer, payload.byteOffset).getUint32(0, true)).toBe(1);
    expect(built.lost).toHaveLength(1);
  });
});

describe("BrtDXF, the differential format a rule applies", () => {
  /** The `BrtDXF` records a workbook's styles part carries. */
  async function dxfsOf(style: Record<string, unknown>): Promise<Uint8Array[]> {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [[1], [9]]);
    Worksheet.addConditionalFormatting(sheet, {
      ref: "A1:A2",
      rules: [{ type: "cellIs", operator: "greaterThan", formulae: ["5"], priority: 1, style }]
    } as never);
    const parts = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    return [...iterateInterpretableRecords(parts.get("xl/styles.bin")!.data, "s")]
      .filter(entry => recordSpec(entry.id)?.name === "BrtDXF")
      .map(entry => entry.payload!);
  }

  /** The `(type, cb)` pairs inside a `BrtDXF`, walked by `cb`. */
  function propsOf(payload: Uint8Array): { type: number; cb: number }[] {
    const view = new DataView(payload.buffer, payload.byteOffset);
    const props: { type: number; cb: number }[] = [];
    // Two flag bytes, then `XFProps`: two reserved and the count.
    let offset = 6;
    while (offset + 4 <= payload.length) {
      const cb = view.getUint16(offset + 2, true);
      props.push({ type: view.getUint16(offset, true), cb });
      if (cb <= 0) {
        break;
      }
      offset += cb;
    }
    return props;
  }

  it("walks cleanly by cb, which is the size of the whole XFProp", async () => {
    // `cb` includes the four-byte header. Writing the blob length instead makes every property after the
    // first land four bytes early — and a reader does not detect that, it reads a plausible type out of the
    // middle of a colour. Asserting the walk *closes* on the payload length is what pins it.
    const [payload] = await dxfsOf({
      font: { bold: true, color: { argb: "FFFF0000" }, size: 14 },
      fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFFF00" } }
    });
    const props = propsOf(payload);
    expect(props).toHaveLength(5);
    expect(6 + props.reduce((total, prop) => total + prop.cb, 0)).toBe(payload.length);
    // And the count in the header agrees with what was walked.
    expect(new DataView(payload.buffer, payload.byteOffset).getUint16(4, true)).toBe(props.length);
  });

  it("writes each facet under the type the specification gives it", async () => {
    const [payload] = await dxfsOf({
      font: {
        bold: true,
        italic: true,
        strike: true,
        name: "Arial",
        color: { argb: "FF00FF00" },
        size: 12
      },
      fill: {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF112233" },
        bgColor: { argb: "FF445566" }
      }
    });
    const types = propsOf(payload).map(prop => prop.type);
    expect(types).toContain(0x00); // fill pattern
    expect(types).toContain(0x01); // foreground colour
    expect(types).toContain(0x02); // background colour
    expect(types).toContain(0x05); // text colour
    expect(types).toContain(0x18); // font name
    expect(types).toContain(0x19); // bold
    expect(types).toContain(0x1c); // italic
    expect(types).toContain(0x1d); // strikethrough
    expect(types).toContain(0x24); // size, in twips
  });

  it("writes Bold as its enumeration, not as a boolean", async () => {
    // `Bold` is 0x0190 normal and 0x02BC bold. A `1` here is neither, and Excel reads it as a font weight
    // of one.
    const view = (payload: Uint8Array): number => {
      const props = propsOf(payload);
      let offset = 6;
      for (const prop of props) {
        if (prop.type === 0x19) {
          return new DataView(payload.buffer, payload.byteOffset).getUint16(offset + 4, true);
        }
        offset += prop.cb;
      }
      return -1;
    };
    expect(view((await dxfsOf({ font: { bold: true } }))[0])).toBe(0x02bc);
    expect(view((await dxfsOf({ font: { bold: false } }))[0])).toBe(0x0190);
  });

  it("writes a font size in twips", async () => {
    // 20 twips to the point, bounded at 20–8191 — so 14 points is 280.
    const [payload] = await dxfsOf({ font: { size: 14 } });
    const props = propsOf(payload);
    let offset = 6;
    for (const prop of props) {
      if (prop.type === 0x24) {
        expect(new DataView(payload.buffer, payload.byteOffset).getUint32(offset + 4, true)).toBe(
          280
        );
        return;
      }
      offset += prop.cb;
    }
    throw new Error("no size property was written");
  });

  it("writes an empty property array for a rule with no style", async () => {
    // A rule can carry no formatting at all, and a `dxfId` then resolves to nothing — but the record still
    // has to be well formed.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [[1]]);
    Worksheet.addConditionalFormatting(sheet, {
      ref: "A1",
      rules: [{ type: "expression", formulae: ["A1"], priority: 1 }]
    } as never);
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const dxfs = [...iterateInterpretableRecords(parts.get("xl/styles.bin")!.data, "s")].filter(
      entry => recordSpec(entry.id)?.name === "BrtDXF"
    );
    // No style means no entry in the table at all — an empty `BrtBeginDXFs` collection is not written.
    expect(dxfs).toHaveLength(0);
  });
});

describe("XFPropBorder — the border a rule applies", () => {
  /** The single `BrtDXF` a one-rule workbook produces. */
  async function dxfOf(style: Record<string, unknown>): Promise<Uint8Array> {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [[1], [9]]);
    Worksheet.addConditionalFormatting(sheet, {
      ref: "A1:A2",
      rules: [{ type: "cellIs", operator: "greaterThan", formulae: ["5"], priority: 1, style }]
    } as never);
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const found = [...iterateInterpretableRecords(parts.get("xl/styles.bin")!.data, "s")].find(
      entry => recordSpec(entry.id)?.name === "BrtDXF"
    );
    return found!.payload!;
  }

  /** The `(type, cb, offset)` triples inside a `BrtDXF`, walked by `cb`. */
  function propsOf(payload: Uint8Array): { type: number; cb: number; offset: number }[] {
    const view = new DataView(payload.buffer, payload.byteOffset);
    const props: { type: number; cb: number; offset: number }[] = [];
    let offset = 6;
    while (offset + 4 <= payload.length) {
      const cb = view.getUint16(offset + 2, true);
      props.push({ type: view.getUint16(offset, true), cb, offset });
      if (cb <= 0) {
        break;
      }
      offset += cb;
    }
    return props;
  }

  it("writes one property per edge, under the type the specification gives it", async () => {
    const payload = await dxfOf({
      border: {
        top: { style: "thin" },
        bottom: { style: "double" },
        left: { style: "medium" },
        right: { style: "dotted" }
      }
    });
    // 0x06 top, 0x07 bottom, 0x08 left, 0x09 right. Types 0x0B and 0x0C are a range's *internal* borders,
    // gated by `fNewBorder`, and a cell style has no such thing — so they must not appear.
    const types = propsOf(payload).map(property => property.type);
    expect(types).toEqual([0x06, 0x07, 0x08, 0x09]);
    expect(types).not.toContain(0x0b);
    expect(types).not.toContain(0x0c);
  });

  it("is ten bytes of colour and line style", async () => {
    // Eight bytes of `XFPropColor` then a two-byte `dgBorder`, so `cb` is 14 with the four-byte header.
    const payload = await dxfOf({ border: { top: { style: "thin" } } });
    const [property] = propsOf(payload);
    expect(property.cb).toBe(14);
    // And the walk closes exactly on the payload, which is what catches a `cb` written as the blob length.
    expect(6 + property.cb).toBe(payload.length);
  });

  it("writes dgBorder from the same table a BrtBorder edge uses", async () => {
    // `thin` is 1 and `double` is 6 in the record's own order. A second copy of those fourteen names in a
    // second order is how one of the two places ends up writing `medium` for a caller who asked for `thin`,
    // so the value is asserted against `borderStyleValue` rather than against a literal repeated here.
    const payload = await dxfOf({
      border: { top: { style: "thin" }, bottom: { style: "double" } }
    });
    const view = new DataView(payload.buffer, payload.byteOffset);
    const styleAt = (type: number): number => {
      const property = propsOf(payload).find(entry => entry.type === type)!;
      // The colour occupies the first eight bytes of the blob.
      return view.getUint16(property.offset + 4 + 8, true);
    };
    expect(styleAt(0x06)).toBe(borderStyleValue("thin"));
    expect(styleAt(0x07)).toBe(borderStyleValue("double"));
    expect(styleAt(0x06)).toBe(1);
    expect(styleAt(0x07)).toBe(6);
  });

  it("sets fNewBorder, which permits internal borders rather than claiming one", async () => {
    // Bit 15 of the leading word. This asserted the opposite, reading the flag as "an internal border is
    // present" — MS-XLSB 2.4.359 defines it as whether the inner-border `XFProp` types `0x0B` and `0x0C`
    // *can* be used, and 0 forbids them. Excel sets it on every `BrtDXF` it writes.
    const payload = await dxfOf({ border: { top: { style: "thin" } } });
    expect(new DataView(payload.buffer, payload.byteOffset).getUint16(0, true)).toBe(0x8000);
  });

  it("orders every property by type", async () => {
    // Not required by the specification — it constrains which types may coexist, not their sequence — but
    // Excel writes an enumerated property array in type order, and a needless deviation is one more thing a
    // reader could be strict about. Borders sit at 0x06–0x09, below bold at 0x19, so an unsorted array is
    // visibly unsorted here.
    const payload = await dxfOf({
      border: { top: { style: "thin" }, bottom: { style: "double" } },
      font: { bold: true, italic: true, size: 12 },
      fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFFF00" } }
    });
    const types = propsOf(payload).map(property => property.type);
    expect(types).toEqual([...types].sort((left, right) => left - right));
    expect(types).toEqual([0x00, 0x02, 0x06, 0x07, 0x19, 0x1c, 0x24]);
  });

  it("no longer reports a loss for a rule that carries a border", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [[1]]);
    Worksheet.addConditionalFormatting(sheet, {
      ref: "A1",
      rules: [
        {
          type: "cellIs",
          operator: "greaterThan",
          formulae: ["0"],
          style: { border: { top: { style: "thin" } } }
        }
      ]
    } as never);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
  });
});

/**
 * The three graphical rules, read back.
 *
 * **This gate exists because implementing only the writer left the reader dropping them**, and the existing
 * read-write symmetry test did not notice: a workbook came out of `toBuffer` with a colour scale in it and came
 * back from `read` without one. The rule record has no room for the thresholds or the colours — they are in the
 * collection that follows it — so a reader that skips the collection turns a colour scale into a rule with no
 * scale, which is worse than the refusal it replaced.
 */
describe("the graphical rules survive a round trip", () => {
  it("keeps every threshold, colour and icon set", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Graphical");
    Worksheet.addAoa(sheet, [["n"], [1], [2], [3]]);
    Worksheet.addConditionalFormatting(sheet, {
      ref: "A2:A4",
      rules: [
        {
          type: "colorScale",
          priority: 1,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: [{ argb: "FFF8696B" }, { argb: "FF63BE7B" }]
        },
        {
          type: "dataBar",
          priority: 2,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: [{ argb: "FF638EC6" }]
        },
        {
          type: "iconSet",
          priority: 3,
          iconSet: "3TrafficLights1",
          cfvo: [
            { type: "percent", value: 0 },
            { type: "percent", value: 33 },
            { type: "percent", value: 67 }
          ]
        }
      ]
    } as never);

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const rules = (
      Worksheet.getModel(Workbook.getWorksheet(reopened, "Graphical")!) as unknown as {
        conditionalFormattings?: readonly { rules?: readonly Record<string, unknown>[] }[];
      }
    ).conditionalFormattings?.flatMap(block => block.rules ?? []);

    expect(rules?.map(rule => rule.type)).toEqual(["colorScale", "dataBar", "iconSet"]);
    // `min` and `max` carry no number, which the specification says is undefined for them — so reporting one
    // would invent a threshold the file does not state.
    expect(rules?.[0]?.cfvo).toEqual([{ type: "min" }, { type: "max" }]);
    expect(rules?.[0]?.color).toEqual([{ argb: "FFF8696B" }, { argb: "FF63BE7B" }]);
    // Excel's data bar defaults, which the record carries explicitly.
    expect(rules?.[1]).toMatchObject({ minLength: 10, maxLength: 90, showValue: true });
    expect(rules?.[2]).toMatchObject({ iconSet: "3TrafficLights1" });
    expect(rules?.[2]?.cfvo).toEqual([
      { type: "percent", value: 0 },
      { type: "percent", value: 33 },
      { type: "percent", value: 67 }
    ]);
  });
});
