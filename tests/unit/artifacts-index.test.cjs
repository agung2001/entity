/**
 * Files → works.
 *
 * The rule that turns a flat shelf listing into things a person can name: a
 * folder is a work when it writes its own document, or when it is a batch of
 * images and nothing else. The two non-obvious halves are pinned here — the
 * ancestor prunes its descendants, and a cover is a rank rather than a sort —
 * because both can look right on the three cards in a screenshot.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const load = () => import('../../src/lib/artifact-works.js')

const row = (id, size, modifiedAt, ext) => ({
  id,
  name: id.slice(id.lastIndexOf('/') + 1),
  ext: ext ?? `.${id.slice(id.lastIndexOf('.') + 1)}`,
  size,
  modifiedAt,
})

const ITEMS = [
  row('design/entities-index/index.html', 800_000, '2026-11-22T10:00:00.000Z'),
  row('design/entities-index/shots/shot-2.png', 200_000, '2026-11-22T09:00:00.000Z'),
  row('design/entities-index/shots/shot-1.png', 200_000, '2026-11-22T09:30:00.000Z'),
  row('design/tailscale-lan/shots/shot_03.png', 10_000, '2026-11-20T08:00:00.000Z'),
  row('design/tailscale-lan/shots/shot_01.png', 10_000, '2026-11-20T09:00:00.000Z'),
  row('mockups/config-transfer-v2/preview.jpg', 900_000, '2026-11-19T08:00:00.000Z'),
  row('mockups/config-transfer-v2/cover.png', 640_000, '2026-11-01T08:00:00.000Z'),
  row('mockups/config-transfer-v2/huge.png', 2_000_000, '2026-11-19T09:00:00.000Z'),
  row('specs/retention.md', 4_000, '2026-11-18T08:00:00.000Z'),
  row('scripts/render.mjs', 2_000, '2026-11-17T08:00:00.000Z'),
  row('notes.txt', 1_000, '2026-11-23T08:00:00.000Z'),
  row('mockup-fonts/inter.woff2', 30_000, '2026-11-16T08:00:00.000Z', '.woff2'),
]

test('a work is the top-most folder that wrote a document or is a batch of images', async () => {
  const { works, loose } = (await load()).groupWorks(ITEMS)
  assert.deepEqual(
    works.map((work) => work.path),
    ['design/entities-index', 'design/tailscale-lan/shots', 'mockups/config-transfer-v2', 'specs', 'scripts'],
  )
  /* `design/entities-index/shots` holds images and no subfolders, so it
     qualifies on its own — and is pruned by its parent, which is the work. The
     tailscale folder has no document of its own, so nothing prunes its `shots/`
     child: the deepest qualifying folder is the work. */
  assert.ok(!works.some((work) => work.path === 'design/entities-index/shots'))
  assert.ok(!works.some((work) => work.path === 'design/tailscale-lan'))
  assert.deepEqual(loose.map((item) => item.id), ['notes.txt', 'mockup-fonts/inter.woff2'])
})

test('a work carries the rows under it, and its own newest age', async () => {
  const { works } = (await load()).groupWorks(ITEMS)
  const index = works[0]
  assert.equal(index.name, 'entities-index')
  assert.equal(index.parent, 'design')
  assert.equal(index.fileCount, 3)
  assert.equal(index.size, 1_200_000)
  assert.equal(index.modifiedAt, '2026-11-22T10:00:00.000Z')
  assert.equal(index.shots, 2)
  assert.deepEqual(index.extMix[0], { ext: 'png', count: 2 })
})

test('a cover is ranked, and a shot must be a raster under the size cap', async () => {
  const { groupWorks, coverCandidate } = await load()
  const { works } = groupWorks(ITEMS)
  const byPath = Object.fromEntries(works.map((work) => [work.path, work]))
  /* `cover` 100 beats `preview` 90, and beats the 2 MB png that is not a
     candidate at all. */
  assert.equal(byPath['mockups/config-transfer-v2'].cover.id, 'mockups/config-transfer-v2/cover.png')
  /* `shot_01` is rank 79 and beats `shot_03` at 77. */
  assert.equal(byPath['design/tailscale-lan/shots'].cover.id, 'design/tailscale-lan/shots/shot_01.png')
  /* `shot-1` at 80-1 beats `shot-2` at 80-2 */
  assert.equal(byPath['design/entities-index'].cover.id, 'design/entities-index/shots/shot-1.png')
  /* a work that wrote only a document has no image to show at all */
  assert.equal(byPath.specs.cover, null)
  assert.equal(coverCandidate([row('a/logo.svg', 10, '2026-01-01T00:00:00.000Z', '.svg')]), null)
})

test('the counts partition the rows, and every bucket adds up to itself', async () => {
  const { counts } = (await load()).groupWorks(ITEMS)
  assert.equal(counts.files, 12)
  assert.equal(counts.works, 5)
  assert.equal(counts.loose, 2)
  assert.equal(counts.previews, 3)
  const sum = Object.values(counts.types).reduce((total, bucket) => total + bucket.count, 0)
  assert.equal(sum, counts.files)
  for (const bucket of Object.values(counts.types)) {
    const parts = bucket.exts.reduce((total, entry) => total + entry.count, 0)
    assert.equal(parts, bucket.count)
  }
  assert.deepEqual(counts.types.other.exts, [{ ext: 'woff2', count: 1 }])
  assert.deepEqual(counts.types.images.exts, [
    { ext: 'png', count: 6 },
    { ext: 'jpg', count: 1 },
  ])
})

