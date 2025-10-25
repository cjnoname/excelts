import fs from "fs/promises";
import path from "path";

export async function cleanDir(dirPath: string): Promise<void> {
  const files = await fs.readdir(dirPath);
  await Promise.all(
    files.map(async file => {
      const filePath = path.join(dirPath, file);
      const stat = await fs.stat(filePath);

      if (stat.isFile()) {
        console.log(`unlink ${filePath}`);
        await fs.unlink(filePath);
      } else if (stat.isDirectory()) {
        await cleanDir(filePath);
        console.log(`rmdir ${filePath}`);
        await fs.rmdir(filePath);
      }
    })
  );
}

export function randomName(length: number = 5): string {
  const text: string[] = [];
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (let i = 0; i < length; i++) {
    text.push(possible.charAt(Math.floor(Math.random() * possible.length)));
  }

  return text.join("");
}

export function randomNum(d: number): number {
  return Math.round(Math.random() * d);
}

export function fmtNumber(n: number): string {
  // output large numbers with thousands separator
  const s = n.toString();
  const l = s.length;
  const a: string[] = [];
  let r = l % 3 || 3;
  let i = 0;
  while (i < l) {
    a.push(s.substr(i, r));
    i += r;
    r = 3;
  }
  return a.join(",");
}

// For backward compatibility
export const utils = {
  cleanDir,
  randomName,
  randomNum,
  fmt: {
    number: fmtNumber
  }
};
