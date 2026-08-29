import type { NamedStyleEntry } from "@excel/core/workbook-core";
import type {
  Alignment,
  Border,
  BorderStyle,
  Borders,
  Color,
  Fill,
  FillPattern,
  FillPatterns,
  Font,
  Protection,
  Style
} from "@excel/types";
import {
  createBinaryWriter,
  createPayload,
  encodeWideString,
  finishBinaryWriter,
  iterateBiffRecords,
  writeRecord,
  XlsbBinaryReader
} from "@excel/xlsb/binary";
import { XlsbRecordType } from "@excel/xlsb/record-types";
import { defaultNumFormats } from "@excel/xlsx/defaultnumformats";

const CUSTOM_NUM_FMT_BASE = 164;
const DEFAULT_FONT: Partial<Font> = {
  name: "Calibri",
  size: 11,
  family: 2,
  scheme: "minor",
  color: { theme: 1 }
};
const DEFAULT_FILL: FillPattern = { type: "pattern", pattern: "none" };
const GRAY_125_FILL: FillPattern = { type: "pattern", pattern: "gray125" };

const PATTERN_BY_CODE: Partial<Record<number, FillPatterns>> = {
  0: "none",
  1: "solid",
  2: "mediumGray",
  3: "darkGray",
  4: "lightGray",
  5: "darkHorizontal",
  6: "darkVertical",
  7: "darkDown",
  8: "darkUp",
  9: "darkGrid",
  10: "darkTrellis",
  11: "lightHorizontal",
  12: "lightVertical",
  13: "lightDown",
  14: "lightUp",
  15: "lightGrid",
  16: "lightTrellis",
  17: "gray125",
  18: "gray0625"
};
const CODE_BY_PATTERN = new Map(
  Object.entries(PATTERN_BY_CODE).map(([code, pattern]) => [pattern, Number(code)])
);

const BORDER_BY_CODE: Partial<Record<number, BorderStyle>> = {
  1: "thin",
  2: "medium",
  3: "dashed",
  4: "dotted",
  5: "thick",
  6: "double",
  7: "hair",
  8: "mediumDashed",
  9: "dashDot",
  10: "mediumDashDot",
  11: "dashDotDot",
  12: "mediumDashDotDot",
  13: "slantDashDot"
};
const CODE_BY_BORDER = new Map(
  Object.entries(BORDER_BY_CODE).map(([code, style]) => [style, Number(code)])
);

const HORIZONTAL_BY_CODE: Partial<Record<number, Alignment["horizontal"]>> = {
  1: "left",
  2: "center",
  3: "right",
  4: "fill",
  5: "justify",
  6: "centerContinuous",
  7: "distributed"
};
const CODE_BY_HORIZONTAL = new Map(
  Object.entries(HORIZONTAL_BY_CODE).map(([code, value]) => [value, Number(code)])
);

const VERTICAL_BY_CODE: Partial<Record<number, Alignment["vertical"]>> = {
  0: "top",
  1: "middle",
  2: "bottom",
  3: "justify",
  4: "distributed"
};
const CODE_BY_VERTICAL = new Map(
  Object.entries(VERTICAL_BY_CODE).map(([code, value]) => [value, Number(code)])
);

interface XlsbXf {
  parent: number;
  numFmtId: number;
  fontId: number;
  fillId: number;
  borderId: number;
  alignment?: Partial<Alignment>;
  protection?: Partial<Protection>;
  applyFlags: number;
  unsupported: boolean;
}

interface XlsbNamedStyle {
  entry: NamedStyleEntry;
  xfId: number;
}

interface ParsedNamedStyle {
  name: string;
  xfId: number;
  builtinId?: number;
  hidden?: boolean;
  customBuiltin?: boolean;
  iLevel?: number;
}

export interface XlsbStyleTable {
  styles: Partial<Style>[];
  namedStyles: NamedStyleEntry[];
  fonts: Partial<Font>[];
  numFmtIds: number[];
  customFormats: Map<number, string>;
  defaultFont?: Partial<Font>;
  hasUnsupportedFormatting: boolean;
  unsupportedRecordTypes: number[];
}

export interface XlsbStyleRegistry {
  formats: string[];
  formatIndexes: Map<string, number>;
  fonts: Partial<Font>[];
  fontIndexes: Map<string, number>;
  fills: Fill[];
  fillIndexes: Map<string, number>;
  borders: Partial<Borders>[];
  borderIndexes: Map<string, number>;
  styles: XlsbXf[];
  styleIndexes: Map<string, number>;
  cellStyleXfs: XlsbXf[];
  namedStyles: XlsbNamedStyle[];
  namedStyleIndexes: Map<string, number>;
  defaultFont: Partial<Font>;
}

