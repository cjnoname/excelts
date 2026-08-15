/**
 * Chart and data-source helpers shared by the spreadsheet write tools.
 *
 * The chart schema exposed to a model is deliberately much smaller than the
 * library's. Two reasons:
 *
 * 1. **Reference construction is where a model fails.** A series wants
 *    `'My Sheet'!$B$2:$B$4`; asked for that, a model produces `B2:B4`,
 *    `Sheet1!B2:B4`, or a quoted name it forgot to escape. So the tool takes
 *    plain `A2:A4` ranges and builds the qualified form itself.
 * 2. **Schema is context.** `AddChartOptions` has scores of fields —
 *    trendlines, error bars, 3-D scenes, manual layout. Exposing them would
 *    cost thousands of tokens on every request to serve a rare case. What
 *    actually changes whether a report is useful is type, data, title, legend.
 */

import { Csv } from "documonster/csv";
import { Address, Chart, Worksheet } from "documonster/excel";
import { z } from "zod";

import { toolError } from "../errors.js";
import {
  MAX_EXCEL_COLUMNS,
  MAX_EXCEL_ROWS,
  parseRange,
  sheetName,
  type SheetHandle
} from "./spreadsheet.js";

/** Chart kinds worth offering. Deliberately not all 24 the library supports. */
export const CHART_TYPES = [
  "column",
  "bar",
  "line",
  "area",
  "pie",
  "doughnut",
  "scatter",
  "radar"
] as const;

export const chartSchema = z.object({
  type: z.enum(CHART_TYPES).describe("Chart kind."),
  title: z.string().optional().describe("Chart title."),
  categories: z
    .string()
    .describe(
      'Range holding the axis labels, e.g. "A2:A13". Plain A1 notation — no sheet name. For a scatter chart this is the numeric X range instead of labels.'
    ),
  values: z
    .union([z.string(), z.array(z.string()).min(1)])
    .describe('Range(s) holding the numbers, e.g. "B2:B13" or ["B2:B13","C2:C13"] for two series.'),
  seriesNames: z
    .array(z.string())
    .optional()
    .describe('Header cell for each series, e.g. ["B1","C1"], so the legend reads properly.'),
  anchor: z
    .string()
    .optional()
    .describe(
      'Where to place it, as a range, e.g. "E2:L20". Defaults to a block right of the data.'
    ),
  legend: z
    .enum(["right", "bottom", "top", "left", "none"])
    .optional()
    .describe(
      "Legend position. Defaults to right when there is more than one series, otherwise none."
    )
});

export type ChartSpec = z.infer<typeof chartSchema>;

/**
 * Add one chart to a worksheet.
 *
 * @returns A human description of what was added.
 */
export function addChart(ws: SheetHandle, spec: ChartSpec): string {
  const name = sheetName(ws);
  const valueRanges = typeof spec.values === "string" ? [spec.values] : spec.values;

  if (spec.seriesNames !== undefined && spec.seriesNames.length !== valueRanges.length) {
    throw toolError.invalidInput(
      `seriesNames has ${spec.seriesNames.length} entr(y/ies) but there are ${valueRanges.length} value range(s)`,
      "Give one name cell per series, or omit seriesNames entirely."
    );
  }

  const axis = qualify(name, spec.categories, "categories");
  const axisCount = rangeLength(spec.categories);
  const series = valueRanges.map((range, index) => {
    if (rangeLength(range) !== axisCount) {
      throw toolError.invalidInput(
        `values range ${JSON.stringify(range)} has ${rangeLength(range)} cells but categories has ${axisCount}`,
        "Every series and the category/X range must cover the same number of cells."
      );
    }
    const nameCell = spec.seriesNames?.[index];
    return {
      // `{ formula }`, not a bare string: the chart API treats a string as the
      // literal legend text, so passing the reference would put
      // `'Sales'!$B$1` in the legend instead of the header cell's value.
      ...(nameCell === undefined
        ? {}
        : { name: { formula: qualify(name, nameCell, "seriesNames") } }),
      values: qualify(name, range, "values"),
      // A scatter series plots numbers against numbers, so the same range is
      // its X values rather than category labels. The engine rejects
      // `categories` there, so the distinction cannot be papered over.
      ...(spec.type === "scatter" ? { xValues: axis } : { categories: axis })
    };
  });

  const anchor = spec.anchor ?? defaultAnchor(ws, valueRanges.length);
  const legend = spec.legend ?? (series.length > 1 ? "right" : "none");
  const options = {
    ...(spec.title === undefined ? {} : { title: spec.title }),
    series,
    // The API takes `showLegend` + `legendPosition`. A `legend: { position }`
    // object is silently ignored, so "none" would still render a legend and a
    // requested position would fall back to the default.
    showLegend: legend !== "none",
    ...(legend === "none" ? {} : { legendPosition: legendCode(legend) })
  };

  try {
    switch (spec.type) {
      case "column":
        Chart.addColumn(ws, options, anchor);
        break;
      case "bar":
        Chart.addBar(ws, options, anchor);
        break;
      case "line":
        Chart.addLine(ws, options, anchor);
        break;
      case "area":
        Chart.addArea(ws, options, anchor);
        break;
      case "pie":
        Chart.addPie(ws, options, anchor);
        break;
      case "doughnut":
        Chart.addDoughnut(ws, options, anchor);
        break;
      case "scatter":
        Chart.addScatter(ws, options, anchor);
        break;
      case "radar":
        Chart.addRadar(ws, options, anchor);
        break;
    }
  } catch (cause) {
    throw toolError.invalidInput(
      `could not add the ${spec.type} chart: ${cause instanceof Error ? cause.message : String(cause)}`,
      "Check that `categories` and each `values` range cover the same number of cells.",
      { cause }
    );
  }

  return `added a ${spec.type} chart${spec.title === undefined ? "" : ` titled ${JSON.stringify(spec.title)}`} with ${series.length} series at ${anchor}`;
}

