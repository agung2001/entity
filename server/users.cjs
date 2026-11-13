#!/usr/bin/env node
/**
 * Server account administration from a terminal.
 *
 *   node server/users.cjs list
 *   ENTITY_NEW_PASSWORD='…' node server/users.cjs add teammate@example.com "Teammate"
 *   ENTITY_NEW_PASSWORD='…' node server/users.cjs password teammate@example.com
 *   node server/users.cjs remove teammate@example.com
 *
 * Inside Docker:
 *   docker compose exec -e ENTITY_NEW_PASSWORD='…' entity \
 *     node server/users.cjs add teammate@example.com "Teammate"
 *
 * The password is read from the environment or from stdin, never from argv: an
 * argument is visible in `ps` and in shell history.
 */
const readline = require('node:readline')
const auth = require('./auth.cjs')

function usage() {
  process.stderr.write(
    [
      'usage:',
      '  node server/users.cjs list',
      '  ENTITY_NEW_PASSWORD=… node server/users.cjs add <email> [name] [member|admin]',
      '  ENTITY_NEW_PASSWORD=… node server/users.cjs password <email>',
      '  node server/users.cjs remove <email>',
      '',
      'ENTITY_HOME selects the data directory (default ~/.entity, /data in Docker).',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

async function password() {
  if (process.env.ENTITY_NEW_PASSWORD) return process.env.ENTITY_NEW_PASSWORD
  if (!process.stdin.isTTY) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  const first = await ask('New password: ')
  const second = await ask('Repeat password: ')
  if (first !== second) {
    process.stderr.write('The two passwords do not match.\n')
    process.exit(1)
  }
  return first
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') usage()

  if (command === 'list') {
    if (!auth.count()) {
      process.stdout.write('No accounts.\n')
      return
    }
    for (const user of auth.list()) {
      process.stdout.write(`${user.email}\t${user.role}\t${user.name}\n`)
    }
    return
  }

  if (command === 'add') {
    const email = rest[0]
    if (!email) usage()
    const name = rest[1] || ''
    const role = rest[2] === 'admin' ? 'admin' : 'member'
    const created = auth.create({ email, name, password: await password(), role })
    process.stdout.write(`created ${created.email} (${created.role})\n`)
    return
  }

  if (command === 'password') {
    const email = rest[0]
    if (!email) usage()
    const user = auth.setPassword({ email, password: await password() })
    process.stdout.write(`password updated for ${user.email}\n`)
    return
  }

  if (command === 'remove') {
    const email = rest[0]
    if (!email) usage()
    const result = auth.remove({ email })
    process.stdout.write(`removed ${result.removed}\n`)
    return
  }

  usage()
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`)
  process.exit(1)
})
