#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cjsDir = path.join(__dirname, "../dist/cjs");

function fixImports(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);

    try {
      // If successful, it's a directory - recurse
      fixImports(filePath);
    } catch (err) {
      // Not a directory or can't read, try as file
      if (file.endsWith(".js")) {
        try {
          let content = fs.readFileSync(filePath, "utf8");

          // Remove .js extensions from require() calls
          content = content.replace(/require\("([^"]+)\.js"\)/g, 'require("$1")');

          fs.writeFileSync(filePath, content);
        } catch (readErr) {
          // Skip files that can't be read or written
          if (readErr.code !== "ENOENT") {
            console.error(`Error reading/writing ${filePath}:`, readErr.message);
          }
        }
      }
    }
  }
}

console.log("Fixing CJS imports...");
fixImports(cjsDir);

// Create package.json for CJS directory
const cjsPackageJson = {
  type: "commonjs"
};
fs.writeFileSync(path.join(cjsDir, "package.json"), JSON.stringify(cjsPackageJson, null, 2));

console.log("Done!");
