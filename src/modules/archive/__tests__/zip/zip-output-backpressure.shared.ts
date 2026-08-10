import { zip } from "@archive/create-archive";
import { describe, expect, it } from "vitest";

export function runZipOutputBackpressureTests(): void {
  describe("ZIP output backpressure", () => {
    for (const level of [0, 6]) {
      it(`should bound production while a level ${level} sink write is blocked`, async () => {
        let releaseWrite!: () => void;
        const blockedWrite = new Promise<void>(resolve => {
          releaseWrite = resolve;
        });
        let writeStarted!: () => void;
        const firstWrite = new Promise<void>(resolve => {
          writeStarted = resolve;
        });
        let produced = 0;

        async function* source(): AsyncIterable<Uint8Array> {
          for (let i = 0; i < 64; i++) {
            produced++;
            const chunk = new Uint8Array(1024);
            for (let j = 0; j < chunk.length; j++) {
              chunk[j] = (i * 31 + j * 17) & 0xff;
            }
            yield chunk;
          }
        }

        let writes = 0;
        const sink = new WritableStream<Uint8Array>({
          write() {
            writes++;
            if (writes === 1) {
              writeStarted();
              return blockedWrite;
            }
          }
        });

        const piping = zip({ level }).add("data.bin", source()).pipeTo(sink);
        await firstWrite;
        // Smart STORE retains a fixed 16 KiB sample before selecting STORE vs
        // DEFLATE. One additional input may enter while the first output is held
        // by the sink, but production must not consume the rest of the archive.
        expect(produced).toBeLessThanOrEqual(17);

        releaseWrite();
        await piping;
        expect(produced).toBe(64);
      });
    }
  });
}
