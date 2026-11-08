/**
 * @file The two sample web projects, written into /Projects. They are
 * ordinary HTML, CSS, and JavaScript files meant to be opened in Code
 * Studio and run in its live preview (or opened in the Browser app).
 *
 * The preview runs pages in a sandboxed frame with an opaque origin, so
 * the samples don't depend on localStorage or network requests.
 */

const PORTFOLIO_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alex Rivera · Frontend developer</title>
  <link rel="icon" href="assets/logo.svg">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="index.html">
      <img src="assets/logo.svg" alt="" width="28" height="28">
      <span>Alex Rivera</span>
    </a>
    <nav aria-label="Main">
      <a href="index.html" aria-current="page">Work</a>
      <a href="about.html">About</a>
      <button class="theme-toggle" type="button" aria-pressed="false">Light theme</button>
    </nav>
  </header>

  <main>
    <section class="hero">
      <p class="eyebrow">Frontend developer</p>
      <h1>I build fast, accessible interfaces for the web.</h1>
      <p class="lead">This is a sample site. Edit <code>index.html</code>, <code>styles.css</code>, or
        <code>script.js</code> in Code Studio and the preview updates as you type.</p>
    </section>

    <section aria-labelledby="work-title">
      <div class="section-head">
        <h2 id="work-title">Selected work</h2>
        <div class="filters" role="group" aria-label="Filter projects">
          <button type="button" data-filter="all" aria-pressed="true">All</button>
          <button type="button" data-filter="web" aria-pressed="false">Web apps</button>
          <button type="button" data-filter="design" aria-pressed="false">Design systems</button>
          <button type="button" data-filter="tools" aria-pressed="false">Tools</button>
        </div>
      </div>
      <ul class="projects">
        <li class="card" data-tags="web">
          <h3>Trail Planner</h3>
          <p>Offline-first route planner with a service worker and a canvas elevation chart.</p>
          <p class="tags">Web app · Canvas · IndexedDB</p>
        </li>
        <li class="card" data-tags="design">
          <h3>Northwind UI</h3>
          <p>Design tokens and twenty accessible components shared by four product teams.</p>
          <p class="tags">Design system · CSS · WCAG AA</p>
        </li>
        <li class="card" data-tags="tools">
          <h3>Diffable</h3>
          <p>A command-line tool that compares two JSON files and explains every change.</p>
          <p class="tags">Tool · Node.js</p>
        </li>
        <li class="card" data-tags="web">
          <h3>Market Board</h3>
          <p>Live dashboard that streams prices and keeps 60 frames per second on mid-range phones.</p>
          <p class="tags">Web app · WebSockets</p>
        </li>
        <li class="card" data-tags="design tools">
          <h3>Contrast Checker</h3>
          <p>Browser extension that flags text below WCAG contrast ratios as you design.</p>
          <p class="tags">Tool · Accessibility</p>
        </li>
      </ul>
      <p class="empty" hidden>No projects match this filter.</p>
    </section>

    <section class="contact" aria-labelledby="contact-title">
      <h2 id="contact-title">Say hello</h2>
      <form class="contact-form" novalidate>
        <label>Name <input name="name" autocomplete="name" required></label>
        <label>Email <input name="email" type="email" autocomplete="email" required></label>
        <label class="wide">Message <textarea name="message" rows="4" required></textarea></label>
        <button type="submit">Send message</button>
        <p class="form-status" role="status"></p>
      </form>
    </section>
  </main>

  <footer class="site-footer">
    <p>© <span id="year"></span> Alex Rivera · A sample project for BrowserOS Code Studio</p>
  </footer>

  <script src="script.js"></script>
</body>
</html>
`;

const PORTFOLIO_ABOUT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>About · Alex Rivera</title>
  <link rel="icon" href="assets/logo.svg">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="index.html">
      <img src="assets/logo.svg" alt="" width="28" height="28">
      <span>Alex Rivera</span>
    </a>
    <nav aria-label="Main">
      <a href="index.html">Work</a>
      <a href="about.html" aria-current="page">About</a>
      <button class="theme-toggle" type="button" aria-pressed="false">Light theme</button>
    </nav>
  </header>

  <main>
    <section class="hero">
      <p class="eyebrow">About</p>
      <h1>Eight years of building for the web.</h1>
      <p class="lead">This second page shows that links between project pages work in the preview:
        select <b>Work</b> above to go back.</p>
    </section>

    <section aria-labelledby="timeline-title">
      <h2 id="timeline-title">Timeline</h2>
      <ol class="timeline">
        <li><span>2024 – now</span> Staff frontend engineer, Northwind</li>
        <li><span>2021 – 2024</span> Senior developer, Lumen Studio</li>
        <li><span>2018 – 2021</span> Web developer, freelance</li>
      </ol>
    </section>
  </main>

  <footer class="site-footer">
    <p>© <span id="year"></span> Alex Rivera · A sample project for BrowserOS Code Studio</p>
  </footer>

  <script src="script.js"></script>
</body>
</html>
`;

