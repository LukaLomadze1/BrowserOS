/**
 * @file Embedding policy — decides whether the Browser shows a web page
 * inside BrowserOS or explains that it has to open in the host browser.
 *
 * Why this exists: the Browser renders web pages in a sandboxed iframe.
 * Many sites forbid being displayed inside another page (X-Frame-Options
 * or Content-Security-Policy frame-ancestors). The host browser then
 * shows nothing, and — because of cross-origin isolation — BrowserOS
 * cannot detect that reliably or read the refusing headers. So the
 * decision combines:
 *
 *   1. a short list of popular sites known to refuse embedding
 *      (the list can go out of date; "Show here anyway" overrides it);
 *   2. the user's per-site choices: "Always open in your browser" and
 *      "Show here anyway";
 *   3. everything else is embedded, with a notice offering the host
 *      browser in case the page stays blank.
 *
 * Per-site choices persist through StorageService ("browser:sitePolicies").
 * Events: "browser:sitePoliciesChanged" {}.
 */

import { eventBus } from "../eventBus.js";
import { storage } from "../storage.js";
import { hostOf } from "./urlUtils.js";

const POLICIES_KEY = "browser:sitePolicies";
const MAX_POLICIES = 200;

/**
 * Sites (and their subdomains) that send headers forbidding embedding on
 * their main pages. Paths listed in `allowPaths` are designed to be embedded.
 */
const KNOWN_REFUSING_SITES = Object.freeze([
  { domain: "google.com" },
  { domain: "youtube.com", allowPaths: ["/embed/"] },
  { domain: "github.com" },
  { domain: "gitlab.com" },
  { domain: "stackoverflow.com" },
  { domain: "facebook.com" },
  { domain: "instagram.com" },
  { domain: "twitter.com" },
  { domain: "x.com" },
  { domain: "linkedin.com" },
  { domain: "reddit.com" },
  { domain: "amazon.com" },
  { domain: "paypal.com" },
  { domain: "netflix.com" },
  { domain: "bing.com" },
  { domain: "duckduckgo.com" },
]);

/**
 * @typedef {"embed"|"known-refusal"|"external"} EmbedDecision
 */

class FramePolicy {
  constructor() {
    /** @type {Record<string, "external"|"embed">|null} host -> choice */
    this._policies = null;
  }

  /**
   * @param {string} url
   * @returns {EmbedDecision}
   */
  decide(url) {
    const host = hostOf(url);
    if (!host) return "embed";
    const choice = this._choiceFor(host);
    if (choice === "external") return "external";
    if (choice === "embed") return "embed";
    return this.isKnownRefusal(url) ? "known-refusal" : "embed";
  }

  /**
   * @param {string} url
   * @returns {boolean} Whether the site is on the known-refusal list.
   */
  isKnownRefusal(url) {
    const host = hostOf(url);
    if (!host) return false;
    let path = "/";
    try {
      path = new URL(url).pathname;
    } catch {
      /* keep "/" */
    }
    return KNOWN_REFUSING_SITES.some(
      (site) => (host === site.domain || host.endsWith(`.${site.domain}`)) && !(site.allowPaths ?? []).some((prefix) => path.startsWith(prefix))
    );
  }

  /**
   * @param {string} url - Any URL on the site.
   * @param {"external"|"embed"|null} choice - null forgets the site's choice.
   * @returns {void}
   */
  setSiteChoice(url, choice) {
    const host = hostOf(url);
    if (!host) return;
    const policies = this._load();
    if (choice === "external" || choice === "embed") policies[host] = choice;
    else delete policies[host];
    const entries = Object.entries(policies);
    this._policies = Object.fromEntries(entries.slice(-MAX_POLICIES));
    storage.set(POLICIES_KEY, this._policies);
    eventBus.emit("browser:sitePoliciesChanged", Object.freeze({}));
  }

  /**
   * @param {string} url
   * @returns {"external"|"embed"|null}
   */
  getSiteChoice(url) {
    const host = hostOf(url);
    return host ? this._choiceFor(host) : null;
  }

  /** @returns {Array<{host: string, choice: "external"|"embed"}>} */
  listSiteChoices() {
    return Object.entries(this._load())
      .map(([host, choice]) => ({ host, choice }))
      .sort((a, b) => a.host.localeCompare(b.host));
  }

  /**
   * @param {string} host
   * @returns {"external"|"embed"|null}
   */
  _choiceFor(host) {
    const choice = this._load()[host];
    return choice === "external" || choice === "embed" ? choice : null;
  }

  /** @returns {Record<string, "external"|"embed">} */
  _load() {
    if (this._policies) return this._policies;
    const stored = storage.get(POLICIES_KEY, {});
    this._policies = {};
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [host, choice] of Object.entries(stored)) {
        if (/^[a-z0-9.-]+$/i.test(host) && (choice === "external" || choice === "embed")) this._policies[host.toLowerCase()] = choice;
      }
    }
    return this._policies;
  }
}

/**
 * Singleton embedding policy.
 * @type {FramePolicy}
 */
export const framePolicy = new FramePolicy();
