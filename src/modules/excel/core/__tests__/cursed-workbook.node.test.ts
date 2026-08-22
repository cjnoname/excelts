/**
 * Regression tests for malformed ("cursed") xlsx workbooks.
 *
 * Two layered fixes are exercised:
 *
 * 1. Robust binding of `<sheet>` declarations to worksheet parts
 *    (the actual root cause):
 *      - the relationships namespace prefix is whatever the workbook
 *        root binds, not hard-coded to `r`;
 *      - rel.Target is normalised through `resolveRelTarget` so that
 *        absolute (`/xl/...`) and dotted (`./...`) targets resolve to
 *        the same canonical zip path the reader uses.
 *
 * 2. Strict OOXML semantics in `WorkbookXform.reconcile`: any
 *    `xl/worksheets/sheetN.xml` part the reader picked up that the
 *    workbook's `<sheets>` element does not bind through a working
 *    rel is dropped. This prevents downstream `_worksheets[undefined]`
 *    corruption and follows the OOXML rule that `<sheets>` is the
 *    authoritative list of worksheets in the workbook.
 *
 * `Workbook.set model` additionally drops worksheet models with no
 * `id` to keep that public API's invariant (no `_worksheets[undefined]`
 * key) intact regardless of caller input.
 */

import { writeFile } from "node:fs/promises";

import { createZip } from "@archive/zip/zip-bytes";
import { getWorksheets } from "@excel/core/workbook";
import { Cell, Workbook } from "@excel/index";
import { testFilePath } from "@test/utils";
import { describe, expect, it } from "vitest";

const enc = (s: string) => new TextEncoder().encode(s);

