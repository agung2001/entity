/**
 * Files → works.
 *
 * The shelf is 720 files deep and a person remembers the *folder* they came
 * from (`design/entities-index/`), not the file inside it. A work is that
 * folder, derived from the rows the store already returns — nothing here is
 * stored, nothing here reads disk, and the same rows always give the same
 * answer.
 *
 * Pure on purpose: no Vue, no DOM, no imports. `tests/unit/artifacts-index`
 * feeds it a hand-written fixture, so the rule is checked without a shelf.
 */

/* A folder that writes its own document is a work. `.htm` and `.cjs` are here
   because a render script and a saved page are the same kind of thing. */
const DOC_EXT = new Set(['.md', '.html', '.htm', '.mjs', '.cjs', '.css'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg'])
/* Covers are photographs of a page: an SVG has no page to photograph and a
   vector scales to any box, so it is never cropped into a 16:10 frame. */
const RASTER_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico'])
/* One read of the call table carries a data URL in a JSON message; a cover
   above this is a download, not a thumbnail. */
const COVER_MAX = 900 * 1024

const TYPE_EXT = {
  images: IMAGE_EXT,
  pages: new Set(['.html', '.htm', '.pdf']),
  notes: new Set(['.md', '.markdown', '.txt']),
  code: new Set([
    '.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.json', '.jsonl', '.css', '.py', '.sh',
    '.yaml', '.yml', '.toml', '.patch', '.diff', '.rs', '.go', '.rb', '.php',
  ]),
}

/**
 * Which pill a file answers to. One function, because the pill's count and the
 * pill's filter must be the same question: `pages` is a document someone opens,
 * `notes` is prose they read in place, and a `.pdf` is a page, not an other.
 */
export function typeOf(ext) {
  const value = String(ext || '').toLowerCase()
  const key = value.startsWith('.') ? value : `.${value}`
  for (const [name, set] of Object.entries(TYPE_EXT)) if (set.has(key)) return name
  return 'other'
}

const dirOf = (id) => {
  const cut = String(id).lastIndexOf('/')
  return cut < 0 ? '' : String(id).slice(0, cut)
}
const baseOf = (id) => String(id).slice(String(id).lastIndexOf('/') + 1)
const extOf = (item) => {
  const value = String(item?.ext || '')
  if (value) return value.toLowerCase()
  const name = String(item?.name || baseOf(item?.id || ''))
  const cut = name.lastIndexOf('.')
  return cut <= 0 ? '' : name.slice(cut).toLowerCase()
}
const bare = (ext) => ext.replace(/^\./, '') || 'file'
const depth = (dir) => dir.split('/').length
const sizeOf = (item) => (Number.isFinite(Number(item?.size)) ? Number(item.size) : 0)
const timeOf = (item) => String(item?.modifiedAt || '')

/**
 * The shot a folder already holds, in the order a person's own naming
 * convention puts them: an explicit `cover` first, the `preview` a render
 * script writes second, then `shot-3` / `shot_03` / `render-2` counting *up*
 * from zero rather than down, then anything else that happens to be an image.
 * A rank, not a sort of the whole list: an unranked 4 MB screenshot must not
 * beat the `cover.png` beside it.
 */
export function coverCandidate(files = []) {
  let best = null
  let bestRank = -Infinity
  for (const file of files) {
    if (!RASTER_EXT.has(extOf(file))) continue
    if (sizeOf(file) >= COVER_MAX) continue
    const base = baseOf(file.name || file.id || '').toLowerCase().replace(/\.[^.]+$/, '')
    const shot = /^shot[-_](\d+)/.exec(base)
    const render = /^render[-_](\d+)/.exec(base)
    const rank = base === 'cover' ? 100 : base === 'preview' ? 90 : shot ? 80 - Number(shot[1]) : render ? 60 - Number(render[1]) : 10
    if (rank > bestRank || (rank === bestRank && timeOf(file) > timeOf(best))) {
      best = file
      bestRank = rank
    }
  }
  return best
}

/**
 * Every work on the shelf, plus the rows that belong to none.
 *
 * Returns `{ works, loose, counts }`. `works` is newest first, `loose` is
 * newest first, and `counts` is derived from the same rows so a pill, a card
 * and the meter cannot disagree: the type buckets partition the rows and the
 * per-type `exts` add up to the bucket.
 */
export function groupWorks(items = []) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => item && item.id)
  const dirs = new Map()
  const node = (dir) => {
    let found = dirs.get(dir)
    if (!found) {
      found = { files: [], children: new Set() }
      dirs.set(dir, found)
    }
    return found
  }

  for (const row of rows) {
    const dir = dirOf(row.id)
    node(dir).files.push(row)
    /* Every ancestor knows it has a child folder. A folder with *any* child
       has subfolders recursively, which is the test the image-batch rule uses. */
    let child = dir
    while (child) {
      const parent = dirOf(child)
      node(parent).children.add(child)
      child = parent
    }
  }

  const qualifies = (dir) => {
    const node = dirs.get(dir)
    if (!node) return false
    if (node.files.some((file) => DOC_EXT.has(extOf(file)))) return true
    return node.children.size === 0 && node.files.some((file) => IMAGE_EXT.has(extOf(file)))
  }

  /* Top-most qualifying folder wins: `design/entities-index` is one work even
     though its `shots/` child qualifies on its own, because a person names the
     folder they made, not the batch inside it. Shallowest first, so the ancestor
     is already chosen when the descendant is considered. */
  const candidates = [...dirs.keys()]
    .filter((dir) => dir && qualifies(dir))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
  const accepted = new Set()
  for (const dir of candidates) {
    let parent = dirOf(dir)
    let pruned = false
    while (parent) {
      if (accepted.has(parent)) {
        pruned = true
        break
      }
      parent = dirOf(parent)
    }
    if (!pruned) accepted.add(dir)
  }

  const works = [...accepted].map((path) => {
    const files = rows.filter((row) => row.id.startsWith(`${path}/`))
    const extMix = extMixOf(files)
    return {
      path,
      name: baseOf(path),
      parent: dirOf(path),
      files,
      fileCount: files.length,
      size: files.reduce((total, file) => total + sizeOf(file), 0),
      modifiedAt: files.reduce((newest, file) => (timeOf(file) > newest ? timeOf(file) : newest), ''),
      extMix,
      shots: files.filter((file) => IMAGE_EXT.has(extOf(file))).length,
      cover: coverCandidate(files),
    }
  })
  works.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)) || a.path.localeCompare(b.path))

  /* A row belongs to its nearest accepted ancestor, which is the one work it is
     under — the ancestor chain is short (depth 3 on a real shelf). */
  const loose = rows
    .filter((row) => {
      let parent = dirOf(row.id)
      while (parent) {
        if (accepted.has(parent)) return false
        parent = dirOf(parent)
      }
      return true
    })
    .sort((a, b) => timeOf(b).localeCompare(timeOf(a)) || String(a.id).localeCompare(String(b.id)))

  const types = {}
  for (const name of [...Object.keys(TYPE_EXT), 'other']) {
    types[name] = bucketOf(rows, (ext) => typeOf(ext) === name)
  }

  return {
    works,
    loose,
    counts: {
      files: rows.length,
      works: works.length,
      loose: loose.length,
      previews: works.filter((work) => work.cover).length,
      bytes: rows.reduce((total, row) => total + sizeOf(row), 0),
      worksBytes: works.reduce((total, work) => total + work.size, 0),
      looseBytes: loose.reduce((total, row) => total + sizeOf(row), 0),
      types,
    },
  }
}

function extMixOf(files) {
  const counts = new Map()
  for (const file of files) {
    const key = bare(extOf(file))
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ext, count]) => ({ ext, count }))
}

function bucketOf(rows, match) {
  const counts = new Map()
  for (const row of rows) {
    const ext = extOf(row)
    if (!match(ext)) continue
    const key = bare(ext)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return {
    count: [...counts.values()].reduce((total, n) => total + n, 0),
    exts: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([ext, count]) => ({ ext, count })),
  }
}
