import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, RenderSurface } from 'claude-code'

import type { ReadAlongCursor, ReadAlongInfo, ReadAlongSettings, ReadAlongStatus, ReadAlongVoice } from '../types'

// Read-along: buttons on every message, a player while reading, auto-read,
// and the sentence being read highlighted in its message.
// The speech itself is bin/speakd.py, one local service per user that every
// session shares (so only one voice talks at a time), reached over HTTP on a
// Unix socket. A voice is `<engine>:<name>` (kokoro:af_heart, win:Microsoft
// Aria, mac:Samantha, espeak:en-us) or `auto`, the best one installed.

const now = atom({ plugin: 'read-along', key: 'now' } as const, null)
const current = atom({ plugin: 'read-along', key: 'prefs' } as const, null)
const cursor = atom({ plugin: 'read-along', key: 'cursor' } as const, null)
const machine = atom({ plugin: 'read-along', key: 'info' } as const, null)
const browsing = atom({ plugin: 'read-along', key: 'browsing' } as const, null)
const installed = atom({ plugin: 'read-along', key: 'voices' } as const, null)
const bandCheck = atom({ plugin: 'read-along', key: 'bandCheck' } as const, 0)

const PANE = 'read-along'
const SPEED_STEP = 0.25
const VOLUME_STEP = 10
/**
 * The player's status icon, by state. `nerd` uses Nerd Font icons (speaker,
 * pause, hourglass); `text` uses plain symbols, which every terminal has.
 */
const ICONS = {
  nerd: { idle: '\u{F057E}', playing: '\u{F057E}', paused: '\u{F03E4}', loading: '\u{F051F}' },
  text: { idle: '♫', playing: '♫', paused: '‖', loading: '…' },
} as const
const icons = () => (str('icons', 'text') === 'nerd' ? 'nerd' : 'text')
const icon = (state: 'idle' | 'playing' | 'paused' | 'loading') => ICONS[icons()][state]
/** Button glyphs, Nerd Font media controls or their plain-text stand-ins. */
const BUTTONS = {
  nerd: { play: '\u{F040A}', pause: '\u{F03E4}', stop: '\u{F04DB}', back: '\u{F04AE}', forward: '\u{F04AD}', slower: '\u{F0374}', faster: '\u{F0415}', restart: '\u{F0450}' },
  text: { play: '▶', pause: '‖', stop: '■', back: '«', forward: '»', slower: '−', faster: '+', restart: '⟲' },
} as const
const btn = (name: keyof (typeof BUTTONS)['text']) => BUTTONS[icons()][name]
const stateOf = (status: ReadAlongStatus) => (status.state === 'paused' ? 'paused' : status.state === 'loading' ? 'loading' : 'playing')
const DUCK_LEVELS = ['off', '50%', '30%', '15%']
/** Other apps' volume while reading, as a fraction of their own: `30%` → 0.3, `off` → 1. */
const duckLevel = (duckOthers: string) => (duckOthers === 'off' ? 1 : Math.max(0, Math.min(1, parseFloat(duckOthers) / 100 || 1)))

type $ = EngineInterface
type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>
type MessageEvent = RenderInput<'AssistantMessage' | 'UserMessage'>

/**
 * Voice groups: Latin-script text goes to `main`, every other script to its
 * own group, so a Japanese sentence in an English reply gets a Japanese voice.
 */
const GROUPS: Record<string, string> = {
  main: 'Main',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  he: 'Hebrew',
  ar: 'Arabic',
  ru: 'Cyrillic',
  hi: 'Hindi',
  el: 'Greek',
  th: 'Thai',
}

let opt: Options = {}
const str = (k: string, d: string) => (typeof opt[k] === 'string' ? (opt[k] as string) : d)
const num = (k: string, d: number) => (typeof opt[k] === 'number' ? (opt[k] as number) : d)
const bool = (k: string, d: boolean) => (typeof opt[k] === 'boolean' ? (opt[k] as boolean) : d)

/**
 * The `voices` setting: `main=kokoro:af_heart, win:Microsoft Aria; ja=auto`.
 * A list with no `group=` is the main one. Each group's first voice is the
 * one used; the voice button steps through the main list.
 */
export const parseVoices = (text: string): Record<string, string[]> => {
  const out: Record<string, string[]> = {}
  for (const part of text.split(';')) {
    const m = part.match(/^\s*([a-z]{2,4})\s*=(.*)$/)
    const group = m?.[1] ?? 'main'
    const voices = (m?.[2] ?? part)
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
    if (voices.length) out[group] = voices
  }
  if (!out.main) out.main = ['auto']
  return out
}

export const formatVoices = (lists: Record<string, string[]>) =>
  Object.entries(lists)
    .filter(([, voices]) => voices.length)
    .map(([group, voices]) => `${group}=${voices.join(', ')}`)
    .join('; ')

const favourites = () => parseVoices(str('voices', 'auto'))

const defaults = (): ReadAlongSettings => ({
  voices: Object.fromEntries(Object.entries(favourites()).map(([g, list]) => [g, list[0] ?? 'auto'])),
  speed: num('speed', 1.25),
  volume: num('volume', 100),
  duckOthers: str('duckOthers', 'off'),
  autoReadReplies: str('autoReadReplies', 'off'),
  autoReadMine: bool('autoReadMine', false),
  readThinking: bool('readThinking', false),
})
/** The message buttons' form on a surface. The phone has no pointer to hover with, so it shows them. */
const buttons = (surface: RenderSurface = 'terminal') => {
  const chosen = str('buttons', 'hover')
  return surface === 'mobile' && (chosen === 'hover' || chosen === 'glyph') ? 'always' : chosen
}
/** `player`: band | hint | message | band+message. */
const playerAt = () => str('player', 'band')
/** Whether a read's progress shows under its message. The phone draws no band, so there it always does. */
const showsUnderMessage = (surface: RenderSurface = 'terminal') =>
  surface === 'mobile' || playerAt() === 'message' || playerAt() === 'band+message'

/**
 * What each surface has asked this mod to draw since it loaded, and the remote
 * clients that attached: \`/read-along doctor\` shows them, so a surface that
 * shows no buttons can be told apart from one that never asks.
 */
