/**
 * Shell scripts must keep LF line endings.
 *
 * `electron/fleet-scan.sh` is piped straight to a POSIX shell on another machine
 * (`ssh <host> sh -s`). On Windows `core.autocrlf=true` used to check it out
 * with CRLF, and dash read `set -u\r` as "Illegal option -" and aborted before
 * printing a single capability line — every remote Test & Scan failed. The
 * `.gitattributes` `*.sh text eol=lf` entry plus the CRLF strip in
 * `machine-scan.cjs` fix that; this test keeps a stray CRLF from creeping back.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.join(__dirname, '..', '..')

function shellScripts(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) shellScripts(full, found)
    else if (entry.name.endsWith('.sh')) found.push(full)
  }
  return found
}

test('shell scripts use LF, never CRLF', () => {
  const scripts = [
    ...shellScripts(path.join(ROOT, 'electron')),
    ...shellScripts(path.join(ROOT, 'scripts')),
    ...shellScripts(path.join(ROOT, 'tests')),
  ]
  assert.ok(scripts.length > 0, 'expected to find at least one shell script')
  for (const file of scripts) {
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(
      !text.includes('\r'),
      `${path.relative(ROOT, file)} has CRLF line endings; piped POSIX shells reject them`,
    )
  }
})
