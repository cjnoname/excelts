import path from "path";

/**
 * Generate unique output filename for tests to avoid file conflicts during parallel testing
 * @param testFilePath - Path to the test file (use import.meta.url)
 * @param extension - File extension, defaults to '.xlsx'
 * @returns Unique test file path
 */
export function getUniqueTestFilePath(testFilePath: string, extension = ".xlsx"): string {
  const fileName = path.basename(testFilePath, ".test.ts");
  return `./src/__test__/out/${fileName}${extension}`;
}

export function getUniqueTestFilePathCJS(filename: string, extension = ".xlsx"): string {
  const fileName = path.basename(filename, ".test");
  return `./src/__test__/out/${fileName}${extension}`;
}

/**
 * Simple helper to generate test output file path from a name
 * @param name - Base name for the test file (without extension)
 * @param extension - File extension, defaults to '.xlsx'
 * @returns Test file path
 */
export function testFilePath(name: string, extension = ".xlsx"): string {
  return `./src/__test__/out/${name}${extension}`;
}

/**
 * Get path to test data file
 * @param filename - Filename in the data directory
 * @returns Path to test data file
 */
export function testDataPath(filename: string): string {
  return `./src/__test__/integration/data/${filename}`;
}
