'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('mdv', {
  /** Real filesystem path of a File dragged in from Explorer. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  openDialog: () => ipcRenderer.invoke('files:open-dialog'),
  acceptPaths: (paths) => ipcRenderer.invoke('files:accept', paths),
  readFile: (target) => ipcRenderer.invoke('file:read', target),
  render: (source, filePath) => ipcRenderer.invoke('file:render', source, filePath),
  saveFile: (target, source, eol, bom) => ipcRenderer.invoke('file:save', target, source, eol, bom),
  resolveLink: (fromPath, href) => ipcRenderer.invoke('link:resolve', fromPath, href),

  openExternal: (url) => ipcRenderer.send('link:external', url),
  revealInExplorer: (target) => ipcRenderer.send('shell:reveal', target),
  setTitle: (title) => ipcRenderer.send('window:title', title),

  watch: (target) => ipcRenderer.send('file:watch', target),
  unwatch: (target) => ipcRenderer.send('file:unwatch', target),

  confirmClose: () => ipcRenderer.send('app:confirm-close'),

  loadSession: () => ipcRenderer.invoke('session:load'),
  saveSession: (state) => ipcRenderer.send('session:save', state),

  onFileChanged: (callback) => ipcRenderer.on('file:changed', (_event, target) => callback(target)),
  onOpenFiles: (callback) => ipcRenderer.on('files:opened', (_event, paths) => callback(paths)),
})
