'use strict'

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')

const MarkdownIt = require('markdown-it')
const taskLists = require('markdown-it-task-lists')
const hljs = require('highlight.js')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MD_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build', '.next', '.cache'])
const FOLDER_SCAN_DEPTH = 4
const FOLDER_SCAN_LIMIT = 100
const MAX_FILE_BYTES = 8 * 1024 * 1024

const SESSION_FILE = path.join(app.getPath('userData'), 'session.json')

const isMarkdown = (p) => MD_EXTENSIONS.has(path.extname(p).toLowerCase())

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight (code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : null
    try {
      const result = language
        ? hljs.highlight(code, { language, ignoreIllegals: true })
        : hljs.highlightAuto(code)
      const label = language || result.language || ''
      return `<pre class="code-block"${label ? ` data-lang="${md.utils.escapeHtml(label)}"` : ''}><code class="hljs">${result.value}</code></pre>`
    } catch {
      return `<pre class="code-block"><code class="hljs">${md.utils.escapeHtml(code)}</code></pre>`
    }
  },
}).use(taskLists, { label: true, labelAfter: true })

function slugify (text) {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()#!]/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-') || 'section'
}

// Give every heading a stable id so in-document `#anchor` links work.
md.core.ruler.push('heading_anchors', (state) => {
  const used = new Map()
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i]
    if (token.type !== 'heading_open') continue
    const inline = state.tokens[i + 1]
    const base = slugify(inline && inline.content ? inline.content : '')
    const seen = used.get(base) || 0
    used.set(base, seen + 1)
    token.attrSet('id', seen === 0 ? base : `${base}-${seen}`)
  }
})

const isRemote = (href) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)

// Resolve relative image paths against the document's own folder, otherwise
// `![](./diagram.png)` renders as a broken image.
const defaultImage = md.renderer.rules.image ||
  ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts))

md.renderer.rules.image = (tokens, idx, opts, env, self) => {
  const token = tokens[idx]
  const src = token.attrGet('src')
  if (src && env.docDir && !isRemote(src)) {
    const [rawPath] = src.split('#')
    const absolute = path.resolve(env.docDir, decodeURIComponent(rawPath))
    if (fs.existsSync(absolute)) {
      token.attrSet('src', pathToFileUrl(absolute))
    }
  }
  return defaultImage(tokens, idx, opts, env, self)
}

// Tag links so the renderer can decide: external browser, new tab, or anchor.
const defaultLinkOpen = md.renderer.rules.link_open ||
  ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts))

md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const href = tokens[idx].attrGet('href') || ''
  if (isRemote(href)) tokens[idx].attrSet('data-external', '1')
  else if (!href.startsWith('#')) tokens[idx].attrSet('data-local', '1')
  return defaultLinkOpen(tokens, idx, opts, env, self)
}

function pathToFileUrl (absolute) {
  return 'file:///' + absolute.replace(/\\/g, '/').replace(/^\/+/, '')
    .split('/').map((segment, i) => (i === 0 ? segment : encodeURIComponent(segment))).join('/')
}

function renderMarkdown (source, filePath) {
  return md.render(source, { docDir: path.dirname(filePath) })
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

async function loadSession () {
  try {
    return JSON.parse(await fsp.readFile(SESSION_FILE, 'utf8'))
  } catch {
    return {}
  }
}

// The renderer owns tab state; the main process owns window geometry. Keep the
// last renderer snapshot around permanently so a later resize can still be
// written out on its own.
let rendererState = null
let sessionTimer = null

function queueSessionSave (state) {
  if (state) rendererState = state
  if (sessionTimer) return
  sessionTimer = setTimeout(() => {
    sessionTimer = null
    flushSession()
  }, 800)
}

function flushSession () {
  if (sessionTimer) {
    clearTimeout(sessionTimer)
    sessionTimer = null
  }
  const state = { ...(rendererState || {}), window: windowState() }
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2))
  } catch {
    /* a viewer that can't remember its tabs is still a working viewer */
  }
}

