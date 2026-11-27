/**
 * The `gh` binary this machine was told to use — `~/.entity/gh.json`.
 *
 * `gh` is usually on PATH, and on a machine where it is not — a Homebrew prefix an
 * app launched from Finder never inherited, a portable install, a second version
 * beside the first — the only answer used to be an environment variable on the
 * app's launch. This file is the field on Connectors → GitHub CLI that replaces it.
 * The rules are `connectors/_binary.cjs`'s; what is this connector's own is the
 * file's name.
 */
const { storeFor } = require('../_binary.cjs')

const FILE = 'gh.json'
const store = storeFor(FILE)

module.exports = {
  FILE,
  file: store.file,
  read: store.read,
  save: store.save,
}
