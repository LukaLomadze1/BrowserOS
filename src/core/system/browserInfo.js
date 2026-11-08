/**
 * @file What the browser reports about itself and the device, for About
 * BrowserOS.
 *
 * Everything here comes from standard web APIs (User-Agent Client
 * Hints where available, otherwise the user-agent string, plus the
 * Screen, Storage, and Intl APIs). Browsers simplify or hide some of
 * these values for privacy, so they describe what this browser tells
 * web pages, not the computer's actual hardware. Nothing is guessed:
 * a value the browser doesn't report is returned as null.
 */

/**
 * @typedef {object} BrowserInfo
 * @property {string|null} browser - e.g. "Chrome 145"
 * @property {string|null} engine - "Blink", "Gecko", or "WebKit"
 * @property {string|null} platform - The operating system the browser reports, e.g. "Windows"
 * @property {boolean} mobile
 * @property {string|null} language
 * @property {string|null} timeZone
 * @property {number|null} logicalProcessors
 * @property {{width: number, height: number, pixelRatio: number}|null} screen
 */

/** @returns {BrowserInfo} */
export function getBrowserInfo() {
  return {
    ...describeUserAgent(navigator.userAgent ?? "", navigator.userAgentData ?? null),
    language: navigator.language || null,
    timeZone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone) || null,
    logicalProcessors: Number.isInteger(navigator.hardwareConcurrency) && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : null,
    screen: window.screen ? { width: window.screen.width, height: window.screen.height, pixelRatio: window.devicePixelRatio || 1 } : null,
  };
}

/**
 * Name the browser, its engine, and the operating system it reports,
 * from User-Agent Client Hints when present, otherwise from the
 * user-agent string.
 * @param {string} ua - navigator.userAgent
 * @param {{brands?: Array<{brand: string, version: string}>, platform?: string, mobile?: boolean}|null} data - navigator.userAgentData
 * @returns {{browser: string|null, engine: string|null, platform: string|null, mobile: boolean}}
 */
export function describeUserAgent(ua, data) {
  return {
    browser: browserName(data, ua),
    engine: engineName(ua),
    platform: platformName(data, ua),
    mobile: data ? data.mobile === true : /Mobi|Android|iPhone|iPad/.test(ua),
  };
}

/**
 * The browser's storage estimate for this site (everything BrowserOS
 * stores), and whether the site's storage is persistent.
 * @returns {Promise<{usage: number|null, quota: number|null, persisted: boolean|null}>}
 */
export async function getStorageInfo() {
  const result = { usage: null, quota: null, persisted: null };
  if (!navigator.storage) return result;
  try {
    if (typeof navigator.storage.estimate === "function") {
      const estimate = await navigator.storage.estimate();
      if (Number.isFinite(estimate.usage)) result.usage = estimate.usage;
      if (Number.isFinite(estimate.quota)) result.quota = estimate.quota;
    }
    if (typeof navigator.storage.persisted === "function") result.persisted = await navigator.storage.persisted();
  } catch (error) {
    console.warn("[browserInfo] the storage estimate isn't available:", error);
  }
  return result;
}

/**
 * @param {*} data - navigator.userAgentData
 * @param {string} ua
 * @returns {string|null}
 */
function browserName(data, ua) {
  const brands = Array.isArray(data?.brands) ? data.brands.filter((brand) => !/not.?a.?brand/i.test(brand.brand)) : [];
  if (brands.length > 0) {
    const named = brands.find((brand) => brand.brand !== "Chromium") ?? brands[0];
    const label = named.brand === "Google Chrome" ? "Chrome" : named.brand;
    return `${label} ${named.version}`;
  }
  const patterns = [
    [/Edg\/(\d+)/, "Microsoft Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Version\/(\d+)[.\d]* .*Safari\//, "Safari"],
  ];
  for (const [pattern, label] of patterns) {
    const match = pattern.exec(ua);
    if (match) return `${label} ${match[1]}`;
  }
  return null;
}

/**
 * @param {string} ua
 * @returns {string|null}
 */
function engineName(ua) {
  if (/Gecko\/\d/.test(ua) && /Firefox\//.test(ua)) return "Gecko";
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return "Blink";
  if (/AppleWebKit\//.test(ua)) return "WebKit";
  return null;
}

/**
 * @param {*} data - navigator.userAgentData
 * @param {string} ua
 * @returns {string|null}
 */
function platformName(data, ua) {
  if (typeof data?.platform === "string" && data.platform) return data.platform;
  if (/Windows NT/.test(ua)) return "Windows";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

/**
 * @template T
 * @param {() => T} read
 * @returns {T|null}
 */
function safe(read) {
  try {
    return read();
  } catch {
    return null;
  }
}
