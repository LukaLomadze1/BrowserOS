/**
 * @file Sample pictures: three PNG images drawn locally on a canvas
 * and one SVG, so Image Viewer and the image file associations have
 * something to show without any download.
 */

const FOLDER = "/Pictures/Sample Pictures";

const PNG_SAMPLES = Object.freeze([
  { name: "Aurora.png", colors: ["#1b1f3b", "#7c6cf6", "#34e2c6"], shape: "waves" },
  { name: "Horizon.png", colors: ["#2b1a2f", "#f59e42", "#f2607e"], shape: "sun" },
  { name: "Lagoon.png", colors: ["#062a3a", "#22c7e0", "#a3e635"], shape: "circles" },
]);

const SVG_SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
  <rect width="640" height="420" rx="36" fill="#141826"/>
  <g transform="translate(224 70) scale(4)" fill="none" stroke="#eef1f7" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M39 22.2V16a8 8 0 0 0-8-8H13a8 8 0 0 0-8 8v14a8 8 0 0 0 8 8h10.2"/>
    <path d="M5 17h34" stroke-linecap="butt"/>
    <circle cx="37" cy="36" r="8.5" fill="#7c6cf6" stroke="none"/>
  </g>
  <text x="320" y="372" fill="#eef1f7" font-family="sans-serif" font-size="34" font-weight="600" text-anchor="middle">BrowserOS</text>
</svg>
`;

/**
 * @returns {Array<{path: string, render: () => Promise<Blob|string|null>}>}
 *   The sample pictures, each drawn only when it is about to be written.
 */
export function getSamplePictures() {
  return [
    ...PNG_SAMPLES.map((sample) => ({ path: `${FOLDER}/${sample.name}`, render: () => renderSample(sample) })),
    { path: `${FOLDER}/BrowserOS.svg`, render: async () => SVG_SAMPLE },
  ];
}

/**
 * @param {{colors: string[], shape: string}} sample
 * @returns {Promise<Blob|null>}
 */
function renderSample({ colors, shape }) {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 600;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);

  const background = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  background.addColorStop(0, colors[0]);
  background.addColorStop(1, shade(colors[0], 30));
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.globalAlpha = 0.85;
  if (shape === "waves") {
    for (let i = 0; i < 5; i += 1) {
      context.beginPath();
      const waveY = (x) => 300 + i * 40 + Math.sin(x / 90 + i) * 60;
      context.moveTo(0, waveY(0));
      for (let x = 20; x <= canvas.width; x += 20) context.lineTo(x, waveY(x));
      context.strokeStyle = i % 2 ? colors[1] : colors[2];
      context.lineWidth = 10;
      context.stroke();
    }
  } else if (shape === "sun") {
    const sun = context.createRadialGradient(480, 380, 20, 480, 380, 260);
    sun.addColorStop(0, colors[1]);
    sun.addColorStop(1, "transparent");
    context.fillStyle = sun;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = colors[2];
    context.fillRect(0, 420, canvas.width, 180);
  } else {
    for (let i = 0; i < 9; i += 1) {
      context.beginPath();
      context.arc(120 + i * 95, 300 + Math.sin(i) * 120, 40 + (i % 3) * 30, 0, Math.PI * 2);
      context.fillStyle = i % 2 ? colors[1] : colors[2];
      context.fill();
    }
  }
  context.globalAlpha = 1;
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

/**
 * @param {string} hex
 * @param {number} amount
 * @returns {string} A lighter variant of a #rrggbb color.
 */
function shade(hex, amount) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift) => Math.min(255, ((value >> shift) & 255) + amount);
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}
