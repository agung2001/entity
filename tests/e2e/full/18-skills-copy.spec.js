import fs from 'node:fs'
import path from 'node:path'
import { test, expect, readProfile } from '../fixtures.js'
import { callRpc } from '../helpers/rpc.js'

/**
 * ENTITY-19 — the workspace skills roster is an inventory, and a skill can be
 * copied into another workspace.
 *
 * The roster cases pin the grammar the design asked for (a bounded table, `/`
 * into the search, every list state drawn) and the copy cases pin the three
 * things that make the sheet safe: nothing is written until the clash is
 * decided, the source keeps its copy, and Escape does nothing while a copy is in
 * flight.
 */
const rows = (page) => page.locator('.skt .row:not(.head)')
const search = (page) => page.locator('.sksearch input')
const sheet = (page) => page.locator('.skcopy-modal')

async function openRoster(page, p = readProfile()) {
  await page.goto(`/${p.workspace}/skills`)
  /* the rail carries a "Skills" heading too, so the page is identified by its
     own command bar rather than by a duplicated accessible name */
  await expect(page.locator('.skbar')).toBeVisible()
  await expect(rows(page).first()).toBeVisible()
}

async function openCopy(page, name) {
  await search(page).fill(name)
  await expect(rows(page)).toHaveCount(1)
  await rows(page).first().locator('.acts .btn').first().click()
  await expect(sheet(page)).toBeVisible()
  /* the destinations are read before the sheet can promise anything */
  await expect(sheet(page).locator('.vline')).not.toContainText('reading')
  return sheet(page)
}

/** The skills a workspace actually carries on disk, read through the call table. */
async function attached(p, id) {
  const list = await callRpc(p, 'workspace.skills', { id })
  return list.map((item) => item.name)
}