export function createStyleRegistry(
  defaultFont?: Partial<Font>,
  namedStyles: readonly NamedStyleEntry[] = []
): XlsbStyleRegistry {
  const normalizedDefaultFont = normalizeFont(defaultFont);
  const defaultXf: XlsbXf = {
    parent: 0,
    numFmtId: 0,
    fontId: 0,
    fillId: 0,
    borderId: 0,
    applyFlags: 0,
    unsupported: false
  };
  const registry: XlsbStyleRegistry = {
    formats: [],
    formatIndexes: new Map(),
    fonts: [normalizedDefaultFont],
    fontIndexes: new Map([[stableKey(normalizedDefaultFont), 0]]),
    fills: [DEFAULT_FILL, GRAY_125_FILL],
    fillIndexes: new Map([
      [stableKey(DEFAULT_FILL), 0],
      [stableKey(GRAY_125_FILL), 1]
    ]),
    borders: [{}],
    borderIndexes: new Map([[stableKey({}), 0]]),
    styles: [defaultXf],
    styleIndexes: new Map([[xfKey(defaultXf), 0]]),
    cellStyleXfs: [
      {
        parent: 0xffff,
        numFmtId: 0,
        fontId: 0,
        fillId: 0,
        borderId: 0,
        applyFlags: 0,
        unsupported: false
      }
    ],
    namedStyles: [],
    namedStyleIndexes: new Map([["Normal", 0]]),
    defaultFont: normalizedDefaultFont
  };
  for (const style of namedStyles) {
    addNamedStyle(registry, style);
  }
  return registry;
}

export function addStyle(registry: XlsbStyleRegistry, style: Partial<Style> | undefined): number {
  if (!style || Object.keys(style).length === 0) {
    return 0;
  }
  const xf = buildXf(registry, style, registry.namedStyleIndexes.get(style.styleName ?? "") ?? 0);
  const key = xfKey(xf);
  const existing = registry.styleIndexes.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const index = registry.styles.length;
  registry.styles.push(xf);
  registry.styleIndexes.set(key, index);
  return index;
}

export function addNumberFormat(registry: XlsbStyleRegistry, format: string | undefined): number {
  if (!format || format === "General") {
    return 0;
  }
  const builtIn = Object.entries(defaultNumFormats).find(([, entry]) => entry.f === format);
  if (builtIn) {
    return Number(builtIn[0]);
  }
  const existing = registry.formatIndexes.get(format);
  if (existing !== undefined) {
    return existing;
  }
  const id = CUSTOM_NUM_FMT_BASE + registry.formats.length;
  registry.formats.push(format);
  registry.formatIndexes.set(format, id);
  return id;
}