const drawn: Record<string, Record<string, number>> = {}
const attached = new Set<string>()
const saw = (e: { surface: RenderSurface; component: string }) => {
  const bySurface = (drawn[e.surface] ??= {})
  bySurface[e.component] = (bySurface[e.component] ?? 0) + 1
}
/** The bottom player's form: a band above the prompt, a tail on the hint line, or none. */
const bottomKind = () => (playerAt() === 'message' ? 'none' : playerAt() === 'hint' ? 'hint' : 'band')

/**
 * Whether another mod hides the player band. The band is one tree the mods
 * draw in turn, in \`enabledPlugins\` order, and a mod listed before
 * read-along that draws its own band without passing it on keeps read-along's
 * hook from running at all, so read-along can't see it from inside the hook.
 * Instead, after the session starts and after each turn, the clock redraws
 * the band and the hint line (bumping \`bandCheck\`, which only those two
 * read: \`$.ui.invalidate\` would redraw every message's buttons too, the
 * transcript jitter again) and watches which of read-along's hooks run: the
 * hint line under the prompt without the band means the band is taken. The player then shows on
 * the hint line meanwhile, and a toast says so, once a session.
 */
const band = {
  /** undefined until checked; then whether the last check found the band taken. */
  isHidden: undefined as boolean | undefined,
  /** The clock tick to check at (0: none due) and the one the check began at. */
  dueTick: 0,
  startTick: 0,
  sawBand: false,
  sawHint: false,
  isToasted: false,
}
const checkBandSoon = () => {
  band.dueTick = ticks + 8 // about 3 s on, so the other mods have drawn
}
const hidesBand = () => bottomKind() === 'band' && band.isHidden === true

/** One step of the check, from the clock. */
async function checkBand($: $) {
  if (band.startTick === 0) {
    if (!band.dueTick || ticks < band.dueTick || bottomKind() !== 'band') return
    band.dueTick = 0
    band.startTick = ticks
    band.sawBand = band.sawHint = false
    await update($, bandCheck, n => n + 1)
    return
  }
  if (ticks - band.startTick < 4) return // about 1.5 s for the redraw
  band.startTick = 0
  if (!band.sawHint) return // no prompt drawn in the terminal: nothing to tell
  const isHidden = !band.sawBand
  const isChanged = isHidden !== band.isHidden
  band.isHidden = isHidden
  if (isChanged) await update($, bandCheck, n => n + 1) // the hint line takes the player, or gives it back
  if (isHidden && !band.isToasted) {
    band.isToasted = true
    $.ui.toast(
      'Read-along: another mod hides the player above the prompt, so it shows under the prompt for now. Move read-along up in enabledPlugins (~/.claude/settings.json) to get it back; /read-along doctor says more.',
      { timeoutMs: 12000 },
    )
  }
}

let socketPath = ''
let isEnsured = false
let lastError: string | null | undefined

// ------------------------------------------------------------ the service

async function sock($: $) {
  if (!socketPath) socketPath = `/tmp/read-along-${(await $.env.get('USER')) ?? 'user'}.sock`
  return socketPath
}

const speakd = ($: $) => `${$.plugin.root}/bin/speakd.py`

async function ensure($: $) {
  if (isEnsured) return
  const run = await $.process.run(['python3', '-I', speakd($), '--ensure', '--socket', await sock($)], { timeoutMs: 20000 })
  if (run.exitCode !== 0) throw new Error(`speech service didn't start: ${run.stdout || run.stderr}`)
  isEnsured = true
}

