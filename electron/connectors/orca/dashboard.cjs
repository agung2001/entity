/**
 * The connector's two main-process verbs: what binary Orca's mentions run, and the
 * field on the connector's page that changes it.
 *
 * **There is no dashboard tab**, and this file is not one. The registry's contract
 * is that a connector's calls live in `dashboard.cjs` — `github.useActive` is the
 * same shape, a write its page needs rather than a read for a tab — so the verbs for
 * a connector with no tab still belong here instead of becoming call-table knowledge
 * in `rpc.cjs`. The store itself is `config.cjs` (one small file in `~/.entity/`);
 * this file is the shape the page talks to.
 *
 * The answer to both verbs is a *resolution*, not the raw field: `{ binary, dir,
 * source, searched }` (`path.cjs`). The page then says why it is that binary, and a
 * cleared field answers "automatic" in the same answer as a save, so the two cannot
 * disagree about what is in effect.
 */
const config = require('./config.cjs')

/** What Orca's mentions would run right now, and how it was found. */
function path() {
  return require('./path.cjs').resolve()
}

/** Set (or clear, with an empty string) the path, then answer the new resolution. */
function setPath({ binary } = {}) {
  config.save({ binary })
  return path()
}

module.exports = { path, setPath }