/**
 * Turn `B2:B13` into `'Sheet name'!$B$2:$B$13`.
 *
 * Quoting and absolute markers are added here rather than asked of the model,
 * because a wrong reference produces a chart that renders empty — which looks
 * like a library failure rather than a bad argument.
 */
function qualify(sheet: string, range: string, field: string): string {
  const trimmed = range.trim().toUpperCase().replace(/\$/g, "");
  if (!/^[A-Z]{1,3}[1-9][0-9]*(?::[A-Z]{1,3}[1-9][0-9]*)?$/.test(trimmed)) {
    throw toolError.invalidInput(
      `${field} value ${JSON.stringify(range)} is not a plain A1 range`,
      'Use A1 notation without a sheet name, e.g. "B2:B13".'
    );
  }

  // Validates Excel's row/column limits and rejects a backwards rectangle.
  parseRange(trimmed);

  const absolute = trimmed
    .split(":")
    .map(part => part.replace(/^([A-Z]+)([0-9]+)$/, "$$$1$$$2"))
    .join(":");

  return `${Address.quoteSheetName(sheet)}!${absolute}`;
}

/** Place a chart clear of the data when the caller does not choose. */
function defaultAnchor(ws: SheetHandle, seriesCount: number): string {
  const dimensions = Worksheet.dimensions(ws);
  const height = Math.max(15, seriesCount * 6);
  const roomOnRight = dimensions.right + 8 <= MAX_EXCEL_COLUMNS;
  const left = roomOnRight ? Math.max(1, dimensions.right + 2) : 1;
  const top = roomOnRight ? 2 : Math.max(2, dimensions.bottom + 2);
  if (top + height > MAX_EXCEL_ROWS) {
    throw toolError.invalidInput(
      "there is no room to place a chart beside or below the used range",
      "Pass an explicit `anchor` inside the worksheet, or put the chart on a separate sheet."
    );
  }
  return `${Address.encodeCell({ r: top - 1, c: left - 1 })}:${Address.encodeCell({ r: top + height - 1, c: left + 6 })}`;
}

/** Number of cells in a one-dimensional category/series range. */
function rangeLength(range: string): number {
  const window = parseRange(range);
  const rows = window.bottom - window.top + 1;
  const columns = window.right - window.left + 1;
  if (rows > 1 && columns > 1) {
    throw toolError.invalidInput(
      `chart range ${JSON.stringify(range)} is two-dimensional`,
      "Categories and series values must each be one row or one column."
    );
  }
  return rows * columns;
}

function legendCode(position: "right" | "bottom" | "top" | "left"): "r" | "b" | "t" | "l" {
  switch (position) {
    case "right":
      return "r";
    case "bottom":
      return "b";
    case "top":
      return "t";
    case "left":
      return "l";
  }
}

/**
 * Synthetic-data generation.
 *
 * A genuinely high-leverage capability: a few dozen tokens of column definitions
 * produce megabytes of plausible rows. A model asked for 5 000 test rows would
 * otherwise have to emit them itself, which is both ruinously expensive and
 * worse data.
 */
export const generateSchema = z.object({
  rows: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .describe("How many data rows to generate (maximum 20,000)."),
  columns: z
    .array(
      z.object({
        name: z.string().min(1).describe("Column header."),
        type: z
          .enum([
            "string",
            "int",
            "float",
            "bool",
            "date",
            "datetime",
            "uuid",
            "email",
            "name",
            "firstName",
            "lastName",
            "word",
            "sentence",
            "phone",
            "url",
            "ip",
            "hex",
            "index"
          ])
          .describe("What kind of value to generate."),
        min: z.number().optional().describe("For int/float."),
        max: z.number().optional().describe("For int/float."),
        length: z.number().int().positive().optional().describe("For string/hex."),
        values: z
          .array(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Pick from this set instead of generating — use it for categories like regions."
          ),
        nullable: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Probability of a blank, 0–1. Useful for testing how code handles gaps.")
      })
    )
    .min(1)
    .max(100)
    .describe("Column definitions, left to right.")
});

export type GenerateSpec = z.infer<typeof generateSchema>;

/** Generate rows and write them into a worksheet, header included. */
export function writeGenerated(ws: SheetHandle, spec: GenerateSpec): string {
  const cells = spec.rows * spec.columns.length;
  if (cells > 2_000_000) {
    throw toolError.tooLarge(
      `generation would create ${cells.toLocaleString()} cells, over the 2,000,000 limit`,
      "Reduce the rows or columns. Synthetic data is materialised in memory before the workbook is written."
    );
  }
  const generated = Csv.generate({
    rows: spec.rows,
    columns: spec.columns.map(column => ({
      type: column.type,
      name: column.name,
      ...(column.min === undefined ? {} : { min: column.min }),
      ...(column.max === undefined ? {} : { max: column.max }),
      ...(column.length === undefined ? {} : { length: column.length }),
      ...(column.values === undefined ? {} : { values: [...column.values] }),
      ...(column.nullable === undefined ? {} : { nullable: column.nullable })
    }))
  });

  Worksheet.addAoa(ws, [generated.headers, ...(generated.data as unknown[][])] as never);

  return `generated ${spec.rows} row(s) × ${spec.columns.length} column(s) server-side`;
}