async function call<T = ReadAlongStatus>($: $, path: string, body?: unknown): Promise<T> {
  const go = async () => {
    const res = await $.http.fetch(`http://speakd${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      socketPath: await sock($),
    })
    return JSON.parse(res.text) as T
  }
  await ensure($)
  try {
    return await go()
  } catch {
    isEnsured = false // the service exited (idle timeout): start it again once
    await ensure($)
    return go()
  }
}

async function settings($: $): Promise<ReadAlongSettings> {
  const base = defaults()
  const s: Partial<ReadAlongSettings> = (await read($, current)) ?? {}
  return { ...base, ...s, voices: { ...base.voices, ...(s.voices ?? {}) } }
}

function setSettings($: $, change: Partial<ReadAlongSettings>) {
  return update($, current, s => ({ ...defaults(), ...(s ?? {}), ...change }))
}

/** What the machine offers (engines, ducking), fetched once a session. */
async function loadInfo($: $) {
  try {
    const info = await call<ReadAlongInfo>($, '/info')
    await update($, machine, () => info)
  } catch {
    // the first read reports it
  }
}

/** Every installed voice, for the settings pane's lists. */
async function loadVoices($: $) {
  if ((await read($, installed)) !== null) return
  try {
    const { voices } = await call<{ voices: ReadAlongVoice[] }>($, '/voices')
    await update($, installed, () => voices)
  } catch {
    // the pane says it couldn't list them
  }
}

/**
 * Writes the service's status into state, and only what changed: every write
 * redraws its readers, and every message row reads \`cursor\`, so an
 * unchanged write (the idle check every 3 s) redrew the whole transcript and
 * made it jitter when it met a message being sent.
 */
async function show($: $, status: ReadAlongStatus) {
  const isIdle = status.state === 'idle' && !status.queue
  const nextNow = isIdle ? null : status
  if (JSON.stringify(await read($, now)) !== JSON.stringify(nextNow)) await update($, now, () => nextNow)
  const nextCursor: ReadAlongCursor | null = isIdle || !status.key ? null : { key: status.key, text: status.text ?? '' }
  const at = await read($, cursor)
  if (at?.key !== nextCursor?.key || at?.text !== nextCursor?.text) await update($, cursor, () => nextCursor)
  if (status.error && status.error !== lastError) $.ui.toast(`Read-along: ${status.error}`)
  lastError = status.error
}

/**
 * The clock that keeps the player and the highlight current. It runs from
 * session.start for the session's life: a timer started inside another
 * dispatch (a press, an append) loses its \`$\` once that dispatch ends,
 * which froze the player mid-read. While a read runs it asks the service every
 * 400 ms; otherwise every 3 s, so a read another session started shows too.
 * It never starts the service: one that is not running just means no read.
 */
let isActive = false
let ticks = 0
let ticker: { cancel: () => void } | undefined

function poll() {
  isActive = true
}

async function tick($: $) {
  ticks += 1
  await checkBand($)
  if (!isActive && ticks % 8 !== 0) return
  try {
    const res = await $.http.fetch('http://speakd/status', { socketPath: await sock($) })
    const status = JSON.parse(res.text) as ReadAlongStatus
    await show($, status)
    isActive = !(status.state === 'idle' && !status.queue)
  } catch {
    isActive = false
    if ((await read($, now)) !== null) await update($, now, () => null)
    if ((await read($, cursor)) !== null) await update($, cursor, () => null)
  }
}

async function speak($: $, text: string, key: string, label: string, mode: 'now' | 'queue') {
  if (!text.trim()) return
  const s = await settings($)
  try {
    const status = await call($, '/speak', {
      text,
      key,
      label,
      mode,
      speed: s.speed,
      volume: s.volume / 100,
      duck: duckLevel(s.duckOthers),
      voices: s.voices,
      readCode: bool('readCode', false),
    })
    await show($, status)
    poll()
  } catch (err) {
    $.ui.toast(`Read-along: ${String(err)}`)
  }
}

async function control($: $, action: string) {
  try {
    await show($, await call($, '/control', { action }))
    poll()
  } catch (err) {
    $.ui.toast(`Read-along: ${String(err)}`)
  }
}

async function setSpeed($: $, speed: number) {
  speed = Math.round(Math.max(0.5, Math.min(4, speed)) * 100) / 100
  await setSettings($, { speed })
  if (await read($, now)) await show($, await call($, '/set', { speed }))
}

async function setVolume($: $, volume: number) {
  volume = Math.round(Math.max(0, Math.min(200, volume)))
  await setSettings($, { volume })
  if (await read($, now)) await show($, await call($, '/set', { volume: volume / 100 }))
}

async function setDuck($: $, duckOthers: string) {
  await setSettings($, { duckOthers })
  if (await read($, now)) await show($, await call($, '/set', { duck: duckLevel(duckOthers) }))
}

/**
 * Reads Claude's last reply. The buttons call this directly: a mod's own
 * \`$.command.run\` never reaches its own command.run hook.
 */
async function readLast($: $) {
  const last = (await $.session.messages()).filter(m => m.role === 'assistant' && m.text.trim()).pop()
  if (last) await speak($, last.text, messageKey('a', last.text), 'reply', 'now')
  return last !== undefined
}

/** The voice button: the next voice in the main list. */
async function nextVoice($: $) {
  const s = await settings($)
  const list = favourites().main ?? ['auto']
  const at = list.indexOf(s.voices.main ?? 'auto')
  await setVoice($, 'main', list[(at + 1) % list.length] ?? 'auto')
}

async function setVoice($: $, group: string, voice: string) {
  const s = await settings($)
  const voices = { ...s.voices, [group]: voice }
  await setSettings($, { voices })
  if (await read($, now)) await show($, await call($, '/set', { voices: { [group]: voice } }))
}

async function saveDefaults($: $) {
  const s = await settings($)
  // Each group's voice in use goes first in its list, the others stay after it.
  const lists = favourites()
  for (const [group, voice] of Object.entries(s.voices)) {
    lists[group] = [voice, ...(lists[group] ?? []).filter(v => v !== voice)]
  }
  const fields: [string, string | number | boolean][] = [
    ['voices', formatVoices(lists)],
    ['speed', s.speed],
    ['volume', s.volume],
    ['duckOthers', s.duckOthers],
    ['autoReadReplies', s.autoReadReplies],
    ['autoReadMine', s.autoReadMine],
    ['readThinking', s.readThinking],
  ]
  const refused: string[] = []
  for (const [field, value] of fields) {
    const { deny } = await $.config.set({ key: `read-along.${field}`, value })
    if (deny) refused.push(`${field} (${deny})`)
  }
  return refused.length ? `Not saved: ${refused.join(', ')}` : 'Saved as the defaults for new sessions.'
}

/** /read-along doctor: what works on this machine and what to install. */
async function doctor($: $) {
  const run = await $.process.run(['python3', '-I', speakd($), '--doctor', '--socket', await sock($)], { timeoutMs: 60000 })
  return [(run.stdout || run.stderr || 'The doctor printed nothing.').trim(), '', await surfacesReport($)].join('\n')
}

/** Where this session draws, and what each surface has asked read-along to draw. */
async function surfacesReport($: $) {
  const surfaces = await $.session.surfaces()
  const lines = ['Surfaces (where this session is drawn):']
  for (const surface of new Set([...surfaces, ...Object.keys(drawn)])) {
    const asks = Object.entries(drawn[surface] ?? {}).map(([component, n]) => `${component} ${n}`)
    lines.push(`  ${surface}: ${asks.length ? asks.join(', ') : 'has asked for nothing yet'}`)
  }
  if (attached.size) lines.push(`  remote clients: ${[...attached].join(', ')}`)
  if (bottomKind() === 'band') {
    lines.push(
      band.isHidden === undefined
        ? 'Player above the prompt: not checked yet (it is checked after each turn).'
        : band.isHidden
          ? 'Player above the prompt: hidden by another mod, so it shows on the line under the prompt. A mod listed before read-along in enabledPlugins (~/.claude/settings.json) draws there without passing the band on; move read-along above it, or set player to hint.'
          : 'Player above the prompt: shown.',
    )
  }
  return lines.join('\n')
}

async function restart($: $) {
  await $.process.run(['python3', '-I', speakd($), '--stop', '--socket', await sock($)], { timeoutMs: 15000 })
  isEnsured = false
  await update($, installed, () => null)
  await loadInfo($)
}

const SETUP_PROMPT =
  "Set up read-along for me: check this machine with /read-along doctor, then help me install the Kokoro voices with the plugin's setup skill."

// ------------------------------------------------------------ text helpers

const clock = (seconds = 0) => {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const bar = (fraction: number, width: number) => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

const KOKORO_ACCENTS: Record<string, string> = { a: 'US', b: 'UK', j: 'JP', z: 'ZH', e: 'ES', f: 'FR', h: 'HI', i: 'IT', p: 'PT' }
const ENGINE_NAMES: Record<string, string> = { kokoro: 'Kokoro', win: 'Windows', mac: 'macOS', espeak: 'eSpeak' }

/**
 * A voice's short name, for buttons and the player: kokoro:af_heart → heart,
 * win:Microsoft Aria Native → Aria, mac:Samantha → Samantha. `isLong` adds
 * the engine: heart (Kokoro US). Names from before engines were named (a bare
 * af_heart, a bare Windows name) still read right.
 */
export const voiceName = (voice = '', isLong = false): string => {
  if (!voice || voice === 'auto') return isLong ? 'auto (best installed)' : 'auto'
  const [, engine = '', name = ''] = voice.match(/^(kokoro|win|mac|espeak):(.*)$/) ?? ['', voice.includes(' ') ? 'win' : 'kokoro', voice]
  if (engine === 'kokoro') {
    const short = name.replace(/^[a-z]{2}_/, '')
    return isLong ? `${short} (Kokoro ${KOKORO_ACCENTS[name[0] ?? ''] ?? ''})`.replace(' )', ')') : short
  }
  const short = engine === 'win' ? name.replace(/^Microsoft /, '').replace(/ (Native|Desktop|Online)$/, '') : name
  return isLong ? `${short} (${ENGINE_NAMES[engine]})` : short
}

const hash = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** The handle a message's row and its read share: who wrote it and its text. */
const messageKey = (who: 'a' | 'u', text: string) => `${who}:${hash(text.trim())}`

/**
 * The service hears a sentence with the markdown taken out, so the mod finds
 * it again word by word: link targets and URLs are skipped, and so are the
 * words the service puts in for symbols (→ is "to", a URL is "link").
 */
const SPOKEN_ONLY = new Set(['to', 'from', 'link', 'code', 'block'])

const words = (text: string, skip: [number, number][] = []) =>
  [...text.matchAll(/[\p{L}\p{N}]+/gu)]
    .map(m => ({ word: m[0].toLowerCase(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter(w => !SPOKEN_ONLY.has(w.word) && !skip.some(([a, b]) => w.start >= a && w.start < b))

/** Where the sentence being heard sits in the message's markdown, if it can be found. */
const findSentence = (raw: string, sentence: string) => {
  const skip = [...raw.matchAll(/\]\([^)]*\)|https?:\/\/\S+/g)].map(m => [m.index ?? 0, (m.index ?? 0) + m[0].length] as [number, number])
  const rawWords = words(raw, skip)
  const target = words(sentence).map(w => w.word)
  if (target.join('').length < 2) return undefined
  const first = rawWords.findIndex((_, i) => target.every((w, k) => rawWords[i + k]?.word === w))
  if (first < 0) return undefined
  const start = rawWords[first]?.start ?? 0
  let end = rawWords[first + target.length - 1]?.end ?? start
  while (end < raw.length && /[.!?。！？]/.test(raw[end] ?? '')) end++
  return { start, end }
}

/** Fallback where the message can't be redrawn (a table, a code block): the sentence bold. */
const markSentence = (raw: string, sentence: string) => {
  const at = findSentence(raw, sentence)
  if (!at) return undefined
  const span = raw.slice(at.start, at.end)
  if (/[\n`*_[\]|]/.test(span)) return undefined
  return `${raw.slice(0, at.start)}**${span}**${raw.slice(at.end)}`
}