const PORTFOLIO_CSS = `/* Sample portfolio styles: custom properties, grid, and a light theme. */

:root {
  --bg: #0f1220;
  --surface: #171b2e;
  --border: #2a3050;
  --text: #eef1f7;
  --muted: #a3abc0;
  --accent: #7c6cf6;
  --radius: 14px;
  color-scheme: dark;
}

:root[data-theme="light"] {
  --bg: #f6f7fb;
  --surface: #ffffff;
  --border: #dde1ec;
  --text: #151a26;
  --muted: #4a5366;
  --accent: #5b48d9;
  color-scheme: light;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}

a { color: inherit; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 0.92em; }

.site-header,
main,
.site-footer {
  width: min(960px, 100% - 40px);
  margin-inline: auto;
}

.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  text-decoration: none;
}

nav { display: flex; align-items: center; gap: 18px; }
nav a { text-decoration: none; color: var(--muted); }
nav a[aria-current="page"] { color: var(--text); font-weight: 600; }

button {
  font: inherit;
  color: inherit;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 14px;
  cursor: pointer;
}

button:hover { border-color: var(--accent); }
button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.hero { padding: 56px 0 32px; }
.eyebrow { margin: 0; color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.8rem; }
h1 { margin: 8px 0 16px; font-size: clamp(1.8rem, 4vw, 2.8rem); line-height: 1.15; max-width: 20ch; }
.lead { margin: 0; color: var(--muted); max-width: 60ch; }

.section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; }

.projects {
  list-style: none;
  margin: 20px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.card {
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: transform 160ms ease, border-color 160ms ease;
}

.card:hover { transform: translateY(-2px); border-color: var(--accent); }
.card h3 { margin: 0 0 6px; }
.card p { margin: 0; color: var(--muted); }
.card .tags { margin-top: 12px; font-size: 0.85rem; color: var(--accent); }
.empty { color: var(--muted); }

.contact { margin: 56px 0; }
.contact-form { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; max-width: 640px; }
.contact-form label { display: grid; gap: 6px; font-weight: 600; font-size: 0.9rem; }
.contact-form .wide, .form-status { grid-column: 1 / -1; }
.contact-form input, .contact-form textarea {
  font: inherit;
  color: inherit;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
}
.contact-form [aria-invalid="true"] { border-color: #f2495c; }
.contact-form button[type="submit"] { justify-self: start; background: var(--accent); border-color: var(--accent); color: #fff; }
.form-status { margin: 0; min-height: 1.6em; color: var(--muted); }

.timeline { padding-left: 20px; }
.timeline li { margin: 8px 0; }
.timeline span { display: inline-block; min-width: 120px; color: var(--muted); }

.site-footer { padding: 24px 0 40px; color: var(--muted); font-size: 0.9rem; border-top: 1px solid var(--border); }

@media (max-width: 600px) {
  .site-header { flex-direction: column; align-items: flex-start; }
  .contact-form { grid-template-columns: 1fr; }
}
`;

