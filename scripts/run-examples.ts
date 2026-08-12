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
    file: "src/modules/excel/examples/a1-addressing.ts",
    description: "Test A1-style cell references",
    outputFiles: []
  },
  {
    file: "src/modules/excel/examples/colour-cell.ts",
    description: "Test cell colors and fills",
    outputFiles: ["src/modules/excel/examples/data/colour-cell.xlsx"],
    args: ["src/modules/excel/examples/data/colour-cell.xlsx"]
  },
  {
    file: "src/modules/excel/examples/formulas.ts",
    description: "Test formula functionality",
    outputFiles: ["src/modules/excel/examples/data/formulas.xlsx"],
    args: ["src/modules/excel/examples/data/formulas.xlsx"]
  },
  {
    file: "src/modules/excel/examples/hyperlinks.ts",
    description: "Test hyperlink functionality",
    outputFiles: ["src/modules/excel/examples/data/hyperlinks.xlsx"],
    args: ["src/modules/excel/examples/data/hyperlinks.xlsx"]
  },
  {
    file: "src/modules/excel/examples/merge-align.ts",
    description: "Test cell merging and alignment",
    outputFiles: ["src/modules/excel/examples/data/merge-align.xlsx"],
    args: ["src/modules/excel/examples/data/merge-align.xlsx"]
  },
  {
    file: "src/modules/excel/examples/table.ts",
    description: "Test Excel table functionality",
    outputFiles: ["src/modules/excel/examples/data/table.xlsx"],
    args: ["src/modules/excel/examples/data/table.xlsx"]
  },
  {
    file: "src/modules/excel/examples/newline.ts",
    description: "Test newlines in cells",
    outputFiles: ["src/modules/excel/examples/data/newline.xlsx"],
    args: ["src/modules/excel/examples/data/newline.xlsx"]
  },
  {
    file: "src/modules/excel/examples/tiny-workbook.ts",
    description: "Test minimal workbook output",
    outputFiles: ["src/modules/excel/examples/data/tiny-workbook.xlsx"],
    args: ["src/modules/excel/examples/data/tiny-workbook.xlsx"]
  },
  {
    file: "src/modules/excel/examples/web-streams-reader-writer.ts",
    description: "Web Streams: writer -> reader roundtrip",
    outputFiles: []
  },
  {
    file: "src/modules/excel/examples/checkbox.ts",
    description: "Checkbox cells (Office Online compatible)",
    outputFiles: ["src/modules/excel/examples/data/checkbox.xlsx"],
    args: ["src/modules/excel/examples/data/checkbox.xlsx"]
  },
  {
    file: "src/modules/excel/examples/images-external.ts",
    description: "External (linked) images — referenced, not embedded",
    outputFiles: ["tmp/images-external.xlsx"],
    args: ["tmp/images-external.xlsx"]
  },
  // Formula engine examples — one per function category.
  {
    file: "src/modules/formula/examples/formula-math.ts",
    description: "Formula: math & trigonometry",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-text.ts",
    description: "Formula: text functions",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-logical.ts",
    description: "Formula: logical & conditional",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-date.ts",
    description: "Formula: date & time",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-lookup.ts",
    description: "Formula: lookup & reference",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-statistical.ts",
    description: "Formula: statistical functions",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-financial.ts",
    description: "Formula: financial functions",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-dynamic-array.ts",
    description: "Formula: dynamic arrays & spill",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-database.ts",
    description: "Formula: database (D-) functions",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-engineering.ts",
    description: "Formula: engineering & conversions",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-information.ts",
    description: "Formula: information functions",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-custom-functions.ts",
    description: "Formula: custom function registration",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-standalone.ts",
    description: "Formula: recalculation + tokenize/parse",
    outputFiles: []
  },
  {
    file: "src/modules/formula/examples/formula-pdf-integration.ts",
    description: "Formula: automatic recalc during excelToPdf()",
    outputFiles: ["tmp/formula-examples/formula-pdf-integration.pdf"]
  },
  {
    file: "src/modules/pdf/examples/pdf-page-setup.ts",
    description: "PDF: Excel page-setup fidelity, incl. issue #203 regression",
    outputFiles: [
      "tmp/pdf-examples/issue-203-fixed.pdf",
      "tmp/pdf-examples/print-titles-outside-print-area.pdf",
      "tmp/pdf-examples/comments-as-displayed.pdf",
      "tmp/pdf-examples/combined-settings.pdf"
    ]
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
  const examplePath = path.join(__dirname, "..", example.file);

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
