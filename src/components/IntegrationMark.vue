<script setup>
import { computed, ref } from 'vue'
import makaMark from '@/assets/connectors/maka.png'
import habitifyMark from '@/assets/connectors/habitify.png'

/**
 * The shipped marks, at the row's 22 px.
 *
 * Orca has no mark in the icon library, and its own app icon is the only thing a
 * person recognises — so it is the real bundle icon from the project's own
 * repository, served through jsDelivr and pinned to a release tag rather than a
 * branch. A machine with no network shows the fallback glyph instead of a broken
 * image: the row still reads, because the name next to it is the label.
 *
 * Maka's own app icon is bundled (`src/assets/connectors/maka.png`, from the
 * app's `images/icon.png`) rather than fetched: it is a built-in connector, so
 * the mark has to be there with no network at all. Habitify's is bundled for the
 * same reason (`src/assets/connectors/habitify.png`).
 *
 * YouTrack and `gh` are drawn from `thesvg.org` (its `youtrack` mark and the
 * GitHub mono mark), inlined so the page keeps zero external assets beyond the
 * one Orca icon. GitHub's mark is `currentColor`, so the row can mute it;
 * YouTrack's is a fixed brand palette, so muting is opacity.
 *
 * Fitbit is inlined for the same reason and is the only mark drawn from its
 * initials rather than its wordmark: the shipped logo is a diamond of dots, which
 * is a dozen circles and no image asset at all.
 */
defineProps({
  name: { type: String, default: '' },
  size: { type: [Number, String], default: 22 },
})

/* jsDelivr resolves this repository from a tag but refuses a commit sha (the
   repo is over the package-size limit), so the tag is the pin. */
const ORCA_ICON =
  'https://cdn.jsdelivr.net/gh/stablyai/orca@v1.4.264/resources/build/icon.png'

const failed = ref(false)
const showOrcaIcon = computed(() => !failed.value)
</script>