export function parseStyles(bytes: Uint8Array | undefined): XlsbStyleTable {
  if (!bytes) {
    return {
      styles: [{}],
      namedStyles: [],
      fonts: [DEFAULT_FONT],
      numFmtIds: [0],
      customFormats: new Map(),
      defaultFont: DEFAULT_FONT,
      hasUnsupportedFormatting: false,
      unsupportedRecordTypes: []
    };
  }

  const customFormats = new Map<number, string>();
  const fonts: Partial<Font>[] = [];
  const fills: Fill[] = [];
  const borders: Partial<Borders>[] = [];
  const cellStyleXfs: XlsbXf[] = [];
  const cellXfs: XlsbXf[] = [];
  const parsedNamedStyles: ParsedNamedStyle[] = [];
  let inCellStyleXfs = false;
  let inCellXfs = false;
  let hasUnsupportedFormatting = false;
  const unsupportedRecordTypes = new Set<number>();

  for (const record of iterateBiffRecords(bytes, "xl/styles.bin")) {
    switch (record.type) {
      case XlsbRecordType.BeginCellStyleXfs:
        inCellStyleXfs = true;
        break;
      case XlsbRecordType.EndCellStyleXfs:
        inCellStyleXfs = false;
        break;
      case XlsbRecordType.BeginCellXfs:
        inCellXfs = true;
        break;
      case XlsbRecordType.EndCellXfs:
        inCellXfs = false;
        break;
      case XlsbRecordType.Fmt: {
        const reader = new XlsbBinaryReader(record.data, "BrtFmt");
        customFormats.set(reader.u16(), reader.wideString());
        break;
      }
      case XlsbRecordType.Font:
        fonts.push(parseFont(record.data));
        break;
      case XlsbRecordType.Fill:
        fills.push(parseFill(record.data));
        break;
      case XlsbRecordType.Border:
        borders.push(parseBorder(record.data));
        break;
      case XlsbRecordType.Xf: {
        const xf = parseXf(record.data);
        hasUnsupportedFormatting ||= xf.unsupported;
        if (inCellXfs) {
          cellXfs.push(xf);
        }
        if (inCellStyleXfs) {
          cellStyleXfs.push(xf);
        }
        break;
      }
      case XlsbRecordType.Style:
        parsedNamedStyles.push(parseNamedStyle(record.data));
        break;
      default:
        if (!isSupportedStyleRecord(record.type)) {
          unsupportedRecordTypes.add(record.type);
        }
    }
  }

  fonts[0] ??= normalizeFont();
  fills[0] ??= DEFAULT_FILL;
  borders[0] ??= {};
  if (cellXfs.length === 0) {
    cellXfs.push({
      parent: 0,
      numFmtId: 0,
      fontId: 0,
      fillId: 0,
      borderId: 0,
      applyFlags: 0,
      unsupported: false
    });
  }

  const namedStyleNames = new Map(
    parsedNamedStyles.map(style => [style.xfId, style.name] as const)
  );
  const styles = cellXfs.map(xf => {
    const style = materializeStyle(
      xf,
      cellStyleXfs[xf.parent],
      fonts,
      fills,
      borders,
      customFormats
    );
    const styleName = namedStyleNames.get(xf.parent);
    if (styleName && styleName !== "Normal") {
      style.styleName = styleName;
    }
    return style;
  });
  const namedStyles = parsedNamedStyles.flatMap<NamedStyleEntry>(style => {
    if (style.builtinId === 0 || style.name === "Normal") {
      return [];
    }
    const xf = cellStyleXfs[style.xfId];
    if (!xf) {
      hasUnsupportedFormatting = true;
      return [];
    }
    const materialized = materializeStyle(xf, undefined, fonts, fills, borders, customFormats);
    return [
      {
        ...(materialized.font ? { font: materialized.font } : {}),
        ...(materialized.fill ? { fill: materialized.fill } : {}),
        ...(materialized.border ? { border: materialized.border } : {}),
        ...(materialized.alignment ? { alignment: materialized.alignment } : {}),
        ...(materialized.protection ? { protection: materialized.protection } : {}),
        ...(typeof materialized.numFmt === "string" ? { numFmt: materialized.numFmt } : {}),
        name: style.name,
        ...(style.builtinId !== undefined ? { builtinId: style.builtinId } : {}),
        ...(style.iLevel !== undefined ? { iLevel: style.iLevel } : {}),
        ...(style.hidden ? { hidden: true } : {}),
        ...(style.customBuiltin ? { customBuiltin: true } : {})
      }
    ];
  });
  return {
    styles,
    namedStyles,
    fonts,
    numFmtIds: cellXfs.map(xf => xf.numFmtId),
    customFormats,
    defaultFont: fonts[0],
    hasUnsupportedFormatting,
    unsupportedRecordTypes: [...unsupportedRecordTypes].sort((left, right) => left - right)
  };
}

function isSupportedStyleRecord(type: number): boolean {
  return (
    type === XlsbRecordType.BeginStyleSheet ||
    type === XlsbRecordType.EndStyleSheet ||
    type === XlsbRecordType.FutureRecordBegin ||
    type === XlsbRecordType.FutureRecordEnd ||
    type === XlsbRecordType.AlternateContentBegin ||
    type === XlsbRecordType.AlternateContentEnd ||
    type === XlsbRecordType.BeginFmts ||
    type === XlsbRecordType.EndFmts ||
    type === XlsbRecordType.BeginFonts ||
    type === XlsbRecordType.EndFonts ||
    type === XlsbRecordType.BeginFills ||
    type === XlsbRecordType.EndFills ||
    type === XlsbRecordType.BeginBorders ||
    type === XlsbRecordType.EndBorders ||
    type === XlsbRecordType.BeginCellStyleXfs ||
    type === XlsbRecordType.EndCellStyleXfs ||
    type === XlsbRecordType.BeginCellXfs ||
    type === XlsbRecordType.EndCellXfs ||
    type === XlsbRecordType.BeginStyles ||
    type === XlsbRecordType.Style ||
    type === XlsbRecordType.EndStyles
  );
}

