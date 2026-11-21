<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DashboardPanel from '@/components/DashboardPanel.vue'
import { hasDesktopBridge } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import {
  countLabel,
  durationLabel,
  initialOf,
  priceLabel,
} from '@/lib/dashboard'
import { hub, toast } from '@/stores/hub'
import { fleet, loadFleet } from '@/stores/fleet'
import {
  dashboardItem,
  loadDashboards,
  readDashboard,
  refreshDashboard,
  saveSchedule,
} from '@/stores/dashboards'

/**
 * One dashboard artifact, read: every panel, per-source status, the pass ring,
 * the schedule and the machine that produced it.
 *
 * Cache-first by construction. Opening this page reads a file; the only action
 * that spends money is `Refresh now`, it names the price before the run, and the
 * main process refuses it on every machine that is not the workspace's executor —
 * a refusal the page repeats in words rather than as a disabled button with no
 * reason.
 */
const props = defineProps({
  /* `:workspace/artifacts/:id` hands the id through the route. */
  id: { type: String, default: '' },
})

const router = useRouter()
const artifactId = computed(() => decodeURIComponent(String(props.id || '')))
const doc = ref(null)
const loading = ref(true)
const missing = ref(false)
const failing = ref('')
const refreshing = ref(false)
const confirmOpen = ref(false)
const shareOpen = ref(false)
const editingSchedule = ref(false)
const scheduleBusy = ref(false)
const scheduleForm = ref({ cadence: 'daily', at: '06:30', grace: '2h', enabled: true })

const item = computed(() => dashboardItem(artifactId.value))
const title = computed(() => doc.value?.title || artifactId.value.split('/').pop() || 'Dashboard')
const state = computed(() => doc.value?.state || 'never')
const panels = computed(() => doc.value?.panels || [])
const sources = computed(() => doc.value?.sources || [])
const stale = computed(() => state.value === 'stale')
const never = computed(() => state.value === 'never' || !doc.value?.snapshot)
const history = computed(() => [...(doc.value?.history || [])].slice(-7).reverse())
const price = computed(() => priceLabel(doc.value))
const workspaceLabel = computed(() => hub.workspaceLabel || hub.workspace || 'this workspace')

/* Spending is the owner's, and only on the machine that actually runs the pass. */
const isOwner = computed(() => hub.session?.role === 'owner')
const machineName = computed(() => String(fleet.hostname || 'this machine').replace(/\.local$/i, ''))
const producedOn = computed(() => item.value?.machine || machineName.value)
/**
 * A pass is a harness turn on this machine and nothing else: a browser tab or a
 * shared server can read the cache and cannot spend. The button says which of the
 * two refusals applies, because "disabled" with no reason is the defect this
 * rule was paid for.
 */
const passRuns = ref(true)
const canRefresh = computed(() => isOwner.value && passRuns.value && !refreshing.value)
const denyReason = computed(() => {
  if (!passRuns.value) return 'A pass is a harness turn, so it runs in the desktop app — not in this tab.'
  if (isOwner.value) return ''
  return `Refreshing spends this workspace's budget and runs as ${doc.value?.producer || 'the producer'}. Ask an owner of ${workspaceLabel.value}, or run it on ${producedOn.value}.`
})

const lastPass = computed(() => history.value[0] || null)
const updatedLine = computed(() => {
  const doc0 = doc.value
  if (!doc0?.snapshot) return 'no pass yet'
  const bits = [
    doc0.asOfLabel,
    lastPass.value?.durationMs ? durationLabel(lastPass.value.durationMs) : '',
    lastPass.value?.cost ? `$${Number(lastPass.value.cost).toFixed(2)}` : '',
    `v${doc0.v}`,
  ]
  return bits.filter(Boolean).join(' · ')
})
const scheduleTitle = computed(() => {
  const schedule = doc.value?.schedule
  if (!schedule) return 'Only when I ask'
  if (schedule.enabled === false) return 'Scheduled pass is off'
  const word = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[schedule.cadence] || 'Daily'
  return schedule.at ? `${word} at ${schedule.at}` : word
})
const budgetLine = computed(() => {
  const cadence = doc.value?.schedule?.cadence || 'daily'
  const perPass = Number(String(price.value).replace(/[^0-9.]/g, '')) || 0.04
  const passes = { daily: 30, weekly: 4, monthly: 1 }[cadence] || 0
  if (!passes) return 'nothing is spent until you ask'
  return `≈ $${(perPass * passes).toFixed(2)} / month at this cadence`
})

