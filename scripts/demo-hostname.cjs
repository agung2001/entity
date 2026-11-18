/* Demo only: the recorder must not print the recorder's real machine name.
 *
 * The composer and the machines page show `os.hostname()`. Loading this file
 * through NODE_OPTIONS replaces it for the dev-server process, so every frame
 * says `studio-mini` instead of a laptop's name.
 *
 *   NODE_OPTIONS=--require ./scripts/demo-hostname.cjs npm run dev
 */
const os = require('node:os')
os.hostname = () => 'studio-mini'
