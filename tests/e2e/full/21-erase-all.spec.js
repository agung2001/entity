import fs from 'node:fs'
import path from 'node:path'
import { test, expect, readProfile } from '../fixtures.js'
import { callRpc } from '../helpers/rpc.js'

/**
 * "Erase all" on Workspace → Chats and Workspace → Artifacts.
 *
 * The one destructive control in settings: it removes a whole population, it asks
 * in a dialog, the primary stays disabled until the word is typed, and it leaves
 * the workspace (entities, retention rule) alone. Artifacts has three buttons —
 * shared, personal, all — because the card draws three populations and one button
 * could not say which half a person meant.
 *
 * The dialog is always in the DOM (the app fades modals instead of unmounting
 * them), so closed means `data-open="0"`, not "not visible".
 */
const WORD = 'ERASE'
const dialog = (page) => page.locator('.erase-modal')

async function openTab(page, tab) {
  const p = readProfile()
  await page.goto(`/${p.workspace}/settings?tab=${tab}`)
  await expect(page.locator('.acct-card')).toBeVisible()
  return p
}

/** Three silent threads, so the card has a count and the button is enabled. */
function seedThreads(p, count = 3) {
  const dir = path.join(p.workspacePath, 'chats')
  fs.mkdirSync(dir, { recursive: true })
  for (let n = 0; n < count; n += 1) {
    const at = new Date().toISOString()
    const doc = {
      schema: 1,
      id: `t_erase_${n}`,
      entity: 'chief-of-staff',
      machine: 'local',
      harness: 'claude',
      title: `erase ${n}`,
      createdAt: at,
      updatedAt: at,
      messages: [{ who: 'me', text: `ask ${n}`, at }],
    }
    fs.writeFileSync(path.join(dir, `${doc.id}.json`), JSON.stringify(doc, null, 2))
  }
  return dir
}

/**
 * One file on the signed-in account's personal shelf. It is written through the
 * call table, not by guessing the folder name: the store keys `.personal/` by the
 * account, and a test that re-derived the slug would pin its own copy of it.
 */
async function seedPersonal(p) {
  await callRpc(p, 'artifact.upload', {
    workspace: p.workspace,
    name: 'mine.md',
    dataUrl: `data:text/markdown;base64,${Buffer.from('# mine\n').toString('base64')}`,
  })
  const root = path.join(p.workspacePath, '.personal')
  const account = fs.readdirSync(root).find((name) => !name.startsWith('.'))
  return path.join(root, account, 'artifacts')
}

/**
 * A file on the shelf and one in the archive, so both populations are named. The
 * archived one is written straight into the dot folder the shelf walk skips.
 */
function seedShelf(p) {
  const shared = path.join(p.workspacePath, 'artifacts')
  fs.mkdirSync(path.join(shared, '.archive'), { recursive: true })
  fs.writeFileSync(path.join(shared, 'keep.md'), '# keep\n')
  fs.writeFileSync(path.join(shared, '.archive', 'old.md'), '# old\n')
  return shared
}

/** The row's own button, so a trigger never matches the dialog's primary. */
const rowButton = (page, name) =>
  page.locator('.erase-option').filter({ hasText: name }).getByRole('button', { name, exact: true })

async function confirmWith(page, label) {
  await dialog(page).locator('#erase-all-word').fill(WORD)
  await dialog(page).getByRole('button', { name: label, exact: true }).click()
  await expect(dialog(page)).toHaveAttribute('data-open', '0')
}

test.describe('erase all', () => {
  test('Chats → Erase all asks for the word before it removes anything', async ({ page }) => {
    const p = readProfile()
    await openTab(page, 'chats')
    const dir = seedThreads(p)
    /* The suite runs in one profile: an earlier spec may have left threads here,
       so "everything" is measured against what this test found, not against its
       own three. */
    const before = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).length
    await page.reload()
    await expect(page.locator('.acct-card')).toBeVisible()

    const trigger = page.getByRole('button', { name: 'Erase all', exact: true })
    await trigger.click()
    await expect(dialog(page)).toHaveAttribute('data-open', '1')
    await expect(dialog(page)).toContainText('Type ERASE to confirm')

    const confirm = dialog(page).getByRole('button', { name: 'Erase all chats', exact: true })
    await expect(confirm).toBeDisabled()
    /* A near miss is not consent. */
    await dialog(page).locator('#erase-all-word').fill('erase')
    await expect(confirm).toBeDisabled()
    await dialog(page).locator('#erase-all-word').fill(WORD)
    await expect(confirm).toBeEnabled()

    /* Esc dismisses the dialog and leaves the history alone. */
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveAttribute('data-open', '0')
    expect(fs.readdirSync(dir).filter((file) => file.endsWith('.json')).length).toBe(before)

    await trigger.click()
    await dialog(page).locator('#erase-all-word').fill(WORD)
    await confirm.click()
    await expect(dialog(page)).toHaveAttribute('data-open', '0')
    expect(fs.readdirSync(dir).filter((file) => file.endsWith('.json'))).toEqual([])
    expect(await callRpc(p, 'chat.list', { workspace: p.workspace })).toEqual([])
  })

  test('Artifacts → the three erase buttons each name their population', async ({ page }) => {
    const p = readProfile()
    await openTab(page, 'artifacts')
    const shared = seedShelf(p)
    const personal = await seedPersonal(p)
    await page.reload()
    await expect(page.locator('.acct-card')).toBeVisible({ timeout: 20_000 })

    /* Shared only: the personal shelf must survive its sibling's button. */
    await rowButton(page, 'Erase shared').click()
    await expect(dialog(page)).toContainText('Erase the shared shelf?')
    await confirmWith(page, 'Erase shared')
    expect(fs.existsSync(path.join(shared, 'keep.md'))).toBe(false)
    expect(fs.existsSync(path.join(shared, '.archive', 'old.md'))).toBe(false)
    expect(fs.existsSync(path.join(personal, 'mine.md'))).toBe(true)

    /* Personal only: the shared shelf is already empty, so this proves the scope
       went the other way rather than that the first click removed everything. */
    await rowButton(page, 'Erase personal').click()
    await expect(dialog(page)).toContainText('Erase your personal shelf?')
    await confirmWith(page, 'Erase personal')
    expect(fs.existsSync(path.join(personal, 'mine.md'))).toBe(false)
  })

  test('Artifacts → Erase all removes both populations and their archive', async ({ page }) => {
    const p = readProfile()
    await openTab(page, 'artifacts')
    const shared = seedShelf(p)
    const personal = await seedPersonal(p)
    await page.reload()
    await expect(page.locator('.acct-card')).toBeVisible({ timeout: 20_000 })

    await rowButton(page, 'Erase all').click()
    await expect(dialog(page)).toContainText('Erase every artifact?')
    await confirmWith(page, 'Erase everything')

    expect(fs.existsSync(path.join(shared, 'keep.md'))).toBe(false)
    expect(fs.existsSync(path.join(shared, '.archive', 'old.md'))).toBe(false)
    expect(fs.existsSync(path.join(personal, 'mine.md'))).toBe(false)
    expect((await callRpc(p, 'artifact.list', { workspace: p.workspace })).items).toEqual([])
  })
})
