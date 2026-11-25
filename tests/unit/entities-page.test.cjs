const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/* ENTITY-66: the roster is a page of its own. Three static facts about that
   move — a route that exists, a stylesheet the app actually loads, and a view
   that draws the table instead of the rail. Nothing here mounts a component:
   `npm run dev` and the Playwright packs cover behaviour. */
const SRC = path.join(__dirname, '..', '..', 'src')
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')

test('the entities index is a route of its own, above the detail route', () => {
  const router = read('router.js')
  const index = router.indexOf("name: 'entities'")
  const detail = router.indexOf("name: 'entity'")
  assert.ok(index > -1, "no route named 'entities'")
  assert.ok(detail > -1, "the detail route named 'entity' is gone")
  assert.ok(index < detail, "'entities' must be declared before ':workspace/entities/:name'")
  assert.match(
    router.slice(Math.max(0, index - 400), index + 400),
    /path: ':workspace\/entities'/,
    'the entities route is not the bare path',
  )
})

test('the index has a stylesheet, and the app loads it', () => {
  const sheet = read('styles/entities-page.css')
  assert.ok(sheet.trim().length > 0, 'entities-page.css is empty')
  assert.match(read('styles/app.css'), /@import '\.\/entities-page\.css';/, 'app.css does not import it')
})

test('the index renders the roster and all three ways it can fail to', () => {
  const view = read('views/EntitiesView.vue')
  assert.match(view, /role="table"/, 'the roster is not a table')
  assert.match(view, /entities\.error/, 'the view cannot show an unreadable folder')
  assert.match(view, /loadEntities/, 'the view never reads the folder')
})
