/**
 * The three pieces of the transfer surfaces that are not a call table hit: a
 * size, a count, and turning a dropped file into the bytes the main process
 * accepts.
 *
 * Everything else — the presets, the seal, the diff, the refusals — belongs to
 * `electron/transfer-store.cjs`, because a second copy of the rules in the
 * renderer is how the preview starts disagreeing with the write.
 */

/** `1 file` / `12 files`: the count out loud, with the plural spelled out when a
 *  caller wants a word that is not `file + s` ("people", "inches"). */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** 412 KB, 1.4 MB: the unit a person says out loud. One decimal from MB up. */
export function humanBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * A dropped file as the call table takes it: base64, because IPC cannot clone a
 * `File` and the main process is never handed a path it did not open itself.
 */
export async function readTransferFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const chunk = 0x8000
  let binary = ''
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return { name: String(file.name || 'transfer'), size: bytes.length, data: btoa(binary) }
}

/** Both extensions the reader accepts, for the drop target's own line. */
export const TRANSFER_EXTENSIONS = '.entity.json · .entity.zip'
