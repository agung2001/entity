/**
 * Local speech-to-text for the desktop app.
 *
 * Voice mode prefers the browser's SpeechRecognition, which is instant but needs
 * a recognition service; inside Electron that service answers `network` and the
 * feature would be a dead button. So the fallback is a whisper CLI the user
 * already has — the same philosophy as the harness runner: this app ships no
 * model, it runs the small tool you installed.
 *
 * The renderer sends **audio only** — a 16 kHz mono WAV it recorded — never a
 * path, a command or an argument. This module finds the binary and the model,
 * writes the take to a private temp directory, runs it, and removes the folder
 * whatever happens. A recording that outlives its turn is not a file this app
 * keeps.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnTracked, killTree } = require('./child-registry.cjs')
const harnesses = require('./harness-store.cjs')

/** Bigger than any single utterance; a guard, not a limit anyone should hit. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
const CLI_TIMEOUT_MS = 60_000
const PY_TIMEOUT_MS = 120_000

/**
 * Where a ggml model may live. Checked in order, so a model the user dropped in
 * `~/.entity/models` wins over a shared cache. `ENTITY_WHISPER_MODEL` names one
 * file outright.
 */
function modelDirs() {
  const home = os.homedir()
  const dirs = [
    path.join(home, '.entity', 'models'),
    path.join(home, '.cache', 'whisper.cpp'),
    path.join(home, '.cache', 'whisper'),
    path.join(home, '.cache', 'hyperframes', 'whisper', 'models'),
  ]
  if (process.platform === 'darwin') {
    dirs.push('/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp')
  } else if (process.platform === 'linux') {
    dirs.push('/usr/share/whisper.cpp', '/usr/local/share/whisper-cpp')
  }
  return dirs
}

/** Smallest useful model first: latency is the feature here, not accuracy. */
const MODEL_ORDER = [
  /^ggml-tiny\.en\.bin$/i,
  /^ggml-tiny\.bin$/i,
  /^ggml-base\.en\.bin$/i,
  /^ggml-base\.bin$/i,
  /^ggml-small\.en\.bin$/i,
  /^ggml-small\.bin$/i,
  /^ggml-medium/i,
  /^ggml-large/i,
]

/** The best of the model files on offer, or '' when none is usable. */
function pickModel(names) {
  const files = (names || []).filter((name) => /^ggml-.*\.bin$/i.test(String(name)))
  if (!files.length) return ''
  for (const pattern of MODEL_ORDER) {
    const hit = files.find((name) => pattern.test(name))
    if (hit) return hit
  }
  return files[0]
}

function listModels() {
  const found = []
  for (const dir of modelDirs()) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) found.push({ dir, name })
  }
  const pinned = String(process.env.ENTITY_WHISPER_MODEL || '').trim()
  if (pinned) {
    try {
      if (fs.statSync(pinned).isFile()) {
        found.unshift({ dir: path.dirname(pinned), name: path.basename(pinned) })
      }
    } catch {
      /* a env var pointing nowhere is not a candidate */
    }
  }
  return found
}

function cachedModels() {
  const dir = path.join(os.homedir(), '.cache', 'whisper')
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /\.pt$/i.test(name))
      .map((name) => name.replace(/\.pt$/i, ''))
  } catch {
    return []
  }
}

/**
 * A packaged app started from Finder does not inherit a login shell's PATH, so
 * Homebrew and pipx installs are invisible to `which`. These are the places a
 * whisper binary actually lives on each platform; the env var pins one outright.
 */
