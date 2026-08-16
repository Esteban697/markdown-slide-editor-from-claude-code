'use strict'

const api = window.mdv

const tabstrip = document.getElementById('tabstrip')
const content = document.getElementById('content')
const emptyState = document.getElementById('empty-state')
const dropzone = document.getElementById('dropzone')
const toast = document.getElementById('toast')
const statusPath = document.getElementById('status-path')
const statusMeta = document.getElementById('status-meta')
const openBtn = document.getElementById('open-btn')
const editorToggle = document.getElementById('editor-toggle')
const editorSource = document.getElementById('editor-source')
const saveBtn = document.getElementById('save-btn')
const highlightBtn = document.getElementById('highlight-btn')
const outlineToggle = document.getElementById('outline-toggle')
const outlinePanel = document.getElementById('outline')
const editorMeasure = document.getElementById('editor-measure')

const MIN_FS = 11
const MAX_FS = 28

/** @type {Array<{path,name,dir,html,error,words,scroll,stale,source,lastSaved,dirty,eol,bom,editorScroll,outline}>} */
let tabs = []
let activeIndex = -1
let fontSize = 16
let restoring = true
let editorOpen = false
let outlineOpen = false
let outlineJump = false // suppress editor→viewer sync right after an outline jump
let outlineButtons = new Map() // heading id -> <button>
let outlineHeadingEls = [] // cached headings whose id is in the outline
let previewSeq = 0
let previewTimer = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const activeTab = () => (activeIndex >= 0 ? tabs[activeIndex] : null)
const indexOfPath = (target) => tabs.findIndex((tab) => tab.path === target)

