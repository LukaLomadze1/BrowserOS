/**
 * @file Project templates. Creating a project writes these files into
 * a new folder through the VFS; Code Studio then works on the real
 * files like any other project (nothing is kept in memory only).
 *
 * A template is { id, name, description, folders: string[], files:
 * Record<relativePath, (projectName) => string>, open: string[] }.
 * `open` lists the files opened in the editor after creation, the first
 * of which also becomes the preview page when it is HTML.
 */

/**
 * @param {string} text
 * @returns {string} HTML-escaped text for use in template markup.
 */
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const PROJECT_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "blank",
    name: "Blank",
    description: "An empty folder.",
    folders: [],
    files: {},
    open: [],
  }),
  Object.freeze({
    id: "html",
    name: "HTML Website",
    description: "Two linked pages and an assets folder.",
    folders: ["assets"],
    files: {
      "index.html": (name) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)}</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      max-width: 42rem;
      margin: 3rem auto;
      padding: 0 1.25rem;
      line-height: 1.6;
      color: #1f2933;
    }
    nav a {
      margin-right: 1rem;
    }
  </style>
</head>
<body>
  <nav>
    <a href="index.html">Home</a>
    <a href="about.html">About</a>
  </nav>
  <h1>${escapeHtml(name)}</h1>
  <p>Edit <code>index.html</code> and the preview updates as you type.</p>
</body>
</html>
`,
      "about.html": (name) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>About \u2014 ${escapeHtml(name)}</title>
</head>
<body>
  <nav>
    <a href="index.html">Home</a>
    <a href="about.html">About</a>
  </nav>
  <h1>About</h1>
  <p>Links between pages of the project open in the preview.</p>
</body>
</html>
`,
    },
    open: ["index.html"],
  }),
  Object.freeze({
    id: "web",
    name: "HTML, CSS & JavaScript",
    description: "index.html with a linked stylesheet and script.",
    folders: ["assets"],
    files: {
      "index.html": (name) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(name)}</h1>
    <p>You clicked <strong id="count">0</strong> times.</p>
    <button id="counter" type="button">Click me</button>
  </main>
  <script src="script.js"></script>
</body>
</html>
`,
      "style.css": () => `* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, sans-serif;
  background: #eef2f7;
  color: #1f2933;
}

.card {
  padding: 2rem 2.5rem;
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  text-align: center;
}

button {
  padding: 0.6rem 1.2rem;
  border: none;
  border-radius: 8px;
  background: #4f46e5;
  color: #ffffff;
  font: inherit;
  cursor: pointer;
}

button:hover {
  background: #4338ca;
}
`,
      "script.js": () => `const button = document.getElementById("counter");
const output = document.getElementById("count");
let count = 0;

button.addEventListener("click", () => {
  count += 1;
  output.textContent = String(count);
  console.log("Clicked", count, "times");
});
`,
    },
    open: ["index.html", "style.css", "script.js"],
  }),
  Object.freeze({
    id: "javascript",
    name: "JavaScript Project",
    description: "ES modules in src/, run by a minimal page.",
    folders: ["src"],
    files: {
      "index.html": (name) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)}</title>
</head>
<body>
  <pre id="output"></pre>
  <script type="module" src="src/main.js"></script>
</body>
</html>
`,
      "src/main.js": () => `import { greet, sum } from "./utils.js";

const output = document.getElementById("output");

function print(...values) {
  output.textContent += values.join(" ") + "\\n";
  console.log(...values);
}

print(greet("BrowserOS"));
print("1 + 2 + 3 =", sum([1, 2, 3]));
`,
      "src/utils.js": () => `/**
 * @param {string} name
 * @returns {string}
 */
export function greet(name) {
  return \`Hello, \${name}!\`;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
`,
      "README.md": (name) => `# ${name}

Modules in \`src/\` run in the live preview, which loads \`index.html\`.
Open the Output panel to see \`console\` messages.
`,
    },
    open: ["src/main.js", "index.html"],
  }),
]);

/**
 * @param {string} id
 * @returns {object|undefined}
 */
export function getTemplate(id) {
  return PROJECT_TEMPLATES.find((template) => template.id === id);
}