test.describe('the workspace skills roster', () => {
  test('is a bounded table with one separator system and a search', async ({ page }) => {
    await openRoster(page)
    const measurements = await page.evaluate(() => {
      const box = document.querySelector('.skt')
      const head = document.querySelector('.skt .row.head')
      const first = document.querySelector('.skt .row:not(.head)')
      const style = (el, prop) => getComputedStyle(el)[prop]
      return {
        scrollHeight: box.scrollHeight,
        clientHeight: box.clientHeight,
        headBottom: style(head, 'borderBottomWidth'),
        firstTop: style(first, 'borderTopWidth'),
        headPosition: style(head, 'position'),
        nameSize: style(first.querySelector('.nm'), 'fontSize'),
        nameWeight: style(first.querySelector('.nm'), 'fontWeight'),
        metaSize: style(first.querySelector('.files'), 'fontSize'),
      }
    })

    /* A roster of a handful of skills never grows the page: one bounded box. */
    expect(measurements.scrollHeight - measurements.clientHeight).toBeLessThanOrEqual(1)
    /* One separator: the header has none, the first row owns the line. */
    expect(measurements.headBottom).toBe('0px')
    expect(measurements.firstTop).toBe('1px')
    expect(measurements.headPosition).toBe('sticky')
    /* DESIGN.md inventory density */
    expect(measurements.nameSize).toBe('13px')
    expect(measurements.nameWeight).toBe('600')
    expect(measurements.metaSize).toBe('10px')

    /* `/` puts the caret in the search — outside an editable field first. */
    await page.locator('.skbar-where').click()
    await page.keyboard.press('/')
    await expect(search(page)).toBeFocused()
    await page.keyboard.type('uat-alpha')
    await expect(rows(page)).toHaveCount(1)
    await expect(page.locator('.skbar-where')).toContainText('1 of')
    /* the hint is the catalog's, not a literal */
    await expect(page.locator('.sksearch-key')).toHaveText('/')
  })

  test('states no results and clears the search again', async ({ page }) => {
    await openRoster(page)
    await search(page).fill('screenplay')
    const note = page.locator('.empty-note').first()
    await expect(note).toContainText('No skill matches “screenplay”.')
    await expect(rows(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear the search' }).click()
    await expect(search(page)).toHaveValue('')
    await expect(rows(page).first()).toBeVisible()
  })

  test('draws a skill whose directory is gone as a blocked row', async ({ page }) => {
    test.skip(process.platform === 'win32', 'a dangling link needs elevation on Windows')
    const p = readProfile()
    const broken = path.join(p.workspacePath, 'skills', p.skills.broken)
    fs.rmSync(broken, { force: true })
    fs.symlinkSync(path.join(p.workspacePath, 'skills', 'gone'), broken)

    await openRoster(page)
    await search(page).fill(p.skills.broken)
    const row = rows(page).first()
    await expect(row).toHaveClass(/miss/)
    await expect(row.locator('.d')).toContainText('Link target missing')
    await expect(row.locator('.files')).toHaveText('—')
    const copy = row.locator('.acts .btn').first()
    await expect(copy).toBeDisabled()
    await expect(copy).toHaveAttribute('aria-label', /unavailable, the entry file is missing/)
    /* the row's other control still names its row */
    await expect(row.locator('.acts .btn-icon')).toHaveAttribute(
      'aria-label',
      `Detach ${p.skills.broken} from this workspace`,
    )

    fs.rmSync(broken, { force: true })
  })

  test('offers the empty note with a working way out', async ({ page }) => {
    const p = readProfile()
    /* a workspace with no skills at all — created for this test, then removed */
    const empty = await callRpc(p, 'workspace.create', { label: 'e2e-empty-skills' })
    try {
      await page.goto(`/${empty.id}/skills`)
      const note = page.locator('.empty-note').first()
      await expect(note).toContainText('No skills in this workspace yet.')
      await expect(rows(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Open the harness libraries' }).click()
      await expect(page.locator('.sk-tabs button[aria-selected="true"]')).toContainText(
        'Harness libraries',
      )
    } finally {
      await callRpc(p, 'workspace.remove', { id: empty.id })
    }
  })
})

test.describe('copy a skill into another workspace', () => {
  test('a clean target copies in one click and says where it landed', async ({ page }) => {
    const p = readProfile()
    const target = p.otherWorkspace
    for (const name of await attached(p, target)) {
      await callRpc(p, 'workspace.detachSkill', { id: target, name })
    }

    await openRoster(page)
    await openCopy(page, p.skills.alpha)

    await expect(sheet(page).getByRole('radiogroup')).toBeVisible()
    /* the source is not a destination: a copy into itself is a rename */
    await expect(sheet(page).locator('.destbtn')).toHaveCount(1)
    await expect(sheet(page).locator('.destbtn')).toContainText('local · no uat-alpha')
    await expect(sheet(page).locator('.skclash')).toHaveCount(0)
    await expect(sheet(page).locator('.vline')).toContainText('nothing to replace')

    const primary = sheet(page).locator('.mo-foot .btn-ink')
    await expect(primary).toBeEnabled()
    await primary.click()

    await expect(page.locator('.toast')).toContainText(`uat-alpha copied to`)
    await expect(sheet(page)).toHaveCount(0)
    expect(await attached(p, target)).toContain('uat-alpha')
    /* the source keeps its copy */
    expect(await attached(p, p.workspace)).toContain('uat-alpha')
    const landed = path.join(p.otherWorkspacePath, 'skills', 'uat-alpha', 'SKILL.md')
    expect(fs.readFileSync(landed, 'utf8')).toContain('E2E-SKILL-LOADED')
  })

  test('a clash is decided before anything is written', async ({ page }) => {
    const p = readProfile()
    const target = p.otherWorkspace
    /* the previous test copied it; make sure the target has the name either way */
    if (!(await attached(p, target)).includes('uat-alpha')) {
      await callRpc(p, 'workspace.copySkill', {
        from: p.workspace,
        to: target,
        name: 'uat-alpha',
      })
    }
    const targetFile = path.join(p.otherWorkspacePath, 'skills', 'uat-alpha', 'SKILL.md')
    fs.writeFileSync(targetFile, '---\nname: uat-alpha\ndescription: the copy that is already there\n---\n\nThe target’s own bytes.\n')

    await openRoster(page)
    await openCopy(page, p.skills.alpha)

    const primary = sheet(page).locator('.mo-foot .btn-ink')
    await expect(sheet(page).locator('.skclash')).toContainText(
      `already has a skill called “uat-alpha”`,
    )
    await expect(primary).toBeDisabled()
    await expect(sheet(page).locator('.vline')).toContainText('1 file ·')
    /* nothing has been written yet */
    expect(fs.readFileSync(targetFile, 'utf8')).toContain('The target’s own bytes.')

    /* Keep both lands beside it and names the landing in the toast */
    await sheet(page).getByRole('button', { name: /Keep both/ }).click()
    await expect(sheet(page).locator('.skchoose button[aria-pressed="true"]')).toContainText(
      'uat-alpha-2',
    )
    await expect(primary).toBeEnabled()
    await primary.click()
    await expect(page.locator('.toast')).toContainText('as uat-alpha-2')
    expect(await attached(p, target)).toContain('uat-alpha-2')
    expect(fs.readFileSync(targetFile, 'utf8')).toContain('The target’s own bytes.')

    /* Replace is the destructive one, and it is the one that changes the bytes */
    await openCopy(page, p.skills.alpha)
    await sheet(page).getByRole('button', { name: /Replace the copy/ }).click()
    await expect(primary).toBeEnabled()
    await primary.click()
    await expect(page.locator('.toast')).toContainText('uat-alpha copied to')
    await expect
      .poll(() => fs.readFileSync(targetFile, 'utf8'), { timeout: 10_000 })
      .toContain('E2E-SKILL-LOADED')
  })

  test('Escape and the scrim close it, but not while a copy is in flight', async ({ page }) => {
    const p = readProfile()
    await openRoster(page)
    await openCopy(page, p.skills.alpha)
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toHaveCount(0)

    await openCopy(page, p.skills.alpha)
    await page.locator('.scrim[data-open="1"]').click({ position: { x: 6, y: 6 } })
    await expect(sheet(page)).toHaveCount(0)

    /* Hold the copy open and try to dismiss it: the sheet is a decision in
       progress, and a dismissed sheet over a half-renamed directory is how a
       skill goes missing. */
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    await page.route('**/__entity/call', async (route) => {
      if ((route.request().postData() || '').includes('workspace.copySkill')) await gate
      await route.continue()
    })
    try {
      await openCopy(page, p.skills.alpha)
      if (await sheet(page).locator('.skclash').count()) {
        await sheet(page).getByRole('button', { name: /Keep both/ }).click()
      }
      await sheet(page).locator('.mo-foot .btn-ink').click()
      await expect(sheet(page).locator('.mo-head p')).toContainText('Copying')
      await expect(sheet(page).locator('.mo-foot .btn-ink')).toHaveText('Copying…')

      await page.keyboard.press('Escape')
      await expect(sheet(page)).toBeVisible()
      await sheet(page).locator('.mo-x').click({ force: true })
      await expect(sheet(page)).toBeVisible()
      await expect(sheet(page).locator('.mo-x')).toBeDisabled()
    } finally {
      release()
    }
    /* Let the held request finish before the route is removed: unrouting under
       an in-flight request is a Playwright error, not a product one. */
    await expect(page.locator('.toast')).toContainText('copied to', { timeout: 15_000 })
    await page.unroute('**/__entity/call')
    await expect(sheet(page)).toHaveCount(0)
  })

  test('the skill page offers the same sheet', async ({ page }) => {
    const p = readProfile()
    await page.goto(`/${p.workspace}/skills/${p.skills.alpha}`)
    await page.getByRole('button', { name: 'Copy to workspace…' }).click()
    await expect(sheet(page)).toBeVisible()
    await expect(sheet(page)).toContainText('uat-alpha')
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toHaveCount(0)
  })
})