function windowState () {
  if (!mainWindow || mainWindow.isDestroyed()) return undefined
  const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds()
  return { ...bounds, maximized: mainWindow.isMaximized() }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow = null
let startupFiles = []

async function createWindow () {
  const session = await loadSession()
  const saved = session.window || {}

  mainWindow = new BrowserWindow({
    width: saved.width || 1100,
    height: saved.height || 820,
    x: saved.x,
    y: saved.y,
    minWidth: 560,
    minHeight: 400,
    show: false,
    backgroundColor: '#0f1116',
    // Hidden frame + native overlay: we draw the tab strip ourselves but keep
    // real Windows 11 minimize/maximize/close, snap layouts and resize edges.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#12151c', symbolColor: '#9aa4b8', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  mainWindow.once('ready-to-show', () => {
    if (saved.maximized) mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.webContents.once('did-finish-load', () => {
    if (startupFiles.length) {
      mainWindow.webContents.send('files:opened', startupFiles)
      startupFiles = []
    }
  })

  // Never let the viewer navigate away from itself or spawn child windows.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) {
    mainWindow.on(event, () => queueSessionSave())
  }

  mainWindow.on('close', () => flushSession())
  mainWindow.on('closed', () => { mainWindow = null })
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

async function scanFolder (dir, depth, collected) {
  if (depth > FOLDER_SCAN_DEPTH || collected.length >= FOLDER_SCAN_LIMIT) return
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (collected.length >= FOLDER_SCAN_LIMIT) return
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await scanFolder(full, depth + 1, collected)
    else if (entry.isFile() && isMarkdown(full)) collected.push(full)
  }
}

/** Turn dropped paths into a markdown-only file list. Folders are expanded. */
async function acceptPaths (paths) {
  const markdown = []
  let rejected = 0
  for (const raw of paths) {
    if (!raw) continue
    const target = path.resolve(raw)
    let stat
    try {
      stat = await fsp.stat(target)
    } catch {
      rejected++
      continue
    }
    if (stat.isDirectory()) {
      const found = []
      await scanFolder(target, 0, found)
      if (found.length) markdown.push(...found)
      else rejected++
    } else if (isMarkdown(target)) {
      markdown.push(target)
    } else {
      rejected++
    }
  }
  return { files: [...new Set(markdown)], rejected }
}

function argvFiles (argv) {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-') && isMarkdown(arg) && fs.existsSync(arg))
    .map((arg) => path.resolve(arg))
}

// ---------------------------------------------------------------------------
// File watching (stat polling survives the atomic save-and-rename that most
// editors use, which plain fs.watch does not)
// ---------------------------------------------------------------------------

const watched = new Set()

// mtime/size snapshots of files we saved ourselves, so the watcher can tell our
// own writes apart from external edits and not echo `file:changed` back at us.
const selfSaved = new Map()

function watchFile (target) {
  if (watched.has(target)) return
  watched.add(target)
  fs.watchFile(target, { interval: 500 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
    const mine = selfSaved.get(target)
    if (mine && curr.mtimeMs === mine.mtimeMs && curr.size === mine.size) {
      selfSaved.delete(target)
      return
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file:changed', target)
    }
  })
}

function unwatchFile (target) {
  if (!watched.delete(target)) return
  selfSaved.delete(target)
  fs.unwatchFile(target)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('files:open-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open markdown files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn'] },
    ],
  })
  return canceled ? [] : filePaths
})

ipcMain.handle('files:accept', (_event, paths) => acceptPaths(Array.isArray(paths) ? paths : []))

