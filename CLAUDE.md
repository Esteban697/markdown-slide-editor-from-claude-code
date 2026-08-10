# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm install                      # first time only
npm start                        # launch the app
npm start -- sample.md           # launch with files preloaded (repeatable, quote absolute paths)
npm run shortcut                 # write "Markdown Viewer.lnk" to the Desktop
```

There is no test suite, no linter, and no build step — the renderer is plain
`<script>`-tag JavaScript with no bundler. Verification is manual: `npm start -- sample.md`,
which exercises headings, tables, code highlighting, task lists and images in one document.

For quick checks of the markdown pipeline without launching Electron, `node -e` against
`markdown-it` / `highlight.js` in the project root works, since both are runtime `dependencies`.

Packaging is not set up. The intended route is `@electron/packager` for a bare `.exe`, or
`electron-builder` with an `nsis` target plus a `fileAssociations` entry for an installer that
registers `.md`.

## Architecture

Three files carry the design; the rest is styling and a sample document.

**`main.js` (main process)** owns markdown → HTML rendering, the filesystem, file watching,
window geometry and the session file. **`renderer/renderer.js`** owns tab state, input and
scroll/zoom. **`preload.js`** is the only channel between them.

### The trust boundary is the whole design

Markdown is treated as untrusted input, and `markdown-it` runs with `html: true` — raw HTML in a
`.md` file reaches the DOM verbatim via `doc.innerHTML = tab.html`. **Nothing sanitizes it.**
Safety comes entirely from two layers that must not be weakened:

- `webPreferences` in `main.js`: `contextIsolation: true`, `nodeIntegration: false`.
- The CSP in `renderer/index.html`: `default-src 'none'`, no `unsafe-inline` anywhere, and
  `connect-src 'none'`. This is what makes `<script>` tags and `onclick=` attributes inside a
  document inert.

Consequences for any change here: adding an inline `<script>`, an inline style attribute, a CDN
font, or a `fetch()` in the renderer will be blocked by the CSP, not silently allowed. `'self'`
is unreliable for `file://` origins, so each directive lists `file:` explicitly. Navigation and
popups are also hard-blocked (`will-navigate` → `preventDefault`, `setWindowOpenHandler` → `deny`
with an `openExternal` side effect for http(s)).

### Adding a capability takes three coordinated edits

The `mdv` object exposed by `contextBridge` in `preload.js` is the renderer's entire API surface.
A new capability needs: an `ipcMain.handle`/`ipcMain.on` in `main.js`, a method in `preload.js`,
and a call site in `renderer.js`. There is no other path — the renderer cannot `require` anything,
including the project's own `node_modules`.

Note `pathForFile`, which wraps `webUtils.getPathForFile`. On Electron 43 the old `File.path`
property no longer exists; this is how a dropped `File` becomes a real filesystem path.

The split editor is the largest such capability. It rides on four changes:
`file:read` returns the raw `source` alongside the rendered `html`; `file:render` re-renders an
in-memory source (live preview stays in the main process, never bundling markdown-it into the
renderer); `file:save` writes atomically and round-trips the file's original EOL/BOM; and
`app:confirm-close` lets the main process ask about unsaved edits when the renderer cancels a
window close in `beforeunload`.

### Link and image behaviour is split across the boundary

`main.js` tags links at render time (`data-external` for absolute/protocol URLs, `data-local` for
relative ones) and rewrites relative image `src` values to `file:` URLs resolved against
`env.docDir` — the document's own folder, passed per-render through `renderMarkdown`. A custom
`heading_anchors` core rule assigns deduplicated slug ids so `#anchor` links resolve.

`renderer.js` then dispatches on those tags at click time: `#` → in-page scroll, `data-external`
→ `openExternal`, otherwise ask main to `resolveLink` and open the result as a tab. Changing link
behaviour usually means touching both halves.

### Session state has two owners

The renderer sends its snapshot (`tabs`, `active`, `fontSize`, `editorOpen`) over
`session:save`; the main process merges it with `windowState()` and debounces the write by
800 ms. `rendererState` is kept
permanently after the first snapshot so a later resize can flush geometry on its own without
losing tab state. Writes land in `%APPDATA%\mdview\session.json`; failures are swallowed on
purpose. `flushSession()` runs on window `close` and `before-quit`.

On the renderer side, a `restoring` flag suppresses `saveSession()` during startup so a partial
tab list is never persisted over a good one.

### Async tab mutations must be serialized

Every operation that mutates `tabs` across an `await` — drops, dialog opens, link navigation,
reloads, session restore — goes through `serial()`, a single promise chain. Bypassing it lets a
file drop landing mid-restore clobber the tab list. Add new async tab operations to that chain.

### Other deliberate choices

- **Polling, not `fs.watch`.** `fs.watchFile` with a 500 ms interval survives the
  atomic save-and-rename that most editors use; `fs.watch` loses the handle.
- **Self-saves don't echo.** `file:save` records the written file's mtime/size in a `selfSaved`
  map in the same tick as the write; the watcher skips a stat that matches it, so saving never
  triggers the tab's own reload. Reload — from the watcher or `Ctrl+R` — is also skipped while a
  tab is dirty (unsaved edits), so the editor can't be clobbered. Dirty tabs get a red dot;
  closing one (or the window) confirms first.
- **No application menu.** `Menu.setApplicationMenu(null)`, so every shortcut lives in the
  renderer's `keydown` listener. New shortcuts go there, not in a menu accelerator.
- **Custom tab strip, native window controls.** `titleBarStyle: 'hidden'` plus `titleBarOverlay`
  keeps real Windows 11 snap layouts and caption buttons; `#controls-spacer` reserves their room.
- **Single instance.** `requestSingleInstanceLock()` plus a `second-instance` handler forwards a
  second launch's argv into the running window as new tabs — this is what makes dropping a file
  on the Desktop shortcut add a tab instead of opening a second app.
- **Zoom is a CSS variable** (`--content-fs`), clamped 11–28px, not Electron's zoom factor.
- Tunable limits sit together at the top of `main.js`: recognised extensions, skipped directory
  names, folder scan depth (4) and file cap (100), and an 8 MB per-file ceiling.
