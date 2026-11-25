/**
 * A QR code, drawn by hand.
 *
 * The Tailscale panel needs exactly one code — `http://<tailnet name>:<port>` at
 * 232 px — and a QR library is 40 kB of mask tables and micro-QR support for
 * that. So this is the encoder, byte mode, error correction M, quiet zone 4:
 * the smallest version the address fits in, then the mask with the lowest
 * penalty score (the standard's rules 1–4).
 *
 * One export. `qrFor(text)` → `{ size, path }`, where `size` counts the quiet
 * zone and `path` is an SVG path in that coordinate space:
 *
 *     <svg viewBox="0 0 ${qr.size} ${qr.size}"><path :d="qr.path" /></svg>
 *
 * Verified against CoreImage's QR detector — that is the check that matters,
 * since a hand-drawn code that looks right and reads wrong is the whole risk.
 */

/* Level M, versions 1–40: error-correction codewords per block, then blocks per
   version. Two rows, because the version is the index and a table keyed any other
   way drifts from the standard by one. */
const ECC_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
]
const BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
]

/* The format byte's high nibble: level M is 00, so only the mask varies. */
const LEVEL_M = 0

const N1 = 3
const N2 = 3
const N3 = 40
const N4 = 10
const QUIET = 4

/** Data modules in a version, before error correction. Function patterns and the
 *  two alignment-row reductions come out of the same formula the standard is
 *  drawn from, so the table above only has to carry the level. */
function rawDataModules(version) {
  let count = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    count -= (25 * align - 10) * align - 55
    if (version >= 7) count -= 36
  }
  return count
}

/** Row/column centres of the alignment patterns, bottom-right first. */
function alignmentPositions(version, size) {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  /* The standard's own spacing, with version 32 as the one exception it calls
     out. */
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const positions = [6]
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos)
  return positions
}

function multiply(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree) {
  const divisor = new Uint8Array(degree)
  divisor[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = multiply(divisor[j], root)
      if (j + 1 < degree) divisor[j] ^= divisor[j + 1]
    }
    root = multiply(root, 0x02)
  }
  return divisor
}

function rsRemainder(data, divisor) {
  const remainder = new Uint8Array(divisor.length)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[remainder.length - 1] = 0
    for (let i = 0; i < remainder.length; i++) remainder[i] ^= multiply(divisor[i], factor)
  }
  return remainder
}

/** The payload: mode, length, bytes, terminator, pad — then blocks and ECC,
 *  interleaved in the order a scanner reads them. */
function codewordsFor(version, bytes) {
  const capacity = Math.floor(rawDataModules(version) / 8) - ECC_M[version] * BLOCKS_M[version]
  const bits = []
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0)
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    data.push(byte)
  }
  /* The two pad bytes the standard specifies, alternating, until the block is
     full. A short payload is not an error — it is padded capacity. */
  for (let pad = 0xec; data.length < capacity; pad ^= 0xfd) data.push(pad)

  const blocks = BLOCKS_M[version]
  const eccLength = ECC_M[version]
  const raw = Math.floor(rawDataModules(version) / 8)
  const shortCount = blocks - (raw % blocks)
  const shortLength = Math.floor(raw / blocks)
  const divisor = rsDivisor(eccLength)
  const split = []
  for (let i = 0, at = 0; i < blocks; i++) {
    const length = shortLength - eccLength + (i < shortCount ? 0 : 1)
    const block = data.slice(at, at + length)
    at += length
    const ecc = rsRemainder(block, divisor)
    if (i < shortCount) block.push(0)
    split.push(block.concat([...ecc]))
  }
  const stream = []
  for (let i = 0; i < split[0].length; i++) {
    for (let j = 0; j < split.length; j++) {
      if (i !== shortLength - eccLength || j >= shortCount) stream.push(split[j][i])
    }
  }
  return stream
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** 15 format bits: BCH(15,5) with the standard's mask, in both copies. */
function drawFormat(grid, size, mask) {
  const data = (LEVEL_M << 3) | mask
  let remainder = data
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  const bits = ((data << 10) | remainder) ^ 0x5412
  const bit = (at) => ((bits >>> at) & 1) === 1
  for (let i = 0; i <= 5; i++) grid[i][8] = bit(i)
  grid[7][8] = bit(6)
  grid[8][8] = bit(7)
  grid[8][7] = bit(8)
  for (let i = 9; i < 15; i++) grid[8][14 - i] = bit(i)
  for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = bit(i)
  for (let i = 8; i < 15; i++) grid[size - 15 + i][8] = bit(i)
  grid[size - 8][8] = true
}

/** 18 version bits, BCH(18,6), for version 7 and up. */
function drawVersion(grid, size, version) {
  let remainder = version
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  const bits = (version << 12) | remainder
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    grid[b][a] = dark
    grid[a][b] = dark
  }
}

