import { computed, reactive } from 'vue'
import {
  adoptLynkConfig,
  dropLynkAnswer,
  lynk,
  readDashboard as readLynkDashboard,
  testFolder as testLynkFolder,
} from '@/connectors/lynk/useLynk'
import { lynkConfig, saveLynkConfig } from '@/stores/connectors'

/**
 * Lynk.id's Overview card: the one setting its Dashboard is gated on, and the three
 * verbs beside it.
 *
 * It lived in `ConnectorPageView` — the folder picker's open state, the four
 * handlers, the two derived lines and the sentences they print — which meant the
 * router held one connector's settings form. The card is now its own component
 * (`components/connectors/LynkReportCard.vue`) and this is the state behind it.
 *
 * **The write goes through the store, not straight to the read layer.** The tab's
 * lock is read from `lynkConfig.folderId` (`lynkGate` in `connectors/dashboards`),
 * and the read layer's own `saveFolder` only updated `lynk` — so a folder picked on
 * this page left the gate pointing at the folder that was there before, and the
 * Dashboard stayed locked until a reload. That was the reload bug on this
 * connector: the fix is one write that updates the state the lock is made of, then
 * a mirror into the read layer so the two cannot disagree.
 */
export const reportCard = reactive({
  /* the picker is the folder lock's own answer: activating a locked tab opens it */
  picker: false,
  notice: '',
  error: '',
})

/** What the folder holds, in the shortest form the row can carry. */
export const folderTail = computed(() => {
  const total = lynk.test?.sheets ?? lynk.sheets.total
  return total ? `${total} ${total === 1 ? 'sheet' : 'sheets'}` : 'not read yet'
})

/** What the last `Test folder` actually saw: the read's own numbers, so the card
    and the tab cannot print two different counts of the same folder. */
export const testLine = computed(() => {
  const answer = lynk.test
  if (!answer) return ''
  const seconds = (Number(answer.ms || 0) / 1000).toFixed(1)
  return `${answer.sheets} ${answer.sheets === 1 ? 'spreadsheet' : 'spreadsheets'} · ${answer.withTab} with a ${lynkConfig.sheetSuffix.trim()} tab · ${answer.rows} ${answer.rows === 1 ? 'row' : 'rows'} · read in ${seconds} s`
})

export function openFolderPicker() {
  reportCard.error = ''
  reportCard.picker = true
}

export function closeFolderPicker() {
  reportCard.picker = false
}

/** One folder, written once: the store (which the lock reads), the read layer
    (which the table reads), then the read itself. */
async function point(id, folder) {
  reportCard.error = ''
  reportCard.notice = ''
  try {
    await saveLynkConfig({ folderId: String(folder?.id || ''), folderName: String(folder?.name || '') }, { id })
    adoptLynkConfig(lynkConfig)
    /* The answer on screen belongs to the folder that was read, so it goes with it:
       keeping it is how the previous folder's revenue ends up under the new
       folder's name. */
    dropLynkAnswer()
    lynk.test = null
    return true
  } catch (problem) {
    reportCard.error = String(problem?.message || problem)
    return false
  }
}

export async function chooseFolder(folder, { id = 'lynk' } = {}) {
  reportCard.picker = false
  if (!(await point(id, folder))) return
  reportCard.notice = `Reading ${folder.name}…`
  try {
    await readLynkDashboard({ force: true })
    reportCard.notice = `${folder.name} is the folder this report reads.`
  } catch (problem) {
    reportCard.error = String(problem?.message || problem)
  }
}

export async function testReport() {
  reportCard.error = ''
  reportCard.notice = ''
  try {
    await testLynkFolder()
    if (lynk.testError) throw new Error(lynk.testError)
  } catch (problem) {
    reportCard.error = String(problem?.message || problem)
  }
}

export async function reReadReport() {
  reportCard.error = ''
  try {
    await readLynkDashboard({ force: true })
    reportCard.notice = lynk.error ? lynk.error : `Read ${lynk.sheets.withTab} spreadsheets again.`
  } catch (problem) {
    reportCard.error = String(problem?.message || problem)
  }
}

/** Forget the folder, so the tab locks again and Overview offers the picker. */
export async function forgetReport({ id = 'lynk' } = {}) {
  if (!(await point(id, { id: '', name: '' }))) return
  reportCard.notice = 'The folder is forgotten; the Dashboard is locked until you pick one.'
}