test('an empty shelf is three zeroes, not a crash', async () => {
  const { works, loose, counts } = (await load()).groupWorks([])
  assert.deepEqual(works, [])
  assert.deepEqual(loose, [])
  assert.equal(counts.files, 0)
  assert.equal(counts.previews, 0)
  assert.equal(counts.bytes, 0)
})

/**
 * The page has to be reachable, and it has to arrive with the shelf beside it.
 * Both broke at once — the rail fell through to its Overview branch on
 * `/w/:workspace/artifacts` and listed machines next to the shelf, and the
 * section heading named a page nobody could open — so both are pinned here as
 * source contracts, the same way the UI contract pins the rest of the chrome.
 * Real data cannot catch either one: the shelf still renders, it is the rail
 * beside it that is wrong.
 */
const source = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')

test('the shelf page arrives with the shelf rail, not another section', () => {
  const rail = source('src/components/RailContext.vue')
  /* The route name is a page now, not only `artifact`: without both, `section`
     falls through to `overview` and the panel lists the machines. */
  assert.match(rail, /name === 'artifact' \|\| name === 'artifacts'/)
  assert.match(rail, /const shelfTitle = \(\) => \(\{/)
  const appRail = source('src/components/AppRail.vue')
  assert.match(appRail, /artifacts: 'Artifacts'/)
})

test('the section heading is the way to a section that has a page', () => {
  const rail = source('src/components/RailContext.vue')
  assert.match(rail, /class="rail-t2-title"/)
  assert.match(rail, /to: \{ name: 'artifacts', params: \{ workspace: hub\.workspace \} \}/)
  /* The heading is still the h2 the bar lays out; the button sits inside it, so
     the type and the ellipsis stay the bar's. */
  assert.match(rail, /<h2>\s*\n\s*<button\s*\n\s*v-if="section\.to"/)
})

/**
 * A page's own top bar is the page's *top edge*, not a block inside the reading
 * measure. The shelf shipped with `.ash-bar` inside `.ash-band`, so the bar's
 * hairline stopped at 1180px instead of the window and its crumb started 28px
 * right of the crumb on the page above — a containerised bar, which is the one
 * thing a second-row navigation must never be. Read from the stylesheet and the
 * template, because the mistake is a wrapper and no data can see a wrapper.
 */
const block = (css, selector) => {
  const at = css.indexOf(`\n${selector} {`)
  assert.ok(at >= 0, `no ${selector} rule`)
  const end = css.indexOf('\n}', at)
  return css.slice(at, end)
}

test("the shelf's bar is the page's top edge, not the column's", () => {
  const css = source('src/styles/artifacts-index.css')
  const view = block(css, '.view.ash-page')
  const bar = block(css, '.ash-bar')
  const band = block(css, '.ash-band')

  /* the view is the whole content area and pays no gutter — the bar does */
  assert.match(view, /max-width: none/)
  assert.match(view, /padding: 0 0 80px/)

  /* the bar: full width of that area, the top bar's own gutter and height */
  assert.match(bar, /width: 100%/)
  assert.match(bar, /height: 56px/)
  assert.match(bar, /padding: 0 var\(--view-pad\)/)
  assert.match(bar, /position: sticky/)
  /* `.entp-bar`'s material and offsets, so the two bars are one surface */
  assert.match(bar, /top: 0/)
  assert.match(bar, /z-index: 3/)
  assert.match(bar, /blur\(16px\) saturate\(1\.8\)/)

  /* the column below pays the inset the bar does not */
  assert.match(band, /width: min\(100% - \(2 \* var\(--view-pad\)\), 1180px\)/)
  assert.match(band, /margin: 20px auto 0/)
  /* a measure of its own on the bar would centre the crumb away from the one above */
  assert.doesNotMatch(bar, /max-width|margin: 0 auto|margin: 0 -?\d*var\(--view-pad\)/)

  /* the crumb is the same object as `.entp-crumb` and `.ovc-barcrumb` */
  const crumb = block(css, '.ash-crumb')
  assert.match(crumb, /font-family: var\(--mono\)/)
  assert.match(crumb, /font-size: var\(--fs-micro\)/)
  assert.match(crumb, /text-transform: uppercase/)
  const entp = source('src/styles/directory.css')
  /* and the bar it copies is still that bar */
  assert.match(block(entp, '.entp-bar'), /padding: 0 var\(--view-pad\)/)

  /* and the bar is a sibling of the measure, never its child */
  const view$ = source('src/views/ArtifactsIndexView.vue')
  const barAt = view$.indexOf('<header class="ash-bar">')
  const bandAt = view$.indexOf('<div class="ash-band">')
  assert.ok(barAt > 0 && bandAt > 0)
  assert.ok(barAt < bandAt, '.ash-bar must precede .ash-band as its sibling')
  const between = view$.slice(barAt, bandAt)
  assert.equal((between.match(/<\/header>/g) || []).length, 1, 'the bar must close before the band opens')
})
