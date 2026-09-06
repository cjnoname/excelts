/**
 * One builder per feature, shared by the examples that write it.
 *
 * **Why the builders are here and not in each example.** The same workbook has to be written to both containers
 * to say anything useful about either, and if each example built its own the two would drift — which is exactly
 * how a defect hides: the XLSX path and the XLSB path stop describing the same workbook and a difference
 * between the outputs stops meaning anything. One builder, two writers, one comparison.
 *
 * Every builder uses the **public API only**, and now that is the whole of it: the two that reached for
 * `Worksheet.getModel` — a frozen pane and an auto-filter — each named the member that would close the gap,
 * and both were added. An example that has to go through the model is a missing public member, not a pattern
 * to copy; treat any future one the same way.
 */
import { Cell, DefinedNames, Form, Sparkline, Table, Workbook, Worksheet } from "@excel/index";

/** A small sheet of numbers every feature can point at. Three regions, a quantity, a date. */
export function sampleSheet(workbook: Workbook.Handle, name = "Data"): Worksheet.Handle {
  const sheet = Workbook.addWorksheet(workbook, name);
  Worksheet.addAoa(sheet, [
    ["Region", "Units", "Sold"],
    ["APAC", 10, new Date(Date.UTC(2024, 0, 15))],
    ["EMEA", 20, new Date(Date.UTC(2024, 1, 20))],
    ["AMER", 30, new Date(Date.UTC(2024, 2, 25))]
  ]);
  return sheet;
}

/** A 1×1 transparent PNG, so no example needs an asset on disk. */
export const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

/**
 * Three conditional-formatting rules on the quantity column: a colour scale, a data bar and an icon set.
 *
 * The three graphical kinds are together because they share `BrtBeginCFRule` and differ only in the child
 * collection — writing one and not the others is how two of them came to be unimplemented while the record
 * looked covered.
 */
export function buildConditionalFormatting(sheet: Worksheet.Handle): void {
  Worksheet.addConditionalFormatting(sheet, {
    ref: "B2:B4",
    rules: [
      {
        type: "colorScale",
        priority: 1,
        cfvo: [{ type: "min" }, { type: "max" }],
        color: [{ argb: "FFF8696B" }, { argb: "FF63BE7B" }]
      }
    ]
  } as never);
  Worksheet.addConditionalFormatting(sheet, {
    ref: "C2:C4",
    rules: [
      {
        type: "dataBar",
        priority: 2,
        cfvo: [{ type: "min" }, { type: "max" }],
        color: { argb: "FF638EC6" }
      }
    ]
  } as never);
  Worksheet.addConditionalFormatting(sheet, {
    ref: "A2:A4",
    rules: [
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
}

/** A list validation and a whole-number range, the two shapes `BrtDVal` encodes differently. */
export function buildDataValidation(sheet: Worksheet.Handle): void {
  // `Cell.setValidation` is the per-cell public path; `DataValidation.add` takes the sheet's validation
  // container rather than the sheet itself.
  Cell.setValidation(sheet, "E2", {
    type: "list",
    allowBlank: true,
    formulae: ['"APAC,EMEA,AMER"'],
    showErrorMessage: true,
    errorTitle: "Pick a region",
    error: "Choose one of the three."
  } as never);
  Cell.setValidation(sheet, "E3", {
    type: "whole",
    operator: "between",
    formulae: [1, 100],
    showInputMessage: true,
    promptTitle: "Units",
    prompt: "Between 1 and 100."
  } as never);
}

/** A threaded-style comment and a plain note — two parts, and only one of them is named by a record. */
export function buildComments(sheet: Worksheet.Handle): void {
  Cell.setComment(sheet, "B2", { texts: [{ text: "Checked against the ledger." }] } as never);
  Cell.setNote(sheet, "B3", "Estimate only." as never);
}

/** An external link, an internal one, and an email — the three destinations `BrtHLink` distinguishes. */
export function buildHyperlinks(sheet: Worksheet.Handle): void {
  Cell.setValue(sheet, "E2", {
    text: "Documentation",
    hyperlink: "https://example.invalid/docs"
  } as never);
  Cell.setValue(sheet, "E3", { text: "Back to A1", hyperlink: "#Data!A1" } as never);
  Cell.setValue(sheet, "E4", {
    text: "Mail us",
    hyperlink: "mailto:hello@example.invalid"
  } as never);
}

/** A table with a header row and a totals row, whose totals formula is a structured reference. */
export function buildTable(sheet: Worksheet.Handle): void {
  Table.add(
    sheet as never,
    {
      name: "Sales",
      ref: "E1",
      headerRow: true,
      totalsRow: true,
      columns: [
        { name: "Item", totalsRowLabel: "Total" },
        { name: "Qty", totalsRowFunction: "sum" }
      ],
      rows: [
        ["Bolt", 4],
        ["Nut", 7],
        ["Washer", 9]
      ]
    } as never
  );
}

/** Two sparkline groups: one taking the default series colour, one stating its own. */
export function buildSparklines(sheet: Worksheet.Handle): void {
  Sparkline.add(sheet, {
    type: "column",
    sparklines: [{ dataRef: "Data!B2:B4", cellRef: "E2" }]
  });
  Sparkline.add(sheet, {
    type: "line",
    markers: true,
    lineColor: "FF638EC6",
    sparklines: [{ dataRef: "Data!B2:B4", cellRef: "E3" }]
  });
}

/** A workbook-scoped name and a sheet-scoped one. */
export function buildDefinedNames(workbook: Workbook.Handle): void {
  const names = Workbook.getDefinedNames(workbook);
  DefinedNames.add(names as never, "Data!$B$2:$B$4", "Quantities");
  DefinedNames.add(names as never, "Data!$B$2", "FirstQuantity");
}

/**
 * A frozen pane: one header row and one label column held in place.
 *
 * This used to go through `getModel`/`setModel` with the OOXML field names, and said so — "a
 * `Worksheet.freeze(sheet, …)` would be the member to add". It was added; this is what an example is for.
 */
export function buildFrozenPane(sheet: Worksheet.Handle): void {
  Worksheet.freeze(sheet, 1, 1);
}

/**
 * An auto-filter over the header row.
 *
 * Likewise `Worksheet.setAutoFilter`, which replaced the `setModel` this used to need.
 */
export function buildAutoFilter(sheet: Worksheet.Handle): void {
  Worksheet.setAutoFilter(sheet, "A1:C4");
}

/**
 * A legacy Form Control checkbox, linked to a cell.
 *
 * Three parts have to line up: an `xl/ctrlProps/ctrlPropN.xml` describing the control, a VML shape that draws
 * it, and a drawing reference from the sheet. XLSB writes the same three as XLSX — the control itself is XML in
 * both containers — so this is a case where the binary format has no work of its own to do beyond pointing at
 * the parts.
 */
export function buildFormControls(sheet: Worksheet.Handle): void {
  Form.addCheckbox(sheet as never, "E2:F3", {
    checked: true,
    link: "G2",
    text: "Shipped"
  } as never);
  Form.addCheckbox(sheet as never, "E4:F5", {
    checked: false,
    link: "G4",
    text: "Invoiced"
  } as never);
}