const PORTFOLIO_JS = `// Sample portfolio behavior: theme switch, project filter, and form validation.
// Messages printed with console.log appear in Code Studio's Output panel.

const root = document.documentElement;
const themeButton = document.querySelector(".theme-toggle");

themeButton?.addEventListener("click", () => {
  const light = root.dataset.theme !== "light";
  root.dataset.theme = light ? "light" : "dark";
  themeButton.setAttribute("aria-pressed", String(light));
  themeButton.textContent = light ? "Dark theme" : "Light theme";
  console.log("Theme:", root.dataset.theme);
});

const filterButtons = document.querySelectorAll("[data-filter]");
const cards = document.querySelectorAll(".card");
const empty = document.querySelector(".empty");

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter;
    filterButtons.forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    let shown = 0;
    cards.forEach((card) => {
      const match = filter === "all" || card.dataset.tags.split(" ").includes(filter);
      card.hidden = !match;
      if (match) shown += 1;
    });
    if (empty) empty.hidden = shown > 0;
    console.log(\`Filter "\${filter}": \${shown} project(s)\`);
  });
});

const form = document.querySelector(".contact-form");
const status = document.querySelector(".form-status");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = [...form.querySelectorAll("input, textarea")];
  const invalid = fields.filter((field) => !field.checkValidity());
  fields.forEach((field) => field.setAttribute("aria-invalid", String(invalid.includes(field))));
  if (invalid.length > 0) {
    status.textContent = "Please fill in every field with a valid value.";
    invalid[0].focus();
    return;
  }
  // A real site would send the message to a server here.
  status.textContent = \`Thanks, \${form.elements.name.value}! (This sample doesn't send anything.)\`;
  form.reset();
});

const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());
`;

const PORTFOLIO_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#7c6cf6"/>
  <path d="M18 44L30 18h4l12 26h-6l-3-7H27l-3 7zm11-12h6l-3-7z" fill="#ffffff"/>
</svg>
`;

const PORTFOLIO_README = `# Portfolio website (sample)

A small multi-page site written in plain HTML, CSS, and JavaScript.

- \`index.html\`: project cards with a filter, and a contact form with validation
- \`about.html\`: a second page, linked from the navigation
- \`styles.css\`: custom properties, a light theme, CSS grid, and a narrow layout
- \`script.js\`: the theme switch, the filter, and the form

Open this folder in Code Studio and select **Run** (Ctrl + Enter). Edits
appear in the preview as you type; \`console.log\` output appears in the
Output panel.
`;

const DEMO_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Orbits · JavaScript demo</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="app">
    <header>
      <h1>Orbits</h1>
      <p>A canvas animation driven by <code>requestAnimationFrame</code>. Change the controls, or edit
        <code>app.js</code> and watch the preview update.</p>
    </header>

    <canvas id="scene" width="640" height="360" aria-label="Animated particles orbiting a center point"></canvas>

    <form class="controls">
      <label>Particles <output id="count-value">120</output>
        <input id="count" type="range" min="10" max="400" value="120">
      </label>
      <label>Speed <output id="speed-value">1.0×</output>
        <input id="speed" type="range" min="0" max="3" step="0.1" value="1">
      </label>
      <label>Trails
        <input id="trails" type="checkbox" checked>
      </label>
      <button id="pause" type="button">Pause</button>
      <button id="burst" type="button">Burst</button>
    </form>

    <p class="stats" aria-live="polite">Frames per second: <span id="fps">–</span></p>
  </main>

  <script type="module" src="app.js"></script>
</body>
</html>
`;

const DEMO_CSS = `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #0b0d16;
  color: #e7eaf3;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.app { width: min(680px, 100% - 32px); padding: 24px 0; }
