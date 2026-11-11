# Entity

Desktop app built with **Vue 3 + Vite** (renderer) and **Electron** (shell).

## Requirements

- Node.js `^20.19` or `>=22.12` (Vite 8 requirement)

## Getting started

```bash
npm install
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Renderer only, in the browser at http://localhost:5183 |
| `npm run dev:desktop` | Starts Vite **and** Electron, pointed at the dev server (HMR included) |
| `npm run build` | Builds the renderer into `dist/` |
| `npm run start` | Runs Electron against the existing `dist/` build (no dev server) |
| `npm run preview` | Serves the built renderer through `vite preview` |
| `npm run package` | Builds and packages a distributable with electron-builder → `release/` |

### Ports

The dev server uses **5183** by default so it does not collide with the many
projects that grab Vite's default 5173. Override it with `VITE_DEV_PORT=6000 npm run dev`.
If the port is taken, Vite moves to the next free one and `dev:desktop` follows it
automatically — the launcher reads the URL Vite actually bound, it does not
assume a port.

## Layout

```
electron/
  main.cjs            main process: window, lifecycle, IPC handlers
  preload.cjs         contextBridge — the only surface exposed to the renderer
scripts/
  dev-desktop.mjs     runs Vite programmatically, then launches Electron
src/
  App.vue             root component
  main.js             renderer entry
  style.css           global styles / design tokens
  composables/
    useDesktop.js     typed-ish wrapper over the preload bridge
index.html            renderer HTML + CSP
vite.config.js        `base: './'` so the build loads over `file://`
```

## Talking to the main process

Keep IPC explicit — add an `ipcMain.handle('my:channel', …)` in
`electron/main.cjs`, expose a narrow method in `electron/preload.cjs`, and call it
from the renderer:

```js
// electron/main.cjs
ipcMain.handle('file:pick', async () => dialog.showOpenDialog({}))

// electron/preload.cjs
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  pickFile: () => ipcRenderer.invoke('file:pick'),
})

// renderer
const result = await window.desktop.pickFile()
```

Never expose `ipcRenderer` itself, and keep `contextIsolation: true` /
`nodeIntegration: false` (the defaults in this scaffold).

## Security notes

- Renderer runs **sandboxed** with context isolation, and a CSP is declared in
  `index.html` (it allows the HMR websocket in dev and nothing extra in prod).
- External links open in the OS browser; in-app navigation away from the app
  origin is blocked.
- Dev only: DevTools open detached when `ELECTRON_RENDERER_URL` is set.

## Relative asset paths

`vite.config.js` sets `base: './'`. Without it the built `index.html` requests
`/assets/…`, which resolves to the filesystem root under `file://` and the
packaged app renders a blank window.

## Not included (add when you need them)

Router (`vue-router`), state management (`pinia`), TypeScript, tests, auto-update.
