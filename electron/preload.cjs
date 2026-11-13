const { contextBridge, ipcRenderer } = require('electron')

// The only surface the renderer gets. Keep it explicit: never expose
// `ipcRenderer` itself.
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  /* Native notification. The main process owns the Notification object and
     sends the click target back so the renderer can open the thread. */
  notify: (payload) => ipcRenderer.invoke('app:notify', payload),
  onNotificationClick: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('app:notification-click', listener)
    return () => ipcRenderer.removeListener('app:notification-click', listener)
  },

  /* All local data goes through one call table (electron/rpc.cjs). The renderer
     passes a name and an argument object; it never passes a path or a command. */
  call: (fn, args) => ipcRenderer.invoke('entity:call', { fn, args }),

  /* Streaming run events. Returns an unsubscribe function; every event carries
     its own workspace so the renderer can drop foreign ones. */
  onRunEvent: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('entity:event', listener)
    return () => ipcRenderer.removeListener('entity:event', listener)
  },
})
