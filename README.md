# Entity

Desktop app built with **Vue 3 + Vite** (renderer) and **Electron** (shell).

The renderer is the entity hub: containers for agents ("entities"), the skill
library, the machines they run on, and the conversations you have with them.
The design comes from the Open Design mock-ups (`hub-home`, `login`,
`skill-web-research`); `index.html` (the marketing site) is not part of this
app.

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
  main.js             renderer entry
  router.js           hash history + session guard
  App.vue             root: marks the platform (macOS traffic-light inset)
  layouts/
    HubLayout.vue     rail + topbar + router-view + global overlays
  views/
    LoginView.vue     sign in
    OverviewView.vue  ask console, machines, entities, activity
    ChatView.vue      history + thread + context picks
    EntitiesView.vue  the agents table, filterable by state
    SkillsView.vue    one library, copied per machine
    SkillDetailView.vue  overview / SKILL.md / files / runs
    MachinesView.vue  the fleet
    ActivityView.vue  every copy, sync and restart
  components/
    EntityMark.vue    the animated voxel character
    MarkPicker.vue    mood + colour, opened from the drawer
    AppRail.vue       brand, workspace switcher, nav, user
    AppTopbar.vue     breadcrumbs + view tools
    AskConsole / MessageList / SlashComposer
    PickMenu.vue      the quiet text trigger used for filter axes
    EntityDrawer.vue  details, skills, ENTITY.md, Relocate
    MoveAgentModal.vue
    CopySkillModal.vue
    CommandPalette.vue
    ToastHost.vue
  composables/
    entityMark.js     the mark's renderer + one shared rAF loop
    useDesktop.js     wrapper over the preload bridge
  stores/
    hub.js            session, workspace data, consoles, drawers, actions
  data/
    mock.js           the sample workspace (agents, machines, skills, seeds)
  styles/
    app.css           tokens, shell, rail, tables, consoles, overlays
    login.css         the sign-in screen
    skill.css         the skill detail page
  assets/fonts/geist.woff2
index.html            renderer HTML + CSP
vite.config.js        `base: './'` so the build loads over `file://`
```

## Routes

Hash history is used because the packaged app loads over `file://`, where
history mode has no server to resolve a path on reload.

| Route | Screen |
| --- | --- |
| `#/login` | Sign in (the only public route) |
| `#/` | Overview |
| `#/chat` | Chat |
| `#/entities` | Entities |
| `#/skills` | Skill library |
| `#/skills/:name` | Skill detail |
| `#/machines` | Machines |
| `#/activity` | Activity |

A session in `localStorage['entity.session']` skips the sign-in screen; the rail
user button signs out. `⌘K` / `Ctrl-K` opens the jump palette; `Esc` closes the
topmost overlay.

## Data

Everything on screen is a **sample workspace** held in `src/data/mock.js` and
mutated in place by `src/stores/hub.js`. Copying a skill, relocating an agent
and sending a console message update that state for the session; nothing is
written to disk except the session, the selected workspace and the mark's
mood/colour.

The mock-ups leave several behaviours unspecified (where the data really comes
from, whether transfers run over ssh, what the console dispatches to). Those
questions, and the assumption each one currently makes, live in
`reports/unclear/hub-mockup-questions.md`. `reports/` is gitignored.

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
  The mark sets CSS custom properties inline, which `style-src 'unsafe-inline'`
  covers; the font is served from the app, not a CDN.
- External links open in the OS browser; in-app navigation away from the app
  origin is blocked.
- Dev only: DevTools open detached when `ELECTRON_RENDERER_URL` is set.

## Relative asset paths

`vite.config.js` sets `base: './'`. Without it the built `index.html` requests
`/assets/…`, which resolves to the filesystem root under `file://` and the
packaged app renders a blank window.

## Not included (add when you need them)

State management (`pinia`), TypeScript, tests, auto-update.
