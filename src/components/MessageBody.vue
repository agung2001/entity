<script setup>
import { computed, onMounted, reactive, watch } from 'vue'
import { downloadArtifact, readArtifact } from '@/stores/artifacts'
import { openArtifactPreview } from '@/stores/hub'
import { hub } from '@/stores/hub'
import { loadProse, proseReady, renderProse } from '@/lib/prose'

/**
 * Assistant text with lightweight media support.
 *
 * The harness is a CLI, not a rich renderer. It can still hand the chat a file:
 * `![alt](artifact://shots/page.png)` or a bare `artifact://shots/page.png`.
 * Artifact ids are resolved through the main process; external image URLs are
 * left as URLs. Everything else stays exactly as the harness wrote it.
 */
const props = defineProps({
  text: { type: String, default: '' },
})

const cache = new Map()
const resolved = reactive({})

/* The ready flag is read here so the plain-text stand-in is replaced the
   moment the parser chunk lands. Parsed HTML is cached in `lib/prose`, one
   entry per distinct reply, so a thread switch re-parses nothing. */
function renderMarkdown(text) {
  void proseReady.value
  return renderProse(text)
}

const TOKEN =
  /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|artifact:\/\/([^\s<>()]+)|(https?:\/\/[^\s<>()]+\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:\?[^\s<>()]*)?)/gi

/* An `artifact://` reference often sits inside a code span, so the token the
   regex finds ends with the closing backtick — and a quoted path ends with a
   quote. Strip the wrapper, or the id names a file that does not exist. */
function stripWrapper(value) {
  return String(value || '')
    .replace(/^[`'"<]+/, '')
    .replace(/[`'">]+$/, '')
    .replace(/[.,;:!?]+$/, '')
}

function decodeId(value) {
  let id = stripWrapper(value)
    /* `![alt](artifact://x)` hands us the whole reference, scheme included. */
    .replace(/^artifact:\/\//i, '')
    .split(/[?#]/)[0]
  try {
    id = decodeURIComponent(id)
  } catch {
    /* keep the raw value */
  }
  /* Agents sometimes paste the absolute path instead of the artifact id. */
  const marker = '/artifacts/'
  const at = id.indexOf(marker)
  if (at >= 0) return id.slice(at + marker.length)
  if (id.startsWith('artifacts/')) return id.slice('artifacts/'.length)
  return id
}

const segments = computed(() => {
  const text = String(props.text || '')
  const out = []
  let last = 0
  TOKEN.lastIndex = 0
  let match
  while ((match = TOKEN.exec(text))) {
    if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) })
    if (match[1] !== undefined) {
      const src = match[2]
      /* An agent may paste the absolute artifact path instead of the scheme.
         Both resolve through the same read RPC. */
      const artifact =
        src.startsWith('artifact://') || (!/^https?:/i.test(src) && src.includes('/artifacts/'))
      out.push({
        type: 'image',
        src,
        alt: match[1] || 'Image',
        artifact,
        id: artifact ? decodeId(src) : '',
      })
    } else if (match[3]) {
      const token = stripWrapper(match[3])
      /* A reference ending in `/` names a folder: there is nothing to preview,
         and asking the reader for it would only fail. Keep the words. */
      if (token.endsWith('/')) {
        out.push({ type: 'text', text: match[0] })
        continue
      }
      const id = decodeId(token)
      out.push({ type: 'image', src: `artifact://${token}`, alt: id, artifact: true, id })
    } else if (match[4]) {
      out.push({ type: 'image', src: match[4], alt: 'Image', artifact: false, id: '' })
    }
    last = match.index + match[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
})

function artifactRefs() {
  const ids = new Set()
  for (const segment of segments.value) {
    if (segment.artifact && segment.id) ids.add(segment.id)
  }
  return [...ids]
}

async function resolve() {
  for (const id of artifactRefs()) {
    if (resolved[id]) continue
    const key = `${hub.workspace}:${id}`
    if (cache.has(key)) {
      resolved[id] = cache.get(key)
      continue
    }
    resolved[id] = { loading: true }
    try {
      const data = await readArtifact(id)
      cache.set(key, { loading: false, ...data })
      resolved[id] = cache.get(key)
    } catch (error) {
      resolved[id] = { loading: false, error: error?.message || 'Artifact not found.' }
    }
  }
}

function imageSource(segment) {
  if (!segment.artifact) return segment.src
  const item = resolved[segment.id]
  return item?.dataUrl || ''
}

function artifactInfo(segment) {
  const item = resolved[segment.id]
  if (!item || item.loading) return { name: segment.id, note: 'Opening…' }
  if (item.error) return { name: segment.id, note: item.error }
  return {
    name: item.name || segment.id,
    note: item.kind === 'text' ? 'text file' : item.mime || 'file',
    data: item,
  }
}

async function download(segment) {
  try {
    const item = await downloadArtifact(segment.id)
    if (!item?.dataUrl) return
    const link = document.createElement('a')
    link.href = item.dataUrl
    link.download = item.name || segment.id.split('/').pop() || 'artifact'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } catch {
    /* the card already says the artifact is unavailable */
  }
}

onMounted(() => {
  loadProse().catch(() => {})
  resolve()
})
watch(() => props.text, resolve)
</script>

<template>
  <div class="msg-body">
    <template v-for="(segment, index) in segments" :key="index">
      <div v-if="segment.type === 'text'" class="msg-md" v-html="renderMarkdown(segment.text)"></div>
      <template v-else>
        <!-- An image an answer points at opens the artifact page: preview,
             actions and the annotator, instead of a dead picture. -->
        <button
          v-if="segment.artifact && resolved[segment.id]?.kind === 'image' && imageSource(segment)"
          class="msg-image-button"
          type="button"
          :title="`Open ${segment.alt}`"
          @click="openArtifactPreview(segment.id)"
        >
          <img
            class="msg-image"
            :src="imageSource(segment)"
            :alt="segment.alt"
            loading="lazy"
            decoding="async"
          />
        </button>
        <img
          v-else-if="!segment.artifact"
          class="msg-image"
          :src="imageSource(segment) || segment.src"
          :alt="segment.alt"
          loading="lazy"
          decoding="async"
        />
        <span v-else class="msg-artifact">
          <span class="msg-artifact-name">{{ artifactInfo(segment).name }}</span>
          <span class="msg-artifact-note">{{ artifactInfo(segment).note }}</span>
          <button
            v-if="resolved[segment.id]?.dataUrl || resolved[segment.id]?.text"
            class="msg-artifact-dl"
            type="button"
            @click="download(segment)"
          >
            Download
          </button>
        </span>
      </template>
    </template>
  </div>
</template>
