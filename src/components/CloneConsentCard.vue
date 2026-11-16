<script setup>
/**
 * A pinned run asked to copy an entity into another workspace.
 *
 * This is not a dialog: it sits on the composer and names the exact content that
 * will be written. The window re-reads the source on Allow, so an edit between
 * the request and the click makes the approval stale instead of publishing
 * something the person did not see.
 */
defineProps({
  request: { type: Object, required: true },
  targetLabel: { type: String, default: '' },
  busy: { type: Boolean, default: false },
})

defineEmits(['allow', 'dismiss'])

const size = (bytes) => {
  const n = Number(bytes || 0)
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}
</script>

<template>
  <div class="clone-consent" role="group" aria-label="Pending entity copy">
    <svg class="cc-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
      <rect x="5.2" y="5.2" width="8" height="8" rx="1" />
      <path d="M10.8 5.2V3.6a1 1 0 00-1-1H3.6a1 1 0 00-1 1v6.2a1 1 0 001 1h1.6" />
    </svg>
    <div class="cc-copy">
      <b>Copy {{ request.name }} into {{ targetLabel || request.to }}?</b>
      <p>
        <span>{{ size(request.bytes) }}</span>
        <span v-if="request.requestedBy">· asked by {{ request.requestedBy }}</span>
        <span v-if="request.summary">· {{ request.summary }}</span>
      </p>
    </div>
    <div class="cc-actions">
      <button class="btn btn-ghost cc-dismiss" type="button" :disabled="busy" @click="$emit('dismiss')">
        Not now
      </button>
      <button class="btn btn-ink" type="button" :disabled="busy" @click="$emit('allow')">
        {{ busy ? 'Copying…' : 'Allow copy' }}
      </button>
    </div>
  </div>
</template>
