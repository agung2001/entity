import fs from 'node:fs'
import path from 'node:path'
import { test, expect, readProfile } from '../fixtures.js'
import { callRpc } from '../helpers/rpc.js'
import { newThread, openChat, sendMessage, threadIdFromUrl, waitForAnswer } from '../helpers/app.js'

/**
 * ENTITY-20 — workspace settings → Chats: when a thread archives itself, and
 * when it is gone.
 *
 * The card is the control: the two dashed lines are the thresholds and the rows
 * underneath move them. These cases pin the things the design argues for — the
 * death line is `arc + delAfter` days of silence, the legend/effects/forecast are
 * one set of numbers, ② at a day is a stated consequence and not a dialog, and a
 * pass only touches what the forecast named.
 */
const DAY = 86_400_000

const card = (page) => page.locator('.acct-card')
const bars = (page) => page.locator('.ages-plot .bar')
const tags = (page) => page.locator('.ages-rule .tag')
const effects = (page) => page.locator('.rule-effect')
const danger = (page) => page.locator('.ret-warn')

async function openTab(page) {
  const p = readProfile()
  await page.goto(`/${p.workspace}/settings?tab=chats`)
  await expect(card(page)).toBeVisible()
  await expect(page.locator('.ages')).toBeVisible({ timeout: 20_000 })
  return p
}

/** Every test starts from the shipped rule, whatever ran before it. */
async function resetRule(p) {
  await callRpc(p, 'chat.setRetention', {
    workspace: p.workspace,
    patch: {
      archiveAfter: { n: 30, unit: 'days' },
      deleteAfter: { n: 180, unit: 'days' },
      archiveEvery: 'day',
      archiveBy: '03:00',
      deleteEvery: 'week',
      deleteBy: '03:00',
      protectPinned: true,
      protectRunning: true,
      protectArtifacts: true,
    },
  })
}

/** A thread file with a chosen silence, so the chart has something to draw. */
function backdate(p, name, { days, inArchive = null }) {
  const dir = path.join(p.workspacePath, 'chats')
  fs.mkdirSync(dir, { recursive: true })
  const at = new Date(Date.now() - days * DAY).toISOString()
  const doc = {
    schema: 1,
    id: `t_ret_${name}`,
    entity: 'chief-of-staff',
    machine: 'local',
    harness: 'claude',
    title: `retention ${name}`,
    createdAt: at,
    updatedAt: at,
    messages: [
      { who: 'me', text: `ask ${name}`, at },
      { who: 'agent', text: 'done', at },
    ],
  }
  if (inArchive !== null) {
    doc.archived = true
    doc.archivedAt = new Date(Date.now() - inArchive * DAY).toISOString()
  }
  const file = path.join(dir, `${doc.id}.json`)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
  return file
}

/** Two threads with different ages, so the chart has something to cut. */
function seedChart(p) {
  backdate(p, 'chart-recent', { days: 4 })
  backdate(p, 'chart-silent', { days: 45 })
}

