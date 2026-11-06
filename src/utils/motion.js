/**
 * @file Reads the centralized motion-duration tokens from CSS.
 *
 * Animation timing lives in styles/variables.css (--duration-fast,
 * --duration-normal, --duration-slow) and changes at runtime with the
 * animation-speed and reduced-motion settings. JavaScript that needs
 * to wait for a transition (e.g. removing an element after its exit
 * animation) must read the current token instead of hardcoding a
 * millisecond value, or it will cut animations short at "slow" and
 * wait needlessly when motion is reduced.
 */

const FALLBACK_MS = Object.freeze({ fast: 120, normal: 220, slow: 400 });

/**
 * @param {"fast"|"normal"|"slow"} token
 * @returns {number} The token's current duration in milliseconds (0 when reduced motion is in effect).
 */
export function getMotionDuration(token) {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(`--duration-${token}`).trim();
    const parsed = parseCssTime(raw);
    return parsed ?? FALLBACK_MS[token] ?? 0;
  } catch {
    return FALLBACK_MS[token] ?? 0;
  }
}

/**
 * @param {string} value - e.g. "220ms", "0.4s", "0ms".
 * @returns {number|null}
 */
function parseCssTime(value) {
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(value);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  return match[2] === "s" ? amount * 1000 : amount;
}
