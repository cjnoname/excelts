export interface FunctionRuntimeContext {
  readonly date1904: boolean;
}

export const DEFAULT_FUNCTION_CONTEXT: FunctionRuntimeContext = { date1904: false };