<template>
  <img
    v-if="name === 'orca' && showOrcaIcon"
    class="int-mark-img"
    :src="ORCA_ICON"
    :width="size"
    :height="size"
    alt=""
    aria-hidden="true"
    decoding="async"
    referrerpolicy="no-referrer"
    @error="failed = true"
  />

  <img
    v-else-if="name === 'maka'"
    class="int-mark-img"
    :src="makaMark"
    :width="size"
    :height="size"
    alt=""
    aria-hidden="true"
    decoding="async"
  />

  <img
    v-else-if="name === 'habitify'"
    class="int-mark-img"
    :src="habitifyMark"
    :width="size"
    :height="size"
    alt=""
    aria-hidden="true"
    decoding="async"
  />

  <!-- Lynk.id is a wordmark and a glyph, and only the glyph survives at 22 px: the
       lettering is `#E8F5F2` (near-white), so on `--bg` it disappears entirely — 174
       px of a 2280 px drawing differ. So the row shows the glyph alone, cropped by
       its own box, on `.mk-tile`'s 14 % brand wash; the wordmark is used once, on the
       hero's `#0d1512` plate, where the lettering is the point. -->
  <svg
    v-else-if="name === 'lynk'"
    class="int-mark-svg int-mark-brand int-mark-lynk"
    :width="size"
    :height="(size * 17) / 12.65"
    viewBox="50.6 7 12.65 17"
    aria-hidden="true"
  >
    <title>Lynk.id</title>
    <path
      fill="#00bb79"
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M56.9181 8.26221C59.8583 8.26221 62.2414 10.4467 62.2414 13.1407V22.2254C62.2414 23.2056 61.3741 23.9999 60.3051 23.9999H53.5312C52.4616 23.9999 51.5949 23.2056 51.5949 22.2254V13.1407C51.5949 10.4467 53.978 8.26221 56.9181 8.26221Z"
    />
  </svg>

  <svg
    v-else-if="name === 'youtrack'"
    class="int-mark-svg int-mark-brand"
    :width="size"
    :height="size"
    viewBox="0 0 256 256"
    aria-hidden="true"
  >
    <title>YouTrack</title>
    <defs>
      <linearGradient id="int-yt-mark" x1="65.797%" x2="2.105%" y1="66.687%" y2="5.574%">
        <stop offset="0%" stop-color="#905cfb" />
        <stop offset="7%" stop-color="#a554e6" />
        <stop offset="25%" stop-color="#d641b5" />
        <stop offset="39%" stop-color="#f43597" />
        <stop offset="47%" stop-color="#ff318c" />
      </linearGradient>
    </defs>
    <path
      fill="#0cb0f2"
      d="M83.61 98.195c42.346-38.629 89.39-81.692 90.752-83.054a63.5 63.5 0 0 1 6.8-6c17.868-13.169 42.523-12 59.066 2.8c16.542 14.802 20.435 39.176 9.326 58.393a44 44 0 0 1-7.4 9.6c-9.398 9.398-45.394 47.594-45.394 47.594s47.194 45.394 47.994 45.994c11.696 9.369 14.684 25.931 7 38.796a30.9 30.9 0 0 1-20.998 14.398c-2.598.459-36.915-32.57-74.812-59.294c-23.958 26.878-71.622 80.332-71.771 80.332c-20.238 14.158-44.995 6.36-56.194.2a56.433 56.433 0 0 1-9.399-90.59c6.6-5.999 34.596-31.396 64.993-59.193z"
    />
    <path
      fill="url(#int-yt-mark)"
      d="M167.802 111.988a36.35 36.35 0 0 0-13.869-23.61L80.22 13.785a46.977 46.977 0 1 0-60.926 71.148l88.984 62.129a37.157 37.157 0 0 0 59.524-35.073"
    />
    <path d="M47.855 48.763h159.382v159.382H47.855z" />
    <path
      fill="#fff"
      d="M63.992 175.87h58.374v10.56H63.992zm21.317-63.952L58.414 69.682h17.93L93.08 97.773l16.935-28.09h17.492l-26.896 42.036v27.892H85.27v-27.693zm65.746-28.09h-21.318V69.681h57.776v14.145h-21.118v55.585h-15.34z"
    />
  </svg>

  <svg
    v-else-if="name === 'fitbit'"
    class="int-mark-svg int-mark-brand"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <title>Fitbit</title>
    <g fill="#00B0B9">
      <circle cx="12" cy="3" r="1.7" />
      <circle cx="8" cy="7" r="1.7" />
      <circle cx="12" cy="7" r="1.7" />
      <circle cx="16" cy="7" r="1.7" />
      <circle cx="4" cy="11" r="1.7" />
      <circle cx="8" cy="11" r="1.7" />
      <circle cx="12" cy="11" r="1.7" />
      <circle cx="16" cy="11" r="1.7" />
      <circle cx="20" cy="11" r="1.7" />
      <circle cx="8" cy="15" r="1.7" />
      <circle cx="12" cy="15" r="1.7" />
      <circle cx="16" cy="15" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </g>
  </svg>

  <svg
    v-else-if="name === 'github'"
    class="int-mark-svg int-mark-mono"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <title>GitHub</title>
    <path
      d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
    />
  </svg>

  <!-- the four account-bearing connectors: same source, same inlining as the two
       above. `x` is the mono mark, so a row can mute it like GitHub's. -->
  <svg
    v-else-if="name === 'gmail'"
    class="int-mark-svg int-mark-brand"
    :width="size"
    :height="size"
    viewBox="0 49.4 512 399.42"
    aria-hidden="true"
  >
    <title>Gmail</title>
    <g fill="none" fill-rule="evenodd">
      <g fill-rule="nonzero">
        <path fill="#4285f4" d="M34.91 448.818h81.454V251L0 163.727V413.91c0 19.287 15.622 34.91 34.91 34.91z" />
        <path fill="#34a853" d="M395.636 448.818h81.455c19.287 0 34.909-15.622 34.909-34.909V163.727L395.636 251z" />
        <path fill="#fbbc04" d="M395.636 99.727V251L512 163.727v-46.545c0-43.142-49.25-67.782-83.782-41.891z" />
      </g>
      <path fill="#ea4335" d="M116.364 251V99.727L256 204.455 395.636 99.727V251L256 355.727z" />
      <path fill="#c5221f" fill-rule="nonzero" d="M0 117.182v46.545L116.364 251V99.727L83.782 75.291C49.25 49.4 0 74.04 0 117.18z" />
    </g>
  </svg>

  <svg
    v-else-if="name === 'google-drive'"
    class="int-mark-svg int-mark-brand"
    :width="size"
    :height="size"
    viewBox="0 0 87.3 78"
    aria-hidden="true"
  >
    <title>Google Drive</title>
    <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" />
    <path fill="#00ac47" d="M43.65 25 29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44A9.06 9.06 0 0 0 0 53h27.5z" />
    <path fill="#ea4335" d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.1 57.5c.8-1.4 1.2-2.95 1.2-4.5H59.798l5.852 11.5z" />
    <path fill="#00832d" d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
    <path fill="#2684fc" d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
    <path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 53h27.45c0-1.55-.4-3.1-1.2-4.5z" />
  </svg>

  <!-- Google's own 200×200 calendar glyph: seven paths, and the only colour in
       the hero the app does not own. The brand hexes are Google's, printed here
       rather than in `tokens.css`, because they are not this app's palette. -->
  <svg
    v-else-if="name === 'google-calendar'"
    class="int-mark-svg int-mark-brand"
    :width="size"
    :height="size"
    viewBox="0 0 200 200"
    aria-hidden="true"
  >
    <title>Google Calendar</title>
    <path fill="#fff" d="M152.63 47.37H47.37v105.26h105.26z" />
    <path fill="#ea4335" d="M152.63 200l47.37-47.37h-47.37z" />
    <path fill="#fbbc04" d="M200 47.37h-47.37v105.26H200z" />
    <path fill="#34a853" d="M152.63 152.63H47.37V200h105.26z" />
    <path fill="#188038" d="M0 152.63v28.42A19 19 0 0 0 18.95 200h28.42v-47.37z" />
    <path fill="#1967d2" d="M200 47.37V18.95A18.95 18.95 0 0 0 181.05 0h-28.42v47.37z" />
    <path fill="#4285f4" d="M152.63 0H18.95A18.95 18.95 0 0 0 0 18.95v133.68h47.37V47.37h105.26z" />
  </svg>

  <svg
    v-else-if="name === 'youtube'"
    class="int-mark-svg int-mark-brand"
    :width="size"
    :height="size"
    viewBox="0 0 256 180"
    aria-hidden="true"
  >
    <title>YouTube</title>
    <path
      fill="red"
      d="M250.346 28.075A32.18 32.18 0 0 0 227.69 5.418C207.824 0 127.87 0 127.87 0S47.912.164 28.046 5.582A32.18 32.18 0 0 0 5.39 28.24c-6.009 35.298-8.34 89.084.165 122.97a32.18 32.18 0 0 0 22.656 22.657c19.866 5.418 99.822 5.418 99.822 5.418s79.955 0 99.82-5.418a32.18 32.18 0 0 0 22.657-22.657c6.338-35.348 8.291-89.1-.164-123.134Z"
    />
    <path fill="#FFF" d="m102.421 128.06 66.328-38.418-66.328-38.418z" />
  </svg>

  <!-- YouTube Studio is the same brand as YouTube; it wears the same mark so a
       person reads the provider, and the chip's label carries "Studio". -->
  <svg
    v-else-if="name === 'youtube-studio'"
    class="int-mark-svg int-mark-brand"
    :width="size"
    :height="size"
    viewBox="0 0 256 180"
    aria-hidden="true"
  >
    <title>YouTube Studio</title>
    <path
      fill="red"
      d="M250.346 28.075A32.18 32.18 0 0 0 227.69 5.418C207.824 0 127.87 0 127.87 0S47.912.164 28.046 5.582A32.18 32.18 0 0 0 5.39 28.24c-6.009 35.298-8.34 89.084.165 122.97a32.18 32.18 0 0 0 22.656 22.657c19.866 5.418 99.822 5.418 99.822 5.418s79.955 0 99.82-5.418a32.18 32.18 0 0 0 22.657-22.657c6.338-35.348 8.291-89.1-.164-123.134Z"
    />
    <path fill="#FFF" d="m102.421 128.06 66.328-38.418-66.328-38.418z" />
  </svg>

  <svg
    v-else-if="name === 'x'"
    class="int-mark-svg int-mark-mono"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <title>X</title>
    <path
      d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"
    />
  </svg>

  <!-- Clockify and Open Design are both from `thesvg.org`, inlined like the marks
       above. Clockify's is the brand palette, so muting is opacity; Open Design's is
       a flat mono drawing, so it takes `currentColor` and the row can mute it like
       GitHub's. -->
  <svg
    v-else-if="name === 'clockify'"
    class="int-mark-svg int-mark-brand"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <title>Clockify</title>
    <path
      fill="#03a9f4"
      d="M13.3512 20.4035c1.1108 0 2.169-.2217 3.139-.6157l2.6913 2.6944C17.4555 23.4458 15.4688 24 13.3512 24 6.729 24 1.3594 18.627 1.3594 12.0006 1.3594 5.3729 6.7289 0 13.3512 0c2.0964 0 4.0652.5406 5.7789 1.4865L16.4834 4.136c-.9687-.3918-2.0236-.6134-3.1322-.6134-4.6379 0-8.3976 3.779-8.3976 8.441 0 4.6609 3.7597 8.4399 8.3976 8.4399zm2.176-12.1544l5.5104-5.5139 1.5773 1.5772-5.5104 5.514zm-2.2328 5.6348c-1.0784 0-1.952-.8775-1.952-1.961 0-1.0825.8736-1.9611 1.952-1.9611 1.0784 0 1.952.8786 1.952 1.961 0 1.0836-.8736 1.9611-1.952 1.9611zm9.3462 5.6953l-1.5772 1.5783-5.5105-5.514 1.5774-1.5783z"
    />
  </svg>

  <svg
    v-else-if="name === 'open-design'"
    class="int-mark-svg int-mark-mono"
    :width="size"
    :height="size"
    viewBox="0 0.727 82 82"
    aria-hidden="true"
  >
    <title>Open Design</title>
    <path
      fill="currentColor"
      d="M41 .727c35.575 0 41 5.424 41 41s-5.425 41-41 41-41-5.425-41-41 5.425-41 41-41m-.11 15.699c-13.974 0-25.302 11.328-25.302 25.303v21.936a3.36 3.36 0 0 0 3.366 3.366h21.937c13.974 0 25.302-11.328 25.302-25.303 0-13.974-11.328-25.302-25.302-25.302m0 5.06c11.18 0 20.243 9.063 20.243 20.242S52.07 61.971 40.89 61.971s-20.242-9.063-20.243-20.242S29.71 21.486 40.89 21.486m-8.245 10.769c-.653-.252-1.295.392-1.045 1.049l7.715 20.3c.32.843 1.562.612 1.562-.29v-11.63h11.788c.895 0 1.126-1.247.29-1.57z"
    />
  </svg>

  <!-- Tailscale's own 24×24 mark, mono like GitHub's and Open Design's: the row
       muting it is opacity, and `heroColorFor('tailscale')` (Sky, `#8db6ed`) is
       already the hero colour, so the connector needs no second colour source. -->
  <svg
    v-else-if="name === 'tailscale'"
    class="int-mark-svg int-mark-mono"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <title>Tailscale</title>
    <path
      fill="currentColor"
      d="M24 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm-9 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm0-9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm6-6a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 24a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm18 .5a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm9-9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm-3 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 3a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM3 5.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"
    />
  </svg>

  <!-- the offline fallback for Orca: a terminal glyph, so the row never shows a
       broken image and the label beside it stays the thing you read -->
  <svg
    v-else
    class="int-mark-svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
    <path d="M6.8 9.6 9.9 12.2 6.8 14.8M12.4 15h4.4" />
  </svg>
</template>