async function load({ silent = false } = {}) {
  if (!silent) loading.value = true
  missing.value = false
  try {
    await loadDashboards()
    doc.value = await readDashboard(artifactId.value)
    const schedule = doc.value?.schedule
    if (schedule) scheduleForm.value = { ...schedule }
  } catch (error) {
    /* A file that is gone and a file that cannot be read are different problems:
       the page says which, because the fix is different. */
    if (/no longer exists|not found/i.test(String(error?.message || ''))) missing.value = true
    else failing.value = error?.message || 'The dashboard could not be read.'
    doc.value = null
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  passRuns.value = hasDesktopBridge()
  await load()
  if (!fleet.loaded) loadFleet()
})

/* ── the one action that spends money ─────────────────────────────── */
function askRefresh() {
  if (!canRefresh.value) return
  confirmOpen.value = true
}
function closeRefresh() {
  if (refreshing.value) return
  confirmOpen.value = false
}
useDialogDismiss({ active: () => confirmOpen.value, close: closeRefresh, guard: () => refreshing.value })

function closeShare() {
  shareOpen.value = false
}
useDialogDismiss({ active: () => shareOpen.value, close: closeShare })

async function runRefresh(panel) {
  if (!canRefresh.value) return
  confirmOpen.value = false
  refreshing.value = true
  try {
    /* One panel's Retry and the page's Refresh are the same pass: a source is not
       refreshed on its own, because the producer writes one snapshot. */
    await refreshDashboard(artifactId.value, panel?.source?.id ? { source: panel.source.id } : {})
    await load({ silent: true })
    toast('The pass finished — every panel is from the new snapshot.')
  } catch (error) {
    /* Refused, not failed: the store's sentence names the machine that runs it. */
    toast(error?.message || 'This machine does not run the pass.')
  } finally {
    refreshing.value = false
  }
}

/* ── the schedule: owner-editable, default daily 06:30 ────────────── */
async function saveScheduleForm() {
  if (scheduleBusy.value) return
  scheduleBusy.value = true
  try {
    await saveSchedule(artifactId.value, { ...scheduleForm.value })
    await load({ silent: true })
    editingSchedule.value = false
    toast('Schedule saved.')
  } catch (error) {
    toast(error?.message || 'Could not save the schedule.')
  } finally {
    scheduleBusy.value = false
  }
}

const openConnectors = () =>
  router.push({ name: 'connectors', params: { workspace: hub.workspace } })
const backToArtifacts = () => {
  hub.rail.artifacts = true
  router.push({ name: 'overview', params: { workspace: hub.workspace } })
}
</script>