function gridFor(version, stream) {
  const size = version * 4 + 17
  const grid = Array.from({ length: size }, () => new Array(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    grid[y][x] = dark
    fixed[y][x] = true
  }

  /* Timing first: the finder patterns draw over their ends on purpose. */
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy))
        set(cx + dx, cy + dy, ring !== 2 && ring !== 4)
      }
    }
  }
  const centres = alignmentPositions(version, size)
  const last = centres.length - 1
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      /* Three corners are the finder patterns; their 7×7 covers the alignment
         square that would sit there. */
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(centres[i] + dx, centres[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  drawFormat(grid, size, 0)
  if (version >= 7) drawVersion(grid, size, version)
  /* Whatever those two wrote is reserved, so the zigzag below cannot land on top
     of it: the two 15-bit format strips, then the two 18-bit version blocks. */
  const reserve = (x, y) => {
    fixed[y][x] = true
  }
  for (let i = 0; i <= 8; i++) {
    reserve(8, i)
    reserve(i, 8)
  }
  for (let i = 0; i < 8; i++) {
    reserve(8, size - 1 - i)
    reserve(size - 1 - i, 8)
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      reserve(a, b)
      reserve(b, a)
    }
  }

  /* The zigzag: two columns at a time, right to left, skipping the vertical
     timing column, alternating direction. */
  let at = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (fixed[y][x]) continue
        grid[y][x] = at < stream.length * 8 && ((stream[at >>> 3] >>> (7 - (at & 7))) & 1) === 1
        at++
      }
    }
  }
  return { size, grid, fixed }
}

function addRun(history, length) {
  /* A row that starts dark has no light border in front of it; the 7-module
     quiet zone is the border, and the pattern rule counts it. */
  history.pop()
  history.unshift(history[0] === 0 ? length + 7 : length)
}

function countFinderPatterns(history) {
  const unit = history[1]
  const core = unit > 0 && history[2] === unit && history[3] === unit * 3 && history[4] === unit && history[5] === unit
  if (!core) return 0
  return (history[0] >= unit * 4 && history[6] >= unit ? 1 : 0) + (history[6] >= unit * 4 && history[0] >= unit ? 1 : 0)
}

function closeRun(history, colour, length) {
  if (colour) {
    addRun(history, length)
    length = 0
  }
  addRun(history, length + 7)
  return countFinderPatterns(history)
}

/** Rules 1–4, in the standard's own order. Lower is a cleaner code. */
function penalty(grid, size) {
  let score = 0
  const line = (at) => {
    let colour = false
    let run = 0
    const history = [0, 0, 0, 0, 0, 0, 0]
    for (let i = 0; i < size; i++) {
      const dark = at(i)
      if (dark === colour) {
        run++
        if (run === 5) score += N1
        else if (run > 5) score++
      } else {
        addRun(history, run)
        if (!colour) score += countFinderPatterns(history) * N3
        colour = dark
        run = 1
      }
    }
    score += closeRun(history, colour, run) * N3
  }
  for (let y = 0; y < size; y++) line((x) => grid[y][x])
  for (let x = 0; x < size; x++) line((y) => grid[y][x])

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const colour = grid[y][x]
      if (colour === grid[y][x + 1] && colour === grid[y + 1][x] && colour === grid[y + 1][x + 1]) score += N2
    }
  }

  let dark = 0
  for (const row of grid) for (const cell of row) if (cell) dark++
  const total = size * size
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * N4
  return score
}

/**
 * The code for one string. ECC M only: this app draws one address, and a second
 * level would be a table nothing calls.
 */
export function qrFor(text, { ecc = 'M' } = {}) {
  if (ecc !== 'M') throw new Error(`qrFor draws error correction M, not ${ecc}.`)
  const value = String(text ?? '')
  if (!value) throw new Error('A QR code needs something to say.')
  const bytes = [...new TextEncoder().encode(value)]

  let version = 0
  for (let v = 1; v <= 40 && !version; v++) {
    const capacity = Math.floor(rawDataModules(v) / 8) - ECC_M[v] * BLOCKS_M[v]
    if (4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= capacity * 8) version = v
  }
  if (!version) throw new Error('That address is too long for one QR code.')

  const base = gridFor(version, codewordsFor(version, bytes))
  let best = null
  for (let mask = 0; mask < 8; mask++) {
    const grid = base.grid.map((row) => row.slice())
    for (let y = 0; y < base.size; y++) {
      for (let x = 0; x < base.size; x++) {
        if (!base.fixed[y][x] && MASKS[mask](x, y)) grid[y][x] = !grid[y][x]
      }
    }
    drawFormat(grid, base.size, mask)
    const score = penalty(grid, base.size)
    if (!best || score < best.score) best = { score, grid }
  }

  /* One path, drawn as horizontal runs: a 33-module code is a few thousand bytes
     as run-lengths and several times that as one square per module. */
  const size = base.size + QUIET * 2
  const parts = []
  for (let y = 0; y < base.size; y++) {
    let x = 0
    while (x < base.size) {
      if (!best.grid[y][x]) {
        x++
        continue
      }
      let run = 1
      while (x + run < base.size && best.grid[y][x + run]) run++
      parts.push(`M${x + QUIET} ${y + QUIET}h${run}v1h-${run}z`)
      x += run
    }
  }
  return { size, path: parts.join('') }
}
