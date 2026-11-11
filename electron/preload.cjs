const { contextBridge, ipcRenderer } = require('electron')

// The only surface the renderer gets. Keep it explicit: never expose
// `ipcRenderer` itself.
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  getAppInfo: () => ipcRenderer.invoke('app:info'),
})