export function writeStyles(registry: XlsbStyleRegistry): Uint8Array {
  const writer = createBinaryWriter();
  writeRecord(writer, XlsbRecordType.BeginStyleSheet);

  writeCountedBegin(writer, XlsbRecordType.BeginFmts, registry.formats.length);
  registry.formats.forEach((format, index) => {
    const text = encodeWideString(format);
    const payload = new Uint8Array(2 + text.length);
    new DataView(payload.buffer).setUint16(0, CUSTOM_NUM_FMT_BASE + index, true);
    payload.set(text, 2);
    writeRecord(writer, XlsbRecordType.Fmt, payload);
  });
  writeRecord(writer, XlsbRecordType.EndFmts);

  writeCountedBegin(writer, XlsbRecordType.BeginFonts, registry.fonts.length);
  registry.fonts.forEach(font => writeRecord(writer, XlsbRecordType.Font, fontPayload(font)));
  writeRecord(writer, XlsbRecordType.EndFonts);

  writeCountedBegin(writer, XlsbRecordType.BeginFills, registry.fills.length);
  registry.fills.forEach(fill => writeRecord(writer, XlsbRecordType.Fill, fillPayload(fill)));
  writeRecord(writer, XlsbRecordType.EndFills);

  writeCountedBegin(writer, XlsbRecordType.BeginBorders, registry.borders.length);
  registry.borders.forEach(border =>
    writeRecord(writer, XlsbRecordType.Border, borderPayload(border))
  );
  writeRecord(writer, XlsbRecordType.EndBorders);

  writeCountedBegin(writer, XlsbRecordType.BeginCellStyleXfs, registry.cellStyleXfs.length);
  registry.cellStyleXfs.forEach(style => writeRecord(writer, XlsbRecordType.Xf, xfPayload(style)));
  writeRecord(writer, XlsbRecordType.EndCellStyleXfs);

  writeCountedBegin(writer, XlsbRecordType.BeginCellXfs, registry.styles.length);
  registry.styles.forEach(style => writeRecord(writer, XlsbRecordType.Xf, xfPayload(style)));
  writeRecord(writer, XlsbRecordType.EndCellXfs);

  writeCountedBegin(writer, XlsbRecordType.BeginStyles, registry.namedStyles.length + 1);
  writeRecord(writer, XlsbRecordType.Style, namedStylePayload({ name: "Normal", builtinId: 0 }, 0));
  registry.namedStyles.forEach(style =>
    writeRecord(writer, XlsbRecordType.Style, namedStylePayload(style.entry, style.xfId))
  );
  writeRecord(writer, XlsbRecordType.EndStyles);

  writeRecord(writer, XlsbRecordType.EndStyleSheet);
  return finishBinaryWriter(writer);
}

function parseNamedStyle(data: Uint8Array): ParsedNamedStyle {
  const reader = new XlsbBinaryReader(data, "BrtStyle");
  const xfId = reader.u32();
  const flags = reader.u16();
  const builtinId = reader.u8();
  const iLevel = reader.u8();
  const name = reader.wideString();
  const builtIn = (flags & 1) !== 0;
  return {
    name,
    xfId,
    ...(builtIn ? { builtinId } : {}),
    ...((flags & 2) !== 0 ? { hidden: true } : {}),
    ...((flags & 4) !== 0 ? { customBuiltin: true } : {}),
    ...(builtIn && (builtinId === 1 || builtinId === 2) ? { iLevel } : {})
  };
}

function namedStylePayload(style: NamedStyleEntry, xfId: number): Uint8Array {
  const name = encodeWideString(style.name);
  const payload = createPayload(8 + name.length);
  payload.view.setUint32(0, xfId, true);
  let flags = style.builtinId !== undefined || style.customBuiltin ? 1 : 0;
  if (style.hidden) {
    flags |= 2;
  }
  if (style.customBuiltin) {
    flags |= 4;
  }
  payload.view.setUint16(4, flags, true);
  payload.bytes[6] = style.builtinId ?? 0;
  payload.bytes[7] = style.iLevel ?? 0;
  payload.bytes.set(name, 8);
  return payload.bytes;
}

