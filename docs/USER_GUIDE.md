# BrowserOS user guide

BrowserOS is a desktop environment that runs in a browser tab. It has
its own windows, file system, and applications, and keeps everything in
the browser you use it in. This guide covers everyday use; the keyboard
shortcuts listed are the defaults (all of them are in **Settings ›
Keyboard Shortcuts**, where some can be turned off).

## Contents

- [The first start](#the-first-start)
- [The desktop](#the-desktop)
- [Windows](#windows)
- [The Start menu](#the-start-menu)
- [The taskbar and system tray](#the-taskbar-and-system-tray)
- [Files and folders](#files-and-folders)
- [Applications](#applications)
- [Settings](#settings)
- [Your data](#your-data)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [When something goes wrong](#when-something-goes-wrong)

## The first start

The first time BrowserOS starts in a browser, the **Welcome** tour
opens. In about a minute it lets you pick a theme, an accent color, and
a wallpaper, shows the basics, and lists the applications.

On its first page, **Add sample files to explore** is checked. Leave it
checked to get a guide, notes, two web projects, pictures, and a
download to try things with; uncheck it to start empty. The samples are
ordinary files: change or delete them as you like, or remove the
unchanged ones later in **Settings › System › Getting started**.

**Skip tour** closes the tour at any point. Open it again from the
Start menu (**Welcome**) or **Settings › System**.

## The desktop

- **Open** an icon by double-clicking it, or select it and press
  Enter.
- **Select** several icons by dragging a rectangle around them, with
  Ctrl + click, or with Ctrl + A.
- **Arrange** icons by dragging them. Right-click the desktop for
  **View** (icon size, auto arrange, grid alignment, labels), **Sort
  by**, and **Arrange icons**; more options are in **Settings ›
  Desktop**.
- **Create** a folder or a text document with **New** in the desktop's
  right-click menu. Files in `/Desktop` appear on the desktop.
- **Copy, cut, paste, rename, and delete** with the right-click menu or
  Ctrl + C, Ctrl + X, Ctrl + V, F2, and Delete.
- **Import** files from your computer by dropping them on the desktop
  or a File Explorer window.

## Windows

- Drag the **title bar** to move a window, and its edges or corners to
  resize it.
- **Maximize** with the title-bar button, by double-clicking the title
  bar, or with Alt + Shift + Up. Alt + Shift + Down minimizes, and
  Alt + Shift + W closes the active window.
- **Switch** windows with their taskbar buttons, or with Alt + \`
  (Alt + Shift + \` goes back).
- Applications with unsaved work, such as Code Studio, ask before their
  window closes.

## The Start menu

Open it with the **Start** button in the lower-left corner or the
Windows key.

- **Pinned applications** are your shortcuts; choose and order them in
  **Settings › Start Menu**.
- **Recent applications** and **recent files** are listed below them.
- **Search**: start typing to find applications, files, folders, and
  settings; Enter opens the first result.
- **Restart** reloads BrowserOS. **Shut down** saves everything and
  stops BrowserOS until you select **Start BrowserOS**; another tab can
  then use it. Both ask first if an application has unsaved work.

## The taskbar and system tray

- Each open window has a **taskbar button**: click to focus, minimize,
  or restore; right-click to close it, close all windows of its
  application, or open Task Manager.
- **Quick Settings** (slider icon, Alt + Shift + A): Do Not Disturb,
  sounds, notification previews, transparency, reduced motion, theme,
  accent, and animation speed.
- **Notification Center** (bell, Alt + Shift + N): reminders, alarms,
  downloads, and system messages, grouped by application, with Do Not
  Disturb.
- **Clock**: opens the date panel, a month calendar where days with
  events are marked; choosing a day opens Calendar at that date.

## Files and folders

Everything you save is stored in BrowserOS's own file system, and every
application sees the same files. The main folders:

| Folder        | What goes there |
| ------------- | --------------- |
| `/Desktop`    | Files shown on the desktop |
| `/Documents`  | Your documents; Notes saves notes in `/Documents/Notes`, Calendar its events in `/Documents/Calendar` |
| `/Projects`   | Code Studio projects |
| `/Pictures`   | Images |
| `/Downloads`  | Files downloaded by the Browser or the Terminal's `download` command |
| `/Trash`      | Deleted items, shown by the Recycle Bin |

**File Explorer** has a sidebar of places and favorites, an address bar
(Ctrl + L), search (optionally including subfolders), grid, list, and
details views, and sorting. Double-click a file to open it in its
application; **Open with** in the right-click menu offers the others.

**Deleting** moves items to the Trash. In the **Recycle Bin** you can
restore them to where they were (or choose a folder), delete them
permanently, or empty the Trash. Permanent deletion always asks first.

## Applications

| Application   | What it does |
| ------------- | ------------ |
| File Explorer | Browse and manage files and folders. |
| Terminal      | A command line for the file system: `ls`, `cd`, `mkdir`, `touch`, `cat`, `echo`, `cp`, `mv`, `rm`, `tree`, `restore`, `purge`, `open`, `code`, `download`, and more. Type `help` for all of them; Tab completes commands and paths. |
| Code Studio   | Edit HTML, CSS, and JavaScript projects with syntax highlighting, find and replace, project search (Ctrl + Shift + F), Go to file (Ctrl + P), diagnostics, and a live preview (Ctrl + Enter) that runs the page in an isolated frame. Its terminal panel runs BrowserOS commands. |
| Browser       | Tabs, bookmarks, history, private tabs, and downloads into `/Downloads`. Many sites don't allow being shown inside another page; BrowserOS then offers **Open in your browser**, which opens them in a new tab of the browser BrowserOS runs in. |
| Notes         | Rich-text notes with headings, lists, checklists, and links, saved automatically. Also opens `.txt` and `.md` files as plain text. |
| Calendar      | Month, week, and day views; recurring events; reminders. |
| Clock         | World clock, alarms, stopwatch, and timer. |
| Calculator    | Standard and scientific modes, keyboard input, and history. |
| Image Viewer  | View images with zoom, rotation, fullscreen, and next/previous in the folder. |
| Downloads     | Progress and history of downloads, with open and show-in-folder. |
| Task Manager  | Running applications and their windows, responsiveness, errors, and background services. |
| Recycle Bin   | Restore or permanently delete items in the Trash. |
| Settings      | Every preference, plus backup and restore. |
| About BrowserOS | Version, what this browser reports about itself, the installed applications, and credits. |
| Welcome       | The tour from the first start. |

Alarms, timers, and calendar reminders work while BrowserOS is open in
a tab, even when their applications are closed; they can't notify you
while BrowserOS isn't open.

## Settings

**Settings** (Ctrl + ,) has a search box and these pages: Appearance
(theme, accent, transparency, blur, corner radius, motion), Wallpaper,
Desktop, Start Menu, File Explorer, Notifications, Taskbar, Browser,
Code Studio, Keyboard Shortcuts, and System (the Welcome tour, sample
files, backup and restore, and resetting preferences). Changes apply
immediately and are saved automatically.

## Your data

- BrowserOS stores your files and settings in this browser, for this
  website address only. Nothing is uploaded, and other people who open
  the same address have their own, separate BrowserOS.
- Clearing the site's data in your browser erases BrowserOS's data. So
  can some browsers when the disk is almost full (About BrowserOS ›
  System shows whether the browser treats the storage as persistent).
- **Back up** from **Settings › System**: **Back up everything** saves
  one file with all files, settings, and application data; **Back up a
  folder** saves just one folder. **Restore from a backup** checks the
  file completely first; restoring everything asks before replacing
  your current data, and a folder backup is added next to your files
  without replacing anything.
- BrowserOS runs in one tab at a time. Opening it in a second tab offers
  **Use BrowserOS here**, which moves it there safely.

## Keyboard shortcuts

| Keys | Action |
| ---- | ------ |
| Windows key | Open or close the Start menu |
| Ctrl + Alt + T | New Terminal window |
| Ctrl + Alt + E | File Explorer |
| Ctrl + , | Settings |
| Ctrl + Alt + Esc | Task Manager |
| Alt + Shift + N | Notification Center |
| Alt + Shift + A | Quick Settings |
| Alt + Shift + Up / Down | Maximize or restore / minimize the active window |
| Alt + Shift + W | Close the active window |
| Alt + \` / Alt + Shift + \` | Next / previous window |
| Escape | Close the open menu, panel, or dialog |

Applications have their own shortcuts (for example, Code Studio's
Ctrl + S, Ctrl + P, and Ctrl + Enter); all of them are listed in
**Settings › Keyboard Shortcuts**.

## When something goes wrong

| What you see | What to do |
| ------------ | ---------- |
| *BrowserOS couldn't start* | The browser didn't allow BrowserOS to open its storage (private mode, blocked site data, or a full disk). Allow site data for this address and select **Try again**. |
| *BrowserOS couldn't be loaded* (on the start-up screen) | The page's files didn't arrive. Check the connection and select **Reload**. |
| *BrowserOS is open in another tab* | Close the other tab, or select **Use BrowserOS here**. |
| An application stopped responding or shows an error | Open **Task Manager** (Ctrl + Alt + Esc) and select **Restart** or **End task** for it. |
| A web page doesn't appear in the Browser | The site doesn't allow being shown inside another page. Use **Open in your browser**. |
| Something looks wrong after changing many settings | **Settings › System › Reset preferences** resets one area or everything; it never deletes files. |