const CONTENT_TYPES_BASE = (sheets: number) => {
  const overrides = Array.from(
    { length: sheets },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${overrides}
</Types>`;
};

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const sheetXml = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row>
  </sheetData>
</worksheet>`;

describe("robust <sheet>↔worksheet binding", () => {
  it("binds <sheet> when the relationships prefix is not 'r'", async () => {
    // Workbook root binds the OOXML relationships namespace to the
    // prefix `rel`. The reader must follow the prefix declared on the
    // root and resolve `rel:id` rather than miss the binding.
    const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Real Name" sheetId="1" rel:id="rId1"/>
  </sheets>
</workbook>`;
    const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    const zipBytes = await createZip([
      { name: "[Content_Types].xml", data: enc(CONTENT_TYPES_BASE(1)) },
      { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
      { name: "xl/workbook.xml", data: enc(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: enc(WORKBOOK_RELS_XML) },
      { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml("named")) }
    ]);

    const filePath = testFilePath("cursed-workbook-alt-prefix");
    await writeFile(filePath, zipBytes);

    const wb = Workbook.create();
    await Workbook.readFile(wb, filePath);

    const ws = Workbook.getWorksheet(wb, "Real Name")!;
    expect(ws).toBeDefined();
    expect(ws!.id).toBe(1);
    expect(Cell.getValue(ws!, "A1")).toBe("named");
  });

  it("binds <sheet> when rel.Target is an absolute /xl/... path", async () => {
    // OPC permits absolute Target URIs; reconcile must canonicalise
    // them to the same zip-entry path the reader keys worksheets by.
    const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Absolute" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
    const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/>
</Relationships>`;

    const zipBytes = await createZip([
      { name: "[Content_Types].xml", data: enc(CONTENT_TYPES_BASE(1)) },
      { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
      { name: "xl/workbook.xml", data: enc(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: enc(WORKBOOK_RELS_XML) },
      { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml("abs-target")) }
    ]);

    const filePath = testFilePath("cursed-workbook-absolute-target");
    await writeFile(filePath, zipBytes);

    const wb = Workbook.create();
    await Workbook.readFile(wb, filePath);

    const ws = Workbook.getWorksheet(wb, "Absolute")!;
    expect(ws).toBeDefined();
    expect(ws!.id).toBe(1);
    expect(Cell.getValue(ws!, "A1")).toBe("abs-target");
  });

  it("binds <sheet> when the workbook declares multiple relationships prefixes", async () => {
    // The OOXML relationships namespace is bound to two prefixes
    // simultaneously and `<sheet>` uses the second one. The reader
    // must accept any prefix bound to that namespace.
    const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
          xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Multi" sheetId="1" rel:id="rId1"/>
  </sheets>
</workbook>`;
    const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    const zipBytes = await createZip([
      { name: "[Content_Types].xml", data: enc(CONTENT_TYPES_BASE(1)) },
      { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
      { name: "xl/workbook.xml", data: enc(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: enc(WORKBOOK_RELS_XML) },
      { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml("multi")) }
    ]);

    const filePath = testFilePath("cursed-workbook-multi-prefix");
    await writeFile(filePath, zipBytes);

    const wb = Workbook.create();
    await Workbook.readFile(wb, filePath);

    const ws = Workbook.getWorksheet(wb, "Multi")!;
    expect(ws).toBeDefined();
    expect(ws!.id).toBe(1);
    expect(Cell.getValue(ws!, "A1")).toBe("multi");
  });

  it("binds <sheet> when rel.Target uses a relative './' prefix", async () => {
    // Some third-party producers emit `./worksheets/sheet1.xml`. The
    // old hand-rolled normaliser produced `xl/./worksheets/sheet1.xml`,
    // which never matched the worksheetHash. resolveRelTarget collapses
    // `.` segments.
    const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="DotSlash" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
    const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="./worksheets/sheet1.xml"/>
</Relationships>`;

    const zipBytes = await createZip([
      { name: "[Content_Types].xml", data: enc(CONTENT_TYPES_BASE(1)) },
      { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
      { name: "xl/workbook.xml", data: enc(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: enc(WORKBOOK_RELS_XML) },
      { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml("dot-slash")) }
    ]);

    const filePath = testFilePath("cursed-workbook-dotslash-target");
    await writeFile(filePath, zipBytes);

    const wb = Workbook.create();
    await Workbook.readFile(wb, filePath);

    const ws = Workbook.getWorksheet(wb, "DotSlash")!;
    expect(ws).toBeDefined();
    expect(ws!.id).toBe(1);
    expect(Cell.getValue(ws!, "A1")).toBe("dot-slash");
  });
});

describe("strict <sheets> as authoritative list", () => {
  it("drops a worksheet part that <sheets> never declares", async () => {
    // workbook.xml has empty <sheets/> — the worksheet part exists in
    // the zip but is not a member of the workbook per OOXML. The
    // reader must not surface it under a synthesised key, which is
    // what produced `_worksheets[undefined]`.
    const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets/>
</workbook>`;
    const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

    const zipBytes = await createZip([
      { name: "[Content_Types].xml", data: enc(CONTENT_TYPES_BASE(1)) },
      { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
      { name: "xl/workbook.xml", data: enc(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: enc(WORKBOOK_RELS_XML) },
      { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml("hello")) }
    ]);

    const filePath = testFilePath("cursed-workbook-empty-sheets");
    await writeFile(filePath, zipBytes);

    const wb = Workbook.create();
    await Workbook.readFile(wb, filePath);

    const internal = wb as unknown as { _worksheets: unknown[] };
    expect(Object.keys(internal._worksheets)).not.toContain("undefined");
    expect(getWorksheets(wb)).toEqual([]);
  });

  it("drops a worksheet part whose <sheet> rId references no rel", async () => {
    // The <sheet> declaration is present but its r:id points at a
    // missing rel — there is no working binding to a part. With
    // strict semantics the part is not a workbook member.
    const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Real Name" sheetId="42" r:id="rIdMissing"/>
  </sheets>
</workbook>`;
    const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

    const zipBytes = await createZip([
      { name: "[Content_Types].xml", data: enc(CONTENT_TYPES_BASE(1)) },
      { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
      { name: "xl/workbook.xml", data: enc(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: enc(WORKBOOK_RELS_XML) },
      { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml("orphan")) }
    ]);

    const filePath = testFilePath("cursed-workbook-bad-rid");
    await writeFile(filePath, zipBytes);

    const wb = Workbook.create();
    await Workbook.readFile(wb, filePath);

    const internal = wb as unknown as { _worksheets: unknown[] };
    expect(Object.keys(internal._worksheets)).not.toContain("undefined");
    expect(getWorksheets(wb)).toEqual([]);
  });

  it("keeps declared sheets, drops undeclared ones in a mixed package", async () => {
    // Two parts on disk: only sheet1 is declared. sheet2 is a foreign
    // part that does not belong to this workbook.
    const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Declared" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
    const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    const zipBytes = await createZip([
      { name: "[Content_Types].xml", data: enc(CONTENT_TYPES_BASE(2)) },
      { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
      { name: "xl/workbook.xml", data: enc(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: enc(WORKBOOK_RELS_XML) },
      { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml("declared")) },
      { name: "xl/worksheets/sheet2.xml", data: enc(sheetXml("foreign")) }
    ]);

    const filePath = testFilePath("cursed-workbook-mixed");
    await writeFile(filePath, zipBytes);

    const wb = Workbook.create();
    await Workbook.readFile(wb, filePath);

    expect(getWorksheets(wb)).toHaveLength(1);
    const declared = Workbook.getWorksheet(wb, "Declared")!;
    expect(declared).toBeDefined();
    expect(declared!.id).toBe(1);
    expect(Cell.getValue(declared!, "A1")).toBe("declared");

    const internal = wb as unknown as { _worksheets: unknown[] };
    expect(Object.keys(internal._worksheets)).not.toContain("undefined");
  });

  it("drops a worksheet whose <sheet sheetId> is not a positive integer", async () => {
    // OOXML requires `sheetId` to be a positive integer. Anything
    // else (empty string, alphabetic, zero, negative) used to flow
    // through `parseInt` and seed `_worksheets["NaN"]` — the same
    // family of bug as `_worksheets["undefined"]`.
    const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Bogus" sheetId="abc" r:id="rId1"/>
  </sheets>
</workbook>`;
    const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    const zipBytes = await createZip([
      { name: "[Content_Types].xml", data: enc(CONTENT_TYPES_BASE(1)) },
      { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
      { name: "xl/workbook.xml", data: enc(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: enc(WORKBOOK_RELS_XML) },
      { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml("bogus-id")) }
    ]);

    const filePath = testFilePath("cursed-workbook-bogus-sheetid");
    await writeFile(filePath, zipBytes);

    const wb = Workbook.create();
    await Workbook.readFile(wb, filePath);

    expect(getWorksheets(wb)).toEqual([]);
    const internal = wb as unknown as { _worksheets: unknown[] };
    const keys = Object.keys(internal._worksheets);
    expect(keys).not.toContain("NaN");
    expect(keys).not.toContain("undefined");
  });

  it("drops a worksheet whose rel.Target points at a non-existent part", async () => {
    // The rel exists but points at a sheet999.xml that is not in the
    // package; no part can be bound to the declaration. Symmetrically,
    // sheet1.xml is in the package but no <sheet> claims it.
    const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Phantom" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
    const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet999.xml"/>
</Relationships>`;

    const zipBytes = await createZip([
      { name: "[Content_Types].xml", data: enc(CONTENT_TYPES_BASE(1)) },
      { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
      { name: "xl/workbook.xml", data: enc(WORKBOOK_XML) },
      { name: "xl/_rels/workbook.xml.rels", data: enc(WORKBOOK_RELS_XML) },
      { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml("phantom-target")) }
    ]);

    const filePath = testFilePath("cursed-workbook-phantom-target");
    await writeFile(filePath, zipBytes);

    const wb = Workbook.create();
    await Workbook.readFile(wb, filePath);

    expect(getWorksheets(wb)).toEqual([]);
    const internal = wb as unknown as { _worksheets: unknown[] };
    expect(Object.keys(internal._worksheets)).not.toContain("undefined");
  });
});
