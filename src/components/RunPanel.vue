<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { toast } from '@/stores/hub'
import { cancelRun, liveFor, runs, startRun } from '@/stores/runs'

/**
 * The Run tab: one real harness process, with the prompt on stdin and the
 * working directory taken from the entity file. The output you see is the child
 * process's own stdout/stderr, streamed and appended to the workspace log.
 */
const props = defineProps({ entity: { type: Object, required: true } })

const prompt = ref('')
const error = ref('')
const tail = ref(null)

const live = computed(() => liveFor(props.entity.name))
const running = computed(() => live.value?.status === 'running')
const output = computed(() => (live.value?.chunks || []).map((chunk) => chunk.text).join(''))

const missingDir = computed(() =>
  (props.entity.problems || []).find((problem) => problem.startsWith('dir ')),
)

watch(
  () => output.value,
  async () => {
    await nextTick()
    if (tail.value) tail.value.scrollTop = tail.value.scrollHeight
  },
)

async function run() {
  if (running.value || runs.starting) return
  error.value = ''
  try {
    await startRun({ name: props.entity.name, prompt: prompt.value })
    prompt.value = prompt.value.trim() ? '' : prompt.value
  } catch (problem) {
    error.value = problem?.message || 'The run could not start.'
  }
}

async function stop() {
  if (!live.value) return
  try {
    await cancelRun(live.value.runId)
  } catch (problem) {
    toast(problem?.message || 'Cancel failed')
  }
}
</script>

<template>
  <div class="runbox">
    <p v-if="missingDir" class="run-warn">
      {{ missingDir }} — fix the <code class="mono">dir:</code> line in the file before running.
    </p>

    <textarea
      v-model="prompt"
      class="run-prompt"
      rows="4"
      :disabled="running || runs.starting"
      placeholder="What should this entity do? e.g. run the test suite and report failures"
      spellcheck="false"
    ></textarea>

    <div class="run-actions">
      <button
        class="btn btn-ink"
        type="button"
        :disabled="running || runs.starting || !prompt.trim() || Boolean(missingDir)"
        @click="run"
      >
        {{ runs.starting ? 'Starting…' : running ? 'Running…' : 'Run' }}
      </button>
      <button v-if="running" class="btn" type="button" @click="stop">
        {{ runs.cancelling ? 'Stopping…' : 'Cancel' }}
      </button>
    </div>

    <div v-if="live" class="run-out">
      <div class="run-out-head">
        <span class="mono">{{ live.runId }}</span>
        <span>{{ live.entity }} · {{ live.harness }}</span>
      </div>
      <pre ref="tail" class="run-tail">{{ output || 'Waiting for output…' }}</pre>
      <p v-if="live.error" class="run-warn">{{ live.error }}</p>
    </div>
    <p v-else-if="error" class="run-warn">{{ error }}</p>
    <p v-else-if="runs.error" class="run-warn">{{ runs.error }}</p>
  </div>
</template>
