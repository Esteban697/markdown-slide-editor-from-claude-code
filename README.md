# Markdown Viewer

A small dark-mode markdown **viewer** and **editor** for Windows 11. It opens
markdown files, renders them enriched (headings, tables, code highlighting,
task lists, images), and behaves like any other Windows window — snap it,
maximise it, resize it, drag it between monitors.

Editing is optional. Slide the editor in beside the viewer with `Ctrl+E` (or
the arrow at the right edge), watch your changes render live, and save them
back to the same file with `Ctrl+S`.

## Running it

```powershell
npm install     # first time only
npm start
```

You can also pass files on the command line:

```powershell
npm start -- sample.md
npm start -- "C:\notes\design.md" "C:\notes\todo.md"
```

## Running it from the Desktop

```powershell
npm run shortcut
```

That creates **Markdown Viewer.lnk** on your Desktop. It launches the app with
no console window. Two extras come for free:

- **Drop a `.md` file onto the shortcut** and it opens in the app.
- If the app is already running, dropping a file adds it as a tab in the
  existing window instead of starting a second copy.

Re-run `npm run shortcut` if you ever move the project folder — the shortcut
stores absolute paths. You can drag the `.lnk` to your taskbar or Start menu,
or drop a copy in `shell:startup` to launch it at login.

## Opening files

| How | What happens |
| --- | --- |
| **Drag a `.md` file from File Explorer onto the window** | Opens as a new tab |
| Drag several files at once | Each becomes its own tab |
| Drag a **folder** | Every markdown file inside is opened (recursive, max 100) |
| `Ctrl`+`O` or the `+` button | File picker, filtered to markdown |
| Command line / "Open with" | Opens on launch |
| Click a relative link like `[spec](./spec.md)` | Opens that file as a new tab |

Non-markdown files are refused with a toast rather than opened. Recognised
extensions: `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl`+`O` | Open files |
| `Ctrl`+`W` | Close current tab (middle-click a tab also closes it) |
| `Ctrl`+`Tab` / `Ctrl`+`Shift`+`Tab` | Next / previous tab |
| `Ctrl`+`1` … `Ctrl`+`8` | Jump to tab by position |
| `Ctrl`+`9` | Jump to last tab |
| `Ctrl`+`R` or `F5` | Reload current file |
| `Ctrl`+`E` | Toggle the editor panel |
| `Ctrl`+`S` | Save the edited file |
| `Ctrl`+`+` / `Ctrl`+`-` / `Ctrl`+`0` | Zoom text in / out / reset |
| `Ctrl`+mouse wheel | Zoom text |
| `Ctrl`+`C` | Copy selected text |

## Behaviour worth knowing

- **Auto-reload.** Open files are polled every 500 ms. Save the file in your
  editor and the view updates, keeping your scroll position. Tabs that changed
  while you were looking at a different one get a blue dot.
- **Split editor.** `Ctrl+E` slides a markdown source editor in beside the
  viewer (arrow flips to close it again). Changes render in the viewer as you
  type, and the viewer's scrollbar tracks the editor's — scroll the editor to
  70% and the viewer follows to roughly the same level. `Ctrl+S` or the
  **Save** button writes back to the same file, preserving its line endings
  and byte-order mark. Auto-reload and `Ctrl+R` are paused while a tab has
  unsaved edits, so the watcher can't clobber them; closing such a tab — or
  the window — asks first. A red dot marks a tab with unsaved changes.
- **Session memory.** Open tabs, the active tab, each tab's scroll position,
  your zoom level and the window geometry are restored on next launch. Files
  that were moved or deleted are dropped silently.
- **Relative images** (`![](./diagram.png)`) resolve against the markdown file's
  own folder.
- **External links** open in your default browser, not in the app window.
- The status bar shows the file path — click it to reveal the file in Explorer.

## Files

| File | Role |
| --- | --- |
| `main.js` | Electron main process: window, markdown → HTML rendering, file watching, atomic saving (EOL/BOM preserving), session file, IPC |
| `preload.js` | The only bridge between the renderer and Node, via `contextBridge` |
| `renderer/index.html` | Window markup and the content security policy |
| `renderer/renderer.js` | Tabs, drag-and-drop, links, keyboard, scroll/zoom state, the split editor and live preview |
| `renderer/styles.css` | Dark theme, markdown typography, syntax highlighting colours |
| `sample.md` | Test document covering most markdown features |
| `make-shortcut.ps1` | Creates the Desktop shortcut (`npm run shortcut`) |

Session state lives in
`%APPDATA%\mdview\session.json`.

## Security notes

Markdown files can contain raw HTML, so the renderer is locked down:

- `nodeIntegration: false`, `contextIsolation: true` — documents have no access
  to Node.
- A content security policy with no `unsafe-inline`, which means `<script>`
  tags and `onclick=` attributes inside a `.md` file will not execute.
- `default-src 'none'` and `connect-src 'none'` — a document cannot phone home
  or pull remote resources.
- Navigation away from the app and popup windows are both blocked.

## Packaging to a standalone `.exe`

Not set up yet. When you want it:

```powershell
npm install --save-dev @electron/packager
npx electron-packager . MarkdownViewer --platform=win32 --arch=x64 --overwrite
```

For an installer plus file-association so `.md` files open in this app by
default, `electron-builder` with an `nsis` target and a `fileAssociations`
entry is the usual route.