function parseFont(data: Uint8Array): Partial<Font> {
  const reader = new XlsbBinaryReader(data, "BrtFont");
  const size = reader.u16() / 20;
  const flags = reader.u16();
  const weight = reader.u16();
  const script = reader.u16();
  const underline = reader.u8();
  const family = reader.u8();
  const charset = reader.u8();
  reader.u8();
  const color = parseColor(reader.slice(8));
  const scheme = reader.u8();
  const name = reader.wideString();
  return compactObject({
    name,
    size,
    family: family || undefined,
    scheme: scheme === 1 ? "major" : scheme === 2 ? "minor" : "none",
    charset,
    color,
    bold: weight >= 700 || undefined,
    italic: (flags & 0x02) !== 0 || undefined,
    underline: underlineName(underline),
    vertAlign: script === 1 ? "superscript" : script === 2 ? "subscript" : undefined,
    strike: (flags & 0x08) !== 0 || undefined,
    outline: (flags & 0x10) !== 0 || undefined,
    shadow: (flags & 0x20) !== 0 || undefined,
    condense: (flags & 0x40) !== 0 || undefined,
    extend: (flags & 0x80) !== 0 || undefined
  }) as Partial<Font>;
}

function parseFill(data: Uint8Array): Fill {
  const reader = new XlsbBinaryReader(data, "BrtFill");
  const pattern = reader.u32();
  if (reader.remaining < 64) {
    return { type: "pattern", pattern: PATTERN_BY_CODE[pattern] ?? "none" };
  }
  const foreground = parseColor(reader.slice(8));
  const background = parseColor(reader.slice(8));
  const gradientType = reader.u32();
  const degree = reader.f64();
  const left = reader.f64();
  const right = reader.f64();
  const top = reader.f64();
  const bottom = reader.f64();
  const stopCount = reader.u32();
  const stops = Array.from({ length: stopCount }, () => ({
    color: parseColor(reader.slice(8)) ?? {},
    position: reader.f64()
  }));
  if (pattern === 0x28) {
    return gradientType === 1
      ? {
          type: "gradient",
          gradient: "path",
          center: { left, right, top, bottom },
          stops
        }
      : { type: "gradient", gradient: "angle", degree, stops };
  }
  return compactObject({
    type: "pattern",
    pattern: PATTERN_BY_CODE[pattern] ?? "none",
    fgColor: foreground,
    bgColor: background
  }) as FillPattern;
}

function parseBorder(data: Uint8Array): Partial<Borders> {
  const reader = new XlsbBinaryReader(data, "BrtBorder");
  const flags = reader.u8();
  const top = parseBorderEdge(reader);
  const bottom = parseBorderEdge(reader);
  const left = parseBorderEdge(reader);
  const right = parseBorderEdge(reader);
  const diagonal = parseBorderEdge(reader);
  return compactObject({
    top,
    bottom,
    left,
    right,
    diagonal: diagonal ? { ...diagonal, down: (flags & 1) !== 0, up: (flags & 2) !== 0 } : undefined
  }) as Partial<Borders>;
}

function parseBorderEdge(reader: XlsbBinaryReader): Partial<Border> | undefined {
  const style = BORDER_BY_CODE[reader.u8()];
  reader.u8();
  const color = parseColor(reader.slice(8));
  return style ? compactObject({ style, color }) : undefined;
}

function parseXf(data: Uint8Array): XlsbXf {
  const reader = new XlsbBinaryReader(data, "BrtXF");
  const parent = reader.u16();
  const numFmtId = reader.u16();
  const fontId = reader.u16();
  const fillId = reader.u16();
  const borderId = reader.u16();
  const rotation = reader.u8();
  const indent = reader.u8();
  const alignmentFlags = reader.u8();
  const protectionFlags = reader.u8();
  const applyFlags = reader.u16() & 0x3f;
  const horizontal = alignmentFlags & 0x07;
  const vertical = (alignmentFlags >>> 3) & 0x07;
  const readingOrder = (protectionFlags >>> 2) & 0x03;
  const alignment = compactObject({
    horizontal: HORIZONTAL_BY_CODE[horizontal],
    vertical: (applyFlags & 4) !== 0 || vertical !== 2 ? VERTICAL_BY_CODE[vertical] : undefined,
    wrapText: (alignmentFlags & 0x40) !== 0 || undefined,
    shrinkToFit: (protectionFlags & 0x01) !== 0 || undefined,
    indent: indent || undefined,
    readingOrder: readingOrder === 1 ? "ltr" : readingOrder === 2 ? "rtl" : undefined,
    textRotation: decodeRotation(rotation)
  }) as Partial<Alignment>;
  const protection = compactObject({
    locked: (protectionFlags & 0x10) !== 0 ? undefined : false,
    hidden: (protectionFlags & 0x20) !== 0 || undefined
  }) as Partial<Protection>;
  return {
    parent,
    numFmtId,
    fontId,
    fillId,
    borderId,
    alignment: Object.keys(alignment).length > 0 ? alignment : undefined,
    protection: Object.keys(protection).length > 0 ? protection : undefined,
    applyFlags,
    unsupported:
      (alignmentFlags & 0x80) !== 0 ||
      (protectionFlags & 0x02) !== 0 ||
      (protectionFlags & 0xc0) !== 0
  };
}

