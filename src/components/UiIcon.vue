<script setup>
/**
 * The iconoir glyphs this app uses, in the app's own idiom.
 *
 * `MachineIcon` and `HarnessIcon` inline their paths and take a `size`; this does
 * the same, for four drawings copied out of iconoir (MIT — see
 * `./icons/LICENSE.iconoir.md`). Vendored rather than imported as a package: the
 * repo already vendors its marks from `thesvg.org`, and four 24 × 24 files are
 * not worth the first runtime dependency added for markup alone.
 *
 * Why these four and not hand-drawn arrows — the set that shipped before was
 * wrong, twice over: a broken arc for *reload*, and then a *table grid* and a
 * smaller grid for two different "forget" actions, so the same page promised to
 * delete a table and to discard a snapshot with drawings a pixel apart. Each
 * glyph here means exactly one thing on this page:
 *
 *   refresh         read the source again
 *   refresh-double  every machine, re-scanned together
 *   scanning        one host, read
 *   nav-arrow-right open one machine's page
 *   trash           discard this copy's snapshot — and nothing on disk
 *
 * The geometry is iconoir's own (24 × 24, `stroke-width: 1.5`, round joins); it
 * is copied verbatim so the files beside this component stay the upstream
 * drawings its licence names.
 */
const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 13 },
})

/* One entry per glyph, as paths rather than a rewritten SVG file: the stroke,
   the caps and the size belong to the caller, not to the drawing. */
const GLYPHS = {
  refresh: [
    'M21.8883 13.5C21.1645 18.3113 17.013 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C16.1006 2 19.6248 4.46819 21.1679 8',
    'M17 8H21.4C21.7314 8 22 7.73137 22 7.4V3',
  ],
  'refresh-double': [
    'M21.1679 8C19.6247 4.46819 16.1006 2 11.9999 2C6.81459 2 2.55104 5.94668 2.04932 11',
    'M17 8H21.4C21.7314 8 22 7.73137 22 7.4V3',
    'M2.88146 16C4.42458 19.5318 7.94874 22 12.0494 22C17.2347 22 21.4983 18.0533 22 13',
    'M7.04932 16H2.64932C2.31795 16 2.04932 16.2686 2.04932 16.6V21',
  ],
  scanning: [
    'M6 3H3V6',
    'M2 12H12L22 12',
    'M9 19V17V15',
    'M12 16V15.5V15',
    'M15 17V16V15',
    'M12 21V19.5V18',
    'M18 3H21V6',
    'M6 21H3V18',
    'M18 21H21V18',
  ],
  'nav-arrow-right': [
    'M9 6L15 12L9 18',
  ],
  trash: [
    'M20 9L18.005 20.3463C17.8369 21.3026 17.0062 22 16.0353 22H7.96474C6.99379 22 6.1631 21.3026 5.99496 20.3463L4 9',
    'M21 6L15.375 6M3 6L8.625 6M8.625 6V4C8.625 2.89543 9.52043 2 10.625 2H13.375C14.4796 2 15.375 2.89543 15.375 4V6M8.625 6L15.375 6',
  ],
}

const paths = () => GLYPHS[String(props.name)] || []
</script>

<template>
  <svg
    class="ui-icon"
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="d in paths()" :key="d" :d="d" />
  </svg>
</template>