let toastTimer = null
function showToast (message) {
  toast.textContent = message
  toast.classList.add('visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600)
}

function readingTime (words) {
  const minutes = Math.max(1, Math.round(words / 220))
  return `${minutes} min read`
}

/** Trim a long path down to its last few segments for the status bar. */
function shortenPath (full, keep = 3) {
  const parts = full.split(/[\\/]/)
  if (parts.length <= keep + 1) return full
  return '…\\' + parts.slice(-keep).join('\\')
}

// File operations mutate `tabs` across awaits, so run them one at a time —
// otherwise a drop landing mid-session-restore can clobber the tab list.
let chain = Promise.resolve()
function serial (task) {
  chain = chain.then(task).catch((error) => console.error(error))
  return chain
}

/** Build a tab from a `file:read` result, seeding the editor fields. */
function tabFromDoc (doc, extra = {}) {
  const source = doc.source || ''
  return {
    ...doc,
    scroll: 0,
    stale: false,
    lastSaved: doc.source,
    dirty: false,
    eol: /\r\n/.test(source) ? '\r\n' : '\n',
    bom: source.startsWith('\uFEFF'),
    editorScroll: 0,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTabs () {
  tabstrip.textContent = ''

  tabs.forEach((tab, index) => {
    const el = document.createElement('div')
    el.className = 'tab'
    el.setAttribute('role', 'tab')
    el.title = tab.path
    if (index === activeIndex) {
      el.classList.add('active')
      el.setAttribute('aria-selected', 'true')
    }
    if (tab.stale) el.classList.add('stale')
    if (tab.dirty) el.classList.add('dirty')
    if (tab.error) el.classList.add('error')

    const name = document.createElement('span')
    name.className = 'tab-name'
    name.textContent = tab.name
    el.appendChild(name)

    const close = document.createElement('button')
    close.className = 'tab-close'
    close.textContent = '×'
    close.title = 'Close (Ctrl+W)'
    close.setAttribute('aria-label', `Close ${tab.name}`)
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      closeTab(index)
    })
    el.appendChild(close)

    el.addEventListener('mousedown', (event) => {
      if (event.button === 0) activateTab(index)
      else if (event.button === 1) { event.preventDefault(); closeTab(index) }
    })

    tabstrip.appendChild(el)
  })
}

function renderContent () {
  const tab = activeTab()

  if (!tab) {
    content.textContent = ''
    content.appendChild(emptyState)
    statusPath.textContent = ''
    statusMeta.textContent = ''
    api.setTitle('Markdown Viewer')
    return
  }

  content.textContent = ''

  if (tab.error) {
    const box = document.createElement('div')
    box.className = 'doc-error'
    const heading = document.createElement('strong')
    heading.textContent = 'Could not open this file'
    const detail = document.createElement('span')
    detail.textContent = tab.error
    box.append(heading, detail)
    content.appendChild(box)
  } else {
    const doc = document.createElement('article')
    doc.className = 'doc'
    doc.innerHTML = tab.html
    content.appendChild(doc)
  }

  // Jump without animating, so a restored position doesn't visibly scroll.
  // Repeat after layout: fresh innerHTML can still be measuring on the first set.
  const target = tab.scroll || 0
  content.style.scrollBehavior = 'auto'
  content.scrollTop = target
  requestAnimationFrame(() => {
    if (activeTab() === tab && Math.abs(content.scrollTop - target) > 1) {
      content.scrollTop = target
    }
    content.style.scrollBehavior = ''
  })

  statusPath.textContent = shortenPath(tab.path)
  statusPath.title = `${tab.path}\n(click to show in File Explorer)`
  statusMeta.textContent = tab.error
    ? ''
    : `${tab.words.toLocaleString()} words · ${readingTime(tab.words)}`
  api.setTitle(`${tab.name} — Markdown Viewer`)
}

function render () {
  renderTabs()
  renderContent()
  renderOutline()
  renderEditor()
  saveSession()
}

// ---------------------------------------------------------------------------
// Hover spotlight: dim the viewer's other blocks, keep the hovered one bright.
// On by default; the Highlight button below the viewer toggles it.
// ---------------------------------------------------------------------------

/** Block-level elements a hover can highlight (paragraphs, headings, …). */
const SPOTLIGHT_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, hr'

let spotlightEnabled = true

function renderHighlightButton () {
  highlightBtn.classList.toggle('active', spotlightEnabled)
  highlightBtn.setAttribute('aria-pressed', String(spotlightEnabled))
}

function toggleHighlight () {
  spotlightEnabled = !spotlightEnabled
  renderHighlightButton()
  if (!spotlightEnabled) clearSpotlight()
  saveSession()
}

highlightBtn.addEventListener('click', toggleHighlight)
renderHighlightButton()

function setSpotlight (doc, block) {
  // Dimming is per top-level block, so promote the hovered element to the
  // direct child of the article that contains it — content nested in lists,
  // blockquotes or tables highlights as part of its containing block.
  let node = block
  while (node.parentElement && node.parentElement !== doc) node = node.parentElement
  if (doc.classList.contains('dimmed') && node.classList.contains('spotlight')) return
  doc.querySelectorAll('.spotlight').forEach((el) => el.classList.remove('spotlight'))
  node.classList.add('spotlight')
  doc.classList.add('dimmed')
}

function clearSpotlight () {
  const doc = content.querySelector('.doc')
  if (!doc) return
  doc.classList.remove('dimmed')
  doc.querySelectorAll('.spotlight').forEach((el) => el.classList.remove('spotlight'))
}

content.addEventListener('mouseover', (event) => {
  if (!spotlightEnabled) return
  const doc = content.querySelector('.doc')
  if (!doc) return
  const block = event.target.closest && event.target.closest(SPOTLIGHT_SELECTOR)
  if (block) setSpotlight(doc, block)
  else clearSpotlight()
})

content.addEventListener('mouseleave', clearSpotlight)

// ---------------------------------------------------------------------------
// Editor panel
// ---------------------------------------------------------------------------

/** The active tab is editable when it loaded without error and has raw source. */
const editableTab = () => {
  const tab = activeTab()
  return tab && !tab.error && typeof tab.source === 'string' ? tab : null
}

function renderEditor () {
  const tab = editableTab()

  if (!tab) {
    editorSource.value = ''
    saveBtn.disabled = true
    editorToggle.disabled = true
    if (editorOpen) setEditorOpen(false)
    return
  }

  editorToggle.disabled = false

  // Sync the textarea only when it's stale — a focused, mid-typing textarea
  // always has value === tab.source (the input handler keeps them in lockstep).
  if (editorSource.value !== tab.source) {
    editorSource.value = tab.source
    editorSource.scrollTop = tab.editorScroll || 0
    syncViewerToEditor()
  }
  saveBtn.disabled = !tab.dirty
}

function setEditorOpen (open) {
  editorOpen = open
  document.body.classList.toggle('editor-open', open)
  editorToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
}

function toggleEditor () {
  const tab = editableTab()
  if (!tab) return
  if (editorOpen) tab.editorScroll = editorSource.scrollTop
  setEditorOpen(!editorOpen)
  if (editorOpen) {
    editorSource.value = tab.source
    editorSource.scrollTop = tab.editorScroll || 0
    syncViewerToEditor()
    editorSource.focus()
  }
  saveSession()
}

/** Fraction [0,1] of the editor's scrollable range. */
function editorFraction () {
  const max = editorSource.scrollHeight - editorSource.clientHeight
  return max > 0 ? editorSource.scrollTop / max : 0
}

// The editor's scrollbar drives the viewer: keep the rendered pane at roughly
// the same level of the document so you can see what you're editing. Re-applies
// once layout settles (fresh innerHTML / the panel's width transition can still
// be measuring on the first pass).
function syncViewerToEditor () {
  const tab = editableTab()
  if (!tab || !editorOpen) return
  const apply = () => {
    if (activeTab() !== tab || !editorOpen) return
    // Jump without animating — scroll-behavior: smooth would make dragging lag.
    content.style.scrollBehavior = 'auto'
    content.scrollTop = editorFraction() * (content.scrollHeight - content.clientHeight)
    content.style.scrollBehavior = ''
    tab.scroll = content.scrollTop
  }
  apply()
  requestAnimationFrame(apply)
}

// Live preview: debounce re-renders of the edited source through main, swapping
// the result into the viewer while keeping its scroll ratio so typing doesn't
// make the page jump.
function schedulePreview () {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(runPreview, 180)
}

async function runPreview () {
  const tab = editableTab()
  const doc = content.querySelector('.doc')
  if (!tab || !doc || !editorOpen) return
  const seq = ++previewSeq
  const ratio = content.scrollHeight ? content.scrollTop / content.scrollHeight : 0
  try {
    const result = await api.render(tab.source, tab.path)
    if (seq !== previewSeq || activeTab() !== tab) return // superseded
    tab.html = result.html
    tab.words = result.words
    tab.outline = result.outline
    doc.innerHTML = result.html
    // The re-render replaced the spotlighted block; drop the stale dim state.
    clearSpotlight()
    renderOutline()
    // Jump without animating — scroll-behavior: smooth would make typing drag.
    content.style.scrollBehavior = 'auto'
    content.scrollTop = ratio * content.scrollHeight
    content.style.scrollBehavior = ''
    statusMeta.textContent = `${tab.words.toLocaleString()} words · ${readingTime(tab.words)}`
  } catch {
    /* transient render error — leave the last good view up */
  }
}

async function saveActiveTab () {
  const tab = editableTab()
  if (!tab || !tab.dirty || tab.saving) return
  const sourceToSave = tab.source
  tab.saving = true
  saveBtn.disabled = true
  try {
    const result = await api.saveFile(tab.path, sourceToSave, tab.eol, tab.bom)
    if (!result.ok) {
      tab.saving = false
      saveBtn.disabled = false
      showToast(`Save failed: ${result.error || 'unknown error'}`)
      return
    }
    tab.lastSaved = sourceToSave
    tab.dirty = tab.source !== sourceToSave // keystrokes that landed mid-save re-dirty
    tab.stale = false
    tab.saving = false
    saveBtn.classList.add('saved')
    saveBtn.textContent = 'Saved ✓'
    setTimeout(() => {
      saveBtn.classList.remove('saved')
      saveBtn.textContent = 'Save'
      saveBtn.disabled = !editableTab()?.dirty
    }, 1400)
    renderTabs()
    showToast(`Saved ${shortenPath(tab.path)}`)
    saveSession()
  } catch (error) {
    tab.saving = false
    saveBtn.disabled = false
    showToast(`Save failed: ${error.message || String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Outline panel (left side)
// ---------------------------------------------------------------------------

function renderOutline () {
  outlinePanel.textContent = ''
  outlineButtons = new Map()
  outlineHeadingEls = []
  const tab = activeTab()

  if (!tab || tab.error) {
    outlineToggle.disabled = true
    if (outlineOpen) setOutlineOpen(false) // mirror renderEditor's auto-close
    return
  }
  outlineToggle.disabled = false

  const items = tab.outline || []
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = 'No headings'
    outlinePanel.appendChild(empty)
    return
  }

  for (const entry of items) {
    const btn = document.createElement('button')
    btn.className = 'outline-item'
    btn.dataset.level = entry.level // drives CSS indentation
    btn.textContent = entry.text
    btn.title = entry.text
    btn.addEventListener('click', () => outlineClick(entry))
    outlinePanel.appendChild(btn)
    outlineButtons.set(entry.id, btn)
  }

  // Cache the rendered headings that correspond to outline entries (excludes
  // id-less HTML headings) so active tracking stays cheap.
  outlineHeadingEls = Array.from(
    content.querySelectorAll('.doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6')
  ).filter((el) => outlineButtons.has(el.id))
  requestAnimationFrame(updateActiveOutline)
}

function setOutlineOpen (open) {
  outlineOpen = open
  document.body.classList.toggle('outline-open', open)
  outlineToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
}

function toggleOutline () {
  if (!activeTab()) return
  setOutlineOpen(!outlineOpen)
  saveSession()
}

outlineToggle.addEventListener('click', toggleOutline)

/** Character offset of the start of `lineIndex` (0-based) in `source`. */
function lineStartChar (source, lineIndex) {
  if (lineIndex <= 0) return 0
  let pos = 0
  for (let l = 0; l < lineIndex; l++) {
    const nl = source.indexOf('\n', pos)
    if (nl === -1) return source.length
    pos = nl + 1
  }
  return pos
}

/**
 * Scroll the editor textarea so the heading's source line is visible. A
 * `line × lineHeight` estimate breaks on wrapped lines; a fraction estimate
 * breaks near the doc's end. Instead, a hidden mirror div replicates the
 * textarea's metrics and is filled with the source prefix up to the target
 * line, so scrollHeight gives the exact scroll offset.
 */
function scrollEditorToLine (tab, lineIndex) {
  const char = lineStartChar(tab.source, lineIndex)
  const measure = () => {
    editorMeasure.textContent = tab.source.slice(0, char)
    editorMeasure.style.width = editorSource.clientWidth + 'px'
    const padBottom = parseFloat(getComputedStyle(editorSource).paddingBottom)
    editorSource.scrollTop = Math.max(0, editorMeasure.scrollHeight - padBottom)
    tab.editorScroll = editorSource.scrollTop
  }
  measure()
  requestAnimationFrame(measure) // re-measure once layout settles
  // If the jump didn't change the scroll position, no scroll event fires to
  // clear the guard — clear it a frame later, well after any event would have.
  requestAnimationFrame(() => requestAnimationFrame(() => { outlineJump = false }))
}

function outlineClick (entry) {
  // Position the viewer synchronously and exactly (auto = no smooth animation,
  // so the editor sync below can't fight it mid-scroll).
  content.style.scrollBehavior = 'auto'
  scrollToAnchor(entry.id)
  content.style.scrollBehavior = ''
  const tab = editableTab()
  if (editorOpen && tab) {
    outlineJump = true
    scrollEditorToLine(tab, entry.line)
  }
}

/** A heading counts as active while it's within this many px of the viewport top. */
const OUTLINE_OFFSET = 32 // > the .doc heading scroll-margin-top of 24px

function updateActiveOutline () {
  if (!outlineOpen || !outlineHeadingEls.length) return
  const tab = activeTab()
  if (!tab || tab.error) return
  const threshold = content.scrollTop + OUTLINE_OFFSET
  let activeId = ''
  for (const el of outlineHeadingEls) {
    if (el.offsetTop <= threshold) activeId = el.id
    else break
  }
  let changed = false
  for (const [id, btn] of outlineButtons) {
    const isActive = id === activeId
    if (btn.classList.contains('active') !== isActive) {
      btn.classList.toggle('active', isActive)
      changed = true
    }
  }
  if (changed && activeId) outlineButtons.get(activeId).scrollIntoView({ block: 'nearest' })
}

// ---------------------------------------------------------------------------
// Tab operations
// ---------------------------------------------------------------------------

async function openPaths (paths, { activate = true } = {}) {
  if (!paths || !paths.length) return

  const { files, rejected } = await api.acceptPaths(paths)

  if (rejected && !files.length) {
    showToast(rejected === 1
      ? 'Only markdown files can be opened.'
      : `Skipped ${rejected} items — only markdown files can be opened.`)
    return
  }
  if (rejected) showToast(`Skipped ${rejected} non-markdown item${rejected === 1 ? '' : 's'}.`)

  let target = -1
  for (const file of files) {
    const existing = indexOfPath(file)
    if (existing !== -1) {
      target = existing
      continue
    }
    const doc = await api.readFile(file)
    tabs.push(tabFromDoc(doc))
    api.watch(file)
    target = tabs.length - 1
  }

  if (activate && target !== -1) activeIndex = target
  render()
}

function activateTab (index) {
  if (index < 0 || index >= tabs.length) return
  if (index === activeIndex) return
  const current = activeTab()
  if (current) {
    current.scroll = content.scrollTop
    if (editorOpen) current.editorScroll = editorSource.scrollTop
  }
  activeIndex = index
  tabs[index].stale = false
  render()
}

function closeTab (index) {
  const tab = tabs[index]
  if (!tab) return
  if (tab.dirty && !window.confirm(`Discard unsaved changes to ${tab.name}?`)) return
  api.unwatch(tab.path)
  tabs.splice(index, 1)

  if (tabs.length === 0) activeIndex = -1
  else if (index < activeIndex) activeIndex--
  else if (index === activeIndex) activeIndex = Math.min(index, tabs.length - 1)

  render()
}

function cycleTab (delta) {
  if (tabs.length < 2) return
  activateTab((activeIndex + delta + tabs.length) % tabs.length)
}

async function reloadTab (index, { keepScroll = true } = {}) {
  const tab = tabs[index]
  if (!tab) return

  // Never clobber unsaved edits: skip the reload and surface the change.
  if (tab.dirty) {
    tab.stale = true
    renderTabs()
    if (index === activeIndex) {
      showToast('File changed on disk but you have unsaved edits — save first.')
    }
    return
  }

  const scroll = index === activeIndex ? content.scrollTop : tab.scroll
  const doc = await api.readFile(tab.path)
  // The tab may have been closed or a keystroke may have landed mid-reload;
  // either way the read result must not overwrite live edits.
  if (!tabs[index] || tabs[index].dirty) return
  const old = tabs[index]
  tabs[index] = {
    ...doc,
    scroll: keepScroll ? scroll : 0,
    stale: index !== activeIndex,
    lastSaved: doc.source,
    dirty: false,
    eol: old.eol,
    bom: old.bom,
    editorScroll: old.editorScroll,
  }
  render()
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

function setFontSize (px) {
  fontSize = Math.min(MAX_FS, Math.max(MIN_FS, px))
  document.documentElement.style.setProperty('--content-fs', `${fontSize}px`)
  requestAnimationFrame(updateActiveOutline)
  saveSession()
}

// Reflow (window resize) changes heading offsetTop; re-run active tracking.
window.addEventListener('resize', () => requestAnimationFrame(updateActiveOutline))

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function saveSession () {
  if (restoring) return
  const current = activeTab()
  if (current) current.scroll = content.scrollTop
  api.saveSession({
    tabs: tabs.map((tab) => ({ path: tab.path, scroll: Math.round(tab.scroll || 0) })),
    active: activeIndex,
    fontSize,
    editorOpen,
    outlineOpen,
    spotlightEnabled,
  })
}

async function restoreSession () {
  let session = {}
  try {
    session = (await api.loadSession()) || {}
  } catch { /* first run */ }

  setFontSize(session.fontSize || 16)

  for (const saved of session.tabs || []) {
    const doc = await api.readFile(saved.path)
    if (doc.error) continue // silently drop files that moved or were deleted
    tabs.push(tabFromDoc(doc, { scroll: saved.scroll || 0 }))
    api.watch(doc.path)
  }

  if (tabs.length) {
    activeIndex = Math.min(Math.max(session.active ?? 0, 0), tabs.length - 1)
  }

  restoring = false
  if (typeof session.spotlightEnabled === 'boolean') spotlightEnabled = session.spotlightEnabled
  if (session.editorOpen) setEditorOpen(true)
  if (session.outlineOpen) setOutlineOpen(true)
  renderHighlightButton()
  render()
}

// ---------------------------------------------------------------------------
// Drag and drop from File Explorer
// ---------------------------------------------------------------------------

let dragDepth = 0

function dragHasFiles (event) {
  const types = event.dataTransfer && event.dataTransfer.types
  return !!types && Array.from(types).includes('Files')
}

window.addEventListener('dragenter', (event) => {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  dragDepth++
  dropzone.classList.add('visible')
})

window.addEventListener('dragover', (event) => {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
})

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dropzone.classList.remove('visible')
})

window.addEventListener('drop', (event) => {
  event.preventDefault()
  dragDepth = 0
  dropzone.classList.remove('visible')

  const paths = Array.from(event.dataTransfer.files)
    .map((file) => api.pathForFile(file))
    .filter(Boolean)

  if (paths.length) serial(() => openPaths(paths))
  else showToast('Could not read the dropped item.')
})

// ---------------------------------------------------------------------------
// Link handling inside rendered documents
// ---------------------------------------------------------------------------

content.addEventListener('click', async (event) => {
  const anchor = event.target.closest && event.target.closest('a[href]')
  if (!anchor) return
  event.preventDefault()

  const href = anchor.getAttribute('href')
  const tab = activeTab()

  if (href.startsWith('#')) {
    scrollToAnchor(href.slice(1))
    return
  }

  if (anchor.hasAttribute('data-external')) {
    api.openExternal(anchor.href)
    return
  }

  if (!tab) return

  // Relative link: open it as a tab if it's markdown, otherwise hand it off.
  const resolved = await api.resolveLink(tab.path, href)
  if (resolved) {
    await serial(() => openPaths([resolved.path]))
    if (resolved.hash) requestAnimationFrame(() => scrollToAnchor(resolved.hash))
  } else {
    showToast('That link does not point to a markdown file.')
  }
})

function scrollToAnchor (id) {
  const decoded = decodeURIComponent(id)
  const target = document.getElementById(decoded) ||
    document.getElementById(decoded.toLowerCase())
  if (target) target.scrollIntoView({ block: 'start' })
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

openBtn.addEventListener('click', async () => {
  const paths = await api.openDialog()
  if (paths.length) serial(() => openPaths(paths))
})

statusPath.addEventListener('click', () => {
  const tab = activeTab()
  if (tab) api.revealInExplorer(tab.path)
})

editorToggle.addEventListener('click', toggleEditor)
saveBtn.addEventListener('click', saveActiveTab)

// Live edit path: keep tab.source in lockstep with the textarea, flag dirty,
// and debounce a re-render into the viewer.
editorSource.addEventListener('input', () => {
  const tab = editableTab()
  if (!tab) return
  tab.source = editorSource.value
  tab.dirty = tab.source !== tab.lastSaved
  saveBtn.disabled = !tab.dirty
  const active = tabstrip.children[activeIndex]
  if (active) active.classList.toggle('dirty', tab.dirty)
  schedulePreview()
})

editorSource.addEventListener('scroll', () => {
  const tab = editableTab()
  if (!tab || !editorOpen) return
  tab.editorScroll = editorSource.scrollTop
  if (outlineJump) {
    outlineJump = false // consume the programmatic jump; the viewer is already positioned
    return
  }
  syncViewerToEditor()
})

let scrollSaveTimer = null
content.addEventListener('scroll', () => {
  const tab = activeTab()
  if (!tab) return
  tab.scroll = content.scrollTop
  updateActiveOutline()
  clearTimeout(scrollSaveTimer)
  scrollSaveTimer = setTimeout(saveSession, 400)
})

content.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return
  event.preventDefault()
  setFontSize(fontSize + (event.deltaY < 0 ? 1 : -1))
}, { passive: false })

window.addEventListener('keydown', (event) => {
  const ctrl = event.ctrlKey || event.metaKey

  if (ctrl && event.key.toLowerCase() === 'o') {
    event.preventDefault()
    openBtn.click()
    return
  }

  if (ctrl && event.key.toLowerCase() === 'w') {
    event.preventDefault()
    if (activeIndex !== -1) closeTab(activeIndex)
    return
  }

  if (ctrl && event.key.toLowerCase() === 's') {
    event.preventDefault()
    saveActiveTab()
    return
  }

  if (ctrl && event.key.toLowerCase() === 'e') {
    event.preventDefault()
    toggleEditor()
    return
  }

  if (ctrl && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    toggleOutline()
    return
  }

  if ((ctrl && event.key.toLowerCase() === 'r') || event.key === 'F5') {
    event.preventDefault()
    if (activeIndex !== -1) serial(() => reloadTab(activeIndex))
    return
  }

  if (event.key === 'Tab' && ctrl) {
    event.preventDefault()
    cycleTab(event.shiftKey ? -1 : 1)
    return
  }

  if (ctrl && (event.key === '=' || event.key === '+')) {
    event.preventDefault()
    setFontSize(fontSize + 1)
    return
  }

  if (ctrl && event.key === '-') {
    event.preventDefault()
    setFontSize(fontSize - 1)
    return
  }

  if (ctrl && event.key === '0') {
    event.preventDefault()
    setFontSize(16)
    return
  }

  if (ctrl && event.key >= '1' && event.key <= '9') {
    event.preventDefault()
    const index = event.key === '9' ? tabs.length - 1 : Number(event.key) - 1
    activateTab(index)
    return
  }

  // Let the content area respond to paging keys even when it isn't focused.
  if (['PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key) &&
      document.activeElement === document.body) {
    content.focus({ preventScroll: true })
  }
})

// ---------------------------------------------------------------------------
// Main-process events
// ---------------------------------------------------------------------------

api.onFileChanged((target) => serial(() => {
  const index = indexOfPath(target)
  if (index !== -1) return reloadTab(index)
}))

api.onOpenFiles((paths) => serial(() => openPaths(paths)))

// Closing the window with unsaved edits is a data-loss trap: cancel the close
// and let the main process ask, so `beforeunload` can't silently discard.
window.addEventListener('beforeunload', (event) => {
  saveSession()
  if (tabs.some((tab) => tab.dirty)) {
    event.preventDefault()
    event.returnValue = ''
    api.confirmClose()
  }
})

serial(restoreSession)
