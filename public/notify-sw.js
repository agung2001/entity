/* Browser notifications need a worker once the page can be in the background.
   This worker has one job: put the user back on the thread named by the banner. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('notificationclick', (event) => {
  const route = event.notification.data?.route || '/'
  event.notification.close()
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        try {
          await client.focus()
          client.postMessage({ type: 'entity:notification-click', route })
          return
        } catch {
          /* try the next window */
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(route)
    })(),
  )
})
