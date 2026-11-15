/**
 * Give the packed macOS app a signature that names its own bundle.
 *
 * macOS registers an app with Notification Center from its code signature. An
 * Electron build signed only by the linker carries the generic `Identifier=
 * Electron` and `Info.plist=not bound`, so `com.entity.app` is never registered
 * and every `Notification` the main process shows is dropped. Re-signing the
 * packed bundle ad-hoc with `--identifier com.entity.app` binds the Info.plist
 * and is enough to register it.
 *
 * ponytail: ad-hoc is a local-development signature — fine for Notification
 * Center, useless for Gatekeeper or for handing the app to someone else. The
 * real fix is a Developer ID certificate plus notarization; when one is present
 * (CSC_LINK/CSC_NAME, or a keychain identity electron-builder already used) this
 * hook does nothing, because signing twice would replace that signature.
 */
const { execFileSync, spawnSync } = require('node:child_process')
const path = require('node:path')

const BUNDLE_ID = 'com.entity.app'

/** Did something already sign this bundle with a real identity? */
function identitySigned(appPath) {
  const probe = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', appPath], {
    encoding: 'utf8',
  })
  const info = `${probe.stdout || ''}${probe.stderr || ''}`
  return /TeamIdentifier=(?!not set)/.test(info) && !/flags=.*adhoc/.test(info)
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  if (identitySigned(appPath)) return
  execFileSync(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--identifier', BUNDLE_ID, appPath],
    { stdio: 'inherit' },
  )
  console.log(`  • re-signed ${path.basename(appPath)} ad-hoc as ${BUNDLE_ID}`)
}
