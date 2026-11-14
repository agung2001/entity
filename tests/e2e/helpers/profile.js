import fs from 'node:fs'
import path from 'node:path'
import { readProfile } from '../fixtures.js'

export { readProfile }

export function workspaceDir(p = readProfile()) {
  return p.workspacePath
}

export function threadsDir(p = readProfile()) {
  return path.join(p.workspacePath, 'chats')
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function readThread(p, id) {
  return readJson(path.join(threadsDir(p), `${id}.json`))
}

export function listThreads(p = readProfile()) {
  try {
    return fs
      .readdirSync(threadsDir(p))
      .filter((file) => file.endsWith('.json'))
      .map((file) => readJson(path.join(threadsDir(p), file)))
      .filter(Boolean)
  } catch {
    return []
  }
}

export function newestThread(p = readProfile()) {
  return listThreads(p).sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  )[0] || null
}

export function entityFile(p, name) {
  return path.join(p.workspacePath, 'entities', `${name}.md`)
}

export function entityText(p, name) {
  return fs.readFileSync(entityFile(p, name), 'utf8')
}

export function auditRows(p = readProfile()) {
  try {
    return fs
      .readFileSync(path.join(p.workspacePath, 'audit.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function artifactFile(p, id) {
  return path.join(p.workspacePath, 'artifacts', id)
}

export function listArtifacts(p = readProfile()) {
  const root = path.join(p.workspacePath, 'artifacts')
  const out = []
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next)
      else out.push(next)
    }
  }
  try {
    walk(root)
  } catch {
    return []
  }
  return out.sort()
}

export function newestPrompt(p = readProfile()) {
  const files = fs
    .readdirSync(p.paths.stubLog)
    .filter((file) => file.endsWith('.prompt'))
    .map((file) => {
      const full = path.join(p.paths.stubLog, file)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return files.length ? fs.readFileSync(files[0].full, 'utf8') : ''
}

export function newestAttachment(p = readProfile()) {
  const files = fs
    .readdirSync(p.paths.stubLog)
    .filter((file) => file.endsWith('.attachment'))
    .map((file) => {
      const full = path.join(p.paths.stubLog, file)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return files.length ? fs.readFileSync(files[0].full, 'utf8') : ''
}

export function newestMeta(p = readProfile()) {
  const files = fs
    .readdirSync(p.paths.stubLog)
    .filter((file) => file.endsWith('.meta'))
    .map((file) => {
      const full = path.join(p.paths.stubLog, file)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return files.length ? fs.readFileSync(files[0].full, 'utf8') : ''
}

export function logsMatching(p, suffix, needle) {
  try {
    return fs
      .readdirSync(p.paths.stubLog)
      .filter((file) => file.endsWith(suffix))
      .map((file) => fs.readFileSync(path.join(p.paths.stubLog, file), 'utf8'))
      .filter((text) => !needle || text.includes(needle))
  } catch {
    return []
  }
}

export function threadUserId(p) {
  return p.user.email
}
