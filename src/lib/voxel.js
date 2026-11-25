/**
 * The specimen sheet's silhouettes, on the mark's own grid.
 *
 * `entityMark.js` owns the character: a 9 × 9 field of square cells standing on
 * two shaded depth layers, with eyes, blinks and a gaze. A page ornament is the
 * same drawing without the animation loop — a station, a drone, an energy blade,
 * one flat fill per light angle, no path and no request.
 *
 * The masks are the sheet's own (`entity-mark-variations.html`), hand-drawn
 * rather than vector paths: a missing pixel is as meaningful as a filled one, so
 * a station's solar wings and a drone's rotor gaps survive the size change. They
 * are 9 × 9 like the character's, so the eyes land at the same row and the same
 * two columns and every ornament reads as the same species.
 */
const U = 4
const N = 9

/* Row 3 is the eye row on every 9-wide mask, and the eyes sit at columns 2 and
   5 — drawn so they land INSIDE the object, never on its silhouette's edge. */
const EYES = [
  [2, 3],
  [5, 3],
]

export const VOXELS = [
  /* hub, then a truss row that both solar wings hang from */
  {
    id: 'station',
    name: 'Space station',
    mask: [
      '000000000', '110000011', '110000011', '111111111', '110000011',
      '110000011', '000000000', '000000000', '000000000',
    ],
  },
  /* four rotor pods on 1-cell arms — the four gaps are what make it an airframe */
  {
    id: 'drone',
    name: 'Drone',
    mask: [
      '110000011', '110000011', '001000100', '001111100', '001111100',
      '001000100', '110000011', '110000011', '000000000',
    ],
  },
  /* point, blade, a crossguard wide enough to hold both eyes, grip, pommel */
  {
    id: 'blade',
    name: 'Energy blade',
    mask: [
      '000010000', '000111000', '001111100', '001111100', '001111100',
      '111111111', '000111000', '000111000', '000010000',
    ],
  },
  /* a handle, then a case that carries both eyes inside it — the page's subject
     is a file leaving, so the ornament is the thing it leaves in */
  {
    id: 'case',
    name: 'Cargo case',
    mask: [
      '000000000', '000111000', '111111111', '111111111', '111111111',
      '111111111', '011111110', '000000000', '000000000',
    ],
  },
]

const BY_ID = new Map(VOXELS.map((voxel) => [voxel.id, voxel]))
export const voxelById = (id) => BY_ID.get(String(id || '')) || VOXELS[0]

const on = (mask, r, c) => r >= 0 && r < N && c >= 0 && c < N && mask[r].charAt(c) === '1'

/* Light falls from the top-left: the top row and left column are the lit faces,
   the bottom and right fall into the extrusion shadow. */
function cell(mask, r, c) {
  const up = !on(mask, r - 1, c)
  const left = !on(mask, r, c - 1)
  const down = !on(mask, r + 1, c)
  const right = !on(mask, r, c + 1)
  if (up) return 'hi'
  if (left && !down) return 'hi'
  if (down || right || left) return 'sh'
  return 'fc'
}

/* Merge cells into runs so the surface has no seams and the DOM stays small. */
function runs(mask, d, fixed) {
  let s = ''
  for (let r = 0; r < N; r++) {
    let c = 0
    while (c < N) {
      if (!on(mask, r, c)) {
        c++
        continue
      }
      const kind = fixed || cell(mask, r, c)
      let e = c
      while (e + 1 < N && on(mask, r, e + 1) && (fixed || cell(mask, r, e + 1) === kind)) e++
      s +=
        `<rect class="vx-${kind}" x="${-18 + c * U + d}" y="${-18 + r * U + d}" ` +
        `width="${(e - c + 1) * U}" height="${U}"/>`
      c = e + 1
    }
  }
  return s
}

/* Two eyes, a glint on the leading pixel of each, and a lid-free silhouette:
   an ornament does not blink, the character does. */
function eyes() {
  return EYES.map(([column, row]) => {
    const x = -18 + column * U
    const y = -18 + row * U
    const size = U * 2
    return (
      '<g class="vx-ey">' +
      `<rect class="vx-eye" x="${x}" y="${y}" width="${size}" height="${size}"/>` +
      `<rect class="vx-gl" x="${x}" y="${y}" width="${U}" height="${U}"/>` +
      '</g>'
    )
  }).join('')
}

const cache = new Map()

/** The cell box a mask actually paints, so the drawing fills its slot. A
 *  station is five rows tall and nine wide: framing the whole 9 × 9 field would
 *  leave a third of the box empty and every ornament would read as the same
 *  small smudge at card size. */
function bounds(mask) {
  let top = N
  let left = N
  let bottom = -1
  let right = -1
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!on(mask, r, c)) continue
      top = Math.min(top, r)
      left = Math.min(left, c)
      bottom = Math.max(bottom, r)
      right = Math.max(right, c)
    }
  }
  return { top, left, bottom, right }
}

/** The markup for one silhouette. Built once per id: an ornament is markup that
    never changes, so parsing it again per row was the wasted half of a list. */
export function voxelSvg(id) {
  const voxel = voxelById(id)
  if (cache.has(voxel.id)) return cache.get(voxel.id)
  const box = bounds(voxel.mask)
  /* the two extrusion steps run down and right, so the frame keeps room for
     them on that side and hugs the lit faces on the other */
  const pad = U * 2
  const x = -18 + box.left * U - U
  const y = -18 + box.top * U - U
  const width = (box.right - box.left + 1) * U + U * 2 + pad
  const height = (box.bottom - box.top + 1) * U + U * 2 + pad
  const svg =
    `<svg viewBox="${x} ${y} ${width} ${height}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">` +
    '<g class="vx-hd"><g class="vx-bd">' +
    runs(voxel.mask, U * 2, 'dx2') +
    runs(voxel.mask, U, 'dx1') +
    runs(voxel.mask, 0) +
    eyes() +
    '</g></g></svg>'
  cache.set(voxel.id, svg)
  return svg
}
