import { randomName } from "./utils/utils.js";
import { HrStopwatch } from "./utils/hr-stopwatch.js";
import { StringBuf } from "../utils/string-buf.js";
import { delay } from "../utils/utils.js";

const SIZE = 1048576;

function testWrite(results) {
  const a = [];

  function test(size) {
    return function () {
      console.log(`Write: ${size}`);
      const text = randomName(size);
      const sb = new StringBuf({ size: SIZE + 10 });
      const sw = new HrStopwatch();
      sw.start();
      while (sb.length < SIZE) {
        sb.addText(text);
      }
      sw.stop();
      a.push(`${size}:${Math.round(sw.span * 1000)}`);
    };
  }

  return Promise.resolve()
    .then(test(1))
    .then(() => delay(1000))
    .then(test(2))
    .then(() => delay(1000))
    .then(test(4))
    .then(() => delay(1000))
    .then(test(8))
    .then(() => delay(1000))
    .then(test(16))
    .then(() => delay(1000))
    .then(test(32))
    .then(() => delay(1000))
    .then(test(64))
    .then(() => delay(1000))
    .then(() => {
      results.write = a.join(", ");
      return results;
    });
}

function testGrow(results) {
  const a = [];

  function test(size) {
    return function () {
      console.log(`Grow: ${size}`);
      const text = randomName(size);
      const sb = new StringBuf({ size: 8 });
      const sw = new HrStopwatch();
      sw.start();
      while (sb.length < SIZE) {
        sb.addText(text);
      }
      sw.stop();
      a.push(`${size}:${Math.round(sw.span * 1000)}`);
    };
  }

  return Promise.resolve()
    .then(test(1))
    .then(() => delay(1000))
    .then(test(2))
    .then(() => delay(1000))
    .then(test(4))
    .then(() => delay(1000))
    .then(test(8))
    .then(() => delay(1000))
    .then(test(16))
    .then(() => delay(1000))
    .then(test(32))
    .then(() => delay(1000))
    .then(test(64))
    .then(() => delay(1000))
    .then(() => {
      results.grow = a.join(", ");
      return results;
    });
}

const results = {};
Promise.resolve(results)
  .then(testWrite)
  .then(testGrow)
  .then(r => {
    console.log(JSON.stringify(r, null, "  "));
  });
