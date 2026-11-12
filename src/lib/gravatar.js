/**
 * Gravatar needs the MD5 of a lowercased, trimmed email. The browser has no
 * MD5 in WebCrypto, and a 32-bit hash is not something to add a package for, so
 * this is the small public-domain style implementation used only for the
 * avatar URL. No email ever leaves the machine except in this hash.
 */
function md5(input) {
  const bytes = new TextEncoder().encode(input)
  const words = []
  for (let i = 0; i < bytes.length; i += 1) {
    words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8))
  }
  const bitLength = bytes.length * 8
  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | (0x80 << (bitLength % 32))
  const lengthWords = (((bitLength + 64) >>> 9) << 4) + 14
  words[lengthWords] = bitLength
  words[lengthWords + 1] = Math.floor(bitLength / 0x100000000)

  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476

  const add = (x, y) => (x + y) | 0
  const rol = (value, count) => (value << count) | (value >>> (32 - count))
  const ff = (x, y, z) => (x & y) | (~x & z)
  const gg = (x, y, z) => (x & z) | (y & ~z)
  const hh = (x, y, z) => x ^ y ^ z
  const ii = (x, y, z) => y ^ (x | ~z)

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  const k = Array.from({ length: 64 }, (_, i) =>
    Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0,
  )

  for (let offset = 0; offset < words.length; offset += 16) {
    const aa = a
    const bb = b
    const cc = c
    const dd = d
    for (let i = 0; i < 64; i += 1) {
      let f
      let g
      if (i < 16) {
        f = ff(b, c, d)
        g = i
      } else if (i < 32) {
        f = gg(b, c, d)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = hh(b, c, d)
        g = (3 * i + 5) % 16
      } else {
        f = ii(b, c, d)
        g = (7 * i) % 16
      }
      const next = d
      d = c
      c = b
      b = add(b, rol(add(add(a, f), add(k[i], words[offset + g] || 0)), s[i]))
      a = next
    }
    a = add(a, aa)
    b = add(b, bb)
    c = add(c, cc)
    d = add(d, dd)
  }

  const hex = (value) => {
    let out = ''
    for (let i = 0; i < 4; i += 1) {
      out += ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
    }
    return out
  }
  return hex(a) + hex(b) + hex(c) + hex(d)
}

/** Profile image for an email; `identicon` is Gravatar's own fallback. */
export function gravatarUrl(email, size = 96) {
  const value = String(email || '').trim().toLowerCase()
  if (!value) return ''
  const hash = md5(value)
  return `https://www.gravatar.com/avatar/${hash}?s=${Math.max(24, Number(size) || 96)}&d=identicon&r=g`
}

/** A readable name from an email local part: ad.min → Ad Min. */
export function displayNameFrom(email, fallback = '') {
  const local = String(email || '').split('@')[0]
  return (
    local
      .split(/[._-]/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(' ') || fallback
  )
}
