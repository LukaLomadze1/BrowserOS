/**
 * @file Text content of the sample files: documents, notes, and the
 * Downloads example. The two web projects are in sampleProjects.js and
 * the pictures are drawn by samplePictures.js.
 *
 * Every entry is a path and its text; demoContent.js writes them
 * through the VFS like any other file.
 */

/**
 * @param {string} html
 * @returns {string} A Notes document (.note) holding `html`.
 */
function note(html) {
  return JSON.stringify({ format: "browseros-note", version: 1, html });
}

const WELCOME = `Welcome to BrowserOS
====================

BrowserOS is a desktop environment that runs in this browser tab:
windows, a file system, and a set of applications, written in plain
HTML, CSS, and JavaScript. Nothing is installed on your computer. Your
files and settings are stored in this browser and stay here between
visits.

This file is one of the sample files. They are ordinary files: open,
edit, move, or delete them like your own. To remove the ones you
haven't changed, open Settings > System > Sample files.

Where to start
--------------
* Start menu (the button in the lower-left corner, or the Windows key):
  every application, plus search for apps, files, and settings.
* File Explorer: the folders below are real folders in BrowserOS's
  file system.
    /Documents  this file, the guide, and sample notes
    /Projects   two web projects to open in Code Studio
    /Pictures   sample pictures for Image Viewer
    /Downloads  where the Browser saves downloaded files
* Code Studio: open /Projects/Portfolio-Website and select Run to see
  the site in the live preview.
* Terminal: type "help" for the list of commands, for example
  "ls /Documents" or "tree /Projects".
* Settings: theme, accent color, wallpaper, and much more. Back up
  everything to a file on your computer from Settings > System.

BrowserOS-Guide.txt, next to this file, explains each application.
`;

const GUIDE = `BrowserOS guide
===============

The desktop
-----------
* Double-click an icon to open it. Drag icons to arrange them. Drop
  files from your computer onto the desktop to copy them into
  BrowserOS.
* Right-click the desktop, an icon, or a window's taskbar button for
  more actions (New folder, Rename, Open with, Properties, ...).
* Select several icons by dragging a rectangle around them, or with
  Ctrl + click. Ctrl + C, Ctrl + X, and Ctrl + V copy, cut, and paste.
* Delete moves items to the Recycle Bin. Restore them from there, or
  delete them permanently.

Windows
-------
* Drag a title bar to move a window; drag an edge or corner to resize.
* Double-click a title bar (or press Alt + Shift + Up) to maximize or
  restore a window. Alt + Shift + W closes the active window.
* Alt + \` cycles through open windows. Every open window also has a
  button on the taskbar.

Keyboard shortcuts (the defaults; see Settings > Keyboard Shortcuts)
-------------------------------------------------------------------
  Windows key ............ open or close the Start menu
  Ctrl + Alt + T ......... new Terminal window
  Ctrl + Alt + E ......... File Explorer
  Ctrl + , ............... Settings
  Ctrl + Alt + Esc ....... Task Manager
  Alt + Shift + N ........ Notification Center
  Alt + Shift + A ........ Quick Settings

Applications
------------
File Explorer   Browse, search, copy, move, rename, import, and delete
                files. Favorites, three views, and the Trash.
Terminal        A command line for the same file system: ls, cd, mkdir,
                cp, mv, rm, cat, echo, tree, open, code, download, ...
                Type "help" for all commands.
Code Studio     A code editor for HTML, CSS, and JavaScript projects with
                a live preview that runs the page in an isolated frame,
                project search, diagnostics, and a built-in terminal.
Browser         Tabs, bookmarks, history, and downloads into /Downloads.
                Many sites refuse to be shown inside another page; those
                open in a new tab of your own browser instead.
Notes           Rich-text notes, saved as files in /Documents/Notes. It
                also opens .txt and .md files as plain text.
Calendar        Events, recurring events, and reminders.
Clock           World clock, alarms, stopwatch, and timer.
Calculator      Standard and scientific modes with history.
Image Viewer    PNG, JPEG, WebP, GIF, and SVG images, with zoom.
Task Manager    Running applications, responsiveness, and background
                services.
Settings        Appearance, wallpaper, desktop, Start menu, keyboard
                shortcuts, backup and restore, and more.

Your data
---------
Everything lives in this browser's storage (IndexedDB for files,
localStorage for settings), for this site only. Clearing the site's data
in your browser erases it, so make backups: Settings > System > Back up
everything saves one file to your computer, and Restore from a backup
brings it back.

BrowserOS runs in one tab at a time. Opening it in a second tab offers
to move it there, so two copies never overwrite each other.
`;

const KICKOFF = note(
  "<h1>Project kickoff</h1>" +
    "<p><b>Goal:</b> publish the portfolio site in <code>/Projects/Portfolio-Website</code>.</p>" +
    "<h2>Agenda</h2>" +
    "<ol><li>Review the home page layout</li><li>Pick three projects to feature</li><li>Write the about page</li></ol>" +
    "<h2>Decisions</h2>" +
    "<ul><li>Keep it static: HTML, CSS, and a small script</li><li>Support a light and a dark theme</li></ul>" +
    "<blockquote>Open the project in Code Studio and select Run to see it.</blockquote>"
);

const READING = note(
  "<h1>Reading list</h1>" +
    '<ul data-checklist="true">' +
    '<li data-checked="true">MDN: Using the Web Storage API</li>' +
    '<li data-checked="false">MDN: IndexedDB key concepts</li>' +
    '<li data-checked="false">web.dev: Learn CSS (grid and flexbox chapters)</li>' +
    '<li data-checked="false">The iframe sandbox attribute</li>' +
    "</ul>" +
    '<p>Ctrl + click a link to open it: <a href="https://developer.mozilla.org/">developer.mozilla.org</a></p>'
);

const WEEKLY = note(
  "<h1>Weekly plan</h1>" +
    "<h2>Monday</h2><ul><li>Sketch the portfolio cards</li></ul>" +
    "<h2>Wednesday</h2><ul><li>Try the JavaScript demo and change its colors</li></ul>" +
    "<h2>Friday</h2>" +
    '<ul data-checklist="true"><li data-checked="false">Back up BrowserOS (Settings &gt; System)</li><li data-checked="false">Empty the Recycle Bin</li></ul>'
);

const DOWNLOADS_NOTE = `About this folder
=================

Files you download with the Browser app, or with the Terminal's
"download" command, are saved in /Downloads. The Downloads app (in the
Start menu) lists them with their progress and lets you open them or
show them in File Explorer.

This text file is a sample: it was not downloaded from anywhere and can
be deleted.
`;

/** @type {ReadonlyArray<{path: string, text: string}>} */
export const SAMPLE_DOCUMENTS = Object.freeze([
  { path: "/Documents/Welcome.txt", text: WELCOME },
  { path: "/Documents/BrowserOS-Guide.txt", text: GUIDE },
  { path: "/Documents/Sample-Notes/Project kickoff.note", text: KICKOFF },
  { path: "/Documents/Sample-Notes/Reading list.note", text: READING },
  { path: "/Documents/Sample-Notes/Weekly plan.note", text: WEEKLY },
  { path: "/Downloads/About-Downloads.txt", text: DOWNLOADS_NOTE },
]);
