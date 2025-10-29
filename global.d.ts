/**
 * Global type augmentations for ExcelTS
 */

declare namespace NodeJS {
  interface Global {
    TextEncoder?: typeof TextEncoder;
    TextDecoder?: typeof TextDecoder;
  }
}

// eslint-disable-next-line no-var
declare var global: NodeJS.Global & typeof globalThis;