<template>
  <div class="view dash-page">
    <div v-if="loading" class="empty-note artifact-state">
      <b>Reading {{ artifactId.split('/').pop() }}…</b>
    </div>

    <div v-else-if="missing" class="empty-note artifact-state">
      <b>That dashboard is not in this workspace.</b>
      <span>It may have been removed on disk.</span>
      <button class="btn" type="button" @click="backToArtifacts">Back to the shelf</button>
    </div>

    <div v-else-if="failing" class="empty-note artifact-state">
      <b>{{ failing }}</b>
      <button class="btn" type="button" @click="load()">Try again</button>
    </div>

    <template v-else-if="doc">
      <div class="dash-head">
        <div class="grow">
          <p class="eyebrow">Artifact · dashboard</p>
          <h1>{{ title }}</h1>
          <div class="dash-meta">
            <span class="band-pill" :data-state="state"><span class="dot" aria-hidden="true"></span>{{ state }}</span>
            <span class="band-pill" v-if="doc.schedule"><span class="dot" aria-hidden="true"></span>{{ scheduleTitle }}</span>
            <span class="band-pill">
              <span class="dot" aria-hidden="true"></span>
              {{ item?.scope === 'personal' ? 'private' : 'shared with this workspace' }}
            </span>
            <span class="band-pill" v-if="doc.producer"><span class="dot" aria-hidden="true"></span>producer {{ doc.producer }}</span>
            <span class="meta">{{ updatedLine }} · produced on {{ producedOn }}</span>
          </div>
        </div>
        <div class="dash-actions">
          <button class="btn btn-sm btn-default" type="button" @click="shareOpen = true">Share</button>
          <button
            class="btn btn-sm btn-primary"
            type="button"
            :disabled="!canRefresh"
            :title="isOwner ? `Runs one ${doc.producer || 'producer'} pass now` : denyReason"
            @click="askRefresh"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M13 8a5 5 0 1 1-1.6-3.7" />
              <path d="M13 2.5V5h-2.5" />
            </svg>
            Refresh now <span class="price">≈ {{ price }}</span>
          </button>
        </div>
      </div>

      <div v-if="!canRefresh && !refreshing" class="deny">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
        <div>
          <b>You can read this snapshot, but not refresh it.</b> {{ denyReason }}
        </div>
      </div>

      <p v-if="item?.scope === 'personal'" class="dash-note">
        This machine only — a private dashboard does not sync.
      </p>

      <div v-if="sources.length" class="sources" aria-label="Sources in the last pass">
        <span class="lbl">Sources</span>
        <span v-for="source in sources" :key="source.id" class="src" :data-s="source.status">
          <span class="sq" aria-hidden="true">{{ source.initial || initialOf(source.label) }}</span>
          {{ source.label }}
          <span class="t">
            <template v-if="source.status === 'failed'">failed</template>
            <template v-else>{{ doc.asOfLabel.replace(/^as of /, '') }}</template>
            <template v-if="source.durationMs"> · {{ durationLabel(source.durationMs) }}</template>
          </span>
        </span>
      </div>

      <!-- `never`: one card, one action, no invented zeros. -->
      <div v-if="never && !panels.length" class="empty-panel">
        <span class="ico" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M8 2v4l2.5 1.5" />
            <circle cx="8" cy="8" r="6" />
          </svg>
        </span>
        <h4>No snapshot yet</h4>
        <p>
          <b>{{ doc.producer || 'The producer' }}</b> has not run in this workspace. The first pass reads
          {{ countLabel(sources.length || doc.connectors.length, 'source', 'sources') }} and usually takes under a minute.
        </p>
        <div class="acts">
          <button class="btn btn-sm btn-primary" type="button" :disabled="!canRefresh" @click="askRefresh">
            Run first pass ≈ {{ price }}
          </button>
          <button class="btn btn-sm" type="button" @click="openConnectors">Check connectors</button>
        </div>
      </div>

      <div v-else class="panels">
        <DashboardPanel
          v-for="panel in panels"
          :key="panel.id"
          :panel="panel"
          :loading="refreshing"
          @retry="runRefresh"
        />
      </div>

      <div class="dash-foot">
        <section class="dash-card">
          <div class="row-between">
            <div>
              <p class="eyebrow">Schedule</p>
              <h3>{{ scheduleTitle }}</h3>
            </div>
            <button
              v-if="isOwner"
              class="btn btn-sm"
              type="button"
              @click="editingSchedule = !editingSchedule"
            >
              {{ editingSchedule ? 'Cancel' : 'Edit schedule' }}
            </button>
          </div>
          <div v-if="editingSchedule" class="sched-fields">
            <label>
              cadence
              <select v-model="scheduleForm.cadence">
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
                <option value="manual">only when I ask</option>
              </select>
            </label>
            <label>
              at
              <input v-model="scheduleForm.at" type="time" />
            </label>
            <label>
              grace
              <input v-model="scheduleForm.grace" type="text" placeholder="2h" />
            </label>
            <button class="btn btn-sm btn-primary" type="button" :disabled="scheduleBusy" @click="saveScheduleForm">
              Save
            </button>
          </div>
          <div v-else class="sched-rows">
            <div class="sched-row">
              <span class="k">next run</span>
              <span class="v">{{ doc.schedule?.enabled === false ? 'off' : 'at the next cadence tick' }}</span>
            </div>
            <div class="sched-row">
              <span class="k">grace</span>
              <span class="v">{{ doc.schedule?.grace || '2h' }} — until then this stays <b>fresh</b></span>
            </div>
            <div class="sched-row">
              <span class="k">cadence</span>
              <span class="v">daily · weekly · monthly · only when I ask</span>
            </div>
            <div class="sched-row">
              <span class="k">budget</span>
              <span class="v">{{ budgetLine }}</span>
            </div>
          </div>
        </section>

        <section class="dash-card">
          <div class="row-between">
            <div>
              <p class="eyebrow">Executor</p>
              <h3>{{ producedOn }}</h3>
            </div>
            <span class="band-pill" :data-state="isOwner ? 'fresh' : 'stale'">
              <span class="dot" aria-hidden="true"></span>{{ isOwner ? 'owner' : 'reader' }}
            </span>
          </div>
          <p class="sub">
            Only one machine per workspace runs the pass, or every clone writes the same file and sync fills
            <span class="mono">artifacts/conflicts/</span>. This machine is a reader; it shows the cache.
          </p>
          <div class="sched-rows">
            <div class="sched-row">
              <span class="k">produced</span>
              <span class="v">{{ doc.asOfLabel || 'never' }} on {{ producedOn }}</span>
            </div>
            <div class="sched-row">
              <span class="k">this machine</span>
              <span class="v">{{ machineName }} · {{ isOwner ? 'executor' : 'reader' }}</span>
            </div>
            <div class="sched-row">
              <span class="k">artifact</span>
              <span class="v mono">{{ artifactId }}</span>
            </div>
          </div>
        </section>
      </div>

      <!-- The share dialog says the one thing a person needs before sending a
           dashboard: what travels, and what does not. -->
      <div v-if="shareOpen" class="modal-scrim" @click.self="closeShare">
        <div class="dash-card dash-modal" role="dialog" aria-labelledby="dash-share-h">
          <h3 id="dash-share-h">Share {{ title }}</h3>
          <p class="sub">definitions travel with the workspace; tokens stay on this machine.</p>
          <p v-if="item?.scope === 'personal'" class="sub">This machine only — a private dashboard does not sync.</p>
          <p class="sub">
            {{ doc.local ? 'Private panels are removed on share.' : 'The snapshot travels with the definitions.' }}
          </p>
          <div class="dash-modal-acts">
            <button class="btn btn-sm" type="button" @click="closeShare">Close</button>
          </div>
        </div>
      </div>

      <div v-if="confirmOpen" class="modal-scrim" @click.self="closeRefresh">
        <div class="dash-card dash-modal" role="dialog" aria-labelledby="dash-refresh-h">
          <h3 id="dash-refresh-h">Run one pass now?</h3>
          <p class="sub">
            <b>{{ doc.producer || 'The producer' }}</b> reads
            {{ countLabel(sources.length || doc.connectors.length, 'source', 'sources') }} and writes one
            snapshot. It runs on {{ producedOn }}.
          </p>
          <div class="sched-rows">
            <div class="sched-row"><span class="k">price</span><span class="v">≈ {{ price }}</span></div>
            <div class="sched-row"><span class="k">executor</span><span class="v">{{ producedOn }}</span></div>
            <div class="sched-row"><span class="k">sources</span><span class="v">{{ doc.connectors.join(', ') || 'none named' }}</span></div>
          </div>
          <div class="dash-modal-acts">
            <button class="btn btn-sm" type="button" :disabled="refreshing" @click="closeRefresh">Cancel</button>
            <button class="btn btn-sm btn-primary" type="button" :disabled="refreshing" @click="runRefresh()">
              {{ refreshing ? 'Running…' : `Run for ≈ ${price}` }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
