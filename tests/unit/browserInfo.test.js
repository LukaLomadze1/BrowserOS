/**
 * @file Unit tests for describeUserAgent(), which About BrowserOS uses to
 * name the browser, engine, and reported operating system.
 */

import { group, test, assert } from "./harness.js";
import { describeUserAgent } from "../../src/core/system/browserInfo.js";

const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const EDGE = `${CHROME_WINDOWS} Edg/145.0.0.0`;
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1";

group("describeUserAgent", () => {
  test("prefers User-Agent Client Hints and skips placeholder brands", () => {
    const info = describeUserAgent(CHROME_WINDOWS, {
      brands: [{ brand: "Not)A;Brand", version: "8" }, { brand: "Chromium", version: "145" }, { brand: "Google Chrome", version: "145" }],
      platform: "Windows",
      mobile: false,
    });
    assert.deepEqual(info, { browser: "Chrome 145", engine: "Blink", platform: "Windows", mobile: false });
  });
  test("uses Chromium when it is the only real brand", () => {
    const info = describeUserAgent(CHROME_WINDOWS, { brands: [{ brand: "Chromium", version: "145" }], platform: "Linux", mobile: false });
    assert.equal(info.browser, "Chromium 145");
    assert.equal(info.platform, "Linux");
  });
  test("reads the user-agent string without Client Hints", () => {
    assert.deepEqual(describeUserAgent(EDGE, null), { browser: "Microsoft Edge 145", engine: "Blink", platform: "Windows", mobile: false });
    assert.deepEqual(describeUserAgent(FIREFOX_LINUX, null), { browser: "Firefox 140", engine: "Gecko", platform: "Linux", mobile: false });
    assert.deepEqual(describeUserAgent(SAFARI_MAC, null), { browser: "Safari 18", engine: "WebKit", platform: "macOS", mobile: false });
  });
  test("recognizes mobile Safari as iOS", () => {
    assert.deepEqual(describeUserAgent(SAFARI_IPHONE, null), { browser: "Safari 18", engine: "WebKit", platform: "iOS", mobile: true });
  });
  test("returns null for what it can't tell, instead of guessing", () => {
    assert.deepEqual(describeUserAgent("SomethingElse/1.0", null), { browser: null, engine: null, platform: null, mobile: false });
  });
});
