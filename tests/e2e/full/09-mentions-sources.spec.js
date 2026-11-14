import path from 'node:path'
import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'
import { newestPrompt } from '../helpers/profile.js'
import { callRpc } from '../helpers/rpc.js'

/**
 * UAT E06–E08 — the sources behind the `@` menu, discovered at run time.
 *
 * Orca is local and needs no credentials. YouTrack and Maka use the user's
 * global harness MCP config through `mcpStore.globals()`; set
 * E2E_MCP_GLOBAL=1 to allow those network calls. Nothing is copied into the
 * repository, and only names/ids appear in assertions.
 */
test.describe('mention sources', () => {
  test('@orca resolves a real project file to an absolute path', async ({ page }) => {
    const profile = readProfile()
    const sources = await callRpc(profile, 'mention.sources', {})
    const project = sources?.orca?.[0]
    test.skip(!project, 'no Orca project is available on this machine')

    const listing = await callRpc(profile, 'mention.search', {
      workspace: profile.workspace,
      kind: 'orca',
      fields: [project.name, ''],
      limit: 5,
      offset: 0,
    })
    const insert = listing.items?.[0]?.insert
    test.skip(!insert, `${project.name} has no selectable file`)

    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, `E2E-ORCA read this @orca:${project.name}:${insert.split(':').slice(2).join(':')}`)
    await waitForAnswer(page, 'E2E-STUB-OK')

    const rel = insert.split(':').slice(2).join(':')
    const prompt = newestPrompt(profile)
    expect(prompt).toContain('Resolved mentions')
    expect(prompt).toContain(path.join(project.path, rel))
  })

  test('@youtrack resolves issues in a real project', async ({ page }) => {
    test.skip(process.env.E2E_MCP_GLOBAL !== '1', 'set E2E_MCP_GLOBAL=1 to call YouTrack')
    const profile = readProfile()

    let project = ''
    try {
      const projects = await callRpc(profile, 'mention.search', {
        workspace: profile.workspace,
        kind: 'youtrack',
        fields: [],
        limit: 5,
        offset: 0,
      })
      project = String(projects.items?.[0]?.insert || '').match(/^@youtrack:([^:]+):$/)?.[1] || ''
    } catch (error) {
      test.skip(true, `YouTrack is not reachable: ${String(error.message).slice(0, 120)}`)
    }
    test.skip(!project, 'no YouTrack project is available')
    const key = project

    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, `E2E-YOUTRACK list issues @youtrack:${key}:`)
    await waitForAnswer(page, 'E2E-STUB-OK')

    const prompt = newestPrompt(profile)
    expect(prompt).toContain('Resolved mentions')
    expect(prompt).toMatch(new RegExp(`@youtrack:${key} .*${key}-\\d+`))
    expect(prompt).not.toContain('found no issue')
  })

  test('@maka resolves notes in a real vault', async ({ page }) => {
    test.skip(process.env.E2E_MCP_GLOBAL !== '1', 'set E2E_MCP_GLOBAL=1 to call Maka')
    const profile = readProfile()

    let vault = ''
    let word = ''
    try {
      const vaults = await callRpc(profile, 'mention.search', {
        workspace: profile.workspace,
        kind: 'maka',
        fields: [],
        limit: 5,
        offset: 0,
      })
      vault = String(vaults.items?.[0]?.insert || '').match(/^@maka:([^:]+):$/)?.[1] || ''
      if (vault) {
        const notes = await callRpc(profile, 'mention.search', {
          workspace: profile.workspace,
          kind: 'maka',
          fields: [vault, ''],
          limit: 5,
          offset: 0,
        })
        const label = String(notes.items?.[0]?.label || '')
        const file = label.includes(' · ') ? label.split(' · ').slice(1).join(' · ') : label
        word = path.basename(file).replace(/\.[^.]+$/, '').split(/[^A-Za-z0-9]+/).find((part) => part.length >= 4) || ''
      }
    } catch (error) {
      test.skip(true, `Maka is not reachable: ${String(error.message).slice(0, 120)}`)
    }
    test.skip(!vault || !word, `no searchable note in ${vault || 'any vault'}`)
    const selected = { vault, word }

    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, `E2E-MAKA find notes @maka:${selected.vault}:${selected.word}`)
    await waitForAnswer(page, 'E2E-STUB-OK')

    const prompt = newestPrompt(profile)
    expect(prompt).toContain('Resolved mentions')
    expect(prompt).toContain(`@maka:${selected.vault}`)
    expect(prompt).not.toContain('nothing found')
  })
})
