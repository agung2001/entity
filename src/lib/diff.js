/**
 * The side-by-side diff, one copy.
 *
 * Longest common subsequence on lines, then paired rows: a removal followed by an
 * addition becomes one row so a rewritten sentence sits beside its old version
 * instead of in a separate block. `EntityLearnDialog` paints it as a dialog; the
 * definition write card paints the same rows on the composer.
 */

export function diffRows(before, after) {
  const a = String(before || '').split('\n')
  const b = String(after || '').split('\n')
  const n = a.length
  const m = b.length
  /* Trim common head and tail so the table stays small for small edits. */
  let head = 0
  while (head < n && head < m && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) tail += 1

  const midA = a.slice(head, n - tail)
  const midB = b.slice(head, m - tail)
  const rows = []
  for (let i = 0; i < head; i += 1) rows.push({ kind: 'same', left: a[i], right: b[i] })

  const ops = lcsDiff(midA, midB)
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (op.type === 'same') {
      rows.push({ kind: 'same', left: op.text, right: op.text })
      continue
    }
    if (op.type === 'remove') {
      const next = ops[i + 1]
      if (next && next.type === 'add') {
        rows.push({ kind: 'change', left: op.text, right: next.text })
        i += 1
      } else {
        rows.push({ kind: 'remove', left: op.text, right: null })
      }
      continue
    }
    rows.push({ kind: 'add', left: null, right: op.text })
  }

  for (let i = 0; i < tail; i += 1) {
    rows.push({ kind: 'same', left: a[n - tail + i], right: b[m - tail + i] })
  }

  /* Line numbers follow each side independently: a row that exists on only one
     side does not consume a number on the other. */
  let ln = 1
  let rn = 1
  for (const row of rows) {
    row.leftNo = row.left === null ? '' : ln++
    row.rightNo = row.right === null ? '' : rn++
  }
  return rows
}

export function lcsDiff(a, b) {
  const n = a.length
  const m = b.length
  if (!n) return b.map((text) => ({ type: 'add', text }))
  if (!m) return a.map((text) => ({ type: 'remove', text }))

  /* One row of the DP table at a time; the table is small because the head and
     tail were already trimmed and instructions are a few hundred lines. */
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'remove', text: a[i] })
      i += 1
    } else {
      ops.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) ops.push({ type: 'remove', text: a[i++] })
  while (j < m) ops.push({ type: 'add', text: b[j++] })
  return ops
}