ipcMain.handle('file:read', async (_event, target) => {
  const result = { path: target, name: path.basename(target), dir: path.dirname(target) }
  try {
    if (!isMarkdown(target)) throw new Error('Not a markdown file')
    const stat = await fsp.stat(target)
    if (!stat.isFile()) throw new Error('Not a file')
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large to render (${(stat.size / 1048576).toFixed(1)} MB)`)
    }
    const source = await fsp.readFile(target, 'utf8')
    result.html = renderMarkdown(source, target)
    result.source = source // raw markdown, for the editor panel
    result.words = (source.match(/\S+/g) || []).length
    result.modified = stat.mtimeMs
  } catch (error) {
    result.error = error.code === 'ENOENT'
      ? 'File no longer exists on disk.'
      : (error.message || String(error))
  }
  return result
})

// Re-render an already-in-memory source (live preview from the editor panel).
// Sync — renderMarkdown is synchronous, and reusing it keeps the image/link
// resolution and link-tagging rules in the main process where they belong.
ipcMain.handle('file:render', (_event, source, filePath) => {
  if (typeof source !== 'string') throw new Error('Invalid source')
  return { html: renderMarkdown(source, filePath), words: (source.match(/\S+/g) || []).length }
})

ipcMain.handle('file:save', async (_event, target, source, eol, bom) => {
  try {
    if (typeof target !== 'string' || !isMarkdown(target)) throw new Error('Not a markdown file')
    if (typeof source !== 'string') throw new Error('Invalid content')

    // Round-trip the file's original line endings and byte-order mark so a save
    // doesn't rewrite the whole file's diff for the sake of one edit.
    let text = source.replace(/\r\n/g, '\n').replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n')
    if (bom && !text.startsWith('\uFEFF')) text = '\uFEFF' + text

    // Atomic write: temp file in the same dir, then rename over the target.
    const dir = path.dirname(target)
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`)
    try {
      await fsp.writeFile(tmp, text, 'utf8')
      await fsp.rename(tmp, target)
    } catch (writeError) {
      // The target may be open by another editor (EPERM/EACCES on Windows).
      // Fall back to a plain write so the save still succeeds.
      try { await fsp.unlink(tmp) } catch { /* already gone */ }
      if (writeError.code !== 'EPERM' && writeError.code !== 'EACCES') throw writeError
      await fsp.writeFile(target, text, 'utf8')
    }

    // Record the stat synchronously, in the SAME tick as the write, so a
    // 500 ms poll tick can't fire `file:changed` for our own save.
    const stat = fs.statSync(target)
    selfSaved.set(target, { mtimeMs: stat.mtimeMs, size: stat.size })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message || String(error) }
  }
})

ipcMain.handle('link:resolve', async (_event, fromPath, href) => {
  try {
    const [rawPath, hash] = decodeURIComponent(href).split('#')
    const target = path.resolve(path.dirname(fromPath), rawPath)
    const stat = await fsp.stat(target)
    if (stat.isFile() && isMarkdown(target)) return { path: target, hash: hash || null }
  } catch { /* fall through */ }
  return null
})

ipcMain.on('link:external', (_event, url) => {
  if (/^(?:https?|mailto):/i.test(url)) shell.openExternal(url)
})

ipcMain.on('file:watch', (_event, target) => watchFile(target))
ipcMain.on('file:unwatch', (_event, target) => unwatchFile(target))

ipcMain.handle('session:load', () => loadSession())
ipcMain.on('session:save', (_event, state) => queueSessionSave(state))

ipcMain.on('window:title', (_event, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(title || 'Markdown Viewer')
})

ipcMain.on('shell:reveal', (_event, target) => {
  if (typeof target === 'string' && fs.existsSync(target)) shell.showItemInFolder(target)
})

// The renderer cancels close in `beforeunload` when a tab has unsaved edits,
// then asks here for a decision. destroy() skips beforeunload, so no loop.
// confirmingClose guards against a second dialog stacking if X is hit twice.
let confirmingClose = false
ipcMain.on('app:confirm-close', async () => {
  if (!mainWindow || mainWindow.isDestroyed() || confirmingClose) return
  confirmingClose = true
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Unsaved changes',
    message: 'You have unsaved edits in the editor.',
    detail: 'Your changes will be lost if you close the window.',
    buttons: ['Discard & Close', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  })
  confirmingClose = false
  if (response === 0) {
    flushSession()
    mainWindow.destroy()
  }
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const files = argvFiles(argv)
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (files.length) mainWindow.webContents.send('files:opened', files)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark'
    Menu.setApplicationMenu(null) // no menu bar; shortcuts live in the renderer
    startupFiles = argvFiles(process.argv)
    createWindow()
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => flushSession())
}
