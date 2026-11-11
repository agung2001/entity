const { contextBridge, ipcRenderer } = require('electron')

// The only surface the renderer gets. Keep it explicit: never expose
// `ipcRenderer` itself.
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  /* local machine data — read-only ssh config, ssh probes and skill libraries */
  readSshHosts: () => ipcRenderer.invoke('ssh:hosts'),
  probeSshHost: (alias) => ipcRenderer.invoke('ssh:probe', alias),
  scanSkills: () => ipcRenderer.invoke('skills:scan'),
  readSkill: (harness, name) => ipcRenderer.invoke('skills:read', { harness, name }),
})
