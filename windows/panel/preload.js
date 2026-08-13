const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeUsage', {
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  getTransparency: () => ipcRenderer.invoke('get-transparency'),
  onTransparency: (cb) => ipcRenderer.on('transparency', (_e, value) => cb(value)),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, value) => cb(value)),
  getVisibleRows: () => ipcRenderer.invoke('get-visible-rows'),
  onVisibleRows: (cb) => ipcRenderer.on('visible-rows', (_e, value) => cb(value)),
  pollNow: () => ipcRenderer.invoke('poll-now'),
  onForceRefresh: (cb) => ipcRenderer.on('force-refresh', () => cb()),
  hidePanel: () => ipcRenderer.send('hide-panel'),
  reportContentHeight: (height) => ipcRenderer.send('content-height', height),
});
