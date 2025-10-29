import { SharedStringsXform } from "../xlsx/xform/strings/shared-strings-xform.js";

const filename = process.argv[2];

const st = new SharedStringsXform();

const lst = ["Hello", "Hello", "World", "Hello\nWorld!", "Hello, 'World!'"];
for (const item of lst) {
  st.add(item);
}

console.log(`Writing sharedstrings to ${filename}`);
console.log("Shared strings:", st.values);
console.log("Done.");