/** Inline markdown taken out of a piece of the line being read, which is drawn as plain text. */
const plain = (text: string) => text.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1').replace(/\*\*|__|`/g, '')

/**
 * The `highlight` setting as Text props: `reverse` swaps the text and
 * background colours, which reads on any theme; else a background colour,
 * optionally with a text colour after a slash (`#7d1010/#ffffff`).
 */
export const highlightProps = (value: string): { inverse?: boolean; backgroundColor?: string; color?: string } => {
  const v = value.trim()
  if (!v || v === 'reverse') return { inverse: true }
  const [bg = '', fg = ''] = v.split('/').map(s => s.trim())
  return fg ? { backgroundColor: bg, color: fg } : { backgroundColor: bg }
}

/**
 * The message while one of its sentences is heard, drawn by the mod: the
 * lines before and after stay markdown, and the line being read is text with
 * the sentence highlighted. Markdown has no background colour, so this is
 * the one way to paint one. Undefined where the line is in a table or a code
 * block, which only draw right whole.
 */
function drawRead($: $, e: MessageEvent, raw: string, at: { start: number; end: number }, lead: string): RenderElement | undefined {
  const lineStart = raw.lastIndexOf('\n', at.start - 1) + 1
  const lineEnd = raw.indexOf('\n', at.end) < 0 ? raw.length : raw.indexOf('\n', at.end)
  const line = raw.slice(lineStart, lineEnd)
  const fences = (raw.slice(0, lineStart).match(/^\s*```/gm) ?? []).length
  if (/^\s*\|/.test(line) || fences % 2 === 1) return undefined

  const { Box, Text, Markdown } = $.ui.resolve(e)
  const before = raw.slice(0, lineStart).replace(/\s+$/, '')
  const after = raw.slice(lineEnd).replace(/^\s+/, '')
  const gapBefore = /\n\s*\n\s*$/.test(raw.slice(0, lineStart)) ? 1 : 0
  const gapAfter = /^\s*\n\s*\n/.test(raw.slice(lineEnd)) ? 1 : 0

  // The line's own markup: a list marker becomes a bullet, a heading goes bold.
  const marker = line.match(/^(\s*)([-*+]|\d+[.)])\s+/)
  const heading = line.match(/^#{1,6}\s+/)
  const quote = line.match(/^>\s?/)
  const skipped = (marker?.[0] ?? heading?.[0] ?? quote?.[0] ?? '').length
  const prefix = marker ? `${marker[1]}${/\d/.test(marker[2] ?? '') ? marker[2] : '•'} ` : quote ? '│ ' : ''
  const from = Math.max(lineStart + skipped, Math.min(at.start, lineEnd))
  const pre = plain(raw.slice(lineStart + skipped, from))
  const span = plain(raw.slice(from, Math.min(at.end, lineEnd)))
  const post = plain(raw.slice(Math.min(at.end, lineEnd), lineEnd))

  // marginTop: the engine draws each message with a blank row above it; without
  // it, a message being read sat flush against the one before until reading ended.
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text>{lead}</Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {before ? [<Markdown text={before} />] : []}
        <Box marginTop={before ? gapBefore : 0}>
          <Text bold={heading !== null}>
            {prefix}
            {pre}
            <Text {...highlightProps(str('highlight', 'reverse'))}>{span}</Text>
            {post}
          </Text>
        </Box>
        {after
          ? [
              <Box marginTop={gapAfter}>
                <Markdown text={after} />
              </Box>,
            ]
          : []}
      </Box>
    </Box>
  )
}

// ------------------------------------------------------------ drawing
//
// Symbols are text-only ones (‖ « » ▶ ■): ⏸ ⏮ ⏭ default to emoji and a
// terminal may draw them as colour icons.
//
// A child left out is an empty list, never `cond && <X/>`: the `false` that
// leaves behind still takes a row on the terminal.

/**
 * What a message carries besides its text: \`below\`, a row under it (the
 * progress while it's read, with \`player: message\`; the buttons, with
 * \`buttons: always\`); \`overlay\`, the buttons over its top-right corner while
 * the pointer is on it (\`buttons: hover\`); and \`gutter\`, a dim ♪ at its
 * right that shows them while the pointer is on the ♪ alone (\`buttons: glyph\`).
 */
type MessageExtras = { below: RenderElement | null; gutter: RenderElement | null; overlay: RenderElement | null }

/** The main voice as heard: the one chosen, or what `auto` picks on this machine. */
async function mainVoice($: $, s: ReadAlongSettings) {
  const chosen = s.voices.main ?? 'auto'
  return chosen === 'auto' ? ((await read($, machine))?.auto ?? 'auto') : chosen
}

async function messageRow($: $, e: MessageEvent, text: string, key: string, label: string): Promise<MessageExtras> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const s = await settings($)
  const at = await read($, cursor)
  const id = e.requestId
  const isThis = at !== null && at.key === key
  const status = isThis ? await read($, now) : null // only the message being read follows the clock
  const isPlaying = status !== null && (status.state === 'playing' || status.state === 'loading')
  const form = buttons(e.surface)

  const controls = (
    <Box key={`${id}-controls`} columnGap={1}>
      <Button key={`${id}-play`} label={isPlaying ? btn('pause') : btn('play')} onPress={() => (isThis ? control($, 'toggle') : speak($, text, key, label, 'now'))} />
      <Button key={`${id}-restart`} label={btn('restart')} onPress={() => (isThis ? control($, 'restart') : speak($, text, key, label, 'now'))} />
      {isThis ? [<Button key={`${id}-stop`} label={btn('stop')} onPress={() => control($, 'stop')} />] : []}
      <Button key={`${id}-slower`} label={btn('slower')} onPress={() => setSpeed($, s.speed - SPEED_STEP)} />
      <Text dimColor>{s.speed}×</Text>
      <Button key={`${id}-faster`} label={btn('faster')} onPress={() => setSpeed($, s.speed + SPEED_STEP)} />
      <Button key={`${id}-voice`} label={voiceName(await mainVoice($, s))} onPress={() => nextVoice($)} />
    </Box>
  )

  // `hover`: the buttons over the message's top-right corner while the pointer
  // is anywhere on the message. They can flash as messages scroll under a
  // resting pointer; `glyph` avoids that by hovering a ♪ alone.
  const overlay =
    form === 'hover' ? (
      <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex' }} backgroundColor="black">
        {controls}
      </Box>
    ) : null
  const gutter =
    form === 'glyph' ? (
      <Box key={`ra-${id}-gutter`} width={2} flexShrink={0}>
        <Text color={isThis ? 'cyan' : undefined} dimColor={!isThis}>
          {' ♪'}
        </Text>
        <Box position="absolute" top={0} right={2} display="none" hover={{ display: 'flex' }} backgroundColor="black">
          {controls}
        </Box>
      </Box>
    ) : null

  if (status !== null && showsUnderMessage(e.surface)) {
    const width = Math.max(8, Math.min(24, (e.viewport?.columns ?? 80) - 60))
    const fraction = status.total ? (status.position ?? 0) / status.total : 0
    const progress = (
      <Box columnGap={1}>
        <Text color="cyan">
          {icon(stateOf(status))} {clock(status.position)} {bar(fraction, width)} {clock(status.total)}
        </Text>
        {controls}
      </Box>
    )
    return { below: progress, gutter, overlay }
  }
  return { below: form === 'always' ? controls : null, gutter, overlay }
}

function wrap($: $, e: MessageEvent, inner: RenderElement, { below, gutter, overlay }: MessageExtras): RenderElement {
  if (below === null && gutter === null && overlay === null) return inner
  const { Box } = $.ui.resolve(e)
  if (overlay !== null) {
    // Keyed, so the whole message is the hover's scope.
    return (
      <Box key={`ra-${e.requestId}`} flexDirection="column">
        {inner}
        {below ? [below] : []}
        {overlay}
      </Box>
    )
  }
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {inner}
        {below ? [below] : []}
      </Box>
      {gutter ? [gutter] : []}
    </Box>
  )
}

/**
 * A message as it draws while one of its sentences is heard: the mod's own
 * drawing with the sentence highlighted, else the engine's with it in bold.
 */
async function drawMessage($: $, e: MessageEvent, raw: string, key: string, lead: string, next: (e: MessageEvent) => Promise<RenderElement>) {
  const at = await read($, cursor)
  if (at === null || at.key !== key || !at.text) return next(e)
  const where = findSentence(raw, at.text)
  const own = where && drawRead($, e, raw, where, lead)
  if (own) return own
  const marked = markSentence(raw, at.text)
  return next(marked ? ({ ...e, props: { ...e.props, text: marked } } as MessageEvent) : e)
}

/** The player's one row: idle settings, or the read in progress with its controls. */
// Indented one column with two spaces after the icon, as token-weather's line
// is, so the two rows' icons and first words line up.
async function playerRow($: $, e: RenderInput<'AbovePrompt'>): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const status = await read($, now)
  const s = await settings($)
  const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80

  if (status === null) {
    const auto = s.autoReadReplies === 'off' && !s.autoReadMine ? 'auto-read off' : `auto-read ${[s.autoReadReplies !== 'off' ? `replies (${s.autoReadReplies})` : '', s.autoReadMine ? 'mine' : ''].filter(Boolean).join(' + ')}`
    return (
      <Box columnGap={1} flexWrap="nowrap" paddingX={1}>
        <Text wrap="truncate-end">
          <Text color="magenta" bold>
            {icon('idle')}
            {'  '}
            {voiceName(await mainVoice($, s))}
          </Text>
          <Text dimColor>
            {'  '}
            {s.speed}× · {auto}
          </Text>
        </Text>
        <Button key="last" hotkey="r" label="▶ last reply" onPress={() => readLast($)} />
        <Button key="settings" hotkey="o" label="settings" onPress={() => $.ui.open({ id: PANE, title: 'Read-along' })} />
      </Box>
    )
  }

  const isPaused = status.state === 'paused'
  const fraction = status.total ? (status.position ?? 0) / status.total : 0
  const where = status.sentences ? ` ${(status.sentence ?? 0) + 1}/${status.sentences}` : ''
  const queued = status.queue ? ` +${status.queue}` : ''
  const voice = voiceName(status.voice ?? (await mainVoice($, s)))
  // Laid out like token-weather's line: icon and voice name in bold colour
  // (where "Showers" sits), then the details. The name is the voice button.
  // Everything but the bar has a fixed width; the bar takes what is left, so the row never wraps.
  const fixed = 1 + 3 + voice.length + 2 + 12 + where.length + queued.length + 6 * 6 + 2
  const width = Math.max(4, Math.min(40, cols - fixed))
  return (
    <Box flexWrap="nowrap" paddingX={1}>
      <Text color="cyan" bold>
        {icon(stateOf(status))}
        {'  '}
      </Text>
      <Button key="voice" plain label={voice} onPress={() => nextVoice($)}>
        <Text color="cyan" bold>
          {voice}
        </Text>
      </Button>
      <Box columnGap={1} marginLeft={2} flexWrap="nowrap">
        <Text color="cyan" wrap="truncate-end">
          {clock(status.position)} {bar(fraction, width)} {clock(status.total)}
          <Text dimColor>
            {where}
            {queued}
          </Text>
        </Text>
        <Button key="toggle" hotkey="p" label={isPaused ? btn('play') : btn('pause')} onPress={() => control($, 'toggle')} />
        <Button key="stop" hotkey="s" label={btn('stop')} onPress={() => control($, 'stop')} />
        <Button key="back" hotkey="b" label={btn('back')} onPress={() => control($, 'back')} />
        <Button key="forward" hotkey="n" label={btn('forward')} onPress={() => control($, status.queue ? 'skip' : 'forward')} />
        <Button key="slower" label={btn('slower')} onPress={() => setSpeed($, s.speed - SPEED_STEP)} />
        <Button key="faster" label={btn('faster')} onPress={() => setSpeed($, s.speed + SPEED_STEP)} />
      </Box>
    </Box>
  )
}

/** The installed voices a group can use: its languages', `main` taking the main language's. */
function voicesFor(all: ReadAlongVoice[], group: string, info: ReadAlongInfo | null) {
  const langs = group === 'main' ? [info?.mainLanguage ?? 'en'] : (info?.groupLangs?.[group] ?? [group])
  return all.filter(v => langs.includes(v.lang.toLowerCase().split(/[-_]/)[0] ?? ''))
}

const HELP = [
  '/read-along                 the settings',
  '/read-along read            read the last reply',
  '/read-along stop | pause',
  '/read-along speed 1.5',
  '/read-along voice NAME      the main voice; voice ja NAME for Japanese, and so on',
  '/read-along voices [GROUP]  list the installed voices',
  '/read-along auto replies off|final|all, auto mine on|off, auto thinking on|off',
  "/read-along save            make this session's choices the defaults",
  '/read-along doctor          what works on this machine, and what to install',
  '/read-along setup           ask Claude to install the Kokoro voices',
  '/read-along restart         restart the speech service',
].join('\n')

export const register: Register = (on, options) => {
  opt = options as Options

  // ------------------------------------------------------------ events

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'read-along',
      description: 'Read-along: open its settings, or read | stop | pause | speed N | voice NAME | voices | auto … | save | doctor | setup | restart | help',
      argumentHint: '[read|stop|pause|speed N|voice NAME|voices|auto …|save|doctor|setup|restart|help]',
    })
    ticker?.cancel()
    ticker = $.clock.every(400, () => tick($))
    checkBandSoon()
    $.ui.status(undefined) // read-along pins no status line; clear one an older version left
    // Start the service and load the voices now, so the first read starts at once.
    void (async () => {
      try {
        const s = await settings($)
        await call($, '/warm', { voices: s.voices })
        await loadInfo($)
      } catch {
        // the first read reports it
      }
    })()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if ((e.origin.kind === 'composer' || e.origin.kind === 'bridge') && (await settings($)).autoReadMine) {
      await speak($, e.text, messageKey('u', e.text), 'your message', 'now')
    }
    return entered
  }).catch(($, e, next) => next(e)) // reading never holds up a prompt

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) checkBandSoon() // a turn can bring another mod's band (replay-theater's after edits)
    if (e.agentId === undefined && e.reason === 'answer' && (await settings($)).autoReadReplies === 'final') {
      await speak($, e.answer, messageKey('a', e.answer), 'reply', 'queue')
    }
    return done
  })

  // `all`: read each text block of a model step as soon as the block ends,
  // the short updates written just before a tool call included. Waiting for
  // the whole step read an update only once its tool call had streamed in,
  // which for a long command or file came a minute late, and never for a
  // step cut short. (Those updates never reach the transcript as their own
  // rows, so listening to session.append missed them.)
  //
  // With `readThinking`, the thinking blocks too: some setups show thinking as
  // short updates in the transcript, so a step can show only thinking before
  // its tool call. Off by default, as a mod can't tell whether it's shown.
  on('turn.step', async function* ($, e, next) {
    const s = await settings($)
    if (e.agentId !== undefined || s.autoReadReplies !== 'all') return yield* next(e)
    let block: number | undefined
    let text = ''
    const flush = async () => {
      if (text.trim()) await speak($, text, messageKey('a', text), 'reply', 'queue')
      block = undefined
      text = ''
    }
    for await (const chunk of next(e)) {
      if (chunk.kind === 'text' || (chunk.kind === 'thinking' && s.readThinking)) {
        if (block !== undefined && chunk.index !== block) await flush()
        block = chunk.index
        text += chunk.text
      } else if (chunk.kind === 'tool' || chunk.kind === 'stop' || chunk.kind === 'thinking') {
        await flush()
      }
      yield chunk
    }
    await flush()
  })

  on('command.run', { command: 'read-along' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    switch (verb) {
      case '':
      case 'settings':
        await $.ui.open({ id: PANE, title: 'Read-along' })
        return { text: 'Read-along settings opened.' }
      case 'help':
        return { text: HELP }
      case 'stop':
      case 'pause':
        await control($, verb === 'stop' ? 'stop' : 'toggle')
        return { text: verb === 'stop' ? 'Stopped.' : 'Paused or resumed.' }
      case 'read':
        return { text: (await readLast($)) ? 'Reading the last reply.' : 'No reply to read yet.' }
      case 'speed': {
        const speed = Number(arg)
        if (!Number.isFinite(speed) || speed <= 0) return { text: 'Usage: /read-along speed 1.5' }
        await setSpeed($, speed)
        return { text: `Speed ${(await settings($)).speed}×.` }
      }
      case 'voice': {
        // voice NAME sets the main voice; voice ja NAME, voice he NAME set the others.
        const [first = '', ...more] = rest
        const group = first in GROUPS ? first : 'main'
        const voice = (group === first ? more.join(' ') : arg).trim()
        if (!voice) return { text: 'Usage: /read-along voice kokoro:af_heart, or voice ja kokoro:jf_alpha. /read-along voices lists them.' }
        await setVoice($, group, voice)
        return { text: `${GROUPS[group]} voice: ${voiceName(voice, true)}.` }
      }
      case 'voices': {
        await loadVoices($)
        const all = (await read($, installed)) ?? []
        if (!all.length) return { text: 'No voices found. /read-along doctor says what to install.' }
        const info = await read($, machine)
        const groups = arg && arg in GROUPS ? [arg] : Object.keys(GROUPS)
        const lines = groups.flatMap(g => {
          const list = voicesFor(all, g, info)
          return list.length ? [`${GROUPS[g]} (${g}): ${list.map(v => v.id).join(', ')}`] : []
        })
        return { text: lines.join('\n\n') }
      }
      case 'auto': {
        const [what = '', value = ''] = rest
        if (what === 'replies' && ['off', 'final', 'all'].includes(value)) {
          await setSettings($, { autoReadReplies: value })
          return { text: `Auto-read replies: ${value}.` }
        }
        if (what === 'mine' && ['on', 'off'].includes(value)) {
          await setSettings($, { autoReadMine: value === 'on' })
          return { text: `Auto-read my messages: ${value}.` }
        }
        if (what === 'thinking' && ['on', 'off'].includes(value)) {
          await setSettings($, { readThinking: value === 'on' })
          return { text: `Read thinking updates: ${value}${value === 'on' && (await settings($)).autoReadReplies !== 'all' ? ' (with auto-read replies set to all)' : ''}.` }
        }
        return { text: 'Usage: /read-along auto replies off|final|all, auto mine on|off, or auto thinking on|off' }
      }
      case 'save':
        return { text: await saveDefaults($) }
      case 'doctor':
        return { text: await doctor($) }
      case 'setup': {
        const { isFilled } = await $.prompt.fill({ text: SETUP_PROMPT })
        return { text: isFilled ? 'A request to set up read-along is in the prompt box: press Enter to send it.' : `Ask Claude: "${SETUP_PROMPT}"` }
      }
      case 'restart':
        await restart($)
        return { text: 'Speech service stopped; it starts again with the next read.' }
      default:
        return { text: `Unknown: ${verb}.\n${HELP}` }
    }
  })

  // ------------------------------------------------------------ drawing

  on('session.attach', async ($, e, next) => {
    attached.add(`${e.clientId} (${e.surface})`)
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    saw(e)
    if (e.props.isSummary || !e.props.text.trim()) return next(e)
    const key = messageKey('a', e.props.text)
    const inner = await drawMessage($, e, e.props.text, key, e.props.isFirstOfReply ? '● ' : '  ', ev => next(ev as typeof e))
    return wrap($, e, inner, await messageRow($, e, e.props.text, key, 'reply'))
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    saw(e)
    const kind = e.props.origin.kind
    if ((kind !== 'composer' && kind !== 'bridge') || !e.props.text.trim()) return next(e)
    const key = messageKey('u', e.props.text)
    const inner = await drawMessage($, e, e.props.text, key, '❯ ', ev => next(ev as typeof e))
    return wrap($, e, inner, await messageRow($, e, e.props.text, key, 'your message'))
  })

  // The player at the bottom: one row that is always there, idle or reading,
  // so it never pushes the transcript when a read starts or ends. With
  // `player: hint` it is a dim tail on the hint line under the prompt instead.
  // Other mods draw here too: their band stays, under the player's row,
  // rather than the player hiding it. The band is one tree that each mod in
  // turn either passes on or wraps, so the player wraps theirs to sit on top;
  // should drawing the player fail, the .catch below hands theirs on alone.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    saw(e)
    await read($, bandCheck) // so the band check redraws this, and only this and the hint line
    if (e.surface === 'terminal') band.sawBand = true
    if (e.props.hasSurvey || bottomKind() !== 'band') return next(e)
    const others = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await playerRow($, e)}
        {others}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    saw(e)
    await read($, bandCheck)
    if (e.surface === 'terminal') band.sawHint = true
    // The hint line also carries the player while another mod hides the band.
    if (bottomKind() !== 'hint' && !hidesBand()) return next(e)
    const status = await read($, now)
    if (status === null) return next(e)
    const s = await settings($)
    const mark = icon(stateOf(status))
    const tail = `${mark} ${clock(status.position)}/${clock(status.total)} · ${status.speed ?? s.speed}× ${voiceName(status.voice ?? (await mainVoice($, s)))}`
    return next({ ...e, props: { ...e.props, tail } })
  })

  // /read-along with no arguments: the settings, one place for all of them.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    saw(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await settings($)
    const status = await read($, now)
    const info = await read($, machine)
    const open = await read($, browsing)
    const all = (await read($, installed)) ?? []
    const lists = favourites()
    const pick = (isOn: boolean) => (isOn ? ('primary' as const) : undefined)
    // Main, plus every group with a voice set; the rest are a click away.
    const shown = [...new Set(['main', ...Object.keys(lists), ...Object.keys(s.voices)])].filter(g => g in GROUPS)
    const others = Object.keys(GROUPS).filter(g => !shown.includes(g))
    const toggle = async (group: string) => {
      await loadVoices($)
      await update($, browsing, b => (b === group ? null : group))
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        <Text dimColor>
          {status ? `${status.state} · ${status.label ?? ''} · ${clock(status.position)} of ${clock(status.total)}` : 'Not reading.'}
          {info?.auto ? `   auto voice here: ${voiceName(info.auto, true)}` : ''}
        </Text>
        {shown.map(group => {
          const chosen = s.voices[group] ?? 'auto'
          const options = [...new Set(['auto', ...(lists[group] ?? []), chosen])]
          const more = open === group ? voicesFor(all, group, info).filter(v => !options.includes(v.id)) : []
          return (
            <Box key={`group-${group}`} flexDirection="column">
              <Text bold>{group === 'main' ? 'Voice' : `${GROUPS[group]} voice`}</Text>
              <Box columnGap={1} flexWrap="wrap">
                {options.map(v => (
                  <Button key={`${group}-${v}`} label={voiceName(v, true)} variant={pick(v === chosen)} onPress={() => setVoice($, group, v)} />
                ))}
                <Button key={`${group}-more`} label={open === group ? 'fewer' : 'more…'} onPress={() => toggle(group)} />
              </Box>
              {more.length
                ? [
                    <Box key={`${group}-list`} columnGap={1} flexWrap="wrap">
                      {more.map(v => (
                        <Button key={`${group}-all-${v.id}`} label={voiceName(v.id, true)} onPress={() => setVoice($, group, v.id)} />
                      ))}
                    </Box>,
                  ]
                : []}
            </Box>
          )
        })}
        <Box columnGap={1} flexWrap="wrap">
          <Text dimColor>Other languages:</Text>
          {others.map(g => (
            <Button key={`add-${g}`} label={GROUPS[g] ?? g} onPress={() => setVoice($, g, 'auto')} />
          ))}
        </Box>
        <Box columnGap={1}>
          <Text bold>Speed</Text>
          <Button key="slower" label="−" onPress={() => setSpeed($, s.speed - SPEED_STEP)} />
          <Text>{s.speed}×</Text>
          <Button key="faster" label="+" onPress={() => setSpeed($, s.speed + SPEED_STEP)} />
        </Box>
        <Box columnGap={1}>
          <Text bold>Volume</Text>
          <Button key="quieter" label="−" onPress={() => setVolume($, s.volume - VOLUME_STEP)} />
          <Text>{s.volume}%</Text>
          <Button key="louder" label="+" onPress={() => setVolume($, s.volume + VOLUME_STEP)} />
        </Box>
        {info?.canDuck
          ? [
              <Box key="duck" columnGap={1}>
                <Text bold>Lower other apps while reading</Text>
                {DUCK_LEVELS.map(v => (
                  <Button key={`duck-${v}`} label={v === 'off' ? 'off' : `to ${v}`} variant={pick(s.duckOthers === v)} onPress={() => setDuck($, v)} />
                ))}
              </Box>,
            ]
          : []}
        <Box columnGap={1}>
          <Text bold>Auto-read replies</Text>
          {['off', 'final', 'all'].map(v => (
            <Button key={`replies-${v}`} label={v} variant={pick(s.autoReadReplies === v)} onPress={() => setSettings($, { autoReadReplies: v })} />
          ))}
        </Box>
        <Box columnGap={1}>
          <Text bold>Auto-read my messages</Text>
          {(['off', 'on'] as const).map(v => (
            <Button key={`mine-${v}`} label={v} variant={pick(s.autoReadMine === (v === 'on'))} onPress={() => setSettings($, { autoReadMine: v === 'on' })} />
          ))}
        </Box>
        <Box columnGap={1}>
          <Text bold>Read thinking updates</Text>
          {(['off', 'on'] as const).map(v => (
            <Button key={`thinking-${v}`} label={v} variant={pick(s.readThinking === (v === 'on'))} onPress={() => setSettings($, { readThinking: v === 'on' })} />
          ))}
          <Text dimColor>with auto-read all</Text>
        </Box>
        <Box columnGap={1}>
          <Button key="save" variant="primary" label="save as defaults" onPress={async () => $.ui.toast(await saveDefaults($))} />
          <Button key="read-last" label="▶ read last reply" onPress={() => readLast($)} />
          <Button key="stop" label="■ stop" onPress={() => control($, 'stop')} />
        </Box>
        <Box columnGap={1}>
          <Text bold>Player</Text>
          {['band', 'hint', 'message', 'band+message'].map(v => (
            <Button key={`player-${v}`} label={v} variant={pick(playerAt() === v)} onPress={() => $.config.set({ key: 'read-along.player', value: v })} />
          ))}
        </Box>
        <Text dimColor>
          Choices here last for this session until you save them. Voice lists, the highlight, icons and the message buttons are in /config under read-along. /read-along doctor checks this machine.
        </Text>
      </Box>
    )
  })
}