h1 { margin: 0 0 4px; font-size: 1.6rem; }
header p { margin: 0 0 16px; color: #9aa3b8; }
code { color: #34e2c6; }

canvas {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 14px;
  background: #050611;
  border: 1px solid #23283d;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
}

.controls label { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; }
output { min-width: 3.5ch; color: #34e2c6; font-variant-numeric: tabular-nums; }

button {
  font: inherit;
  color: inherit;
  background: #1a1f33;
  border: 1px solid #2f3654;
  border-radius: 8px;
  padding: 6px 14px;
  cursor: pointer;
}

button:hover { border-color: #7c6cf6; }
.stats { color: #9aa3b8; font-size: 0.85rem; }
`;

const DEMO_JS = `// Orbits: particles circling the center of a canvas.
// Everything here runs in Code Studio's sandboxed preview frame.

import { createParticles, stepParticles } from "./particles.js";

const canvas = document.getElementById("scene");
const context = canvas.getContext("2d");
const countInput = document.getElementById("count");
const speedInput = document.getElementById("speed");
const trailsInput = document.getElementById("trails");
const pauseButton = document.getElementById("pause");
const burstButton = document.getElementById("burst");
const fpsLabel = document.getElementById("fps");

let particles = createParticles(Number(countInput.value), canvas);
let paused = false;
let lastTime = performance.now();
let frames = 0;
let fpsTimer = 0;

countInput.addEventListener("input", () => {
  document.getElementById("count-value").textContent = countInput.value;
  particles = createParticles(Number(countInput.value), canvas);
});

speedInput.addEventListener("input", () => {
  document.getElementById("speed-value").textContent = \`\${Number(speedInput.value).toFixed(1)}×\`;
});

pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume" : "Pause";
  console.log(paused ? "Paused" : "Resumed");
});

burstButton.addEventListener("click", () => {
  for (const particle of particles) particle.velocity *= 2.5;
  console.log(\`Burst: \${particles.length} particles sped up\`);
});

function frame(now) {
  const elapsed = Math.min(64, now - lastTime);
  lastTime = now;

  if (!paused) {
    context.fillStyle = trailsInput.checked ? "rgba(5, 6, 17, 0.18)" : "#050611";
    context.fillRect(0, 0, canvas.width, canvas.height);
    stepParticles(particles, elapsed * Number(speedInput.value));
    for (const particle of particles) {
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fillStyle = particle.color;
      context.fill();
    }
  }

  frames += 1;
  fpsTimer += elapsed;
  if (fpsTimer >= 500) {
    fpsLabel.textContent = String(Math.round((frames * 1000) / fpsTimer));
    frames = 0;
    fpsTimer = 0;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
console.log("Orbits started with", particles.length, "particles");
`;

const DEMO_PARTICLES_JS = `// Particle model for app.js, loaded as an ES module import.

const COLORS = ["#7c6cf6", "#34e2c6", "#4f8ff7", "#f2607e", "#f5b955"];

/**
 * @param {number} count
 * @param {HTMLCanvasElement} canvas
 */
export function createParticles(count, canvas) {
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  return Array.from({ length: count }, (_, index) => {
    const radius = 30 + Math.random() * Math.min(centerX, centerY) * 0.9;
    return {
      centerX,
      centerY,
      radius,
      angle: Math.random() * Math.PI * 2,
      velocity: (0.4 + Math.random()) / radius,
      size: 1 + Math.random() * 2.5,
      color: COLORS[index % COLORS.length],
      x: centerX,
      y: centerY,
    };
  });
}

/**
 * Move every particle along its orbit; bursts slowly settle back down.
 * @param {ReturnType<typeof createParticles>} particles
 * @param {number} elapsed - Milliseconds since the last frame, already scaled by speed.
 */
export function stepParticles(particles, elapsed) {
  for (const particle of particles) {
    const base = (0.4 + (particle.size - 1) / 2.5) / particle.radius;
    particle.velocity += (base - particle.velocity) * 0.02;
    particle.angle += particle.velocity * elapsed * 0.06;
    particle.x = particle.centerX + Math.cos(particle.angle) * particle.radius;
    particle.y = particle.centerY + Math.sin(particle.angle) * particle.radius * 0.55;
  }
}
`;

const DEMO_README = `# JavaScript demo (sample)

An animated canvas that shows JavaScript running in Code Studio's live
preview:

- \`app.js\`: the animation loop, controls, and a frames-per-second counter
- \`particles.js\`: an ES module imported by \`app.js\`
- \`style.css\` and \`index.html\`: layout and controls

Open this folder in Code Studio and select **Run**. Try changing the
colors in \`particles.js\`; \`console.log\` output appears in the Output
panel.
`;

/** @type {ReadonlyArray<{path: string, text: string}>} */
export const SAMPLE_PROJECT_FILES = Object.freeze([
  { path: "/Projects/Portfolio-Website/index.html", text: PORTFOLIO_INDEX },
  { path: "/Projects/Portfolio-Website/about.html", text: PORTFOLIO_ABOUT },
  { path: "/Projects/Portfolio-Website/styles.css", text: PORTFOLIO_CSS },
  { path: "/Projects/Portfolio-Website/script.js", text: PORTFOLIO_JS },
  { path: "/Projects/Portfolio-Website/assets/logo.svg", text: PORTFOLIO_LOGO },
  { path: "/Projects/Portfolio-Website/README.md", text: PORTFOLIO_README },
  { path: "/Projects/JavaScript-Demo/index.html", text: DEMO_INDEX },
  { path: "/Projects/JavaScript-Demo/style.css", text: DEMO_CSS },
  { path: "/Projects/JavaScript-Demo/app.js", text: DEMO_JS },
  { path: "/Projects/JavaScript-Demo/particles.js", text: DEMO_PARTICLES_JS },
  { path: "/Projects/JavaScript-Demo/README.md", text: DEMO_README },
]);
