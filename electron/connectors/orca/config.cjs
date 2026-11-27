/**
 * The Orca binary this machine was told to use — `~/.entity/orca.json`.
 *
 * The app can find Orca on its own (`path.cjs` knows the app bundle, the user's own
 * bin and PATH), and finding it automatically is the normal case. This file is for
 * the machine where it is somewhere else: a nightly build, a checkout, a package
 * manager with its own prefix. Without it the only answer was to edit the
 * environment the app was launched with, which is not a setting a person has.
 *
 * The rules — machine-wide, empty means automatic, an unrunnable path is refused at
 * save time — are `connectors/_binary.cjs`'s, because `gh` keeps the same file with
 * the same rules. What is Orca's own here is the file's name.
 */
const { storeFor } = require('../_binary.cjs')

const FILE = 'orca.json'
const store = storeFor(FILE)

module.exports = {
  FILE,
  file: store.file,
  read: store.read,
  save: store.save,
}
