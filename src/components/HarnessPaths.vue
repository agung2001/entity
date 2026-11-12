<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { toast } from '@/stores/hub'
import { harnesses, loadHarnesses, loadModels, setHarnessPath } from '@/stores/harnesses'

/**
 * The five CLIs are usually found on PATH. This panel exists for the ones that
 * are not: a version manager, a custom prefix, or an app bundle. The override
 * is machine-wide because the binary is a property of the machine, not of an
 * entity or a workspace.
 */
const props = defineProps({
  active: { type: String, default: '' },
})
const draft = reactive({})
const busy = ref('')

onMounted(() => {
  loadHarnesses().catch(() => {})
})

watch(
  () => harnesses.items,
  (items) => {
    for (const item of items) {
      if (busy.value === item.id) continue
      draft[item.id] = item.customPath || ''
    }
  },
  { immediate: true, deep: true },
)

const item = computed(
  () =>
    harnesses.items.find((entry) => entry.id === props.active) ||
    harnesses.items[0] ||
    null,
)

async function save(item, value = draft[item.id]) {
  if (busy.value) return
  busy.value = item.id
  try {
    await setHarnessPath(item.id, value)
    draft[item.id] = value
    loadModels(item.id, true).catch(() => {})
    toast(value ? `${item.label} path saved` : `${item.label} will use PATH`)
  } catch (error) {
    toast(error?.message || `${item.label} path could not be saved.`)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <details class="harness-paths" open>
    <summary>
      <span>Harness path</span>
      <span class="harness-paths-count">{{ item?.label || 'detecting…' }}</span>
      <span v-if="harnesses.loading" class="mnote">checking…</span>
    </summary>
    <p class="mnote">
      Machine-wide. Leave the field blank to use the first executable found on
      <code class="mono">PATH</code>.
    </p>
    <div v-if="harnesses.error" class="acct-error" role="alert">{{ harnesses.error }}</div>
    <div v-if="item" class="harness-path-row">
      <HarnessIcon :name="item.id" :size="14" />
      <div class="harness-path-main">
        <b>{{ item.label }}</b>
        <span class="mono" :title="item.path || item.command">
          {{ item.path || `${item.command} · not found` }}
        </span>
      </div>
      <span class="state" :data-s="item.installed ? 'ok' : 'fail'">
        <i></i>{{ item.installed ? 'found' : 'missing' }}
      </span>
      <input
        v-model="draft[item.id]"
        class="acct-input harness-path-input mono"
        type="text"
        :placeholder="item.path || 'auto-detected path'"
        spellcheck="false"
        :disabled="busy === item.id"
        :aria-label="`${item.label} executable path`"
        @keydown.enter.prevent="save(item)"
      />
      <button
        class="btn btn-sm"
        type="button"
        :disabled="Boolean(busy) || !draft[item.id]"
        @click="save(item)"
      >
        {{ busy === item.id ? 'Saving…' : 'Save' }}
      </button>
      <button
        v-if="item.custom"
        class="btn btn-sm btn-ghost"
        type="button"
        :disabled="Boolean(busy)"
        @click="save(item, '')"
      >
        Use PATH
      </button>
    </div>
    <p v-if="!harnesses.items.length && !harnesses.loading" class="mnote">
      No harness information yet.
    </p>
  </details>
</template>
