#!/usr/bin/env node
/**
 * Run specified example files and report results
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// List of example files to test with descriptions
interface ExampleTest {
  file: string;
  description: string;
  outputFiles?: string[]; // Generated file paths (relative to project root)
  args?: string[]; // Arguments passed to the script
}

const examples: ExampleTest[] = [
  {
    file: "test-a1.ts",
    description: "Test A1-style cell references",
    outputFiles: []
  },
  {
    file: "test-colour-cell.ts",
    description: "Test cell colors and fills",
    outputFiles: ["src/examples/data/test-colour-cell.xlsx"],
    args: ["src/examples/data/test-colour-cell.xlsx"]
  },
  {
    file: "test-formula.ts",
    description: "Test formula functionality",
    outputFiles: ["src/examples/data/test-formula.xlsx"],
    args: ["src/examples/data/test-formula.xlsx"]
  },
  {
    file: "test-hyperlink.ts",
    description: "Test hyperlink functionality",
    outputFiles: ["src/examples/data/test-hyperlink.xlsx"],
    args: ["src/examples/data/test-hyperlink.xlsx"]
  },
  {
    file: "test-merge-align.ts",
    description: "Test cell merging and alignment",
    outputFiles: ["src/examples/data/test-merge-align.xlsx"],
    args: ["src/examples/data/test-merge-align.xlsx"]
  },
  {
    file: "testBookOut.ts",
    description: "Test full workbook output (fonts, borders, fills, etc.)",
    outputFiles: ["src/examples/data/test.xlsx"],
    args: ["src/examples/data/test.xlsx"]
  },
  {
    file: "test-table.ts",
    description: "Test Excel table functionality",
    outputFiles: ["src/examples/data/test-table.xlsx"],
    args: ["src/examples/data/test-table.xlsx"]
  },
  {
    file: "test-newline.ts",
    description: "Test newlines in cells",
    outputFiles: ["src/examples/data/test-newline.xlsx"],
    args: ["src/examples/data/test-newline.xlsx"]
  },
  {
    file: "testTinyBookOut.ts",
    description: "Test minimal workbook output",
    outputFiles: ["src/examples/data/test-tiny.xlsx"],
    args: ["src/examples/data/test-tiny.xlsx"]
  }
];

interface TestResult {
  file: string;
  description: string;
  success: boolean;
  duration: number;
  error?: string;
  outputFiles?: string[];
}

async function runExample(example: ExampleTest): Promise<TestResult> {
  const startTime = Date.now();
  const examplePath = path.join(__dirname, "../src/examples", example.file);

  // Prepare command arguments
  const args = ["tsx", examplePath];
  if (example.args) {
    args.push(...example.args);
  }

  return new Promise(resolve => {
    const proc = spawn("npx", args, {
      stdio: "pipe",
      cwd: path.join(__dirname, "..")
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", data => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", data => {
      stderr += data.toString();
    });

    proc.on("close", code => {
      const duration = Date.now() - startTime;

      if (code === 0) {
        resolve({
          file: example.file,
          description: example.description,
          success: true,
          duration,
          outputFiles: example.outputFiles
        });
      } else {
        resolve({
          file: example.file,
          description: example.description,
          success: false,
          duration,
          error: stderr || stdout,
          outputFiles: example.outputFiles
        });
      }
    });

    proc.on("error", error => {
      resolve({
        file: example.file,
        description: example.description,
        success: false,
        duration: Date.now() - startTime,
        error: error.message,
        outputFiles: example.outputFiles
      });
    });
  });
}

async function runAll() {
  console.log(`🧪 Running ${examples.length} examples...\n`);

  const results: TestResult[] = [];

  for (const example of examples) {
    console.log(`\n📝 ${example.description}`);
    process.stdout.write(`   Testing ${example.file}... `);
    const result = await runExample(example);
    results.push(result);

    if (result.success) {
      console.log(`✅ (${result.duration}ms)`);
      if (result.outputFiles && result.outputFiles.length > 0) {
        console.log(`   📄 Output: ${result.outputFiles.join(", ")}`);
      }
    } else {
      console.log(`❌ (${result.duration}ms)`);
      if (result.error) {
        const errorLines = result.error.split("\n").slice(0, 3);
        console.log(`   ❗ Error: ${errorLines.join("\n   ")}`);
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Summary:");
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Total:  ${results.length}`);

  if (failed > 0) {
    console.log("\n❌ Failed examples:");
    results
      .filter(r => !r.success)
      .forEach(r => {
        console.log(`   - ${r.file}: ${r.description}`);
      });
    process.exit(1);
  } else {
    console.log("\n✨ All examples passed! Check the output files above.");
  }
}

runAll().catch(console.error);