function materializeStyle(
  xf: XlsbXf,
  parent: XlsbXf | undefined,
  fonts: readonly Partial<Font>[],
  fills: readonly Fill[],
  borders: readonly Partial<Borders>[],
  formats: ReadonlyMap<number, string>
): Partial<Style> {
  const numFmtId = selectInheritedId(xf.numFmtId, parent?.numFmtId, xf.applyFlags, 1);
  const fontId = selectInheritedId(xf.fontId, parent?.fontId, xf.applyFlags, 2);
  const fillId = selectInheritedId(xf.fillId, parent?.fillId, xf.applyFlags, 16);
  const borderId = selectInheritedId(xf.borderId, parent?.borderId, xf.applyFlags, 8);
  const numFmt = formats.get(numFmtId) ?? defaultNumFormats[numFmtId]?.f;
  return compactObject({
    numFmt: numFmt && numFmt !== "General" ? numFmt : undefined,
    font: fontId !== 0 ? fonts[fontId] : undefined,
    fill: fillId !== 0 ? fills[fillId] : undefined,
    border: borderId !== 0 ? borders[borderId] : undefined,
    alignment: xf.alignment ?? parent?.alignment,
    protection: xf.protection ?? parent?.protection
  }) as Partial<Style>;
}

function selectInheritedId(
  value: number,
  inherited: number | undefined,
  applyFlags: number,
  applyFlag: number
): number {
  return (applyFlags & applyFlag) !== 0 || value !== 0 ? value : (inherited ?? 0);
}

function addNamedStyle(registry: XlsbStyleRegistry, style: NamedStyleEntry): void {
  if (style.name === "Normal") {
    return;
  }
  const existing = registry.namedStyleIndexes.get(style.name);
  const xf = buildXf(registry, style, 0xffff);
  if (existing !== undefined) {
    registry.cellStyleXfs[existing] = xf;
    const namedIndex = registry.namedStyles.findIndex(entry => entry.entry.name === style.name);
    if (namedIndex >= 0) {
      registry.namedStyles[namedIndex] = { entry: style, xfId: existing };
    }
    return;
  }
  const xfId = registry.cellStyleXfs.length;
  registry.cellStyleXfs.push(xf);
  registry.namedStyles.push({ entry: style, xfId });
  registry.namedStyleIndexes.set(style.name, xfId);
}

function buildXf(registry: XlsbStyleRegistry, style: Partial<Style>, parent: number): XlsbXf {
  const numFmtId = addNumberFormat(registry, normalizeNumFmt(style.numFmt));
  const fontId = style.font ? addFont(registry, style.font) : 0;
  const fillId = style.fill ? addFill(registry, style.fill) : 0;
  const borderId = style.border ? addBorder(registry, style.border) : 0;
  let applyFlags = 0;
  if (style.numFmt) {
    applyFlags |= 1;
  }
  if (style.font) {
    applyFlags |= 2;
  }
  if (style.alignment) {
    applyFlags |= 4;
  }
  if (style.border) {
    applyFlags |= 8;
  }
  if (style.fill) {
    applyFlags |= 16;
  }
  if (style.protection) {
    applyFlags |= 32;
  }
  return {
    parent,
    numFmtId,
    fontId,
    fillId,
    borderId,
    alignment: style.alignment,
    protection: style.protection,
    applyFlags,
    unsupported: false
  };
}

export function addFont(registry: XlsbStyleRegistry, font: Partial<Font>): number {
  return addIndexed(
    registry.fonts,
    registry.fontIndexes,
    normalizeFont(font, registry.defaultFont)
  );
}

function addFill(registry: XlsbStyleRegistry, fill: Fill): number {
  return addIndexed(registry.fills, registry.fillIndexes, fill);
}

function addBorder(registry: XlsbStyleRegistry, border: Partial<Borders>): number {
  return addIndexed(registry.borders, registry.borderIndexes, border);
}

function addIndexed<T>(values: T[], indexes: Map<string, number>, value: T): number {
  const key = stableKey(value);
  const existing = indexes.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const index = values.length;
  values.push(value);
  indexes.set(key, index);
  return index;
}

function writeCountedBegin(
  writer: ReturnType<typeof createBinaryWriter>,
  type: number,
  count: number
): void {
  const payload = createPayload(4);
  payload.view.setUint32(0, count, true);
  writeRecord(writer, type, payload.bytes);
}

