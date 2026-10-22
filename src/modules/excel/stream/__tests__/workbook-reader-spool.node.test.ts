/**
 * A worksheet the archive delivers before the parts it depends on is spooled to
 * a temporary file and replayed later. Those files must be gone by the time the
 * reader's loop is left — however it is left — and removing them must not race
 * the stream still reading one: removing first failed a pending open with
 * ENOENT on a stream nobody listened to any more (every run on Bun), and a
 * consumer that left early used to leave every sheet not yet replayed on disk.
 *
 * `os.tmpdir()` is pointed at a private directory for the duration, so what is
 * counted is this reader's spool and nothing a parallel test created.
 */

import fs, { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zip } from "@archive/create-archive";
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel/index";
import { WorkbookReader } from "@excel/stream/workbook-reader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEMP_VARIABLES = ["TMPDIR", "TMP", "TEMP"] as const;

describe("WorkbookReader spool files", () => {
  let spoolRoot: string;
  let saved: Array<string | undefined>;
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    uncaught.push(reason);
  };

  beforeEach(() => {
    spoolRoot = mkdtempSync(join(tmpdir(), "spool-root-"));
    saved = TEMP_VARIABLES.map(name => process.env[name]);
    for (const name of TEMP_VARIABLES) {
      process.env[name] = spoolRoot;
    }
    uncaught.length = 0;
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandledRejection);
    vi.restoreAllMocks();
    TEMP_VARIABLES.forEach((name, i) => {
      if (saved[i] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[i];
      }
    });
    rmSync(spoolRoot, { recursive: true, force: true });
  });

  /** Three sheets as `Workbook.toBuffer` lays them out: before the workbook, so each is spooled. */
  async function threeSheets(): Promise<Uint8Array> {
    const wb = Workbook.create();
    for (const name of ["A", "B", "C"]) {
      Cell.setValue(Workbook.addWorksheet(wb, name), "A1", name);
    }
    return Workbook.toBuffer(wb);
  }

  /** Spool directories left behind, once anything already scheduled has had its turn. */
  async function leftBehind(): Promise<string[]> {
    const now = readdirSync(spoolRoot);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(readdirSync(spoolRoot)).toEqual(now);
    return now;
  }

  it("spools at all (otherwise the cases below prove nothing)", async () => {
    const spooled: number[] = [];
    for await (const ws of new WorkbookReader(await threeSheets(), {})) {
      spooled.push(readdirSync(spoolRoot).length);
      for await (const _row of ws) {
        // read it whole
      }
    }
    expect(spooled[0]).toBeGreaterThan(0);
  });

  it.each([
    ["read to the end", "all"],
    ["left during the first sheet's rows", "rows"],
    ["left before reading a row", "sheet"]
  ] as const)("are all removed when the loop is %s", async (_label, leave) => {
    const seen: string[] = [];
    for await (const ws of new WorkbookReader(await threeSheets(), {})) {
      seen.push(ws.name);
      if (leave === "sheet") {
        break;
      }
      for await (const _row of ws) {
        if (leave === "rows") {
          break;
        }
      }
      if (leave === "rows") {
        break;
      }
    }
    expect(seen).toEqual(leave === "all" ? ["A", "B", "C"] : ["A"]);
    expect(await leftBehind()).toEqual([]);
    expect(uncaught).toEqual([]);
  });

  /** The same package, entry order kept, with one part's bytes replaced. */
  async function withPart(buffer: Uint8Array, name: string, text: string): Promise<Uint8Array> {
    const archive = zip();
    for (const [path, file] of await extractAll(buffer)) {
      if (file.type !== "directory") {
        archive.add(path, path === name ? new TextEncoder().encode(text) : file.data);
      }
    }
    return archive.bytes();
  }

  /** Let anything already scheduled report itself before `uncaught` is read. */
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50));

  it("hands a failure while replaying a spooled sheet to the consumer, and still removes the spool", async () => {
    const broken = await withPart(
      await threeSheets(),
      "xl/worksheets/sheet2.xml",
      '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"'
    );
    const seen: string[] = [];
    const reading = (async () => {
      for await (const ws of new WorkbookReader(broken, {})) {
        seen.push(ws.name);
        for await (const _row of ws) {
          // read it whole
        }
      }
    })();
    await expect(reading).rejects.toThrow();
    expect(seen).toContain("A");
    await settle();
    expect(await leftBehind()).toEqual([]);
    expect(uncaught).toEqual([]);
  });

  it("keeps the consumer's own error, and still removes the spool", async () => {
    const mine = new Error("the consumer's own failure");
    const reading = (async () => {
      for await (const ws of new WorkbookReader(await threeSheets(), {})) {
        for await (const _row of ws) {
          throw mine;
        }
      }
    })();
    await expect(reading).rejects.toBe(mine);
    await settle();
    expect(await leftBehind()).toEqual([]);
    expect(uncaught).toEqual([]);
  });

  it("fails a spool over its limit without an unhandled rejection, and removes it", async () => {
    const reading = (async () => {
      for await (const ws of new WorkbookReader(await threeSheets(), {
        maxBufferedWorksheetBytes: 16
      })) {
        for await (const _row of ws) {
          // read it whole
        }
      }
    })();
    await expect(reading).rejects.toThrow("maxBufferedWorksheetBytes");
    await settle();
    expect(await leftBehind()).toEqual([]);
    expect(uncaught).toEqual([]);
  });

  it("waits for a spool file's pending open before removing it", async () => {
    // Bun opens a file stream later than Node does, so a consumer leaving at
    // once had its spool removed before the open ran. Delaying the open here
    // makes that order happen on Node too.
    const realOpen = fs.open;
    const delayed: string[] = [];
    vi.spyOn(fs, "open").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      const flags = rest.length > 1 ? rest[0] : "r";
      if (String(path).startsWith(spoolRoot) && (flags === "r" || flags === 0)) {
        delayed.push(String(path));
        setTimeout(() => (realOpen as (...args: unknown[]) => void)(path, ...rest), 30);
        return;
      }
      (realOpen as (...args: unknown[]) => void)(path, ...rest);
    }) as typeof fs.open);

    for await (const _ws of new WorkbookReader(await threeSheets(), {})) {
      break;
    }
    await settle();
    expect(delayed.length).toBeGreaterThan(0);
    expect(await leftBehind()).toEqual([]);
    expect(uncaught).toEqual([]);
  });
});