test.describe('chat retention', () => {
  test('the card is a chart with two rules and one set of numbers', async ({ page }) => {
    const p = readProfile()
    await resetRule(p)
    seedChart(p)
    await openTab(page)

    /* 14 bands, always — an empty one draws nothing but keeps its column */
    await expect(bars(page)).toHaveCount(14)

    /* the two chips name the arithmetic: 30 days of silence, gone at 210 */
    await expect(tags(page).nth(0)).toContainText('1 Archive at 30 d')
    await expect(tags(page).nth(1)).toContainText('2 Gone at 210 d')

    /* the legend, the two rule effects and the badge are one set of numbers */
    const legend = await page.evaluate(() =>
      [...document.querySelectorAll('.legend-key')]
        .slice(0, 3)
        .map((el) => Number(el.querySelector('b')?.textContent || 0)),
    )
    const badge = Number((await page.locator('.role-badge').textContent()).replace(/\D+/g, ''))
    expect(legend.reduce((a, b) => a + b, 0)).toBe(badge)

    const numbers = await page.evaluate(() => ({
      archive: Number(/^(\d+)/.exec(document.querySelectorAll('.rule-effect')[0].textContent.trim())?.[1]),
      del: Number(/^(\d+)/.exec(document.querySelectorAll('.rule-effect')[1].textContent.trim())?.[1]),
    }))
    expect(numbers.archive).toBe(legend[1])
    expect(numbers.del).toBe(legend[2])

    /* each rule row is two lines by construction: the sentence, then the outcome */
    for (const index of [0, 1]) {
      const lines = await page.evaluate((i) => {
        const row = document.querySelectorAll('.rule-row')[i]
        const effect = row.querySelector('.rule-effect')
        const tail = row.querySelector('.rule-tail')
        return {
          effectBelow: effect.getBoundingClientRect().top >= tail.getBoundingClientRect().bottom - 2,
          rightAligned:
            Math.abs(
              effect.getBoundingClientRect().right - row.getBoundingClientRect().right,
            ) < 24,
        }
      }, index)
      expect(lines.effectBelow).toBe(true)
      expect(lines.rightAligned).toBe(true)
    }
  })

  test('moving ① moves both lines and says the sum in words', async ({ page }) => {
    const p = readProfile()
    await resetRule(p)
    seedChart(p)
    await openTab(page)

    const before = await page.evaluate(() =>
      [...document.querySelectorAll('.ages-rule')].map((el) => el.style.gridColumn),
    )
    const arcNum = page.locator('.rule-row').first().locator('input.rule-num')
    await arcNum.fill('7')
    await expect(page.locator('.rule-effect').first()).toContainText(/threads?/)
    await expect(page.locator('.ages-rule').first().locator('.tag')).toHaveText('1 Archive at 7 d')
    await expect(page.locator('.ages-rule').nth(1).locator('.tag')).toHaveText('2 Gone at 187 d')
    await expect(page.locator('.rule-derived')).toContainText('removed at 187')

    const after = await page.evaluate(() =>
      [...document.querySelectorAll('.ages-rule')].map((el) => el.style.gridColumn),
    )
    expect(after[0]).not.toBe(before[0])
    /* ②'s column only moves when the sum crosses a band edge (210 → 187 stays in
       the 180–240 band); its chip is what has to say 187, and it does above. */
    await resetRule(p)
  })

  test('② at one day states the consequence instead of asking', async ({ page }) => {
    const p = readProfile()
    await resetRule(p)
    seedChart(p)
    await openTab(page)

    await expect(danger(page)).toHaveCount(0)
    const delNum = page.locator('.rule-row').nth(1).locator('input.rule-num')
    await delNum.fill('1')
    await expect(danger(page)).toBeVisible()
    await expect(danger(page)).toContainText('② is 1 day')
    await expect(danger(page)).toContainText('no Trash')
    /* no dialog appeared: the value is legal, the field is on screen */
    await expect(page.locator('.modal[data-open="1"]')).toHaveCount(0)

    /* and it agrees with the effect above it */
    const removed = Number(/^(\d+)/.exec((await effects(page).nth(1).textContent()).trim())?.[1])
    await expect(danger(page)).toContainText(`${removed} thread`)

    await delNum.fill('180')
    await expect(danger(page)).toHaveCount(0)
    await resetRule(p)
  })

  test('only when I ask takes the deadline off both rows', async ({ page }) => {
    const p = readProfile()
    await resetRule(p)
    await openTab(page)

    for (const index of [0, 1]) {
      await page.locator('.sched-row').nth(index).locator('select').selectOption('manual')
      await expect(page.locator('.sched-time').nth(index)).toBeHidden()
      await expect(page.locator('.sched-tail').nth(index)).toBeHidden()
    }
    await expect(page.locator('.forecast-head')).toContainText('No automatic pass')
    await expect(page.locator('.ret-foot')).toContainText('no automatic pass')
    /* and no idle switch crept in: three protections, that is all */
    await expect(page.locator('.notif-option')).toHaveCount(3)
    await expect(page.locator('.acct-card')).not.toContainText('idle')
    await resetRule(p)
  })

  test('the pass touches exactly what the forecast named', async ({ page }) => {
    const p = readProfile()
    await resetRule(p)
    /* a thread silent past ①, and one archived past ② */
    const silent = backdate(p, 'silent', { days: 45 })
    const doomed = backdate(p, 'doomed', { days: 400, inArchive: 200 })

    await openTab(page)
    await expect(effects(page).first()).toContainText(/^[1-9]/)
    await expect(effects(page).nth(1)).toContainText(/^[1-9]/)

    await page.getByRole('button', { name: 'Archive due now' }).click()
    await expect(page.locator('.toast')).toContainText('archived')

    /* the archive pass wrote the flag and kept the file */
    await expect.poll(() => JSON.parse(fs.readFileSync(silent, 'utf8')).archived).toBe(true)
    /* the delete pass removed the thread that was already in the archive */
    await expect.poll(() => fs.existsSync(doomed)).toBe(false)
    /* nothing is left due: the forecast is the pass's own view, while the effects
       above keep counting the threads that are now *in* the archive */
    await expect(page.locator('.forecast li').first()).toContainText('0 threads archived')
    await expect(page.locator('.forecast li').nth(1)).toContainText('0 threads deleted')
    await expect(page.locator('.ret-foot')).toContainText('Last pass just now')
  })

  test('replying to an archived thread brings it back before ② can count', async ({ page }) => {
    const p = readProfile()
    await resetRule(p)
    await openChat(page, p)
    await newThread(page, { entity: 'chief-of-staff' })
    const id = threadIdFromUrl(page)
    await sendMessage(page, 'E2E-RETENTION-ARCHIVE me')
    await waitForAnswer(page, 'E2E-STUB-OK')

    /* archived by hand, then used again: the rule counts days *in the archive*, so
       a thread somebody is still talking in must not be counting toward deletion */
    await callRpc(p, 'chat.archive', { workspace: p.workspace, id })
    const file = path.join(p.workspacePath, 'chats', `${id}.json`)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).archived).toBe(true)

    await sendMessage(page, 'E2E-RETENTION-REPLY me')
    await waitForAnswer(page, 'E2E-STUB-OK')

    await expect
      .poll(() => JSON.parse(fs.readFileSync(file, 'utf8')).archived, { timeout: 15_000 })
      .toBe(undefined)
    expect('archivedAt' in JSON.parse(fs.readFileSync(file, 'utf8'))).toBe(false)
  })

  test('an empty workspace draws a note inside the chart, not an empty chart', async ({ page }) => {
    const p = readProfile()
    const empty = await callRpc(p, 'workspace.create', { label: 'e2e-retention-empty' })
    try {
      await page.goto(`/${empty.id}/settings?tab=chats`)
      await expect(page.locator('.empty-inline')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.empty-inline')).toContainText('No chats yet.')
      await expect(bars(page)).toHaveCount(0)
      await expect(page.locator('.rule-effect').first()).toContainText('0 threads')
      /* ② is still 180 days here, so the effect is a count of zero, not the
         "off" wording that belongs to `Never` */
      await expect(page.locator('.rule-effect').nth(1)).toContainText('0 threads')
      await expect(page.locator('.ret-foot')).toContainText('No pass has run yet')
    } finally {
      await callRpc(p, 'workspace.remove', { id: empty.id })
    }
  })
})