function fontPayload(font: Partial<Font>): Uint8Array {
  const normalized = normalizeFont(font);
  const name = encodeWideString(normalized.name ?? "Calibri");
  const payload = createPayload(21 + name.length);
  payload.view.setUint16(0, Math.round((normalized.size ?? 11) * 20), true);
  let flags = 0;
  flags |= normalized.italic ? 0x02 : 0;
  flags |= normalized.strike ? 0x08 : 0;
  flags |= normalized.outline ? 0x10 : 0;
  flags |= normalized.shadow ? 0x20 : 0;
  flags |= normalized.condense ? 0x40 : 0;
  flags |= normalized.extend ? 0x80 : 0;
  payload.view.setUint16(2, flags, true);
  payload.view.setUint16(4, normalized.bold ? 700 : 400, true);
  payload.view.setUint16(
    6,
    normalized.vertAlign === "superscript" ? 1 : normalized.vertAlign === "subscript" ? 2 : 0,
    true
  );
  payload.bytes[8] = underlineCode(normalized.underline);
  payload.bytes[9] = normalized.family ?? 0;
  payload.bytes[10] = normalized.charset ?? 0;
  payload.bytes.set(colorPayload(normalized.color), 12);
  payload.bytes[20] = normalized.scheme === "major" ? 1 : normalized.scheme === "minor" ? 2 : 0;
  payload.bytes.set(name, 21);
  return payload.bytes;
}

function fillPayload(fill: Fill): Uint8Array {
  const stops = fill.type === "gradient" ? fill.stops : [];
  const payload = createPayload(68 + stops.length * 16);
  if (fill.type === "gradient") {
    payload.view.setUint32(0, 0x28, true);
    payload.view.setUint32(20, fill.gradient === "path" ? 1 : 0, true);
    payload.view.setFloat64(24, fill.gradient === "angle" ? fill.degree : 0, true);
    if (fill.gradient === "path") {
      payload.view.setFloat64(32, fill.center.left, true);
      payload.view.setFloat64(40, fill.center.right ?? fill.center.left, true);
      payload.view.setFloat64(48, fill.center.top, true);
      payload.view.setFloat64(56, fill.center.bottom ?? fill.center.top, true);
    }
    payload.view.setUint32(64, stops.length, true);
    stops.forEach((stop, index) => {
      const offset = 68 + index * 16;
      payload.bytes.set(colorPayload(stop.color), offset);
      payload.view.setFloat64(offset + 8, stop.position, true);
    });
  } else {
    payload.view.setUint32(0, CODE_BY_PATTERN.get(fill.pattern) ?? 0, true);
    payload.bytes.set(colorPayload(fill.fgColor), 4);
    payload.bytes.set(colorPayload(fill.bgColor), 12);
  }
  return payload.bytes;
}

function borderPayload(border: Partial<Borders>): Uint8Array {
  const payload = createPayload(51);
  if (border.diagonal?.down) {
    payload.bytes[0]! |= 1;
  }
  if (border.diagonal?.up) {
    payload.bytes[0]! |= 2;
  }
  writeBorderEdge(payload.bytes, 1, border.top);
  writeBorderEdge(payload.bytes, 11, border.bottom);
  writeBorderEdge(payload.bytes, 21, border.left);
  writeBorderEdge(payload.bytes, 31, border.right);
  writeBorderEdge(payload.bytes, 41, border.diagonal);
  return payload.bytes;
}

function writeBorderEdge(
  bytes: Uint8Array,
  offset: number,
  border: Partial<Border> | undefined
): void {
  bytes[offset] = border?.style ? (CODE_BY_BORDER.get(border.style) ?? 0) : 0;
  bytes.set(colorPayload(border?.color), offset + 2);
}

