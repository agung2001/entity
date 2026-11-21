import { test, expect, readProfile } from '../fixtures.js'

/**
 * Workspace → Settings → Machines, drawn as the entity profile page.
 *
 * The gallery this replaces could not say two things, and both are the reason
 * the page exists: *why* a host is red once the toast is gone, and *which*
 * machine runs the artifact sweep. A roster answers both in place, and it keeps
 * the page height fixed while it does.
 *
 * The acceptance list is `design/machines-fleet/spec.md` §9, one `test` per
 * clause that a browser can check. Numbers here are measured, not chosen: the
 * name track must hold the longest alias on the fixture plus its `this machine` tag.
 */
async function openFleet(page) {
  const profile = readProfile()
  await page.goto(`/${profile.workspace}/settings?tab=machines`)
  await expect(page.getByRole('heading', { name: 'Machines' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.mrow').first()).toBeVisible({ timeout: 20_000 })
  return profile
}

const rowCount = (page) => page.locator('.mrow').count()

test.describe('workspace settings → machines', () => {
  test('a row is exactly four cells, in the order the grid depends on', async ({ page }) => {
    await openFleet(page)
    /* host · state · inventory · actions — the skills roster's grammar, with the
       station's tile folded into the host cell the way a skill's sigil rides
       inside `.skt .nm`. A fourth cell moved, or a fifth added, reflows the row
       and nothing else in the suite would notice. */
    const shapes = await page.locator('.mrow').evaluateAll((rows) =>
      rows.map((row) => ({
        children: row.children.length,
        classes: [...row.children].map((cell) => cell.className.split(' ')[0]),
        tileInside: Boolean(row.querySelector('.mfhost .mvslot')),
      })),
    )
    expect(shapes.length).toBeGreaterThan(1)
    for (const row of shapes) {
      expect(row.children).toBe(4)
      expect(row.classes).toEqual(['mfhost', 'state', 'mfcap', 'mfact'])
      expect(row.tileInside).toBe(true)
    }
  })

  test('the page has the entity shell\'s second row, with its verbs on it', async ({ page }) => {
    await openFleet(page)
    const bar = page.locator('.entp-bar')
    await expect(bar).toBeVisible()
    /* where you are, and the way back */
    await expect(bar.locator('.entp-crumb')).toContainText('Machines')
    await expect(bar.getByRole('link', { name: /Settings/ })).toBeVisible()
    /* the three page-wide verbs belong here, not under the facts */
    await expect(bar.getByRole('button', { name: /Test every host/ })).toBeVisible()
    await expect(bar.getByRole('button', { name: /Forget every fact/ })).toBeVisible()
    await expect(bar.getByRole('button', { name: /Reload/ })).toBeVisible()
    /* the bar is the page's top edge: it sticks, and the hero starts under it */
    const stick = await bar.evaluate((el) => {
      const style = getComputedStyle(el)
      return { position: style.position, top: style.top }
    })
    expect(stick.position).toBe('sticky')
    expect(stick.top).toBe('0px')
    expect((await bar.boundingBox()).y).toBeLessThan((await page.locator('.entp-hero').boundingBox()).y)
  })

  test('the bar and the roster hold the same measure', async ({ page }) => {
    for (const width of [1440, 1280, 768]) {
      await page.setViewportSize({ width, height: 900 })
      await openFleet(page)
      /* the shell is the parent's, so nesting a second `.detail-view` would
         inset the page by 56px and put the roster on a second measure */
      const nesting = await page.locator('.detail-view').evaluateAll((nodes) =>
        nodes.map((node) => node.querySelectorAll('.detail-view').length),
      )
      expect(nesting).toEqual([0])
      /* The bar is the page's *edge*: it bleeds the whole window and pads its own
         contents (`directory.css` — "no gutter of its own: the bar pays it, so a
         bar edge is a window edge"). Its CONTENTS therefore line up with the
         roster, not its box. Asserting the boxes agree was wrong. */
      /* the bar's own box starts where the roster starts: its first child is a
         button with 7px of padding of its own, so the child's box — not its text
         — is what lines up */
      const barLeft = await page.locator('.entp-bar .back').evaluate((el) => el.getBoundingClientRect().left)
      const rosterLeft = await page.locator('.mftable').evaluate((el) => el.getBoundingClientRect().left)
      expect(Math.abs(barLeft - rosterLeft)).toBeLessThanOrEqual(2)

      /* and the bar runs the window, exactly as the entity page's does */
      const bar = await page.locator('.entp-bar').evaluate((el) => el.getBoundingClientRect().width)
      const shell = await page.locator('.detail-view').evaluate((el) => el.getBoundingClientRect().width)
      expect(Math.abs(bar - shell)).toBeLessThanOrEqual(2)
      /* zero gap under the top bar — it is the page's top edge, not a card */
      const gap = await page.locator('.entp-bar').evaluate((el) => {
        const top = document.querySelector('.topbar')
        return el.getBoundingClientRect().top - top.getBoundingClientRect().bottom
      })
      expect(gap).toBe(0)
    }
  })

  test('the field is not welded to the table below it', async ({ page }) => {
    await openFleet(page)
    /* The field opens the roster, so it wants no gap above — but its own bottom
       border and the table's top border touched, and two hairlines a pixel apart
       read as one thick rule. */
    const box = await page.evaluate(() => {
      const field = document.querySelector('.mbar .wsl-search').getBoundingClientRect()
      const table = document.querySelector('.mftable').getBoundingClientRect()
      const above = document.querySelector('.mach-strip').getBoundingClientRect()
      return {
        below: Math.round(table.top - field.bottom),
        above: Math.round(field.top - above.bottom),
      }
    })
    expect(box.below).toBeGreaterThanOrEqual(10)
    expect(box.above).toBeLessThanOrEqual(24)
  })

  test('the Actions column and its header end on the same edge', async ({ page }) => {
    await openFleet(page)
    /* the cell is `justify-content: flex-end`; a left-aligned header over a
       right-aligned column reads as a different column */
    const edges = await page.evaluate(() => {
      const header = [...document.querySelectorAll('.mfhead > span[role="columnheader"]')].pop()
      const cell = document.querySelector('.mrow .mfact')
      return {
        header: Math.round(header.getBoundingClientRect().right),
        cell: Math.round(cell.getBoundingClientRect().right),
      }
    })
    expect(Math.abs(edges.header - edges.cell)).toBeLessThanOrEqual(8)
  })

  test('the filter has room around its glyph and its text is centred', async ({ page }) => {
    await openFleet(page)
    /* `.wsl-search` is a 32px box around a 20px input, which sat the caret high
       and glued the glyph to the first letter. The app's other search field is
       taller and padding-carried; this one matches it. */
    const box = await page.locator('.mbar .wsl-search').evaluate((el) => {
      const input = el.querySelector('input')
      const glyph = el.querySelector('svg')
      const field = el.getBoundingClientRect()
      const line = input.getBoundingClientRect()
      const icon = glyph.getBoundingClientRect()
      return {
        height: Math.round(field.height),
        inputHeight: Math.round(line.height),
        gap: Math.round(line.left - icon.right),
        centered: Math.abs(line.top + line.height / 2 - (field.top + field.height / 2)) < 2,
      }
    })
    expect(box.height).toBeGreaterThanOrEqual(34)
    /* the input fills the box, so its text cannot float to the top */
    expect(box.inputHeight).toBeGreaterThanOrEqual(box.height - 2)
    expect(box.centered).toBe(true)
    /* 8px read as glued at 34px; the app's other field carries more */
    expect(box.gap).toBeGreaterThanOrEqual(9)
  })

  test('the one filter takes the band, with no sentence beside it', async ({ page }) => {
    await openFleet(page)
    const field = page.locator('.mbar .wsl-search')
    const band = page.locator('.mach-shelf')
    const [fieldBox, bandBox] = [await field.boundingBox(), await band.boundingBox()]
    expect(Math.abs(fieldBox.width - bandBox.width)).toBeLessThanOrEqual(2)
    /* the tagline that used to share the row is gone */
    await expect(page.locator('.mbar .mnote')).toHaveCount(0)
  })

  test('all three verbs survive on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 })
    await openFleet(page)
    /* `directory.css` hides `.entp-bar .entp-actions .btn:first-child` below
       760px, which here is Reload — a page that cannot recover from a stale read */
    for (const name of [/Reload/, /Test every host/, /Forget every fact/]) {
      const button = page.locator('.entp-bar').getByRole('button', { name })
      await expect(button).toBeVisible()
      await expect(button).toBeInViewport()
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })

  test('the facts are a row above the table, so the roster owns the band', async ({ page }) => {
    await openFleet(page)
    const strip = await page.locator('.mach-strip').boundingBox()
    const roster = await page.locator('.mftable').boundingBox()
    const band = await page.locator('.mach-shelf').boundingBox()
    expect(strip).toBeTruthy()
    /* the strip is *between* the banner and the table, in that order */
    await expect(page.locator('.entp-hero')).toBeVisible()
    expect(strip.y).toBeGreaterThan((await page.locator('.entp-hero').boundingBox()).y)
    expect(strip.y).toBeLessThan(roster.y)
    /* and it costs the roster nothing: the table is as wide as the page */
    expect(Math.abs(roster.width - band.width)).toBeLessThanOrEqual(2)
  })

  test('the hero publishes --hero, so the cabinet actually paints', async ({ page }) => {
    await openFleet(page)
    /* Without it every `color-mix(in oklab, var(--hero) …)` is invalid and the
       hero falls back to `background: none` — a white rectangle, which is
       exactly how this shipped the first time. */
    const hero = await page.locator('.entp-hero').evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        token: style.getPropertyValue('--hero').trim(),
        background: style.backgroundImage,
        borderColor: style.borderColor,
        ink: style.color,
      }
    })
    expect(hero.token).not.toBe('')
    expect(hero.background).not.toBe('none')
    expect(hero.background).toContain('gradient')
    /* a border that is `currentColor` is the other half of the same failure */
    expect(hero.borderColor).not.toBe(hero.ink)
  })

  test('the inventory column states a count in full at 1280 and up', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openFleet(page)
    /* the rail used to starve this track to `5 harnesses · 1278 mo…`. A count
       that cannot be read is the same as a missing one. */
    const clipped = await page.locator('.mfcap .l1').evaluateAll((nodes) =>
      nodes
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => node.textContent.trim()),
    )
    expect(clipped).toEqual([])
  })

  test('a column can be resized, and the width holds', async ({ page }) => {
    await openFleet(page)
    await page.evaluate(() => localStorage.removeItem('entity.machines.cols'))
    await page.reload()
    await expect(page.locator('.mrow').first()).toBeVisible({ timeout: 20_000 })

    const tracks = () =>
      page.locator('.mrow').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    const deskTracks = () =>
      page.locator('.mfhead').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    const base = await tracks()
    expect(await deskTracks()).toBe(base)

    /* The Machine track is `minmax(floor, 1fr)` — the flexible one — so a drag
       moves its floor. Drag the Inventory handle instead: a fixed track's drag
       changes a number you can read back from the template. */
    const grip = page.locator('.mfhead .col-grip[aria-label="Resize the Inventory column"]')
    const box = await grip.boundingBox()
    const before = await page.evaluate(() =>
      Math.round(document.querySelector('.mrow .mfcap').getBoundingClientRect().width),
    )
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()

    const dragged = await tracks()
    expect(dragged).not.toBe(base)
    /* it moved the column it named, and the desk followed */
    expect(await deskTracks()).toBe(dragged)
    const after = await page.evaluate(() =>
      Math.round(document.querySelector('.mrow .mfcap').getBoundingClientRect().width),
    )
    expect(after).toBeGreaterThan(before + 40)

    /* a reader's table is worth remembering across a reload */
    await page.reload()
    await expect(page.locator('.mrow').first()).toBeVisible({ timeout: 20_000 })
    expect(await tracks()).toBe(dragged)

    /* a handle is a control: arrows nudge it, a double-click resets every column */
    await page.locator('.mfhead .col-grip[aria-label="Resize the Inventory column"]').focus()
    await page.keyboard.press('ArrowLeft')
    expect(await tracks()).not.toBe(dragged)
    await page.locator('.mfhead .col-grip[aria-label="Resize the Inventory column"]').dblclick({ force: true })
    expect(await tracks()).toBe(base)
  })

  test('no column is lopsided against its neighbour', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFleet(page)
    /* after a navigation: a blank page denies localStorage */
    await page.evaluate(() => localStorage.removeItem('entity.machines.cols'))
    await page.reload()
    await expect(page.locator('.mrow').first()).toBeVisible({ timeout: 20_000 })
    /* the inventory used to be handed the whole spare track — 420px against the
       name's 292 — which is what made the table look wrong. A count needs a
       reading column, not the widest one. */
    const widths = await page.locator('.mrow').first().evaluate((el) =>
      [...el.children].map((cell) => Math.round(cell.getBoundingClientRect().width)),
    )
    const [machine, state, inventory, actions] = widths
    /* the skills roster's shape: one wide track that eats the spare width and
       three narrow ones. The machine track owns the band. */
    expect(machine).toBeGreaterThan(state * 3)
    expect(machine).toBeGreaterThan(inventory * 1.5)
    expect(actions).toBeGreaterThanOrEqual(124)
    expect(actions).toBeLessThan(inventory)
  })

  test('the row wears one glyph, not two', async ({ page }) => {
    await openFleet(page)
    /* the station's tile drew the machine; a server glyph beside the name said it
       again, one row down from the drawing */
    await expect(page.locator('.mfhost .ic')).toHaveCount(0)
    await expect(page.locator('svg.machine-icon')).toHaveCount(0)
    await expect(page.locator('.mrow .mvslot .vx').first()).toBeVisible()
  })

  test('the desk stays on the cells\' tracks', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openFleet(page)
    /* `auto` / `max-content` would resolve per row, so the header and the cells
       would each get their own columns and the labels would run together. */
    const tracks = await page.locator('.mrow, .mfhead').evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).gridTemplateColumns),
    )
    expect(new Set(tracks).size).toBe(1)
  })

  test('the hero states the fleet once, and the counter agrees with the rows', async ({ page }) => {
    await openFleet(page)
    const rows = await rowCount(page)
    const counter = page.locator('.entp-xp')
    await expect(counter).toContainText(String(rows))
    /* `0 of N` while nothing has been scanned is the honest answer, and the
       track must agree with it rather than with a placeholder width. */
    const now = await counter.locator('[role="progressbar"]').getAttribute('aria-valuenow')
    const scanned = await page.locator('.mrow[data-probe="ok"]').count()
    expect(Number(now)).toBe(scanned)
    /* the count is stated in the hero's counter and nowhere twice: there is no
       section head over the roster to repeat it */
    await expect(page.locator('.entp-sec-head')).toHaveCount(0)
  })

  test('the page height is fixed: the roster scrolls, the page does not', async ({ page }) => {
    await openFleet(page)
    const box = await page.locator('.mftable-scroll').evaluate((el) => {
      /* the declared rule resolves to a px value; read both, so the test says what
         it means: the box is shorter than the page and it is the only scroller */
      const cap = 620
      const resolved = parseFloat(getComputedStyle(el).maxHeight)
      return { cap, resolved, overflow: getComputedStyle(el).overflowY, height: el.clientHeight }
    })
    expect(box.overflow).toBe('auto')
    expect(box.resolved).toBeLessThanOrEqual(box.cap)
    /* and it is actually bounded: fourteen rows do not fit in it */
    expect(box.height).toBeLessThanOrEqual(box.cap)
    /* the head stays stuck to the top of that box, not to the page */
    const head = await page.locator('.mfhead').evaluate((el) => {
      const style = getComputedStyle(el)
      return { position: style.position, top: style.top }
    })
    expect(head.position).toBe('sticky')
    expect(head.top).toBe('0px')
  })

  test('no horizontal scroll at 1280, 768 or 360, and the name never clips', async ({ page }) => {
    for (const width of [1280, 768, 360]) {
      await page.setViewportSize({ width, height: 900 })
      await openFleet(page)
      const seen = await page.evaluate(() => {
        const box = document.querySelector('.mftable-scroll')
        const name = document.querySelector('.mrow .mfhost .nm')
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          roster: box.scrollWidth - box.clientWidth,
          /* a wrapped identifier cannot be told from its sibling that differs in
             the last five characters */
          nameClipped: name.scrollWidth > name.clientWidth + 1,
        }
      })
      expect(seen.page, `the page scrolls sideways at ${width}px`).toBe(0)
      expect(seen.roster, `the roster scrolls sideways at ${width}px`).toBe(0)
      expect(seen.nameClipped, `a host name clips at ${width}px`).toBe(false)
    }
  })

  test('the name is the link, and the row is not', async ({ page }) => {
    await openFleet(page)
    /* DESIGN.md → "The name is the link, the row is not": the name is what a
       person aims at, the row wraps buttons. */
    const shapes = await page.locator('.mrow').evaluateAll((rows) =>
      rows.map((row) => ({
        current: row.getAttribute('aria-current') === 'true',
        host: row.getAttribute('data-host') === '1',
        nameAnchor: Boolean(row.querySelector('.mfhost b a.nm')),
        addrAnchor: Boolean(row.querySelector('.mfhost .addr a')),
        rowAnchor: Boolean(row.querySelector(':scope > a')),
      })),
    )
    for (const row of shapes) {
      /* no row is ever itself an anchor, and the address never is one */
      expect(row.rowAnchor).toBe(false)
      expect(row.addrAnchor).toBe(false)
      /* a run target's name goes somewhere; a git remote's does not */
      expect(row.nameAnchor).toBe(row.host && true)
    }
    /* and it points at the machine it names */
    const first = page.locator('.mrow[data-host="1"] .mfhost b a.nm').first()
    await expect(first).toBeVisible()
    expect(await first.getAttribute('href')).toMatch(/\/machines\/[^/]+$/)
  })

  test('a row that was never scanned carries the one primary action', async ({ page }) => {
    await openFleet(page)
    /* an ssh row, not `local`: this machine's row carries Open and the sweep */
    const never = page
      .locator('.mrow[data-host="1"]:not([aria-current="true"])')
      .filter({ hasText: 'not tested' })
      .first()
    await expect(never.getByRole('button', { name: /Test & scan/ })).toBeVisible()
    /* and the row says what a scan would do for it, so the button is not a
       question mark */
    await expect(never.locator('.mfcap .l2')).toContainText('a scan stores it here')
  })

  test('a failed scan leaves its reason in the row, not in a toast', async ({ page }) => {
    await openFleet(page)
    /* A git remote resolves but is not an agent host; the sweep control and the
       scan are absent, and the row says why rather than greying a dead button. */
    const remote = page.locator('.mrow[data-host="0"]').first()
    await expect(remote).toContainText('not a host')
    await expect(remote.locator('.mfcap .l1')).toContainText('a git remote')
    await expect(remote.getByRole('button', { name: /Test & scan/ })).toHaveCount(0)
  })

  test('the sweep control exists only where a pass can run', async ({ page }) => {
    const profile = await openFleet(page)
    /* `local` always, and the sync host when the workspace is shared — never on
       an ssh row, which is a run target and not a daemon. */
    const sweeps = await page.locator('.mrow').evaluateAll((rows) =>
      rows
        .filter((row) =>
          [...row.querySelectorAll('.mfact .btn')].some((node) => /Sweep/i.test(node.textContent)),
        )
        .map((row) => row.querySelector('.mfhost .nm').textContent.trim()),
    )
    expect(sweeps.length).toBeGreaterThan(0)
    /* exactly the two machines that can run a pass, and no ssh alias */
    const localLabel = await page.locator('.mrow[aria-current="true"] .nm').textContent()
    expect(sweeps).toEqual([localLabel.trim()])
    /* a git remote is in the file but is not a place to run an agent; its
       actions answer in words, so nobody sees a button that fails after a click */
    await expect(
      page.locator('.mrow[data-host="0"]').first().locator('.mfact .owner-word'),
    ).toContainText('owner decides')
    expect(profile.workspace).toBeTruthy()
  })

  test('search focuses from the catalog key and echoes a typo back', async ({ page }) => {
    await openFleet(page)
    const field = page.locator('#inventory-search')
    await expect(field).toBeVisible()
    /* the hint is rendered from the catalog, never typed into the component */
    await expect(page.locator('.mbar .search-kbd')).toBeVisible()

    await field.fill('zzz-nothing')
    await expect(page.locator('.empty-note')).toContainText('No machine matches “zzz-nothing”')
    await page.getByRole('button', { name: 'Clear the search' }).click()
    await expect(page.locator('.mrow').first()).toBeVisible()

    /* a real filter narrows the roster rather than the page */
    const total = await rowCount(page)
    await field.fill('root-')
    expect(await rowCount(page)).toBeLessThan(total)
  })

  test('the skeleton wears the real row height, so nothing jumps', async ({ page }) => {
    const profile = readProfile()
    await page.goto(`/${profile.workspace}/settings?tab=machines`)
    /* the first paint is the skeleton; the answer replaces it in place */
    const heights = await page.locator('.mrow').evaluateAll((rows) => rows.map((row) => row.offsetHeight))
    if (heights.length) {
      for (const height of heights) expect(height).toBeGreaterThanOrEqual(58)
    }
    await expect(page.locator('.mfhead')).toBeVisible()
  })

  test('a member reads the sweep answer instead of a button that fails', async ({ page }) => {
    await openFleet(page)
    /* The suite's profile is an owner, so this asserts the mechanism rather than
       a second account: one predicate decides both, and it is in the component. */
    const view = await page.locator('.mach-shelf').evaluate((el) => el.outerHTML)
    expect(view).toContain('owner decides')
    expect(view).not.toContain('Run the sweep here')
  })
})
