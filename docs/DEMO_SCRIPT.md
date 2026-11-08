# BrowserOS demo script

A two-and-a-half-minute screen recording that shows BrowserOS doing
real work: starting, creating a file, using the Terminal, building and
running a small website in Code Studio, and personalizing the desktop.
Every step is a live interaction; nothing is staged.

## Before recording

1. Build and serve the production copy:
   ```sh
   python tools/build.py
   python tools/serve.py dist
   ```
2. Open <http://127.0.0.1:8000/> in a **new browser profile** (or a
   private window that allows site storage), so BrowserOS starts as a
   new installation and the Welcome tour appears.
3. Set the browser window to 1440 × 900 or 1920 × 1080, hide bookmarks
   bars and extensions, and turn on the operating system's Do Not
   Disturb.
4. Record the browser window only, at 30 or 60 frames per second, with
   the cursor visible.

## Script

Times are approximate; the narration is a suggestion.

| Time | Action | Narration |
| ---- | ------ | --------- |
| 0:00 | Reload the page. The start-up screen shows the logo and progress, then fades into the desktop with the Welcome tour. | "This is BrowserOS: a desktop environment that runs entirely in a browser tab. No install, no server, no frameworks." |
| 0:10 | In the tour, leave **Add sample files** checked and select **Get started**. Pick **Light**, then **Dark** again, an accent color, and the **Nebula** wallpaper. | "On first start it lets you pick a look; every change applies live." |
| 0:22 | Select **Skip tour**. | "The rest of the tour explains the basics. Let's just use it." |
| 0:25 | Open the **Start** menu, type `calc`, press Enter. Do a quick calculation, close Calculator. | "The Start menu searches apps, files, and settings." |
| 0:35 | Right-click the desktop › **New › Text Document**, name it `plan.txt`, double-click it, type two lines in Notes, close Notes. | "Files are real: they live in BrowserOS's own file system in the browser's storage." |
| 0:50 | Press **Ctrl + Alt + T**. Type `ls /Desktop`, `cat /Desktop/plan.txt`, then `tree /Projects`. | "The Terminal sees the same files, including the sample projects." |
| 1:05 | Type `code /Projects/Portfolio-Website`. In Code Studio, select **Run**. | "Code Studio opens the folder as a project and runs it in an isolated preview." |
| 1:15 | In `styles.css`, change `--accent: #7c6cf6;` to `--accent: #f2607e;`. The preview updates as you type. Click **Tools** in the preview's filter. | "Edits show up immediately, and the page's JavaScript really runs." |
| 1:30 | **File › New file…**, create `hello.js` with `console.log("Hello from BrowserOS")`; add `<script src="hello.js"></script>` to `index.html` before `</body>`; save; open the Output panel. | "New files go straight into the project folder…" |
| 1:45 | Open **File Explorer** from the Start menu, go to `/Projects/Portfolio-Website`, and show `hello.js` next to the other files. | "…and File Explorer shows them, because every app shares one file system." |
| 1:55 | Switch between Code Studio, File Explorer, and the Terminal with the taskbar and **Alt + \`**. Open **Task Manager** (Ctrl + Alt + Esc). | "Windows, a taskbar, and a Task Manager that lists running apps and background services." |
| 2:10 | Open **Settings › Appearance**, switch to the light theme, change the accent; open **Settings › System** and point at **Back up everything**. | "Everything is configurable, and all your data can be backed up to a single file." |
| 2:25 | Close the windows, open the Start menu once more, and end on the desktop. | "BrowserOS: an operating-system experience, built with the web platform." |

## Notes

- If a step fails during recording, start again in a fresh profile; the
  Welcome tour appears only on a new installation.
- The Browser application isn't in the script because most well-known
  sites refuse to be shown inside another page; to include it, open the
  Browser's start page and a site that allows embedding.
- To reset between takes, use a new private window, or delete the site's
  data for the address in the browser's settings.
