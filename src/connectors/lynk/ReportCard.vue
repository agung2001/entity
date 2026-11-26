<script setup>
import { onMounted, ref, watch } from 'vue'
import DriveFolderPicker from '@/connectors/lynk/FolderPicker.vue'
import { lynk } from '@/connectors/lynk/useLynk'
import {
  chooseFolder,
  closeFolderPicker,
  folderTail,
  forgetReport,
  openFolderPicker,
  reReadReport,
  reportCard,
  saveMarketplaceUrl,
  testLine,
  testReport,
} from '@/connectors/lynk/useReportCard'
import { lynkConfig, loadLynkConfig } from '@/stores/connectors'

/**
 * Lynk.id's one setting: which Drive folder the report is read from.
 *
 * A card of its own, with its state in `composables/lynkReportCard.js`, because it
 * is a connector's settings form and this repository's connector page is a router.
 * Everything else on it is a fact printed beside the control — the tab suffix, the
 * currency, the zone — because a number without its unit is a number somebody will
 * misread.
 *
 * `Test folder` is its own call, not the page's `Test connection`: a probe answers
 * a status line, and this answers how many spreadsheets were found and how many of
 * them had anything to read. `Re-read now` is `force`. `Forget folder` writes an
 * empty id, which locks the tab again.
 */
defineProps({
  /** The connector's own name, so the heading is the row's, not a second literal. */
  label: { type: String, default: 'Lynk.id' },
})

/* The card reads its own settings.
   
   `lynkConfig` is filled by the Dashboard tab's gate, not by the page — so a person
   who lands on Overview and never opens the Dashboard saw this card's defaults: an
   empty folder where a chosen one was stored, and an empty marketplace over a row
   that has a URL. Reading it here is idempotent (`loaded` guards the second call)
   and it is the only way this card can be right on the tab it lives on. */
onMounted(() => {
  if (!lynkConfig.loaded) loadLynkConfig().catch(() => null)
})

/* The field is edited locally and written on commit, not on every keystroke: a
   half-typed URL is not a setting, and a save per character would re-read the
   folder's links seventy times. */
const draftUrl = ref(lynkConfig.marketplaceUrl)
const saveUrl = () => saveMarketplaceUrl(draftUrl.value)
/* The store is written by this card and adopted elsewhere; a value that arrives
   from a save (or a refused one) is the one the field must show. */
watch(
  () => lynkConfig.marketplaceUrl,
  (next) => (draftUrl.value = next),
)
</script>

<template>
  <section class="cxn-card cxn-report">
    <h2>{{ label }} report</h2>
    <p class="cxn-about-lead">
      One spreadsheet per product, and this folder's <code class="mono">{{ lynkConfig.sheetSuffix }}</code>
      tab is the one read. Change the folder here and the Dashboard follows it —
      no reload, and no second setting anywhere else.
    </p>
    <p class="cxn-about-lead">
      The <b>marketplace</b> is this workspace's own document — a JSON list of
      <code class="mono">{ title, url }</code> per product. It is what the dashboard
      matches a spreadsheet's name against to put a landing link on a row, and what
      it checks a sheet's name against. Leave it empty and no landing link is drawn;
      nothing here names a domain for you, because this app is public and the store
      that reads it is yours.
    </p>
    <div class="cfg">
      <div class="cfg-row">
        <span class="lb">Drive folder</span>
        <button
          type="button"
          class="field"
          data-role="select"
          :aria-label="lynkConfig.folderName ? `Drive folder: ${lynkConfig.folderName}` : 'Choose a Drive folder'"
          @click="openFolderPicker"
        >
          <span class="val">{{ lynkConfig.folderName || (lynkConfig.folderId ? lynkConfig.folderId : 'Pick a folder…') }}</span>
          <span class="tail">{{ folderTail }}</span>
          <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
      <div class="cfg-row">
        <span class="lb">Sheet suffix</span>
        <div class="field-static">
          <code class="mono">{{ lynkConfig.sheetSuffix }}</code>
          <span class="tail">tab name</span>
        </div>
      </div>
      <div class="cfg-row">
        <span class="lb">Marketplace</span>
        <label class="field-input">
          <input
            v-model="draftUrl"
            aria-label="Marketplace document URL"
            type="text"
            placeholder="https://your-store.example.test/marketplace.json"
            autocomplete="off"
            spellcheck="false"
            inputmode="url"
            @change="saveUrl"
            @keydown.enter.prevent="saveUrl"
          />
        </label>
      </div>
      <div class="cfg-row">
        <span class="lb">Currency</span>
        <div class="field-static">
          <span>IDR · Indonesian rupiah</span>
          <span class="tail">no conversion</span>
        </div>
      </div>
      <div class="cfg-row">
        <span class="lb">Time zone</span>
        <div class="field-static">
          <span>{{ lynkConfig.timezone }}</span>
          <span class="tail">for every date</span>
        </div>
      </div>
    </div>
    <div class="cfg-actions">
      <button class="btn btn-primary btn-sm" type="button" :disabled="!lynkConfig.folderId || lynk.testing" @click="testReport">
        {{ lynk.testing ? 'Reading…' : 'Test folder' }}
      </button>
      <button class="btn btn-sm" type="button" :disabled="!lynkConfig.folderId || lynk.reading" @click="reReadReport">
        {{ lynk.reading ? 'Reading…' : 'Re-read now' }}
      </button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!lynkConfig.folderId" @click="forgetReport()">
        Forget folder
      </button>
    </div>
    <!-- What the last test actually saw. The numbers are the read's own, so
         "70 spreadsheets" here and "70 sheets" on the tab cannot disagree. -->
    <div v-if="testLine" class="cfg-test">
      <span class="k">read in {{ (Number(lynk.test?.ms || 0) / 1000).toFixed(1) }} s</span>
      <p>{{ testLine }}</p>
    </div>
    <div v-else-if="lynk.testError" class="cfg-test" data-tone="bad">
      <span class="k">not read</span>
      <p>{{ lynk.testError }}</p>
    </div>
    <div v-if="reportCard.error" class="cxn-error" role="alert">{{ reportCard.error }}</div>
    <div v-else-if="reportCard.notice" class="cxn-ok" role="status">
      <div><b>{{ reportCard.notice }}</b></div>
    </div>

    <!-- The folder lock's answer: one dialog, one job. It lives with the card
         because the card is what opens it, and a lock with its own modal is the
         shortest path from "what is it waiting for" to a folder. -->
    <DriveFolderPicker
      v-if="reportCard.picker"
      :folder-id="lynkConfig.folderId"
      @close="closeFolderPicker"
      @pick="chooseFolder($event)"
    />
  </section>
</template>
