<script setup>
import { computed } from 'vue'

/**
 * The glyph for one artifact's *type*, not for "artifact".
 *
 * A shelf row that lists a PNG, an HTML mock-up and a Markdown note with the same
 * page icon makes the reader open each one to tell them apart. The type is
 * already on the item (`kind` from `artifact-store.kindFor`, plus `ext`), so the
 * row can say it before the click.
 *
 * Deliberately its own component rather than another `NavIcon` name: `NavIcon` is
 * the navigation registry (chat, artifact, mcp, skill …) and this is a file-type
 * axis — different question, different set.
 */
const props = defineProps({
  kind: { type: String, default: '' },
  ext: { type: String, default: '' },
})

/* Code files are `text` on the shelf, so the extension refines the kind. */
const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.py', '.sh', '.json', '.jsonl', '.yaml', '.yml'])

const name = computed(() => {
  const kind = String(props.kind || '')
  const ext = String(props.ext || '').toLowerCase()
  if (kind === 'dashboard') return 'dashboard'
  if (kind === 'image') return 'image'
  if (ext === '.html' || ext === '.htm') return 'page'
  if (kind === 'pdf') return 'pdf'
  if (kind === 'audio' || kind === 'video') return 'play'
  if (kind === 'archive') return 'archive'
  if (kind === 'text') return CODE_EXT.has(ext) ? 'code' : 'doc'
  return 'file'
})
</script>

<template>
  <svg v-if="name === 'dashboard'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.4" />
    <path d="M1.8 5.8h12.4" />
    <path d="M4.6 12V8.9M8 12V7.2M11.4 12V9.8" />
  </svg>
  <svg v-else-if="name === 'image'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <rect x="1.7" y="2.6" width="12.6" height="10.8" rx="1.6" />
    <circle cx="5.6" cy="6.4" r="1.2" />
    <path d="M2.4 11.6l3.4-3.6 2.6 2.4 2.3-2.6 3 3.4" />
  </svg>
  <svg v-else-if="name === 'page'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M3 2.4h6l4 4v7.2H3z" />
    <path d="M9 2.4v4h4" />
    <path d="M6.2 8.6L4.8 10l1.4 1.4M9.8 8.6L11.2 10l-1.4 1.4" />
  </svg>
  <svg v-else-if="name === 'code'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M5.6 4.6L2.6 8l3 3.4M10.4 4.6L13.4 8l-3 3.4" />
    <path d="M8.9 3.4l-1.8 9.2" />
  </svg>
  <svg v-else-if="name === 'doc'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M3 2.4h6l4 4v7.2H3z" />
    <path d="M9 2.4v4h4M5.4 9.2h5.2M5.4 11.4h3.4" />
  </svg>
  <svg v-else-if="name === 'pdf'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M3 2.4h6l4 4v7.2H3z" />
    <path d="M9 2.4v4h4" />
    <path d="M5.2 12.2V8.8h1.3a1 1 0 010 2H5.2M8.2 12.2V8.8h1a1.7 1.7 0 010 3.4z" stroke-width="1.1" />
  </svg>
  <svg v-else-if="name === 'play'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <rect x="1.7" y="2.6" width="12.6" height="10.8" rx="1.6" />
    <path d="M6.6 5.6l4 2.4-4 2.4z" />
  </svg>
  <svg v-else-if="name === 'archive'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M1.8 3.4h12.4v2.6H1.8zM2.8 6v7.6h10.4V6" />
    <path d="M6.4 8.6h3.2" />
  </svg>
  <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M3 2.4h6l4 4v7.2H3z" />
    <path d="M9 2.4v4h4" />
  </svg>
</template>