function commonBinDirs() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return [
      path.join(home, 'scoop', 'shims'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'whisper.cpp'),
    ]
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'pipx', 'bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Env override, then PATH, then the usual install directories. */
function findBinary(name) {
  const pinned = String(process.env.ENTITY_WHISPER_BIN || '').trim()
  if (pinned && executable(pinned)) return pinned
  const onPath = harnesses.which(name)
  if (onPath) return onPath
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of commonBinDirs()) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`)
      if (executable(candidate)) return candidate
    }
  }
  return ''
}

let cachedStatus = null

/** What this machine can actually do. Probed once; models do not appear often. */
function status({ refresh = false } = {}) {
  if (cachedStatus && !refresh) return cachedStatus

  const models = listModels()
  const cli = findBinary('whisper-cli')
  const model = cli ? pickModel(models.map((entry) => entry.name)) : ''
  if (cli && model) {
    const entry = models.find((item) => item.name === model)
    cachedStatus = {
      stt: {
        available: true,
        engine: 'whisper-cli',
        model: path.join(entry?.dir || '', model),
        binary: cli,
        reason: '',
      },
      maxSeconds: 30,
    }
    return cachedStatus
  }

  const python = findBinary('whisper')
  const cached = python ? cachedModels()[0] || '' : ''
  if (python && cached) {
    cachedStatus = {
      stt: { available: true, engine: 'whisper', model: cached, binary: python, reason: '' },
      maxSeconds: 30,
    }
    return cachedStatus
  }

  const reason = !cli && !python
    ? 'No whisper CLI on this machine (install whisper.cpp or openai-whisper), and this build has no browser speech service.'
    : cli
      ? 'whisper-cli is installed but no ggml model was found (put one in ~/.entity/models or set ENTITY_WHISPER_MODEL).'
      : 'whisper is installed but no model is cached in ~/.cache/whisper.'

  cachedStatus = {
    stt: { available: false, engine: '', model: '', reason },
    maxSeconds: 30,
  }
  return cachedStatus
}

/** Reset the probe; exported for tests and for a settings retry. */
function reset() {
  cachedStatus = null
}

function cleanTranscript(raw) {
  return String(raw || '')
    .replace(/^\s*\[[\d:.\s>=-]+\]\s*/gm, '')
    .replace(/\[(BLANK_AUDIO|SILENCE|MUSIC|SOUND|NOISE|INAUDIBLE)\]/gi, ' ')
    .replace(/\((silence|music|inaudible)\)/gi, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeLanguage(value) {
  const raw = String(value || 'en').trim()
  return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(raw) ? raw : 'en'
}

/** whisper.cpp knows `en`, not `en-US`; the region belongs to speech synthesis. */
function cliLanguage(value) {
  const tag = safeLanguage(value)
  return tag.split('-')[0].toLowerCase()
}

function run(bin, argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnTracked(bin, argv, {
      kind: 'voice',
      label: 'whisper',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child, 'SIGKILL')
      reject(new Error('Transcription timed out.'))
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 400_000) stdout = stdout.slice(-400_000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 40_000) stderr = stderr.slice(-40_000)
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Could not run ${path.basename(bin)}: ${error.message}`))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const detail = cleanTranscript(stderr) || `exit ${code}`
        reject(new Error(`Transcription failed: ${detail}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Transcribe one take.
 *
 * `audio` is base64 WAV. Anything else is refused: the encoder lives in the
 * renderer and there is exactly one format, so a surprise container is a bug,
 * not something to hand to a decoder.
 */
async function transcribe({ audio, mime = 'audio/wav', language = 'en' } = {}) {
  const encoded = typeof audio === 'string' ? audio : ''
  if (!encoded) throw new Error('No audio was sent.')
  if (mime && !/^audio\/wav$|^audio\/wave$|^audio\/x-wav$/i.test(String(mime))) {
    throw new Error('Voice takes are sent as WAV.')
  }
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.length < 256) throw new Error('The recording was empty.')
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error('The recording was too long.')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('The recording was not a WAV file.')

  const probe = status()
  if (!probe.stt.available) throw new Error(probe.stt.reason || 'No local transcriber is available.')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-voice-'))
  const file = path.join(dir, 'take.wav')
  try {
    fs.writeFileSync(file, buffer, { mode: 0o600 })
    const lang = safeLanguage(language)
    if (probe.stt.engine === 'whisper-cli') {
      const threads = Math.max(2, Math.min(8, os.cpus().length - 2))
      const { stdout } = await run(
        probe.stt.binary,
        ['-m', probe.stt.model, '-f', file, '-l', cliLanguage(lang), '-nt', '-t', String(threads)],
        CLI_TIMEOUT_MS,
      )
      /* whisper.cpp exits 0 after printing its usage for an option it did not
         understand, so a textual check is the only honest failure signal. */
      if (/^\s*usage:/im.test(stdout) || /^\s*error:/im.test(stdout)) {
        const detail = cleanTranscript(stdout.match(/error:[^\n]*/i)?.[0] || 'the transcriber rejected the input')
        throw new Error(`Transcription failed: ${detail}`)
      }
      return { text: cleanTranscript(stdout), engine: 'whisper-cli', model: path.basename(probe.stt.model) }
    }

    await run(
      probe.stt.binary,
      [
        file,
        '--model',
        probe.stt.model,
        '--language',
        lang,
        '--task',
        'transcribe',
        '--output_format',
        'txt',
        '--output_dir',
        dir,
        '--fp16',
        'False',
        '--verbose',
        'False',
      ],
      PY_TIMEOUT_MS,
    )
    const out = path.join(dir, 'take.txt')
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
    return { text: cleanTranscript(text), engine: 'whisper', model: probe.stt.model }
  } finally {
    /* The take is the most private file this app touches. It does not survive
       the call, even when the call threw. */
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a temp directory that cannot be removed is reported by the OS, not us */
    }
  }
}

module.exports = {
  status,
  transcribe,
  reset,
  pickModel,
  cleanTranscript,
  safeLanguage,
  cliLanguage,
  findBinary,
  modelDirs,
}
