const { contextBridge, ipcRenderer } = require('electron')

// The only surface the renderer gets. Keep it explicit: never expose
// `ipcRenderer` itself.
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  /* Native notification. The main process owns the Notification object and
     sends the click target back so the renderer can open the thread. */
  notify: (payload) => ipcRenderer.invoke('app:notify', payload),
  syncNotificationSettings: (payload) =>
    ipcRenderer.invoke('app:notification-settings', payload),
  /* Which thread is on screen, so a reply in another thread can still notify
     while the window is focused. */
  syncViewState: (payload) => ipcRenderer.invoke('app:view-state', payload),
  onNotificationClick: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('app:notification-click', listener)
    return () => ipcRenderer.removeListener('app:notification-click', listener)
  },

  /* The application menu's Settings item. Same shape as the notification
     channel: a payload-less event, and an unsubscribe function back. */
  onOpenAccount: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('app:open-account', listener)
    return () => ipcRenderer.removeListener('app:open-account', listener)
  },

  /* A protocol launch carries a hash-router path from the main process. */
  onDeepLink: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('app:deep-link', listener)
    return () => ipcRenderer.removeListener('app:deep-link', listener)
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