function xfPayload(xf: XlsbXf): Uint8Array {
  const payload = createPayload(16);
  payload.view.setUint16(0, xf.parent, true);
  payload.view.setUint16(2, xf.numFmtId, true);
  payload.view.setUint16(4, xf.fontId, true);
  payload.view.setUint16(6, xf.fillId, true);
  payload.view.setUint16(8, xf.borderId, true);
  const alignment = xf.alignment;
  if (alignment?.textRotation === "vertical") {
    payload.bytes[10] = 255;
  } else if (typeof alignment?.textRotation === "number") {
    payload.bytes[10] = encodeRotation(alignment.textRotation);
  }
  payload.bytes[11] = alignment?.indent ?? 0;
  const horizontal = alignment?.horizontal
    ? (CODE_BY_HORIZONTAL.get(alignment.horizontal) ?? 0)
    : 0;
  const vertical = alignment?.vertical ? (CODE_BY_VERTICAL.get(alignment.vertical) ?? 2) : 2;
  payload.bytes[12] = horizontal | (vertical << 3) | (alignment?.wrapText ? 0x40 : 0);
  let protection = alignment?.shrinkToFit ? 0x01 : 0;
  protection |= alignment?.readingOrder === "ltr" ? 0x04 : 0;
  protection |= alignment?.readingOrder === "rtl" ? 0x08 : 0;
  protection |= xf.protection?.locked === false ? 0 : 0x10;
  protection |= xf.protection?.hidden ? 0x20 : 0;
  payload.bytes[13] = protection;
  payload.view.setUint16(14, xf.applyFlags & 0x3f, true);
  return payload.bytes;
}

function parseColor(bytes: Uint8Array): Partial<Color> | undefined {
  if (bytes.length < 8) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = bytes[0]! >>> 1;
  const index = bytes[1]!;
  const tintRaw = view.getInt16(2, true);
  const tint = tintRaw === 0 ? undefined : tintRaw / (tintRaw > 0 ? 32767 : 32768);
  if (type === 2) {
    return compactObject({
      argb: [bytes[7], bytes[4], bytes[5], bytes[6]]
        .map(value => value!.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase(),
      tint
    }) as Partial<Color>;
  }
  if (type === 3) {
    return compactObject({ theme: index, tint }) as Partial<Color>;
  }
  if (type === 1) {
    return compactObject({ indexed: index, tint }) as Partial<Color>;
  }
  return undefined;
}

function colorPayload(color: Partial<Color> | undefined): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  if (color?.argb) {
    const argb = color.argb.length === 6 ? `FF${color.argb}` : color.argb.padStart(8, "F");
    bytes[0] = 0x05;
    bytes[4] = parseInt(argb.slice(2, 4), 16);
    bytes[5] = parseInt(argb.slice(4, 6), 16);
    bytes[6] = parseInt(argb.slice(6, 8), 16);
    bytes[7] = parseInt(argb.slice(0, 2), 16);
  } else if (color?.theme !== undefined) {
    bytes[0] = 0x06;
    bytes[1] = color.theme;
  } else if (color?.indexed !== undefined) {
    bytes[0] = 0x02;
    bytes[1] = color.indexed;
  }
  if (color?.tint !== undefined) {
    const tint = Math.max(-1, Math.min(1, color.tint));
    view.setInt16(2, Math.round(tint * (tint >= 0 ? 32767 : 32768)), true);
  }
  return bytes;
}

function normalizeFont(font?: Partial<Font>, base: Partial<Font> = DEFAULT_FONT): Partial<Font> {
  return {
    ...base,
    ...font,
    color: font?.color ? { ...font.color } : base.color ? { ...base.color } : undefined
  };
}

function normalizeNumFmt(numFmt: Style["numFmt"] | undefined): string | undefined {
  return typeof numFmt === "string" ? numFmt : numFmt?.formatCode;
}

function underlineName(value: number): Font["underline"] | undefined {
  switch (value) {
    case 1:
      return "single";
    case 2:
      return "double";
    case 0x21:
      return "singleAccounting";
    case 0x22:
      return "doubleAccounting";
    default:
      return undefined;
  }
}

function underlineCode(value: Font["underline"] | undefined): number {
  switch (value) {
    case true:
    case "single":
      return 1;
    case "double":
      return 2;
    case "singleAccounting":
      return 0x21;
    case "doubleAccounting":
      return 0x22;
    default:
      return 0;
  }
}

function decodeRotation(value: number): Alignment["textRotation"] | undefined {
  if (value === 0) {
    return undefined;
  }
  if (value === 255) {
    return "vertical";
  }
  if (value <= 90) {
    return value;
  }
  if (value <= 180) {
    return 90 - value;
  }
  return undefined;
}

function encodeRotation(value: number): number {
  const bounded = Math.max(-90, Math.min(90, value));
  return bounded < 0 ? 90 - bounded : bounded;
}

function compactObject<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableKey(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function xfKey(xf: XlsbXf): string {
  return stableKey({
    parent: xf.parent,
    numFmtId: xf.numFmtId,
    fontId: xf.fontId,
    fillId: xf.fillId,
    borderId: xf.borderId,
    alignment: xf.alignment,
    protection: xf.protection,
    applyFlags: xf.applyFlags
  });
}
