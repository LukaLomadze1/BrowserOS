/**
 * @file Alert sounds synthesized with the Web Audio API — no audio
 * files to ship or load.
 *
 * Browsers only allow audio after the page has received a user
 * gesture. If the audio context can't start, sounds are skipped
 * silently and the visual notification still appears, so an alert is
 * never lost because sound was blocked.
 */

/** Selectable sound styles; "none" is silent. */
export const ALERT_SOUNDS = Object.freeze([
  Object.freeze({ id: "chime", label: "Chime" }),
  Object.freeze({ id: "bell", label: "Bell" }),
  Object.freeze({ id: "digital", label: "Digital" }),
  Object.freeze({ id: "soft", label: "Soft" }),
  Object.freeze({ id: "none", label: "Silent" }),
]);

/** Note sequences: [frequency Hz, start offset s, duration s]. */
const PATTERNS = Object.freeze({
  chime: { wave: "sine", gain: 0.22, notes: [[880, 0, 0.35], [1318.5, 0.18, 0.5]] },
  bell: { wave: "triangle", gain: 0.25, notes: [[659.3, 0, 0.9], [987.8, 0, 0.9], [1318.5, 0, 0.6]] },
  digital: { wave: "square", gain: 0.08, notes: [[1046.5, 0, 0.1], [1046.5, 0.15, 0.1], [1046.5, 0.3, 0.1], [1046.5, 0.45, 0.1]] },
  soft: { wave: "sine", gain: 0.15, notes: [[523.3, 0, 0.6], [659.3, 0.25, 0.7]] },
});

/** Length of one pattern including its tail, used to space repeats. */
const PATTERN_INTERVAL_MS = 1600;

let audioContext = null;

/**
 * @returns {AudioContext|null}
 */
function getContext() {
  if (audioContext) return audioContext;
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) return null;
  try {
    audioContext = new Context();
  } catch {
    audioContext = null;
  }
  return audioContext;
}

/**
 * Play one instance of a sound.
 * @param {string} style - An ALERT_SOUNDS id.
 * @returns {void}
 */
export function playAlertSound(style) {
  const pattern = PATTERNS[style];
  if (!pattern) return;
  const context = getContext();
  if (!context) return;
  if (context.state === "suspended") {
    context.resume().catch(() => {});
  }
  if (context.state !== "running" && context.state !== "suspended") return;

  const start = context.currentTime + 0.02;
  for (const [frequency, offset, duration] of pattern.notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = pattern.wave;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start + offset);
    gain.gain.linearRampToValueAtTime(pattern.gain, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + duration + 0.05);
  }
}

/**
 * Repeat a sound until stopped or until `maxDurationMs` elapses.
 * @param {string} style
 * @param {number} [maxDurationMs]
 * @returns {() => void} Stops the loop. Safe to call more than once.
 */
export function loopAlertSound(style, maxDurationMs = 60000) {
  if (!PATTERNS[style]) return () => {};
  playAlertSound(style);
  const intervalId = window.setInterval(() => playAlertSound(style), PATTERN_INTERVAL_MS);
  const timeoutId = window.setTimeout(() => window.clearInterval(intervalId), maxDurationMs);
  return () => {
    window.clearInterval(intervalId);
    window.clearTimeout(timeoutId);
  };
}
